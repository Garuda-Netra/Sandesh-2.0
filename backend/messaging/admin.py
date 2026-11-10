"""
Messaging Admin
"""

from django.contrib import admin
from .models import Message, CallLog, Group, GroupMembership, GroupMessage, GroupMessageRead, GroupMessageDelivery, GroupE2EKey, StarredMessage, PinnedChat


@admin.register(Message)
class MessageAdmin(admin.ModelAdmin):
    list_display = ('sender', 'receiver', 'message_type', 'timestamp', 'is_read')
    list_filter = ('message_type', 'is_read', 'timestamp')
    search_fields = ('sender__username', 'receiver__username')
    readonly_fields = ('message', 'timestamp')
    ordering = ('-timestamp',)

    def has_change_permission(self, request, obj=None):
        return False


@admin.register(CallLog)
class CallLogAdmin(admin.ModelAdmin):
    list_display = ('caller', 'callee', 'call_type', 'status', 'started_at', 'duration_seconds')
    list_filter = ('call_type', 'status')
    search_fields = ('caller__username', 'callee__username')
    readonly_fields = ('started_at',)


class GroupMembershipInline(admin.TabularInline):
    model = GroupMembership
    extra = 0
    readonly_fields = ('joined_at',)


@admin.register(Group)
class GroupAdmin(admin.ModelAdmin):
    list_display = ('name', 'created_by', 'member_count', 'created_at')
    search_fields = ('name', 'created_by__username')
    readonly_fields = ('created_at', 'updated_at')
    inlines = [GroupMembershipInline]


@admin.register(GroupMessage)
class GroupMessageAdmin(admin.ModelAdmin):
    list_display = ('group', 'sender', 'message_type', 'is_system_message', 'timestamp')
    list_filter = ('message_type', 'is_system_message', 'timestamp')
    search_fields = ('group__name', 'sender__username')
    readonly_fields = ('timestamp',)
    ordering = ('-timestamp',)

    def has_change_permission(self, request, obj=None):
        return False


@admin.register(GroupE2EKey)
class GroupE2EKeyAdmin(admin.ModelAdmin):
    list_display = ('group', 'user', 'sender', 'created_at')
    search_fields = ('group__name', 'user__username', 'sender__username')
    readonly_fields = ('encrypted_key', 'encryption_iv', 'created_at')


@admin.register(StarredMessage)
class StarredMessageAdmin(admin.ModelAdmin):
    list_display = ('user', 'message', 'group_message', 'created_at')
    list_filter = ('created_at',)
    search_fields = ('user__username',)
    readonly_fields = ('created_at',)
    ordering = ('-created_at',)


@admin.register(PinnedChat)
class PinnedChatAdmin(admin.ModelAdmin):
    list_display = ('user', 'pinned_user', 'pinned_group', 'is_self_chat', 'pinned_at')
    list_filter = ('is_self_chat', 'pinned_at')
    search_fields = ('user__username', 'pinned_user__username', 'pinned_group__name')
    readonly_fields = ('pinned_at',)
    ordering = ('-pinned_at',)


