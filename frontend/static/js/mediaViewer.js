/**
 * SDH – Universal Media Viewer & Lightbox Module
 * ===============================================
 * Provides a high-fidelity popup modal for previewing images, videos, PDFs,
 * audio, and generic files sent across Sandesh 2.0 chats.
 *
 * Features:
 *  - Instant zero-latency display via blob caching
 *  - Interactive Image Lightbox (zoom in/out, wheel zoom, double-click toggle, pan/drag)
 *  - Fullscreen HTML5 Video Player with auto-play and audio stop on close
 *  - Embedded high-res PDF Viewer with "Open in New Tab" & direct download
 *  - Audio Player with wave visualizer
 *  - Keyboard shortcuts (Esc to close, +/-/0 to zoom)
 *  - Safe fallback for unsupported document types
 */

'use strict';

window.SDH = window.SDH || {};

SDH.MediaViewer = (() => {

  // ── State ─────────────────────────────────────────────────────────────────
  const blobCache = new Map(); // fileId -> { blob, blobUrl, mimeType, fileName }
  let activeMedia = null;      // Current open media descriptor
  let currentZoom = 1.0;
  let panX = 0;
  let panY = 0;
  let isDragging = false;
  let startDragX = 0;
  let startDragY = 0;
  let hasMoved = false;

  // ── DOM References ────────────────────────────────────────────────────────
  let modalEl, headerEl, titleEl, metaEl, typeIconEl, zoomControlsEl, zoomLevelEl;
  let viewportEl, containerEl, spinnerEl, errorEl, errorMsgEl, openTabBtnEl, downloadBtnEl;

  function _ensureElements() {
    modalEl        = document.getElementById('mediaPreviewModal');
    headerEl       = document.getElementById('mpHeader');
    titleEl        = document.getElementById('mpFileName');
    metaEl         = document.getElementById('mpMetaText');
    typeIconEl     = document.getElementById('mpTypeIcon');
    zoomControlsEl = document.getElementById('mpZoomControls');
    zoomLevelEl    = document.getElementById('mpZoomLevel');
    viewportEl     = document.getElementById('mpViewport');
    containerEl    = document.getElementById('mpContentContainer');
    spinnerEl      = document.getElementById('mpSpinner');
    errorEl        = document.getElementById('mpError');
    errorMsgEl     = document.getElementById('mpErrorMsg');
    openTabBtnEl   = document.getElementById('mpOpenTabBtn');
    downloadBtnEl  = document.getElementById('mpDownloadBtn');
  }

  // ── Helper: Download URL ──────────────────────────────────────────────────
  function _downloadUrl(fileId) {
    const base = window.SDH_DATA?.downloadFileUrl || '/messaging/download-file/';
    return `${base}${fileId}/`;
  }

  function _escape(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Helper: Determine Media Category ──────────────────────────────────────
  function _detectCategory(mimeType, fileName, messageType) {
    const mime = (mimeType || '').toLowerCase();
    const name = (fileName || '').toLowerCase();

    if (messageType === 'image' || mime.startsWith('image/') || /\.(jpe?g|png|gif|webp|svg|bmp|ico)$/i.test(name)) {
      return 'image';
    }
    if (messageType === 'video' || mime.startsWith('video/') || /\.(mp4|webm|ogg|mov|m4v|mkv)$/i.test(name)) {
      return 'video';
    }
    if (mime === 'application/pdf' || name.endsWith('.pdf')) {
      return 'pdf';
    }
    if (mime.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(name)) {
      return 'audio';
    }
    if (mime.startsWith('text/') || /\.(txt|json|csv|log|md|html|css|js|py)$/i.test(name)) {
      return 'text';
    }
    return 'file';
  }

  // ── Cache Management ──────────────────────────────────────────────────────
  function cacheBlob(fileId, blob, mimeType, fileName) {
    if (!fileId || !blob) return null;
    const fid = String(fileId);
    if (blobCache.has(fid)) {
      return blobCache.get(fid).blobUrl;
    }
    const blobUrl = URL.createObjectURL(blob);
    blobCache.set(fid, { blob, blobUrl, mimeType, fileName });
    return blobUrl;
  }

  function getCachedBlob(fileId) {
    if (!fileId) return null;
    return blobCache.get(String(fileId)) || null;
  }

  // ── Fetch Blob ────────────────────────────────────────────────────────────
  async function _fetchBlob(fileId, mimeType, fileName) {
    const cached = getCachedBlob(fileId);
    if (cached?.blobUrl) return cached.blobUrl;

    const response = await fetch(_downloadUrl(fileId), { credentials: 'same-origin' });
    if (!response.ok) {
      throw new Error(`Failed to load file (HTTP ${response.status})`);
    }

    const rawBlob = await response.blob();
    const finalBlob = new Blob([await rawBlob.arrayBuffer()], {
      type: mimeType || rawBlob.type || 'application/octet-stream',
    });

    return cacheBlob(fileId, finalBlob, mimeType, fileName);
  }

  // ── Zoom & Pan Logic for Images ───────────────────────────────────────────
  function applyZoom() {
    const img = document.getElementById('mpImage');
    if (!img) return;

    if (currentZoom <= 1.0) {
      panX = 0;
      panY = 0;
    }

    img.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${currentZoom})`;
    img.style.cursor = currentZoom > 1.0 ? (isDragging ? 'grabbing' : 'grab') : 'zoom-in';

    if (zoomLevelEl) {
      zoomLevelEl.textContent = `${Math.round(currentZoom * 100)}%`;
    }
  }

  function zoomIn() {
    currentZoom = Math.min(4.0, +(currentZoom + 0.25).toFixed(2));
    applyZoom();
  }

  function zoomOut() {
    currentZoom = Math.max(0.5, +(currentZoom - 0.25).toFixed(2));
    applyZoom();
  }

  function resetZoom() {
    if (currentZoom !== 1.0) {
      currentZoom = 1.0;
    } else {
      currentZoom = 2.0;
    }
    panX = 0;
    panY = 0;
    applyZoom();
  }

  function _setupImageInteraction(img) {
    currentZoom = 1.0;
    panX = 0;
    panY = 0;
    isDragging = false;
    hasMoved = false;
    applyZoom();

    // Mouse drag
    img.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // Only left click
      if (currentZoom <= 1.0) return;
      isDragging = true;
      hasMoved = false;
      startDragX = e.clientX - panX;
      startDragY = e.clientY - panY;
      img.style.cursor = 'grabbing';
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      hasMoved = true;
      panX = e.clientX - startDragX;
      panY = e.clientY - startDragY;
      applyZoom();
    });

    window.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      applyZoom();
    });

    // Wheel zoom
    const container = viewportEl || img.parentElement;
    container.onwheel = (e) => {
      if (!activeMedia || activeMedia.category !== 'image') return;
      e.preventDefault();
      if (e.deltaY < 0) {
        zoomIn();
      } else {
        zoomOut();
      }
    };

    // Double click toggle
    img.addEventListener('dblclick', (e) => {
      e.preventDefault();
      resetZoom();
    });

    // Single click toggles zoom if at 1.0
    img.addEventListener('click', (e) => {
      if (hasMoved) return;
      if (currentZoom === 1.0) {
        currentZoom = 1.75;
        applyZoom();
      }
    });
  }

  // ── Open Media in Viewer ──────────────────────────────────────────────────
  /**
   * Opens the universal media preview lightbox.
   *
   * @param {{
   *   fileId:      number|string,
   *   fileName?:   string,
   *   mimeType?:   string,
   *   messageType?:'image'|'video'|'file'|'text',
   *   src?:        string,
   *   imgEl?:      HTMLImageElement,
   * }} opts
   */
  async function open(opts) {
    _ensureElements();
    if (!modalEl) {
      console.error('[MediaViewer] Modal element #mediaPreviewModal not found');
      return;
    }

    const fileId      = opts.fileId;
    const fileName    = opts.fileName || 'Media File';
    const mimeType    = opts.mimeType || '';
    const messageType = opts.messageType || '';
    const category    = _detectCategory(mimeType, fileName, messageType);

    activeMedia = {
      fileId,
      fileName,
      mimeType,
      messageType,
      category,
      blobUrl: opts.src || (opts.imgEl?.src?.startsWith('blob:') ? opts.imgEl.src : null),
    };

    // Reset UI states
    currentZoom = 1.0;
    panX = 0;
    panY = 0;
    isDragging = false;

    if (spinnerEl) spinnerEl.classList.add('hidden');
    if (errorEl)   errorEl.classList.add('hidden');
    if (containerEl) containerEl.innerHTML = '';

    // Update Header
    if (titleEl) {
      titleEl.textContent = fileName;
      titleEl.title = fileName;
    }

    // Set Header Icon and Badge
    if (typeIconEl) {
      switch (category) {
        case 'image':
          typeIconEl.innerHTML = '🖼️';
          typeIconEl.className = 'w-9 h-9 rounded-xl bg-purple-500/15 border border-purple-500/30 flex items-center justify-center text-lg flex-shrink-0';
          break;
        case 'video':
          typeIconEl.innerHTML = '🎬';
          typeIconEl.className = 'w-9 h-9 rounded-xl bg-blue-500/15 border border-blue-500/30 flex items-center justify-center text-lg flex-shrink-0';
          break;
        case 'pdf':
          typeIconEl.innerHTML = '📕';
          typeIconEl.className = 'w-9 h-9 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-lg flex-shrink-0';
          break;
        case 'audio':
          typeIconEl.innerHTML = '🎵';
          typeIconEl.className = 'w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-lg flex-shrink-0';
          break;
        case 'text':
          typeIconEl.innerHTML = '📝';
          typeIconEl.className = 'w-9 h-9 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-lg flex-shrink-0';
          break;
        default:
          typeIconEl.innerHTML = '📦';
          typeIconEl.className = 'w-9 h-9 rounded-xl bg-slate-500/15 border border-slate-500/30 flex items-center justify-center text-lg flex-shrink-0';
          break;
      }
    }

    if (metaEl) {
      metaEl.textContent = `${category.toUpperCase()} · ${mimeType || 'Document'}`;
    }

    // Toggle zoom controls (images only)
    if (zoomControlsEl) {
      if (category === 'image') {
        zoomControlsEl.classList.remove('hidden');
        zoomControlsEl.classList.add('flex');
        if (zoomLevelEl) zoomLevelEl.textContent = '100%';
      } else {
        zoomControlsEl.classList.add('hidden');
        zoomControlsEl.classList.remove('flex');
      }
    }

    // Reveal modal with smooth fade-in
    modalEl.classList.remove('hidden');
    // Force layout reflow
    void modalEl.offsetWidth;
    modalEl.classList.remove('opacity-0');

    // Render / Load Media Content
    try {
      let url = activeMedia.blobUrl;
      if (!url && fileId) {
        if (spinnerEl) spinnerEl.classList.remove('hidden');
        url = await _fetchBlob(fileId, mimeType, fileName);
        activeMedia.blobUrl = url;
        if (spinnerEl) spinnerEl.classList.add('hidden');
      }

      if (!url) {
        throw new Error('No media source available.');
      }

      _renderCategory(category, url, fileName, mimeType);

    } catch (err) {
      console.error('[MediaViewer] Failed to load media:', err);
      if (spinnerEl) spinnerEl.classList.add('hidden');
      if (errorEl) {
        errorEl.classList.remove('hidden');
        if (errorMsgEl) errorMsgEl.textContent = err.message || 'Unable to open media preview.';
      }
    }
  }

  // ── Render Category Content ───────────────────────────────────────────────
  function _renderCategory(category, blobUrl, fileName, mimeType) {
    if (!containerEl) return;

    if (category === 'image') {
      containerEl.innerHTML = `
        <div class="relative w-full h-full flex items-center justify-center overflow-hidden">
          <img id="mpImage"
               src="${blobUrl}"
               alt="${_escape(fileName)}"
               class="max-w-[95vw] max-h-[85vh] object-contain rounded-xl shadow-2xl transition-transform duration-100 ease-out select-none block"
               draggable="false" />
        </div>`;
      const img = document.getElementById('mpImage');
      if (img) {
        img.onload = () => {
          if (metaEl && img.naturalWidth && img.naturalHeight) {
            metaEl.textContent = `IMAGE · ${img.naturalWidth} × ${img.naturalHeight} px`;
          }
        };
        _setupImageInteraction(img);
      }
      return;
    }

    if (category === 'video') {
      containerEl.innerHTML = `
        <div class="relative max-w-5xl w-full flex items-center justify-center p-2">
          <video id="mpVideo"
                 src="${blobUrl}"
                 controls autoplay playsinline
                 class="max-w-[94vw] max-h-[82vh] rounded-2xl shadow-2xl bg-black border border-white/10 outline-none block">
            Your browser does not support HTML5 video.
          </video>
        </div>`;
      return;
    }

    if (category === 'pdf') {
      containerEl.innerHTML = `
        <div class="w-[95vw] max-w-5xl h-[82vh] rounded-2xl overflow-hidden border border-white/15 shadow-2xl bg-white flex flex-col">
          <iframe id="mpPdfFrame"
                  src="${blobUrl}#view=FitH&toolbar=1"
                  class="w-full h-full border-0 block"
                  title="${_escape(fileName)}">
          </iframe>
        </div>`;
      return;
    }

    if (category === 'audio') {
      containerEl.innerHTML = `
        <div class="flex flex-col items-center justify-center p-8 sm:p-10 bg-black/60 border border-white/15 rounded-3xl backdrop-blur-2xl shadow-2xl max-w-md w-full text-center animate-scale-in">
          <div class="w-24 h-24 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-4xl mb-5 animate-pulse shadow-lg shadow-amber-500/10">
            🎵
          </div>
          <h4 class="text-base font-bold text-white mb-1.5 truncate max-w-xs" title="${_escape(fileName)}">${_escape(fileName)}</h4>
          <p class="text-xs text-white/50 mb-6">Audio Player</p>
          <audio id="mpAudio" controls autoplay class="w-full rounded-xl outline-none" src="${blobUrl}"></audio>
        </div>`;
      return;
    }

    if (category === 'text') {
      // Fetch plain text content to display
      fetch(blobUrl)
        .then(res => res.text())
        .then(text => {
          containerEl.innerHTML = `
            <div class="w-[95vw] max-w-4xl max-h-[82vh] flex flex-col bg-[#0f0f13] border border-white/15 rounded-2xl overflow-hidden shadow-2xl text-left animate-scale-in">
              <div class="flex items-center justify-between px-4 py-3 bg-black/40 border-b border-white/10">
                <span class="text-xs font-mono text-white/70 truncate">${_escape(fileName)}</span>
                <button type="button"
                        onclick="navigator.clipboard.writeText(document.getElementById('mpTextContent').textContent); if(window.SDH?.Chat?.showToast) SDH.Chat.showToast('Copied to clipboard', 'success');"
                        class="px-3 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-semibold transition-all">
                  Copy Text
                </button>
              </div>
              <pre id="mpTextContent" class="p-5 overflow-auto text-xs font-mono text-emerald-300 select-text whitespace-pre-wrap leading-relaxed max-h-[72vh] custom-scrollbar">${_escape(text)}</pre>
            </div>`;
        })
        .catch(() => _renderGenericCard(fileName, blobUrl));
      return;
    }

    _renderGenericCard(fileName, blobUrl);
  }

  function _renderGenericCard(fileName, blobUrl) {
    if (!containerEl) return;
    containerEl.innerHTML = `
      <div class="flex flex-col items-center justify-center p-8 sm:p-12 bg-black/60 border border-white/15 rounded-3xl backdrop-blur-2xl shadow-2xl max-w-sm w-full text-center animate-scale-in">
        <div class="w-24 h-24 rounded-2xl bg-divine-gold/15 border border-divine-gold/30 flex items-center justify-center text-5xl mb-5 shadow-lg shadow-divine-gold/10">
          📦
        </div>
        <h4 class="text-base font-bold text-white mb-2 truncate max-w-xs" title="${_escape(fileName)}">${_escape(fileName)}</h4>
        <p class="text-xs text-white/50 mb-7 leading-relaxed">Direct browser preview is not supported for this file type. You can download and open it with your device.</p>
        <button type="button" onclick="SDH.MediaViewer.downloadCurrent()" class="sdh-liquid-btn btn-primary px-6 py-2.5 flex items-center gap-2">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
          </svg>
          <span>Download File</span>
        </button>
      </div>`;
  }

  // ── Actions ───────────────────────────────────────────────────────────────
  function close() {
    _ensureElements();
    if (!modalEl || modalEl.classList.contains('hidden')) return;

    // Pause any playing media immediately
    const video = document.getElementById('mpVideo');
    if (video) {
      video.pause();
      video.src = '';
    }
    const audio = document.getElementById('mpAudio');
    if (audio) {
      audio.pause();
      audio.src = '';
    }

    if (viewportEl) viewportEl.onwheel = null;

    modalEl.classList.add('opacity-0');
    setTimeout(() => {
      modalEl.classList.add('hidden');
      if (containerEl) containerEl.innerHTML = '';
      activeMedia = null;
    }, 200);
  }

  function downloadCurrent() {
    if (!activeMedia) return;
    const { fileId, fileName, mimeType, blobUrl } = activeMedia;

    if (blobUrl) {
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = fileName || 'download';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return;
    }

    if (fileId && window.SDH?.FileUpload?.downloadFile) {
      window.SDH.FileUpload.downloadFile({
        messageId: Number(fileId),
        fileName,
        mimeType,
      });
    }
  }

  function openInNewTab() {
    if (!activeMedia) return;
    const { blobUrl, fileId } = activeMedia;
    const targetUrl = blobUrl || _downloadUrl(fileId);
    if (targetUrl) {
      window.open(targetUrl, '_blank', 'noopener,noreferrer');
    }
  }

  function retry() {
    if (activeMedia) {
      const copy = { ...activeMedia };
      open(copy);
    }
  }

  // ── Keyboard Support ──────────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (!modalEl || modalEl.classList.contains('hidden')) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === '+' || e.key === '=') {
      if (activeMedia?.category === 'image') {
        e.preventDefault();
        zoomIn();
      }
    } else if (e.key === '-' || e.key === '_') {
      if (activeMedia?.category === 'image') {
        e.preventDefault();
        zoomOut();
      }
    } else if (e.key === '0') {
      if (activeMedia?.category === 'image') {
        e.preventDefault();
        resetZoom();
      }
    }
  });

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    open,
    close,
    zoomIn,
    zoomOut,
    resetZoom,
    downloadCurrent,
    openInNewTab,
    retry,
    cacheBlob,
    getCachedBlob,
  };

})();
