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
        Schedule stale is_online flag reset for after migrations are complete,
        clear the cache registry on startup, and establish a first-request listener
        to safely wipe any stale online states.
        """
        # Clear cache completely on startup to wipe stale connection counts
        from django.core.cache import cache
        try:
            cache.clear()
        except Exception:
            pass

        from django.core.signals import request_started

        def reset_stale_flags_on_first_request(sender, **kwargs):
            if not getattr(self, '_stale_flags_reset', False):
                self._stale_flags_reset = True
                try:
                    from .models import UserProfile
                    UserProfile.objects.filter(is_online=True).update(is_online=False)
                except Exception:
                    pass

        request_started.connect(reset_stale_flags_on_first_request)

        from django.db.models.signals import post_migrate
        post_migrate.connect(self._reset_online_flags, sender=self)

        import users.signals  # Import signals for UserSession Tracking

    @staticmethod
    def _reset_online_flags(sender, **kwargs):
        """Reset all stale is_online flags to False when migrations are run."""
        try:
            from .models import UserProfile
            UserProfile.objects.filter(is_online=True).update(is_online=False)
        except Exception:
            pass
