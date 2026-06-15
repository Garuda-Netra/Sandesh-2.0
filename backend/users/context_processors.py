from django.conf import settings

def clerk_config(request):
    """
    Context processor to pass Clerk frontend configurations to Django templates.
    """
    return {
        'CLERK_PUBLISHABLE_KEY': getattr(settings, 'CLERK_PUBLISHABLE_KEY', ''),
    }

