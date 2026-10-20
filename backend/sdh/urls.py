"""
SDH Root URL Configuration
"""

from django.contrib import admin
from django.urls import path, include, re_path
from django.conf import settings
from django.conf.urls.static import static
from django.views.static import serve

def sdh_serve_media(request, path, document_root=None, show_indexes=False):
    """
    Serve uploaded media files (avatars, moments, attachments) with
    permissive CORS and CORP headers so images, audio, and videos
    render without browser origin or security policy blocks.
    """
    response = serve(request, path, document_root=document_root, show_indexes=show_indexes)
    response['Access-Control-Allow-Origin'] = '*'
    response['Access-Control-Allow-Methods'] = 'GET, HEAD, OPTIONS'
    response['Access-Control-Allow-Headers'] = '*'
    response['Cross-Origin-Resource-Policy'] = 'cross-origin'
    return response

urlpatterns = [
    # Admin
    path('admin/', admin.site.urls),

    # Serve uploaded media files (avatars, moments, attachments)
    re_path(r'^media/(?P<path>.*)$', sdh_serve_media, {'document_root': settings.MEDIA_ROOT}),

    # Messaging
    path('messaging/', include('messaging.urls')),

    # Landing page (root) — served by users app (index view)
    path('', include('users.urls')),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
