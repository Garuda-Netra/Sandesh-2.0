/**
 * Sandesh 2.0 - Nearby WebRTC Subsystem
 * =======================================
 * Dedicated peer-to-peer WebRTC DataChannel engine for local Wi-Fi / Hotspot mesh.
 *
 * Security & Network Boundaries:
 * - Strictly isolated from online voice/video calling in `SDH.WebRTC` (webrtc.js).
 * - Offline-first configuration: `iceServers: []`. Never queries public STUN/TURN servers.
 * - Prioritizes and accepts only local/host ICE candidates (`typ host`).
 * - Full gathering promise ensures complete SDP is bundled into QR code without trickle signaling.
 * - Wire encryption: DTLS-SRTP / SCTP over DTLS (RFC 8831) natively secures all DataChannel packets.
 * - Explicit connection states: PAIRING, CONNECTING, CONNECTED, FAILED, DISCONNECTED.
 */

'use strict';

window.SDH = window.SDH || {};

SDH.NearbyWebRTC = (() => {

  // ── Connection States ────────────────────────────────────────────────
  const STATES = {
    IDLE: 'idle',
    PAIRING: 'pairing',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    FAILED: 'failed',
    DISCONNECTED: 'disconnected'
  };

  // Dedicated WebRTC configuration for Nearby Mode (No Internet / No STUN / No TURN)
  const NEARBY_RTC_CONFIG = {
    iceServers: [], // Strictly EMPTY — No STUN/TURN dependency!
    iceCandidatePoolSize: 0
  };

  const DATA_CHANNEL_LABEL = 'sandesh-nearby-mesh';

  let currentPeerConnection = null;
  let activeDataChannel = null;
  let currentRemotePeer = null; // { peerId, username, displayName, safetyCode, isVerified }
  let currentState = STATES.IDLE;
  let stateListeners = new Set();
  let messageListeners = new Set();
  let connectionTimeout = null;

  // ── State Emitter ────────────────────────────────────────────────────

  function _setState(newState, detail = {}) {
    const oldState = currentState;
    currentState = newState;
    console.log(`[SDH.NearbyWebRTC] State transition: ${oldState} -> ${newState}`, detail);

    const eventData = {
      state: newState,
      oldState: oldState,
      peer: currentRemotePeer,
      detail: detail
    };

    stateListeners.forEach((listener) => {
      try {
        listener(eventData);
      } catch (err) {
        console.error('[SDH.NearbyWebRTC] State listener error:', err);
      }
    });

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('sdh:nearby-connection-state', { detail: eventData }));
    }
  }

  // ── Host Candidate Filtering & Gathering ─────────────────────────────

  /**
   * Waits for host ICE candidates to be gathered up to a short timeout.
   * Filters out any non-host candidates.
   */
  function _waitForHostCandidates(pc, maxWaitMs = 1500) {
    return new Promise((resolve) => {
      const candidates = [];
      let timeoutHandle = null;

      const finishGathering = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        pc.removeEventListener('icecandidate', onCandidate);
        resolve(candidates);
      };

      const onCandidate = (event) => {
        if (!event.candidate || !event.candidate.candidate) {
          // Gathering complete (null candidate)
          finishGathering();
          return;
        }

        const candStr = event.candidate.candidate;
        // Prioritize local / host candidates only
        if (candStr.includes('typ host') || event.candidate.type === 'host') {
          candidates.push({
            candidate: candStr,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex
          });
        }
      };

      pc.addEventListener('icecandidate', onCandidate);

      // Check if gathering is already complete
      if (pc.iceGatheringState === 'complete') {
        resolve(candidates);
        return;
      }

      timeoutHandle = setTimeout(() => {
        console.log('[SDH.NearbyWebRTC] Host candidate gathering window ended with', candidates.length, 'candidates');
        finishGathering();
      }, maxWaitMs);
    });
  }

  // ── DataChannel Setup ────────────────────────────────────────────────

  function _setupDataChannel(channel, peerInfo) {
    activeDataChannel = channel;
    activeDataChannel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      console.log('[SDH.NearbyWebRTC] DataChannel OPENED for peer:', peerInfo?.username);
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
      }
      _setState(STATES.CONNECTED, { peer: peerInfo });
    };

    channel.onclose = () => {
      console.log('[SDH.NearbyWebRTC] DataChannel CLOSED for peer:', peerInfo?.username);
      _setState(STATES.DISCONNECTED, { peer: peerInfo });
    };

    channel.onerror = (err) => {
      console.error('[SDH.NearbyWebRTC] DataChannel ERROR:', err);
      _setState(STATES.FAILED, { error: err });
    };

    channel.onmessage = (event) => {
      _handleIncomingData(event.data);
    };
  }

  function _handleIncomingData(data) {
    try {
      let parsed;
      if (typeof data === 'string') {
        parsed = JSON.parse(data);
      } else {
        const text = new TextDecoder().decode(data);
        parsed = JSON.parse(text);
      }

      messageListeners.forEach((listener) => {
        try {
          listener(parsed, currentRemotePeer);
        } catch (err) {
          console.error('[SDH.NearbyWebRTC] Message listener error:', err);
        }
      });
    } catch (err) {
      console.warn('[SDH.NearbyWebRTC] Error decoding DataChannel payload:', err);
    }
  }

  // ── Peer Connection Lifecycle ────────────────────────────────────────

  function _createPeerConnection(remotePeer) {
    _cleanup();

    currentRemotePeer = remotePeer || null;
    const pc = new RTCPeerConnection(NEARBY_RTC_CONFIG);
    currentPeerConnection = pc;

    pc.onconnectionstatechange = () => {
      console.log('[SDH.NearbyWebRTC] Connection state:', pc.connectionState);
      switch (pc.connectionState) {
        case 'connecting':
          _setState(STATES.CONNECTING);
          break;
        case 'connected':
          // DataChannel onopen will set CONNECTED state
          break;
        case 'failed':
          _setState(STATES.FAILED, { reason: 'ICE/DTLS connection failed' });
          break;
        case 'disconnected':
        case 'closed':
          _setState(STATES.DISCONNECTED);
          break;
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[SDH.NearbyWebRTC] ICE connection state:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        _setState(STATES.FAILED, { reason: 'Local ICE negotiation failed' });
      } else if (pc.iceConnectionState === 'disconnected') {
        _setState(STATES.DISCONNECTED);
      }
    };

    pc.ondatachannel = (event) => {
      console.log('[SDH.NearbyWebRTC] Remote peer opened DataChannel:', event.channel.label);
      _setupDataChannel(event.channel, currentRemotePeer);
    };

    return pc;
  }

  function _cleanup() {
    if (connectionTimeout) {
      clearTimeout(connectionTimeout);
      connectionTimeout = null;
    }
    if (activeDataChannel) {
      try {
        activeDataChannel.close();
      } catch (e) { }
      activeDataChannel = null;
    }
    if (currentPeerConnection) {
      try {
        currentPeerConnection.close();
      } catch (e) { }
      currentPeerConnection = null;
    }
  }

  // ── Public Pairing Operations ────────────────────────────────────────

  /**
   * Initiator Flow: Creates WebRTC offer, creates DataChannel, gathers local host candidates.
   *
   * @param {Object} peerProfile - Local user identity profile
   * @returns {Promise<{ sdp: string, candidates: Array }>}
   */
  async function createOffer(peerProfile) {
    _setState(STATES.PAIRING, { role: 'initiator' });
    const pc = _createPeerConnection();

    // Create bidirectional DataChannel
    const dc = pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
    _setupDataChannel(dc, null);

    // Create offer with DTLS
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Gather local host ICE candidates
    const candidates = await _waitForHostCandidates(pc);

    return {
      sdp: pc.localDescription.sdp,
      type: pc.localDescription.type,
      candidates: candidates
    };
  }

  /**
   * Receiver Flow: Receives remote offer, creates answer, gathers local host candidates.
   *
   * @param {Object} offerData - { sdp, candidates, remotePeer }
   * @returns {Promise<{ sdp: string, candidates: Array }>}
   */
  async function handleOffer(offerData) {
    _setState(STATES.PAIRING, { role: 'receiver', remotePeer: offerData.remotePeer });
    const pc = _createPeerConnection(offerData.remotePeer);

    // Apply remote offer description
    await pc.setRemoteDescription(new RTCSessionDescription({
      type: 'offer',
      sdp: offerData.sdp
    }));

    // Add provided remote host candidates
    if (Array.isArray(offerData.candidates)) {
      for (const cand of offerData.candidates) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(cand));
        } catch (candErr) {
          console.warn('[SDH.NearbyWebRTC] Non-fatal ICE candidate add error:', candErr);
        }
      }
    }

    // Create answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // Gather local host ICE candidates
    const candidates = await _waitForHostCandidates(pc);

    _armConnectionTimeout(25_000);

    return {
      sdp: pc.localDescription.sdp,
      type: pc.localDescription.type,
      candidates: candidates
    };
  }

  /**
   * Initiator Flow Completion: Sets remote answer received from scanner.
   *
   * @param {Object} answerData - { sdp, candidates, remotePeer }
   */
  async function handleAnswer(answerData) {
    if (!currentPeerConnection) {
      throw new Error('No active pairing session found.');
    }

    currentRemotePeer = answerData.remotePeer || currentRemotePeer;
    _setState(STATES.CONNECTING, { remotePeer: currentRemotePeer });

    await currentPeerConnection.setRemoteDescription(new RTCSessionDescription({
      type: 'answer',
      sdp: answerData.sdp
    }));

    if (Array.isArray(answerData.candidates)) {
      for (const cand of answerData.candidates) {
        try {
          await currentPeerConnection.addIceCandidate(new RTCIceCandidate(cand));
        } catch (candErr) {
          console.warn('[SDH.NearbyWebRTC] Non-fatal candidate add error:', candErr);
        }
      }
    }

    _armConnectionTimeout(25_000);
  }

  function _armConnectionTimeout(timeoutMs) {
    if (connectionTimeout) clearTimeout(connectionTimeout);
    connectionTimeout = setTimeout(() => {
      if (currentState !== STATES.CONNECTED) {
        console.warn('[SDH.NearbyWebRTC] Connection timed out waiting for DataChannel to open.');
        _setState(STATES.FAILED, { reason: 'Connection timed out. Check local Wi-Fi / Hotspot.' });
        _cleanup();
      }
    }, timeoutMs);
  }

  /**
   * Transmits a message or object payload over the direct WebRTC DataChannel.
   *
   * @param {Object|string} data
   * @returns {boolean} True if sent successfully
   */
  function send(data) {
    if (!activeDataChannel || activeDataChannel.readyState !== 'open') {
      console.warn('[SDH.NearbyWebRTC] Cannot send: DataChannel is not open (State: ' + currentState + ')');
      return false;
    }

    try {
      const payloadStr = typeof data === 'string' ? data : JSON.stringify(data);
      activeDataChannel.send(payloadStr);
      return true;
    } catch (err) {
      console.error('[SDH.NearbyWebRTC] Send failed:', err);
      return false;
    }
  }

  function disconnect() {
    _cleanup();
    _setState(STATES.DISCONNECTED);
  }

  function getState() {
    return currentState;
  }

  function getRemotePeer() {
    return currentRemotePeer;
  }

  function isConnected() {
    return currentState === STATES.CONNECTED && activeDataChannel?.readyState === 'open';
  }

  function onStateChange(callback) {
    if (typeof callback === 'function') stateListeners.add(callback);
    return () => stateListeners.delete(callback);
  }

  function onMessage(callback) {
    if (typeof callback === 'function') messageListeners.add(callback);
    return () => messageListeners.delete(callback);
  }

  // ── Public API ───────────────────────────────────────────────────────

  return {
    STATES,
    createOffer,
    handleOffer,
    handleAnswer,
    send,
    disconnect,
    getState,
    getRemotePeer,
    isConnected,
    onStateChange,
    onMessage
  };

})();
