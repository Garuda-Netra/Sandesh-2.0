"""
Messaging Views

Main chat interface and message history API.
"""

import json
import os
import requests
import base64

from django.shortcuts import render, get_object_or_404
from django.contrib.auth.decorators import login_required
from django.contrib.auth.models import User
from django.http import JsonResponse, FileResponse, Http404
from django.views.decorators.http import require_GET, require_POST, require_http_methods
from django.views.decorators.csrf import csrf_protect
from django.db.models import Q
from django.conf import settings

from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync

from .models import Message, Group, GroupMembership, GroupMessage, GroupMessageRead
from .chatbot import generate_chatbot_reply
from users.models import UserProfile, Friendship

# Maximum file size accepted (5 MB)
_MAX_FILE_BYTES = 5 * 1024 * 1024  # 5 MB

# Allowed upload MIME types
_ALLOWED_MIME_PREFIXES = ('image/', 'video/', 'audio/')
_ALLOWED_MIME_TYPES = {
    # Documents
    'application/pdf',
    'application/msword',                                                        # .doc
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',   # .docx
    'application/vnd.ms-excel',                                                  # .xls
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',         # .xlsx
    'application/vnd.ms-powerpoint',                                             # .ppt
    'application/vnd.openxmlformats-officedocument.presentationml.presentation', # .pptx
    'application/vnd.oasis.opendocument.presentation',                           # .odp
    # Archives
    'application/zip',
    'application/x-rar-compressed',
    'application/x-7z-compressed',
    # Text
    'text/plain',
    'text/csv',
}


def _hidden_user_ids(user):
    """Return User IDs hidden from the current user's contact surfaces.

    Only checks hidden_users (cosmetic hiding).
    Blocked users stay visible per WhatsApp-style blocking.
    """
    try:
        profile = user.profile
    except Exception:
        return []

    user_ids = set()
    try:
        user_ids.update(profile.hidden_users.values_list('user_id', flat=True))
    except Exception:
        pass
    return list(user_ids)


def _is_chat_blocked(user, other_user):
    """WhatsApp-style blocking check.

    Returns a tuple: (blocked: bool, reason: str)
      - If user blocked other_user: blocked, "unblock to send"
      - If other_user blocked user: blocked, "message not delivered"
      - Otherwise: not blocked
    """
    if user.id == other_user.id:
        return False, ''

    try:
        my_profile = user.profile
        other_profile = other_user.profile
    except UserProfile.DoesNotExist:
        return False, ''

    # Check if I blocked them
    try:
        if my_profile.blocked_users.filter(id=other_profile.id).exists():
            return True, 'Unblock this contact to send messages.'
    except Exception:
        pass

    # Check if they blocked me
    try:
        if other_profile.blocked_users.filter(id=my_profile.id).exists():
            return True, 'Message not delivered.'
    except Exception:
        pass

    return False, ''


def _positive_int(value, default, max_value=None):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    number = max(1, number)
    if max_value is not None:
        number = min(number, max_value)
    return number


# ---------------------------------------------------------------------------
# Chat Page
# ---------------------------------------------------------------------------
@login_required
def chat_view(request):
    """
    Main chat interface.
    Loads the shell; real-time messages flow via WebSocket.
    """
    try:
        my_profile = request.user.profile
    except UserProfile.DoesNotExist:
        my_profile = UserProfile.objects.create(user=request.user)

    # Get friends + blocked contacts (WhatsApp-style: blocked stay visible)
    hidden_ids = _hidden_user_ids(request.user)
    friend_profile_ids = Friendship.get_friend_profile_ids(my_profile)
    blocked_profile_ids = set(
        my_profile.blocked_users.values_list('id', flat=True)
    )

    # Convert to user IDs
    friend_user_ids = set(
        UserProfile.objects.filter(id__in=friend_profile_ids)
        .values_list('user_id', flat=True)
    ) if friend_profile_ids else set()
    blocked_user_ids = set(
        UserProfile.objects.filter(id__in=blocked_profile_ids)
        .values_list('user_id', flat=True)
    ) if blocked_profile_ids else set()

    visible_ids = (friend_user_ids | blocked_user_ids) - set(hidden_ids)
    visible_ids.discard(request.user.id)

    users = (
        User.objects
        .filter(id__in=visible_ids)
        .filter(profile__is_active_account=True)
        .select_related('profile')
        .order_by('username')
    )

    # Build user list with online status and last_seen
    user_data = []

    # Pinned self-chat (WhatsApp-style "message yourself")
    user_data.append({
        'user': request.user,
        'is_online': True,
        'last_seen': None,
        'is_self_chat': True,
        'is_blocked': False,
    })

    for u in users:
        try:
            profile = u.profile
            is_online = profile.is_online
            last_seen = profile.last_seen  # datetime object for template filters
        except UserProfile.DoesNotExist:
            is_online = False
            last_seen = None
        user_data.append({
            'user': u,
            'is_online': is_online,
            'last_seen': last_seen,
            'is_self_chat': False,
            'is_blocked': u.id in blocked_user_ids,
        })

    # Put self first, then online users
    user_data.sort(key=lambda x: (not x.get('is_self_chat', False), not x['is_online'], x['user'].username.lower()))

    # Build serializable users list for JS to avoid IDE syntax/parsing issues in HTML template
    serializable_users = []
    for contact in user_data:
        if contact.get('is_self_chat'):
            continue
        u = contact['user']
        avatar_url = ''
        try:
            profile = u.profile
            if profile.avatar and profile.avatar.name:
                avatar_url = profile.avatar.url
        except Exception:
            pass
        serializable_users.append({
            'id': u.id,
            'username': u.username,
            'avatar_url': avatar_url,
            'is_online': contact.get('is_online', False),
            'last_seen': contact.get('last_seen').isoformat() if contact.get('last_seen') else None,
        })

    # Fetch groups the user is a member of
    memberships = GroupMembership.objects.filter(user=request.user).select_related('group')
    user_groups = []
    for m in memberships:
        avatar_url = ''
        try:
            if m.group.avatar and m.group.avatar.name:
                avatar_url = m.group.avatar.url
        except Exception:
            pass
        user_groups.append({
            'id': m.group.id,
            'name': m.group.name,
            'description': m.group.description,
            'avatar_url': avatar_url,
            'role': m.role,
        })

    context = {
        'users': user_data,
        'users_json': serializable_users,
        'groups': user_groups,
        'current_user': request.user,
        'turn_server_url': settings.TURN_SERVER_URL,
        'turn_server_username': settings.TURN_SERVER_USERNAME,
        'turn_server_credential': settings.TURN_SERVER_CREDENTIAL,
    }
    return render(request, 'messaging/chat.html', context)


# ---------------------------------------------------------------------------
# Message History API
# ---------------------------------------------------------------------------
@login_required
@require_GET
def message_history(request, username):
    """
    Returns paginated message history between
    the current user and the named user.
    """
    other_user = get_object_or_404(User, username=username)
    page = _positive_int(request.GET.get('page'), 1)
    per_page = _positive_int(request.GET.get('per_page'), 50, max_value=100)

    # Purge expired messages immediately before reading
    Message.objects.filter(expires_at__lt=timezone.now()).delete()

    messages_qs = (
        Message.objects
        .filter(
            (Q(sender=request.user) & Q(receiver=other_user)) |
            (Q(sender=other_user) & Q(receiver=request.user))
        )
        .exclude(
            Q(sender=request.user, deleted_by_sender=True) |
            Q(receiver=request.user, deleted_by_receiver=True)
        )
        # "Remove from My View" — hide only for the requesting user
        .exclude(hidden_for_users=request.user)
        .order_by('-timestamp')
    )

    total = messages_qs.count()
    start = (page - 1) * per_page
    end = start + per_page
    messages_page = list(reversed(messages_qs[start:end]))

    # Mark unread messages as read
    Message.objects.filter(
        sender=other_user,
        receiver=request.user,
        is_read=False
    ).update(is_read=True)

    def _display_name(u):
        """Return username; append '(Account Deleted)' for soft-deleted accounts."""
        try:
            if not u.profile.is_active_account:
                return f'{u.username} (Account Deleted)'
        except Exception:
            pass
        return u.username

    data = [
        {
            'id': m.id,
            'sender': _display_name(m.sender),
            'receiver': _display_name(m.receiver),
            'message': m.message,
            'message_type': m.message_type,
            'original_filename': m.original_filename or m.file_name or '',
            'mime_type': m.mime_type,
            'timestamp': m.timestamp.isoformat(),
            'is_delivered': m.is_delivered,
            'is_read': m.is_read,
            'is_mine': m.sender == request.user,
            'has_file': bool(m.file),
            'file_id': m.id if m.file else None,
            'is_deleted_for_all': m.is_deleted_for_all,
            'replied_moment': {
                'id': m.replied_moment.id,
                'media_url': m.replied_moment.media.url if m.replied_moment.media else '',
                'moment_type': m.replied_moment.moment_type,
                'text_content': m.replied_moment.text_content
            } if m.replied_moment else None,
        }
        for m in messages_page
    ]

    return JsonResponse({
        'messages': data,
        'total': total,
        'page': page,
        'has_more': end < total,
    })


# ---------------------------------------------------------------------------
# Save Message (REST fallback — primary path is via WebSocket)
# ---------------------------------------------------------------------------
@login_required
@require_POST
def save_message(request):
    """
    REST fallback for saving a message.
    Primary message saving happens inside the WebSocket consumer.
    """
    try:
        data = json.loads(request.body)
        receiver_username = data.get('receiver')
        message           = data.get('message', '')
        message_type      = data.get('message_type', Message.MESSAGE_TYPE_TEXT)
        original_filename = data.get('original_filename', '')
        mime_type         = data.get('mime_type', '')
        moment_id         = data.get('moment_id', None)

        if not receiver_username:
            return JsonResponse({'error': 'Missing required fields.'}, status=400)

        receiver = User.objects.filter(username=receiver_username).first()
        if not receiver:
            return JsonResponse({'error': 'Recipient not found.'}, status=404)

        blocked, reason = _is_chat_blocked(request.user, receiver)
        if blocked:
            return JsonResponse({'error': reason}, status=403)

        is_self_chat = receiver == request.user

        replied_moment = None
        if moment_id:
            from .models import Moment
            replied_moment = Moment.objects.filter(id=moment_id).first()

        from .models import ChatSetting
        from datetime import timedelta
        
        # Calculate expiration
        lo_user, hi_user = sorted([request.user, receiver], key=lambda u: u.id)
        setting, _ = ChatSetting.objects.get_or_create(user1=lo_user, user2=hi_user)
        retention_days = setting.retention_days
        expires_at = timezone.now() + timedelta(days=retention_days)

        msg = Message.objects.create(
            sender=request.user,
            receiver=receiver,
            message=message,
            message_type=message_type,
            original_filename=original_filename,
            mime_type=mime_type,
            replied_moment=replied_moment,
            is_delivered=is_self_chat,
            is_read=is_self_chat,
            expires_at=expires_at,
        )

        try:
            from channels.layers import get_channel_layer
            from asgiref.sync import async_to_sync
            lo, hi = sorted([request.user.id, receiver.id])
            room_group = f'chat_{lo}__{hi}'
            
            payload = {
                'type': 'broadcast_message',
                'message_id': msg.id,
                'sender': request.user.username,
                'receiver': receiver.username,
                'receiver_id': receiver.id,
                'message': msg.message,
                'message_type': msg.message_type,
                'original_filename': msg.original_filename,
                'mime_type': msg.mime_type,
                'timestamp': msg.timestamp.isoformat(),
            }
            if replied_moment:
                payload['replied_moment'] = {
                    'id': replied_moment.id,
                    'media_url': replied_moment.media.url if replied_moment.media else '',
                    'moment_type': replied_moment.moment_type,
                    'text_content': replied_moment.text_content
                }
                
            async_to_sync(get_channel_layer().group_send)(room_group, payload)
        except Exception:
            pass # Ignore channel layer errors in REST fallback

        return JsonResponse({
            'status': 'ok',
            'message_id': msg.id,
            'timestamp': msg.timestamp.isoformat(),
        })

    except Exception as e:
        return JsonResponse({'status': 'error', 'message': str(e)}, status=500)

# ---------------------------------------------------------------------------
# Spotify Proxy API
# ---------------------------------------------------------------------------
@login_required
@require_GET
def spotify_search(request):
    """
    Proxy search endpoint for Spotify API to keep keys secure.
    Returns preview_urls if available.
    """
    query = request.GET.get('q', '').strip()
    if not query:
        return JsonResponse({'tracks': []})

    client_id = settings.SPOTIFY_CLIENT_ID
    client_secret = settings.SPOTIFY_CLIENT_SECRET
    
    if not client_id or not client_secret:
        return JsonResponse({'error': 'Spotify integration not configured on backend'}, status=500)

    try:
        # 1. Get access token
        auth_str = f"{client_id}:{client_secret}"
        b64_auth = base64.b64encode(auth_str.encode()).decode()
        token_url = "https://accounts.spotify.com/api/token"
        token_headers = {
            "Authorization": f"Basic {b64_auth}",
            "Content-Type": "application/x-www-form-urlencoded"
        }
        token_data = {"grant_type": "client_credentials"}
        
        token_res = requests.post(token_url, headers=token_headers, data=token_data, timeout=5)
        token_res.raise_for_status()
        access_token = token_res.json().get('access_token')

        # 2. Search
        search_url = f"https://api.spotify.com/v1/search?q={query}&type=track&limit=10"
        search_headers = {
            "Authorization": f"Bearer {access_token}"
        }
        search_res = requests.get(search_url, headers=search_headers, timeout=5)
        search_res.raise_for_status()
        search_data = search_res.json()

        tracks = []
        for track in search_data.get('tracks', {}).get('items', []):
            if track.get('preview_url'):
                tracks.append({
                    'id': track['id'],
                    'title': track['name'],
                    'artist': track['artists'][0]['name'] if track.get('artists') else 'Unknown Artist',
                    'album_art': track['album']['images'][0]['url'] if track.get('album') and track['album'].get('images') else None,
                    'preview_url': track['preview_url']
                })

        return JsonResponse({'tracks': tracks})

    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)
# ---------------------------------------------------------------------------
# Unread Count API
# ---------------------------------------------------------------------------
@login_required
@require_GET
def unread_counts(request):
    """Returns unread message counts grouped by sender."""
    from django.db.models import Count
    counts = (
        Message.objects
        .filter(receiver=request.user, is_read=False)
        .values('sender__username')
        .annotate(count=Count('id'))
    )
    data = {item['sender__username']: item['count'] for item in counts}
    return JsonResponse({'unread': data})


# ---------------------------------------------------------------------------
# Chatbot API
# ---------------------------------------------------------------------------
@login_required
@require_POST
def chatbot_reply(request):
    """Return a chatbot response for the given message payload."""
    try:
        payload = json.loads(request.body or '{}')
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON payload.'}, status=400)

    message = (payload.get('message') or '').strip()
    history = payload.get('history') or []
    if not isinstance(history, list):
        history = []

    if not message:
        return JsonResponse({'error': 'Message is required.'}, status=400)
    if len(message) > 2000:
        return JsonResponse({'error': 'Message is too long.'}, status=400)

    reply = generate_chatbot_reply(message, history, user=request.user)
    return JsonResponse({'reply': reply})


# ---------------------------------------------------------------------------
# File Upload
# ---------------------------------------------------------------------------
@login_required
@csrf_protect
@require_POST
def upload_file(request):
    """
    Accept a file from the browser and save it to the server.

    Expected multipart/form-data fields:
        file          – file binary
        file_name     – original filename
        receiver      – recipient username
        mime_type     – MIME type of the file
        message_type  – 'file' | 'image' | 'video'

    Returns JSON: { message_id, file_id, timestamp }
    """
    uploaded = request.FILES.get('file')
    if not uploaded:
        return JsonResponse({'error': 'No file provided.'}, status=400)

    # ── Size guard ──────────────────────────────────────────────
    if uploaded.size > _MAX_FILE_BYTES:
        return JsonResponse(
            {'error': f'File exceeds the 5 MB limit ({uploaded.size} bytes).'},
            status=413,
        )

    # ── Required metadata ───────────────────────────────────────
    receiver_username = request.POST.get('receiver', '').strip()
    file_name         = request.POST.get('file_name', uploaded.name).strip()
    mime_type         = request.POST.get('mime_type', 'application/octet-stream').strip()
    message_type      = request.POST.get('message_type', Message.MESSAGE_TYPE_FILE).strip()

    if not receiver_username:
        return JsonResponse({'error': 'Missing required fields.'}, status=400)

    if (
        mime_type not in _ALLOWED_MIME_TYPES and
        not any(mime_type.startswith(prefix) for prefix in _ALLOWED_MIME_PREFIXES)
    ):
        return JsonResponse({'error': f'File type "{mime_type}" is not supported.'}, status=400)

    if message_type not in ('file', 'image', 'video'):
        message_type = Message.MESSAGE_TYPE_FILE

    # ── Resolve receiver ────────────────────────────────────────
    receiver = User.objects.filter(username=receiver_username).first()
    if not receiver:
        return JsonResponse({'error': 'Recipient not found.'}, status=404)

    blocked, reason = _is_chat_blocked(request.user, receiver)
    if blocked:
        return JsonResponse({'error': reason}, status=403)

    is_self_chat = receiver == request.user

    # ── Persist Message ─────────────────────────────────────────
    msg = Message.objects.create(
        sender=request.user,
        receiver=receiver,
        message='',
        message_type=message_type,
        original_filename=file_name,
        file_name=file_name,
        mime_type=mime_type,
        file=uploaded,
        is_delivered=is_self_chat,
        is_read=is_self_chat,
    )

    # Automatically unhide users when messaging resumes
    if not is_self_chat:
        try:
            request.user.profile.hidden_users.remove(receiver.profile)
            receiver.profile.hidden_users.remove(request.user.profile)
        except Exception:
            pass

    return JsonResponse({
        'status': 'ok',
        'message_id': msg.id,
        'file_id': msg.id,
        'sender': request.user.username,
        'receiver': receiver_username,
        'message_type': msg.message_type,
        'original_filename': msg.file_name,
        'mime_type': msg.mime_type,
        'timestamp': msg.timestamp.isoformat(),
        'has_file': True,
    }, status=201)


# ---------------------------------------------------------------------------
# File Download
# ---------------------------------------------------------------------------
@login_required
@require_GET
def download_file(request, file_id):
    """
    Stream a file back to an authorised participant.

    Only the sender and receiver of the message may download.
    """
    msg = get_object_or_404(
        Message,
        pk=file_id,
        message_type__in=(
            Message.MESSAGE_TYPE_FILE,
            Message.MESSAGE_TYPE_IMAGE,
            Message.MESSAGE_TYPE_VIDEO,
        ),
    )

    # ── Authorisation: only sender or receiver ──────────────────
    if request.user not in (msg.sender, msg.receiver):
        raise Http404('File not found.')

    if not msg.file:
        return JsonResponse({'error': 'No file stored for this message.'}, status=404)

    # ── Stream file ─────────────────────────────────────────────
    try:
        file_handle = msg.file.open('rb')
    except FileNotFoundError:
        return JsonResponse({'error': 'File data missing on server.'}, status=404)

    # Use the stored MIME type for the Content-Type header.
    content_type = msg.mime_type or 'application/octet-stream'

    response = FileResponse(
        file_handle,
        content_type=content_type,
        as_attachment=False,
    )
    response['Content-Disposition'] = (
        f'attachment; filename="{os.path.basename(msg.file.name)}"'
    )
    response['X-SDH-Original-Mime'] = content_type
    response['X-SDH-File-Name']     = msg.file_name or msg.original_filename or 'sdh_file'
    response['Access-Control-Expose-Headers'] = (
        'X-SDH-Original-Mime, X-SDH-File-Name'
    )
    return response


# ---------------------------------------------------------------------------
# Remove from My View
# ---------------------------------------------------------------------------
@login_required
@require_POST
def remove_from_my_view(request, message_id):
    """
    Adds the current user to hidden_for_users.
    The message record is preserved; only this user stops seeing it.
    """
    msg = get_object_or_404(Message, pk=message_id)

    # Only sender or receiver may act
    if request.user not in (msg.sender, msg.receiver):
        return JsonResponse({'error': 'Not authorised.'}, status=403)

    msg.hidden_for_users.add(request.user)

    # Notify the requesting client via WebSocket so the UI can react
    lo, hi = sorted([msg.sender_id, msg.receiver_id])
    room_group = f'chat_{lo}__{hi}'
    try:
        async_to_sync(get_channel_layer().group_send)(
            room_group,
            {
                'type': 'message_removed',
                'message_id': message_id,
                'removal_scope': 'self',
                'removed_by': request.user.username,
            },
        )
    except Exception:
        pass  # channel layer may not be available in all environments

    return JsonResponse({'status': 'ok'})


# ---------------------------------------------------------------------------
# Delete for All Participants
# ---------------------------------------------------------------------------
@login_required
@require_POST
def delete_for_all(request, message_id):
    """
    Permanently removes message content for all participants.
    Only the original sender may invoke this action.
    Associated file is deleted from storage to prevent orphan files.
    """
    msg = get_object_or_404(Message, pk=message_id)

    if msg.sender != request.user:
        return JsonResponse(
            {'error': 'Only the original sender can delete a message for all participants.'},
            status=403,
        )

    # Delete file from storage and clear references
    if msg.file:
        try:
            file_path = msg.file.path
            if os.path.isfile(file_path):
                os.remove(file_path)
        except Exception:
            pass  # log in production; do not halt the operation
        msg.file = None
        msg.file_name = ''
        msg.original_filename = ''

    # For Saved Messages (self-chat), completely remove the message.
    if msg.sender == msg.receiver:
        # Save necessary details before deleting the object
        sender_id = msg.sender_id
        receiver_id = msg.receiver_id
        msg.delete()
        
        lo, hi = sorted([sender_id, receiver_id])
        room_group = f'chat_{lo}__{hi}'
        try:
            async_to_sync(get_channel_layer().group_send)(
                room_group,
                {
                    'type': 'message_removed',
                    'message_id': message_id,
                    'removal_scope': 'self',
                    'removed_by': request.user.username,
                },
            )
        except Exception:
            pass
        return JsonResponse({'status': 'ok'})

    # Replace content with professional placeholder for normal chats
    msg.message = 'This message has been deleted.'
    msg.message_type = Message.MESSAGE_TYPE_TEXT
    msg.is_deleted_for_all = True
    msg.save(update_fields=[
        'message', 'message_type', 'is_deleted_for_all',
        'file', 'file_name', 'original_filename',
    ])

    # Broadcast real-time update to all participants in this chat room
    lo, hi = sorted([msg.sender_id, msg.receiver_id])
    room_group = f'chat_{lo}__{hi}'
    try:
        async_to_sync(get_channel_layer().group_send)(
            room_group,
            {
                'type': 'message_removed',
                'message_id': message_id,
                'removal_scope': 'all',
                'removed_by': request.user.username,
            },
        )
    except Exception:
        pass

    return JsonResponse({'status': 'ok'})


# ---------------------------------------------------------------------------
# Clear All Chat
# ---------------------------------------------------------------------------
@login_required
@require_POST
def clear_chat(request, username):
    """
    Hard-deletes every message exchanged between request.user and the given user.
    Files stored on disk are removed before the DB rows are deleted.
    A real-time broadcast tells both participants to wipe their chat UI.
    """
    other_user = get_object_or_404(User, username=username)

    messages_qs = Message.objects.filter(
        Q(sender=request.user, receiver=other_user) |
        Q(sender=other_user, receiver=request.user)
    )

    # Delete files from storage to prevent orphan media
    for msg in messages_qs.exclude(file='').exclude(file=None):
        try:
            file_path = msg.file.path
            if os.path.isfile(file_path):
                os.remove(file_path)
        except Exception:
            pass  # log in production; do not halt the operation

    deleted_count, _ = messages_qs.delete()

    # Broadcast real-time clear event to both users in the shared chat room
    lo, hi = sorted([request.user.id, other_user.id])
    room_group = f'chat_{lo}__{hi}'
    try:
        async_to_sync(get_channel_layer().group_send)(
            room_group,
            {
                'type': 'chat_cleared',
                'cleared_by': request.user.username,
                'other_user': other_user.username,
            },
        )
    except Exception:
        pass

    return JsonResponse({'status': 'ok', 'deleted': deleted_count})


# ---------------------------------------------------------------------------
# Call Page
# ---------------------------------------------------------------------------
@login_required
def call_view(request, username=None):
    """
    Dedicated full-page WebRTC call interface.

    Loads the contact list so the user can initiate or receive calls.
    An optional `username` URL segment pre-selects the remote user.
    """
    try:
        my_profile = request.user.profile
    except UserProfile.DoesNotExist:
        my_profile = UserProfile.objects.create(user=request.user)

    hidden_ids = _hidden_user_ids(request.user)
    friend_profile_ids = Friendship.get_friend_profile_ids(my_profile)

    friend_user_ids = set(
        UserProfile.objects.filter(id__in=friend_profile_ids)
        .values_list('user_id', flat=True)
    ) if friend_profile_ids else set()

    visible_ids = friend_user_ids - set(hidden_ids)
    visible_ids.discard(request.user.id)

    users = (
        User.objects
        .filter(id__in=visible_ids)
        .select_related('profile')
        .order_by('username')
    )

    user_data = []
    for u in users:
        try:
            is_online = u.profile.is_online
        except UserProfile.DoesNotExist:
            is_online = False
        user_data.append({
            'user': u,
            'is_online': is_online,
        })

    context = {
        'users': user_data,
        'current_user': request.user,
        'preselect_username': username or '',
        'turn_server_url': settings.TURN_SERVER_URL,
        'turn_server_username': settings.TURN_SERVER_USERNAME,
        'turn_server_credential': settings.TURN_SERVER_CREDENTIAL,
    }
    return render(request, 'messaging/call.html', context)


# ---------------------------------------------------------------------------
# Moments (Temporary Updates) API
# ---------------------------------------------------------------------------
from django.utils import timezone

@login_required
@require_GET
def get_moments(request):
    """
    Returns active (unexpired) moments for the current user and their friends.
    Grouped by user.
    """
    try:
        my_profile = request.user.profile
    except UserProfile.DoesNotExist:
        return JsonResponse({'error': 'Profile not found.'}, status=404)

    # Get friend IDs
    friend_profile_ids = Friendship.get_friend_profile_ids(my_profile)
    friend_user_ids = set(
        UserProfile.objects.filter(id__in=friend_profile_ids)
        .values_list('user_id', flat=True)
    ) if friend_profile_ids else set()

    # Include self
    visible_user_ids = friend_user_ids | {request.user.id}

    from .models import Moment
    now = timezone.now()
    active_moments = Moment.objects.filter(
        user_id__in=visible_user_ids,
        expires_at__gt=now
    ).order_by('user_id', 'timestamp')

    # Group by user
    grouped = {}
    for m in active_moments:
        uid = m.user_id
        if uid not in grouped:
            grouped[uid] = {
                'user_id': uid,
                'username': m.user.username,
                'moments': []
            }
        
        moment_data = {
            'id': m.id,
            'media_url': m.media.url if m.media else None,
            'text_content': m.text_content,
            'caption': m.caption,
            'moment_type': m.moment_type,
            'song_url': m.song_file.url if m.song_file else None,
            'spotify_track_id': m.spotify_track_id,
            'spotify_track_info': m.spotify_track_info,
            'timestamp': m.timestamp.isoformat(),
            'expires_at': m.expires_at.isoformat(),
        }

        # Only include viewers and reactions for the creator's own moments
        if uid == request.user.id:
            moment_data['viewers'] = [
                {
                    'id': v.id,
                    'username': v.username,
                    # Fallback to random avatar if no profile media, but ideally we'd fetch profile image
                    'avatar': v.profile.avatar.url if hasattr(v, 'profile') and v.profile.avatar else f"https://ui-avatars.com/api/?name={v.username}&background=random"
                }
                for v in m.viewers.all()
            ]
            moment_data['reactions'] = m.reactions or []

        grouped[uid]['moments'].append(moment_data)

    return JsonResponse({'status': 'ok', 'data': list(grouped.values())})


@login_required
@csrf_protect
@require_POST
def upload_moment(request):
    """
    Upload a new moment.
    """
    from .models import Moment
    
    moment_type = request.POST.get('moment_type', Moment.MOMENT_TYPE_IMAGE)
    caption = request.POST.get('caption', '').strip()
    text_content = request.POST.get('text_content', '').strip()
    spotify_track_id = request.POST.get('spotify_track_id', '').strip()
    spotify_track_info = request.POST.get('spotify_track_info', '')
    if spotify_track_info:
        try:
            spotify_track_info = json.loads(spotify_track_info)
        except Exception:
            spotify_track_info = None
    else:
        spotify_track_info = None

    uploaded_file = request.FILES.get('media')
    song_file = request.FILES.get('song_file')

    if moment_type in (Moment.MOMENT_TYPE_IMAGE, Moment.MOMENT_TYPE_VIDEO) and not uploaded_file:
        return JsonResponse({'error': 'Media file is required for image/video moments.'}, status=400)
    
    if moment_type == Moment.MOMENT_TYPE_TEXT and not text_content:
        return JsonResponse({'error': 'Text content is required for text moments.'}, status=400)

    # Create the moment
    moment = Moment.objects.create(
        user=request.user,
        moment_type=moment_type,
        caption=caption,
        text_content=text_content,
        media=uploaded_file,
        song_file=song_file,
        spotify_track_id=spotify_track_id,
        spotify_track_info=spotify_track_info
    )

    moment_data = {
        'id': moment.id,
        'user_id': request.user.id,
        'username': request.user.username,
        'media_url': moment.media.url if moment.media else None,
        'text_content': moment.text_content,
        'caption': moment.caption,
        'moment_type': moment.moment_type,
        'song_url': moment.song_file.url if moment.song_file else None,
        'spotify_track_id': moment.spotify_track_id,
        'spotify_track_info': moment.spotify_track_info,
        'timestamp': moment.timestamp.isoformat(),
        'expires_at': moment.expires_at.isoformat(),
    }

    # Broadcast to all friends via WebSocket
    try:
        my_profile = request.user.profile
        friend_profile_ids = Friendship.get_friend_profile_ids(my_profile)
        friend_users = User.objects.filter(profile__id__in=friend_profile_ids)
        channel_layer = get_channel_layer()
        for friend in friend_users:
            async_to_sync(channel_layer.group_send)(
                f"user_chat_{friend.id}",
                {
                    'type': 'new_moment',
                    'moment': moment_data
                }
            )
        # also broadcast to self
        async_to_sync(channel_layer.group_send)(
            f"user_chat_{request.user.id}",
            {
                'type': 'new_moment',
                'moment': moment_data
            }
        )
    except Exception:
        pass # log error in production

    return JsonResponse({'status': 'ok', 'moment': moment_data}, status=201)


@login_required
@require_POST
def delete_moment(request, moment_id):
    """
    Deletes a specific moment owned by the user.
    """
    from .models import Moment
    moment = get_object_or_404(Moment, id=moment_id, user=request.user)
    moment.delete() # Triggers pre/post delete signals

    # Broadcast delete event to friends
    try:
        my_profile = request.user.profile
        friend_profile_ids = Friendship.get_friend_profile_ids(my_profile)
        friend_users = User.objects.filter(profile__id__in=friend_profile_ids)
        channel_layer = get_channel_layer()
        for friend in friend_users:
            async_to_sync(channel_layer.group_send)(
                f"user_chat_{friend.id}",
                {
                    'type': 'delete_moment',
                    'moment_id': moment_id,
                    'user_id': request.user.id
                }
            )
        async_to_sync(channel_layer.group_send)(
            f"user_chat_{request.user.id}",
            {
                'type': 'delete_moment',
                'moment_id': moment_id,
                'user_id': request.user.id
            }
        )
    except Exception:
        pass

    return JsonResponse({'status': 'ok'})


@login_required
@require_POST
@csrf_protect
def view_moment(request, moment_id):
    """
    Mark a moment as viewed by the current user.
    """
    from .models import Moment
    moment = get_object_or_404(Moment, id=moment_id)
    
    # Don't add if it's their own moment
    if moment.user != request.user:
        already_viewed = moment.viewers.filter(id=request.user.id).exists()
        if not already_viewed:
            moment.viewers.add(request.user)
            
            # Broadcast to the owner in real-time
            try:
                from channels.layers import get_channel_layer
                from asgiref.sync import async_to_sync
                channel_layer = get_channel_layer()
                async_to_sync(channel_layer.group_send)(
                    f"user_chat_{moment.user.id}",
                    {
                        'type': 'moment_viewed',
                        'moment_id': moment.id,
                        'viewer': {
                            'id': request.user.id,
                            'username': request.user.username,
                            'avatar': request.user.profile.avatar.url if hasattr(request.user, 'profile') and request.user.profile.avatar else f"https://ui-avatars.com/api/?name={request.user.username}&background=random"
                        }
                    }
                )
            except Exception:
                pass
        
    return JsonResponse({'status': 'ok'})


@login_required
@require_POST
@csrf_protect
def react_moment(request, moment_id):
    """
    Save a user reaction to a moment and broadcast it.
    """
    from .models import Moment
    from django.utils import timezone
    moment = get_object_or_404(Moment, id=moment_id)
    
    emoji = request.POST.get('emoji', '').strip()
    if not emoji:
        return JsonResponse({'error': 'Emoji is required.'}, status=400)
        
    # Get current reactions (ensure it's a list)
    reactions = moment.reactions or []
    
    # Update or add reaction for this user
    user_id = request.user.id
    username = request.user.username
    avatar = request.user.profile.avatar.url if hasattr(request.user, 'profile') and request.user.profile.avatar else f"https://ui-avatars.com/api/?name={username}&background=random"
    
    # Remove existing reaction by this user if any (user can only have one active reaction per moment)
    reactions = [r for r in reactions if r.get('user_id') != user_id]
    
    reaction_data = {
        'user_id': user_id,
        'username': username,
        'avatar': avatar,
        'emoji': emoji,
        'timestamp': timezone.now().isoformat()
    }
    reactions.append(reaction_data)
    moment.reactions = reactions
    moment.save(update_fields=['reactions'])
    
    # Broadcast to the owner in real-time
    try:
        from channels.layers import get_channel_layer
        from asgiref.sync import async_to_sync
        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)(
            f"user_chat_{moment.user.id}",
            {
                'type': 'moment_reacted',
                'moment_id': moment.id,
                'reaction': reaction_data
            }
        )
    except Exception:
        pass
        
    return JsonResponse({'status': 'ok', 'reaction': reaction_data})

# ---------------------------------------------------------------------------
# Chat Settings API
# ---------------------------------------------------------------------------
@login_required
def chat_setting_api(request, username):
    other_user = get_object_or_404(User, username=username)
    lo_user, hi_user = sorted([request.user, other_user], key=lambda u: u.id)
    
    from .models import ChatSetting
    setting, _ = ChatSetting.objects.get_or_create(user1=lo_user, user2=hi_user)

    if request.method == 'GET':
        return JsonResponse({
            'status': 'ok',
            'retention_days': setting.retention_days
        })
    elif request.method == 'POST':
        import json
        try:
            data = json.loads(request.body)
            new_days = int(data.get('retention_days', 7))
            if new_days in [1, 7, 30, 180]:
                setting.retention_days = new_days
                setting.save()
                return JsonResponse({'status': 'ok', 'retention_days': new_days})
            else:
                return JsonResponse({'error': 'Invalid retention days'}, status=400)
        except Exception as e:
            return JsonResponse({'error': str(e)}, status=400)
    
    return JsonResponse({'error': 'Method not allowed'}, status=405)


# ---------------------------------------------------------------------------
# Group Chat API
# ---------------------------------------------------------------------------

@login_required
@require_POST
def group_create(request):
    """Create a new group. Creator becomes owner."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    name = (data.get('name') or '').strip()
    if not name or len(name) > 100:
        return JsonResponse({'error': 'Group name is required (max 100 chars).'}, status=400)

    description = (data.get('description') or '').strip()[:500]
    member_ids = data.get('member_ids', [])

    group = Group.objects.create(
        name=name,
        description=description,
        created_by=request.user,
    )

    # Creator is always the owner
    GroupMembership.objects.create(
        group=group, user=request.user, role=GroupMembership.ROLE_OWNER
    )

    # Add initial members
    added = []
    for uid in member_ids:
        try:
            user = User.objects.get(id=int(uid))
            if user.id != request.user.id:
                GroupMembership.objects.get_or_create(
                    group=group, user=user,
                    defaults={'role': GroupMembership.ROLE_MEMBER}
                )
                added.append(user.username)
        except (User.DoesNotExist, ValueError):
            continue

    # System message
    GroupMessage.objects.create(
        group=group, sender=request.user,
        message=f'{request.user.username} established this group.',
        message_type=GroupMessage.MESSAGE_TYPE_SYSTEM,
        is_system_message=True,
    )
    for username in added:
        GroupMessage.objects.create(
            group=group, sender=request.user,
            message=f'{username} was welcomed to the group.',
            message_type=GroupMessage.MESSAGE_TYPE_SYSTEM,
            is_system_message=True,
        )

    return JsonResponse({
        'status': 'ok',
        'group': _serialize_group(group, request.user),
    })


@login_required
@require_GET
def group_list(request):
    """List all groups the current user is a member of."""
    memberships = GroupMembership.objects.filter(
        user=request.user
    ).select_related('group', 'group__created_by')

    groups = []
    for m in memberships:
        g = m.group
        # Get last message preview
        last_msg = g.messages.order_by('-timestamp').first()
        groups.append({
            'id': g.id,
            'name': g.name,
            'description': g.description,
            'avatar_url': g.avatar.url if g.avatar else '',
            'member_count': g.member_count,
            'role': m.role,
            'muted': m.muted,
            'last_message': {
                'text': last_msg.message[:80] if last_msg else '',
                'sender': last_msg.sender.username if last_msg and last_msg.sender else 'System',
                'timestamp': last_msg.timestamp.isoformat() if last_msg else '',
                'is_system': last_msg.is_system_message if last_msg else False,
            } if last_msg else None,
            'updated_at': g.updated_at.isoformat(),
        })

    return JsonResponse({'groups': groups})


@login_required
@require_http_methods(['GET', 'DELETE'])
def group_info(request, group_id):
    """Get detailed group info including member list, or delete the group."""
    group = get_object_or_404(Group, id=group_id)
    membership = GroupMembership.objects.filter(group=group, user=request.user).first()
    
    if request.method == 'DELETE':
        if not membership or membership.role != GroupMembership.ROLE_OWNER:
            return JsonResponse({'error': 'Only the group owner can disband the group.'}, status=403)
        group.delete()
        return JsonResponse({'status': 'ok', 'group_deleted': True})

    # GET method
    if not membership:
        return JsonResponse({'error': 'Not a member of this group.'}, status=403)

    return JsonResponse(_serialize_group(group, request.user))


@login_required
@require_GET
def group_message_reads(request, message_id):
    """Get list of users who have read a specific group message."""
    msg = get_object_or_404(GroupMessage, id=message_id)
    # Check if current user is in the group
    if not GroupMembership.objects.filter(group=msg.group, user=request.user).exists():
        return JsonResponse({'error': 'Not a member of this group.'}, status=403)
        
    reads = GroupMessageRead.objects.filter(message=msg).select_related('user', 'user__profile')
    readers = []
    for r in reads:
        readers.append({
            'username': r.user.username,
            'read_at': r.read_at.isoformat(),
            'avatar_url': r.user.profile.avatar.url if hasattr(r.user, 'profile') and r.user.profile.avatar else '',
        })
        
    return JsonResponse({'readers': readers})


@login_required
@require_POST
def group_update(request, group_id):
    """Update group name/description. Admin or owner only."""
    group = get_object_or_404(Group, id=group_id)
    membership = GroupMembership.objects.filter(group=group, user=request.user).first()
    if not membership or not membership.is_admin_or_owner:
        return JsonResponse({'error': 'Only admins can update group info.'}, status=403)

    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    changed = []
    name = (data.get('name') or '').strip()
    if name and name != group.name:
        group.name = name[:100]
        changed.append('name')
    desc = data.get('description')
    if desc is not None and desc != group.description:
        group.description = desc[:500]
        changed.append('description')

    if changed:
        group.save()
        GroupMessage.objects.create(
            group=group, sender=request.user,
            message=f'{request.user.username} updated the {" and ".join(changed)} of this group.',
            message_type=GroupMessage.MESSAGE_TYPE_SYSTEM,
            is_system_message=True,
        )

    return JsonResponse({'status': 'ok', 'group': _serialize_group(group, request.user)})


@login_required
@require_POST
def group_add_members(request, group_id):
    """Add members to a group. Admin or owner only."""
    group = get_object_or_404(Group, id=group_id)
    membership = GroupMembership.objects.filter(group=group, user=request.user).first()
    if not membership or not membership.is_admin_or_owner:
        return JsonResponse({'error': 'Only admins can add members.'}, status=403)

    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    member_ids = data.get('member_ids', [])
    added = []
    for uid in member_ids:
        try:
            user = User.objects.get(id=int(uid))
            _, created = GroupMembership.objects.get_or_create(
                group=group, user=user,
                defaults={'role': GroupMembership.ROLE_MEMBER}
            )
            if created:
                added.append(user.username)
                GroupMessage.objects.create(
                    group=group, sender=request.user,
                    message=f'{user.username} was invited to the group by {request.user.username}.',
                    message_type=GroupMessage.MESSAGE_TYPE_SYSTEM,
                    is_system_message=True,
                )
        except (User.DoesNotExist, ValueError):
            continue

    # Touch group to update sidebar ordering
    group.save()

    return JsonResponse({'status': 'ok', 'added': added})


@login_required
@require_POST
def group_remove_member(request, group_id):
    """Remove a member from a group. Admin or owner only."""
    group = get_object_or_404(Group, id=group_id)
    my_membership = GroupMembership.objects.filter(group=group, user=request.user).first()
    if not my_membership or not my_membership.is_admin_or_owner:
        return JsonResponse({'error': 'Only admins can remove members.'}, status=403)

    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    target_id = data.get('user_id')
    target_membership = GroupMembership.objects.filter(group=group, user_id=target_id).first()
    if not target_membership:
        return JsonResponse({'error': 'User is not a member.'}, status=404)

    # Can't remove the owner
    if target_membership.role == GroupMembership.ROLE_OWNER:
        return JsonResponse({'error': 'Cannot remove the group owner.'}, status=403)

    # Admin can't remove another admin (only owner can)
    if target_membership.role == GroupMembership.ROLE_ADMIN and my_membership.role != GroupMembership.ROLE_OWNER:
        return JsonResponse({'error': 'Only the owner can remove admins.'}, status=403)

    username = target_membership.user.username
    target_membership.delete()

    GroupMessage.objects.create(
        group=group, sender=request.user,
        message=f'{username} was removed by {request.user.username}.',
        message_type=GroupMessage.MESSAGE_TYPE_SYSTEM,
        is_system_message=True,
    )
    group.save()

    return JsonResponse({'status': 'ok', 'removed': username})


@login_required
@require_POST
def group_leave(request, group_id):
    """Leave a group."""
    group = get_object_or_404(Group, id=group_id)
    membership = GroupMembership.objects.filter(group=group, user=request.user).first()
    if not membership:
        return JsonResponse({'error': 'Not a member.'}, status=404)

    if membership.role == GroupMembership.ROLE_OWNER:
        # Owner must transfer ownership before leaving
        other_admins = group.memberships.filter(role=GroupMembership.ROLE_ADMIN).exclude(user=request.user)
        other_members = group.memberships.exclude(user=request.user)
        if other_members.exists():
            # Auto-transfer to first admin, or first member
            new_owner = other_admins.first() or other_members.first()
            new_owner.role = GroupMembership.ROLE_OWNER
            new_owner.save()
            GroupMessage.objects.create(
                group=group, sender=request.user,
                message=f'{new_owner.user.username} is the new group owner.',
                message_type=GroupMessage.MESSAGE_TYPE_SYSTEM,
                is_system_message=True,
            )
        else:
            # Last member — delete the group
            group.delete()
            return JsonResponse({'status': 'ok', 'group_deleted': True})

    GroupMessage.objects.create(
        group=group, sender=request.user,
        message=f'{request.user.username} departed from the group.',
        message_type=GroupMessage.MESSAGE_TYPE_SYSTEM,
        is_system_message=True,
    )
    membership.delete()
    group.save()

    return JsonResponse({'status': 'ok'})


@login_required
@require_POST
def group_change_role(request, group_id):
    """Change a member's role (promote/demote). Owner only for admin changes."""
    group = get_object_or_404(Group, id=group_id)
    my_membership = GroupMembership.objects.filter(group=group, user=request.user).first()
    if not my_membership or not my_membership.is_admin_or_owner:
        return JsonResponse({'error': 'Only admins can change roles.'}, status=403)

    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    target_id = data.get('user_id')
    new_role = data.get('role')

    if new_role not in (GroupMembership.ROLE_ADMIN, GroupMembership.ROLE_MEMBER):
        return JsonResponse({'error': 'Invalid role.'}, status=400)

    target_membership = GroupMembership.objects.filter(group=group, user_id=target_id).first()
    if not target_membership:
        return JsonResponse({'error': 'User is not a member.'}, status=404)

    if target_membership.role == GroupMembership.ROLE_OWNER:
        return JsonResponse({'error': 'Cannot change the owner\'s role.'}, status=403)

    # Only owner can promote to admin or demote an admin
    if new_role == GroupMembership.ROLE_ADMIN or target_membership.role == GroupMembership.ROLE_ADMIN:
        if my_membership.role != GroupMembership.ROLE_OWNER:
            return JsonResponse({'error': 'Only the owner can manage admin roles.'}, status=403)

    old_role = target_membership.role
    target_membership.role = new_role
    target_membership.save()

    action = 'promoted to Admin' if new_role == GroupMembership.ROLE_ADMIN else 'changed to Member'
    GroupMessage.objects.create(
        group=group, sender=request.user,
        message=f'{target_membership.user.username} was {action} by {request.user.username}.',
        message_type=GroupMessage.MESSAGE_TYPE_SYSTEM,
        is_system_message=True,
    )

    return JsonResponse({'status': 'ok', 'user_id': target_id, 'new_role': new_role})


@login_required
@require_GET
def group_message_history(request, group_id):
    """Paginated message history for a group."""
    group = get_object_or_404(Group, id=group_id)
    if not GroupMembership.objects.filter(group=group, user=request.user).exists():
        return JsonResponse({'error': 'Not a member.'}, status=403)

    page = _positive_int(request.GET.get('page'), 1)
    per_page = _positive_int(request.GET.get('per_page'), 50, max_value=100)

    messages_qs = GroupMessage.objects.filter(group=group).order_by('-timestamp')
    total = messages_qs.count()
    start = (page - 1) * per_page
    end = start + per_page
    messages_page = list(reversed(messages_qs[start:end]))

    result = []
    for msg in messages_page:
        entry = {
            'id': msg.id,
            'sender': msg.sender.username if msg.sender else None,
            'sender_id': msg.sender.id if msg.sender else None,
            'message': msg.message,
            'message_type': msg.message_type,
            'is_system_message': msg.is_system_message,
            'timestamp': msg.timestamp.isoformat(),
        }
        if msg.file:
            entry['has_file'] = True
            entry['file_id'] = msg.id
            entry['original_filename'] = msg.original_filename or msg.file_name or ''
            entry['mime_type'] = msg.mime_type
        result.append(entry)

    return JsonResponse({
        'messages': result,
        'total': total,
        'page': page,
        'per_page': per_page,
        'has_more': end < total,
    })


def _serialize_group(group, user):
    """Serialize a group object for API responses."""
    memberships = group.memberships.select_related('user', 'user__profile').all()
    my_membership = None
    members = []
    for m in memberships:
        member_data = {
            'user_id': m.user.id,
            'username': m.user.username,
            'role': m.role,
            'joined_at': m.joined_at.isoformat(),
            'avatar_url': m.user.profile.avatar.url if hasattr(m.user, 'profile') and m.user.profile.avatar else '',
            'is_online': m.user.profile.is_online if hasattr(m.user, 'profile') else False,
        }
        members.append(member_data)
        if m.user.id == user.id:
            my_membership = m

    return {
        'id': group.id,
        'name': group.name,
        'description': group.description,
        'avatar_url': group.avatar.url if group.avatar else '',
        'created_by': group.created_by.username if group.created_by else None,
        'created_at': group.created_at.isoformat(),
        'member_count': len(members),
        'my_role': my_membership.role if my_membership else None,
        'members': members,
    }
