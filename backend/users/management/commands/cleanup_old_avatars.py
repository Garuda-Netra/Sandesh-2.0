"""
Django Management Command: cleanup_old_avatars

Usage:
    python backend/manage.py cleanup_old_avatars
    python backend/manage.py cleanup_old_avatars --username balidan8340

Can be run on a recurring schedule (e.g., cron or background worker)
to sweep and delete historical/orphaned avatar images, ensuring only
the single current avatar remains per user.
"""

from django.core.management.base import BaseCommand
from django.contrib.auth.models import User
from users.avatar_service import cleanup_user_avatar_history, cleanup_all_orphaned_avatars


class Command(BaseCommand):
    help = "Cleans up previous / orphaned profile pictures from Cloudinary and disk so only the current image remains."

    def add_arguments(self, parser):
        parser.add_argument(
            '--username',
            type=str,
            default=None,
            help='Clean up historical avatars for a specific username only.',
        )

    def handle(self, *args, **options):
        target_username = options.get('username')

        if target_username:
            user = User.objects.filter(username=target_username).first()
            if not user:
                self.stderr.write(self.style.ERROR(f"User '{target_username}' not found."))
                return

            self.stdout.write(f"Cleaning up previous avatars for user: {user.username}...")
            purged = cleanup_user_avatar_history(user)
            self.stdout.write(self.style.SUCCESS(f"Done. Purged {purged} previous avatar(s) for {user.username}."))
        else:
            self.stdout.write("Sweeping all users for previous/orphaned avatars...")
            result = cleanup_all_orphaned_avatars()
            self.stdout.write(
                self.style.SUCCESS(
                    f"Cleanup complete! Processed {result['users_processed']} user(s), purged {result['assets_purged']} old asset(s)."
                )
            )
