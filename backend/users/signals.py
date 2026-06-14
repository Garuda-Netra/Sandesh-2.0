import threading
import requests
from django.contrib.auth.signals import user_logged_in
from django.dispatch import receiver
from .models import UserSession
from user_agents import parse

def fetch_location(session_id, ip):
    try:
        if ip in ('127.0.0.1', 'localhost', '::1'):
            UserSession.objects.filter(id=session_id).update(location="Local Network")
            return
        res = requests.get(f'http://ip-api.com/json/{ip}', timeout=3).json()
        if res.get('status') == 'success':
            loc = f"{res.get('city')}, {res.get('country')}"
            UserSession.objects.filter(id=session_id).update(location=loc)
    except Exception:
        pass

@receiver(user_logged_in)
def track_user_session(sender, user, request, **kwargs):
    if not request:
        return

    # Ensure session exists
    if not request.session.session_key:
        request.session.create()

    session_key = request.session.session_key
    
    # Parse User-Agent
    user_agent_str = request.META.get('HTTP_USER_AGENT', '')
    user_agent = parse(user_agent_str)

    device_name = user_agent.device.family if user_agent.device.family != 'Other' else 'Unknown Device'
    if user_agent.is_mobile:
        device_name = f"Mobile ({device_name})"
    elif user_agent.is_tablet:
        device_name = f"Tablet ({device_name})"
    elif user_agent.is_pc:
        device_name = f"Desktop"

    os_name = f"{user_agent.os.family} {user_agent.os.version_string}".strip()
    browser_name = f"{user_agent.browser.family} {user_agent.browser.version_string}".strip()

    # Get IP Address
    x_forwarded_for = request.META.get('HTTP_X_FORWARDED_FOR')
    if x_forwarded_for:
        ip = x_forwarded_for.split(',')[0].strip()
    else:
        ip = request.META.get('REMOTE_ADDR')

    # Create UserSession
    user_session, created = UserSession.objects.update_or_create(
        session_key=session_key,
        defaults={
            'user': user,
            'device_name': device_name,
            'os': os_name,
            'browser': browser_name,
            'ip_address': ip,
        }
    )

    if created and ip:
        threading.Thread(target=fetch_location, args=(user_session.id, ip), daemon=True).start()
