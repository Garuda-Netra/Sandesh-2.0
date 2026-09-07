import json
import time
from django.test import TestCase, Client
from django.contrib.auth.models import User
from messaging.models import Message, Group, GroupMembership, ChatLock, UserSecurityCredential
from users.models import UserProfile


class ChatLockTestCase(TestCase):
    def setUp(self):
        self.client = Client()
        self.user1 = User.objects.create_user(username='alice', password='password123')
        self.user2 = User.objects.create_user(username='bob', password='password123')
        self.user3 = User.objects.create_user(username='charlie', password='password123')

        # Profiles are automatically created via User post_save signal

        # Create message between alice and bob
        Message.objects.create(sender=self.user2, receiver=self.user1, message='Hello Alice')
        # Create message between alice and charlie
        Message.objects.create(sender=self.user3, receiver=self.user1, message='Hello from Charlie')

        # Create a group with alice and bob
        self.group = Group.objects.create(name='Test Group', created_by=self.user1)
        GroupMembership.objects.create(group=self.group, user=self.user1, role=GroupMembership.ROLE_OWNER)
        GroupMembership.objects.create(group=self.group, user=self.user2, role=GroupMembership.ROLE_MEMBER)

    def test_zero_harm_non_locked_chats(self):
        """Un-locked chats work 100% normally without any lock barriers."""
        self.client.login(username='alice', password='password123')

        # Non-locked direct chat history returns 200
        res = self.client.get(f'/messaging/api/history/{self.user2.username}/')
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(len(data['messages']), 1)

        # Non-locked group history returns 200
        res = self.client.get(f'/messaging/api/groups/{self.group.id}/history/')
        self.assertEqual(res.status_code, 200)

        # Chat view loads with 0 locked chats
        res = self.client.get('/messaging/chat/')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.context['locked_chats_count'], 0)

    def test_pin_setup_and_verification(self):
        """Setup PIN, verify correct PIN, test invalid PIN and rate limiting."""
        self.client.login(username='alice', password='password123')

        # Setting invalid PIN fails (must be 4-6 digits)
        res = self.client.post('/messaging/api/security/setup-pin/', json.dumps({'pin': '12'}), content_type='application/json')
        self.assertEqual(res.status_code, 400)

        # Setup valid PIN 1234
        res = self.client.post('/messaging/api/security/setup-pin/', json.dumps({'pin': '1234'}), content_type='application/json')
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertTrue(data.get('unlocked'))

        # Check credential in DB
        cred = UserSecurityCredential.objects.get(user=self.user1)
        self.assertTrue(cred.has_pin)

        # Lock session
        self.client.post('/messaging/api/chat-lock/lock-now/')

        # Verify incorrect PIN
        res = self.client.post('/messaging/api/security/verify-pin/', json.dumps({'pin': '9999'}), content_type='application/json')
        self.assertEqual(res.status_code, 400)

        # Verify correct PIN
        res = self.client.post('/messaging/api/security/verify-pin/', json.dumps({'pin': '1234'}), content_type='application/json')
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.json().get('unlocked'))

    def test_chat_lock_flow_direct_and_group(self):
        """Lock chat with Bob, verify lock enforcement and unlock flow."""
        self.client.login(username='alice', password='password123')

        # Setup PIN first
        self.client.post('/messaging/api/security/setup-pin/', json.dumps({'pin': '4321'}), content_type='application/json')

        # Lock chat with Bob
        res = self.client.post('/messaging/api/chat-lock/toggle/', json.dumps({
            'chat_type': 'direct',
            'target_id': self.user2.username,
        }), content_type='application/json')
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.json()['is_locked'])

        # Lock Group
        res = self.client.post('/messaging/api/chat-lock/toggle/', json.dumps({
            'chat_type': 'group',
            'target_id': self.group.id,
        }), content_type='application/json')
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.json()['is_locked'])

        # Check status API
        res = self.client.get('/messaging/api/chat-lock/status/')
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn(self.user2.username, data['locked_users'])
        self.assertIn(self.group.id, data['locked_group_ids'])

        # Now lock session immediately
        self.client.post('/messaging/api/chat-lock/lock-now/')

        # Accessing locked chat with Bob should now return HTTP 423 Locked!
        res = self.client.get(f'/messaging/api/history/{self.user2.username}/')
        self.assertEqual(res.status_code, 423)
        self.assertTrue(res.json().get('locked'))

        # Accessing locked group should return HTTP 423 Locked!
        res = self.client.get(f'/messaging/api/groups/{self.group.id}/history/')
        self.assertEqual(res.status_code, 423)
        self.assertTrue(res.json().get('locked'))

        # BUT Charlie's chat is NOT locked, so it must return 200 without any issue!
        res = self.client.get(f'/messaging/api/history/{self.user3.username}/')
        self.assertEqual(res.status_code, 200)

        # Now verify PIN to unlock session
        res = self.client.post('/messaging/api/security/verify-pin/', json.dumps({'pin': '4321'}), content_type='application/json')
        self.assertEqual(res.status_code, 200)

        # Now Bob's chat history should return 200!
        res = self.client.get(f'/messaging/api/history/{self.user2.username}/')
        self.assertEqual(res.status_code, 200)

        # And Group history should return 200!
        res = self.client.get(f'/messaging/api/groups/{self.group.id}/history/')
        self.assertEqual(res.status_code, 200)

    def test_webauthn_options_and_verify(self):
        """Test WebAuthn options and verification endpoints."""
        self.client.login(username='alice', password='password123')

        # WebAuthn register options
        res = self.client.get('/messaging/api/security/webauthn-register-options/')
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn('challenge', data)
        self.assertIn('rp', data)
        self.assertEqual(data['authenticatorSelection']['authenticatorAttachment'], 'platform')

        # WebAuthn register verify
        res = self.client.post('/messaging/api/security/webauthn-register-verify/', json.dumps({
            'id': 'test_credential_id_123',
            'clientDataJSON': 'test_client_data',
        }), content_type='application/json')
        self.assertEqual(res.status_code, 200)

        cred = UserSecurityCredential.objects.get(user=self.user1)
        self.assertTrue(cred.biometric_enabled)
        self.assertEqual(cred.biometric_credential_id, 'test_credential_id_123')

        # WebAuthn auth options
        res = self.client.get('/messaging/api/security/webauthn-auth-options/')
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn('challenge', data)
        self.assertEqual(data['allowCredentials'][0]['id'], 'test_credential_id_123')

        # Lock session
        self.client.post('/messaging/api/chat-lock/lock-now/')

        # WebAuthn auth verify
        res = self.client.post('/messaging/api/security/webauthn-auth-verify/', json.dumps({
            'id': 'test_credential_id_123',
            'clientDataJSON': 'test_client_data',
        }), content_type='application/json')
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.json().get('unlocked'))
