import logging
import zoneinfo
from django.core.management.base import BaseCommand
from django.utils import timezone
from messaging.models import AutoWishEvent, AutoWishMessage
from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync

logger = logging.getLogger(__name__)

class Command(BaseCommand):
    help = 'Generates and sends automated wishes for events occurring today.'

    def handle(self, *args, **options):
        ist = zoneinfo.ZoneInfo("Asia/Kolkata")
        today = timezone.now().astimezone(ist).date()
        # Find events where month and day match today
        events = AutoWishEvent.objects.filter(
            event_date__month=today.month,
            event_date__day=today.day
        )
        
        count = 0
        channel_layer = get_channel_layer()
        
        for event in events:
            sender_name = event.user.first_name or event.user.username
            target = event.target_user if event.target_user else event.user

            # Generate message based on language
            if event.language_preference == AutoWishEvent.LANGUAGE_ENGLISH:
                if event.event_type == AutoWishEvent.EVENT_TYPE_BIRTHDAY:
                    text = f"🎉 Happy Birthday! {sender_name} scheduled this wish for you ✨"
                elif event.event_type == AutoWishEvent.EVENT_TYPE_ANNIVERSARY:
                    text = f"🎉 Happy Anniversary! {sender_name} scheduled this wish for you ✨"
                else:
                    text = f"🎉 Wishing you all the best on your special day! From {sender_name} ✨"
            else:
                if event.event_type == AutoWishEvent.EVENT_TYPE_BIRTHDAY:
                    text = f"🎂 Happy Birthday dost! {sender_name} ne yeh wish schedule ki thi 💫"
                elif event.event_type == AutoWishEvent.EVENT_TYPE_ANNIVERSARY:
                    text = f"🎉 Happy Anniversary! {sender_name} ne yeh wish schedule ki thi 💫"
                else:
                    text = f"🎉 Mubarak ho aapka special day! From {sender_name} 💫"

            # Save the message to DB for persistence
            msg = AutoWishMessage.objects.create(
                user=target,
                message=text,
                is_delivered=False
            )
            
            # Attempt to push real-time via WebSocket
            try:
                group_name = f"user_chat_{target.id}"
                payload = {
                    'type': 'auto_wish',
                    'message': text,
                    'message_id': msg.id
                }
                async_to_sync(channel_layer.group_send)(group_name, payload)
                self.stdout.write(self.style.SUCCESS(f'Sent real-time wish to {target.username}'))
            except Exception as e:
                logger.error(f"Failed to send real-time wish via websocket to {target.username}: {e}")
                self.stdout.write(self.style.WARNING(f'Could not send real-time wish to {target.username}. Will deliver on next login.'))
                
            count += 1
            
        self.stdout.write(self.style.SUCCESS(f'Successfully generated {count} auto-wishes for {today} (IST).'))
