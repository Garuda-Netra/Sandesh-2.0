"""
SDH Root URL Configuration
"""

from django.contrib import admin
from django.urls import path, include, re_path
from django.conf import settings
from django.conf.urls.static import static
from django.views.static import serve

urlpatterns = [
    # Admin
    path('admin/', admin.site.urls),

    # Serve uploaded media files (avatars, moments, attachments)
    re_path(r'^media/(?P<path>.*)$', serve, {'document_root': settings.MEDIA_ROOT}),

    # Messaging
    path('messaging/', include('messaging.urls')),

    # Landing page (root) — served by users app (index view)
    path('', include('users.urls')),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
