import logging
from datetime import timedelta
from django.core.management.base import BaseCommand
from django.utils import timezone
from users.models import UserProfile
from users.deletion import purge_user_account, GRACE_PERIOD_DAYS

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = 'Permanently purges accounts whose 30-day deletion grace period has expired.'

    def add_arguments(self, parser):
        parser.add_argument(
            '--days',
            type=int,
            default=GRACE_PERIOD_DAYS,
            help=f'Grace period in days (default: {GRACE_PERIOD_DAYS}). Accounts deactivated longer than this will be purged.'
        )
        parser.add_argument(
            '--dry-run',
            action='store_true',
            help='Simulate deletion without destroying data or media.'
        )
        parser.add_argument(
            '--username',
            type=str,
            default=None,
            help='Target a specific deactivated username for purge.'
        )
        parser.add_argument(
            '--batch-size',
            type=int,
            default=100,
            help='Maximum number of accounts to process in this run (default: 100).'
        )

    def handle(self, *args, **options):
        days = options['days']
        dry_run = options['dry_run']
        target_username = options['username']
        batch_size = options['batch_size']

        cutoff = timezone.now() - timedelta(days=days)

        qs = UserProfile.objects.filter(
            is_active_account=False,
            deleted_at__lte=cutoff
        ).select_related('user')

        if target_username:
            qs = qs.filter(user__username=target_username)

        total_eligible = qs.count()

        if total_eligible == 0:
            self.stdout.write(self.style.SUCCESS(f'No accounts pending permanent purge (cutoff: {cutoff:%Y-%m-%d %H:%M} UTC).'))
            return

        mode_label = '[DRY-RUN] ' if dry_run else ''
        self.stdout.write(f'{mode_label}Found {total_eligible} account(s) eligible for permanent deletion.')

        purged_count = 0
        failed_count = 0
        total_files_cleaned = 0

        # Process up to batch_size accounts
        for profile in qs[:batch_size]:
            user = profile.user
            username = user.username
            user_id = user.id

            try:
                result = purge_user_account(user_id=user_id, dry_run=dry_run)
                if result.get('status') in ('purged', 'dry_run'):
                    purged_count += 1
                    files_num = result.get('files_deleted', result.get('files_count', 0))
                    total_files_cleaned += files_num
                    self.stdout.write(
                        self.style.SUCCESS(
                            f"  [OK] {mode_label}User '{username}' (ID {user_id}) purged. Files unlinked: {files_num}."
                        )
                    )
                else:
                    self.stdout.write(
                        self.style.WARNING(f"  [-] User '{username}' skipped ({result.get('status')}).")
                    )
            except Exception as e:
                failed_count += 1
                logger.exception("Failed to purge account %s (ID %s): %s", username, user_id, e)
                self.stdout.write(
                    self.style.ERROR(f"  [FAIL] Failed to purge user '{username}' (ID {user_id}): {e}")
                )

        summary_msg = f"{mode_label}Purge complete: {purged_count} account(s) purged, {total_files_cleaned} file(s) cleaned, {failed_count} failure(s)."
        if failed_count > 0:
            self.stdout.write(self.style.WARNING(summary_msg))
        else:
            self.stdout.write(self.style.SUCCESS(summary_msg))
