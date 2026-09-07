/**
 * SDH – WebRTC Module
 * ======================
 * Handles peer-to-peer voice and video calls via WebRTC.
 * Uses Django Channels as the signaling server.
 *
 * Features:
 *   - Voice call (medium / high quality)
 *   - Video call (medium / high quality)
 *   - Mute / camera toggle
 *   - Quality switching (via re-negotiation)
 *   - Incoming call UI
 *   - Call state management
 */

'use strict';

window.SDH = window.SDH || {};

SDH.WebRTC = (() => {

  // ── State ─────────────────────────────────────────────────────
  let peerConnection = null;
  let signalSocket = null;
  let localStream = null;
  let currentUsername = null;   // OUR own username (signaling inbox)
  let remoteUser = null;   // contact selected in sidebar
  let callPeer = null;   // username of person we're in/requesting a call with
  let currentCallType = null;   // 'voice' | 'video'
  let currentQuality = 'medium';
  let isMuted = false;
  let isCameraOff = false;
  let isCallActive = false;
  let pendingOffer = null;   // call-request data while waiting for user to accept
  let pendingOfferSdp = null;   // buffered SDP offer — processed only AFTER user accepts
  let pendingIceCandidates = [];     // ICE candidates buffered before setRemoteDescription
  let ringtoneInterval = null;   // handle for incoming-call ringtone loop
  let videoSwapped = false;
  let stylesSaved = false;
  let originalRemoteClasses = '';
  let originalLocalClasses = '';
  let originalLocalStyle = '';
  let originalRemoteStyle = '';

  let isUpgradePending = false;
  let upgradeTimeout = null;

  // ── Media quality presets ─────────────────────────────────────
  const QUALITY = {
    voice: {
      medium: {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 32000,
          channelCount: 1
        },
        video: false
      },
      high: {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
          channelCount: 2
        },
        video: false
      },
    },
    video: {
      medium: {
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 32000 },
        video: {
          width: { ideal: 640, max: 854 },
          height: { ideal: 480, max: 480 },
          frameRate: { ideal: 24, max: 24 }
        },
      },
      high: {
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000 },
        video: {
          width: { ideal: 1280, min: 640, max: 1920 },
          height: { ideal: 720, min: 480, max: 1080 },
          frameRate: { ideal: 30, min: 20, max: 60 }
        },
      },
    },
  };

  // STUN / TURN servers — TURN credentials loaded from server config
  const ICE_SERVERS = (() => {
    const servers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];
    // Add TURN server if configured via environment variables
    // (injected into window.SDH_DATA by the Django template)
    const turnUrl = window.SDH_DATA?.turnServerUrl;
    const turnUser = window.SDH_DATA?.turnServerUsername;
    const turnCred = window.SDH_DATA?.turnServerCredential;
    if (turnUrl) {
      servers.push({
        urls: turnUrl,
        username: turnUser || '',
        credential: turnCred || '',
      });
    }
    return servers;
  })();

  // ── Signaling socket ──────────────────────────────────────────

  /**
   * init(username)
   * Called once on page load with the CURRENT (logged-in) user's username.
   * Opens a persistent signaling socket so this user can receive calls
   * from anyone at any time — not just when a contact is already selected.
   */
  function init(username) {
    currentUsername = username;
    _openSignalSocket(username);
    _initDraggablePIP();
  }

  function _initDraggablePIP() {
    const pip = document.getElementById('localVideo');
    if (!pip) return;

    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    const dragStart = (e) => {
      if (e.target !== pip) return;
      isDragging = true;

      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;

      startX = clientX;
      startY = clientY;

      const rect = pip.getBoundingClientRect();
      const parentRect = pip.parentElement.getBoundingClientRect();

      if (!pip.style.left || !pip.style.top) {
        pip.style.left = (rect.left - parentRect.left) + 'px';
        pip.style.top = (rect.top - parentRect.top) + 'px';
        pip.style.right = 'auto';
        pip.style.bottom = 'auto';
      }

      initialLeft = parseFloat(pip.style.left);
      initialTop = parseFloat(pip.style.top);

      pip.style.transition = 'none';
      if (e.cancelable) e.preventDefault();
    };

    const dragMove = (e) => {
      if (!isDragging) return;

      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;

      const dx = clientX - startX;
      const dy = clientY - startY;

      let newLeft = initialLeft + dx;
      let newTop = initialTop + dy;

      const parent = pip.parentElement;
      const maxX = parent.clientWidth - pip.offsetWidth;
      const maxY = parent.clientHeight - pip.offsetHeight;

      if (newLeft < 0) newLeft = 0;
      if (newTop < 0) newTop = 0;
      if (newLeft > maxX) newLeft = maxX;
      if (newTop > maxY) newTop = maxY;

      pip.style.left = newLeft + 'px';
      pip.style.top = newTop + 'px';
    };

    const dragEnd = (e) => {
      if (!isDragging) return;
      isDragging = false;
      pip.style.transition = '';
    };

    pip.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', dragMove);
    document.addEventListener('mouseup', dragEnd);

    pip.addEventListener('touchstart', dragStart, { passive: false });
    document.addEventListener('touchmove', dragMove, { passive: false });
    document.addEventListener('touchend', dragEnd);
  }

  /**
   * _openSignalSocket(username)
   * Internal helper — (re)opens the WebSocket to /ws/signal/<username>/.
   * The server ignores the URL param for routing; it adds the authenticated
   * user to their own  user_<id>  presence group.
   */
  function _openSignalSocket(username) {
    if (signalSocket && signalSocket.readyState === WebSocket.OPEN) return;
    if (signalSocket) {
      signalSocket.onclose = null;   // suppress reconnect triggered by close
      signalSocket.close(1000);
      signalSocket = null;
    }

    const wsBase = window.SDH_DATA?.wsBase || `ws://${window.location.host}`;
    const url = `${wsBase}/ws/signal/${encodeURIComponent(username)}/`;

    signalSocket = new WebSocket(url);
    signalSocket.onmessage = onSignal;
    signalSocket.onerror = e => console.error('[WebRTC] Signal socket error:', e);
    signalSocket.onclose = e => {
      signalSocket = null;
      if (e.code !== 1000 && currentUsername) {
        // Reconnect with back-off so we stay reachable even after brief disconnects
        const delay = isCallActive ? 1000 : 4000;
        setTimeout(() => _openSignalSocket(currentUsername), delay);
      }
    };
  }

  /**
   * sendSignal(payload, toUser?)
   * Sends a signaling frame.  ``to_user`` is resolved in priority order:
   *   1. explicit ``toUser`` argument
   *   2. ``callPeer``  (whoever we're currently in a call with)
   *   3. ``remoteUser`` (contact selected in sidebar)
   * The server reads ``to_user`` to route the frame to the correct inbox.
   */
  function sendSignal(payload, toUser = null) {
    const target = toUser || callPeer || remoteUser;
    if (!target) {
      console.warn('[WebRTC] sendSignal: no target user — frame dropped.', payload?.type);
      return;
    }
    const frame = Object.assign({}, payload, { to_user: target });
    if (signalSocket?.readyState === WebSocket.OPEN) {
      signalSocket.send(JSON.stringify(frame));
    } else {
      console.warn('[WebRTC] Signal socket not ready.', payload?.type);
    }
  }

  // ── Wait until the signaling socket is open (or timeout) ────
  function waitForSignalSocket(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (signalSocket?.readyState === WebSocket.OPEN) { resolve(); return; }
      // If we have a username but no socket, try to open one now
      if (currentUsername && (!signalSocket || signalSocket.readyState === WebSocket.CLOSED)) {
        _openSignalSocket(currentUsername);
      }
      const deadline = Date.now() + timeoutMs;
      const poll = setInterval(() => {
        if (signalSocket?.readyState === WebSocket.OPEN) {
          clearInterval(poll);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(poll);
          reject(new Error('Signaling socket did not open in time'));
        }
      }, 100);
    });
  }

  // ── Signal dispatcher ─────────────────────────────────────────
  async function onSignal(event) {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }

    switch (data.type) {
      case 'call-request':
        await handleIncomingCallRequest(data);
        break;
      case 'call-accept':
        await handleCallAccepted(data);
        break;
      case 'call-reject':
        handleCallRejected(data);
        break;
      case 'call-offline':
        handleCallOffline(data);
        break;
      case 'call-end':
        hangup('Remote ended the call.');
        break;
      case 'offer':
        await handleOffer(data);
        break;
      case 'answer':
        await handleAnswer(data);
        break;
      case 'ice-candidate':
        await handleIceCandidate(data);
        break;
      case 'call-quality':
        await handleQualityChange(data);
        break;
      case 'call-mute':
        if (SDH.Chat && SDH.Chat.showToast) {
          SDH.Chat.showToast(data.isMuted ? 'Remote user muted their microphone' : 'Remote user unmuted their microphone', 'info');
        }
        break;
      case 'call-camera':
        if (SDH.Chat && SDH.Chat.showToast) {
          SDH.Chat.showToast(data.isCameraOff ? 'Remote user turned off their camera' : 'Remote user turned on their camera', 'info');
        }
        break;
      case 'call-upgrade-request':
        handleVideoUpgradeRequest(data);
        break;
      case 'call-upgrade-accept':
        await handleVideoUpgradeAccepted(data);
        break;
      case 'call-upgrade-reject':
        handleVideoUpgradeRejected(data);
        break;
      case 'call-upgrade':
        if (data.call_type === 'video' && currentCallType !== 'video') {
          handleVideoUpgradeRequest(data);
        }
        break;
    }
  }

  // ── Initiate outgoing call ────────────────────────────────────
  // ── Initiate outgoing call ────────────────────────────────────
  async function startCall(callType, quality = null) {
    if (!remoteUser) {
      SDH.Chat?.showToast('Select a contact first.', 'warning');
      return;
    }
    if (isCallActive) {
      if (currentCallType === 'voice' && callType === 'video') {
        return requestVideoUpgrade();
      }
      SDH.Chat?.showToast('Already in a call.', 'warning');
      return;
    }

    const domQuality = document.getElementById('qualitySelect')?.value;
    const resolvedQuality = (quality === 'high' || quality === 'medium') ? quality : (domQuality || currentQuality || 'medium');
    currentCallType = callType;
    currentQuality = resolvedQuality;
    callPeer = remoteUser;   // ← record who we are calling

    // Request media permissions FIRST so the browser prompt appears before
    // any network activity, and we can bail cleanly on denial.
    try {
      localStream = await navigator.mediaDevices.getUserMedia(QUALITY[callType][resolvedQuality]);
    } catch (err) {
      _handleMediaError(err);
      callPeer = null;
      return;
    }

    // Ensure our signaling socket is open before sending anything
    try {
      await waitForSignalSocket();
    } catch (err) {
      SDH.Chat?.showToast(
        'Unable to reach signaling server. Check your connection and try again.',
        'error'
      );
      localStream?.getTracks().forEach(t => t.stop());
      localStream = null;
      callPeer = null;
      return;
    }

    isCallActive = true;

    // Show "Calling…" stage — active panel shown only after remote accepts
    showCallingPanel(callType);

    // Signal the remote user.  sendSignal() picks up callPeer automatically.
    sendSignal({ type: 'call-request', call_type: callType, quality: resolvedQuality });

    // Build peer connection and send the SDP offer
    await createPeerConnection();
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    sendSignal({ type: 'offer', sdp: offer });
  }

  // ── Handle incoming call request ──────────────────────────────
  async function handleIncomingCallRequest(data) {
    if (isCallActive) {
      // Already in a call — silently decline with 'busy'
      sendSignal({ type: 'call-reject', reason: 'busy' }, data.from);
      return;
    }
    // Record the caller so all subsequent signals go back to them
    callPeer = data.from;
    pendingOffer = data;
    _startRingtone();
    showIncomingCallPanel(data.from, data.call_type);
  }

  // ── User accepts incoming call ────────────────────────────────
  async function acceptCall() {
    if (!pendingOffer) return;
    _stopRingtone();

    const { call_type, quality = 'medium' } = pendingOffer;
    currentCallType = call_type;
    currentQuality = quality || 'medium';
    document.querySelectorAll('#qualitySelect').forEach(el => { el.value = currentQuality; });
    // callPeer was already set in handleIncomingCallRequest

    // Get local media FIRST — tracks must be added before creating the answer
    try {
      localStream = await navigator.mediaDevices.getUserMedia(QUALITY[call_type][quality]);
    } catch (err) {
      sendSignal({ type: 'call-reject', reason: 'media_error' });
      pendingOffer = null;
      pendingOfferSdp = null;
      callPeer = null;
      hideCallOverlay();
      _handleMediaError(err);
      return;
    }

    sendSignal({ type: 'call-accept' });   // to_user = callPeer (caller)
    isCallActive = true;

    // Build peer connection — local stream tracks are added inside
    await createPeerConnection();

    // Process the buffered SDP offer from the caller
    if (pendingOfferSdp) {
      try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(pendingOfferSdp));
        await _flushIceCandidates();
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        sendSignal({ type: 'answer', sdp: answer });   // to_user = callPeer
      } catch (err) {
        console.error('[WebRTC] Error processing buffered offer:', err);
        hangup('Call setup failed.');
        return;
      }
      pendingOfferSdp = null;
    }

    pendingOffer = null;
    showActiveCallPanel(call_type, false);
  }

  // ── User rejects incoming call ────────────────────────────────
  function rejectCall() {
    _stopRingtone();
    sendSignal({ type: 'call-reject', reason: 'declined' });   // to_user = callPeer
    pendingOffer = null;
    pendingOfferSdp = null;
    callPeer = null;
    pendingIceCandidates = [];
    hideCallOverlay();
  }

  // ── Remote accepted our call ──────────────────────────────────
  async function handleCallAccepted(data) {
    // Stop outgoing ringback tone when recipient answers
    _stopRingtone();
    // Transition caller from "calling" panel to active call panel.
    // The SDP answer will arrive shortly and establish the media channel.
    showActiveCallPanel(currentCallType);
  }

  function handleCallRejected(data) {
    if (SDH.Chat && SDH.Chat.showToast) {
      SDH.Chat.showToast('Call was declined.', 'info');
    }

    if (callPeer && window.SDH && SDH.WS && SDH.WS.isOpen()) {
      const msgText = currentCallType === 'video' ? 'Missed video call' : 'Missed voice call';
      const tempId = `temp_${Date.now()}`;
      SDH.WS.sendMessage({
        type: 'chat_message',
        receiver: callPeer,
        message_type: 'call',
        message: msgText,
        temp_id: tempId
      });
      if (SDH.Chat && SDH.Chat.appendMessage) {
        SDH.Chat.appendMessage({
          sender: currentUsername,
          isFromMe: true,
          content: msgText,
          messageType: 'call',
          timestamp: new Date().toISOString(),
          messageId: tempId
        });
        if (SDH.Chat.registerTempMessage) {
          SDH.Chat.registerTempMessage(tempId);
        }
      }
    }

    hangup();
  }

  function handleCallOffline(data) {
    if (SDH.Chat && SDH.Chat.showToast) {
      SDH.Chat.showToast('User is offline.', 'info');
    }

    if (callPeer && window.SDH && SDH.WS && SDH.WS.isOpen()) {
      const msgText = currentCallType === 'video' ? 'Missed video call' : 'Missed voice call';
      const tempId = `temp_${Date.now()}`;
      SDH.WS.sendMessage({
        type: 'chat_message',
        receiver: callPeer,
        message_type: 'call',
        message: msgText,
        temp_id: tempId
      });
      if (SDH.Chat && SDH.Chat.appendMessage) {
        SDH.Chat.appendMessage({
          sender: currentUsername,
          isFromMe: true,
          content: msgText,
          messageType: 'call',
          timestamp: new Date().toISOString(),
          messageId: tempId
        });
        if (SDH.Chat.registerTempMessage) {
          SDH.Chat.registerTempMessage(tempId);
        }
      }
    }

    hangup();
  }

  // ── RTCPeerConnection setup ───────────────────────────────────
  async function createPeerConnection() {
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }

    peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Add every local media track to the peer connection
    if (localStream) {
      localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
      });
    }

    // Apply bitrate and resolution encoding constraints immediately
    await _applySenderBitrate(currentQuality);

    // Mirror local video feed (video calls only)
    const localVideo = document.getElementById('localVideo');
    if (localVideo) {
      if (currentCallType === 'video') {
        localVideo.srcObject = localStream;
        localVideo.classList.remove('hidden');
      } else {
        localVideo.classList.add('hidden');
      }
    }

    // Send ICE candidates as soon as they are gathered
    peerConnection.onicecandidate = (e) => {
      if (e.candidate) {
        sendSignal({ type: 'ice-candidate', candidate: e.candidate });
      }
    };

    // Attach remote stream to the correct media element
    peerConnection.ontrack = (e) => {
      const stream = e.streams?.[0];
      if (!stream) return;

      const hasVideo = stream.getVideoTracks().length > 0 || e.track?.kind === 'video';
      if (hasVideo) {
        currentCallType = 'video';
        showActiveCallPanel('video');
        const remoteVideo = document.getElementById('remoteVideo');
        if (remoteVideo) {
          remoteVideo.srcObject = stream;
          remoteVideo.play().catch(() => { });
        }
      } else if (currentCallType === 'video') {
        const remoteVideo = document.getElementById('remoteVideo');
        if (remoteVideo) {
          remoteVideo.srcObject = stream;
          remoteVideo.play().catch(() => { });
        }
      }

      let remoteAudio = document.getElementById('remoteAudio');
      if (!remoteAudio) {
        remoteAudio = document.createElement('audio');
        remoteAudio.id = 'remoteAudio';
        remoteAudio.autoplay = true;
        document.body.appendChild(remoteAudio);
      }
      remoteAudio.srcObject = stream;
      remoteAudio.play().catch(() => { });
      updateAudioVisual();
    };

    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection?.connectionState;
      if (state === 'failed') {
        hangup('Connection failed. Please try again.');
      } else if (state === 'disconnected') {
        // Give a short grace period before treating as a hard failure
        setTimeout(() => {
          if (peerConnection?.connectionState === 'disconnected') {
            hangup('Connection lost.');
          }
        }, 5000);
      }
    };
  }

  // ── Handle SDP offer ─────────────────────────────────────────
  async function handleOffer(data) {
    // If the user has not yet accepted the incoming call, buffer the SDP.
    // acceptCall() will process it after acquiring local media so that
    // local tracks are present when the answer is created.
    if (!isCallActive) {
      pendingOfferSdp = data.sdp;
      return;
    }

    // Re-offer during an active call (video upgrade, renegotiation, etc.)
    if (data.sdp?.sdp?.includes('m=video') && !data.sdp?.sdp?.includes('m=video 0')) {
      currentCallType = 'video';
      showActiveCallPanel('video');
    }
    if (!peerConnection) await createPeerConnection();
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
    await _flushIceCandidates();
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    sendSignal({ type: 'answer', sdp: answer });
  }

  // ── Handle SDP answer ────────────────────────────────────────
  async function handleAnswer(data) {
    if (!peerConnection) return;
    if (data.sdp?.sdp?.includes('m=video') && !data.sdp?.sdp?.includes('m=video 0')) {
      currentCallType = 'video';
      showActiveCallPanel('video');
    }
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
    // Flush any ICE candidates that arrived before the answer
    await _flushIceCandidates();
  }

  // ── Handle ICE candidate ──────────────────────────────────────
  async function handleIceCandidate(data) {
    if (!data.candidate) return;
    // Buffer candidates until the remote description is set
    if (!peerConnection || !peerConnection.remoteDescription) {
      pendingIceCandidates.push(data.candidate);
      return;
    }
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (err) {
      console.warn('[WebRTC] ICE candidate error:', err);
    }
  }

  // ── Flush buffered ICE candidates ────────────────────────────
  async function _flushIceCandidates() {
    const queue = pendingIceCandidates.splice(0);
    for (const candidate of queue) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('[WebRTC] Buffered ICE error:', err);
      }
    }
  }

  // ── Apply WebRTC Encoding Bitrates & Framerates ───────────────
  async function _applySenderBitrate(quality) {
    if (!peerConnection) return;
    const senders = peerConnection.getSenders();
    for (const sender of senders) {
      if (!sender.track) continue;
      try {
        const params = sender.getParameters();
        if (!params) continue;
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        if (sender.track.kind === 'video') {
          if (quality === 'high') {
            params.encodings[0].maxBitrate = 2500000; // 2.5 Mbps High Definition (720p)
            params.encodings[0].maxFramerate = 30;
            params.encodings[0].scaleResolutionDownBy = 1.0;
          } else {
            params.encodings[0].maxBitrate = 600000;  // 600 Kbps Standard Definition (480p)
            params.encodings[0].maxFramerate = 24;
            params.encodings[0].scaleResolutionDownBy = 1.5;
          }
        } else if (sender.track.kind === 'audio') {
          if (quality === 'high') {
            params.encodings[0].maxBitrate = 64000;  // 64 kbps HD Audio
          } else {
            params.encodings[0].maxBitrate = 24000;  // 24 kbps Standard Voice
          }
        }
        await sender.setParameters(params);
      } catch (err) {
        console.warn('[WebRTC] sender.setParameters error/warning:', err);
      }
    }
  }

  // ── Handle remote quality change request ─────────────────────
  async function handleQualityChange(data) {
    const q = (data.quality === 'high' || data.quality === 'medium') ? data.quality : 'medium';
    currentQuality = q;

    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack && QUALITY.video[q]) {
        try { await videoTrack.applyConstraints(QUALITY.video[q].video); } catch (e) { }
      }
      const audioTrack = localStream.getAudioTracks()[0];
      if (audioTrack && QUALITY.voice[q]) {
        try { await audioTrack.applyConstraints(QUALITY.voice[q].audio); } catch (e) { }
      }
    }

    await _applySenderBitrate(q);

    document.querySelectorAll('#qualitySelect').forEach(el => {
      if (el.value !== q) el.value = q;
    });

    if (SDH.Chat && SDH.Chat.showToast) {
      const label = q === 'high' ? 'High Quality (HD)' : 'Medium Quality (Standard)';
      SDH.Chat.showToast(`Remote peer set call quality to ${label}`, 'info');
    }
  }

  // ── End call ─────────────────────────────────────────────────
  function endCall() {
    if (callPeer && peerConnection && peerConnection.connectionState !== 'connected' && window.SDH && SDH.WS && SDH.WS.isOpen()) {
      const msgText = currentCallType === 'video' ? 'Missed video call' : 'Missed voice call';
      const tempId = `temp_${Date.now()}`;
      SDH.WS.sendMessage({
        type: 'chat_message',
        receiver: callPeer,
        message_type: 'call',
        message: msgText,
        temp_id: tempId
      });
      if (SDH.Chat && SDH.Chat.appendMessage) {
        SDH.Chat.appendMessage({
          sender: currentUsername,
          isFromMe: true,
          content: msgText,
          messageType: 'call',
          timestamp: new Date().toISOString(),
          messageId: tempId
        });
        if (SDH.Chat.registerTempMessage) {
          SDH.Chat.registerTempMessage(tempId);
        }
      }
    }

    sendSignal({ type: 'call-end' });   // to_user = callPeer
    hangup('You ended the call.');
  }

  function hangup(reason) {
    _stopRingtone();

    isCallActive = false;
    pendingOffer = null;
    pendingOfferSdp = null;
    pendingIceCandidates = [];
    isMuted = false;
    isCameraOff = false;
    callPeer = null;   // reset after call ends
    isUpgradePending = false;
    if (upgradeTimeout) {
      clearTimeout(upgradeTimeout);
      upgradeTimeout = null;
    }
    const upModal = document.getElementById('videoUpgradeModal');
    if (upModal) {
      upModal.classList.add('hidden');
      upModal.classList.remove('flex');
    }
    _updateCamBtnUI();

    // Stop all local media tracks
    localStream?.getTracks().forEach(t => t.stop());
    localStream = null;

    // Close the peer connection gracefully
    if (peerConnection) {
      peerConnection.onicecandidate = null;
      peerConnection.ontrack = null;
      peerConnection.onconnectionstatechange = null;
      peerConnection.close();
      peerConnection = null;
    }

    // Detach streams from video/audio elements
    const remoteVideo = document.getElementById('remoteVideo');
    const localVideo = document.getElementById('localVideo');
    const remoteAudio = document.getElementById('remoteAudio');

    if (stylesSaved) {
      if (remoteVideo) {
        remoteVideo.className = originalRemoteClasses;
        remoteVideo.style.cssText = originalRemoteStyle;
      }
      if (localVideo) {
        localVideo.className = originalLocalClasses;
        localVideo.style.cssText = originalLocalStyle;
      }
    }
    videoSwapped = false;
    stylesSaved = false;

    if (remoteVideo) remoteVideo.srcObject = null;
    if (localVideo) localVideo.srcObject = null;
    if (remoteAudio) remoteAudio.srcObject = null;

    hideCallOverlay();
    if (reason) SDH.Chat?.showToast(reason, 'info');
  }

  // ── Mute / unmute ─────────────────────────────────────────────
  function toggleMute() {
    if (!localStream) return;
    const audioTracks = localStream.getAudioTracks();
    if (!audioTracks.length) {
      if (SDH.Chat && SDH.Chat.showToast) SDH.Chat.showToast('No microphone track found.', 'warning');
      return;
    }
    isMuted = !isMuted;
    audioTracks.forEach(track => { track.enabled = !isMuted; });
    const btn = document.getElementById('btnMute');
    if (btn) {
      btn.title = isMuted ? 'Unmute' : 'Mute';
      btn.setAttribute('aria-pressed', String(isMuted));

      if (isMuted) {
        btn.classList.add('muted-active');
        btn.style.background = 'rgba(239, 68, 68, 0.9)';
        btn.style.color = '#fff';
        btn.style.borderColor = 'rgba(239, 68, 68, 0.5)';
        btn.innerHTML = `<svg class="w-5 h-5 drop-shadow-md" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 016 0v6a3 3 0 01-3 3z"/><line x1="1" y1="1" x2="23" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
      } else {
        btn.classList.remove('muted-active');
        btn.style.background = 'rgba(255, 255, 255, 0.15)';
        btn.style.color = '#fff';
        btn.style.borderColor = 'rgba(255, 255, 255, 0.2)';
        btn.innerHTML = `<svg class="w-5 h-5 drop-shadow-md" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 016 0v6a3 3 0 01-3 3z"/></svg>`;
      }
    }
    sendSignal({ type: 'call-mute', isMuted: isMuted });
  }

  // ── Request video upgrade (Voice → Video) ─────────────────────
  function requestVideoUpgrade() {
    if (!isCallActive) return;
    if (currentCallType === 'video') {
      SDH.Chat?.showToast('Already in a video call.', 'info');
      return;
    }
    if (isUpgradePending) {
      SDH.Chat?.showToast('Video call request is already pending...', 'info');
      return;
    }
    isUpgradePending = true;
    sendSignal({ type: 'call-upgrade-request', from: currentUsername });
    if (SDH.Chat && SDH.Chat.showToast) {
      SDH.Chat.showToast(`Requesting ${callPeer || 'contact'} to switch to video call...`, 'info');
    }
    if (upgradeTimeout) clearTimeout(upgradeTimeout);
    upgradeTimeout = setTimeout(() => {
      if (isUpgradePending) {
        isUpgradePending = false;
        if (SDH.Chat && SDH.Chat.showToast) {
          SDH.Chat.showToast('Video call switch request timed out.', 'info');
        }
      }
    }, 30000);
  }

  // ── Remote requests to upgrade to video call ─────────────────
  function handleVideoUpgradeRequest(data) {
    if (!isCallActive || currentCallType === 'video') return;
    try { RingtoneEngine.playChime(); } catch (e) { }
    const requester = data.from || callPeer || 'Contact';
    const requesterEl = document.getElementById('videoUpgradeRequester');
    if (requesterEl) requesterEl.textContent = requester;

    const modal = document.getElementById('videoUpgradeModal');
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }
  }

  // ── Decline incoming video upgrade request ───────────────────
  function rejectVideoUpgrade() {
    const modal = document.getElementById('videoUpgradeModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
    sendSignal({ type: 'call-upgrade-reject', from: currentUsername });
    if (SDH.Chat && SDH.Chat.showToast) {
      SDH.Chat.showToast('Declined video call switch.', 'info');
    }
  }

  // ── Remote declined video upgrade request ────────────────────
  function handleVideoUpgradeRejected(data) {
    isUpgradePending = false;
    if (upgradeTimeout) { clearTimeout(upgradeTimeout); upgradeTimeout = null; }
    const who = data.from || callPeer || 'User';
    if (SDH.Chat && SDH.Chat.showToast) {
      SDH.Chat.showToast(`${who} declined to switch to video call.`, 'info');
    }
  }

  // ── Accept incoming video upgrade request ─────────────────────
  async function acceptVideoUpgrade() {
    const modal = document.getElementById('videoUpgradeModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }

    try {
      const vidConstraints = QUALITY.video[currentQuality || 'medium'].video;
      const vidStream = await navigator.mediaDevices.getUserMedia({ video: vidConstraints });
      const vTrack = vidStream.getVideoTracks()[0];
      if (!vTrack) throw new Error('No video track obtained');

      if (localStream) {
        localStream.addTrack(vTrack);
      } else {
        localStream = vidStream;
      }

      currentCallType = 'video';
      isCameraOff = false;

      showActiveCallPanel('video');
      const localVideo = document.getElementById('localVideo');
      if (localVideo) {
        localVideo.srcObject = localStream;
        localVideo.classList.remove('hidden');
      }
      _updateCamBtnUI();
      updateAudioVisual();

      if (peerConnection) {
        peerConnection.addTrack(vTrack, localStream);
        await _applySenderBitrate(currentQuality || 'medium');
      }

      sendSignal({ type: 'call-upgrade-accept', from: currentUsername });
      if (SDH.Chat && SDH.Chat.showToast) {
        SDH.Chat.showToast('Switched to video call.', 'success');
      }
    } catch (err) {
      console.error('[WebRTC] acceptVideoUpgrade camera error:', err);
      sendSignal({ type: 'call-upgrade-reject', reason: 'camera_error', from: currentUsername });
      _handleMediaError(err);
    }
  }

  // ── Remote accepted our video upgrade request ─────────────────
  async function handleVideoUpgradeAccepted(data) {
    isUpgradePending = false;
    if (upgradeTimeout) { clearTimeout(upgradeTimeout); upgradeTimeout = null; }

    try {
      const vidConstraints = QUALITY.video[currentQuality || 'medium'].video;
      const vidStream = await navigator.mediaDevices.getUserMedia({ video: vidConstraints });
      const vTrack = vidStream.getVideoTracks()[0];
      if (!vTrack) throw new Error('No video track obtained');

      if (localStream) {
        localStream.addTrack(vTrack);
      } else {
        localStream = vidStream;
      }

      currentCallType = 'video';
      isCameraOff = false;

      showActiveCallPanel('video');
      const localVideo = document.getElementById('localVideo');
      if (localVideo) {
        localVideo.srcObject = localStream;
        localVideo.classList.remove('hidden');
      }
      _updateCamBtnUI();
      updateAudioVisual();

      if (peerConnection) {
        peerConnection.addTrack(vTrack, localStream);
        await _applySenderBitrate(currentQuality || 'medium');

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        sendSignal({ type: 'offer', sdp: offer });
      }

      if (SDH.Chat && SDH.Chat.showToast) {
        SDH.Chat.showToast(`${data.from || callPeer || 'Contact'} accepted! Switched to video call.`, 'success');
      }
    } catch (err) {
      console.error('[WebRTC] handleVideoUpgradeAccepted camera error:', err);
      _handleMediaError(err);
    }
  }

  // ── Toggle camera (in-call) ───────────────────────────────────
  async function toggleCamera() {
    if (currentCallType === 'voice') {
      return requestVideoUpgrade();
    }

    const videoTracks = localStream?.getVideoTracks();
    if (!videoTracks || videoTracks.length === 0) {
      try {
        const vidConstraints = QUALITY.video[currentQuality || 'medium'].video;
        const vidStream = await navigator.mediaDevices.getUserMedia({ video: vidConstraints });
        const track = vidStream.getVideoTracks()[0];
        if (!track) return;
        localStream?.addTrack(track);
        isCameraOff = false;
        const localVideo = document.getElementById('localVideo');
        if (localVideo) localVideo.srcObject = localStream;
        if (peerConnection) {
          peerConnection.addTrack(track, localStream);
          const offer = await peerConnection.createOffer();
          await peerConnection.setLocalDescription(offer);
          sendSignal({ type: 'offer', sdp: offer });
        }
        _updateCamBtnUI();
        updateAudioVisual();
      } catch (err) {
        _handleMediaError(err);
      }
      return;
    }

    isCameraOff = !isCameraOff;
    videoTracks.forEach(t => { t.enabled = !isCameraOff; });
    _updateCamBtnUI();
    updateAudioVisual();
    sendSignal({ type: 'call-camera', isCameraOff: isCameraOff });
  }

  function _updateCamBtnUI() {
    const btn = document.getElementById('btnCam');
    if (btn) {
      btn.title = isCameraOff ? 'Turn camera on' : (currentCallType === 'voice' ? 'Switch to Video Call' : 'Turn camera off');
      if (isCameraOff) {
        btn.classList.add('cam-off-active');
        btn.style.background = 'rgba(239, 68, 68, 0.9)';
        btn.style.color = '#fff';
        btn.style.borderColor = 'rgba(239, 68, 68, 0.5)';
        btn.innerHTML = `<svg class="w-5 h-5 drop-shadow-md" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.069A1 1 0 0121 8.868v6.264a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/><line x1="1" y1="1" x2="23" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
      } else {
        btn.classList.remove('cam-off-active');
        btn.style.background = 'rgba(255, 255, 255, 0.15)';
        btn.style.color = '#fff';
        btn.style.borderColor = 'rgba(255, 255, 255, 0.2)';
        btn.innerHTML = `<svg class="w-5 h-5 drop-shadow-md" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.069A1 1 0 0121 8.868v6.264a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>`;
      }
    }
  }

  // ── Quality change (UI-triggered) ────────────────────────────
  async function changeQuality(quality) {
    if (quality !== 'high' && quality !== 'medium') quality = 'medium';
    currentQuality = quality;

    // 1. Apply hardware capture constraints if local stream is active
    if (localStream) {
      const vTrack = localStream.getVideoTracks()[0];
      if (vTrack && QUALITY.video[quality]) {
        try {
          await vTrack.applyConstraints(QUALITY.video[quality].video);
        } catch (e) {
          console.warn('[WebRTC] applyConstraints video:', e);
        }
      }
      const aTrack = localStream.getAudioTracks()[0];
      if (aTrack && QUALITY.voice[quality]) {
        try {
          await aTrack.applyConstraints(QUALITY.voice[quality].audio);
        } catch (e) {
          console.warn('[WebRTC] applyConstraints audio:', e);
        }
      }
    }

    // 2. Apply bitrate & resolution scaling to RTCRtpSenders
    await _applySenderBitrate(quality);

    // 3. Keep all quality dropdowns synced
    document.querySelectorAll('#qualitySelect').forEach(el => {
      if (el.value !== quality) el.value = quality;
    });

    // 4. Notify remote peer of quality switch
    sendSignal({ type: 'call-quality', quality });

    // 5. User feedback toast
    if (SDH.Chat && SDH.Chat.showToast) {
      const label = quality === 'high' ? 'High Quality (HD)' : 'Medium Quality (Standard)';
      SDH.Chat.showToast(`Call quality set to ${label}`, 'success');
    }
  }

  // ── UI helpers ────────────────────────────────────────────────
  // ── Show outgoing-call (ringing) panel ──────────────────────
  function showCallingPanel(callType) {
    // Start realistic outgoing telephone ringback tone
    RingtoneEngine.startOutgoingRingback();

    // call.html bridge
    if (window._SDHCallPage) {
      window._SDHCallPage.onCalling(callType);
      return;
    }
    // chat.html: reuse the overlay, hide incoming panel, show active-like state
    const overlay = document.getElementById('callOverlay');
    const active = document.getElementById('activeCallPanel');
    document.getElementById('incomingCallPanel')?.classList.add('hidden');
    active?.classList.remove('hidden');
    active?.classList.add('flex');
    overlay?.classList.remove('hidden');
    const user = document.getElementById('activeCallUser');
    if (user) user.textContent = remoteUser || '';
    document.getElementById('audioCallVisual')?.classList.remove('hidden');
  }

  function showIncomingCallPanel(callerUsername, callType) {
    // ── call.html bridge ──────────────────────────────────────────
    if (window._SDHCallPage) {
      window._SDHCallPage.onIncomingCall(callerUsername, callType);
      return;
    }

    // ── chat.html overlay ─────────────────────────────────────────
    const overlay = document.getElementById('callOverlay');
    const panel = document.getElementById('incomingCallPanel');
    const active = document.getElementById('activeCallPanel');
    if (!overlay || !panel) return;

    document.getElementById('callerName').textContent = callerUsername;
    document.getElementById('callTypeLabel').textContent =
      callType === 'video' ? '📹 Video Call' : '📞 Voice Call';

    panel.classList.remove('hidden');
    panel.classList.add('flex');
    active.classList.add('hidden');
    overlay.classList.remove('hidden');
  }

  function showActiveCallPanel(callType) {
    // ── call.html bridge ──────────────────────────────────────────
    if (window._SDHCallPage) {
      window._SDHCallPage.onCallActive(callType);
      return;
    }

    // ── chat.html overlay ─────────────────────────────────────────
    const overlay = document.getElementById('callOverlay');
    const incomingP = document.getElementById('incomingCallPanel');
    const activeP = document.getElementById('activeCallPanel');
    const audioVisual = document.getElementById('audioCallVisual');
    const activeUser = document.getElementById('activeCallUser');
    const localVideo = document.getElementById('localVideo');

    incomingP?.classList.add('hidden');
    incomingP?.classList.remove('flex');
    activeP?.classList.remove('hidden');
    overlay?.classList.remove('hidden');

    if (callType === 'video') {
      audioVisual?.classList.add('hidden');
      localVideo?.classList.remove('hidden');
    } else {
      audioVisual?.classList.remove('hidden');
      localVideo?.classList.add('hidden');
      if (activeUser) activeUser.textContent = remoteUser || '';
    }
  }

  function hideCallOverlay() {
    // ── call.html bridge ──────────────────────────────────────────
    if (window._SDHCallPage) {
      window._SDHCallPage.onCallEnded();
      return;
    }

    // ── chat.html overlay ─────────────────────────────────────────
    document.getElementById('callOverlay')?.classList.add('hidden');
    document.getElementById('incomingCallPanel')?.classList.add('hidden');
    document.getElementById('activeCallPanel')?.classList.add('hidden');
  }

  function updateAudioVisual() {
    const audioVisual = document.getElementById('audioCallVisual');
    if (!audioVisual) return;
    if (currentCallType === 'voice' || isCameraOff) {
      audioVisual.classList.remove('hidden');
    } else {
      audioVisual.classList.add('hidden');
    }
  }

  // ── Set which user we're calling / chatting with ─────────────
  /**
   * setRemoteUser(username)
   * Called by SDH.Chat when the user selects a contact in the sidebar.
   * Only updates the remoteUser reference — does NOT reconnect the socket,
   * because the persistent signaling socket opened via init() serves ALL calls.
   * If init() was never called (e.g. page visited without DOMContentLoaded
   * triggering it), we lazily open the socket here as a fallback.
   */
  function setRemoteUser(username) {
    remoteUser = username;
    // Lazy init fallback: ensure the inbox socket is open
    if (currentUsername && (!signalSocket || signalSocket.readyState === WebSocket.CLOSED)) {
      _openSignalSocket(currentUsername);
    }
  }

  // ── Permission error helper ───────────────────────────────────
  function _handleMediaError(err) {
    const name = err?.name || '';
    let msg;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      msg = 'Microphone/camera permission was denied. Please allow access in your browser settings and try again.';
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      msg = 'No microphone or camera found. Please connect a device and try again.';
    } else if (name === 'NotReadableError' || name === 'TrackStartError') {
      msg = 'Your microphone or camera is already in use by another application.';
    } else {
      msg = `Could not access media device: ${err.message}`;
    }
    SDH.Chat?.showToast(msg, 'error');
    console.error('[WebRTC] Media error:', err);
  }

  // ── High-Fidelity Professional Ringtone Synthesizer Engine ──────
  const RingtoneEngine = (() => {
    let audioCtx = null;
    let ringtoneTimer = null;
    let ringbackTimer = null;
    let previewTimer = null;
    let activeNodes = [];
    let shankhaAudioBuffer = null;
    let shankhaLoading = false;

    function getAudioContext() {
      if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      return audioCtx;
    }

    function getSelectedTone() {
      return localStorage.getItem('sdh_call_ringtone') || 'shankha';
    }

    function getVolume() {
      const v = parseFloat(localStorage.getItem('sdh_ringtone_vol'));
      return isNaN(v) ? 0.75 : Math.max(0, Math.min(1, v));
    }

    function isRingbackEnabled() {
      return localStorage.getItem('sdh_ringback_enabled') !== 'false';
    }

    function stopAllNodes() {
      activeNodes.forEach(node => {
        try {
          if (node.stop) node.stop();
          if (node.disconnect) node.disconnect();
          if (node.pause) node.pause();
        } catch (e) { }
      });
      activeNodes = [];
    }

    // Play a synthetic note with harmonic overtones and smooth envelope
    function playHarmonicTone(ctx, freq, startTime, duration, masterGain, type = 'sine') {
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = type;
      osc1.frequency.setValueAtTime(freq, startTime);

      // Harmonic overtone (octave higher for shimmer & warmth)
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(freq * 2, startTime);

      osc1.connect(gain1);
      gain1.connect(masterGain);
      osc2.connect(gain2);
      gain2.connect(masterGain);

      const attack = 0.015;
      gain1.gain.setValueAtTime(0.0001, startTime);
      gain1.gain.exponentialRampToValueAtTime(0.65, startTime + attack);
      gain1.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

      gain2.gain.setValueAtTime(0.0001, startTime);
      gain2.gain.exponentialRampToValueAtTime(0.2, startTime + attack);
      gain2.gain.exponentialRampToValueAtTime(0.0001, startTime + (duration * 0.7));

      osc1.start(startTime);
      osc1.stop(startTime + duration + 0.05);
      osc2.start(startTime);
      osc2.stop(startTime + duration + 0.05);

      activeNodes.push(osc1, osc2, gain1, gain2);
    }

    // 1. Celestial Chime: Warm, luxury polyphonic arpeggio
    function playCelestial(ctx, masterGain) {
      const now = ctx.currentTime;
      const notes = [
        { f: 523.25, t: 0.00, d: 0.8 }, // C5
        { f: 659.25, t: 0.12, d: 0.8 }, // E5
        { f: 783.99, t: 0.24, d: 0.9 }, // G5
        { f: 1046.50, t: 0.36, d: 1.2 }, // C6
        { f: 1174.66, t: 0.58, d: 0.6 }, // D6 shimmer
        { f: 1046.50, t: 0.74, d: 1.4 }  // C6 resolve
      ];
      notes.forEach(n => playHarmonicTone(ctx, n.f, now + n.t, n.d, masterGain, 'sine'));
    }

    // 2. Executive Lounge: Smooth corporate vibraphone chord progression
    function playExecutive(ctx, masterGain) {
      const now = ctx.currentTime;
      // Chord 1: A4, C#5, E5
      [440.00, 554.37, 659.25].forEach(f => playHarmonicTone(ctx, f, now, 0.9, masterGain, 'sine'));
      // Chord 2: B4, D#5, F#5
      [493.88, 622.25, 739.99].forEach(f => playHarmonicTone(ctx, f, now + 0.45, 1.4, masterGain, 'sine'));
    }

    // 3. Modern Marimba: Crisp acoustic wooden percussion motif
    function playMarimba(ctx, masterGain) {
      const now = ctx.currentTime;
      const notes = [
        { f: 783.99, t: 0.00, d: 0.35 },
        { f: 987.77, t: 0.14, d: 0.35 },
        { f: 1174.66, t: 0.28, d: 0.45 },
        { f: 987.77, t: 0.44, d: 0.35 },
        { f: 783.99, t: 0.60, d: 0.70 }
      ];
      notes.forEach(n => playHarmonicTone(ctx, n.f, now + n.t, n.d, masterGain, 'triangle'));
    }

    // 4. Cosmic Horizon: Ambient ethereal drifting chord
    function playCosmic(ctx, masterGain) {
      const now = ctx.currentTime;
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      const gain = ctx.createGain();

      osc1.frequency.value = 587.33;
      osc2.frequency.value = 880.00;
      osc2.detune.value = 8;

      lfo.frequency.value = 4.5;
      lfoGain.gain.value = 6;
      lfo.connect(osc1.frequency);
      lfo.connect(osc2.frequency);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(masterGain);

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.5, now + 0.2);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 1.8);

      lfo.start(now);
      osc1.start(now);
      osc2.start(now);
      lfo.stop(now + 1.9);
      osc1.stop(now + 1.9);
      osc2.stop(now + 1.9);

      activeNodes.push(osc1, osc2, lfo, lfoGain, gain);
    }

    // 5. Classic Bell: Crisp modern telephone dual-tone (440Hz + 480Hz)
    function playClassic(ctx, masterGain) {
      const now = ctx.currentTime;
      const playPulse = (start) => {
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain = ctx.createGain();

        osc1.frequency.value = 440;
        osc2.frequency.value = 480;

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(masterGain);

        gain.gain.setValueAtTime(0.001, start);
        gain.gain.linearRampToValueAtTime(0.4, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.45);

        osc1.start(start);
        osc2.start(start);
        osc1.stop(start + 0.48);
        osc2.stop(start + 0.48);
        activeNodes.push(osc1, osc2, gain);
      };
      playPulse(now);
      playPulse(now + 0.55);
    }

    function preloadOriginalShankha(ctx) {
      if (shankhaAudioBuffer || shankhaLoading) return;
      shankhaLoading = true;
      fetch('/static/sounds/shankha.mp3')
        .then(res => {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.arrayBuffer();
        })
        .then(arr => ctx.decodeAudioData(arr))
        .then(decoded => {
          shankhaAudioBuffer = decoded;
          shankhaLoading = false;
        })
        .catch(err => {
          console.warn('[RingtoneEngine] Preload shankha error:', err);
          shankhaLoading = false;
        });
    }

    // 6. Divine Shankha: Authentic original sacred conch blast recording (शंख नाद)
    function playShankha(ctx, masterGain) {
      const now = ctx.currentTime;
      preloadOriginalShankha(ctx);
      if (shankhaAudioBuffer) {
        try {
          const source = ctx.createBufferSource();
          source.buffer = shankhaAudioBuffer;
          source.connect(masterGain);
          source.start(now);
          activeNodes.push(source);
        } catch (e) {
          console.warn('[RingtoneEngine] WebAudio buffer playback error:', e);
        }
      } else {
        // Direct HTML5 Audio fallback
        try {
          const audio = new Audio('/static/sounds/shankha.mp3');
          audio.volume = getVolume();
          audio.play().catch(e => console.warn('[RingtoneEngine] Shankha HTML5 play error:', e));
          activeNodes.push({
            stop: () => { audio.pause(); audio.currentTime = 0; },
            pause: () => { audio.pause(); audio.currentTime = 0; },
            disconnect: () => {}
          });
        } catch (e) {
          console.warn('[RingtoneEngine] Shankha fallback error:', e);
        }
      }
    }

    const TONES = {
      'shankha': { name: 'Divine Shankha', desc: 'Original sacred conch shell blast (शंख नाद)', badge: 'Divine', play: playShankha, interval: 6800 },
      'celestial': { name: 'Celestial Chime', desc: 'Modern luxury polyphonic chime', badge: 'Popular', play: playCelestial, interval: 2800 },
      'executive': { name: 'Executive Lounge', desc: 'Warm corporate vibraphone chords', badge: 'Refined', play: playExecutive, interval: 3000 },
      'marimba': { name: 'Modern Marimba', desc: 'Crisp acoustic rosewood percussion', badge: 'Upbeat', play: playMarimba, interval: 2600 },
      'cosmic': { name: 'Cosmic Horizon', desc: 'Ambient ethereal futuristic pad', badge: 'Ambient', play: playCosmic, interval: 3200 },
      'classic': { name: 'Classic Bell', desc: 'Modernized dual-cadence telephone ring', badge: 'Classic', play: playClassic, interval: 2800 },
    };

    function startIncomingRingtone() {
      stopAll();
      try {
        const ctx = getAudioContext();
        const toneId = getSelectedTone();
        const tone = TONES[toneId] || TONES['celestial'];
        const vol = getVolume();

        const masterGain = ctx.createGain();
        masterGain.gain.value = vol;
        masterGain.connect(ctx.destination);

        const loop = () => {
          try {
            tone.play(ctx, masterGain);
          } catch (e) {
            console.warn('[RingtoneEngine] loop error:', e);
          }
        };

        loop();
        ringtoneTimer = setInterval(loop, tone.interval);

        // Auto stop after 35s if not answered
        setTimeout(() => stopIncomingRingtone(), 35_000);
      } catch (err) {
        console.warn('[RingtoneEngine] start error:', err);
      }
    }

    function stopIncomingRingtone() {
      if (ringtoneTimer) {
        clearInterval(ringtoneTimer);
        ringtoneTimer = null;
      }
      stopAllNodes();
    }

    // Realistic outgoing telephone ringback tone (soft dual tone 400Hz + 450Hz)
    function startOutgoingRingback() {
      stopAll();
      if (!isRingbackEnabled()) return;
      try {
        const ctx = getAudioContext();
        const vol = Math.min(0.22, getVolume() * 0.35);

        const masterGain = ctx.createGain();
        masterGain.gain.value = vol;
        masterGain.connect(ctx.destination);

        const playRingbackPulse = () => {
          const now = ctx.currentTime;
          const osc1 = ctx.createOscillator();
          const osc2 = ctx.createOscillator();
          const gain = ctx.createGain();

          osc1.frequency.value = 400;
          osc2.frequency.value = 450;

          osc1.connect(gain);
          osc2.connect(gain);
          gain.connect(masterGain);

          gain.gain.setValueAtTime(0.001, now);
          gain.gain.linearRampToValueAtTime(0.35, now + 0.05);
          gain.gain.setValueAtTime(0.35, now + 1.2);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 1.35);

          osc1.start(now);
          osc2.start(now);
          osc1.stop(now + 1.4);
          osc2.stop(now + 1.4);
          activeNodes.push(osc1, osc2, gain);
        };

        playRingbackPulse();
        ringbackTimer = setInterval(playRingbackPulse, 3800);
      } catch (e) {
        console.warn('[RingtoneEngine] ringback error:', e);
      }
    }

    function stopOutgoingRingback() {
      if (ringbackTimer) {
        clearInterval(ringbackTimer);
        ringbackTimer = null;
      }
      stopAllNodes();
    }

    function stopAll() {
      stopIncomingRingtone();
      stopOutgoingRingback();
      stopPreview();
    }

    function previewTone(toneId) {
      stopAll();
      const tone = TONES[toneId] || TONES['celestial'];
      const ctx = getAudioContext();
      const masterGain = ctx.createGain();
      masterGain.gain.value = getVolume();
      masterGain.connect(ctx.destination);

      tone.play(ctx, masterGain);

      if (previewTimer) clearTimeout(previewTimer);
      const previewDuration = (toneId === 'shankha') ? 6700 : Math.min(3500, Math.max(2500, (tone.interval || 3000) - 200));
      previewTimer = setTimeout(() => {
        stopPreview();
      }, previewDuration);
    }

    function stopPreview() {
      if (previewTimer) {
        clearTimeout(previewTimer);
        previewTimer = null;
      }
      stopAllNodes();
      document.querySelectorAll('.sdh-tone-preview-btn').forEach(b => {
        b.innerHTML = '▶ Preview';
        b.classList.remove('bg-divine-gold', 'text-black');
      });
    }

    function playChime() {
      try {
        const ctx = getAudioContext();
        const masterGain = ctx.createGain();
        masterGain.gain.value = Math.min(0.6, getVolume());
        masterGain.connect(ctx.destination);
        const now = ctx.currentTime;
        playHarmonicTone(ctx, 587.33, now, 0.35, masterGain, 'sine');        // D5
        playHarmonicTone(ctx, 880.00, now + 0.14, 0.55, masterGain, 'sine'); // A5
      } catch (e) {
        console.warn('[RingtoneEngine] playChime error:', e);
      }
    }

    return {
      TONES,
      getSelectedTone,
      getVolume,
      isRingbackEnabled,
      startIncomingRingtone,
      stopIncomingRingtone,
      startOutgoingRingback,
      stopOutgoingRingback,
      stopAll,
      previewTone,
      stopPreview,
      playChime,
      setRingtone: (toneId) => {
        if (TONES[toneId]) localStorage.setItem('sdh_call_ringtone', toneId);
      },
      setVolume: (vol) => {
        localStorage.setItem('sdh_ringtone_vol', vol.toString());
      },
      setRingbackEnabled: (enabled) => {
        localStorage.setItem('sdh_ringback_enabled', enabled ? 'true' : 'false');
      }
    };
  })();

  // ── Ringtone helper methods ────────────────────────────────────
  function _startRingtone() {
    RingtoneEngine.startIncomingRingtone();
  }

  function _stopRingtone() {
    RingtoneEngine.stopAll();
  }

  // ── Ringtone Settings UI Logic ─────────────────────────────────
  function openRingtoneSettings() {
    const modal = document.getElementById('ringtoneSettingsModal');
    if (!modal) return;
    renderRingtoneSettingsUI();
    modal.classList.remove('hidden');
  }

  function renderRingtoneSettingsUI() {
    const listEl = document.getElementById('ringtoneOptionsList');
    if (!listEl) return;

    const currentTone = RingtoneEngine.getSelectedTone();
    const currentVol = Math.round(RingtoneEngine.getVolume() * 100);
    const ringbackOn = RingtoneEngine.isRingbackEnabled();

    const slider = document.getElementById('ringtoneVolSlider');
    if (slider) slider.value = currentVol;
    const volLabel = document.getElementById('ringtoneVolLabel');
    if (volLabel) volLabel.textContent = `${currentVol}%`;

    const toggle = document.getElementById('ringbackToneToggle');
    if (toggle) toggle.checked = ringbackOn;

    let html = '';
    for (const [id, info] of Object.entries(RingtoneEngine.TONES)) {
      const isSelected = id === currentTone;
      html += `
        <div class="rs-tone-card p-3 rounded-2xl border transition-all flex items-center justify-between cursor-pointer ${isSelected
          ? 'is-selected border-divine-gold/70 bg-divine-gold/10 shadow-[0_0_15px_rgba(212,175,55,0.15)]'
          : 'border-divine-border/60 bg-divine-surface/40 hover:border-divine-gold/40'
        }" onclick="SDH.WebRTC.selectRingtone('${id}')">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold ${isSelected ? 'bg-divine-gold text-black' : 'bg-white/5 text-divine-muted border border-white/10'
        }">
              ${isSelected ? '✓' : '♪'}
            </div>
            <div>
              <div class="flex items-center gap-2">
                <span class="tone-name text-xs font-bold text-divine-text">${info.name}</span>
                <span class="text-[9px] font-semibold px-1.5 py-0.2 rounded-full ${isSelected ? 'bg-divine-gold/20 text-divine-gold border border-divine-gold/30' : 'bg-white/5 text-divine-muted border border-white/10'
        }">${info.badge}</span>
              </div>
              <p class="tone-desc text-[10px] text-divine-muted mt-0.5">${info.desc}</p>
            </div>
          </div>
          <button type="button" onclick="event.stopPropagation(); SDH.WebRTC.togglePreview('${id}', this)"
            class="sdh-tone-preview-btn px-2.5 py-1 rounded-lg border border-divine-gold/40 bg-divine-gold/10 hover:bg-divine-gold/20 text-divine-gold text-[10px] font-bold transition-all">
            ▶ Preview
          </button>
        </div>
      `;
    }
    listEl.innerHTML = html;
  }

  function selectRingtone(toneId) {
    RingtoneEngine.setRingtone(toneId);
    renderRingtoneSettingsUI();
    SDH.Chat?.showToast?.(`Ringtone set to "${RingtoneEngine.TONES[toneId].name}"`, 'success');
  }

  let activePreviewToneId = null;
  function togglePreview(toneId, btn) {
    if (activePreviewToneId === toneId) {
      RingtoneEngine.stopPreview();
      activePreviewToneId = null;
      btn.innerHTML = '▶ Preview';
      btn.classList.remove('bg-divine-gold', 'text-black');
    } else {
      activePreviewToneId = toneId;
      RingtoneEngine.previewTone(toneId);
      document.querySelectorAll('.sdh-tone-preview-btn').forEach(b => {
        b.innerHTML = '▶ Preview';
        b.classList.remove('bg-divine-gold', 'text-black');
      });
      btn.innerHTML = '⏹ Stop';
      btn.classList.add('bg-divine-gold', 'text-black');
    }
  }

  function onVolumeSliderChange(val) {
    const v = parseInt(val, 10) / 100;
    RingtoneEngine.setVolume(v);
    const volLabel = document.getElementById('ringtoneVolLabel');
    if (volLabel) volLabel.textContent = `${val}%`;
  }

  function onRingbackToggleChange(checked) {
    RingtoneEngine.setRingbackEnabled(checked);
    SDH.Chat?.showToast?.(checked ? 'Outgoing ringback tone enabled' : 'Outgoing ringback tone disabled', 'info');
  }

  function testIncomingCall() {
    document.getElementById('ringtoneSettingsModal')?.classList.add('hidden');
    RingtoneEngine.stopPreview();
    showIncomingCallPanel('Demo Caller', 'voice');
    _startRingtone();
    setTimeout(() => {
      _stopRingtone();
      hideCallOverlay();
      SDH.Chat?.showToast?.('Test call ended.', 'info');
    }, 4000);
  }

  // ── Named spec aliases ────────────────────────────────────────

  /**
   * initializePeerConnection()
   * Named alias as required by the spec.
   */
  async function initializePeerConnection() {
    return createPeerConnection();
  }

  /**
   * startVoiceCall(quality)
   * Start an audio-only call with the currently selected remote user.
   */
  function startVoiceCall(quality = 'medium') {
    return startCall('voice', quality);
  }

  /**
   * startVideoCall(quality)
   * Start a video+audio call with the currently selected remote user.
   */
  function startVideoCall(quality = 'medium') {
    return startCall('video', quality);
  }

  // ── Public API ────────────────────────────────────────────────
  return {
    // Page-level initialisation (call once on DOMContentLoaded)
    init,
    // Contact selection
    setRemoteUser,
    // Peer connection
    initializePeerConnection,
    // Call initiation
    startCall,
    startVoiceCall,
    startVideoCall,
    // Call control
    acceptCall,
    rejectCall,
    endCall,
    // In-call controls
    toggleMute,
    toggleCamera,
    changeQuality,
    // Video switch & upgrade controls
    requestVideoUpgrade,
    acceptVideoUpgrade,
    rejectVideoUpgrade,
    isCallInProgress: () => isCallActive,
    getCallType: () => currentCallType,
    // Ringtone & Audio Settings
    openRingtoneSettings,
    selectRingtone,
    togglePreview,
    previewTone: RingtoneEngine.previewTone,
    stopTonePreview: RingtoneEngine.stopPreview,
    onVolumeSliderChange,
    onRingbackToggleChange,
    testIncomingCall,
    getRingtoneEngine: () => RingtoneEngine,
  };

})();
