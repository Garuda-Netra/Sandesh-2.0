"""
avatar_service.py - Professional Avatar & Profile Image Management Service

Handles:
- Uploading and persisting avatars to Cloudinary (or fallback local storage).
- Immediate synchronous deletion of previous avatars when a new avatar is set,
  guaranteeing that ONLY the current image stays under the user.
- Removal of avatars (destroying Cloudinary assets and local files).
- Scheduled cleanup of orphaned / historical avatars.
"""

import os
import time
import logging
from django.conf import settings
from django.core.exceptions import ValidationError
from messaging.file_security import validate_uploaded_file

logger = logging.getLogger(__name__)


def is_cloudinary_configured() -> bool:
    """
    Checks if Cloudinary credentials are fully configured and ready to use.
    """
    cloud_name = getattr(settings, '_CLOUDINARY_CLOUD_NAME', '')
    api_key = getattr(settings, '_CLOUDINARY_API_KEY', '')
    api_secret = getattr(settings, '_CLOUDINARY_API_SECRET', '')
    return bool(cloud_name and api_key and api_secret)


def _init_cloudinary():
    """
    Initializes the Cloudinary SDK with configured credentials.
    """
    if is_cloudinary_configured():
        import cloudinary
        cloudinary.config(
            cloud_name=settings._CLOUDINARY_CLOUD_NAME,
            api_key=settings._CLOUDINARY_API_KEY,
            api_secret=settings._CLOUDINARY_API_SECRET,
            secure=True
        )


def upload_avatar(user, file_obj):
    """
    Validates, uploads, and durably persists a new profile avatar for the given user.
    Immediately deletes the previous avatar from Cloudinary and local storage,
    ensuring only the current active image stays under the user.

    Args:
        user: Django User instance.
        file_obj: UploadedFile or file-like object.

    Returns:
        tuple: (avatar_url: str, error_message: str or None)
    """
    if not file_obj:
        return None, "No image file provided."

    # 1. Rigorous security validation (mime, extension, magic bytes, dimensions, bomb protection)
    try:
        validate_uploaded_file(
            file_obj,
            allowed_categories=('image',),
            max_size=5 * 1024 * 1024
        )
    except ValidationError as exc:
        msg = exc.message if hasattr(exc, 'message') else str(exc)
        return None, msg
    except Exception as exc:
        return None, f"Image validation failed: {exc}"

    profile = user.profile
    old_public_id = profile.avatar_public_id
    old_local_file = profile.avatar

    # 2. Upload to Cloudinary if configured (Production / Persistent Cloud Storage)
    if is_cloudinary_configured():
        import cloudinary
        import cloudinary.uploader
        _init_cloudinary()

        try:
            file_obj.seek(0)
            timestamp = int(time.time())
            folder = f"sandesh/avatars/user_{user.id}"
            public_id = f"{folder}/avatar_{timestamp}"

            upload_result = cloudinary.uploader.upload(
                file_obj,
                public_id=public_id,
                overwrite=True,
                resource_type="image",
                transformation=[
                    {'width': 500, 'height': 500, 'crop': 'limit'},
                    {'quality': 'auto'},
                    {'fetch_format': 'auto'}
                ]
            )

            new_url = upload_result.get('secure_url') or upload_result.get('url')
            new_public_id = upload_result.get('public_id')

            if not new_url:
                raise Exception("Cloudinary did not return a valid URL.")

            # Automatically delete the previous image from Cloudinary
            if old_public_id and old_public_id != new_public_id:
                try:
                    cloudinary.uploader.destroy(old_public_id)
                    logger.info("Deleted previous Cloudinary avatar %s for user %s", old_public_id, user.username)
                except Exception as del_err:
                    logger.warning("Could not delete old Cloudinary avatar %s: %s", old_public_id, del_err)

            # Clean up old local file if present
            if old_local_file:
                try:
                    old_local_file.delete(save=False)
                except Exception:
                    pass

            # Save permanent URL and public_id into UserProfile schema, clearing local avatar field
            profile.profile_image_url = new_url
            profile.avatar_public_id = new_public_id
            profile.avatar = None
            profile.save(update_fields=['profile_image_url', 'avatar_public_id', 'avatar'])

            logger.info("Successfully updated avatar for user %s to Cloudinary: %s", user.username, new_url)

            # Trigger background sweep to ensure only current image remains in the user's Cloudinary folder
            import threading
            threading.Thread(target=_background_avatar_cleanup_worker, args=(user.id,), daemon=True).start()

            return profile.avatar_url, None

        except Exception as cloud_err:
            logger.error("Cloudinary upload failed for user %s: %s", user.username, cloud_err, exc_info=True)
            # Fall through to local storage if Cloudinary fails unexpectedly

    # 3. Fallback to local storage (Development or Cloudinary offline)
    try:
        # Delete old local file if present
        if old_local_file:
            try:
                old_local_file.delete(save=False)
            except Exception:
                pass

        file_obj.seek(0)
        profile.avatar = file_obj
        profile.avatar_public_id = ''
        profile.save()
        profile.profile_image_url = profile.avatar.url
        profile.save(update_fields=['profile_image_url', 'avatar_public_id'])

        logger.info("Saved local avatar for user %s: %s", user.username, profile.avatar.url)
        return profile.avatar_url, None

    except Exception as loc_err:
        logger.error("Local avatar save failed for user %s: %s", user.username, loc_err, exc_info=True)
        return None, f"Failed to save avatar image: {loc_err}"


def remove_avatar(user):
    """
    Completely removes the user's avatar from Cloudinary, local filesystem, and the database.
    Reverts the user to default avatar.

    Returns:
        tuple: (success: bool, error_message: str or None)
    """
    profile = getattr(user, 'profile', None)
    if not profile:
        return False, "User profile not found."

    # 1. Destroy Cloudinary asset
    if profile.avatar_public_id and is_cloudinary_configured():
        import cloudinary.uploader
        _init_cloudinary()
        try:
            cloudinary.uploader.destroy(profile.avatar_public_id)
            logger.info("Destroyed Cloudinary avatar %s for user %s", profile.avatar_public_id, user.username)
        except Exception as e:
            logger.warning("Error destroying Cloudinary avatar %s: %s", profile.avatar_public_id, e)

    # 2. Delete local file
    if profile.avatar:
        try:
            profile.avatar.delete(save=False)
        except Exception as e:
            logger.warning("Error deleting local avatar for user %s: %s", user.username, e)

    # 3. Clear database fields
    profile.profile_image_url = ''
    profile.avatar_public_id = ''
    profile.avatar = None
    profile.save(update_fields=['profile_image_url', 'avatar_public_id', 'avatar'])

    return True, None


def _background_avatar_cleanup_worker(user_id: int) -> None:
    """
    Background worker run in a detached daemon thread to purge orphaned avatar assets.
    Explicitly closes thread-local database connections on entry and exit to prevent connection leaks.
    """
    from django.db import close_old_connections, connections
    close_old_connections()
    try:
        from django.contrib.auth.models import User
        user = User.objects.filter(id=user_id).first()
        if user:
            cleanup_user_avatar_history(user)
    except Exception as exc:
        logger.warning("Background avatar cleanup failed for user_id=%s: %s", user_id, exc)
    finally:
        connections.close_all()


def cleanup_user_avatar_history(user) -> int:
    """
    Cleans up any orphaned or historical avatar images under this user's Cloudinary folder
    or local directory, ensuring only the single active avatar is retained.

    Returns:
        int: Number of old files/assets purged.
    """
    profile = getattr(user, 'profile', None)
    if not profile:
        return 0

    purged_count = 0
    current_public_id = profile.avatar_public_id

    # 1. Clean Cloudinary folder
    if is_cloudinary_configured():
        import cloudinary.api
        import cloudinary.uploader
        _init_cloudinary()
        try:
            prefix = f"sandesh/avatars/user_{user.id}/"
            res = cloudinary.api.resources(
                type="upload",
                prefix=prefix,
                max_results=100
            )
            for item in res.get('resources', []):
                pub_id = item.get('public_id')
                if pub_id and pub_id != current_public_id:
                    cloudinary.uploader.destroy(pub_id)
                    purged_count += 1
                    logger.info("Purged historical Cloudinary avatar: %s", pub_id)
        except Exception as e:
            logger.warning("Error during Cloudinary avatar cleanup for user %s: %s", user.username, e)

    # 2. Clean local directory
    try:
        avatars_dir = os.path.join(settings.MEDIA_ROOT, 'avatars')
        if os.path.exists(avatars_dir):
            current_name = profile.avatar.name if profile.avatar else ''
            user_patterns = (f"user_{user.id}_", f"{user.username}_", f"{user.username}.")
            for fname in os.listdir(avatars_dir):
                if any(fname.startswith(p) for p in user_patterns):
                    rel_name = f"avatars/{fname}"
                    if rel_name != current_name:
                        full_p = os.path.join(avatars_dir, fname)
                        try:
                            if os.path.isfile(full_p):
                                os.remove(full_p)
                                purged_count += 1
                                logger.info("Purged historical local avatar: %s", rel_name)
                        except Exception:
                            pass
    except Exception as e:
        logger.warning("Error during local avatar cleanup for user %s: %s", user.username, e)

    return purged_count


def cleanup_all_orphaned_avatars() -> dict:
    """
    Sweeps across all registered users and deletes historical / orphaned avatars.
    Ensures database connections are safely closed when executed in a background thread.
    """
    from django.db import close_old_connections, connections
    close_old_connections()
    from django.contrib.auth.models import User
    total_purged = 0
    users_processed = 0

    try:
        for u in User.objects.all().iterator():
            try:
                count = cleanup_user_avatar_history(u)
                total_purged += count
                users_processed += 1
            except Exception as e:
                logger.error("Error cleaning avatars for user %s: %s", u.username, e)
    finally:
        connections.close_all()

    return {
        'users_processed': users_processed,
        'assets_purged': total_purged
    }
