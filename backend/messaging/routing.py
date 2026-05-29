"""
Messaging WebSocket URL Routing
"""

from django.urls import re_path
from . import consumers

websocket_urlpatterns = [
    # Real-time chat — integer user_id (primary route, checked first)
    # Matches /ws/chat/42/ but NOT /ws/chat/alice/
    re_path(r'^ws/chat/(?P<user_id>[0-9]{1,18})/$', consumers.ChatConsumer.as_asgi()),

    # Backward-compatible route — username (must contain at least one non-digit)
    re_path(r'^ws/chat/(?P<username>[^\d/][^/]*)/$', consumers.ChatConsumer.as_asgi()),

    # WebRTC signaling
    re_path(r'^ws/signal/(?P<username>[\w.@+-]+)/$', consumers.SignalingConsumer.as_asgi()),
]
