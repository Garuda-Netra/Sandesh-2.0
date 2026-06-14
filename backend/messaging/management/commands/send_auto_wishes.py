import logging
from django.core.management.base import BaseCommand
from django.utils import timezone
from messaging.models import AutoWishEvent, AutoWishMessage
from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync

logger = logging.getLogger(__name__)

class Command(BaseCommand):
    help = 'Generates and sends automated wishes for events occurring today.'

    def handle(self, *args, **options):
        today = timezone.localdate()
        # Find events where month and day match today
        events = AutoWishEvent.objects.filter(
            event_date__month=today.month,
            event_date__day=today.day
        )
        
        count = 0
        channel_layer = get_channel_layer()
        
        for event in events:
            # Generate message based on language
            if event.language_preference == AutoWishEvent.LANGUAGE_ENGLISH:
                if event.event_type == AutoWishEvent.EVENT_TYPE_BIRTHDAY:
                    text = "🎉 Happy Birthday! Wishing you joy and success ✨"
                elif event.event_type == AutoWishEvent.EVENT_TYPE_ANNIVERSARY:
                    text = "🎉 Happy Anniversary! Wishing you many more years of happiness ✨"
                else:
                    text = "🎉 Wishing you all the best on your special day! ✨"
            else:
                if event.event_type == AutoWishEvent.EVENT_TYPE_BIRTHDAY:
                    text = "🎂 Happy Birthday dost! Khush raho, mast raho 💫"
                elif event.event_type == AutoWishEvent.EVENT_TYPE_ANNIVERSARY:
                    text = "🎉 Happy Anniversary! Humesha aise hi sath raho 💫"
                else:
                    text = "🎉 Mubarak ho aapka special day! Khush raho 💫"

            # Save the message to DB for persistence
            msg = AutoWishMessage.objects.create(
                user=event.user,
                message=text,
                is_delivered=False
            )
            
            # Attempt to push real-time via WebSocket
            try:
                group_name = f"user_chat_{event.user.id}"
                payload = {
                    'type': 'auto_wish',
                    'message': text,
                    'message_id': msg.id
                }
                async_to_sync(channel_layer.group_send)(group_name, payload)
                self.stdout.write(self.style.SUCCESS(f'Sent real-time wish to {event.user.username}'))
            except Exception as e:
                logger.error(f"Failed to send real-time wish via websocket to {event.user.username}: {e}")
                self.stdout.write(self.style.WARNING(f'Could not send real-time wish to {event.user.username}. Will deliver on next login.'))
                
            count += 1
            
        self.stdout.write(self.style.SUCCESS(f'Successfully generated {count} auto-wishes for {today}.'))
