import os
import logging
import firebase_admin
from firebase_admin import credentials
from django.conf import settings

logger = logging.getLogger(__name__)

def initialize_firebase():
    """
    Initializes the Firebase Admin SDK using the configured FIREBASE_CREDENTIALS.
    This call is idempotent.
    """
    if not firebase_admin._apps:
        cred_path = getattr(settings, 'FIREBASE_CREDENTIALS', '')
        if cred_path:
            # If path is relative, resolve it relative to BASE_DIR
            if not os.path.isabs(cred_path):
                possible_paths = [
                    os.path.join(settings.BASE_DIR.parent, cred_path),
                    os.path.join(settings.BASE_DIR, cred_path),
                    cred_path
                ]
                for p in possible_paths:
                    if os.path.exists(p):
                        cred_path = p
                        break

            if os.path.exists(cred_path):
                try:
                    cred = credentials.Certificate(cred_path)
                    firebase_admin.initialize_app(cred)
                    logger.info("Firebase Admin SDK successfully initialized.")
                except Exception as e:
                    logger.error(f"Error initializing Firebase Admin SDK with credentials file: {e}")
            else:
                logger.warning(f"Firebase credentials file not found at {cred_path}. Authentication backend will fail if used.")
        else:
            logger.warning("FIREBASE_CREDENTIALS is not set in settings. Firebase Admin SDK not initialized.")
