"""
Custom storage classes for Sandesh 2.0.
"""

from cloudinary_storage.storage import MediaCloudinaryStorage, RESOURCE_TYPES


class SmartMediaCloudinaryStorage(MediaCloudinaryStorage):
    """
    Intelligently routes files to Cloudinary resource types based on file extension:
    - Images (jpg, png, gif, webp, etc.) -> 'image'
    - Videos (mp4, webm, mov, etc.) -> 'video'
    - Documents (pdf, doc, docx, txt, etc.), archives, audio -> 'raw'
    """

    def _get_resource_type(self, name):
        name_str = str(name or '')
        ext = (name_str.rsplit('.', 1)[-1] if '.' in name_str else '').lower()
        if ext in ('jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico', 'heic', 'heif', 'svg'):
            return RESOURCE_TYPES['IMAGE']
        if ext in ('mp4', 'webm', 'ogg', 'mov', 'm4v', 'mkv'):
            return RESOURCE_TYPES['VIDEO']
        if ext in ('pdf', 'doc', 'docx', 'txt', 'zip', 'tar', 'gz', 'mp3', 'wav', 'aac', 'm4a', 'flac'):
            return RESOURCE_TYPES['RAW']
        # If name has no extension (e.g. Cloudinary public_id stored without extension):
        # Inspect folder/path hints:
        name_lower = name_str.lower()
        if any(v in name_lower for v in ('video', 'videos')):
            return RESOURCE_TYPES['VIDEO']
        if any(r in name_lower for r in ('song', 'audio', 'doc', 'file', 'attachment')):
            return RESOURCE_TYPES['RAW']
        # Default for all media (moments, avatars, photos) in a media storage class is IMAGE:
        return RESOURCE_TYPES['IMAGE']
