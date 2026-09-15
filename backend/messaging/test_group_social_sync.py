import json
from django.test import TestCase, Client
from django.contrib.auth.models import User
from messaging.models import (
    Group, GroupMembership, GroupMessage, GroupMessageRead,
    GroupMessageDelivery, GroupE2EKey, Message
)
from users.models import UserProfile, Friendship


class GroupSocialSyncTestCase(TestCase):
    def setUp(self):
        self.client = Client()
        self.alice = User.objects.create_user(username='alice', password='password123', email='alice@example.com')
        self.bob = User.objects.create_user(username='bob', password='password123', email='bob@example.com')
        self.charlie = User.objects.create_user(username='charlie', password='password123', email='charlie@example.com')
        self.david = User.objects.create_user(username='david', password='password123', email='david@example.com')

        # Alice <-> Bob
        Friendship.add_friendship(self.alice.profile, self.bob.profile)
        # Bob <-> Charlie
        Friendship.add_friendship(self.bob.profile, self.charlie.profile)
        # Alice <-> David
        Friendship.add_friendship(self.alice.profile, self.david.profile)
        # Note: Alice is NOT friends with Charlie

    def test_unfriend_auto_removes_from_group_when_no_friends_remain(self):
        """If Alice & Bob unfriend, and Alice has no other friends in the group, Alice is auto-removed."""
        group = Group.objects.create(name='Devs Group', created_by=self.bob)
        GroupMembership.objects.create(group=group, user=self.bob, role=GroupMembership.ROLE_OWNER)
        GroupMembership.objects.create(group=group, user=self.alice, role=GroupMembership.ROLE_MEMBER)
        GroupMembership.objects.create(group=group, user=self.charlie, role=GroupMembership.ROLE_MEMBER)

        # Distribute E2E key to Alice
        GroupE2EKey.objects.create(group=group, user=self.alice, sender=self.bob, encrypted_key='key_alice')

        self.assertEqual(group.memberships.count(), 3)
        self.assertTrue(GroupE2EKey.objects.filter(group=group, user=self.alice).exists())

        # Bob unfriends Alice
        self.client.login(username='bob', password='password123')
        res = self.client.post(
            '/api/unfriend/',
            data=json.dumps({'target_user_id': self.alice.id}),
            content_type='application/json'
        )
        self.assertEqual(res.status_code, 200)

        # Alice had only Bob as a friend in the group (Charlie is not her friend).
        # Alice should be removed from group!
        self.assertFalse(GroupMembership.objects.filter(group=group, user=self.alice).exists())
        # Alice's E2E key in that group must be deleted for zero-knowledge security!
        self.assertFalse(GroupE2EKey.objects.filter(group=group, user=self.alice).exists())
        # Charlie and Bob should still be in the group
        self.assertTrue(GroupMembership.objects.filter(group=group, user=self.bob).exists())
        self.assertTrue(GroupMembership.objects.filter(group=group, user=self.charlie).exists())
        self.assertEqual(group.memberships.count(), 2)

    def test_unfriend_retains_member_if_other_friends_exist_in_group(self):
        """Alice stays in the group if she has another friend (David) in the group."""
        Friendship.add_friendship(self.bob.profile, self.david.profile)
        group = Group.objects.create(name='Engineers Group', created_by=self.bob)
        GroupMembership.objects.create(group=group, user=self.bob, role=GroupMembership.ROLE_OWNER)
        GroupMembership.objects.create(group=group, user=self.alice, role=GroupMembership.ROLE_MEMBER)
        GroupMembership.objects.create(group=group, user=self.david, role=GroupMembership.ROLE_MEMBER)

        self.assertEqual(group.memberships.count(), 3)

        # Bob unfriends Alice
        self.client.login(username='bob', password='password123')
        res = self.client.post(
            '/api/unfriend/',
            data=json.dumps({'target_user_id': self.alice.id}),
            content_type='application/json'
        )
        self.assertEqual(res.status_code, 200)

        # Alice is still friends with David, who is in this group!
        # So Alice MUST stay in the group.
        self.assertTrue(GroupMembership.objects.filter(group=group, user=self.alice).exists())
        self.assertEqual(group.memberships.count(), 3)

    def test_remove_member_api_authorization_and_key_cleanup(self):
        """Admin/owner can remove member, which revokes membership and cleans up E2E key."""
        group = Group.objects.create(name='Security Group', created_by=self.bob)
        GroupMembership.objects.create(group=group, user=self.bob, role=GroupMembership.ROLE_OWNER)
        GroupMembership.objects.create(group=group, user=self.alice, role=GroupMembership.ROLE_MEMBER)

        GroupE2EKey.objects.create(group=group, user=self.alice, sender=self.bob, encrypted_key='e2e_secret')

        # Alice (regular member) cannot remove Bob
        self.client.login(username='alice', password='password123')
        res = self.client.post(
            f'/messaging/api/groups/{group.id}/members/remove/',
            data=json.dumps({'user_id': self.bob.id}),
            content_type='application/json'
        )
        self.assertEqual(res.status_code, 403)

        # Bob (owner) removes Alice
        self.client.logout()
        self.client.login(username='bob', password='password123')
        res = self.client.post(
            f'/messaging/api/groups/{group.id}/members/remove/',
            data=json.dumps({'user_id': self.alice.id}),
            content_type='application/json'
        )
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data['status'], 'ok')
        self.assertEqual(data['removed'], 'alice')

        # Membership and E2E key are both deleted
        self.assertFalse(GroupMembership.objects.filter(group=group, user=self.alice).exists())
        self.assertFalse(GroupE2EKey.objects.filter(group=group, user=self.alice).exists())

    def test_group_message_delivery_and_read_tracking(self):
        """Group message history marks delivered and read receipts properly."""
        group = Group.objects.create(name='Tick Test Group', created_by=self.bob)
        GroupMembership.objects.create(group=group, user=self.bob, role=GroupMembership.ROLE_OWNER)
        GroupMembership.objects.create(group=group, user=self.alice, role=GroupMembership.ROLE_MEMBER)

        # Bob sends message
        msg = GroupMessage.objects.create(group=group, sender=self.bob, message='Test message')

        # Initially, Bob checks history: 0 reads, 0 deliveries from Alice
        self.client.login(username='bob', password='password123')
        res = self.client.get(f'/messaging/api/groups/{group.id}/history/')
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(len(data['messages']), 1)
        # Not delivered to Alice yet, so is_delivered is False, is_read is False
        self.assertFalse(data['messages'][0]['is_delivered'])
        self.assertFalse(data['messages'][0]['is_read'])

        # Alice loads history -> this marks message as delivered AND read by Alice
        self.client.logout()
        self.client.login(username='alice', password='password123')
        res_alice = self.client.get(f'/messaging/api/groups/{group.id}/history/')
        self.assertEqual(res_alice.status_code, 200)

        self.assertTrue(GroupMessageDelivery.objects.filter(message=msg, user=self.alice).exists())
        self.assertTrue(GroupMessageRead.objects.filter(message=msg, user=self.alice).exists())

        # Now Bob checks history again -> both is_delivered and is_read should be True!
        self.client.logout()
        self.client.login(username='bob', password='password123')
        res_bob = self.client.get(f'/messaging/api/groups/{group.id}/history/')
        self.assertEqual(res_bob.status_code, 200)
        data_bob = res_bob.json()
        self.assertTrue(data_bob['messages'][0]['is_delivered'])
        self.assertTrue(data_bob['messages'][0]['is_read'])

    def test_non_friend_group_member_profile_privacy(self):
        """Group member who is NOT a friend cannot view email, phone, or bio via user_profile_api."""
        # Charlie is in group with Alice, but they are NOT friends
        self.client.login(username='alice', password='password123')
        res = self.client.get(f'/api/profile/{self.charlie.username}/')
        self.assertEqual(res.status_code, 200)
        data = res.json()

        self.assertFalse(data['is_friend'])
        self.assertEqual(data['email'], '')
        self.assertEqual(data['phone_number'], '')
        self.assertEqual(data['bio'], '')
