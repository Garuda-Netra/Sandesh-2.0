/**
 * SDH Location Sharing Module
 * =========================================================================
 * Provides:
 *   - Send Current Location (GPS Pin, address reverse geocoding, landmark search)
 *   - Share Live Location (Real-time tracking: 15m / 1h / 8h durations)
 *   - Interactive Leaflet Map picker and Full-screen Live Viewer Modal
 *   - Continuous GPS streaming over WebSocket with REST fallback
 * =========================================================================
 */

/* eslint-env browser */
/* global SDH, window, document, console, fetch, setTimeout, clearTimeout, navigator, L */

'use strict';

window.SDH = window.SDH || {};

SDH.LocationShare = (function () {
  let activeTab = 'current'; // 'current' | 'live'
  let currentLat = null;
  let currentLng = null;
  let currentAccuracy = null;

  let selectedLat = null;
  let selectedLng = null;
  let selectedPlaceName = '';
  let selectedAddress = '';

  let liveDuration = 3600; // default 1 hour in seconds
  let activeWatchId = null;
  let activeLiveMsgId = null;
  let activeLiveExpirationTimer = null;

  // Stored location payloads keyed by messageId
  const messageLocations = new Map();

  // Leaflet map instances
  let shareMap = null;
  let shareMarker = null;
  let shareAccuracyCircle = null;

  let viewerMap = null;
  let viewerMarker = null;
  let viewerAccuracyCircle = null;
  let currentViewingLoc = null;

  // Tile layer: Standard OpenStreetMap (100% free, zero watermarks, no API key required)
  const osmTileUrl = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const tileAttrib = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

  function getTileUrl() {
    return osmTileUrl;
  }

  // Custom Leaflet DivIcon for Current & Live location
  function createPinIcon(isLive = false, avatarUrl = '') {
    const pulseHtml = isLive
      ? `<span class="absolute -inset-2 rounded-full bg-emerald-500/30 animate-ping pointer-events-none"></span>`
      : '';
    const avatarHtml = avatarUrl
      ? `<img src="${avatarUrl}" class="w-8 h-8 rounded-full object-cover border-2 border-white shadow-md" />`
      : `<div class="w-8 h-8 rounded-full bg-gradient-to-tr from-emerald-600 to-teal-500 flex items-center justify-center text-white text-sm font-bold shadow-lg border-2 border-white">📍</div>`;

    return L.divIcon({
      className: 'sdh-leaflet-marker-pin',
      html: `
        <div class="relative flex items-center justify-center cursor-pointer">
          ${pulseHtml}
          ${avatarHtml}
        </div>
      `,
      iconSize: [36, 36],
      iconAnchor: [18, 36],
      popupAnchor: [0, -36]
    });
  }

  // ── Open / Close Share Modal ──────────────────────────────────────────────

  function openModal() {
    const activeTarget = (typeof SDH.Chat?.getActiveUser === 'function' ? SDH.Chat.getActiveUser() : '') || '';
    if (!activeTarget) {
      if (typeof SDH.showNotification === 'function') {
        SDH.showNotification('Please select a conversation first.');
      }
      return;
    }

    const modal = document.getElementById('locationShareModal');
    if (!modal) return;

    // Set target display name in header
    const targetLabel = document.getElementById('locModalTargetName');
    if (targetLabel) {
      targetLabel.textContent = `with ${activeTarget.replace('group_', '')}`;
    }

    modal.classList.remove('hidden');
    switchTab('current');

    // Acquire current GPS location
    detectCurrentPosition((lat, lng, accuracy) => {
      initShareMap(lat, lng, accuracy);
      reverseGeocode(lat, lng);
    });
  }

  function closeModal() {
    const modal = document.getElementById('locationShareModal');
    if (modal) modal.classList.add('hidden');
    clearSearch();
  }

  // ── Switch Tabs (Current Location vs Live Location) ───────────────────────

  function switchTab(tab) {
    activeTab = tab;
    const currentBtn = document.getElementById('locTabCurrentBtn');
    const liveBtn = document.getElementById('locTabLiveBtn');
    const searchWrap = document.getElementById('locSearchContainer');
    const liveConfig = document.getElementById('locLiveConfig');
    const submitBtnText = document.getElementById('locSubmitBtnText');

    if (tab === 'current') {
      if (currentBtn) {
        currentBtn.className = 'flex-1 py-2 px-3 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 bg-emerald-500 text-white shadow-md shadow-emerald-500/25';
      }
      if (liveBtn) {
        liveBtn.className = 'flex-1 py-2 px-3 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 transition-all flex items-center justify-center gap-1.5';
      }
      if (searchWrap) searchWrap.classList.remove('hidden');
      if (liveConfig) liveConfig.classList.add('hidden');
      if (submitBtnText) submitBtnText.textContent = 'Send Current Location';
      if (shareMarker) shareMarker.setIcon(createPinIcon(false));
    } else {
      if (currentBtn) {
        currentBtn.className = 'flex-1 py-2 px-3 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 transition-all flex items-center justify-center gap-1.5';
      }
      if (liveBtn) {
        liveBtn.className = 'flex-1 py-2 px-3 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 bg-emerald-500 text-white shadow-md shadow-emerald-500/25';
      }
      if (searchWrap) searchWrap.classList.add('hidden');
      if (liveConfig) liveConfig.classList.remove('hidden');
      if (submitBtnText) submitBtnText.textContent = 'Share Live Location';
      if (shareMarker) shareMarker.setIcon(createPinIcon(true));
    }

    if (shareMap) {
      setTimeout(() => shareMap.invalidateSize(), 100);
    }
  }

  function selectDuration(seconds, btnEl) {
    liveDuration = seconds;
    document.querySelectorAll('.loc-duration-btn').forEach(b => {
      b.className = 'loc-duration-btn py-2 px-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white/50 dark:bg-black/20 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:border-emerald-500 transition-all text-center';
    });
    if (btnEl) {
      btnEl.className = 'loc-duration-btn active py-2 px-2.5 rounded-xl border border-emerald-500 bg-emerald-500/15 text-xs font-bold text-emerald-600 dark:text-emerald-400 transition-all text-center';
    }
  }

  // ── GPS Acquisition ───────────────────────────────────────────────────────

  function detectCurrentPosition(callback) {
    const accuracyBadge = document.getElementById('locAccuracyBadge');
    if (accuracyBadge) accuracyBadge.textContent = 'Acquiring GPS...';

    if (!navigator.geolocation) {
      if (accuracyBadge) accuracyBadge.textContent = 'GPS not supported';
      // Fallback coordinates (New Delhi Center: 28.6139, 77.2090)
      useFallbackCoordinates(callback);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        currentLat = pos.coords.latitude;
        currentLng = pos.coords.longitude;
        currentAccuracy = Math.round(pos.coords.accuracy || 15);

        selectedLat = currentLat;
        selectedLng = currentLng;
        selectedPlaceName = 'Current Location';

        if (accuracyBadge) {
          accuracyBadge.textContent = `Accurate to ${currentAccuracy} m`;
        }
        if (typeof callback === 'function') {
          callback(currentLat, currentLng, currentAccuracy);
        }
      },
      (err) => {
        console.warn('[SDH.LocationShare] Geolocation error:', err);
        if (accuracyBadge) {
          accuracyBadge.textContent = 'Location access denied or unavailable';
        }
        useFallbackCoordinates(callback);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 15000
      }
    );
  }

  function useFallbackCoordinates(callback) {
    // Default to New Delhi / fallback coordinates if browser denied GPS
    currentLat = 28.6139;
    currentLng = 77.2090;
    currentAccuracy = 50;
    selectedLat = currentLat;
    selectedLng = currentLng;
    selectedPlaceName = 'Selected Pin';
    if (typeof callback === 'function') {
      callback(currentLat, currentLng, currentAccuracy);
    }
  }

  function recenterGPS() {
    detectCurrentPosition((lat, lng, accuracy) => {
      if (shareMap) {
        shareMap.setView([lat, lng], 16);
      }
      if (shareMarker) {
        shareMarker.setLatLng([lat, lng]);
      }
      if (shareAccuracyCircle) {
        shareAccuracyCircle.setLatLng([lat, lng]);
        shareAccuracyCircle.setRadius(accuracy || 20);
      }
      reverseGeocode(lat, lng);
    });
  }

  // ── Leaflet Share Map Initialization ─────────────────────────────────────

  function initShareMap(lat, lng, accuracy) {
    const mapEl = document.getElementById('locShareMap');
    if (!mapEl || typeof L === 'undefined') return;

    if (!shareMap) {
      shareMap = L.map('locShareMap', {
        zoomControl: false,
        attributionControl: false
      }).setView([lat, lng], 16);

      L.control.zoom({ position: 'topright' }).addTo(shareMap);

      L.tileLayer(getTileUrl(), {
        maxZoom: 19,
        attribution: tileAttrib
      }).addTo(shareMap);

      // Draggable pin marker
      shareMarker = L.marker([lat, lng], {
        draggable: true,
        icon: createPinIcon(activeTab === 'live')
      }).addTo(shareMap);

      shareMarker.on('dragend', function (e) {
        const pos = e.target.getLatLng();
        selectedLat = pos.lat;
        selectedLng = pos.lng;
        selectedPlaceName = 'Custom Selected Pin';
        reverseGeocode(pos.lat, pos.lng);
      });

      // Accuracy radius circle
      shareAccuracyCircle = L.circle([lat, lng], {
        radius: accuracy || 20,
        color: '#10b981',
        fillColor: '#10b981',
        fillOpacity: 0.12,
        weight: 1.5
      }).addTo(shareMap);

      // Click on map to reposition pin
      shareMap.on('click', function (e) {
        selectedLat = e.latlng.lat;
        selectedLng = e.latlng.lng;
        shareMarker.setLatLng(e.latlng);
        if (shareAccuracyCircle) shareAccuracyCircle.setLatLng(e.latlng);
        selectedPlaceName = 'Custom Selected Pin';
        reverseGeocode(selectedLat, selectedLng);
      });
    } else {
      shareMap.setView([lat, lng], 16);
      if (shareMarker) shareMarker.setLatLng([lat, lng]);
      if (shareAccuracyCircle) {
        shareAccuracyCircle.setLatLng([lat, lng]);
        shareAccuracyCircle.setRadius(accuracy || 20);
      }
    }

    setTimeout(() => {
      if (shareMap) shareMap.invalidateSize();
    }, 150);
  }

  // ── Reverse Geocoding (Nominatim OpenStreetMap) ───────────────────────────

  async function reverseGeocode(lat, lng) {
    const titleEl = document.getElementById('locPlaceTitle');
    const addrEl = document.getElementById('locPlaceAddress');
    const coordsEl = document.getElementById('locPlaceCoords');

    if (coordsEl) {
      coordsEl.textContent = `${lat.toFixed(5)}° N, ${lng.toFixed(5)}° E`;
    }

    if (titleEl) titleEl.textContent = selectedPlaceName || 'Pinned Location';
    if (addrEl) addrEl.textContent = 'Fetching address...';

    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      if (res.ok) {
        const data = await res.json();
        const displayName = data.display_name || '';
        const namePart = data.name || data.address?.road || data.address?.suburb || data.address?.city || 'Pinned Location';
        
        selectedAddress = displayName;
        if (!selectedPlaceName || selectedPlaceName === 'Pinned Location' || selectedPlaceName === 'Custom Selected Pin') {
          selectedPlaceName = namePart;
        }

        if (titleEl) titleEl.textContent = selectedPlaceName;
        if (addrEl) addrEl.textContent = selectedAddress || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
      }
    } catch (err) {
      console.warn('[SDH.LocationShare] Reverse geocode error:', err);
      if (addrEl) addrEl.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    }
  }

  // ── Place Search Autocomplete ─────────────────────────────────────────────

  let searchDebounce = null;
  async function searchPlaces() {
    const input = document.getElementById('locSearchInput');
    const resultsContainer = document.getElementById('locSearchResults');
    const clearBtn = document.getElementById('locSearchClearBtn');
    if (!input || !resultsContainer) return;

    const query = input.value.trim();
    if (!query) {
      resultsContainer.classList.add('hidden');
      if (clearBtn) clearBtn.classList.add('hidden');
      return;
    }

    if (clearBtn) clearBtn.classList.remove('hidden');
    resultsContainer.innerHTML = '<div class="p-3 text-xs text-slate-400 text-center">Searching places...</div>';
    resultsContainer.classList.remove('hidden');

    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(query)}&limit=5`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      if (!res.ok) return;

      const items = await res.json();
      if (!items || items.length === 0) {
        resultsContainer.innerHTML = '<div class="p-3 text-xs text-slate-400 text-center">No locations found.</div>';
        return;
      }

      resultsContainer.innerHTML = items.map((item, idx) => `
        <div class="p-2.5 hover:bg-emerald-500/10 cursor-pointer transition-colors text-left flex items-start gap-2.5"
             onclick="SDH.LocationShare.selectSearchResult(${item.lat}, ${item.lon}, '${escapeJsString(item.name || item.display_name.split(',')[0])}', '${escapeJsString(item.display_name)}')">
          <span class="text-emerald-500 text-sm mt-0.5">📍</span>
          <div class="min-w-0 flex-1">
            <p class="text-xs font-bold text-slate-800 dark:text-slate-200 truncate">${escapeHtml(item.name || item.display_name.split(',')[0])}</p>
            <p class="text-[10px] text-slate-500 dark:text-slate-400 truncate">${escapeHtml(item.display_name)}</p>
          </div>
        </div>
      `).join('');
    } catch (err) {
      console.warn('[SDH.LocationShare] Search places error:', err);
      resultsContainer.innerHTML = '<div class="p-3 text-xs text-rose-400 text-center">Failed to search. Check internet connection.</div>';
    }
  }

  function selectSearchResult(lat, lng, name, address) {
    selectedLat = parseFloat(lat);
    selectedLng = parseFloat(lng);
    selectedPlaceName = name || 'Selected Place';
    selectedAddress = address || '';

    const resultsContainer = document.getElementById('locSearchResults');
    if (resultsContainer) resultsContainer.classList.add('hidden');

    const input = document.getElementById('locSearchInput');
    if (input) input.value = selectedPlaceName;

    const titleEl = document.getElementById('locPlaceTitle');
    const addrEl = document.getElementById('locPlaceAddress');
    const coordsEl = document.getElementById('locPlaceCoords');

    if (titleEl) titleEl.textContent = selectedPlaceName;
    if (addrEl) addrEl.textContent = selectedAddress;
    if (coordsEl) coordsEl.textContent = `${selectedLat.toFixed(5)}° N, ${selectedLng.toFixed(5)}° E`;

    if (shareMap) {
      shareMap.setView([selectedLat, selectedLng], 16);
    }
    if (shareMarker) {
      shareMarker.setLatLng([selectedLat, selectedLng]);
    }
    if (shareAccuracyCircle) {
      shareAccuracyCircle.setLatLng([selectedLat, selectedLng]);
    }
  }

  function clearSearch() {
    const input = document.getElementById('locSearchInput');
    const resultsContainer = document.getElementById('locSearchResults');
    const clearBtn = document.getElementById('locSearchClearBtn');
    if (input) input.value = '';
    if (resultsContainer) resultsContainer.classList.add('hidden');
    if (clearBtn) clearBtn.classList.add('hidden');
  }

  // ── Send / Submit Location ────────────────────────────────────────────────

  async function submitLocation() {
    const activeTarget = (typeof SDH.Chat?.getActiveUser === 'function' ? SDH.Chat.getActiveUser() : '') || '';
    if (!activeTarget) return;

    if (selectedLat === null || selectedLng === null) {
      if (typeof SDH.showNotification === 'function') {
        SDH.showNotification('GPS location not ready yet.');
      }
      return;
    }

    const isLive = (activeTab === 'live');
    const commentInput = document.getElementById('locLiveComment');
    const comment = (commentInput ? commentInput.value.trim() : '') || '';

    const isGroup = activeTarget.startsWith('group_');

    const expiresAtMs = Date.now() + (liveDuration || 3600) * 1000;
    const locPayload = {
      latitude: selectedLat,
      longitude: selectedLng,
      location_name: isLive ? 'Live Location' : (selectedPlaceName || 'Current Location'),
      location_address: selectedAddress || `${selectedLat.toFixed(4)}, ${selectedLng.toFixed(4)}`,
      is_live: isLive,
      is_live_location: isLive,
      live_duration: isLive ? liveDuration : 0,
      live_expires_at: isLive ? new Date(expiresAtMs).toISOString() : null,
      is_live_ended: false,
      is_group: isGroup
    };

    const payload = {
      target: activeTarget,
      latitude: selectedLat,
      longitude: selectedLng,
      location_name: locPayload.location_name,
      location_address: locPayload.location_address,
      is_live: isLive,
      live_duration: isLive ? liveDuration : 0,
      message: comment
    };

    // Optimistically render card in active chat
    const tempId = `temp_loc_${Date.now()}`;
    if (typeof SDH.Chat?.appendMessage === 'function') {
      SDH.Chat.appendMessage({
        sender: window.SDH_DATA?.currentUser || 'You',
        isFromMe: true,
        content: comment,
        messageType: 'location',
        location: locPayload,
        timestamp: new Date().toISOString(),
        messageId: tempId
      });
      SDH.Chat.scrollToBottom?.();
    }

    if (isLive) {
      activeLiveMsgId = tempId;
      startLiveGeolocationWatch(tempId, isGroup, expiresAtMs);
    }

    // Close modal immediately for optimal responsive feel
    closeModal();

    // REST call saves to DB and broadcasts to room/channel
    try {
      const res = await fetch('/messaging/api/location/send/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': getCookie('csrftoken') || ''
        },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        const respData = await res.json();
        const realId = respData.message_id;
        if (realId) {
          activeLiveMsgId = realId;
          // Update temp DOM element with real message id
          const tempBubble = document.getElementById(`msg-${tempId}`);
          if (tempBubble) {
            tempBubble.id = `msg-${realId}`;
            tempBubble.dataset.messageId = String(realId);
            const cardEl = tempBubble.querySelector(`#loc-bubble-${tempId}`) || tempBubble.querySelector('.sdh-location-msg-card');
            if (cardEl) {
              cardEl.id = `loc-bubble-${realId}`;
              cardEl.dataset.messageId = String(realId);
              cardEl.setAttribute('data-msg-id', String(realId));
            }
            const stopBtn = tempBubble.querySelector('.sdh-loc-btn-stop') || tempBubble.querySelector('.sdh-loc-stop-btn');
            if (stopBtn) {
              stopBtn.setAttribute('onclick', `event.stopPropagation(); SDH.LocationShare.stopLiveLocation('${realId}', ${isGroup});`);
            }
            const mapThumb = tempBubble.querySelector('[onclick*="openViewer"]');
            if (mapThumb) {
              mapThumb.setAttribute('onclick', `SDH.LocationShare.openViewer('${realId}', true)`);
            }
            const viewBtn = tempBubble.querySelector('.sdh-loc-btn-view');
            if (viewBtn) {
              viewBtn.setAttribute('onclick', `SDH.LocationShare.openViewer('${realId}', true)`);
            }
          }
          locPayload.message_id = realId;
          messageLocations.set(String(realId), locPayload);

          if (isLive) {
            startLiveGeolocationWatch(realId, isGroup, expiresAtMs);
          }
        }
      }
    } catch (err) {
      console.error('[SDH.LocationShare] REST error:', err);
    }
  }

  // ── Render Location Message Card in Chat Bubble ───────────────────────────

  function buildCardHtml({ location, content, messageId, isFromMe, timestamp }) {
    if (!location) {
      return `<p class="text-sm italic text-slate-300">Location data unavailable</p>`;
    }

    const lat = parseFloat(location.latitude) || 0;
    const lng = parseFloat(location.longitude) || 0;
    const isLive = Boolean(location.is_live === true || location.is_live === 'true' || location.is_live_location === true || location.is_live_location === 'true');
    const isEnded = isLive && (Boolean(location.is_live_ended === true || location.is_live_ended === 'true') || (location.live_expires_at && new Date() > new Date(location.live_expires_at)));
    
    // Strict title distinction: Live Location vs landmark/place name vs Current Location
    let locTitle = '';
    if (isLive) {
      locTitle = 'Live Location';
    } else {
      locTitle = (location.location_name && location.location_name !== 'Live Location') ? location.location_name : 'Current Location';
    }
    const locAddress = location.location_address || `${lat.toFixed(4)}°, ${lng.toFixed(4)}°`;
    const comment = content || '';

    // Cache in memory for interactive modal lookups
    const locData = {
      message_id: messageId,
      latitude: lat,
      longitude: lng,
      location_name: locTitle,
      location_address: locAddress,
      is_live: isLive,
      is_live_ended: isEnded,
      live_expires_at: location.live_expires_at,
      is_group: Boolean(location.is_group)
    };
    messageLocations.set(String(messageId), locData);

    // Calculate map tile numbers at zoom 15 for OpenStreetMap (Clean, zero watermarks, no API key required)
    const z = 15;
    const n = Math.pow(2, z);
    const x = Math.floor((lng + 180) / 360 * n);
    const latRad = lat * Math.PI / 180;
    const y = Math.floor((1 - Math.log(Math.tan(latRad) + (1 / Math.cos(latRad))) / Math.PI) / 2 * n);
    const tileSub = ['a', 'b', 'c'][Math.abs((x + y) % 3)];
    const tileUrl = `https://${tileSub}.tile.openstreetmap.org/${z}/${x}/${y}.png`;

    // Calculate live expiration & remaining time
    let liveRemainingText = '';
    let remainingMs = 0;
    if (isLive && !isEnded && location.live_expires_at) {
      const expiresAtMs = new Date(location.live_expires_at).getTime();
      remainingMs = expiresAtMs - Date.now();
      if (remainingMs > 0) {
        const remainingMinutes = Math.ceil(remainingMs / 60000);
        if (remainingMinutes >= 60) {
          const hours = Math.floor(remainingMinutes / 60);
          const mins = remainingMinutes % 60;
          liveRemainingText = mins > 0 ? `${hours}h ${mins}m left` : `${hours}h left`;
        } else {
          liveRemainingText = `${remainingMinutes}m left`;
        }

        // Schedule auto-expiry on the card so badge changes to 'Live ended' automatically
        setTimeout(() => {
          handleIncomingLiveStopped({ message_id: messageId });
        }, remainingMs);
      }
    }

    // Status badge: Live Active vs Live Ended vs Current Pinpoint
    let badgeHtml = '';
    if (isLive) {
      if (isEnded || (location.live_expires_at && remainingMs <= 0 && isLive)) {
        badgeHtml = `
          <div class="sdh-loc-badge inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-slate-900/90 text-slate-300 border border-slate-600 shadow-md backdrop-blur-md">
            <span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span>
            <span>Live ended</span>
          </div>`;
      } else {
        badgeHtml = `
          <div class="sdh-loc-badge inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-extrabold bg-emerald-950/90 text-emerald-300 border border-emerald-400/50 shadow-md backdrop-blur-md">
            <span class="relative flex h-2 w-2">
              <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-80"></span>
              <span class="relative inline-flex rounded-full h-2 w-2 bg-emerald-400"></span>
            </span>
            <span>Live Location${liveRemainingText ? ` · ${liveRemainingText}` : ''}</span>
          </div>`;
      }
    } else {
      badgeHtml = `
        <div class="sdh-loc-badge inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-slate-900/90 text-emerald-300 border border-emerald-500/40 shadow-md backdrop-blur-md">
          <span>📍</span>
          <span>Current Location</span>
        </div>`;
    }

    // Stop live button ONLY for sender when live is active
    const stopBtnHtml = (isLive && !isEnded && isFromMe) ? `
      <button type="button"
              onclick="event.stopPropagation(); SDH.LocationShare.stopLiveLocation('${messageId}', ${Boolean(location.is_group)});"
              class="sdh-loc-btn-stop flex-1 min-w-[95px] py-2 px-3 rounded-xl text-xs font-bold text-white shadow-md flex items-center justify-center gap-1.5 transition-all active:scale-95 cursor-pointer"
              title="Stop sharing live location">
        <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"/></svg>
        <span class="whitespace-nowrap">Stop Sharing</span>
      </button>` : '';

    return `
      <div class="sdh-location-msg-card w-[280px] sm:w-[325px] max-w-full flex flex-col box-border select-none rounded-2xl bg-slate-900/95 dark:bg-[#0b1120]/95 text-white p-2 border border-white/20 shadow-xl backdrop-blur-md" id="loc-bubble-${messageId}" data-msg-id="${messageId}">
        <!-- Map Thumbnail Preview -->
        <div class="relative w-full h-36 sm:h-44 rounded-xl overflow-hidden cursor-pointer group/map border border-white/15 shadow-sm bg-slate-950"
             onclick="SDH.LocationShare.openViewer('${messageId}', ${isFromMe})">
          
          <!-- Static OpenStreetMap tile (zero watermark, no API key required) -->
          <img src="${tileUrl}"
               alt="Map Preview"
               class="w-full h-full object-cover group-hover/map:scale-105 transition-transform duration-500"
               loading="lazy"
               onerror="this.style.display='none'; this.nextElementSibling.classList.remove('hidden');" />

          <!-- Fallback pattern background if tile fails to load -->
          <div class="hidden absolute inset-0 bg-gradient-to-br from-slate-900 via-slate-950 to-slate-900 flex items-center justify-center">
            <svg class="w-16 h-16 text-emerald-500/30" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"/></svg>
          </div>

          <!-- Center Map Pin / Live Beacon -->
          <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
            ${isLive ? `
              <div class="relative flex items-center justify-center">
                ${!isEnded ? `<span class="animate-ping absolute -inset-3 rounded-full bg-emerald-500/50"></span>` : ''}
                <div class="w-10 h-10 rounded-full ${isEnded ? 'bg-slate-700 border-slate-400' : 'bg-emerald-500 border-white'} flex items-center justify-center text-white text-lg shadow-2xl border-2">
                  ${isEnded ? '⚪' : '📍'}
                </div>
              </div>
            ` : `
              <div class="w-10 h-10 rounded-full bg-emerald-500 flex items-center justify-center text-white text-lg shadow-2xl border-2 border-white hover:scale-110 transition-transform">
                📍
              </div>
            `}
          </div>

          <!-- Top Badge Overlay (Live or Static status) -->
          <div class="absolute top-2 left-2 z-10 pointer-events-none">
            ${badgeHtml}
          </div>

          <!-- Hover "View Live Map" Overlay Indicator -->
          <div class="absolute inset-0 bg-black/40 opacity-0 group-hover/map:opacity-100 transition-opacity duration-200 flex items-center justify-center pointer-events-none">
            <span class="py-1.5 px-3.5 rounded-full bg-black/85 text-white backdrop-blur-md border border-white/25 text-xs font-bold shadow-2xl flex items-center gap-1.5">
              <svg class="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
              <span>View Map</span>
            </span>
          </div>
        </div>

        <!-- Place Details Card Info -->
        <div class="mt-2.5 px-1.5">
          <p class="sdh-loc-title text-sm sm:text-base font-bold text-white leading-tight truncate" title="${escapeHtml(locTitle)}">${escapeHtml(locTitle)}</p>
          <p class="sdh-loc-subtitle text-xs text-slate-300 mt-1 line-clamp-2 leading-relaxed" title="${escapeHtml(locAddress)}">${escapeHtml(locAddress)}</p>
          ${comment ? `<p class="sdh-loc-comment text-xs text-slate-100 mt-2 italic p-2 rounded-xl bg-white/10 border border-white/15">${escapeHtml(comment)}</p>` : ''}
        </div>

        <!-- Action Buttons (Responsive flex-wrap) -->
        <div class="mt-3 flex flex-wrap items-center gap-1.5 sm:gap-2">
          <button type="button"
                  onclick="SDH.LocationShare.openViewer('${messageId}', ${isFromMe})"
                  class="sdh-loc-btn-view flex-1 min-w-[95px] py-2 px-3 rounded-xl text-xs font-bold text-white shadow-md flex items-center justify-center gap-1.5 transition-all active:scale-95 cursor-pointer">
            <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"/></svg>
            <span class="whitespace-nowrap">View Map</span>
          </button>

          <a href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}"
             target="_blank"
             rel="noopener noreferrer"
             class="sdh-loc-btn-dir flex-1 min-w-[95px] py-2 px-3 rounded-xl text-xs font-semibold text-white shadow-md flex items-center justify-center gap-1.5 transition-all active:scale-95 cursor-pointer no-underline"
             title="Get Directions">
            <svg class="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M14 5l7 7m0 0l-7 7m7-7H3"/></svg>
            <span class="whitespace-nowrap">Directions</span>
          </a>

          ${stopBtnHtml}
        </div>
      </div>
    `;
  }

  // ── Real-Time Live Location Watch & Streaming ─────────────────────────────

  function startLiveGeolocationWatch(messageId, isGroup, expiresAtMs) {
    if (activeWatchId !== null) {
      navigator.geolocation.clearWatch(activeWatchId);
      activeWatchId = null;
    }
    if (activeLiveExpirationTimer) {
      clearTimeout(activeLiveExpirationTimer);
      activeLiveExpirationTimer = null;
    }

    activeLiveMsgId = messageId;
    let lastSentTime = 0;

    if (navigator.geolocation) {
      activeWatchId = navigator.geolocation.watchPosition(
        (pos) => {
          const now = Date.now();
          // Throttle updates to every 10 seconds
          if (now - lastSentTime < 10000) return;
          lastSentTime = now;

          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;

          broadcastLiveCoords(messageId, isGroup, lat, lng);
        },
        (err) => console.warn('[SDH.LocationShare] Live watch error:', err),
        { enableHighAccuracy: true, maximumAge: 8000 }
      );
    }

    // Schedule auto-stop when duration expires
    const now = Date.now();
    let delayMs = (liveDuration || 3600) * 1000;
    if (expiresAtMs && typeof expiresAtMs === 'number' && expiresAtMs > now) {
      delayMs = Math.max(1000, expiresAtMs - now);
    }
    activeLiveExpirationTimer = setTimeout(() => {
      stopLiveLocation(messageId, isGroup);
    }, delayMs);
  }

  function broadcastLiveCoords(messageId, isGroup, lat, lng) {
    const ws = SDH.WS?.getSocket?.();
    const payload = {
      type: 'live_location_update',
      message_id: messageId,
      is_group: isGroup,
      latitude: lat,
      longitude: lng,
      updated_at: new Date().toISOString()
    };

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    } else {
      // REST fallback
      fetch('/messaging/api/location/update/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': getCookie('csrftoken') || ''
        },
        body: JSON.stringify(payload)
      }).catch(e => console.warn('[SDH.LocationShare] update_live_location err:', e));
    }
  }

  async function stopLiveLocation(messageId, isGroup) {
    if (activeWatchId !== null) {
      navigator.geolocation.clearWatch(activeWatchId);
      activeWatchId = null;
    }
    if (activeLiveExpirationTimer) {
      clearTimeout(activeLiveExpirationTimer);
      activeLiveExpirationTimer = null;
    }

    const targetMsgId = (messageId && !String(messageId).startsWith('temp_'))
      ? messageId
      : (activeLiveMsgId || messageId);

    activeLiveMsgId = null;

    if (isGroup === undefined || isGroup === null) {
      const activeTarget = (typeof SDH.Chat?.getActiveUser === 'function' ? SDH.Chat.getActiveUser() : '') || '';
      isGroup = activeTarget.startsWith('group_');
    }

    const payload = {
      type: 'stop_live_location',
      message_id: targetMsgId,
      is_group: Boolean(isGroup)
    };

    const ws = SDH.WS?.getSocket?.();
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(payload));
      } catch (err) {
        console.warn('[SDH.LocationShare] ws send stop error:', err);
      }
    }

    try {
      await fetch('/messaging/api/location/stop/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': getCookie('csrftoken') || ''
        },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      console.warn('[SDH.LocationShare] stop_live_location err:', e);
    }

    // Optimistically update card in DOM
    handleIncomingLiveStopped({ message_id: targetMsgId });
    if (messageId && messageId !== targetMsgId) {
      handleIncomingLiveStopped({ message_id: messageId });
    }
  }

  // ── Full-screen Location Viewer Modal ─────────────────────────────────────

  function openViewer(locationDataOrId, isFromMe = false) {
    let locationData = locationDataOrId;
    if (typeof locationDataOrId === 'string' || typeof locationDataOrId === 'number') {
      const stored = messageLocations.get(String(locationDataOrId));
      if (stored) {
        locationData = stored;
      } else {
        const card = document.getElementById(`loc-bubble-${locationDataOrId}`);
        if (card && card.dataset.locData) {
          try { locationData = JSON.parse(card.dataset.locData); } catch (e) { }
        }
      }
    }
    if (!locationData) return;
    currentViewingLoc = { ...locationData, isFromMe };

    const modal = document.getElementById('locationViewerModal');
    if (!modal) return;

    modal.classList.remove('hidden');

    const lat = parseFloat(locationData.latitude);
    const lng = parseFloat(locationData.longitude);

    // Header labels
    const titleEl = document.getElementById('locViewerTitle');
    const subtitleEl = document.getElementById('locViewerSubtitle');
    const addrEl = document.getElementById('locViewerAddressText');
    const updatedEl = document.getElementById('locViewerLastUpdated');
    const dirBtn = document.getElementById('locViewerDirectionsBtn');
    const stopBtn = document.getElementById('locViewerStopBtn');
    const liveBanner = document.getElementById('locViewerLiveBanner');
    const liveStatus = document.getElementById('locViewerLiveStatus');

    if (titleEl) titleEl.textContent = locationData.location_name || (locationData.is_live ? 'Live Location' : 'Location Pin');
    if (subtitleEl) subtitleEl.textContent = `${lat.toFixed(5)}° N, ${lng.toFixed(5)}° E`;
    if (addrEl) addrEl.textContent = locationData.location_address || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    if (updatedEl) updatedEl.textContent = locationData.is_live ? 'Live tracking' : 'Static pinpoint';

    if (dirBtn) {
      dirBtn.href = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
    }

    const isEnded = locationData.is_live_ended || (locationData.live_expires_at && new Date() > new Date(locationData.live_expires_at));

    if (locationData.is_live && !isEnded) {
      if (liveBanner) liveBanner.classList.remove('hidden');
      if (liveStatus) liveStatus.textContent = 'Live Location Active';
      if (stopBtn && isFromMe) {
        stopBtn.classList.remove('hidden');
      } else if (stopBtn) {
        stopBtn.classList.add('hidden');
      }
    } else {
      if (liveBanner) liveBanner.classList.add('hidden');
      if (stopBtn) stopBtn.classList.add('hidden');
    }

    // Initialize or update Viewer Map
    initViewerMap(lat, lng, locationData.is_live && !isEnded);
  }

  function initViewerMap(lat, lng, isLive) {
    const mapEl = document.getElementById('locViewerMap');
    if (!mapEl || typeof L === 'undefined') return;

    if (!viewerMap) {
      viewerMap = L.map('locViewerMap', {
        zoomControl: false,
        attributionControl: false
      }).setView([lat, lng], 16);

      L.control.zoom({ position: 'topright' }).addTo(viewerMap);

      L.tileLayer(getTileUrl(), {
        maxZoom: 19,
        attribution: tileAttrib
      }).addTo(viewerMap);

      viewerMarker = L.marker([lat, lng], {
        icon: createPinIcon(isLive)
      }).addTo(viewerMap);

      viewerAccuracyCircle = L.circle([lat, lng], {
        radius: 20,
        color: '#10b981',
        fillColor: '#10b981',
        fillOpacity: 0.15,
        weight: 1.5
      }).addTo(viewerMap);
    } else {
      viewerMap.setView([lat, lng], 16);
      if (viewerMarker) {
        viewerMarker.setLatLng([lat, lng]);
        viewerMarker.setIcon(createPinIcon(isLive));
      }
      if (viewerAccuracyCircle) {
        viewerAccuracyCircle.setLatLng([lat, lng]);
      }
    }

    setTimeout(() => {
      if (viewerMap) viewerMap.invalidateSize();
    }, 150);
  }

  function recenterViewer() {
    if (viewerMap && currentViewingLoc) {
      viewerMap.setView([parseFloat(currentViewingLoc.latitude), parseFloat(currentViewingLoc.longitude)], 16);
    }
  }

  function stopCurrentLiveFromViewer() {
    if (!currentViewingLoc || !currentViewingLoc.message_id) return;
    stopLiveLocation(currentViewingLoc.message_id, currentViewingLoc.is_group);
    closeViewer();
  }

  function closeViewer() {
    const modal = document.getElementById('locationViewerModal');
    if (modal) modal.classList.add('hidden');
    currentViewingLoc = null;
  }

  // ── WebSocket Incoming Event Handlers ─────────────────────────────────────

  function handleIncomingLiveUpdate(data) {
    const msgId = data.message_id;
    const newLat = parseFloat(data.latitude);
    const newLng = parseFloat(data.longitude);

    // 1. Update full viewer modal if currently viewing this message
    if (currentViewingLoc && currentViewingLoc.message_id === msgId) {
      currentViewingLoc.latitude = newLat;
      currentViewingLoc.longitude = newLng;
      if (viewerMarker) {
        viewerMarker.setLatLng([newLat, newLng]);
      }
      if (viewerAccuracyCircle) {
        viewerAccuracyCircle.setLatLng([newLat, newLng]);
      }
      const updatedEl = document.getElementById('locViewerLastUpdated');
      if (updatedEl) updatedEl.textContent = 'Updated just now';
    }

    // 2. Update mini-map on message bubble if open
    const bubbleCard = document.getElementById(`loc-bubble-${msgId}`);
    if (bubbleCard) {
      const subtitle = bubbleCard.querySelector('.sdh-loc-subtitle');
      if (subtitle) subtitle.textContent = 'Live location updating...';
    }
  }

  function handleIncomingLiveStopped(data) {
    const msgId = data?.message_id;
    if (!msgId) return;

    // Update in-memory cached location object
    const loc = messageLocations.get(String(msgId));
    if (loc) {
      loc.is_live_ended = true;
    }

    // Update in-bubble card badge
    const cardSelectors = [
      `#loc-bubble-${msgId}`,
      `[data-message-id="${msgId}"] .sdh-location-msg-card`,
      `[data-msg-id="${msgId}"]`,
      `#msg-${msgId} .sdh-location-msg-card`
    ];

    let bubbleCard = null;
    for (const sel of cardSelectors) {
      const found = document.querySelector(sel);
      if (found) {
        bubbleCard = found;
        break;
      }
    }

    if (bubbleCard) {
      const badge = bubbleCard.querySelector('.sdh-loc-badge');
      if (badge) {
        badge.className = 'sdh-loc-badge inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-slate-900/90 text-slate-300 border border-slate-600 shadow-md backdrop-blur-md';
        badge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span><span>Live ended</span>`;
      }
      const stopBtn = bubbleCard.querySelector('.sdh-loc-btn-stop') || bubbleCard.querySelector('.sdh-loc-stop-btn');
      if (stopBtn) stopBtn.remove();
    }

    // Update viewer modal if open
    if (currentViewingLoc && String(currentViewingLoc.message_id) === String(msgId)) {
      currentViewingLoc.is_live_ended = true;
      const stopBtn = document.getElementById('locViewerStopBtn');
      if (stopBtn) stopBtn.classList.add('hidden');
      const liveBanner = document.getElementById('locViewerLiveBanner');
      if (liveBanner) liveBanner.classList.add('hidden');
      const liveStatus = document.getElementById('locViewerLiveStatus');
      if (liveStatus) liveStatus.textContent = 'Live ended';
      if (viewerMarker) {
        viewerMarker.setIcon(createPinIcon(false));
      }
    }
  }

  // ── Helper Utilities ──────────────────────────────────────────────────────

  function getCookie(name) {
    let cookieValue = null;
    if (document.cookie && document.cookie !== '') {
      const cookies = document.cookie.split(';');
      for (let i = 0; i < cookies.length; i++) {
        const cookie = cookies[i].trim();
        if (cookie.substring(0, name.length + 1) === (name + '=')) {
          cookieValue = decodeURIComponent(cookie.substring(name.length + 1));
          break;
        }
      }
    }
    return cookieValue;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeJsString(str) {
    if (!str) return '';
    return String(str).replace(/'/g, "\\'").replace(/"/g, '\\"');
  }

  // Public API
  return {
    openModal,
    closeModal,
    switchTab,
    selectDuration,
    recenterGPS,
    searchPlaces,
    selectSearchResult,
    clearSearch,
    submitLocation,
    stopLiveLocation,
    buildCardHtml,
    openViewer,
    closeViewer,
    recenterViewer,
    stopCurrentLiveFromViewer,
    handleIncomingLiveUpdate,
    handleIncomingLiveStopped
  };
})();
