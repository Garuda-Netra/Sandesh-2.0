"""
Messaging URL Configuration
"""

from django.urls import path
from . import views

app_name = 'messaging'

urlpatterns = [
    path('chat/', views.chat_view, name='chat'),
    path('call/', views.call_view, name='call'),
    path('call/<str:username>/', views.call_view, name='call_with_user'),
    path('api/history/<str:username>/', views.message_history, name='message_history'),
    path('api/save/', views.save_message, name='save_message'),
    path('api/unread/', views.unread_counts, name='unread_counts'),
    path('api/chat-setting/<str:username>/', views.chat_setting_api, name='chat_setting_api'),
    path('api/chatbot/', views.chatbot_reply, name='chatbot_reply'),
    # Secure file transfer
    path('upload-file/', views.upload_file, name='upload_file'),
    path('download-file/<int:file_id>/', views.download_file, name='download_file'),
    # Professional message deletion
    path('api/message/<int:message_id>/remove-my-view/', views.remove_from_my_view, name='remove_from_my_view'),
    path('api/message/<int:message_id>/delete-for-all/', views.delete_for_all, name='delete_for_all'),
    # Clear all chat history
    path('api/clear-chat/<str:username>/', views.clear_chat, name='clear_chat'),
    
    # Moments (Temporary Updates)
    path('api/moments/', views.get_moments, name='get_moments'),
    path('api/moments/upload/', views.upload_moment, name='upload_moment'),
    path('api/moments/<int:moment_id>/', views.delete_moment, name='delete_moment'),
    path('api/moments/<int:moment_id>/view/', views.view_moment, name='view_moment'),
    path('api/moments/<int:moment_id>/react/', views.react_moment, name='react_moment'),
    
    # Spotify Integration
    path('api/spotify/search/', views.spotify_search, name='spotify_search'),
]
