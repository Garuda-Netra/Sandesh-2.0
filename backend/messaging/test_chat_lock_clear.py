import json
from django.test import TestCase, Client
from django.contrib.auth.models import User
from messaging.models import Message, ChatLock, UserSecurityCredential


class ChatLockClearTestCase(TestCase):
    def setUp(self):
        self.user1 = User.objects.create_user(username='alice', password='password123')
        self.user2 = User.objects.create_user(username='bob', password='password123')
        self.client = Client()
        self.client.login(username='alice', password='password123')

        # Setup PIN for user1
        UserSecurityCredential.objects.create(
            user=self.user1,
            pin_hash='hash123'
        )

    def test_toggle_chat_lock_with_user_alias(self):
        # Test toggle using 'user' chat_type alias
        res = self.client.post(
            '/messaging/api/chat-lock/toggle/',
            data=json.dumps({'chat_type': 'user', 'target_id': self.user2.id}),
            content_type='application/json'
        )
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.json()['is_locked'])
        self.assertTrue(ChatLock.objects.filter(user=self.user1, locked_user=self.user2).exists())

    def test_unlock_and_clear_specific_chat(self):
        # Lock user2 chat
        ChatLock.objects.create(user=self.user1, locked_user=self.user2)

        # Create messages between alice and bob
        Message.objects.create(sender=self.user1, receiver=self.user2, message='Secret 1')
        Message.objects.create(sender=self.user2, receiver=self.user1, message='Secret 2')

        self.assertEqual(Message.objects.filter(sender=self.user1, receiver=self.user2).count(), 1)
        self.assertEqual(Message.objects.filter(sender=self.user2, receiver=self.user1).count(), 1)

        # Call unlock_and_clear_chat
        res = self.client.post(
            '/messaging/api/chat-lock/unlock-clear/',
            data=json.dumps({'chat_type': 'direct', 'target_id': self.user2.username}),
            content_type='application/json'
        )
        self.assertEqual(res.status_code, 200)
        self.assertFalse(res.json()['is_locked'])

        # Verify messages between alice and bob were cleared
        self.assertEqual(Message.objects.filter(sender=self.user1, receiver=self.user2).count(), 0)
        self.assertEqual(Message.objects.filter(sender=self.user2, receiver=self.user1).count(), 0)

        # Verify chat lock was removed
        self.assertFalse(ChatLock.objects.filter(user=self.user1, locked_user=self.user2).exists())
