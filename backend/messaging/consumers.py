"""
Messaging WebSocket Consumers

Two consumers:
  1. ChatConsumer  — real-time messaging
  2. SignalingConsumer — WebRTC signaling for voice/video calls
"""

import json
import logging
import asyncio

from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from django.contrib.auth.models import User
from django.core.cache import cache

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helper: canonical room name (alphabetically sorted usernames)
# ---------------------------------------------------------------------------
def room_name_for(user_a: str, user_b: str) -> str:
    return '__'.join(sorted([user_a, user_b]))


def room_name_for_ids(user_a_id: int, user_b_id: int) -> str:
    lo, hi = sorted([int(user_a_id), int(user_b_id)])
    return f'{lo}__{hi}'


# ---------------------------------------------------------------------------
# 1. ChatConsumer
# ---------------------------------------------------------------------------
class ChatConsumer(AsyncWebsocketConsumer):
    """
    Handles real-time messaging.

    URL pattern: /ws/chat/<user_id>/
    Legacy fallback: /ws/chat/<username>/
    """

    # ---- Connection lifecycle ----------------------------------------------

    async def connect(self):
        if not self.scope['user'].is_authenticated:
            await self.close(code=4001)
            return

        self.me = self.scope['user']
        self._presence_debounce_seconds = 30.0

        # Reject soft-deleted accounts
        if await self.is_account_deleted(self.me):
            await self.close(code=4002)
            return

        route_kwargs = self.scope.get('url_route', {}).get('kwargs', {})
        self.other_user = await self.resolve_other_user(route_kwargs)
        if not self.other_user:
            await self.close(code=4004)
            return

        self.other_user_id = self.other_user.id
        self.other_username = self.other_user.username
        self.room = room_name_for_ids(self.me.id, self.other_user_id)
        self.room_group = f'chat_{self.room}'

        # Join the room channel group, global presence broadcast group, and personal group
        await self.channel_layer.group_add(self.room_group, self.channel_name)
        await self.channel_layer.group_add('presence_all', self.channel_name)
        
        self.personal_group = f"user_chat_{self.me.id}"
        await self.channel_layer.group_add(self.personal_group, self.channel_name)

        # Join session-specific group for force logout
        self.session_key = self.scope.get('session', {}).session_key
        if self.session_key:
            self.session_group = f"session_{self.session_key}"
            await self.channel_layer.group_add(self.session_group, self.channel_name)

        # Mark user active only when their first chat socket connects.
        # Switching chats closes/reopens sockets; we avoid flapping presence.
        became_online = await self._incr_active_connections()
        await self.set_online(True)

        await self.accept()
        logger.info(f'[WS] {self.me.username} connected to room {self.room}')

        # Mark unread messages from the other user as delivered
        newly_delivered_ids = await self.mark_and_get_newly_delivered()
        for msg_id in newly_delivered_ids:
            await self.channel_layer.group_send(
                self.room_group,
                {
                    'type': 'broadcast_message_status',
                    'message_id': msg_id,
                    'status': 'delivered',
                }
            )

        # Broadcast Active status to ALL connected users
        await self.channel_layer.group_send(
            'presence_all',
            {
                'type': 'broadcast_presence',
                'user_id': self.me.id,
                'username': self.me.username,
                'is_online': True,
                'last_seen': None
            }
        )

        # Immediately send the other user's current presence to this connection
        other_presence = await self.get_user_presence(self.other_user)
        await self.send(text_data=json.dumps({
            'type': 'presence',
            'username': self.other_username,
            'status': 'active' if other_presence['is_online'] else 'inactive',
            'last_seen': other_presence['last_seen'],
        }))

    async def disconnect(self, code):
        if hasattr(self, 'room_group'):
            await self.channel_layer.group_discard(self.room_group, self.channel_name)

        # Leave the global presence group
        await self.channel_layer.group_discard('presence_all', self.channel_name)

        if hasattr(self, 'personal_group'):
            await self.channel_layer.group_discard(self.personal_group, self.channel_name)

        if hasattr(self, 'session_group'):
            await self.channel_layer.group_discard(self.session_group, self.channel_name)

        if hasattr(self, 'me'):
            # Mark offline only when the last chat socket disconnects.
            # Do it with a short debounce so rapid chat switching doesn't flicker.
            became_offline = await self._decr_active_connections()
            if became_offline:
                asyncio.create_task(self._debounced_offline())

    async def _debounced_offline(self):
        try:
            await asyncio.sleep(self._presence_debounce_seconds)
            # If a new socket connected during the debounce, don't go offline.
            if await self._get_active_connection_count() > 0:
                return
            last_seen_iso = await self.set_online(False)
            await self.channel_layer.group_send(
                'presence_all',
                {
                    'type': 'broadcast_presence',
                    'user_id': self.me.id,
                    'username': self.me.username,
                    'is_online': False,
                    'last_seen': last_seen_iso
                }
            )
        except Exception as exc:
            logger.warning(f'[WS] debounced_offline error: {exc}')

    # ---- Inbound messages --------------------------------------------------

    async def receive(self, text_data=None, bytes_data=None):
        try:
            data = json.loads(text_data)
        except (json.JSONDecodeError, TypeError):
            await self.send_error('Invalid JSON payload.')
            return

        msg_type = data.get('type')

        if msg_type == 'chat_message':
            await self.handle_chat_message(data)
        elif msg_type == 'file_notification':
            await self.handle_file_notification(data)
        elif msg_type == 'typing':
            await self.handle_typing(data)
        elif msg_type == 'delivered_receipt':
            await self.handle_delivered_receipt(data)
        elif msg_type == 'read_receipt':
            await self.handle_read_receipt(data)
        elif msg_type == 'ping':
            await self._verify_and_restore_online_status()
            await self.send(text_data=json.dumps({'type': 'pong'}))
        elif msg_type == 'retention_update':
            await self.handle_retention_update(data)
        else:
            await self.send_error(f'Unknown message type: {msg_type}')

    async def force_logout(self, event):
        """Relay force logout signal to frontend."""
        await self.send(text_data=json.dumps({
            'type': 'force_logout'
        }))
        await self.close(code=4003)

    async def broadcast_presence(self, event: dict):
        if event.get('user_id') == getattr(self, 'me', None).id:
            return
        await self.send(text_data=json.dumps({
            'type': 'presence',
            'user_id': event.get('user_id'),
            'username': event.get('username'),
            'status': 'active' if event.get('is_online') else 'inactive',
            'last_seen': event.get('last_seen')
        }))

    # ---- Chat message handler ----------------------------------------------

    async def handle_chat_message(self, data: dict):
        """
        Persists a message and broadcasts it to the room.
        """
        if 'message' not in data:
            await self.send_error('Missing field: message')
            return

        # Block enforcement: WhatsApp-style — check blocked_users only
        blocked, reason = await self.is_chat_blocked()
        if blocked:
            await self.send_error(reason)
            return

        # Save to DB
        message = await self.save_message(data)
        if not message:
            await self.send_error('Failed to save message.')
            return

        payload = {
            'message_id': message['id'],
            'sender': self.me.username,
            'receiver': self.other_username,
            'receiver_id': self.other_user_id,
            'message': data.get('message', ''),
            'message_type': data.get('message_type', 'text'),
            'original_filename': data.get('original_filename', ''),
            'mime_type': data.get('mime_type', ''),
            'timestamp': message['timestamp'],
        }

        if message.get('replied_moment'):
            payload['replied_moment'] = message['replied_moment']

        # Broadcast to the shared room group (both participants)
        await self.channel_layer.group_send(
            self.room_group,
            {'type': 'broadcast_message', **payload}
        )

    async def handle_file_notification(self, data: dict):
        """
        Broadcast a 'file upload complete' notification to the room.

        The file was already saved to the DB by the upload_file HTTP view.
        This handler just relays the metadata so the receiver's browser
        can render the file message bubble immediately.
        """
        required = ['message_id', 'file_id', 'message_type', 'original_filename']
        for field in required:
            if not data.get(field):
                await self.send_error(f'Missing file_notification field: {field}')
                return

        blocked, reason = await self.is_chat_blocked()
        if blocked:
            await self.send_error(reason)
            return

        payload = {
            'message_id': data['message_id'],
            'file_id': data['file_id'],
            'sender': self.me.username,
            'receiver': self.other_username,
            'message_type': data['message_type'],
            'original_filename': data['original_filename'],
            'mime_type': data.get('mime_type', 'application/octet-stream'),
            'timestamp': data.get('timestamp', ''),
            'has_file': True,
        }

        await self.channel_layer.group_send(
            self.room_group,
            {'type': 'broadcast_file_notification', **payload},
        )

    async def handle_typing(self, data: dict):
        """Broadcasts typing indicator to the other party."""
        blocked, _ = await self.is_chat_blocked()
        if blocked:
            return
        await self.channel_layer.group_send(
            self.room_group,
            {
                'type': 'broadcast_typing',
                'sender': self.me.username,
                'is_typing': bool(data.get('is_typing', False)),
            }
        )

    async def broadcast_group_message(self, event: dict):
        """Handle group messages forwarded from GroupChatConsumer."""
        payload = {k: v for k, v in event.items() if k != 'type'}
        payload['type'] = 'group_message'
        await self.send(text_data=json.dumps(payload))

    async def handle_delivered_receipt(self, data: dict):
        """Receiver notifies sender that a specific message was delivered."""
        message_id = data.get('message_id')
        if not message_id:
            return
        await self.mark_message_delivered(int(message_id))
        await self.channel_layer.group_send(
            self.room_group,
            {
                'type': 'broadcast_message_status',
                'message_id': int(message_id),
                'status': 'delivered',
            }
        )

    async def handle_read_receipt(self, data: dict):
        read_ids = await self.mark_messages_read_get_ids()
        for msg_id in read_ids:
            await self.channel_layer.group_send(
                self.room_group,
                {
                    'type': 'broadcast_message_status',
                    'message_id': msg_id,
                    'status': 'read',
                }
            )

    async def handle_retention_update(self, data: dict):
        """Broadcasts retention setting changes to the room."""
        retention_days = data.get('retention_days')
        if not retention_days:
            return
        await self.channel_layer.group_send(
            self.room_group,
            {
                'type': 'chat_setting_update',
                'retention_days': retention_days,
                'updated_by': self.me.username,
            }
        )

    # ---- Broadcast relays (called by group_send) ---------------------------------

    async def broadcast_message(self, event):
        payload = {k: v for k, v in event.items() if k != 'type'}
        payload['type'] = 'chat_message'
        await self.send(text_data=json.dumps(payload))

    async def broadcast_file_notification(self, event):
        payload = {k: v for k, v in event.items() if k != 'type'}
        payload['type'] = 'file_notification'
        await self.send(text_data=json.dumps(payload))

    async def broadcast_typing(self, event):
        await self.send(text_data=json.dumps({
            'type': 'typing',
            'sender': event['sender'],
            'is_typing': event['is_typing'],
        }))

    async def broadcast_message_status(self, event):
        """Relay message_status events (sent / delivered / read) to both clients."""
        await self.send(text_data=json.dumps({
            'type': 'message_status',
            'message_id': event['message_id'],
            'status': event['status'],
        }))

    async def presence_update(self, event):
        await self.send(text_data=json.dumps({
            'type': 'presence',
            'username': event['username'],
            'status': event.get('status', 'inactive'),
            'last_seen': event.get('last_seen'),
        }))

    async def message_removed(self, event):
        """Relay professional deletion events to connected clients."""
        await self.send(text_data=json.dumps({
            'type': 'message_removed',
            'message_id': event['message_id'],
            'removal_scope': event.get('removal_scope'),
            'removed_by': event.get('removed_by'),
        }))

    async def chat_setting_update(self, event):
        """Relay chat setting updates to connected clients."""
        await self.send(text_data=json.dumps({
            'type': 'chat_setting_update',
            'retention_days': event['retention_days'],
            'updated_by': event['updated_by'],
        }))

    async def chat_cleared(self, event):
        """Relay a chat_cleared event so both participants wipe their UI."""
        await self.send(text_data=json.dumps({
            'type': 'chat_cleared',
            'cleared_by': event.get('cleared_by'),
            'other_user': event.get('other_user'),
            'group_id': event.get('group_id'),
        }))

    async def friend_request(self, event):
        """Relay friend request event to the client."""
        await self.send(text_data=json.dumps({
            'type': 'friend_request',
            'sender': event['sender'],
        }))

    async def friend_request_accepted(self, event):
        """Relay friend request accepted event so sender updates sidebar."""
        await self.send(text_data=json.dumps({
            'type': 'friend_request_accepted',
            'new_friend': event['new_friend'],
        }))

    async def group_invite(self, event):
        """Relays a group invite notification to the user."""
        await self.send(text_data=json.dumps({
            'type': 'group_invite',
            'invite_id': event['invite_id'],
            'group_id': event['group_id'],
            'group_name': event['group_name'],
            'inviter': event['inviter'],
        }))

    async def group_deleted(self, event):
        """Relays a group deletion notification to the user."""
        await self.send(text_data=json.dumps({
            'type': 'group_deleted',
            'group_id': event['group_id'],
            'group_name': event['group_name'],
            'deleted_by': event['deleted_by'],
            'reason': event.get('reason'),
        }))

    async def new_moment(self, event):
        """Relay a new moment to the connected client."""
        await self.send(text_data=json.dumps({
            'type': 'new_moment',
            'moment': event['moment']
        }))

    async def delete_moment(self, event):
        """Relay a moment deletion event to the client."""
        await self.send(text_data=json.dumps({
            'type': 'delete_moment',
            'moment_id': event['moment_id'],
            'user_id': event['user_id']
        }))

    async def moment_viewed(self, event):
        """Relay a moment viewed event to the client."""
        await self.send(text_data=json.dumps({
            'type': 'moment_viewed',
            'moment_id': event['moment_id'],
            'viewer': event['viewer']
        }))

    async def moment_reacted(self, event):
        """Relay a moment reacted event to the client."""
        await self.send(text_data=json.dumps({
            'type': 'moment_reacted',
            'moment_id': event['moment_id'],
            'reaction': event['reaction']
        }))

    async def user_blocked(self, event):
        """Relay a user blocked event to the client."""
        await self.send(text_data=json.dumps({
            'type': 'user_blocked',
            'blocker_id': event['blocker_id'],
            'blocker_username': event['blocker_username'],
            'blocked_id': event['blocked_id'],
            'blocked_username': event['blocked_username']
        }))

    async def user_unblocked(self, event):
        """Relay a user unblocked event to the client."""
        await self.send(text_data=json.dumps({
            'type': 'user_unblocked',
            'unblocker_id': event['unblocker_id'],
            'unblocker_username': event['unblocker_username'],
            'unblocked_id': event['unblocked_id'],
            'unblocked_username': event['unblocked_username']
        }))

    # ---- Utilities ---------------------------------------------------------

    async def send_error(self, message: str):
        await self.send(text_data=json.dumps({'type': 'error', 'message': message}))

    @database_sync_to_async
    def is_chat_blocked(self) -> tuple:
        """WhatsApp-style blocking: only checks blocked_users.

        Returns (blocked: bool, reason: str).
        """
        try:
            if self.me.id == self.other_user.id:
                return False, ''

            me_profile = self.me.profile
            other_profile = self.other_user.profile

            # I blocked them — I must unblock to send
            if me_profile.blocked_users.filter(id=other_profile.id).exists():
                return True, 'Unblock this contact to send messages.'

            # They blocked me — messages silently fail
            if other_profile.blocked_users.filter(id=me_profile.id).exists():
                return True, 'Message not delivered.'
        except Exception:
            # Fail open to avoid breaking chat due to profile edge cases.
            return False, ''
        return False, ''

    # ---- DB helpers (sync wrapped) -----------------------------------------

    @database_sync_to_async
    def save_message(self, data: dict) -> dict | None:
        from .models import Message
        try:
            is_self_chat = (self.me.id == self.other_user.id)
            moment_id = data.get('moment_id')
            replied_moment = None
            if moment_id:
                from .models import Moment
                replied_moment = Moment.objects.filter(id=moment_id).first()

            from .models import ChatSetting
            from django.utils import timezone
            from datetime import timedelta
            
            # Fetch retention setting
            lo_user, hi_user = sorted([self.me, self.other_user], key=lambda u: u.id)
            setting, _ = ChatSetting.objects.get_or_create(user1=lo_user, user2=hi_user)
            retention_days = setting.retention_days
            expires_at = timezone.now() + timedelta(days=retention_days)

            msg = Message.objects.create(
                sender=self.me,
                receiver=self.other_user,
                message=data.get('message', ''),
                message_type=data.get('message_type', Message.MESSAGE_TYPE_TEXT),
                original_filename=data.get('original_filename', ''),
                mime_type=data.get('mime_type', ''),
                replied_moment=replied_moment,
                is_delivered=is_self_chat,
                is_read=is_self_chat,
                expires_at=expires_at,
            )

            # Automatically unhide users when messaging resumes
            if not is_self_chat:
                try:
                    self.me.profile.hidden_users.remove(self.other_user.profile)
                    self.other_user.profile.hidden_users.remove(self.me.profile)
                except Exception:
                    pass

            result = {'id': msg.id, 'timestamp': msg.timestamp.isoformat()}
            if replied_moment:
                result['replied_moment'] = {
                    'id': replied_moment.id,
                    'media_url': replied_moment.media.url if replied_moment.media else '',
                    'moment_type': replied_moment.moment_type,
                    'text_content': replied_moment.text_content
                }
            return result
        except Exception as exc:
            logger.error(f'[WS] save_message error: {exc}')
            return None

    @database_sync_to_async
    def resolve_other_user(self, route_kwargs: dict):
        user_id = route_kwargs.get('user_id')
        username = route_kwargs.get('username')
        try:
            if user_id is not None:
                return User.objects.filter(id=int(user_id)).first()
            if username:
                return User.objects.filter(username=username).first()
        except (TypeError, ValueError):
            return None
        return None

    @database_sync_to_async
    def is_account_deleted(self, user) -> bool:
        """Returns True if the user's account has been soft-deleted."""
        from users.models import UserProfile
        try:
            return not user.profile.is_active_account
        except UserProfile.DoesNotExist:
            return False

    @database_sync_to_async
    def get_user_presence(self, user) -> dict:
        """Returns the current presence state for a given user."""
        from users.models import UserProfile
        try:
            profile = UserProfile.objects.get(user=user)
            return {
                'is_online': profile.is_online,
                'last_seen': profile.last_seen.isoformat() if profile.last_seen else None,
            }
        except UserProfile.DoesNotExist:
            return {'is_online': False, 'last_seen': None}
        except Exception as exc:
            logger.warning(f'[WS] get_user_presence error: {exc}')
            return {'is_online': False, 'last_seen': None}

    @database_sync_to_async
    def set_online(self, status: bool) -> str | None:
        """Sets is_online flag and returns last_seen ISO string when going offline."""
        from django.utils import timezone
        from users.models import UserProfile
        try:
            profile, _ = UserProfile.objects.get_or_create(user=self.me)
            
            # Detailed log for production monitoring and debugging
            if profile.is_online != status:
                logger.info(f'[Presence] User {self.me.username} toggling status: {profile.is_online} -> {status}')
                
            profile.is_online = status
            profile.last_seen = timezone.now()
            profile.save(update_fields=['is_online', 'last_seen'])
            if not status:
                return profile.last_seen.isoformat()
        except Exception as exc:
            logger.warning(f'[WS] set_online error: {exc}')
        return None

    async def _verify_and_restore_online_status(self):
        """Self-healing heartbeat utility: restores status if database/cache got desynced."""
        try:
            profile = await self._get_my_profile()
            if not profile or not profile.is_online:
                logger.info(f'[Presence] Heartbeat self-heal: restoring {self.me.username} to online state')
                await self.set_online(True)
                await self.channel_layer.group_send(
                    'presence_all',
                    {
                        'type': 'broadcast_presence',
                        'user_id': self.me.id,
                        'username': self.me.username,
                        'is_online': True,
                        'last_seen': None
                    }
                )
        except Exception as exc:
            logger.warning(f'[WS] self-healing heartbeat check failed: {exc}')

    @database_sync_to_async
    def _get_my_profile(self):
        from users.models import UserProfile
        try:
            return UserProfile.objects.filter(user=self.me).first()
        except Exception:
            return None

    # ---- Presence connection counting (cache) -----------------------------

    def _presence_cache_key(self) -> str:
        # One key per authenticated user
        return f'sdh_ws_conn_count_user_{self.me.id}'

    @database_sync_to_async
    def _get_active_connection_count(self) -> int:
        try:
            return int(cache.get(self._presence_cache_key(), 0) or 0)
        except Exception:
            return 0

    @database_sync_to_async
    def _incr_active_connections(self) -> bool:
        """Returns True when transitioning 0→1 (user becomes online)."""
        key = self._presence_cache_key()
        try:
            current = int(cache.get(key, 0) or 0)
            new_val = current + 1
            # Use timeout=None so active connections never expire prematurely.
            cache.set(key, new_val, timeout=None)
            return current == 0
        except Exception as exc:
            logger.warning(f'[WS] incr_active_connections error: {exc}')
            return True

    @database_sync_to_async
    def _decr_active_connections(self) -> bool:
        """Returns True when transitioning 1→0 (user may become offline)."""
        key = self._presence_cache_key()
        try:
            current = int(cache.get(key, 0) or 0)
            new_val = max(0, current - 1)
            if new_val == 0:
                cache.delete(key)
                return current > 0
            # Use timeout=None so active connections never expire prematurely.
            cache.set(key, new_val, timeout=None)
            return False
        except Exception as exc:
            logger.warning(f'[WS] decr_active_connections error: {exc}')
            return True

    @database_sync_to_async
    def mark_message_delivered(self, message_id: int):
        from .models import Message
        try:
            Message.objects.filter(
                pk=message_id,
                receiver=self.me,
                is_delivered=False,
            ).update(is_delivered=True)
        except Exception as exc:
            logger.warning(f'[WS] mark_message_delivered error: {exc}')

    @database_sync_to_async
    def mark_and_get_newly_delivered(self) -> list:
        """Marks all undelivered messages sent to me from other_user as delivered.
        Returns the list of IDs that were just marked."""
        from .models import Message
        try:
            other = User.objects.filter(username=self.other_username).first()
            if not other:
                return []
            ids = list(
                Message.objects.filter(
                    sender=other,
                    receiver=self.me,
                    is_delivered=False,
                ).values_list('id', flat=True)
            )
            if ids:
                Message.objects.filter(pk__in=ids).update(is_delivered=True)
            return ids
        except Exception as exc:
            logger.warning(f'[WS] mark_and_get_newly_delivered error: {exc}')
            return []

    @database_sync_to_async
    def mark_messages_read_get_ids(self) -> list:
        """Marks all unread messages from other_user as read and returns their IDs."""
        from .models import Message
        try:
            other = User.objects.get(username=self.other_username)
            ids = list(
                Message.objects.filter(
                    sender=other,
                    receiver=self.me,
                    is_read=False,
                ).values_list('id', flat=True)
            )
            if ids:
                Message.objects.filter(pk__in=ids).update(is_delivered=True, is_read=True)
            return ids
        except Exception:
            return []


# ---------------------------------------------------------------------------
# 2. SignalingConsumer (WebRTC)
# ---------------------------------------------------------------------------
class SignalingConsumer(AsyncWebsocketConsumer):
    """
    Acts as the WebRTC signaling server.

    Each authenticated user joins their own personal group  ``user_<id>``.
    Incoming signals must carry a ``to_user`` field (username) so the server
    can route the payload to exactly the intended recipient's group.

    URL pattern: /ws/signal/<username>/
    (The <username> path parameter is accepted for routing compatibility but
    the group assignment is always based on the authenticated user's own ID.)
    """

    # ── Connection lifecycle ─────────────────────────────────────

    async def connect(self):
        if not self.scope['user'].is_authenticated:
            await self.close(code=4001)
            return

        self.me = self.scope['user']

        # Each user joins ONE personal inbox group based on their own ID.
        # This means ANY other user can send signals to them as long as they
        # know the target's username (resolved to ID server-side).
        self.user_group = f'user_{self.me.id}'

        await self.channel_layer.group_add(self.user_group, self.channel_name)
        await self.accept()
        logger.info(
            f'[Signal] {self.me.username} (id={self.me.id}) connected — '
            f'listening on group {self.user_group}'
        )

    async def disconnect(self, code):
        if hasattr(self, 'user_group'):
            await self.channel_layer.group_discard(self.user_group, self.channel_name)
        logger.info(f'[Signal] {getattr(self, "me", "?")} disconnected (code={code})')

    # ── Inbound frames from the browser ─────────────────────────

    async def receive(self, text_data=None, bytes_data=None):
        try:
            data = json.loads(text_data)
        except (json.JSONDecodeError, TypeError):
            return

        sig_type = data.get('type')
        allowed_types = {
            'offer', 'answer', 'ice-candidate',
            'call-request', 'call-accept', 'call-reject', 'call-end',
            'call-quality',
        }
        if sig_type not in allowed_types:
            return

        # Every signal frame MUST specify the intended recipient by username.
        to_username = data.get('to_user')
        if not to_username:
            logger.warning(
                f'[Signal] "{sig_type}" from {self.me.username} missing to_user — dropped'
            )
            return

        # Prevent relaying a signal back to the sender themselves
        if to_username == self.me.username:
            return

        target_user = await self._resolve_user(to_username)
        if not target_user:
            logger.warning(
                f'[Signal] Target user "{to_username}" not found — signal dropped'
            )
            return

        if await self._is_signal_blocked(target_user):
            logger.info(
                f'[Signal] "{sig_type}" from {self.me.username} to '
                f'{to_username} blocked by contact settings'
            )
            return

        target_group = f'user_{target_user.id}'

        # If it's a call request and the user is offline, immediately reject it
        if sig_type == 'call-request':
            try:
                target_profile = target_user.profile
                if not target_profile.is_online:
                    await self.send(text_data=json.dumps({
                        'type': 'call-offline',
                        'from': to_username
                    }))
                    return
            except Exception:
                pass

        await self.channel_layer.group_send(
            target_group,
            {
                'type': 'signal_message',
                'from_user': self.me.username,
                'payload': data,
            }
        )

    # ── Outbound frame handler (channel layer → browser) ─────────

    async def signal_message(self, event):
        """Deliver a routed signal to the connected browser client."""
        payload = dict(event['payload'])
        # Stamp the sender's username so the browser knows who it came from
        payload['from'] = event['from_user']
        # Strip the routing field — it is irrelevant to the receiver
        payload.pop('to_user', None)
        await self.send(text_data=json.dumps(payload))

    # ── DB helper ────────────────────────────────────────────────

    @database_sync_to_async
    def _resolve_user(self, username: str):
        try:
            return User.objects.filter(username=username, is_active=True).first()
        except Exception as exc:
            logger.warning(f'[Signal] _resolve_user error: {exc}')
            return None

    @database_sync_to_async
    def _is_signal_blocked(self, target_user) -> bool:
        """Block WebRTC signaling when either side has blocked the other.

        Only checks blocked_users (WhatsApp-style). hidden_users is
        cosmetic only and does not affect calls.
        """
        try:
            me_profile = self.me.profile
            target_profile = target_user.profile
        except Exception:
            return False

        try:
            if me_profile.blocked_users.filter(id=target_profile.id).exists():
                return True
        except Exception:
            pass
        try:
            if target_profile.blocked_users.filter(id=me_profile.id).exists():
                return True
        except Exception:
            pass

        return False


# ---------------------------------------------------------------------------
# 3. GroupChatConsumer
# ---------------------------------------------------------------------------
class GroupChatConsumer(ChatConsumer):
    """
    Handles real-time messaging within a group.

    URL pattern: /ws/group/<group_id>/
    """

    async def connect(self):
        if not self.scope['user'].is_authenticated:
            await self.close(code=4001)
            return

        self.me = self.scope['user']
        self.group_id = int(self.scope['url_route']['kwargs']['group_id'])
        self.room_group = f'group_chat_{self.group_id}'

        # Verify membership
        is_member = await self._check_membership()
        if not is_member:
            await self.close(code=4003)
            return

        await self.channel_layer.group_add(self.room_group, self.channel_name)
        await self.channel_layer.group_add('presence_all', self.channel_name)
        
        self.personal_group = f'user_chat_{self.me.id}'
        await self.channel_layer.group_add(self.personal_group, self.channel_name)
        
        self._presence_debounce_seconds = 30.0
        became_online = await self._incr_active_connections()
        
        # Always update DB and broadcast presence to override cache desyncs
        await self.set_online(True)
        await self.channel_layer.group_send(
            'presence_all',
            {
                'type': 'broadcast_presence',
                'user_id': self.me.id,
                'username': self.me.username,
                'is_online': True,
                'last_seen': None
            }
        )

        await self.accept()
        logger.info(f'[WS-Group] {self.me.username} connected to group {self.group_id}')

    async def disconnect(self, code):
        if hasattr(self, 'room_group'):
            await self.channel_layer.group_discard(self.room_group, self.channel_name)
            
        await self.channel_layer.group_discard('presence_all', self.channel_name)
        if hasattr(self, 'personal_group'):
            await self.channel_layer.group_discard(self.personal_group, self.channel_name)
            
        if hasattr(self, 'me'):
            became_offline = await self._decr_active_connections()
            if became_offline:
                asyncio.create_task(self._debounced_offline())

    async def receive(self, text_data=None, bytes_data=None):
        try:
            data = json.loads(text_data)
        except (json.JSONDecodeError, TypeError):
            await self.send_error('Invalid JSON payload.')
            return

        msg_type = data.get('type')

        if msg_type == 'group_message':
            await self.handle_group_message(data)
        elif msg_type == 'typing':
            await self.handle_typing(data)
        elif msg_type == 'mark_read':
            await self.handle_mark_read(data)
        elif msg_type == 'ping':
            await self._verify_and_restore_online_status()
            await self.send(text_data=json.dumps({'type': 'pong'}))
        else:
            await self.send_error(f'Unknown message type: {msg_type}')

    async def handle_group_message(self, data):
        """Persist and broadcast a group message."""
        message_text = data.get('message', '').strip()
        if not message_text:
            await self.send_error('Empty message.')
            return

        msg = await self._save_group_message(message_text)
        if not msg:
            await self.send_error('Failed to save message.')
            return

        payload = {
            'type': 'broadcast_group_message',
            'message_id': msg['id'],
            'sender': self.me.username,
            'sender_id': self.me.id,
            'message': message_text,
            'message_type': 'text',
            'timestamp': msg['timestamp'],
            'is_system_message': False,
            'group_id': self.group_id,
        }

        member_ids = await self._get_group_member_ids()
        for user_id in member_ids:
            await self.channel_layer.group_send(
                f'user_chat_{user_id}',
                payload
            )

    @database_sync_to_async
    def _get_group_member_ids(self):
        from .models import GroupMembership
        return list(GroupMembership.objects.filter(group_id=self.group_id).values_list('user_id', flat=True))

    async def handle_typing(self, data):
        """Broadcast typing indicator to all group members."""
        await self.channel_layer.group_send(
            self.room_group,
            {
                'type': 'broadcast_typing',
                'sender': self.me.username,
                'is_typing': bool(data.get('is_typing', False)),
            }
        )

    async def handle_mark_read(self, data):
        """Mark a specific message as read by this user."""
        message_id = data.get('message_id')
        if not message_id:
            return
            
        await self._mark_group_message_read(message_id)
        
        await self.channel_layer.group_send(
            self.room_group,
            {
                'type': 'broadcast_group_read',
                'message_id': message_id,
                'user_id': self.me.id,
                'username': self.me.username,
            }
        )


    # ---- Broadcast relays ----

    async def broadcast_group_message(self, event):
        payload = {k: v for k, v in event.items() if k != 'type'}
        payload['type'] = 'group_message'
        await self.send(text_data=json.dumps(payload))

    async def broadcast_typing(self, event):
        await self.send(text_data=json.dumps({
            'type': 'typing',
            'sender': event['sender'],
            'is_typing': event['is_typing'],
        }))

    async def broadcast_group_read(self, event):
        await self.send(text_data=json.dumps({
            'type': 'message_read',
            'message_id': event['message_id'],
            'user_id': event['user_id'],
            'username': event['username'],
        }))

    async def group_system_message(self, event):
        """Relay system messages (member joined/left, role changes)."""
        await self.send(text_data=json.dumps({
            'type': 'group_message',
            'message_id': event.get('message_id'),
            'sender': None,
            'message': event['message'],
            'message_type': 'system',
            'timestamp': event.get('timestamp', ''),
            'is_system_message': True,
        }))

    async def group_member_update(self, event):
        """Notify clients of membership changes so they can refresh the member list."""
        await self.send(text_data=json.dumps({
            'type': 'group_member_update',
            'action': event.get('action'),  # 'added', 'removed', 'left', 'role_changed'
            'user_id': event.get('user_id'),
            'username': event.get('username'),
            'role': event.get('role'),
        }))

    # ---- Utilities ----

    async def send_error(self, message):
        await self.send(text_data=json.dumps({'type': 'error', 'message': message}))

    @database_sync_to_async
    def _check_membership(self):
        from .models import GroupMembership
        return GroupMembership.objects.filter(
            group_id=self.group_id, user=self.me
        ).exists()

    @database_sync_to_async
    def _save_group_message(self, message_text):
        from .models import GroupMessage
        try:
            msg = GroupMessage.objects.create(
                group_id=self.group_id,
                sender=self.me,
                message=message_text,
                message_type=GroupMessage.MESSAGE_TYPE_TEXT,
            )
            # Touch group updated_at for sidebar ordering
            from .models import Group
            Group.objects.filter(id=self.group_id).update(
                updated_at=msg.timestamp
            )
            return {'id': msg.id, 'timestamp': msg.timestamp.isoformat()}
        except Exception as exc:
            logger.error(f'[WS-Group] save_group_message error: {exc}')
            return None

    @database_sync_to_async
    def _mark_group_message_read(self, message_id):
        from .models import GroupMessage, GroupMessageRead
        try:
            msg = GroupMessage.objects.get(id=message_id, group_id=self.group_id)
            GroupMessageRead.objects.get_or_create(message=msg, user=self.me)
        except Exception as exc:
            logger.error(f'[WS-Group] mark_read error: {exc}')
