from django.contrib.auth import logout
from django.utils.deprecation import MiddlewareMixin
from django.conf import settings
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

        # Ensure session key exists for authenticated session
        if not request.session.session_key:
            request.session.create()

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
            if getattr(settings, 'DEBUG', False) or ip in ('127.0.0.1', 'localhost', '::1'):
                # In development or local testing, device emulation or localhost IP shifts should not invalidate session
                request.session['security_hash'] = current_hash
            else:
                # Hash mismatch! Potential session hijacking. Log the user out immediately.
                logout(request)
                return None

        # Check if the account has been deactivated / scheduled for deletion
        profile = getattr(request.user, 'profile', None)
        if profile and profile.is_pending_deletion:
            # If the 30-day grace period has passed, terminate session
            if profile.is_deletion_expired:
                logout(request)
                from django.shortcuts import redirect
                return redirect('users:login')

            # Verified owner in grace period is strictly constrained to reactivation/cancellation/logout
            path = request.path
            exempt_prefixes = (
                '/account/reactivate/',
                '/account/cancel-deletion/',
                '/logout/',
                '/static/',
                '/media/',
            )
            if not any(path.startswith(prefix) for prefix in exempt_prefixes):
                if request.headers.get('x-requested-with') == 'XMLHttpRequest' or request.content_type == 'application/json':
                    from django.http import JsonResponse
                    return JsonResponse({
                        'error': 'Account deactivated. Reactivation required.',
                        'code': 'account_deactivated',
                        'reactivate_url': '/account/reactivate/',
                    }, status=403)
                from django.shortcuts import redirect
                return redirect('users:reactivate_account')
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
