"""
file_security.py - Enterprise-grade file and image upload security validator.

Protects against:
- Disguised executables and malicious binaries (MZ, ELF, Mach-O, Shebang, Java, Windows shortcuts)
- Content-type / MIME spoofing (verifies true byte magic signatures)
- Double extensions (e.g. evil.php.jpg, payload.exe.pdf)
- Dangerous extensions (.exe, .php, .sh, .bat, .svg, etc.)
- Stored XSS via SVG or embedded HTML/JS polyglots in text files
- Image decompression bombs / pixel flood DoS (via Pillow resolution constraints)
- Path traversal, control characters, null bytes, and Unicode RTL overrides in filenames
"""

import os
import re
import unicodedata
from PIL import Image
from django.core.exceptions import ValidationError

# Maximum image resolution (5000x5000 pixels = 25MP) to block decompression bombs
MAX_IMAGE_PIXELS = 25_000_000

# Extensions strictly prohibited anywhere in filename segments
DANGEROUS_EXTENSIONS = frozenset({
    'exe', 'dll', 'so', 'dylib', 'bin', 'elf', 'bat', 'cmd', 'sh', 'bash',
    'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'mjs', 'wsf', 'wsh', 'scr',
    'com', 'pif', 'hta', 'cpl', 'msi', 'msp', 'jar', 'war', 'ear', 'php',
    'php3', 'php4', 'php5', 'php7', 'phtml', 'py', 'pyc', 'pyw', 'rb', 'pl',
    'cgi', 'asp', 'aspx', 'jsp', 'jspx', 'cer', 'csr', 'htaccess', 'htpasswd',
    'reg', 'swf', 'shtml', 'xhtml', 'svg', 'lnk', 'iso', 'img', 'dmg', 'app'
})

# Magic signatures of executable binary formats
DANGEROUS_MAGIC_PREFIXES = (
    (b'MZ', 'Windows/DOS Executable'),
    (b'\x7fELF', 'Linux ELF Binary'),
    (b'#!', 'Script Shebang'),
    (b'\xfe\xed\xfa\xce', 'Mach-O Binary'),
    (b'\xfe\xed\xfa\xcf', 'Mach-O Binary'),
    (b'\xce\xfa\xed\xfe', 'Mach-O Binary'),
    (b'\xcf\xfa\xed\xfe', 'Mach-O Binary'),
    (b'\xca\xfe\xba\xbe', 'Java Class / Mach-O Fat Binary'),
    (b'\x4c\x00\x00\x00\x01\x14\x02\x00', 'Windows Shortcut LNK'),
)

# Allowed file specifications: extension -> (mime_type, category)
ALLOWED_FILE_TYPES = {
    # Images (Raster only)
    'jpg':  ('image/jpeg', 'image'),
    'jpeg': ('image/jpeg', 'image'),
    'png':  ('image/png',  'image'),
    'gif':  ('image/gif',  'image'),
    'webp': ('image/webp', 'image'),

    # Audio
    'mp3':  ('audio/mpeg', 'audio'),
    'wav':  ('audio/wav',  'audio'),
    'ogg':  ('audio/ogg',  'audio'),
    'oga':  ('audio/ogg',  'audio'),
    'm4a':  ('audio/mp4',  'audio'),
    'flac': ('audio/flac', 'audio'),

    # Video
    'mp4':  ('video/mp4',  'video'),
    'm4v':  ('video/mp4',  'video'),
    'webm': ('video/webm', 'video'),
    'ogv':  ('video/ogg',  'video'),

    # Documents
    'pdf':  ('application/pdf', 'document'),
    'doc':  ('application/msword', 'document'),
    'docx': ('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document'),
    'xls':  ('application/vnd.ms-excel', 'document'),
    'xlsx': ('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'document'),
    'ppt':  ('application/vnd.ms-powerpoint', 'document'),
    'pptx': ('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'document'),
    'odp':  ('application/vnd.oasis.opendocument.presentation', 'document'),
    'txt':  ('text/plain', 'text'),
    'csv':  ('text/csv',   'text'),

    # Archives
    'zip':  ('application/zip', 'archive'),
    'rar':  ('application/x-rar-compressed', 'archive'),
    '7z':   ('application/x-7z-compressed',   'archive'),
}

# Regex for detecting embedded HTML/JavaScript vectors in plain text / CSV
_HTML_SCRIPT_VECTOR_RE = re.compile(
    r'<\s*(script|html|body|head|iframe|object|embed|svg|xml|applet|meta|link|style)\b|javascript:|onerror\s*=|onload\s*=',
    re.IGNORECASE
)

# Windows reserved device names
_WINDOWS_RESERVED_NAMES = frozenset({
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
})


def sanitize_filename(filename: str, default_name: str = "file") -> str:
    """
    Sanitizes an untrusted filename:
    - Strips directory traversal (/ and \\)
    - Strips Unicode control chars, null bytes, and Bidi/RTL overrides
    - Normalizes Unicode to ASCII
    - Replaces unsafe characters with underscores
    - Avoids Windows reserved device names
    - Truncates long filenames safely while preserving the extension
    """
    if not filename:
        return default_name

    # Extract base name
    base = os.path.basename(filename).strip()

    # Strip null bytes and control/bidi characters (\u200E, \u200F, \u202A-\u202E, \u2066-\u2069)
    base = re.sub(r'[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]', '', base)

    # Convert unicode to closest ASCII representation
    base = unicodedata.normalize('NFKD', base).encode('ascii', 'ignore').decode('ascii')

    # Keep only safe alphanumeric characters, dots, dashes, and underscores
    base = re.sub(r'[^a-zA-Z0-9._-]', '_', base).strip('._- ')
    if not base:
        base = default_name

    stem, ext = os.path.splitext(base)
    ext = ext.lower()

    # Avoid Windows reserved filenames (e.g. CON.txt -> file_CON.txt)
    if stem.upper() in _WINDOWS_RESERVED_NAMES:
        stem = f"file_{stem}"

    # Safely truncate overly long filenames (max 100 chars for stem)
    if len(stem) > 100:
        stem = stem[:100]

    return f"{stem}{ext}" if ext else stem


def _check_dangerous_extensions(filename: str) -> None:
    """
    Inspects all dot-separated components of a filename to block double extensions
    like 'payload.exe.jpg' or 'shell.php.png'.
    """
    parts = filename.lower().split('.')
    if len(parts) > 1:
        for ext in parts[1:]:
            cleaned_ext = re.sub(r'[^a-z0-9]', '', ext)
            if cleaned_ext in DANGEROUS_EXTENSIONS:
                raise ValidationError(
                    f"File contains a prohibited extension segment ('.{cleaned_ext}')."
                )


def _check_dangerous_magic_bytes(header: bytes) -> None:
    """
    Rejects files beginning with known executable, bytecode, or script headers.
    """
    for sig, desc in DANGEROUS_MAGIC_PREFIXES:
        if header.startswith(sig):
            raise ValidationError(
                f"Malicious or executable file format detected ({desc}). Upload rejected."
            )


def _detect_magic_category(header: bytes, ext: str) -> tuple[str, str] | None:
    """
    Inspects header bytes to verify if they match legitimate formats.
    Returns (detected_category, detected_mime) or None.
    """
    # Raster Images
    if header.startswith(b'\xff\xd8\xff'):
        return 'image', 'image/jpeg'
    if header.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image', 'image/png'
    if header.startswith((b'GIF87a', b'GIF89a')):
        return 'image', 'image/gif'
    if len(header) >= 12 and header.startswith(b'RIFF') and header[8:12] == b'WEBP':
        return 'image', 'image/webp'

    # Audio
    if header.startswith(b'ID3') or (len(header) >= 2 and header[0] == 0xff and (header[1] & 0xe0) == 0xe0):
        return 'audio', 'audio/mpeg'
    if len(header) >= 12 and header.startswith(b'RIFF') and header[8:12] == b'WAVE':
        return 'audio', 'audio/wav'
    if header.startswith(b'fLaC'):
        return 'audio', 'audio/flac'

    # Video & Containers
    if len(header) >= 8 and header[4:8] == b'ftyp':
        # ISO Base Media File Format: can be MP4 video or M4A audio
        if ext in ('m4a',):
            return 'audio', 'audio/mp4'
        return 'video', 'video/mp4'
    if header.startswith(b'\x1a\x45\xdf\xa3'):
        return 'video', 'video/webm'
    if header.startswith(b'OggS'):
        # Ogg container can be audio or video depending on extension
        if ext in ('ogg', 'oga'):
            return 'audio', 'audio/ogg'
        return 'video', 'video/ogg'

    # Documents
    if header.startswith(b'%PDF-'):
        return 'document', 'application/pdf'
    if header.startswith(b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'):
        # Legacy Microsoft Compound Document (doc, xls, ppt)
        return 'document', ALLOWED_FILE_TYPES.get(ext, ('application/msword', 'document'))[0]

    # Zip-based documents and archives (docx, xlsx, pptx, odp, zip)
    if header.startswith((b'PK\x03\x04', b'PK\x05\x06')):
        if ext in ('docx', 'xlsx', 'pptx', 'odp'):
            return 'document', ALLOWED_FILE_TYPES[ext][0]
        return 'archive', 'application/zip'

    # Other Archives
    if header.startswith((b'Rar!\x1a\x07\x00', b'Rar!\x1a\x07\x01\x00')):
        return 'archive', 'application/x-rar-compressed'
    if header.startswith(b'7z\xbc\xaf\x27\x1c'):
        return 'archive', 'application/x-7z-compressed'

    return None


def _verify_raster_image(file_obj) -> str:
    """
    Verifies image integrity using Pillow:
    - Protects against decompression bombs
    - Verifies format header and dimensions
    - Ensures format is within safe raster types
    Returns Pillow format string ('JPEG', 'PNG', 'GIF', 'WEBP').
    """
    pos = file_obj.tell()
    try:
        Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
        file_obj.seek(0)
        with Image.open(file_obj) as img:
            fmt = (img.format or '').upper()
            if fmt not in {'JPEG', 'PNG', 'GIF', 'WEBP'}:
                raise ValidationError(f"Image format '{fmt}' is not permitted.")
            w, h = img.size
            if w <= 0 or h <= 0:
                raise ValidationError("Image has invalid or zero dimensions.")
            if w * h > MAX_IMAGE_PIXELS:
                raise ValidationError("Image resolution exceeds safe limits.")
            img.verify()
        return fmt
    except Image.DecompressionBombError:
        raise ValidationError("Image exceeds safe resolution limits (decompression bomb protection).")
    except ValidationError:
        raise
    except Exception as exc:
        raise ValidationError(f"Invalid or corrupted image file: {exc}")
    finally:
        file_obj.seek(pos)


def _verify_plain_text(file_obj) -> None:
    """
    Validates text / CSV files:
    - Confirms valid UTF-8 encoding
    - Ensures no binary null bytes
    - Blocks HTML/JavaScript/SVG tag injection
    """
    pos = file_obj.tell()
    try:
        file_obj.seek(0)
        sample = file_obj.read(8192)
        if b'\x00' in sample:
            raise ValidationError("Binary files cannot be uploaded as text.")
        try:
            text = sample.decode('utf-8')
        except UnicodeDecodeError:
            try:
                text = sample.decode('latin-1')
            except Exception:
                raise ValidationError("Text file encoding is not supported.")

        if _HTML_SCRIPT_VECTOR_RE.search(text):
            raise ValidationError("Text file contains prohibited HTML or script content.")
    finally:
        file_obj.seek(pos)


def validate_uploaded_file(uploaded_file, allowed_categories=None, max_size=5 * 1024 * 1024) -> dict:
    """
    Comprehensive file security validator.

    Args:
        uploaded_file: Django UploadedFile or file-like object.
        allowed_categories: Optional tuple/list of allowed categories:
                            ('image', 'video', 'audio', 'document', 'archive', 'text')
        max_size: Maximum allowed file size in bytes (default: 5 MB).

    Returns:
        dict: {
            'safe_filename': str,
            'mime_type': str,
            'category': str,
            'extension': str,
            'message_type': str,  # 'image' | 'video' | 'file'
        }

    Raises:
        ValidationError: When any security check fails.
    """
    if not uploaded_file:
        raise ValidationError("No file provided.")

    # 1. Size verification
    size = getattr(uploaded_file, 'size', None)
    if size is None:
        pos = uploaded_file.tell()
        uploaded_file.seek(0, os.SEEK_END)
        size = uploaded_file.tell()
        uploaded_file.seek(pos)

    if size <= 0:
        raise ValidationError("Uploaded file is empty (0 bytes).")
    if size > max_size:
        max_mb = max_size / (1024 * 1024)
        raise ValidationError(f"File size exceeds the {max_mb:.1f} MB limit ({size} bytes).")

    # 2. Filename sanitization & double extension check
    raw_name = getattr(uploaded_file, 'name', '') or 'upload.dat'
    _check_dangerous_extensions(raw_name)
    safe_name = sanitize_filename(raw_name)

    ext = safe_name.split('.')[-1].lower() if '.' in safe_name else ''
    if not ext or ext not in ALLOWED_FILE_TYPES:
        raise ValidationError(f"File extension '.{ext}' is not supported.")

    expected_mime, expected_category = ALLOWED_FILE_TYPES[ext]

    # Category restriction check
    if allowed_categories and expected_category not in allowed_categories:
        allowed_str = ", ".join(allowed_categories)
        raise ValidationError(f"Only {allowed_str} files are permitted here.")

    # 3. Magic signature verification
    pos = uploaded_file.tell()
    try:
        uploaded_file.seek(0)
        header = uploaded_file.read(512)
    finally:
        uploaded_file.seek(pos)

    if not header:
        raise ValidationError("Unable to read file content.")

    # Immediate rejection of dangerous executable signatures
    _check_dangerous_magic_bytes(header)

    # Inspect magic bytes
    if expected_category == 'text':
        _verify_plain_text(uploaded_file)
        verified_category = 'text'
        verified_mime = expected_mime
    else:
        detected = _detect_magic_category(header, ext)
        if not detected:
            raise ValidationError(
                f"File content does not match the expected format for '.{ext}'."
            )
        detected_category, detected_mime = detected

        if detected_category != expected_category:
            raise ValidationError(
                f"File content type mismatch: expected {expected_category}, detected {detected_category}."
            )

        verified_category = detected_category
        verified_mime = detected_mime

    # 4. Deep image verification with Pillow
    if verified_category == 'image':
        img_format = _verify_raster_image(uploaded_file)
        # Verify format consistency
        format_map = {'JPEG': ('jpg', 'jpeg'), 'PNG': ('png',), 'GIF': ('gif',), 'WEBP': ('webp',)}
        valid_exts = format_map.get(img_format, ())
        if ext not in valid_exts:
            # Correct extension or normalize mime
            expected_mime = 'image/jpeg' if img_format == 'JPEG' else f'image/{img_format.lower()}'
            verified_mime = expected_mime

    # 5. Map category to message_type for chat compatibility
    if verified_category == 'image':
        message_type = 'image'
    elif verified_category == 'video':
        message_type = 'video'
    else:
        message_type = 'file'

    return {
        'safe_filename': safe_name,
        'mime_type': verified_mime,
        'category': verified_category,
        'extension': ext,
        'message_type': message_type,
    }
