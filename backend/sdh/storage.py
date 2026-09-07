"""
Custom storage classes for Sandesh 2.0.
"""

import os
from cloudinary_storage.storage import MediaCloudinaryStorage, RESOURCE_TYPES


class SmartMediaCloudinaryStorage(MediaCloudinaryStorage):
    """
    Intelligently routes files to Cloudinary resource types based on file extension:
    - Images (jpg, png, gif, webp, etc.) -> 'image'
    - Videos (mp4, webm, mov, etc.) -> 'video'
    - Documents (pdf, doc, docx, txt, etc.), archives, audio -> 'raw'
    """

    def _get_resource_type(self, name):
        ext = (name.rsplit('.', 1)[-1] if '.' in name else '').lower()
        if ext in ('jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico'):
            return RESOURCE_TYPES['IMAGE']
        if ext in ('mp4', 'webm', 'ogg', 'mov', 'm4v', 'mkv'):
            return RESOURCE_TYPES['VIDEO']
        return RESOURCE_TYPES['RAW']
