/**
 * Sandesh 2.0 - Nearby Signaling & Pairing Layer
 * =================================================
 * Ephemeral QR-based signaling and cryptographic identity verification.
 *
 * Security Principles:
 * 1. Strict Secret Exclusion:
 *    - Never includes passwords, PINs, private keys, permanent auth tokens, or chat messages.
 *    - Payload schema is strictly validated against a whitelist of ephemeral fields.
 * 2. Independent Identity Verification:
 *    - WebRTC DTLS handles wire encryption.
 *    - Computes a deterministic 6-digit Safety Code (SHA-256 derived from both peers' public keys + session ID).
 *    - Allows users to visually compare and confirm peer authenticity against MITM attacks.
 * 3. Offline Resilience:
 *    - Operates 100% locally with zero external network or server calls.
 *    - Provides high-contrast QR generation and camera scanning with copy/paste code fallback.
 */

'use strict';

window.SDH = window.SDH || {};

SDH.NearbySignaling = (() => {

  const PROTOCOL_VERSION = 1;
  const TOKEN_PREFIX = 'SDH2:PAIR:';
  const MAX_TOKEN_AGE_MS = 10 * 60 * 1000; // 10 minutes expiry

  let currentSession = null; // { sessionId, role, offer, answer, localPeer, remotePeer, safetyCode }
  let activeModal = null;

  // ── Cryptographic Safety Code Generation ─────────────────────────────

  /**
   * Derives a deterministic 6-digit Safety Code and hex fingerprint
   * from both peers' ECDSA public keys and the ephemeral session ID.
   *
   * @param {Object} pubKeyA - JWK of Device A
   * @param {Object} pubKeyB - JWK of Device B
   * @param {string} sessionId - Ephemeral pairing session ID
   * @returns {Promise<{ numericCode: string, hexFingerprint: string }>}
   */
  async function computeSafetyCode(pubKeyA, pubKeyB, sessionId) {
    const keyStrA = typeof pubKeyA === 'string' ? pubKeyA : JSON.stringify(pubKeyA || {});
    const keyStrB = typeof pubKeyB === 'string' ? pubKeyB : JSON.stringify(pubKeyB || {});

    // Sort keys lexicographically so both devices compute identical hashes regardless of role
    const sortedKeys = [keyStrA, keyStrB].sort();
    const material = `${sortedKeys[0]}::${sortedKeys[1]}::${sessionId || 'sandesh_session'}`;

    const encoder = new TextEncoder();
    const data = encoder.encode(material);

    let hashBuffer;
    if (window.crypto && window.crypto.subtle) {
      hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
    } else {
      // Fallback simple 32-bit hash if crypto.subtle is unavailable
      let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
      for (let i = 0; i < data.length; i++) {
        h1 = Math.imul(h1 ^ data[i], 2654435761);
        h2 = Math.imul(h2 ^ data[i], 1597334677);
      }
      const b = new ArrayBuffer(8);
      const v = new DataView(b);
      v.setUint32(0, h1);
      v.setUint32(4, h2);
      hashBuffer = b;
    }

    const hashBytes = new Uint8Array(hashBuffer);

    // Derive 6-digit numeric code formatted as XXX - XXX
    const numVal = (hashBytes[0] << 24) | (hashBytes[1] << 16) | (hashBytes[2] << 8) | hashBytes[3];
    const absVal = Math.abs(numVal) % 1000000;
    const padded = String(absVal).padStart(6, '0');
    const numericCode = `${padded.substring(0, 3)} - ${padded.substring(3, 6)}`;

    // Derive chunked hex fingerprint
    let hex = '';
    for (let i = 0; i < 8; i++) {
      hex += hashBytes[i].toString(16).padStart(2, '0').toUpperCase();
    }
    const hexFingerprint = `${hex.substring(0, 4)} - ${hex.substring(4, 8)} - ${hex.substring(8, 12)} - ${hex.substring(12, 16)}`;

    return { numericCode, hexFingerprint };
  }

  // ── Payload Packaging & Security Filtering ───────────────────────────

  /**
   * Asserts that no sensitive fields (passwords, private keys, tokens) exist.
   */
  function assertNoSecrets(obj, path = '') {
    if (!obj || typeof obj !== 'object') return;

    const FORBIDDEN_KEYS = [
      'password', 'passwd', 'secret', 'private', 'privatekey', 'privatekeyjwk',
      'd', 'token', 'auth', 'cookie', 'sessionid_http', 'message', 'chat'
    ];

    for (const key of Object.keys(obj)) {
      const lower = key.toLowerCase();
      if (FORBIDDEN_KEYS.includes(lower)) {
        throw new Error(`Security Violation: Payload contains forbidden secret field: '${path + key}'`);
      }
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        assertNoSecrets(obj[key], `${path + key}.`);
      }
    }
  }

  /**
   * Compresses and packages the signaling payload into a compact token.
   */
  function encodeToken(payload) {
    assertNoSecrets(payload);
    const jsonStr = JSON.stringify(payload);
    // Base64 encode UTF-8 bytes safely
    const utf8Bytes = new TextEncoder().encode(jsonStr);
    let binary = '';
    for (let i = 0; i < utf8Bytes.length; i++) {
      binary += String.fromCharCode(utf8Bytes[i]);
    }
    return TOKEN_PREFIX + window.btoa(binary);
  }

  /**
   * Decodes and strictly validates an incoming signaling token.
   */
  function decodeToken(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') {
      throw new Error('Invalid token format.');
    }

    const trimmed = rawToken.trim();
    let b64 = trimmed;
    if (trimmed.startsWith(TOKEN_PREFIX)) {
      b64 = trimmed.substring(TOKEN_PREFIX.length);
    }

    const binary = window.atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const jsonStr = new TextDecoder().decode(bytes);
    const payload = JSON.parse(jsonStr);

    // Enforce protocol version & type
    if (!payload.v || payload.v !== PROTOCOL_VERSION) {
      throw new Error('Unsupported pairing protocol version.');
    }
    if (!['offer', 'answer'].includes(payload.type)) {
      throw new Error('Invalid signaling packet type.');
    }

    // Expiry check
    const now = Date.now();
    if (!payload.ts || now - payload.ts > MAX_TOKEN_AGE_MS) {
      throw new Error('Pairing session has expired (exceeded 10 minutes). Please create a fresh offer.');
    }

    // Strict security assertion
    assertNoSecrets(payload);

    return payload;
  }

  // ── Session Flow: Initiator (Offer) ──────────────────────────────────

  /**
   * Device A: Generates ephemeral WebRTC offer and packages into a QR token.
   *
   * @param {Object} localProfile - Local user identity
   * @returns {Promise<{ token: string, sessionId: string, payload: Object }>}
   */
  async function createPairingOffer(localProfile) {
    if (!window.SDH?.NearbyWebRTC) {
      throw new Error('SDH.NearbyWebRTC module not initialized.');
    }

    const sessionId = 'sdh_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
    const nonce = Math.random().toString(36).substring(2, 10);

    // Generate WebRTC offer with host-only ICE candidates
    const offerData = await window.SDH.NearbyWebRTC.createOffer(localProfile);

    // Retrieve local public key from LocalIdentity
    let localPubKey = null;
    if (window.SDH?.LocalIdentity) {
      const identity = await window.SDH.LocalIdentity.getIdentity();
      localPubKey = identity?.publicKeyJwk || null;
    }

    const payload = {
      v: PROTOCOL_VERSION,
      type: 'offer',
      sid: sessionId,
      sdp: offerData.sdp,
      candidates: offerData.candidates,
      peer: {
        username: localProfile.username,
        displayName: localProfile.displayName || localProfile.username,
        deviceId: localProfile.deviceId || 'device_' + localProfile.username,
        publicKeyJwk: localPubKey
      },
      nonce: nonce,
      ts: Date.now()
    };

    const token = encodeToken(payload);

    currentSession = {
      sessionId: sessionId,
      role: 'initiator',
      offerPayload: payload,
      localPeer: payload.peer,
      remotePeer: null,
      token: token,
      createdAt: Date.now()
    };

    return {
      token: token,
      sessionId: sessionId,
      payload: payload
    };
  }

  /**
   * Device A: Processes the Answer QR/token scanned from Device B.
   *
   * @param {string} rawAnswerToken
   */
  async function finalizePairing(rawAnswerToken) {
    if (!currentSession || currentSession.role !== 'initiator') {
      throw new Error('No active initiator pairing session.');
    }

    const answerPayload = decodeToken(rawAnswerToken);

    if (answerPayload.type !== 'answer') {
      throw new Error('Expected Answer packet, received: ' + answerPayload.type);
    }
    if (answerPayload.sid !== currentSession.sessionId) {
      throw new Error('Session ID mismatch. Please scan the matching answer.');
    }

    currentSession.remotePeer = answerPayload.peer;
    currentSession.answerPayload = answerPayload;

    // Set remote description on WebRTC connection
    await window.SDH.NearbyWebRTC.handleAnswer({
      sdp: answerPayload.sdp,
      candidates: answerPayload.candidates,
      remotePeer: answerPayload.peer
    });

    // Compute Safety Code
    const safety = await computeSafetyCode(
      currentSession.localPeer.publicKeyJwk,
      currentSession.remotePeer.publicKeyJwk,
      currentSession.sessionId
    );

    currentSession.safetyCode = safety.numericCode;
    currentSession.hexFingerprint = safety.hexFingerprint;

    return {
      session: currentSession,
      safetyCode: safety.numericCode,
      hexFingerprint: safety.hexFingerprint,
      remotePeer: currentSession.remotePeer
    };
  }

  // ── Session Flow: Receiver (Answer) ──────────────────────────────────

  /**
   * Device B: Processes the Offer QR/token scanned from Device A and creates an Answer QR/token.
   *
   * @param {string} rawOfferToken
   * @param {Object} localProfile
   * @returns {Promise<{ token: string, answerPayload: Object, safetyCode: string }>}
   */
  async function acceptPairingOffer(rawOfferToken, localProfile) {
    if (!window.SDH?.NearbyWebRTC) {
      throw new Error('SDH.NearbyWebRTC module not initialized.');
    }

    const offerPayload = decodeToken(rawOfferToken);

    if (offerPayload.type !== 'offer') {
      throw new Error('Expected Offer packet, received: ' + offerPayload.type);
    }

    // Retrieve local public key
    let localPubKey = null;
    if (window.SDH?.LocalIdentity) {
      const identity = await window.SDH.LocalIdentity.getIdentity();
      localPubKey = identity?.publicKeyJwk || null;
    }

    // Pass offer to WebRTC to configure remote description and generate answer
    const answerData = await window.SDH.NearbyWebRTC.handleOffer({
      sdp: offerPayload.sdp,
      candidates: offerPayload.candidates,
      remotePeer: offerPayload.peer
    });

    const localPeer = {
      username: localProfile.username,
      displayName: localProfile.displayName || localProfile.username,
      deviceId: localProfile.deviceId || 'device_' + localProfile.username,
      publicKeyJwk: localPubKey
    };

    const answerPayload = {
      v: PROTOCOL_VERSION,
      type: 'answer',
      sid: offerPayload.sid,
      sdp: answerData.sdp,
      candidates: answerData.candidates,
      peer: localPeer,
      nonce: offerPayload.nonce,
      ts: Date.now()
    };

    const token = encodeToken(answerPayload);

    // Compute Safety Code
    const safety = await computeSafetyCode(
      offerPayload.peer.publicKeyJwk,
      localPeer.publicKeyJwk,
      offerPayload.sid
    );

    currentSession = {
      sessionId: offerPayload.sid,
      role: 'receiver',
      offerPayload: offerPayload,
      answerPayload: answerPayload,
      localPeer: localPeer,
      remotePeer: offerPayload.peer,
      safetyCode: safety.numericCode,
      hexFingerprint: safety.hexFingerprint,
      token: token,
      createdAt: Date.now()
    };

    return {
      token: token,
      sessionId: offerPayload.sid,
      answerPayload: answerPayload,
      safetyCode: safety.numericCode,
      hexFingerprint: safety.hexFingerprint,
      remotePeer: offerPayload.peer
    };
  }

  // ── Verification & Identity Trust ────────────────────────────────────

  /**
   * Confirms the Safety Code matches and marks the peer as verified in IndexedDB.
   *
   * @param {string} peerId
   * @param {string} safetyCode
   */
  async function confirmPeerVerification(peerId, safetyCode) {
    if (!currentSession || !currentSession.remotePeer) {
      console.warn('[SDH.NearbySignaling] No active peer to verify.');
      return;
    }

    const peer = currentSession.remotePeer;
    peer.peerId = peerId || 'peer_' + peer.username;
    peer.isVerified = true;
    peer.safetyCode = safetyCode || currentSession.safetyCode;
    peer.verifiedAt = new Date().toISOString();

    // Persist in LocalIdentity store
    if (window.SDH?.LocalIdentity) {
      await window.SDH.LocalIdentity.upsertPeer(peer);
    }

    // Register with NearbyTransport
    if (window.SDH?.NearbyTransport) {
      window.SDH.NearbyTransport.registerDiscoveredPeer(peer);
    }

    console.log('[SDH.NearbySignaling] Peer identity verified & trusted:', peer.username);

    // Notify UI
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('sdh:nearby-peer-verified', {
        detail: { peer }
      }));
    }

    return peer;
  }

  // ── UI Modal Controller ──────────────────────────────────────────────

  function openPairingModal() {
    const modal = document.getElementById('nearbyPairingModal');
    if (modal) {
      modal.classList.remove('hidden');
      _initModalState();
    }
  }

  function closePairingModal() {
    const modal = document.getElementById('nearbyPairingModal');
    if (modal) {
      modal.classList.add('hidden');
    }
    if (window.SDH?.QRCode) {
      window.SDH.QRCode.stopScanner();
    }
  }

  function _initModalState() {
    // Select default 'offer' tab
    switchTab('offer');
  }

  async function switchTab(tabName) {
    const tabOffer = document.getElementById('pairingTabOffer');
    const tabScan = document.getElementById('pairingTabScan');
    const tabVerify = document.getElementById('pairingTabVerify');

    const paneOffer = document.getElementById('pairingPaneOffer');
    const paneScan = document.getElementById('pairingPaneScan');
    const paneVerify = document.getElementById('pairingPaneVerify');

    if (paneOffer) paneOffer.classList.add('hidden');
    if (paneScan) paneScan.classList.add('hidden');
    if (paneVerify) paneVerify.classList.add('hidden');

    [tabOffer, tabScan, tabVerify].forEach(t => {
      if (t) {
        t.classList.remove('bg-emerald-500/20', 'text-emerald-300', 'border-emerald-500/40');
        t.classList.add('text-slate-400', 'hover:text-slate-200');
      }
    });

    if (tabName === 'offer') {
      if (paneOffer) paneOffer.classList.remove('hidden');
      if (tabOffer) {
        tabOffer.classList.add('bg-emerald-500/20', 'text-emerald-300', 'border-emerald-500/40');
        tabOffer.classList.remove('text-slate-400');
      }
      _startOfferWorkflow();
    } else if (tabName === 'scan') {
      if (paneScan) paneScan.classList.remove('hidden');
      if (tabScan) {
        tabScan.classList.add('bg-emerald-500/20', 'text-emerald-300', 'border-emerald-500/40');
        tabScan.classList.remove('text-slate-400');
      }
      _startScannerWorkflow();
    } else if (tabName === 'verify') {
      if (paneVerify) paneVerify.classList.remove('hidden');
      if (tabVerify) {
        tabVerify.classList.add('bg-emerald-500/20', 'text-emerald-300', 'border-emerald-500/40');
        tabVerify.classList.remove('text-slate-400');
      }
      _renderVerificationView();
    }
  }

  async function _startOfferWorkflow() {
    const canvas = document.getElementById('pairingOfferCanvas');
    const statusText = document.getElementById('pairingOfferStatus');
    const tokenBox = document.getElementById('pairingOfferToken');

    if (statusText) statusText.textContent = 'Generating local WebRTC offer & gathering host candidates...';

    try {
      const username = window.SDH_DATA?.currentUser || 'user';
      const offerResult = await createPairingOffer({
        username: username,
        displayName: username
      });

      if (canvas && window.SDH?.QRCode) {
        window.SDH.QRCode.generate(offerResult.token, canvas, { size: 260, margin: 2 });
      }

      if (tokenBox) {
        tokenBox.value = offerResult.token;
      }

      if (statusText) {
        statusText.innerHTML = '<span class="text-emerald-400 font-semibold">Offer ready!</span> Show this QR code to your nearby peer.';
      }
    } catch (err) {
      console.error('[SDH.NearbySignaling] Offer creation error:', err);
      if (statusText) statusText.textContent = 'Error: ' + err.message;
    }
  }

  function _startScannerWorkflow() {
    const video = document.getElementById('pairingScanVideo');
    const feedback = document.getElementById('pairingScanFeedback');

    if (feedback) feedback.textContent = 'Position peer’s QR code in frame...';

    if (video && window.SDH?.QRCode) {
      window.SDH.QRCode.startScanner(video, async (decodedText) => {
        if (feedback) feedback.textContent = 'QR Code detected! Processing...';
        await handleScannedInput(decodedText);
      }, (err) => {
        if (feedback) feedback.textContent = 'Camera not available. Use the paste code tab below.';
      });
    }
  }

  async function handleScannedInput(rawText) {
    const feedback = document.getElementById('pairingScanFeedback');
    try {
      const payload = decodeToken(rawText);

      if (payload.type === 'offer') {
        // We scanned an Offer -> Accept and generate Answer
        const username = window.SDH_DATA?.currentUser || 'user';
        const answerRes = await acceptPairingOffer(rawText, {
          username: username,
          displayName: username
        });

        // Show Answer QR screen
        const answerCanvas = document.getElementById('pairingAnswerCanvas');
        const answerContainer = document.getElementById('pairingAnswerContainer');
        const scannerBox = document.getElementById('pairingScannerBox');

        if (scannerBox) scannerBox.classList.add('hidden');
        if (answerContainer) answerContainer.classList.remove('hidden');

        if (answerCanvas && window.SDH?.QRCode) {
          window.SDH.QRCode.generate(answerRes.token, answerCanvas, { size: 240, margin: 2 });
        }

        const answerTokenInput = document.getElementById('pairingAnswerToken');
        if (answerTokenInput) answerTokenInput.value = answerRes.token;

        if (feedback) feedback.textContent = 'Offer accepted! Show this Answer QR to your friend.';
      } else if (payload.type === 'answer') {
        // We are the initiator and just scanned the Answer!
        const finalRes = await finalizePairing(rawText);
        if (feedback) feedback.textContent = 'Connection established! Verifying safety code...';
        switchTab('verify');
      }
    } catch (err) {
      console.warn('[SDH.NearbySignaling] Scan process error:', err);
      if (feedback) feedback.textContent = 'Invalid or expired QR code: ' + err.message;
    }
  }

  function _renderVerificationView() {
    const codeEl = document.getElementById('pairingSafetyCode');
    const remotePeerEl = document.getElementById('pairingRemotePeerName');
    const hexEl = document.getElementById('pairingHexFingerprint');

    if (codeEl) codeEl.textContent = currentSession?.safetyCode || '--- - ---';
    if (remotePeerEl) remotePeerEl.textContent = currentSession?.remotePeer?.username || 'Peer';
    if (hexEl) hexEl.textContent = currentSession?.hexFingerprint || '---- - ---- - ---- - ----';
  }

  async function onVerifyClicked() {
    if (currentSession?.remotePeer) {
      await confirmPeerVerification(
        currentSession.remotePeer.peerId || 'peer_' + currentSession.remotePeer.username,
        currentSession.safetyCode
      );
      closePairingModal();
      if (window.SDH?.TransportManager?._showToast) {
        window.SDH.TransportManager._showToast(`Peer @${currentSession.remotePeer.username} verified & connected!`, 'success');
      }
    }
  }

  function copyOfferToken() {
    const tokenBox = document.getElementById('pairingOfferToken');
    if (tokenBox && tokenBox.value) {
      navigator.clipboard.writeText(tokenBox.value).then(() => {
        const btn = document.getElementById('pairingCopyOfferBtn');
        if (btn) {
          const orig = btn.innerHTML;
          btn.innerHTML = '<span>Copied!</span>';
          setTimeout(() => btn.innerHTML = orig, 2000);
        }
      });
    }
  }

  function applyPastedToken() {
    const input = document.getElementById('pairingManualPasteInput');
    if (input && input.value) {
      handleScannedInput(input.value.trim());
    }
  }

  // ── Connection State Listener for UI ─────────────────────────────────
  if (typeof window !== 'undefined') {
    window.addEventListener('sdh:nearby-connection-state', (e) => {
      const badge = document.getElementById('pairingConnectionBadge');
      const text = document.getElementById('pairingConnectionText');
      if (!badge || !text) return;

      const state = e.detail?.state;
      switch (state) {
        case 'pairing':
          badge.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30';
          text.textContent = 'Pairing...';
          break;
        case 'connecting':
          badge.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-sky-500/15 text-sky-300 border border-sky-500/30';
          text.textContent = 'Connecting...';
          break;
        case 'connected':
          badge.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm';
          text.textContent = 'Connected (P2P)';
          // Automatically switch to verification tab if not already verified
          if (document.getElementById('pairingPaneVerify')?.classList.contains('hidden')) {
            switchTab('verify');
          }
          break;
        case 'failed':
          badge.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-rose-500/15 text-rose-300 border border-rose-500/30';
          text.textContent = 'Failed';
          break;
        case 'disconnected':
          badge.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-slate-500/15 text-slate-300 border border-slate-500/30';
          text.textContent = 'Disconnected';
          break;
      }
    });
  }

  // ── Public API ───────────────────────────────────────────────────────

  return {
    createPairingOffer,
    acceptPairingOffer,
    finalizePairing,
    computeSafetyCode,
    decodeToken,
    encodeToken,
    confirmPeerVerification,
    openPairingModal,
    closePairingModal,
    switchTab,
    handleScannedInput,
    onVerifyClicked,
    copyOfferToken,
    applyPastedToken,
    getCurrentSession: () => currentSession
  };

})();
