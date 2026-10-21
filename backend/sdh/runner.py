"""
Custom test runner for Sandesh 2.0.

Ensures default 'manage.py test' command reliably discovers all project tests
when invoked from the repository root without duplicate discovery or extra arguments.
"""

from django.test.runner import DiscoverRunner


class SandeshTestRunner(DiscoverRunner):
    """
    Project test runner ensuring test discovery defaults to local project apps
    ('users', 'messaging') when no test labels are passed.
    """

    def build_suite(self, test_labels=None, **kwargs):
        if not test_labels:
            test_labels = ['users', 'messaging']
        return super().build_suite(test_labels=test_labels, **kwargs)
