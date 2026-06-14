"""
SDH (SANDESH) - Django Settings
Production-ready configuration with Django Channels support.

Environment variables (via python-decouple):
  SECRET_KEY, DEBUG, ALLOWED_HOSTS, DATABASE_URL, REDIS_URL,
  CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET,
    TURN_SERVER_URL, TURN_SERVER_USERNAME, TURN_SERVER_CREDENTIAL,
    CHATBOT_PROVIDER, CHATBOT_OPENAI_API_KEY, CHATBOT_OPENAI_BASE_URL,
    CHATBOT_MODEL, CHATBOT_TEMPERATURE, CHATBOT_MAX_TOKENS, CHATBOT_SYSTEM_PROMPT
"""

import os
import json
from pathlib import Path
from decouple import Config, RepositoryEnv, Csv
import dj_database_url

# ---------------------------------------------------------------------------
# Base Directories
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------------------
# Configuration (python-decouple)
# ---------------------------------------------------------------------------
# Point to .env in the project root (one level above BASE_DIR)
env_path = BASE_DIR.parent / '.env'
if env_path.exists():
    config = Config(RepositoryEnv(str(env_path)))
else:
    from decouple import config # fallback to default behavior

# ---------------------------------------------------------------------------
# Security
# ---------------------------------------------------------------------------
SECRET_KEY = config(
    'SECRET_KEY',
    default='django-insecure-sdh-sandesh-change-this-in-production-!!!'
)

DEBUG = config('DEBUG', default=True, cast=bool)

ALLOWED_HOSTS = config('ALLOWED_HOSTS', default='localhost,127.0.0.1', cast=Csv())

# ---------------------------------------------------------------------------
# Application Definition
# ---------------------------------------------------------------------------
INSTALLED_APPS = [
    'daphne',                          # Must be first for ASGI
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',

    # Third-party
    'channels',
    'corsheaders',
    'cloudinary_storage',
    'cloudinary',

    # Local apps
    'users.apps.UsersConfig',
    'messaging.apps.MessagingConfig',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',         # Static files in prod
    'corsheaders.middleware.CorsMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'users.middleware.SessionSecurityMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'sdh.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [BASE_DIR.parent / 'frontend' / 'templates'],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
                'users.context_processors.firebase_config',
            ],
        },
    },
]

# ---------------------------------------------------------------------------
# ASGI / Django Channels
# ---------------------------------------------------------------------------
ASGI_APPLICATION = 'sdh.asgi.application'

WSGI_APPLICATION = 'sdh.wsgi.application'

# Channel layers — use Redis in production, in-memory for development
_REDIS_URL = config('REDIS_URL', default='')

if _REDIS_URL:
    CHANNEL_LAYERS = {
        'default': {
            'BACKEND': 'channels_redis.core.RedisChannelLayer',
            'CONFIG': {
                'hosts': [_REDIS_URL],
            },
        },
    }
    CACHES = {
        'default': {
            'BACKEND': 'django.core.cache.backends.redis.RedisCache',
            'LOCATION': _REDIS_URL,
        }
    }
else:
    CHANNEL_LAYERS = {
        'default': {
            'BACKEND': 'channels.layers.InMemoryChannelLayer',
        },
    }
    CACHES = {
        'default': {
            'BACKEND': 'django.core.cache.backends.locmem.LocMemCache',
            'LOCATION': 'sdh-presence-cache',
        }
    }

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
# Reads DATABASE_URL env var. Falls back to SQLite for local development.
DATABASES = {
    'default': dj_database_url.config(
        default=f"sqlite:///{BASE_DIR / 'db.sqlite3'}",
        conn_max_age=600,
        conn_health_checks=True,
    )
}

# ---------------------------------------------------------------------------
# Password Validation
# ---------------------------------------------------------------------------
AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

# ---------------------------------------------------------------------------
# Internationalization
# ---------------------------------------------------------------------------
LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True

# ---------------------------------------------------------------------------
# Static & Media Files
# ---------------------------------------------------------------------------
STATIC_URL = '/static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'
STATICFILES_DIRS = [BASE_DIR.parent / 'frontend' / 'static']

MEDIA_URL = '/media/'
MEDIA_ROOT = BASE_DIR / 'media'

# ---------------------------------------------------------------------------
# Cloudinary Configuration (Media/File Storage)
# ---------------------------------------------------------------------------
_CLOUDINARY_CLOUD_NAME = config('CLOUDINARY_CLOUD_NAME', default='')
_CLOUDINARY_API_KEY = config('CLOUDINARY_API_KEY', default='')
_CLOUDINARY_API_SECRET = config('CLOUDINARY_API_SECRET', default='')

if _CLOUDINARY_CLOUD_NAME and _CLOUDINARY_API_KEY and _CLOUDINARY_API_SECRET:
    # Production: use Cloudinary for user-uploaded files
    CLOUDINARY_STORAGE = {
        'CLOUD_NAME': _CLOUDINARY_CLOUD_NAME,
        'API_KEY': _CLOUDINARY_API_KEY,
        'API_SECRET': _CLOUDINARY_API_SECRET,
    }

    STORAGES = {
        'default': {
            'BACKEND': 'cloudinary_storage.storage.MediaCloudinaryStorage',
        },
        'staticfiles': {
            'BACKEND': 'whitenoise.storage.CompressedManifestStaticFilesStorage',
        },
    }
else:
    # Local development: use filesystem storage
    STORAGES = {
        'default': {
            'BACKEND': 'django.core.files.storage.FileSystemStorage',
        },
        'staticfiles': {
            'BACKEND': 'whitenoise.storage.CompressedManifestStaticFilesStorage',
        },
    }

# ---------------------------------------------------------------------------
# TURN Server Configuration (WebRTC Voice/Video Calls)
# ---------------------------------------------------------------------------
# These are passed to the frontend via a template context processor
# so webrtc.js can include TURN credentials in its ICE server list.
TURN_SERVER_URL = config('TURN_SERVER_URL', default='')
TURN_SERVER_USERNAME = config('TURN_SERVER_USERNAME', default='')
TURN_SERVER_CREDENTIAL = config('TURN_SERVER_CREDENTIAL', default='')

# ---------------------------------------------------------------------------
# Chatbot Configuration
# ---------------------------------------------------------------------------
CHATBOT_PROVIDER = config('CHATBOT_PROVIDER', default='local')
CHATBOT_OPENAI_API_KEY = config('CHATBOT_OPENAI_API_KEY', default='')
CHATBOT_OPENAI_BASE_URL = config('CHATBOT_OPENAI_BASE_URL', default='https://api.openai.com/v1')
CHATBOT_MODEL = config('CHATBOT_MODEL', default='gpt-4o-mini')
CHATBOT_TEMPERATURE = config('CHATBOT_TEMPERATURE', default=0.7, cast=float)
CHATBOT_MAX_TOKENS = config('CHATBOT_MAX_TOKENS', default=500, cast=int)
CHATBOT_SYSTEM_PROMPT = config('CHATBOT_SYSTEM_PROMPT', default='')

# ---------------------------------------------------------------------------
# Spotify Configuration
# ---------------------------------------------------------------------------
SPOTIFY_CLIENT_ID = config('SPOTIFY_CLIENT_ID', default='')
SPOTIFY_CLIENT_SECRET = config('SPOTIFY_CLIENT_SECRET', default='')

# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------
LOGIN_URL = '/login/'
LOGIN_REDIRECT_URL = '/messaging/chat/'
LOGOUT_REDIRECT_URL = '/'

FIREBASE_API_KEY = config('FIREBASE_API_KEY', default='')
FIREBASE_AUTH_DOMAIN = config('FIREBASE_AUTH_DOMAIN', default='')
FIREBASE_PROJECT_ID = config('FIREBASE_PROJECT_ID', default='')
FIREBASE_APP_ID = config('FIREBASE_APP_ID', default='')
FIREBASE_CREDENTIALS = config('FIREBASE_CREDENTIALS', default='firebase-key.json')

AUTH_USER_MODEL = 'auth.User'

AUTHENTICATION_BACKENDS = [
    'users.backends.EmailPhoneUsernameBackend',
    'django.contrib.auth.backends.ModelBackend',
]

# ---------------------------------------------------------------------------
# Session
# ---------------------------------------------------------------------------
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = 'Lax'
SESSION_EXPIRE_AT_BROWSER_CLOSE = True
CSRF_COOKIE_HTTPONLY = False       # JS needs CSRF token
CSRF_COOKIE_SAMESITE = 'Lax'

# ---------------------------------------------------------------------------
# CSRF Trusted Origins (required for Railway/Render behind proxy)
# ---------------------------------------------------------------------------
CSRF_TRUSTED_ORIGINS = config(
    'CSRF_TRUSTED_ORIGINS',
    default='http://localhost:8000,http://127.0.0.1:8000',
    cast=Csv()
)

# ---------------------------------------------------------------------------
# Security Headers (tighten for production)
# ---------------------------------------------------------------------------
SECURE_BROWSER_XSS_FILTER = True
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = 'DENY'
SECURE_REFERRER_POLICY = 'same-origin'

if not DEBUG:
    SECURE_HSTS_SECONDS = 31536000
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_SSL_REDIRECT = True
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')

# ---------------------------------------------------------------------------
# CORS (optional — for API use)
# ---------------------------------------------------------------------------
CORS_ALLOWED_ORIGINS = config(
    'CORS_ALLOWED_ORIGINS',
    default='http://localhost:8000,http://127.0.0.1:8000',
    cast=Csv()
)

# ---------------------------------------------------------------------------
# File Upload Limits
# ---------------------------------------------------------------------------
DATA_UPLOAD_MAX_MEMORY_SIZE = 10 * 1024 * 1024   # 10 MB
FILE_UPLOAD_MAX_MEMORY_SIZE = 10 * 1024 * 1024   # 10 MB

# ---------------------------------------------------------------------------
# Default Primary Key
# ---------------------------------------------------------------------------
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {
        'verbose': {
            'format': '[{asctime}] {levelname} {name}: {message}',
            'style': '{',
        },
    },
    'handlers': {
        'console': {
            'class': 'logging.StreamHandler',
            'formatter': 'verbose',
        },
    },
    'root': {
        'handlers': ['console'],
        'level': 'INFO',
    },
    'loggers': {
        'django': {
            'handlers': ['console'],
            'level': config('DJANGO_LOG_LEVEL', default='INFO'),
            'propagate': False,
        },
    },
}
