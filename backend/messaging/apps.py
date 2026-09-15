"""
Messaging App Configuration
"""

from django.apps import AppConfig


class MessagingConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'messaging'
    verbose_name = 'Messaging'

    def ready(self):
        import os
        if os.environ.get('RUN_MAIN') == 'true':
            try:
                from django.core.management import call_command
                call_command('migrate', interactive=False)
            except Exception:
                pass
