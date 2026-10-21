"""
Regression and security boundary tests for Sandesh 2.0 user services.
Covers:
- Avatar upload validation and dangerous file rejection
- Background avatar cleanup thread connection safety
- Profile avatar removal
- WebRTC SignalingConsumer preloaded profile resolution
- User session geolocation thread connection safety
"""

import io
from PIL import Image
from django.test import TestCase
from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection

from users.models import UserProfile, UserSession
from users.avatar_service import (
    upload_avatar,
    remove_avatar,
    _background_avatar_cleanup_worker,
    cleanup_user_avatar_history,
)
from users.signals import fetch_location
from messaging.file_security import validate_uploaded_file
from messaging.consumers import SignalingConsumer
from asgiref.sync import async_to_sync


def _make_test_image(filename="avatar.png", fmt="PNG", size=(64, 64), color="blue"):
    buf = io.BytesIO()
    img = Image.new("RGB", size, color=color)
    img.save(buf, format=fmt)
    buf.seek(0)
    return SimpleUploadedFile(filename, buf.read(), content_type=f"image/{fmt.lower()}")


class AvatarSecurityAndPersistenceTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="testuser", password="securepassword123")
        self.profile, _ = UserProfile.objects.get_or_create(user=self.user)

    def test_upload_avatar_empty_rejected(self):
        url, err = upload_avatar(self.user, None)
        self.assertIsNone(url)
        self.assertEqual(err, "No image file provided.")

    def test_upload_avatar_dangerous_extension_rejected(self):
        fake_exe = SimpleUploadedFile("payload.exe", b"MZ\x90\x00\x03fakeexe", content_type="application/octet-stream")
        url, err = upload_avatar(self.user, fake_exe)
        self.assertIsNone(url)
        self.assertIn("prohibited", err.lower())

    def test_upload_avatar_double_extension_rejected(self):
        fake_php = SimpleUploadedFile("exploit.php.jpg", b"\xff\xd8\xfffakeimage", content_type="image/jpeg")
        url, err = upload_avatar(self.user, fake_php)
        self.assertIsNone(url)
        self.assertIn("prohibited", err.lower())

    def test_upload_avatar_valid_image_local_persistence(self):
        valid_img = _make_test_image("avatar.png", "PNG")
        url, err = upload_avatar(self.user, valid_img)
        self.assertIsNone(err)
        self.assertIsNotNone(url)

        self.user.refresh_from_db()
        self.profile.refresh_from_db()
        self.assertTrue(bool(self.profile.profile_image_url))
        self.assertEqual(self.profile.avatar_url, self.profile.profile_image_url)

    def test_remove_avatar(self):
        valid_img = _make_test_image("avatar.png", "PNG")
        upload_avatar(self.user, valid_img)
        self.profile.refresh_from_db()
        self.assertTrue(bool(self.profile.profile_image_url))

        success, err = remove_avatar(self.user)
        self.assertTrue(success)
        self.assertIsNone(err)

        self.profile.refresh_from_db()
        self.assertEqual(self.profile.profile_image_url, "")
        self.assertFalse(bool(self.profile.avatar))

    def test_background_avatar_cleanup_worker_execution(self):
        # Must execute cleanly without unhandled exception and close DB connections
        _background_avatar_cleanup_worker(self.user.id)
        # Verify connection is valid and not leaked
        self.assertTrue(connection.is_usable())


class WebRTCSignalingResolutionTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="caller1", password="securepassword123")
        self.profile, _ = UserProfile.objects.get_or_create(user=self.user)

    def test_resolve_user_preloads_profile(self):
        consumer = SignalingConsumer()
        resolved = async_to_sync(consumer._resolve_user)(self.user.username)
        self.assertIsNotNone(resolved)
        self.assertEqual(resolved.username, self.user.username)
        # Profile must be pre-loaded in the cache to prevent synchronous queries in async loop
        self.assertIn('profile', resolved._state.fields_cache)
        self.assertEqual(resolved.profile.id, self.profile.id)

    def test_resolve_user_without_profile_safe(self):
        # Edge case: User without profile row does not crash getattr or resolve
        user_no_profile = User.objects.create_user(username="noprofile", password="pwd")
        UserProfile.objects.filter(user=user_no_profile).delete()
        consumer = SignalingConsumer()
        resolved = async_to_sync(consumer._resolve_user)(user_no_profile.username)
        self.assertIsNotNone(resolved)
        self.assertIsNone(getattr(resolved, 'profile', None))


class SessionGeolocationConnectionSafetyTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="sessionuser", password="securepassword123")
        self.session = UserSession.objects.create(
            user=self.user,
            session_key="test_session_key_12345",
            ip_address="127.0.0.1",
        )

    def test_fetch_location_local_network_and_connection_cleanup(self):
        fetch_location(self.session.id, "127.0.0.1")
        self.session.refresh_from_db()
        self.assertEqual(self.session.location, "Local Network")
        self.assertTrue(connection.is_usable())

    def test_fetch_location_handles_error_gracefully(self):
        # Invalid session ID should handle exception safely without crashing or leaking
        fetch_location(99999999, "8.8.8.8")
        self.assertTrue(connection.is_usable())


class SandeshTestRunnerTests(TestCase):
    def test_default_test_labels(self):
        from sdh.runner import SandeshTestRunner
        runner = SandeshTestRunner()
        suite = runner.build_suite([])
        self.assertGreater(suite.countTestCases(), 0)


class MomentUploadAndSessionSecurityTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="storyuser", password="securepassword123")
        self.profile, _ = UserProfile.objects.get_or_create(user=self.user)

    def test_session_security_middleware_localhost_retains_session_on_ua_change(self):
        from users.middleware import SessionSecurityMiddleware
        from django.test import RequestFactory
        factory = RequestFactory()
        middleware = SessionSecurityMiddleware(get_response=lambda req: None)

        # Initial request on desktop UA
        req1 = factory.get('/', HTTP_USER_AGENT='Desktop Chrome', REMOTE_ADDR='127.0.0.1')
        req1.user = self.user
        req1.session = self.client.session
        middleware.process_request(req1)
        self.assertTrue(req1.user.is_authenticated)

        # Subsequent request with emulated mobile device UA (e.g. Chrome DevTools device mode)
        req2 = factory.get('/', HTTP_USER_AGENT='Mobile Safari iPhone', REMOTE_ADDR='127.0.0.1')
        req2.user = self.user
        req2.session = req1.session
        middleware.process_request(req2)
        # User must remain authenticated in dev / localhost
        self.assertTrue(req2.user.is_authenticated)

    def test_upload_moment_unauthenticated_returns_401_json(self):
        resp = self.client.post('/messaging/api/moments/upload/', {'moment_type': 'text', 'text_content': 'Hello'})
        self.assertEqual(resp.status_code, 401)
        data = resp.json()
        self.assertEqual(data.get('status'), 'error')

    def test_upload_moment_authenticated_creates_moment(self):
        self.client.force_login(self.user)
        img = _make_test_image("story.png", "PNG")
        resp = self.client.post('/messaging/api/moments/upload/', {
            'moment_type': 'image',
            'media': img,
            'caption': 'Test Story',
        })
        self.assertEqual(resp.status_code, 201)
        data = resp.json()
        self.assertEqual(data.get('status'), 'ok')
        self.assertIn('moment', data)
