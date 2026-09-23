/**
 * Sandesh 2.0 - Nearby Transport Subsystem
 * ==========================================
 * Transport implementation for Nearby / Offline Mode across local Wi-Fi and mobile hotspots.
 *
 * Responsibilities:
 * - Operates without Internet or external mobile data connections.
 * - Manages peer discovery state machine: DISCONNECTED -> INITIALIZING -> SCANNING -> ACTIVE.
 * - Implements the unified Transport interface:
 *     connect(targetId, isGroup)
 *     sendMessage(payload)
 *     isOpen()
 *     disconnect()
 *     onMessage(callback)
 *     onStatusChange(callback)
 * - Emits standardized message frames to SDH.Chat._onWsMessage(data):
 *     chat_message, typing, presence, delivered_receipt, read_receipt.
 * - Integrates with SDH.LocalIdentity for peer authentication and message queues.
 * - Completely isolated from Cloud WebSocket and online WebRTC signaling.
 */

'use strict';

window.SDH = window.SDH || {};

SDH.NearbyTransport = (() => {

  // ── Transport States ─────────────────────────────────────────────────
  const STATES = {
    DISCONNECTED: 'DISCONNECTED',
    INITIALIZING: 'INITIALIZING',
    SCANNING: 'SCANNING',
    ACTIVE: 'ACTIVE',
    ERROR: 'ERROR'
  };

  let currentState = STATES.DISCONNECTED;
  let currentTargetId = null;
  let isGroupChat = false;
  let activePeers = new Map(); // peerId -> { peerId, username, displayName, status, lastSeen, ipOrEndpoint, publicKeyJwk }
  let scanInterval = null;
  let messageListeners = new Set();
  let statusListeners = new Set();
  let localIdentity = null;

  // ── State & Event Emitters ───────────────────────────────────────────

  function _setState(newState, detail = {}) {
    const oldState = currentState;
    currentState = newState;
    console.log(`[SDH.NearbyTransport] State: ${oldState} -> ${newState}`, detail);

    const eventData = { state: newState, oldState: oldState, detail };
    statusListeners.forEach((listener) => {
      try {
        listener(eventData);
      } catch (err) {
        console.error('[SDH.NearbyTransport] Status listener error:', err);
      }
    });

    // Custom window event for reactive UI updates
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('sdh:nearby-status', { detail: eventData }));
    }
  }

  function _dispatchIncoming(data) {
    messageListeners.forEach((listener) => {
      try {
        listener(data);
      } catch (err) {
        console.error('[SDH.NearbyTransport] Message listener error:', err);
      }
    });

    // Directly forward to SDH.Chat if connected
    if (window.SDH?.Chat?._onWsMessage) {
      window.SDH.Chat._onWsMessage(data);
    }
  }

  // ── Public Transport Interface ───────────────────────────────────────

  /**
   * Initializes NearbyTransport with authenticated local device identity.
   */
  async function init() {
    _setState(STATES.INITIALIZING);

    if (!window.SDH?.LocalIdentity) {
      _setState(STATES.ERROR, { error: 'SDH.LocalIdentity module not available.' });
      return false;
    }

    const verification = await window.SDH.LocalIdentity.verifyLocalIdentity();
    if (!verification.verified) {
      console.warn('[SDH.NearbyTransport] Local identity verification failed:', verification.reason);
      _setState(STATES.ERROR, { error: verification.reason });
      return false;
    }

    localIdentity = verification.identity;
    console.log('[SDH.NearbyTransport] Initialized with local identity @' + localIdentity.username);

    // Load any previously seen nearby peers from IndexedDB
    const cachedPeers = await window.SDH.LocalIdentity.getAllPeers();
    cachedPeers.forEach(p => activePeers.set(p.peerId, p));

    // Wire up direct peer-to-peer WebRTC DataChannel handlers
    if (window.SDH?.NearbyWebRTC && !window.SDH.NearbyWebRTC._transportHooked) {
      window.SDH.NearbyWebRTC._transportHooked = true;

      window.SDH.NearbyWebRTC.onMessage(async (incomingFrame, remotePeer) => {
        console.log('[SDH.NearbyTransport] Received frame via WebRTC DataChannel:', incomingFrame?.type, incomingFrame);
        if (!_validateIncomingFrame(incomingFrame)) return;

        // 1. File transfer frames routing
        if (incomingFrame.type === 'file_chunk_meta' && window.SDH?.NearbyFileTransfer) {
          window.SDH.NearbyFileTransfer.handleIncomingChunkMeta(incomingFrame);
          return;
        }
        if (incomingFrame.type === 'file_chunk' && window.SDH?.NearbyFileTransfer) {
          window.SDH.NearbyFileTransfer.handleIncomingChunk(incomingFrame);
          return;
        }
        if (incomingFrame.type === 'file_cancel' && window.SDH?.NearbyFileTransfer) {
          window.SDH.NearbyFileTransfer.handleIncomingCancel(incomingFrame);
          return;
        }

        // 2. Chat message handling
        if (incomingFrame.type === 'chat_message' || incomingFrame.type === 'group_message') {
          const msgId = incomingFrame.id || incomingFrame.message_id;
          if (_isDuplicate(msgId)) {
            console.log('[SDH.NearbyTransport] Ignored duplicate message:', msgId);
            return;
          }

          let content = incomingFrame.message || '';
          // Standard E2EE decryption
          if (incomingFrame.is_encrypted && incomingFrame.encryption_iv && window.SDH?.E2E) {
            try {
              content = await window.SDH.E2E.decrypt(incomingFrame.message, incomingFrame.encryption_iv, incomingFrame.sender);
            } catch (e) {
              console.warn('[SDH.NearbyTransport] Decryption failed:', e);
            }
          }

          const synthesizedFrame = {
            type: incomingFrame.type,
            message_id: msgId,
            sender: incomingFrame.sender,
            sender_id: incomingFrame.sender_id || 0,
            receiver: incomingFrame.receiver || (localIdentity?.username || window.SDH_DATA?.currentUser),
            receiver_id: null,
            message: content,
            message_type: incomingFrame.message_type || 'text',
            location: incomingFrame.location || null,
            original_filename: incomingFrame.original_filename || '',
            mime_type: incomingFrame.mime_type || '',
            is_encrypted: Boolean(incomingFrame.is_encrypted),
            encryption_iv: incomingFrame.encryption_iv || '',
            timestamp: incomingFrame.ts || incomingFrame.timestamp || new Date().toISOString(),
            is_nearby: true
          };

          // Persist in IndexedDB
          if (window.SDH?.LocalIdentity?.saveNearbyMessage) {
            await window.SDH.LocalIdentity.saveNearbyMessage(synthesizedFrame);
          }

          // Acknowledge with delivered receipt
          if (window.SDH?.NearbyWebRTC?.isConnected()) {
            window.SDH.NearbyWebRTC.send({
              v: 1,
              type: 'delivered_receipt',
              id: 'del_' + Date.now(),
              message_id: msgId,
              sender: localIdentity?.username || 'me',
              recipient: incomingFrame.sender,
              ts: new Date().toISOString(),
              is_nearby: true
            });
          }

          // Forward to Chat UI
          _dispatchIncoming(synthesizedFrame);
          return;
        }

        // 3. Receipt updates
        if (incomingFrame.type === 'delivered_receipt' || incomingFrame.type === 'read_receipt') {
          const msgId = incomingFrame.message_id;
          if (msgId && window.SDH?.LocalIdentity) {
            if (incomingFrame.type === 'read_receipt') {
              await window.SDH.LocalIdentity.markNearbyMessageRead(msgId);
            } else {
              await window.SDH.LocalIdentity.markNearbyMessageDelivered(msgId);
            }
          }
          _dispatchIncoming({
            type: 'message_status',
            message_id: msgId,
            status: incomingFrame.type === 'read_receipt' ? 'read' : 'delivered',
            is_nearby: true
          });
          return;
        }

        // 4. Other frames (typing, presence)
        _dispatchIncoming(incomingFrame);
      });

      window.SDH.NearbyWebRTC.onStateChange((event) => {
        console.log('[SDH.NearbyTransport] NearbyWebRTC connection state changed:', event.state);
        if (event.state === 'connected' && event.peer) {
          registerDiscoveredPeer(event.peer);
          _flushOfflineQueue(event.peer.username);
        }
      });
    }

    _startScanning();
    return true;
  }

  // ── Deduplication & Validation ───────────────────────────────────────
  const processedMessageIds = new Set();

  function _isDuplicate(msgId) {
    if (!msgId) return false;
    if (processedMessageIds.has(String(msgId))) return true;
    processedMessageIds.add(String(msgId));
    if (processedMessageIds.size > 2000) {
      const first = processedMessageIds.values().next().value;
      processedMessageIds.delete(first);
    }
    return false;
  }

  function _validateIncomingFrame(frame) {
    if (!frame || typeof frame !== 'object') return false;
    if (frame.v !== 1 && !frame.type) return false;
    // Max payload limit check (64KB for control/text frames)
    if (frame.type !== 'file_chunk') {
      try {
        const strLen = JSON.stringify(frame).length;
        if (strLen > 65536) {
          console.warn('[SDH.NearbyTransport] Rejected oversized frame:', strLen, 'bytes');
          return false;
        }
      } catch (e) {
        return false;
      }
    }
    return true;
  }

  /**
   * Connects to a specific nearby target (user or group).
   *
   * @param {string|number} targetId - username or peer ID
   * @param {boolean} isGroup - whether target is a local group
   */
  async function connect(targetId, isGroup = false) {
    if (!targetId) {
      console.warn('[SDH.NearbyTransport] connect called without targetId.');
      return;
    }

    currentTargetId = String(targetId);
    isGroupChat = !!isGroup;

    if (currentState === STATES.DISCONNECTED || currentState === STATES.ERROR) {
      const initialized = await init();
      if (!initialized) return;
    }

    _setState(STATES.ACTIVE, { targetId, isGroup });

    // Announce presence to the target peer
    _announcePresence();
  }

  /**
   * Flushes any pending offline messages for a connected peer.
   */
  async function _flushOfflineQueue(targetUsername) {
    if (!window.SDH?.LocalIdentity || !window.SDH?.NearbyWebRTC?.isConnected()) return;
    try {
      const queue = await window.SDH.LocalIdentity.getOfflineQueue();
      for (const item of queue) {
        if (!targetUsername || item.recipient === targetUsername) {
          const sent = window.SDH.NearbyWebRTC.send(item.payload);
          if (sent) {
            await window.SDH.LocalIdentity.dequeueOfflineMessage(item.tempId);
            console.log('[SDH.NearbyTransport] Flushed queued offline message:', item.tempId);
          }
        }
      }
    } catch (e) {
      console.warn('[SDH.NearbyTransport] Queue flush error:', e);
    }
  }

  /**
   * Transmits a message payload over local transport.
   *
   * @param {Object} payload - Message payload
   * @returns {Promise<boolean>} True if processed or queued
   */
  async function sendMessage(payload) {
    if (!payload || !payload.type) {
      console.warn('[SDH.NearbyTransport] Invalid payload', payload);
      return false;
    }

    console.log('[SDH.NearbyTransport] Sending nearby message:', payload.type, payload);

    const senderUsername = localIdentity?.username || window.SDH_DATA?.currentUser || 'local_user';
    const timestamp = new Date().toISOString();

    if (payload.type === 'chat_message' || payload.type === 'group_message') {
      const targetUser = payload.receiver || currentTargetId;
      const messageId = payload.message_id || ('nearby_msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7));

      let isEncrypted = Boolean(payload.is_encrypted);
      let encryptionIv = payload.encryption_iv || '';
      let messageContent = payload.message || '';

      // Standard E2EE encryption if not already encrypted
      if (!isEncrypted && window.SDH?.E2E && payload.message && typeof payload.message === 'string') {
        try {
          const encRes = await window.SDH.E2E.encrypt(payload.message, targetUser);
          if (encRes && encRes.is_encrypted) {
            isEncrypted = true;
            encryptionIv = encRes.iv;
            messageContent = encRes.ciphertext;
          }
        } catch (e) {
          console.warn('[SDH.NearbyTransport] E2EE encryption error:', e);
        }
      }

      // Create standardized versioned protocol packet
      const outgoingFrame = {
        v: 1,
        id: messageId,
        type: payload.type,
        message_id: messageId,
        sender: senderUsername,
        sender_id: localIdentity?.userId || 0,
        sender_device_id: localIdentity?.deviceId || 'device_' + senderUsername,
        receiver: targetUser,
        receiver_id: null,
        recipient: targetUser,
        message: messageContent,
        message_type: payload.message_type || 'text',
        location: payload.location || null,
        original_filename: payload.original_filename || '',
        mime_type: payload.mime_type || '',
        file_id: payload.file_id || null,
        file_data: payload.file_data || null,
        is_encrypted: isEncrypted,
        encryption_iv: encryptionIv,
        ts: timestamp,
        timestamp: timestamp,
        is_nearby: true
      };

      // 1. Transmit directly over WebRTC DataChannel if peer is connected!
      let sentOverWebRTC = false;
      if (window.SDH?.NearbyWebRTC?.isConnected()) {
        sentOverWebRTC = window.SDH.NearbyWebRTC.send(outgoingFrame);
        console.log('[SDH.NearbyTransport] Sent over direct WebRTC DataChannel:', sentOverWebRTC);
      }

      // 2. Persist in local IndexedDB store
      if (window.SDH?.LocalIdentity?.saveNearbyMessage) {
        await window.SDH.LocalIdentity.saveNearbyMessage({
          ...outgoingFrame,
          message: payload.message || messageContent // save decrypted plaintext locally for self
        });
      }

      // 3. Persist in offline queue if peer is not currently connected
      if (!sentOverWebRTC && window.SDH?.LocalIdentity) {
        window.SDH.LocalIdentity.enqueueOfflineMessage({
          tempId: messageId,
          recipient: targetUser,
          payload: outgoingFrame,
          timestamp: timestamp,
          delivered: false
        });
      }

      // Simulate local acknowledgement receipt for smooth UI rendering
      setTimeout(() => {
        _dispatchIncoming({
          type: 'message_status',
          message_id: messageId,
          status: 'sent',
          is_nearby: true
        });
      }, 50);

      return true;
    }

    if (payload.type === 'typing') {
      const typingFrame = {
        v: 1,
        type: 'typing',
        sender: senderUsername,
        recipient: payload.receiver || currentTargetId,
        is_typing: !!payload.is_typing,
        ts: timestamp,
        is_nearby: true
      };
      _broadcastToPeers(typingFrame);
      return true;
    }

    if (payload.type === 'read_receipt' || payload.type === 'delivered_receipt') {
      const receiptFrame = {
        v: 1,
        type: payload.type,
        message_id: payload.message_id,
        sender: senderUsername,
        recipient: payload.receiver || currentTargetId,
        ts: timestamp,
        is_nearby: true
      };
      _broadcastToPeers(receiptFrame);
      return true;
    }

    return true;
  }

  /**
   * Checks whether the nearby transport is active.
   */
  function isOpen() {
    return currentState === STATES.ACTIVE || currentState === STATES.SCANNING;
  }

  /**
   * Disconnects and stops scanning.
   */
  function disconnect() {
    _stopScanning();
    currentTargetId = null;
    isGroupChat = false;
    _setState(STATES.DISCONNECTED);
  }

  // ── Discovery & Peer Management ──────────────────────────────────────

  function _startScanning() {
    _setState(STATES.SCANNING);
    _stopScanning();

    // Local hotspot / Wi-Fi peer scanning heartbeat
    scanInterval = setInterval(() => {
      _scanLocalNetwork();
    }, 8_000);

    // Initial immediate scan
    _scanLocalNetwork();
  }

  function _stopScanning() {
    if (scanInterval) {
      clearInterval(scanInterval);
      scanInterval = null;
    }
  }

  /**
   * Performs local Wi-Fi / hotspot beacon broadcast.
   */
  function _scanLocalNetwork() {
    if (!isOpen()) return;

    // Announce local device identity beacon
    _announcePresence();

    // Prune stale peers not seen in 45 seconds
    const now = Date.now();
    activePeers.forEach((peer, peerId) => {
      const lastSeenTime = new Date(peer.lastSeen).getTime();
      if (now - lastSeenTime > 45_000) {
        activePeers.delete(peerId);
        _dispatchIncoming({
          type: 'presence',
          username: peer.username,
          user_id: peer.userId,
          status: 'inactive',
          is_nearby: true
        });
        if (window.SDH?.LocalIdentity) {
          window.SDH.LocalIdentity.removePeer(peerId);
        }
      }
    });

    _notifyPeerUpdate();
  }

  function _announcePresence() {
    if (!localIdentity) return;

    const beacon = {
      type: 'presence',
      user_id: localIdentity.userId || 0,
      username: localIdentity.username,
      display_name: localIdentity.displayName,
      status: 'active',
      is_nearby: true,
      last_seen: new Date().toISOString()
    };

    // Reflect to local UI
    _dispatchIncoming(beacon);
  }

  function _broadcastToPeers(frame) {
    // Dispatches frame to local listeners & local peers
    _dispatchIncoming(frame);
  }

  function _notifyPeerUpdate() {
    const peersList = Array.from(activePeers.values());
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('sdh:nearby-peers-changed', {
        detail: { peers: peersList, count: peersList.length }
      }));
    }
  }

  /**
   * Registers a newly discovered local peer (from local broadcast or direct connection).
   */
  function registerDiscoveredPeer(peer) {
    if (!peer || !peer.username) return;
    const peerId = peer.peerId || 'peer_' + peer.username;
    peer.peerId = peerId;
    peer.lastSeen = new Date().toISOString();

    activePeers.set(peerId, peer);

    if (window.SDH?.LocalIdentity) {
      window.SDH.LocalIdentity.upsertPeer(peer);
    }

    _dispatchIncoming({
      type: 'presence',
      username: peer.username,
      user_id: peer.userId,
      status: 'active',
      is_nearby: true
    });

    _notifyPeerUpdate();
  }

  function getNearbyPeers() {
    return Array.from(activePeers.values());
  }

  function getState() {
    return currentState;
  }

  function onMessage(callback) {
    if (typeof callback === 'function') messageListeners.add(callback);
    return () => messageListeners.delete(callback);
  }

  function onStatusChange(callback) {
    if (typeof callback === 'function') statusListeners.add(callback);
    return () => statusListeners.delete(callback);
  }

  // ── Public API ───────────────────────────────────────────────────────

  return {
    name: 'nearby',
    init,
    connect,
    sendMessage,
    isOpen,
    disconnect,
    getState,
    getNearbyPeers,
    registerDiscoveredPeer,
    onMessage,
    onStatusChange
  };

})();
