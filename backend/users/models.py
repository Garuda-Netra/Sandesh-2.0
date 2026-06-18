"""
Users Models

UserProfile extends Django's built-in User with:
  - Avatar support
  - Online status tracking
"""

from django.db import models
from django.contrib.auth.models import User
from django.db.models.signals import post_save, post_delete
from django.dispatch import receiver
from django.utils import timezone


class UserProfile(models.Model):
    """
    Extended profile for each registered user.
    """
    user = models.OneToOneField(
        User,
        on_delete=models.CASCADE,
        related_name='profile'
    )

    created_at = models.DateTimeField(default=timezone.now, editable=False)

    avatar = models.ImageField(
        upload_to='avatars/',
        null=True,
        blank=True
    )

    # Simple online indicator — updated via WebSocket connect/disconnect
    is_online = models.BooleanField(default=False)

    last_seen = models.DateTimeField(auto_now=True)

    bio = models.CharField(max_length=200, blank=True, default='')

    phone_number = models.CharField(
        max_length=20,
        blank=True,
        null=True,
        unique=True,
        help_text="User's verified phone number with country code"
    )

    # ── Hidden / removed contacts (one-way) ────────────────────────────────
    hidden_users = models.ManyToManyField(
        'self',
        symmetrical=False,
        blank=True,
        related_name='hidden_by',
        help_text="Profiles hidden from this user's contact list."
    )

    # ── Blocked contacts (one-way) ─────────────────────────────────────────
    # Blocked users are hidden from contact lists and chat delivery is disabled.
    blocked_users = models.ManyToManyField(
        'self',
        symmetrical=False,
        blank=True,
        related_name='blocked_by',
        help_text="Profiles blocked by this user."
    )

    # ── Soft-delete fields ──────────────────────────────────────────────────
    is_active_account = models.BooleanField(
        default=True,
        help_text='False = account soft-deleted by owner.'
    )
    deleted_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text='Timestamp when the account was soft-deleted.'
    )

    class Meta:
        verbose_name = 'User Profile'
        verbose_name_plural = 'User Profiles'

    def __str__(self):
        return f'Profile of {self.user.username}'

    @property
    def display_name(self):
        return self.user.get_full_name() or self.user.username




# ---------------------------------------------------------------------------
# Signal: Auto-create UserProfile when a new User is created
# ---------------------------------------------------------------------------
@receiver(post_save, sender=User)
def create_user_profile(sender, instance, created, **kwargs):
    if created:
        UserProfile.objects.get_or_create(user=instance)


# ---------------------------------------------------------------------------
# Friend Request (matches migration 0007)
# ---------------------------------------------------------------------------
class FriendRequest(models.Model):
    """
    Tracks friend requests between users.
    New users are hidden from everyone until discovered via search
    and a friend request is sent and accepted.
    """
    STATUS_PENDING = 'pending'
    STATUS_ACCEPTED = 'accepted'
    STATUS_REJECTED = 'rejected'
    STATUS_CHOICES = [
        (STATUS_PENDING, 'Pending'),
        (STATUS_ACCEPTED, 'Accepted'),
        (STATUS_REJECTED, 'Rejected'),
    ]

    from_user = models.ForeignKey(
        UserProfile,
        on_delete=models.CASCADE,
        related_name='sent_friend_requests',
    )
    to_user = models.ForeignKey(
        UserProfile,
        on_delete=models.CASCADE,
        related_name='received_friend_requests',
    )
    status = models.CharField(
        max_length=10,
        choices=STATUS_CHOICES,
        default=STATUS_PENDING,
    )
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = 'Friend Request'
        verbose_name_plural = 'Friend Requests'
        unique_together = ('from_user', 'to_user')

    def __str__(self):
        return (
            f'{self.from_user.user.username} → '
            f'{self.to_user.user.username} [{self.status}]'
        )


# ---------------------------------------------------------------------------
# Friendship (matches migration 0007)
# ---------------------------------------------------------------------------
class Friendship(models.Model):
    """
    Stores confirmed friend pairs.  user1.id is always < user2.id
    to avoid duplicate rows and simplify lookups.
    """
    user1 = models.ForeignKey(
        UserProfile,
        on_delete=models.CASCADE,
        related_name='friendships_as_user1',
    )
    user2 = models.ForeignKey(
        UserProfile,
        on_delete=models.CASCADE,
        related_name='friendships_as_user2',
    )
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        verbose_name = 'Friendship'
        verbose_name_plural = 'Friendships'
        unique_together = ('user1', 'user2')

    def __str__(self):
        return (
            f'{self.user1.user.username} ↔ {self.user2.user.username}'
        )

    @classmethod
    def are_friends(cls, profile_a, profile_b):
        """Return True if a confirmed friendship exists between two profiles."""
        lo, hi = sorted([profile_a.id, profile_b.id])
        return cls.objects.filter(user1_id=lo, user2_id=hi).exists()

    @classmethod
    def add_friendship(cls, profile_a, profile_b):
        """Create a friendship with consistently ordered IDs. Returns (obj, created)."""
        lo_id, hi_id = sorted([profile_a.id, profile_b.id])
        lo = UserProfile.objects.get(pk=lo_id)
        hi = UserProfile.objects.get(pk=hi_id)
        return cls.objects.get_or_create(user1=lo, user2=hi)

    @classmethod
    def get_friend_profile_ids(cls, profile):
        """Return a set of UserProfile IDs that are friends with the given profile."""
        ids = set()
        ids.update(
            cls.objects.filter(user1=profile).values_list('user2_id', flat=True)
        )
        ids.update(
            cls.objects.filter(user2=profile).values_list('user1_id', flat=True)
        )
        return ids

# ---------------------------------------------------------------------------
# User Session (for "Devices & Active Sessions")
# ---------------------------------------------------------------------------
class UserSession(models.Model):
    """
    Tracks active devices and sessions for a user.
    """
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='active_sessions')
    session_key = models.CharField(max_length=40, unique=True)
    device_name = models.CharField(max_length=255, blank=True, null=True)  # e.g., Windows, macOS, iPhone
    os = models.CharField(max_length=255, blank=True, null=True)  # e.g., Windows 10
    browser = models.CharField(max_length=255, blank=True, null=True)  # e.g., Chrome 114
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    location = models.CharField(max_length=255, blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    last_activity = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = 'User Session'
        verbose_name_plural = 'User Sessions'

    def __str__(self):
        return f'{self.user.username} - {self.device_name} ({self.ip_address})'

@receiver(post_delete, sender=UserProfile)
def auto_delete_userprofile_avatar_on_delete(sender, instance, **kwargs):
    """Deletes the avatar file from storage when the UserProfile is deleted."""
    if instance.avatar:
        instance.avatar.delete(save=False)
