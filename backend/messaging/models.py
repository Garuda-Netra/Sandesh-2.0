"""
Messaging Models

Message content is stored as plain text.
"""

from django.db import models
from django.contrib.auth.models import User
from django.utils import timezone
from django.db.models.signals import post_delete
from django.dispatch import receiver
from datetime import timedelta


class Message(models.Model):
    """
    Stores a single message between two users.
    """
    MESSAGE_TYPE_TEXT = 'text'
    MESSAGE_TYPE_FILE = 'file'
    MESSAGE_TYPE_IMAGE = 'image'
    MESSAGE_TYPE_VIDEO = 'video'
    MESSAGE_TYPE_CALL = 'call'

    MESSAGE_TYPES = [
        (MESSAGE_TYPE_TEXT, 'Text'),
        (MESSAGE_TYPE_FILE, 'File'),
        (MESSAGE_TYPE_IMAGE, 'Image'),
        (MESSAGE_TYPE_VIDEO, 'Video'),
        (MESSAGE_TYPE_CALL, 'Call Log'),
    ]

    sender = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='sent_messages'
    )
    receiver = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='received_messages'
    )

    # Plain text message content
    message = models.TextField(
        blank=True,
        default='',
        help_text='Plain text message content'
    )

    # For files: original filename and MIME type
    original_filename = models.CharField(max_length=255, blank=True, default='')
    mime_type = models.CharField(max_length=100, blank=True, default='')

    # Uploaded file storage
    file = models.FileField(
        upload_to='files/',
        null=True,
        blank=True,
    )
    file_name = models.CharField(
        max_length=255,
        null=True,
        blank=True,
        help_text='Display name shown to users (original filename)'
    )

    message_type = models.CharField(
        max_length=10,
        choices=MESSAGE_TYPES,
        default=MESSAGE_TYPE_TEXT
    )

    replied_moment = models.ForeignKey(
        'Moment',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='replies',
        help_text='If this message is a reply to a moment, stores a reference to it'
    )

    timestamp = models.DateTimeField(auto_now_add=True, db_index=True)
    expires_at = models.DateTimeField(null=True, blank=True, db_index=True)

    # Delivery / read tracking (updated via WebSocket signals)
    is_delivered = models.BooleanField(default=False)
    is_read = models.BooleanField(default=False)

    # Soft-delete: hide from both parties (legacy)
    deleted_by_sender = models.BooleanField(default=False)
    deleted_by_receiver = models.BooleanField(default=False)

    # Professional deletion: Remove from My View (per-user hidden list)
    hidden_for_users = models.ManyToManyField(
        User,
        blank=True,
        related_name='hidden_messages',
        help_text='Users for whom this message is hidden ("Remove from My View")',
    )

    # Professional deletion: Delete for All Participants
    is_deleted_for_all = models.BooleanField(
        default=False,
        help_text='True when sender deleted the message for all participants',
    )

    class Meta:
        ordering = ['timestamp']
        verbose_name = 'Message'
        verbose_name_plural = 'Messages'
        indexes = [
            models.Index(fields=['sender', 'receiver', 'timestamp']),
            models.Index(fields=['receiver', 'is_delivered']),
            models.Index(fields=['receiver', 'is_read']),
        ]

    def __str__(self):
        return (
            f'[{self.message_type}] {self.sender.username} → '
            f'{self.receiver.username} @ {self.timestamp:%Y-%m-%d %H:%M}'
        )


class CallLog(models.Model):
    """
    Records voice/video call events for display in the chat timeline.
    """
    CALL_VOICE = 'voice'
    CALL_VIDEO = 'video'
    CALL_TYPES = [
        (CALL_VOICE, 'Voice Call'),
        (CALL_VIDEO, 'Video Call'),
    ]

    STATUS_INITIATED = 'initiated'
    STATUS_ACCEPTED = 'accepted'
    STATUS_REJECTED = 'rejected'
    STATUS_MISSED = 'missed'
    STATUS_ENDED = 'ended'
    CALL_STATUSES = [
        (STATUS_INITIATED, 'Initiated'),
        (STATUS_ACCEPTED, 'Accepted'),
        (STATUS_REJECTED, 'Rejected'),
        (STATUS_MISSED, 'Missed'),
        (STATUS_ENDED, 'Ended'),
    ]

    caller = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name='initiated_calls'
    )
    callee = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name='received_calls'
    )
    call_type = models.CharField(max_length=10, choices=CALL_TYPES)
    status = models.CharField(
        max_length=15, choices=CALL_STATUSES, default=STATUS_INITIATED
    )
    started_at = models.DateTimeField(default=timezone.now)
    ended_at = models.DateTimeField(null=True, blank=True)

    @property
    def duration_seconds(self):
        if self.ended_at and self.started_at:
            return int((self.ended_at - self.started_at).total_seconds())
        return 0

    class Meta:
        ordering = ['-started_at']

    def __str__(self):
        return (
            f'{self.call_type.upper()} {self.caller.username} → '
            f'{self.callee.username} [{self.status}]'
        )


class Moment(models.Model):
    """
    Stores a 24-hour temporary update (story) for a user.
    """
    MOMENT_TYPE_IMAGE = 'image'
    MOMENT_TYPE_VIDEO = 'video'
    MOMENT_TYPE_TEXT = 'text'

    MOMENT_TYPES = [
        (MOMENT_TYPE_IMAGE, 'Image'),
        (MOMENT_TYPE_VIDEO, 'Video'),
        (MOMENT_TYPE_TEXT, 'Text'),
    ]

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='moments')
    media = models.FileField(upload_to='moments/', null=True, blank=True)
    text_content = models.TextField(blank=True, default='')
    caption = models.CharField(max_length=255, blank=True, default='')
    moment_type = models.CharField(max_length=10, choices=MOMENT_TYPES, default=MOMENT_TYPE_IMAGE)
    
    # Soundtrack fields
    song_file = models.FileField(upload_to='moments/songs/', null=True, blank=True)
    spotify_track_id = models.CharField(max_length=255, blank=True, default='')
    spotify_track_info = models.JSONField(null=True, blank=True, help_text="Caches title, artist, and album art for faster loading")
    reactions = models.JSONField(default=list, blank=True, null=True, help_text="List of user reactions: [{'user_id', 'username', 'avatar', 'emoji', 'timestamp'}]")

    viewers = models.ManyToManyField(User, related_name='viewed_moments', blank=True)

    timestamp = models.DateTimeField(auto_now_add=True, db_index=True)
    expires_at = models.DateTimeField(db_index=True)

    class Meta:
        ordering = ['-timestamp']

    def save(self, *args, **kwargs):
        if not self.expires_at:
            # Set expiration to 24 hours from now
            self.expires_at = timezone.now() + timedelta(hours=24)
        super().save(*args, **kwargs)

    def __str__(self):
        return f"Moment by {self.user.username} at {self.timestamp}"


@receiver(post_delete, sender=Moment)
def auto_delete_moment_media_on_delete(sender, instance, **kwargs):
    """
    Deletes the media and song files from storage when the Moment is deleted.
    """
    if instance.media:
        instance.media.delete(save=False)
    if instance.song_file:
        instance.song_file.delete(save=False)

@receiver(post_delete, sender=Message)
def auto_delete_message_media_on_delete(sender, instance, **kwargs):
    """
    Deletes the file attached to a Message when it is deleted.
    """
    if instance.file:
        instance.file.delete(save=False)


class ChatSetting(models.Model):
    """
    Stores per-chat configuration such as message retention periods.
    """
    RETENTION_CHOICES = [
        (2, '2 Days'),
        (7, '1 Week'),
        (30, '1 Month'),
        (180, '6 Months'),
    ]

    user1 = models.ForeignKey(User, on_delete=models.CASCADE, related_name='+')
    user2 = models.ForeignKey(User, on_delete=models.CASCADE, related_name='+')
    retention_days = models.IntegerField(default=2, choices=RETENTION_CHOICES)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = ('user1', 'user2')
        indexes = [
            models.Index(fields=['user1', 'user2']),
        ]

    def __str__(self):
        return f"Settings for {self.user1.username} & {self.user2.username}"


# ---------------------------------------------------------------------------
# Group Chat Models
# ---------------------------------------------------------------------------
class Group(models.Model):
    """
    Stores a group / community.
    The creator is automatically assigned as 'owner' via GroupMembership.
    """
    name = models.CharField(max_length=100)
    description = models.TextField(blank=True, default='')
    avatar = models.ImageField(upload_to='group_avatars/', null=True, blank=True)
    created_by = models.ForeignKey(
        User, on_delete=models.SET_NULL, null=True,
        related_name='created_groups',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-updated_at']
        verbose_name = 'Group'
        verbose_name_plural = 'Groups'

    def __str__(self):
        return self.name

    @property
    def member_count(self):
        return self.memberships.count()


class GroupMembership(models.Model):
    """
    Tracks membership and role within a group.
    Roles: owner (irrevocable creator), admin, member.
    """
    ROLE_OWNER = 'owner'
    ROLE_ADMIN = 'admin'
    ROLE_MEMBER = 'member'
    ROLE_CHOICES = [
        (ROLE_OWNER, 'Owner'),
        (ROLE_ADMIN, 'Admin'),
        (ROLE_MEMBER, 'Member'),
    ]

    group = models.ForeignKey(
        Group, on_delete=models.CASCADE, related_name='memberships'
    )
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name='group_memberships'
    )
    role = models.CharField(
        max_length=10, choices=ROLE_CHOICES, default=ROLE_MEMBER,
    )
    joined_at = models.DateTimeField(auto_now_add=True)
    cleared_at = models.DateTimeField(null=True, blank=True, help_text="Timestamp when the user last cleared the group chat.")
    muted = models.BooleanField(default=False)

    class Meta:
        unique_together = ('group', 'user')
        verbose_name = 'Group Membership'
        verbose_name_plural = 'Group Memberships'
        indexes = [
            models.Index(fields=['group', 'user']),
            models.Index(fields=['user']),
        ]

    def __str__(self):
        return f'{self.user.username} in {self.group.name} [{self.role}]'

    @property
    def is_admin_or_owner(self):
        return self.role in (self.ROLE_OWNER, self.ROLE_ADMIN)


class GroupInvite(models.Model):
    """
    Tracks group invitations sent to users.
    """
    STATUS_PENDING = 'pending'
    STATUS_ACCEPTED = 'accepted'
    STATUS_DECLINED = 'declined'
    STATUS_CHOICES = [
        (STATUS_PENDING, 'Pending'),
        (STATUS_ACCEPTED, 'Accepted'),
        (STATUS_DECLINED, 'Declined'),
    ]

    group = models.ForeignKey(
        Group, on_delete=models.CASCADE, related_name='invites'
    )
    inviter = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name='sent_group_invites'
    )
    invitee = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name='received_group_invites'
    )
    status = models.CharField(
        max_length=10, choices=STATUS_CHOICES, default=STATUS_PENDING
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('group', 'invitee')
        verbose_name = 'Group Invite'
        verbose_name_plural = 'Group Invites'
        ordering = ['-created_at']

    def __str__(self):
        return f'Invite to {self.invitee.username} for {self.group.name} by {self.inviter.username}'



class GroupMessage(models.Model):
    """
    Stores a single message within a group.
    System messages (join, leave, admin changes) use is_system_message=True.
    """
    MESSAGE_TYPE_TEXT = 'text'
    MESSAGE_TYPE_FILE = 'file'
    MESSAGE_TYPE_IMAGE = 'image'
    MESSAGE_TYPE_VIDEO = 'video'
    MESSAGE_TYPE_SYSTEM = 'system'

    MESSAGE_TYPES = [
        (MESSAGE_TYPE_TEXT, 'Text'),
        (MESSAGE_TYPE_FILE, 'File'),
        (MESSAGE_TYPE_IMAGE, 'Image'),
        (MESSAGE_TYPE_VIDEO, 'Video'),
        (MESSAGE_TYPE_SYSTEM, 'System'),
    ]

    group = models.ForeignKey(
        Group, on_delete=models.CASCADE, related_name='messages'
    )
    sender = models.ForeignKey(
        User, on_delete=models.SET_NULL, null=True,
        related_name='sent_group_messages',
    )
    message = models.TextField(blank=True, default='')
    message_type = models.CharField(
        max_length=10, choices=MESSAGE_TYPES, default=MESSAGE_TYPE_TEXT,
    )

    # File support
    file = models.FileField(upload_to='group_files/', null=True, blank=True)
    file_name = models.CharField(max_length=255, null=True, blank=True)
    original_filename = models.CharField(max_length=255, blank=True, default='')
    mime_type = models.CharField(max_length=100, blank=True, default='')

    # System messages (e.g. "User joined the group")
    is_system_message = models.BooleanField(default=False)

    timestamp = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ['timestamp']
        verbose_name = 'Group Message'
        verbose_name_plural = 'Group Messages'
        indexes = [
            models.Index(fields=['group', 'timestamp']),
        ]

    def __str__(self):
        sender_name = self.sender.username if self.sender else 'System'
        return f'[{self.group.name}] {sender_name} @ {self.timestamp:%Y-%m-%d %H:%M}'


class GroupMessageRead(models.Model):
    """
    Tracks which users have read a specific group message.
    """
    message = models.ForeignKey(GroupMessage, on_delete=models.CASCADE, related_name='read_receipts')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='read_group_messages')
    read_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        unique_together = ('message', 'user')
        verbose_name = 'Group Message Read Receipt'
        verbose_name_plural = 'Group Message Read Receipts'
        indexes = [
            models.Index(fields=['message', 'user']),
        ]

    def __str__(self):
        return f'{self.user.username} read {self.message.id} at {self.read_at:%Y-%m-%d %H:%M}'


@receiver(post_delete, sender=GroupMessage)
def auto_delete_group_message_file_on_delete(sender, instance, **kwargs):
    """Deletes the file attached to a GroupMessage when it is deleted."""
    if instance.file:
        instance.file.delete(save=False)


@receiver(post_delete, sender=Group)
def auto_delete_group_avatar_on_delete(sender, instance, **kwargs):
    """Deletes the avatar file when a Group is deleted."""
    if instance.avatar:
        instance.avatar.delete(save=False)
