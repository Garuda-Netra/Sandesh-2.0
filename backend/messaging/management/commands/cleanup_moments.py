import logging
from django.core.management.base import BaseCommand
from django.utils import timezone
from messaging.models import Moment

logger = logging.getLogger(__name__)

class Command(BaseCommand):
    help = 'Deletes expired Moments (older than 24 hours)'

    def handle(self, *args, **options):
        now = timezone.now()
        expired_moments = Moment.objects.filter(expires_at__lt=now)
        count = expired_moments.count()

        if count == 0:
            self.stdout.write(self.style.SUCCESS('No expired moments to delete.'))
            return

        # We delete one by one to ensure the pre_delete/post_delete signals fire 
        # and delete the media files from Cloudinary/storage.
        for moment in expired_moments:
            try:
                moment.delete()
            except Exception as e:
                logger.error(f"Failed to delete moment {moment.id}: {e}")

        self.stdout.write(self.style.SUCCESS(f'Successfully deleted {count} expired moment(s).'))
