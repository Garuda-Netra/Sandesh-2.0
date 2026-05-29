"""
Users App Configuration
"""

from django.apps import AppConfig


class UsersConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'users'
    verbose_name = 'Users'

    def ready(self):
        """
        Schedule stale is_online flag reset for after migrations are complete.
        This prevents ghost-active users that remain marked online after
        an unclean shutdown or server restart, without triggering the
        'Accessing the database during app initialization' warning.
        """
        from django.db.models.signals import post_migrate
        post_migrate.connect(self._reset_online_flags, sender=self)

    @staticmethod
    def _reset_online_flags(sender, **kwargs):
        """Reset all stale is_online flags to False when the server starts."""
        try:
            from .models import UserProfile
            UserProfile.objects.filter(is_online=True).update(is_online=False)
        except Exception:
            # Database may not be ready on the very first migrate run.
            pass
