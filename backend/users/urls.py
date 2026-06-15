"""
Users URL Configuration
"""

from django.urls import path
from . import views

app_name = 'users'

urlpatterns = [
    # Landing page (root URL)
    path('', views.index, name='index'),

    # Auth
    path('register/', views.register_view, name='register'),
    path('login/', views.login_view, name='login'),
    path('logout/', views.logout_view, name='logout'),
    path('auth/clerk/login/', views.clerk_login_view, name='clerk_login'),

    # Profile
    path('profile/', views.profile_view, name='profile'),

    # Account deletion
    path('account/delete/', views.delete_account_view, name='delete_account'),

    # API endpoints
    path('api/profile/<str:username>/', views.user_profile_api, name='user_profile_api'),
    path('api/remove-avatar/', views.remove_avatar_view, name='remove_avatar'),
    path('api/report-bug/', views.report_bug_view, name='report_bug'),
    path('api/users/', views.user_list, name='user_list'),
    path('api/search-users/', views.search_users, name='search_users'),
    path('api/remove-user/', views.remove_user_view, name='remove_user'),
    path('api/unblock-user/', views.unblock_user_view, name='unblock_user'),
    path('api/unfriend/', views.unfriend_view, name='unfriend'),

    # Friend request APIs
    path('api/send-friend-request/', views.send_friend_request_view, name='send_friend_request'),
    path('api/respond-friend-request/', views.respond_friend_request_view, name='respond_friend_request'),
    path('api/friend-requests/', views.friend_requests_view, name='friend_requests'),

    # Session management APIs
    path('api/sessions/', views.session_list_api, name='session_list'),
    path('api/sessions/<str:session_key>/terminate/', views.terminate_session_api, name='terminate_session'),
    path('api/sessions/terminate-others/', views.terminate_other_sessions_api, name='terminate_other_sessions'),
]
