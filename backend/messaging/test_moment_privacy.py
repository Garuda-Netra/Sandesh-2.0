import json
from django.test import TestCase, Client
from django.contrib.auth.models import User
from messaging.models import Moment, MomentPrivacySetting
from users.models import UserProfile, Friendship


class MomentPrivacyTestCase(TestCase):
    def setUp(self):
        self.client = Client()
        self.alice = User.objects.create_user(username='alice', password='password123')
        self.bob = User.objects.create_user(username='bob', password='password123')
        self.charlie = User.objects.create_user(username='charlie', password='password123')
        self.david = User.objects.create_user(username='david', password='password123')

        # Add friendships: Alice <-> Bob, Alice <-> Charlie, Alice <-> David
        Friendship.add_friendship(self.alice.profile, self.bob.profile)
        Friendship.add_friendship(self.alice.profile, self.charlie.profile)
        Friendship.add_friendship(self.alice.profile, self.david.profile)

    def test_moment_privacy_all(self):
        """Moments with privacy_type='all' are visible to all friends."""
        m = Moment.objects.create(
            user=self.alice,
            moment_type=Moment.MOMENT_TYPE_TEXT,
            text_content='Hello everyone!',
            privacy_type=Moment.PRIVACY_ALL
        )

        # Bob checks moments
        self.client.login(username='bob', password='password123')
        res = self.client.get('/messaging/api/moments/')
        self.assertEqual(res.status_code, 200)
        data = res.json()
        alice_moments = next((item for item in data['data'] if item['username'] == 'alice'), None)
        self.assertIsNotNone(alice_moments)
        self.assertEqual(alice_moments['moments'][0]['id'], m.id)

    def test_moment_privacy_exclude(self):
        """Moments with privacy_type='exclude' hide moment from excluded contacts."""
        # Alice excludes Bob
        m = Moment.objects.create(
            user=self.alice,
            moment_type=Moment.MOMENT_TYPE_TEXT,
            text_content='Secret from Bob',
            privacy_type=Moment.PRIVACY_EXCLUDE
        )
        m.privacy_users.add(self.bob)

        # Bob checks moments -> should NOT see it
        self.client.login(username='bob', password='password123')
        res = self.client.get('/messaging/api/moments/')
        self.assertEqual(res.status_code, 200)
        data = res.json()
        alice_moments = next((item for item in data['data'] if item['username'] == 'alice'), None)
        self.assertIsNone(alice_moments)

        # Charlie checks moments -> SHOULD see it
        self.client.login(username='charlie', password='password123')
        res = self.client.get('/messaging/api/moments/')
        self.assertEqual(res.status_code, 200)
        data = res.json()
        alice_moments = next((item for item in data['data'] if item['username'] == 'alice'), None)
        self.assertIsNotNone(alice_moments)
        self.assertEqual(alice_moments['moments'][0]['id'], m.id)

        # Bob tries to directly view excluded moment -> 403 Forbidden
        self.client.login(username='bob', password='password123')
        res = self.client.post(f'/messaging/api/moments/{m.id}/view/')
        self.assertEqual(res.status_code, 403)

    def test_moment_privacy_only(self):
        """Moments with privacy_type='only' are visible only to selected contacts."""
        # Alice only shares with Charlie
        m = Moment.objects.create(
            user=self.alice,
            moment_type=Moment.MOMENT_TYPE_TEXT,
            text_content='Only for Charlie',
            privacy_type=Moment.PRIVACY_ONLY
        )
        m.privacy_users.add(self.charlie)

        # Bob checks moments -> should NOT see it
        self.client.login(username='bob', password='password123')
        res = self.client.get('/messaging/api/moments/')
        self.assertEqual(res.status_code, 200)
        data = res.json()
        alice_moments = next((item for item in data['data'] if item['username'] == 'alice'), None)
        self.assertIsNone(alice_moments)

        # Charlie checks moments -> SHOULD see it
        self.client.login(username='charlie', password='password123')
        res = self.client.get('/messaging/api/moments/')
        self.assertEqual(res.status_code, 200)
        data = res.json()
        alice_moments = next((item for item in data['data'] if item['username'] == 'alice'), None)
        self.assertIsNotNone(alice_moments)
        self.assertEqual(alice_moments['moments'][0]['id'], m.id)

    def test_privacy_settings_api(self):
        """User can get and update default privacy settings via API."""
        self.client.login(username='alice', password='password123')

        # GET settings
        res = self.client.get('/messaging/api/moments/privacy/')
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data['privacy_type'], Moment.PRIVACY_ALL)
        self.assertEqual(len(data['friends']), 3)  # Bob, Charlie, David

        # POST update settings to 'exclude' Bob and Charlie
        payload = {
            'privacy_type': Moment.PRIVACY_EXCLUDE,
            'user_ids': [self.bob.id, self.charlie.id]
        }
        res = self.client.post(
            '/messaging/api/moments/privacy/',
            json.dumps(payload),
            content_type='application/json'
        )
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data['privacy_type'], Moment.PRIVACY_EXCLUDE)
        self.assertIn(self.bob.id, data['custom_user_ids'])
        self.assertIn(self.charlie.id, data['custom_user_ids'])

        # Now test uploading a moment without passing privacy_type:
        # It should automatically inherit Alice's default privacy setting!
        res = self.client.post(
            '/messaging/api/moments/upload/',
            {
                'moment_type': Moment.MOMENT_TYPE_TEXT,
                'text_content': 'Status with default settings'
            }
        )
        self.assertEqual(res.status_code, 201)
        created_moment = Moment.objects.filter(user=self.alice).first()
        self.assertEqual(created_moment.privacy_type, Moment.PRIVACY_EXCLUDE)
        self.assertEqual(created_moment.privacy_users.count(), 2)
