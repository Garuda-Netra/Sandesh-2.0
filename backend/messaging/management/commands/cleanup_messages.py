from django.core.management.base import BaseCommand
from django.utils import timezone
from messaging.models import Message

class Command(BaseCommand):
    help = 'Deletes expired messages from the database'

    def handle(self, *args, **kwargs):
        now = timezone.now()
        expired_msgs = Message.objects.filter(expires_at__lt=now)
        count = expired_msgs.count()
        if count > 0:
            expired_msgs.delete()
            self.stdout.write(self.style.SUCCESS(f'Successfully deleted {count} expired messages.'))
        else:
            self.stdout.write(self.style.SUCCESS('No expired messages found.'))
