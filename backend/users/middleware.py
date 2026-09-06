from django.contrib.auth import logout
from django.utils.deprecation import MiddlewareMixin
import hashlib

class SessionSecurityMiddleware(MiddlewareMixin):
    """
    Middleware to prevent session hijacking by tying the session to
    the user's IP address and User-Agent. If either changes dramatically
    during an active session, the user is automatically logged out.
    """
    def process_request(self, request):
        if not hasattr(request, 'user') or not request.user.is_authenticated:
            return None

        # Get current IP
        x_forwarded_for = request.META.get('HTTP_X_FORWARDED_FOR')
        if x_forwarded_for:
            ip = x_forwarded_for.split(',')[0].strip()
        else:
            ip = request.META.get('REMOTE_ADDR', '')
            
        # Get User-Agent
        user_agent = request.META.get('HTTP_USER_AGENT', '')
        
        # Create a combined secure hash
        current_hash = hashlib.sha256(f"{ip}::{user_agent}".encode('utf-8')).hexdigest()

        # Check existing hash in session
        session_hash = request.session.get('security_hash')

        if not session_hash:
            # First time for this session, store the hash
            request.session['security_hash'] = current_hash
        elif session_hash != current_hash:
            # Hash mismatch! Potential session hijacking. Log the user out immediately.
            logout(request)
            
        return None

from django.utils import timezone
from .models import UserSession

class UserSessionTrackingMiddleware(MiddlewareMixin):
    """
    Middleware to track last activity of UserSessions.
    Only updates the database every 5 minutes to minimize write overhead.
    """
    def process_request(self, request):
        if hasattr(request, 'user') and request.user.is_authenticated and request.session.session_key:
            session_key = request.session.session_key
            try:
                user_session = UserSession.objects.filter(session_key=session_key).first()
                if user_session:
                    now = timezone.now()
                    # Update only if more than 5 minutes have passed
                    if (now - user_session.last_activity).total_seconds() > 300:
                        user_session.last_activity = now
                        user_session.save(update_fields=['last_activity'])
            except Exception:
                pass
        return None
