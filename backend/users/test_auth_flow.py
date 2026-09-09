from django.test import TestCase, Client
from django.contrib.auth.models import User
from django.urls import reverse
from users.models import UserProfile


class AuthFlowTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.user = User.objects.create_user(username='authtestuser', password='Password123!', email='authtest@example.com')
        self.profile = self.user.profile
        self.profile.is_online = True
        self.profile.save()

    def test_logout_marks_offline_and_clears_session(self):
        self.client.login(username='authtestuser', password='Password123!')
        response = self.client.get(reverse('users:logout'))
        self.assertEqual(response.status_code, 302)
        self.assertIn(reverse('users:index'), response.url)

        # Profile is marked offline
        self.profile.refresh_from_db()
        self.assertFalse(self.profile.is_online)

        # Session is invalidated
        self.assertNotIn('_auth_user_id', self.client.session)

    def test_logout_with_next_redirect(self):
        self.client.login(username='authtestuser', password='Password123!')
        response = self.client.get(reverse('users:logout') + '?next=/login/')
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.url, '/login/')

    def test_login_page_renders_cleanly(self):
        response = self.client.get(reverse('users:login'))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'Sign in to')
        self.assertContains(response, 'Sign in with Google')
