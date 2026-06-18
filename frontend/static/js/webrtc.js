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
  let peerConnection       = null;
  let signalSocket         = null;
  let localStream          = null;
  let currentUsername      = null;   // OUR own username (signaling inbox)
  let remoteUser           = null;   // contact selected in sidebar
  let callPeer             = null;   // username of person we're in/requesting a call with
  let currentCallType      = null;   // 'voice' | 'video'
  let currentQuality       = 'medium';
  let isMuted              = false;
  let isCameraOff          = false;
  let isCallActive         = false;
  let pendingOffer         = null;   // call-request data while waiting for user to accept
  let pendingOfferSdp      = null;   // buffered SDP offer — processed only AFTER user accepts
  let pendingIceCandidates = [];     // ICE candidates buffered before setRemoteDescription
  let ringtoneInterval     = null;   // handle for incoming-call ringtone loop
  let videoSwapped         = false;
  let stylesSaved          = false;
  let originalRemoteClasses= '';
  let originalLocalClasses = '';
  let originalLocalStyle   = '';
  let originalRemoteStyle  = '';

  // ── Media quality presets ─────────────────────────────────────
  const QUALITY = {
    voice: {
      medium: { audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 32000 }, video: false },
      high:   { audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 }, video: false },
    },
    video: {
      medium: {
        audio: { echoCancellation: true, noiseSuppression: true },
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
      },
      high: {
        audio: { echoCancellation: true, noiseSuppression: true },
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
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
    const turnUrl  = window.SDH_DATA?.turnServerUrl;
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
    const url    = `${wsBase}/ws/signal/${encodeURIComponent(username)}/`;

    signalSocket = new WebSocket(url);
    signalSocket.onmessage = onSignal;
    signalSocket.onerror   = e => console.error('[WebRTC] Signal socket error:', e);
    signalSocket.onclose   = e => {
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
      case 'call-upgrade':
        if (data.call_type === 'video') {
          currentCallType = 'video';
          const remoteAudio = document.getElementById('remoteAudio');
          const remoteVideo = document.getElementById('remoteVideo');
          if (remoteAudio && remoteVideo && remoteAudio.srcObject) {
            remoteVideo.srcObject = remoteAudio.srcObject;
          }
          updateAudioVisual();
          if (SDH.Chat && SDH.Chat.showToast) SDH.Chat.showToast('Call upgraded to video', 'info');
        }
        break;
    }
  }

  // ── Initiate outgoing call ────────────────────────────────────
  async function startCall(callType, quality = 'medium') {
    if (!remoteUser) {
      SDH.Chat?.showToast('Select a contact first.', 'warning');
      return;
    }
    if (isCallActive) {
      SDH.Chat?.showToast('Already in a call.', 'warning');
      return;
    }

    currentCallType = callType;
    currentQuality  = quality;
    callPeer        = remoteUser;   // ← record who we are calling

    // Request media permissions FIRST so the browser prompt appears before
    // any network activity, and we can bail cleanly on denial.
    try {
      localStream = await navigator.mediaDevices.getUserMedia(QUALITY[callType][quality]);
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
      callPeer    = null;
      return;
    }

    isCallActive = true;

    // Show "Calling…" stage — active panel shown only after remote accepts
    showCallingPanel(callType);

    // Signal the remote user.  sendSignal() picks up callPeer automatically.
    sendSignal({ type: 'call-request', call_type: callType, quality });

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
    callPeer     = data.from;
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
    currentQuality  = quality;
    // callPeer was already set in handleIncomingCallRequest

    // Get local media FIRST — tracks must be added before creating the answer
    try {
      localStream = await navigator.mediaDevices.getUserMedia(QUALITY[call_type][quality]);
    } catch (err) {
      sendSignal({ type: 'call-reject', reason: 'media_error' });
      pendingOffer    = null;
      pendingOfferSdp = null;
      callPeer        = null;
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
    pendingOffer    = null;
    pendingOfferSdp = null;
    callPeer        = null;
    pendingIceCandidates = [];
    hideCallOverlay();
  }

  // ── Remote accepted our call ──────────────────────────────────
  async function handleCallAccepted(data) {
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

    // Mirror local video feed (video calls only)
    const localVideo = document.getElementById('localVideo');
    if (localVideo && currentCallType === 'video') {
      localVideo.srcObject = localStream;
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
      if (currentCallType === 'video') {
        const remoteVideo = document.getElementById('remoteVideo');
        if (remoteVideo) remoteVideo.srcObject = stream;
      } else {
        // Voice call — attach to an <audio> element so it plays automatically
        let remoteAudio = document.getElementById('remoteAudio');
        if (!remoteAudio) {
          remoteAudio = document.createElement('audio');
          remoteAudio.id       = 'remoteAudio';
          remoteAudio.autoplay = true;
          document.body.appendChild(remoteAudio);
        }
        remoteAudio.srcObject = stream;
      }
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

    // Re-offer during an active call (quality renegotiation, etc.)
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

  // ── Handle remote quality change request ─────────────────────
  async function handleQualityChange(data) {
    // Apply new sender video constraints
    if (currentCallType !== 'video') return;
    const q = data.quality || 'medium';
    const videoTrack = localStream?.getVideoTracks()[0];
    if (videoTrack) {
      await videoTrack.applyConstraints(QUALITY.video[q].video);
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

    isCallActive         = false;
    pendingOffer         = null;
    pendingOfferSdp      = null;
    pendingIceCandidates = [];
    isMuted              = false;
    isCameraOff          = false;
    callPeer             = null;   // reset after call ends

    // Stop all local media tracks
    localStream?.getTracks().forEach(t => t.stop());
    localStream = null;

    // Close the peer connection gracefully
    if (peerConnection) {
      peerConnection.onicecandidate    = null;
      peerConnection.ontrack           = null;
      peerConnection.onconnectionstatechange = null;
      peerConnection.close();
      peerConnection = null;
    }

    // Detach streams from video/audio elements
    const remoteVideo = document.getElementById('remoteVideo');
    const localVideo  = document.getElementById('localVideo');
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
    if (localVideo)  localVideo.srcObject  = null;
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

  // ── Toggle camera ─────────────────────────────────────────────
  async function toggleCamera() {
    const videoTracks = localStream?.getVideoTracks();
    if (!videoTracks || videoTracks.length === 0) {
      if (!localStream) return;
      try {
        const vidConstraints = QUALITY.video[currentQuality || 'medium'].video;
        const vidStream = await navigator.mediaDevices.getUserMedia({ video: vidConstraints });
        const track = vidStream.getVideoTracks()[0];
        if (!track) return;

        localStream.addTrack(track);
        currentCallType = 'video';
        isCameraOff = false;

        const localVideo = document.getElementById('localVideo');
        if (localVideo) localVideo.srcObject = localStream;

        if (peerConnection) {
          peerConnection.addTrack(track, localStream);
          const offer = await peerConnection.createOffer();
          await peerConnection.setLocalDescription(offer);
          sendSignal({ type: 'offer', sdp: offer });
        }

        sendSignal({ type: 'call-upgrade', call_type: 'video' });
        _updateCamBtnUI();
        updateAudioVisual();
        if (window.SDH?.Chat?.showToast) SDH.Chat.showToast('Upgraded to video call', 'success');
      } catch (err) {
        console.error('[WebRTC] Failed to upgrade to video:', err);
        if (window.SDH?.Chat?.showToast) SDH.Chat.showToast('Could not access camera.', 'error');
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
      btn.title = isCameraOff ? 'Turn camera on' : 'Turn camera off';
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
    currentQuality = quality;
    if (localStream && currentCallType === 'video') {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        await videoTrack.applyConstraints(QUALITY.video[quality].video);
      }
    }
    // Notify remote
    sendSignal({ type: 'call-quality', quality });
  }

  // ── UI helpers ────────────────────────────────────────────────
  // ── Show outgoing-call (ringing) panel ──────────────────────
  function showCallingPanel(callType) {
    // call.html bridge
    if (window._SDHCallPage) {
      window._SDHCallPage.onCalling(callType);
      return;
    }
    // chat.html: reuse the overlay, hide incoming panel, show active-like state
    const overlay = document.getElementById('callOverlay');
    const active  = document.getElementById('activeCallPanel');
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
    const panel   = document.getElementById('incomingCallPanel');
    const active  = document.getElementById('activeCallPanel');
    if (!overlay || !panel) return;

    document.getElementById('callerName').textContent    = callerUsername;
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
    const overlay    = document.getElementById('callOverlay');
    const incomingP  = document.getElementById('incomingCallPanel');
    const activeP    = document.getElementById('activeCallPanel');
    const audioVisual = document.getElementById('audioCallVisual');
    const activeUser  = document.getElementById('activeCallUser');

    incomingP?.classList.add('hidden');
    incomingP?.classList.remove('flex');
    activeP?.classList.remove('hidden');
    overlay?.classList.remove('hidden');

    if (callType === 'video') {
      audioVisual?.classList.add('hidden');
    } else {
      audioVisual?.classList.remove('hidden');
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

  // ── Ringtone (incoming call) ──────────────────────────────────
  function _startRingtone() {
    _stopRingtone();
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const beep = () => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type            = 'sine';
        osc.frequency.value = 480;
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.4);
      };
      beep();
      ringtoneInterval = setInterval(beep, 1200);
      // Auto-stop after 30 s if caller never gets answered
      setTimeout(() => _stopRingtone(), 30_000);
    } catch { /* AudioContext unavailable — fail silently */ }
  }

  function _stopRingtone() {
    if (ringtoneInterval) {
      clearInterval(ringtoneInterval);
      ringtoneInterval = null;
    }
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
  };

})();
