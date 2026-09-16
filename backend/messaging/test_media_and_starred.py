import json
import os
from django.test import TestCase, Client
from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from messaging.models import (
    Message, Group, GroupMembership, GroupMessage, StarredMessage
)
from users.models import Friendship


class MediaAndStarredMessagesTestCase(TestCase):
    def setUp(self):
        self.client = Client()
        self.alice = User.objects.create_user(username='alice', password='password123', email='alice@example.com')
        self.bob = User.objects.create_user(username='bob', password='password123', email='bob@example.com')
        self.charlie = User.objects.create_user(username='charlie', password='password123', email='charlie@example.com')

        Friendship.add_friendship(self.alice.profile, self.bob.profile)

        # Create Direct Messages between Alice and Bob
        # 1. Image (Visual Asset)
        img_file = SimpleUploadedFile("sample_photo.jpg", b"fake-jpg-content", content_type="image/jpeg")
        self.msg_img = Message.objects.create(
            sender=self.alice, receiver=self.bob, message='',
            message_type='image', original_filename='sample_photo.jpg',
            file_name='sample_photo.jpg', mime_type='image/jpeg',
            file=img_file
        )

        # 2. Document (Document Asset)
        doc_file = SimpleUploadedFile("report.pdf", b"fake-pdf-content", content_type="application/pdf")
        self.msg_doc = Message.objects.create(
            sender=self.bob, receiver=self.alice, message='',
            message_type='file', original_filename='report.pdf',
            file_name='report.pdf', mime_type='application/pdf',
            file=doc_file
        )

        # 3. Web Link (Shared Link)
        self.msg_link = Message.objects.create(
            sender=self.alice, receiver=self.bob,
            message='Please review the codebase at https://github.com/Garuda-Netra/Sandesh-2.0 and check www.google.com for docs.',
            message_type='text'
        )

        # 4. Group Setup
        self.group = Group.objects.create(name='Dev Team', created_by=self.alice)
        GroupMembership.objects.create(group=self.group, user=self.alice, role=GroupMembership.ROLE_OWNER)
        GroupMembership.objects.create(group=self.group, user=self.bob, role=GroupMembership.ROLE_MEMBER)

        grp_img = SimpleUploadedFile("diagram.png", b"fake-png-content", content_type="image/png")
        self.grp_msg_img = GroupMessage.objects.create(
            group=self.group, sender=self.alice, message='',
            message_type='image', original_filename='diagram.png',
            file_name='diagram.png', mime_type='image/png',
            file=grp_img
        )

    def test_toggle_star_message_direct(self):
        """Alice stars a direct message, then unstars it."""
        self.client.login(username='alice', password='password123')

        # Star
        res = self.client.post(f'/messaging/api/messages/{self.msg_img.id}/star/')
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data['status'], 'ok')
        self.assertTrue(data['is_starred'])
        self.assertTrue(StarredMessage.objects.filter(user=self.alice, message=self.msg_img).exists())

        # Unstar
        res2 = self.client.post(f'/messaging/api/messages/{self.msg_img.id}/star/')
        self.assertEqual(res2.status_code, 200)
        data2 = res2.json()
        self.assertFalse(data2['is_starred'])
        self.assertFalse(StarredMessage.objects.filter(user=self.alice, message=self.msg_img).exists())

    def test_toggle_star_group_message_authorization(self):
        """Only group members can star group messages."""
        # Charlie is not a member of the group
        self.client.login(username='charlie', password='password123')
        res = self.client.post(f'/messaging/api/messages/{self.grp_msg_img.id}/star/', data={'is_group': True})
        self.assertEqual(res.status_code, 403)

        # Bob is a member and can star it
        self.client.login(username='bob', password='password123')
        res2 = self.client.post(f'/messaging/api/messages/{self.grp_msg_img.id}/star/', data={'is_group': True})
        self.assertEqual(res2.status_code, 200)
        self.assertTrue(res2.json()['is_starred'])
        self.assertTrue(StarredMessage.objects.filter(user=self.bob, group_message=self.grp_msg_img).exists())

    def test_starred_messages_api(self):
        """Retrieves starred messages list filtered by conversation."""
        self.client.login(username='alice', password='password123')
        self.client.post(f'/messaging/api/messages/{self.msg_doc.id}/star/')
        self.client.post(f'/messaging/api/messages/{self.grp_msg_img.id}/star/', data={'is_group': True})

        # Query all starred
        res = self.client.get('/messaging/api/starred-messages/')
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data['count'], 2)

        # Query filtered by group
        res_grp = self.client.get(f'/messaging/api/starred-messages/?group_id={self.group.id}')
        self.assertEqual(res_grp.status_code, 200)
        data_grp = res_grp.json()
        self.assertEqual(data_grp['count'], 1)
        self.assertEqual(data_grp['starred_messages'][0]['message_id'], self.grp_msg_img.id)

    def test_chat_media_api_categorization_and_storage_stats(self):
        """Verifies categorization into Visual Assets, Documents, and Web Links with accurate storage stats."""
        self.client.login(username='alice', password='password123')

        res = self.client.get(f'/messaging/api/chat-media/?target_user=bob')
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data['status'], 'ok')

        stats = data['stats']
        self.assertEqual(stats['visual_count'], 1)
        self.assertEqual(stats['document_count'], 1)
        self.assertEqual(stats['web_link_count'], 2) # github.com and google.com
        self.assertTrue(stats['total_bytes'] > 0)

        # Visual Assets check
        visuals = data['visual_assets']
        self.assertEqual(len(visuals), 1)
        self.assertEqual(visuals[0]['filename'], 'sample_photo.jpg')
        self.assertEqual(visuals[0]['message_type'], 'image')

        # Documents check
        docs = data['documents']
        self.assertEqual(len(docs), 1)
        self.assertEqual(docs[0]['filename'], 'report.pdf')
        self.assertEqual(docs[0]['extension'], 'PDF')

        # Web Links check
        links = data['web_links']
        self.assertEqual(len(links), 2)
        urls = [l['url'] for l in links]
        self.assertTrue(any('github.com' in u for u in urls))
        self.assertTrue(any('google.com' in u for u in urls))

    def test_batch_storage_delete(self):
        """Batch delete removes items and frees storage."""
        self.client.login(username='alice', password='password123')

        payload = {
            'message_ids': [self.msg_img.id],
            'is_group': False,
            'removal_scope': 'all',
        }
        res = self.client.post(
            '/messaging/api/storage/batch-delete/',
            data=json.dumps(payload),
            content_type='application/json'
        )
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data['deleted_count'], 1)
        self.assertTrue(data['freed_bytes'] > 0)

        self.msg_img.refresh_from_db()
        self.assertTrue(self.msg_img.is_deleted_for_all)
        self.assertEqual(self.msg_img.message, 'This message has been deleted.')
