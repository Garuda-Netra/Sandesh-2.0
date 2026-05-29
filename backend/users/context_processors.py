from django.conf import settings

def firebase_config(request):
    """
    Context processor to pass Firebase frontend configurations to Django templates.
    """
    return {
        'FIREBASE_API_KEY': getattr(settings, 'FIREBASE_API_KEY', ''),
        'FIREBASE_AUTH_DOMAIN': getattr(settings, 'FIREBASE_AUTH_DOMAIN', ''),
        'FIREBASE_PROJECT_ID': getattr(settings, 'FIREBASE_PROJECT_ID', ''),
        'FIREBASE_APP_ID': getattr(settings, 'FIREBASE_APP_ID', ''),
    }
