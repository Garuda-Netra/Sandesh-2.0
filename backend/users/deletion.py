"""
Account Deletion and Purge Services for Sandesh 2.0.

Provides safe temporary deactivation with 30-day grace period,
session revocation, cancellation, and atomic permanent purge.
"""

import logging
from datetime import timedelta
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from django.contrib.auth.models import User
from django.contrib.sessions.models import Session

logger = logging.getLogger(__name__)

# Default grace period for temporary account deletion
GRACE_PERIOD_DAYS = 30


def schedule_account_deletion(user):
    """
    Deactivates the user account immediately, records deletion timestamp,
    and revokes all active sessions.

    Does NOT destroy data immediately; user enters a 30-day grace period.
    Returns: (profile, session_keys_revoked)
    """
    from users.models import UserProfile, UserSession

    with transaction.atomic():
        profile, _ = UserProfile.objects.select_for_update().get_or_create(user=user)
        profile.is_active_account = False
        profile.deleted_at = timezone.now()
        profile.is_online = False
        profile.save(update_fields=['is_active_account', 'deleted_at', 'is_online'])

        # Collect session keys to terminate
        session_keys = list(
            UserSession.objects.filter(user=user).values_list('session_key', flat=True)
        )

        # Clear global Django sessions and user tracking
        if session_keys:
            Session.objects.filter(session_key__in=session_keys).delete()
        UserSession.objects.filter(user=user).delete()

    return profile, session_keys


def cancel_account_deletion(user):
    """
    Cancels account deletion for verified owner if within 30-day grace period.
    Restores account to active status and clears deletion timestamp.

    Returns: (success: bool, message: str)
    """
    from users.models import UserProfile

    with transaction.atomic():
        profile = UserProfile.objects.select_for_update().filter(user=user).first()
        if not profile:
            return False, "User profile not found."

        if profile.is_active_account:
            return True, "Account is already active."

        if profile.is_deletion_expired:
            return False, "Account grace period has expired. Account cannot be restored."

        # Restore account
        profile.is_active_account = True
        profile.deleted_at = None
        profile.save(update_fields=['is_active_account', 'deleted_at'])

    return True, "Account deletion cancelled. Your account has been restored."


def purge_user_account(user_id, dry_run=False):
    """
    Permanently purges a user account and associated personal data after grace period:
    - User avatar, moments, messages, saved messages, credentials, sessions.
    - Preserves other users' data and shared group conversations (GroupMessage.sender becomes NULL).
    - Safely removes media from external storage (Cloudinary / FileSystemStorage).
    - Protects against storage outages so DB cleanup completes cleanly.

    Returns: dict with summary of purged items.
    """
    from users.models import UserProfile, UserSession
    from messaging.models import Message, Moment

    with transaction.atomic():
        try:
            user = User.objects.select_for_update().get(id=user_id)
        except User.DoesNotExist:
            return {'status': 'not_found', 'user_id': user_id}

        profile = getattr(user, 'profile', None)

        # 1. Collect media files before database records are deleted
        files_to_delete = []

        if profile and profile.avatar and profile.avatar.name:
            files_to_delete.append((profile.avatar.storage, profile.avatar.name))

        for moment in Moment.objects.filter(user=user):
            if moment.media and moment.media.name:
                files_to_delete.append((moment.media.storage, moment.media.name))
            if moment.song_file and moment.song_file.name:
                files_to_delete.append((moment.song_file.storage, moment.song_file.name))

        # Attachments on messages involving user (Saved Messages and 1-on-1 messages)
        user_msgs = Message.objects.filter(Q(sender=user) | Q(receiver=user)).exclude(file='')
        for msg in user_msgs:
            if msg.file and msg.file.name:
                files_to_delete.append((msg.file.storage, msg.file.name))

        # Note: GroupMessage files in shared groups are preserved for other members.

        if dry_run:
            return {
                'status': 'dry_run',
                'username': user.username,
                'user_id': user.id,
                'files_count': len(files_to_delete),
            }

        # 2. Revoke any remaining session records
        session_keys = list(
            UserSession.objects.filter(user=user).values_list('session_key', flat=True)
        )
        if session_keys:
            Session.objects.filter(session_key__in=session_keys).delete()

        # 3. Permanently delete user from database
        # Django CASCADE handles UserProfile, Friendship, FriendRequest, Message,
        # Moment, UserSecurityCredential, ChatLock, CallLog, UserSession, UserSettings,
        # and GroupMembership.
        # GroupMessage.sender and Group.created_by default to SET_NULL (preserving group chat).
        username = user.username
        user.delete()

    # 4. Safely delete files from storage outside DB transaction to avoid blocking rollback
    storage_errors = 0
    deleted_files_count = 0
    for storage, file_name in files_to_delete:
        try:
            if storage.exists(file_name):
                storage.delete(file_name)
                deleted_files_count += 1
        except Exception as e:
            # External storage failure (network, Cloudinary outage, etc.) is logged, not fatal
            logger.warning("Failed to delete file '%s' from storage: %s", file_name, e)
            storage_errors += 1

    return {
        'status': 'purged',
        'username': username,
        'user_id': user_id,
        'files_deleted': deleted_files_count,
        'storage_errors': storage_errors,
    }
