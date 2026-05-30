"""
Messaging Admin
"""

from django.contrib import admin
from .models import Message, CallLog, Group, GroupMembership, GroupMessage


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
