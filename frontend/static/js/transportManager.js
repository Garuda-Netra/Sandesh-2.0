/**
 * Sandesh 2.0 - Transport Manager
 * =================================
 * Orchestrates connection routing between Cloud Mode (Django Channels) and
 * Nearby Mode (Local Wi-Fi / Hotspot Mesh).
 *
 * Responsibilities:
 * - Coordinates CloudTransport and NearbyTransport.
 * - Manages active mode state ('cloud' | 'nearby').
 * - Preserves existing SDH.WS behavior in Cloud Mode.
 * - Proxies SDH.WS methods so existing callers (chat.js, fileUpload.js)
 *   automatically communicate through the active transport without code rewrites.
 * - Enforces cryptographic identity verification before entering Nearby Mode.
 * - Emits 'sdh:modechange' events for responsive UI updates.
 */

'use strict';

window.SDH = window.SDH || {};

SDH.TransportManager = (() => {

  const MODE_CLOUD = 'cloud';
  const MODE_NEARBY = 'nearby';
  const STORAGE_KEY = 'sandesh_transport_mode';

  let currentMode = MODE_CLOUD;
  let modeListeners = new Set();
  let originalWsSend = null;
  let originalWsIsOpen = null;
  let originalWsConnect = null;

  // ── Cloud Transport Wrapper ──────────────────────────────────────────

  const CloudTransport = {
    name: MODE_CLOUD,
    connect: (targetId, isGroup = false) => {
      if (window.SDH?.WS?.connectWebSocket) {
        window.SDH.WS.connectWebSocket(targetId, isGroup);
      }
    },
    sendMessage: (payload) => {
      if (originalWsSend) {
        return originalWsSend(payload);
      }
      return window.SDH?.WS?.sendMessage ? window.SDH.WS.sendMessage(payload) : false;
    },
    isOpen: () => {
      if (originalWsIsOpen) {
        return originalWsIsOpen();
      }
      return window.SDH?.WS?.isOpen ? window.SDH.WS.isOpen() : false;
    },
    disconnect: () => {
      if (window.SDH?.WS?.disconnect) {
        window.SDH.WS.disconnect();
      }
    }
  };

  // ── Hook into SDH.WS for transparent caller compatibility ────────────

  function _hookExistingWS() {
    if (!window.SDH?.WS) return;

    if (!originalWsSend) {
      originalWsSend = window.SDH.WS.sendMessage.bind(window.SDH.WS);
      originalWsIsOpen = window.SDH.WS.isOpen.bind(window.SDH.WS);
      originalWsConnect = window.SDH.WS.connectWebSocket.bind(window.SDH.WS);

      // Wrap sendMessage to route according to active mode
      window.SDH.WS.sendMessage = function (payload) {
        if (currentMode === MODE_NEARBY && window.SDH?.NearbyTransport) {
          return window.SDH.NearbyTransport.sendMessage(payload);
        }
        return originalWsSend(payload);
      };

      // Wrap isOpen to return status of active transport
      window.SDH.WS.isOpen = function () {
        if (currentMode === MODE_NEARBY && window.SDH?.NearbyTransport) {
          return window.SDH.NearbyTransport.isOpen();
        }
        return originalWsIsOpen();
      };

      // Wrap connectWebSocket to route according to active mode
      window.SDH.WS.connectWebSocket = function (userId, isGroup = false) {
        if (currentMode === MODE_NEARBY && window.SDH?.NearbyTransport) {
          window.SDH.NearbyTransport.connect(userId, isGroup);
          return;
        }
        return originalWsConnect(userId, isGroup);
      };

      console.log('[SDH.TransportManager] Transparent hooks registered on SDH.WS');
    }
  }

  // ── Mode Management ──────────────────────────────────────────────────

  /**
   * Switches the active transport mode between Cloud and Nearby.
   *
   * @param {string} targetMode - 'cloud' | 'nearby'
   * @returns {Promise<{success: boolean, mode: string, reason?: string}>}
   */
  async function setMode(targetMode) {
    if (targetMode !== MODE_CLOUD && targetMode !== MODE_NEARBY) {
      console.warn('[SDH.TransportManager] Unknown mode:', targetMode);
      return { success: false, mode: currentMode, reason: 'Invalid mode.' };
    }

    if (targetMode === currentMode) {
      return { success: true, mode: currentMode };
    }

    // ── Switching to Nearby Mode ───────────────────────────────────────
    if (targetMode === MODE_NEARBY) {
      // 1. Verify local cryptographic device identity
      if (window.SDH?.LocalIdentity) {
        const verification = await window.SDH.LocalIdentity.verifyLocalIdentity();
        if (!verification.verified) {
          console.warn('[SDH.TransportManager] Cannot switch to Nearby Mode:', verification.reason);
          _showToast(verification.reason || 'Local identity verification required.', 'error');
          return { success: false, mode: currentMode, reason: verification.reason };
        }
      }

      // 2. Disconnect Cloud chat socket cleanly
      if (window.SDH?.WS?.disconnect) {
        window.SDH.WS.disconnect();
      }

      // 3. Initialize & activate Nearby Transport
      currentMode = MODE_NEARBY;
      try {
        localStorage.setItem(STORAGE_KEY, MODE_NEARBY);
      } catch (e) { }

      if (window.SDH?.NearbyTransport) {
        await window.SDH.NearbyTransport.init();
      }

      _showToast('Switched to Nearby Mode — Local Wi-Fi / Hotspot active', 'info');
      _notifyModeChange(MODE_NEARBY);
      return { success: true, mode: MODE_NEARBY };
    }

    // ── Switching to Cloud Mode ────────────────────────────────────────
    if (targetMode === MODE_CLOUD) {
      // 1. Disconnect Nearby transport
      if (window.SDH?.NearbyTransport?.disconnect) {
        window.SDH.NearbyTransport.disconnect();
      }

      currentMode = MODE_CLOUD;
      try {
        localStorage.setItem(STORAGE_KEY, MODE_CLOUD);
      } catch (e) { }

      // 2. Re-establish Cloud WebSocket connection
      if (originalWsConnect) {
        // Connect to current conversation or global notifications
        const activeUserId = window.SDH?.Chat?.activeUserId;
        const isGroup = window.SDH?.Chat?.isGroupChat;
        if (activeUserId) {
          originalWsConnect(activeUserId, isGroup);
        } else {
          originalWsConnect('global');
        }
      }

      _showToast('Switched to Cloud Mode — Internet connected', 'info');
      _notifyModeChange(MODE_CLOUD);
      return { success: true, mode: MODE_CLOUD };
    }
  }

  /**
   * Toggles between Cloud and Nearby modes.
   */
  async function toggleMode() {
    const nextMode = currentMode === MODE_CLOUD ? MODE_NEARBY : MODE_CLOUD;
    return await setMode(nextMode);
  }

  function getMode() {
    return currentMode;
  }

  function isNearby() {
    return currentMode === MODE_NEARBY;
  }

  function isCloud() {
    return currentMode === MODE_CLOUD;
  }

  function getActiveTransport() {
    return currentMode === MODE_NEARBY ? window.SDH?.NearbyTransport : CloudTransport;
  }

  function onModeChange(callback) {
    if (typeof callback === 'function') modeListeners.add(callback);
    return () => modeListeners.delete(callback);
  }

  function _notifyModeChange(mode) {
    const detail = { mode, isNearby: mode === MODE_NEARBY, isCloud: mode === MODE_CLOUD };

    modeListeners.forEach((listener) => {
      try {
        listener(detail);
      } catch (err) {
        console.error('[SDH.TransportManager] Listener error:', err);
      }
    });

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('sdh:modechange', { detail }));
    }
  }

  function _showToast(message, type = 'info') {
    if (typeof window.showToast === 'function') {
      window.showToast(message, type);
    } else if (window.SDH?.Chat?.showToast) {
      window.SDH.Chat.showToast(message, type);
    } else {
      console.log(`[SDH.TransportManager] [${type}] ${message}`);
    }
  }

  // ── Auto Initialization ──────────────────────────────────────────────
  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
      _hookExistingWS();

      // Check if user previously chosen Nearby Mode
      try {
        const savedMode = localStorage.getItem(STORAGE_KEY);
        if (savedMode === MODE_NEARBY) {
          // Verify if identity is available before auto-activating
          if (window.SDH?.LocalIdentity) {
            window.SDH.LocalIdentity.verifyLocalIdentity().then(res => {
              if (res.verified) {
                setMode(MODE_NEARBY);
              } else {
                setMode(MODE_CLOUD);
              }
            });
          }
        }
      } catch (e) { }
    });
  }

  // ── Public API ───────────────────────────────────────────────────────

  return {
    MODE_CLOUD,
    MODE_NEARBY,
    getMode,
    setMode,
    toggleMode,
    isNearby,
    isCloud,
    getActiveTransport,
    onModeChange
  };

})();
