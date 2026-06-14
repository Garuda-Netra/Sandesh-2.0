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
    path('api/chatbot/events/', views.manage_auto_wish_events, name='chatbot_events'),
    path('api/chatbot/pending-wishes/', views.get_pending_wishes, name='chatbot_pending_wishes'),
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

    # ── Group Chat ────────────────────────────────────────────────
    path('api/groups/create/', views.group_create, name='group_create'),
    path('api/groups/list/', views.group_list, name='group_list'),
    path('api/groups/<int:group_id>/', views.group_info, name='group_info'),
    path('api/groups/<int:group_id>/update/', views.group_update, name='group_update'),
    path('api/groups/<int:group_id>/members/add/', views.group_add_members, name='group_add_members'),
    path('api/groups/<int:group_id>/members/remove/', views.group_remove_member, name='group_remove_member'),
    path('api/groups/<int:group_id>/clear/', views.clear_group_chat, name='clear_group_chat'),
    path('api/groups/<int:group_id>/members/leave/', views.group_leave, name='group_leave'),
    path('api/groups/<int:group_id>/members/role/', views.group_change_role, name='group_change_role'),
    path('api/groups/<int:group_id>/history/', views.group_message_history, name='group_message_history'),
    path('api/groups/messages/<int:message_id>/reads/', views.group_message_reads, name='group_message_reads'),
    path('api/groups/invites/pending/', views.pending_group_invites, name='pending_group_invites'),
    path('api/groups/invites/<int:invite_id>/respond/', views.group_invite_respond, name='group_invite_respond'),
]
