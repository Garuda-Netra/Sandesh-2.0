/**
 * SDH – Chat Lock & Biometric / PIN Security Module
 * ==================================================
 * WhatsApp-style Chat Lock with Device Biometrics (Fingerprint / Face ID / Windows Hello)
 * and 4-6 digit Security PIN fallback.
 */

'use strict';

window.SDH = window.SDH || {};

SDH.ChatLock = (() => {
  // ── State ───────────────────────────────────────────────────────
  let isUnlocked            = false;
  let hasSecurityPin        = false;
  let biometricEnabled      = false;
  let lockedUserIds         = new Set();
  let lockedGroupIds        = new Set();
  let isSavedMessagesLocked = false;
  let folderExpanded        = false;
  let forceShowFolder       = false;
  let autoLockTimeoutId     = null;
  const AUTO_LOCK_DELAY_MS  = 5 * 60 * 1000; // 5 minutes inactivity

  // PIN input buffer for Auth Modal
  let currentPinBuffer      = '';
  let authSuccessCallback   = null;

  // Targets for Lock Warning and Unlock / Forgot PIN flows
  let pendingLockTarget     = null;
  let pendingUnlockTarget   = null;

  // ── Helper: Base64 / ArrayBuffer conversions for WebAuthn ───────
  function _bufferToBase64Url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  function _base64UrlToBuffer(base64url) {
    if (!base64url) return new ArrayBuffer(0);
    let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
      base64 += '=';
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // ── Check if WebAuthn platform authenticator is available ───────
  async function isWebAuthnAvailable() {
    if (window.PublicKeyCredential &&
        typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
      try {
        return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  // ── Initialization ──────────────────────────────────────────────
  function init() {
    const d = window.SDH_DATA || {};
    isUnlocked            = !!d.isSessionUnlocked;
    hasSecurityPin        = !!d.hasSecurityPin;
    biometricEnabled      = !!d.biometricEnabled;
    isSavedMessagesLocked = !!d.isSavedMessagesLocked;

    if (Array.isArray(d.lockedUserIds)) {
      lockedUserIds = new Set(d.lockedUserIds.map(String));
    }
    if (Array.isArray(d.lockedGroupIds)) {
      lockedGroupIds = new Set(d.lockedGroupIds.map(String));
    }

    // Set up auto-lock if currently unlocked
    if (isUnlocked) {
      _resetAutoLockTimer();
    }

    // Bind keyboard event for PIN input when auth modal is open
    document.addEventListener('keydown', _handleGlobalKeyDown);

    // Initial DOM synchronization
    syncLockedItemsInDom();

    // Check if user arrived via ?open_locked=1 from Settings
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('open_locked') === '1') {
      forceShowFolder = true;
      syncLockedItemsInDom();
      setTimeout(() => {
        _handleOpenLockedParam();
      }, 350);
    }
  }

  function _handleOpenLockedParam() {
    const folderEl = document.getElementById('lockedChatsFolder');
    if (folderEl) {
      folderEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    const count = getLockedCount();
    if (count === 0) {
      folderExpanded = true;
      syncLockedItemsInDom();
      if (window.SDH?.Chat?.showToast) {
        SDH.Chat.showToast('Locked folder ready. To lock a chat, open it and select (⋯) → Lock Chat', 'info');
      }
    } else if (!isUnlocked) {
      toggleLockedFolder();
    } else {
      folderExpanded = true;
      syncLockedItemsInDom();
    }
  }

  // ── Auto-Lock Timer ─────────────────────────────────────────────
  function _resetAutoLockTimer() {
    if (autoLockTimeoutId) clearTimeout(autoLockTimeoutId);
    autoLockTimeoutId = setTimeout(() => {
      console.log('[ChatLock] Inactivity timeout reached. Locking session.');
      lockNow(false);
    }, AUTO_LOCK_DELAY_MS);
  }

  function _clearAutoLockTimer() {
    if (autoLockTimeoutId) {
      clearTimeout(autoLockTimeoutId);
      autoLockTimeoutId = null;
    }
  }

  // ── Check if a chat is locked ───────────────────────────────────
  function isChatLocked(chatIdentifier, isGroup = false) {
    if (!chatIdentifier) return false;
    const str = String(chatIdentifier);

    if (str === window.SDH_DATA?.currentUser || str === 'saved') {
      return isSavedMessagesLocked;
    }

    if (isGroup || str.startsWith('group_')) {
      const gId = str.replace('group_', '');
      return lockedGroupIds.has(gId);
    }

    // Check by user ID or username
    if (lockedUserIds.has(str)) return true;
    const uObj = window.SDH_DATA?.users?.find(u => u.username === str);
    if (uObj && lockedUserIds.has(String(uObj.id))) return true;

    return false;
  }

  function getLockedCount() {
    return lockedUserIds.size + lockedGroupIds.size + (isSavedMessagesLocked ? 1 : 0);
  }

  // ── DOM Synchronization ─────────────────────────────────────────
  function syncLockedItemsInDom() {
    const totalLocked = getLockedCount();
    const folderEl = document.getElementById('lockedChatsFolder');
    const badgeEl = document.getElementById('lockedChatsBadge');
    const itemsContainer = document.getElementById('lockedChatsItemsContainer');
    const statusIconEl = document.getElementById('lockedFolderStatusIcon');
    const chevronEl = document.getElementById('lockedFolderChevron');

    if (badgeEl) badgeEl.textContent = String(totalLocked);

    if (folderEl) {
      if (totalLocked > 0 || forceShowFolder) {
        folderEl.classList.remove('hidden');
      } else {
        folderEl.classList.add('hidden');
      }
    }

    // Status icon in folder header
    if (statusIconEl) {
      if (isUnlocked) {
        statusIconEl.title = 'Click to lock immediately';
        statusIconEl.innerHTML = `<button type="button" onclick="event.stopPropagation(); SDH.ChatLock.lockNow();" class="p-1 rounded-lg hover:bg-emerald-500/20 text-emerald-400 transition-colors" title="Lock Now"><svg class="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z"/></svg></button>`;
      } else {
        statusIconEl.title = 'Protected';
        statusIconEl.innerHTML = `<svg class="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>`;
      }
    }

    if (chevronEl) {
      chevronEl.style.transform = (isUnlocked && folderExpanded) ? 'rotate(180deg)' : 'rotate(0deg)';
    }

    // Handle container visibility
    if (itemsContainer) {
      if (isUnlocked && folderExpanded) {
        itemsContainer.classList.remove('hidden');
        // If totalLocked is 0, show helpful empty state prompt
        const existingEmpty = itemsContainer.querySelector('.sdh-locked-empty-prompt');
        if (totalLocked === 0) {
          if (!existingEmpty) {
            const emptyEl = document.createElement('div');
            emptyEl.className = 'sdh-locked-empty-prompt px-3 py-3 text-center text-xs text-purple-300/80 bg-purple-500/5 rounded-xl border border-purple-500/20 my-1';
            emptyEl.innerHTML = `
              <p class="font-semibold text-purple-300">No locked chats yet</p>
              <p class="text-[11px] text-divine-muted mt-0.5">To lock a chat, open conversation & tap (⋯) → Lock Chat</p>
            `;
            itemsContainer.appendChild(emptyEl);
          }
        } else if (existingEmpty) {
          existingEmpty.remove();
        }
      } else {
        itemsContainer.classList.add('hidden');
      }
    }

    // Move locked items into locked container when unlocked & expanded;
    // hide them from normal sidebar when locked.
    const userList = document.getElementById('userList');
    const dmsContainer = document.getElementById('dmsContainer') || userList;
    const groupsContainer = document.getElementById('groupsContainer') || userList;

    // Process all user items
    document.querySelectorAll('.user-item[data-username]').forEach(el => {
      const username = el.dataset.username;
      const userId = el.dataset.userid;
      const isSelf = el.dataset.self === '1';
      const locked = isSelf ? isSavedMessagesLocked : (lockedUserIds.has(String(userId)) || isChatLocked(username));

      if (locked) {
        el.setAttribute('data-locked', '1');
        _attachItemLockBadge(el);

        if (isUnlocked && folderExpanded && itemsContainer) {
          if (el.parentElement !== itemsContainer) {
            itemsContainer.appendChild(el);
          }
          el.classList.remove('hidden');
        } else {
          // Hide from normal view when folder is closed or session is locked
          el.classList.add('hidden');
          if (el.parentElement !== itemsContainer && itemsContainer) {
            itemsContainer.appendChild(el);
          }
        }
      } else {
        el.removeAttribute('data-locked');
        _removeItemLockBadge(el);
        // Move back to dmsContainer if it was in itemsContainer
        if (el.parentElement === itemsContainer && dmsContainer) {
          dmsContainer.appendChild(el);
        }
        el.classList.remove('hidden');
      }
    });

    // Process all group items
    document.querySelectorAll('.user-item[data-group="1"]').forEach(el => {
      const groupId = el.dataset.groupid;
      const locked = lockedGroupIds.has(String(groupId));

      if (locked) {
        el.setAttribute('data-locked', '1');
        _attachItemLockBadge(el);

        if (isUnlocked && folderExpanded && itemsContainer) {
          if (el.parentElement !== itemsContainer) {
            itemsContainer.appendChild(el);
          }
          el.classList.remove('hidden');
        } else {
          el.classList.add('hidden');
          if (el.parentElement !== itemsContainer && itemsContainer) {
            itemsContainer.appendChild(el);
          }
        }
      } else {
        el.removeAttribute('data-locked');
        _removeItemLockBadge(el);
        if (el.parentElement === itemsContainer && groupsContainer) {
          groupsContainer.appendChild(el);
        }
        el.classList.remove('hidden');
      }
    });

    // Update Kebab menu lock/unlock text for active conversation
    _updateKebabLockText();
  }

  function _attachItemLockBadge(itemEl) {
    if (itemEl.querySelector('.sdh-chat-lock-badge')) return;
    const nameEl = itemEl.querySelector('.sdh-user-name');
    if (!nameEl) return;
    const lockBadge = document.createElement('span');
    lockBadge.className = 'sdh-chat-lock-badge inline-flex items-center ml-1 text-purple-400';
    lockBadge.title = 'Locked Chat';
    lockBadge.innerHTML = `<svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>`;
    nameEl.appendChild(lockBadge);
  }

  function _removeItemLockBadge(itemEl) {
    const badge = itemEl.querySelector('.sdh-chat-lock-badge');
    if (badge) badge.remove();
  }

  function _updateKebabLockText() {
    const active = window.SDH?.Chat?.getActiveUser?.() || sessionStorage.getItem('ndm_last_chat');
    const lockUserText = document.getElementById('lockChatBtnText');
    const lockGroupText = document.getElementById('lockGroupBtnText');

    if (!active) return;
    const locked = isChatLocked(active, active.startsWith('group_'));

    if (lockUserText) {
      lockUserText.textContent = locked ? 'Unlock Chat' : 'Lock Chat';
    }
    if (lockGroupText) {
      lockGroupText.textContent = locked ? 'Unlock Group' : 'Lock Group';
    }
  }

  // ── Folder Interaction ──────────────────────────────────────────
  function toggleLockedFolder() {
    if (!isUnlocked) {
      showAuthModal({
        reason: 'Unlock Locked Chats',
        onSuccess: () => {
          folderExpanded = true;
          syncLockedItemsInDom();
        }
      });
    } else {
      folderExpanded = !folderExpanded;
      syncLockedItemsInDom();
    }
  }

  // ── Chat Access Interceptor ─────────────────────────────────────
  function ensureChatAccessible(target, isGroup, onAllowed) {
    const locked = isChatLocked(target, isGroup);
    if (!locked || isUnlocked) {
      if (typeof onAllowed === 'function') onAllowed();
      return;
    }

    // Chat is locked and session is not unlocked -> prompt auth
    showAuthModal({
      reason: `Unlock to view this chat`,
      onSuccess: () => {
        if (typeof onAllowed === 'function') onAllowed();
      }
    });
  }

  // ── Auth Modal (Biometrics / PIN) ───────────────────────────────
  function showAuthModal({ reason = 'Unlock Locked Chats', onSuccess = null } = {}) {
    authSuccessCallback = onSuccess;
    currentPinBuffer = '';
    _renderPinDots();

    const modal = document.getElementById('chatLockAuthModal');
    if (!modal) return;

    const titleEl = document.getElementById('chatLockAuthReason');
    if (titleEl) titleEl.textContent = reason;

    const errEl = document.getElementById('chatLockAuthError');
    if (errEl) {
      errEl.textContent = '';
      errEl.classList.add('hidden');
    }

    modal.classList.remove('hidden');

    // If device biometrics are enrolled, optionally trigger prompt immediately
    if (biometricEnabled) {
      const bioBtn = document.getElementById('chatLockBioBtn');
      if (bioBtn) bioBtn.classList.remove('hidden');
      setTimeout(() => {
        authenticateBiometrics();
      }, 250);
    } else {
      const bioBtn = document.getElementById('chatLockBioBtn');
      if (bioBtn) bioBtn.classList.add('hidden');
    }
  }

  function closeAuthModal() {
    const modal = document.getElementById('chatLockAuthModal');
    if (modal) modal.classList.add('hidden');
    currentPinBuffer = '';
    authSuccessCallback = null;
  }

  // ── Keypad & PIN Entry ──────────────────────────────────────────
  function enterPinDigit(digit) {
    if (currentPinBuffer.length >= 6) return;
    currentPinBuffer += String(digit);
    _renderPinDots();

    // Auto-verify when 4 to 6 digits reached (if 4, check after slight debounce or manual OK)
    if (currentPinBuffer.length === 4 || currentPinBuffer.length === 6) {
      // Small pause so the user sees the filled dot
      setTimeout(() => {
        if (currentPinBuffer.length === 4 || currentPinBuffer.length === 6) {
          submitPin();
        }
      }, 100);
    }
  }

  function clearPinDigit() {
    if (currentPinBuffer.length > 0) {
      currentPinBuffer = currentPinBuffer.slice(0, -1);
      _renderPinDots();
    }
  }

  function resetPinBuffer() {
    currentPinBuffer = '';
    _renderPinDots();
  }

  function _renderPinDots() {
    const dots = document.querySelectorAll('.sdh-pin-dot');
    dots.forEach((dot, idx) => {
      if (idx < currentPinBuffer.length) {
        dot.classList.add('sdh-pin-dot-active');
      } else {
        dot.classList.remove('sdh-pin-dot-active');
      }
    });
  }

  function _handleGlobalKeyDown(e) {
    const authModal = document.getElementById('chatLockAuthModal');
    if (!authModal || authModal.classList.contains('hidden')) return;

    if (e.key >= '0' && e.key <= '9') {
      e.preventDefault();
      enterPinDigit(e.key);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      clearPinDigit();
    } else if (e.key === 'Escape') {
      closeAuthModal();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      submitPin();
    }
  }

  // ── Verify PIN via Server ───────────────────────────────────────
  async function submitPin() {
    if (!currentPinBuffer || currentPinBuffer.length < 4) {
      _showAuthError('Please enter at least 4 digits.');
      return;
    }

    const errEl = document.getElementById('chatLockAuthError');
    if (errEl) errEl.classList.add('hidden');

    try {
      const res = await fetch(window.SDH_DATA.verifyPinUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': window.SDH_DATA.csrfToken,
        },
        body: JSON.stringify({ pin: currentPinBuffer }),
      });

      const data = await res.json();
      if (!res.ok) {
        _showAuthError(data.error || 'Incorrect PIN.');
        _shakePinDots();
        currentPinBuffer = '';
        _renderPinDots();
        return;
      }

      // Success
      _onUnlockSuccess();
    } catch (err) {
      _showAuthError('Network error verifying PIN. Please try again.');
    }
  }

  function _shakePinDots() {
    const container = document.getElementById('sdhPinDotsContainer');
    if (container) {
      container.classList.add('sdh-shake');
      setTimeout(() => container.classList.remove('sdh-shake'), 500);
    }
  }

  function _showAuthError(msg) {
    const errEl = document.getElementById('chatLockAuthError');
    if (errEl) {
      errEl.textContent = msg;
      errEl.classList.remove('hidden');
    }
  }

  // ── WebAuthn Biometric Authentication ───────────────────────────
  async function authenticateBiometrics() {
    if (!window.PublicKeyCredential) {
      _showAuthError('Biometrics not supported on this browser. Use PIN.');
      return;
    }

    try {
      const optRes = await fetch(window.SDH_DATA.webauthnAuthOptionsUrl, {
        headers: { 'X-CSRFToken': window.SDH_DATA.csrfToken }
      });
      const options = await optRes.json();
      if (!optRes.ok) {
        _showAuthError(options.error || 'Biometric auth not available.');
        return;
      }

      // Format options for navigator.credentials.get
      options.challenge = _base64UrlToBuffer(options.challenge);
      if (Array.isArray(options.allowCredentials)) {
        options.allowCredentials = options.allowCredentials.map(c => ({
          type: c.type,
          id: _base64UrlToBuffer(c.id),
        }));
      }

      const assertion = await navigator.credentials.get({ publicKey: options });
      if (!assertion) throw new Error('Biometric scan failed or cancelled.');

      const verifyPayload = {
        id: assertion.id,
        rawId: _bufferToBase64Url(assertion.rawId),
        response: {
          authenticatorData: _bufferToBase64Url(assertion.response.authenticatorData),
          clientDataJSON: _bufferToBase64Url(assertion.response.clientDataJSON),
          signature: _bufferToBase64Url(assertion.response.signature),
        }
      };

      const verRes = await fetch(window.SDH_DATA.webauthnAuthVerifyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': window.SDH_DATA.csrfToken,
        },
        body: JSON.stringify(verifyPayload),
      });

      const verData = await verRes.json();
      if (!verRes.ok) {
        _showAuthError(verData.error || 'Biometric verification failed.');
        return;
      }

      _onUnlockSuccess();
    } catch (err) {
      console.warn('[ChatLock] Biometric authentication error:', err);
      if (err.name !== 'AbortError') {
        _showAuthError('Biometric cancelled or failed. Use PIN below.');
      }
    }
  }

  // ── Successful Unlock Handler ───────────────────────────────────
  function _onUnlockSuccess() {
    isUnlocked = true;
    _resetAutoLockTimer();
    closeAuthModal();
    syncLockedItemsInDom();

    if (window.SDH?.Chat?.showToast) {
      SDH.Chat.showToast('Chats unlocked 🔓', 'success');
    }

    if (typeof authSuccessCallback === 'function') {
      const cb = authSuccessCallback;
      authSuccessCallback = null;
      cb();
    }
  }

  // ── Setup Security PIN & Biometrics Modal ───────────────────────
  function showSetupModal() {
    const modal = document.getElementById('chatLockSetupModal');
    if (!modal) return;

    document.getElementById('setupNewPin').value = '';
    document.getElementById('setupConfirmPin').value = '';
    document.getElementById('setupEnableBio').checked = true;

    const errEl = document.getElementById('setupPinError');
    if (errEl) {
      errEl.textContent = '';
      errEl.classList.add('hidden');
    }

    modal.classList.remove('hidden');
  }

  function closeSetupModal() {
    const modal = document.getElementById('chatLockSetupModal');
    if (modal) modal.classList.add('hidden');
  }

  async function submitSetupPin() {
    const pin = document.getElementById('setupNewPin')?.value.trim();
    const confirm = document.getElementById('setupConfirmPin')?.value.trim();
    const enableBio = !!document.getElementById('setupEnableBio')?.checked;
    const errEl = document.getElementById('setupPinError');

    if (!pin || pin.length < 4 || pin.length > 6 || !/^\d+$/.test(pin)) {
      if (errEl) {
        errEl.textContent = 'PIN must be between 4 and 6 numeric digits.';
        errEl.classList.remove('hidden');
      }
      return;
    }

    if (pin !== confirm) {
      if (errEl) {
        errEl.textContent = 'PINs do not match. Please re-enter.';
        errEl.classList.remove('hidden');
      }
      return;
    }

    try {
      const res = await fetch(window.SDH_DATA.setupPinUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': window.SDH_DATA.csrfToken,
        },
        body: JSON.stringify({ pin }),
      });

      const data = await res.json();
      if (!res.ok) {
        if (errEl) {
          errEl.textContent = data.error || 'Failed to setup PIN.';
          errEl.classList.remove('hidden');
        }
        return;
      }

      hasSecurityPin = true;
      isUnlocked = true;
      _resetAutoLockTimer();

      if (enableBio) {
        // Attempt biometric enrollment
        await registerBiometrics();
      }

      closeSetupModal();
      if (window.SDH?.Chat?.showToast) {
        SDH.Chat.showToast('Security PIN configured successfully! 🔒', 'success');
      }

      // If user was in the process of locking the current chat, lock it now
      toggleCurrentChatLock();
    } catch (e) {
      if (errEl) {
        errEl.textContent = 'Error saving security PIN.';
        errEl.classList.remove('hidden');
      }
    }
  }

  // ── Register Biometrics (WebAuthn create) ────────────────────────
  async function registerBiometrics() {
    if (!window.PublicKeyCredential) return false;

    try {
      const optRes = await fetch(window.SDH_DATA.webauthnRegOptionsUrl, {
        headers: { 'X-CSRFToken': window.SDH_DATA.csrfToken }
      });
      const options = await optRes.json();
      if (!optRes.ok) return false;

      options.challenge = _base64UrlToBuffer(options.challenge);
      options.user.id = _base64UrlToBuffer(options.user.id);

      const credential = await navigator.credentials.create({ publicKey: options });
      if (!credential) return false;

      const verifyPayload = {
        id: credential.id,
        rawId: _bufferToBase64Url(credential.rawId),
        type: credential.type,
        clientDataJSON: _bufferToBase64Url(credential.response.clientDataJSON),
        attestationObject: _bufferToBase64Url(credential.response.attestationObject),
      };

      const verRes = await fetch(window.SDH_DATA.webauthnRegVerifyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': window.SDH_DATA.csrfToken,
        },
        body: JSON.stringify(verifyPayload),
      });

      const verData = await verRes.json();
      if (verRes.ok) {
        biometricEnabled = true;
        if (window.SDH?.Chat?.showToast) {
          SDH.Chat.showToast('Device biometrics linked! 🖐️', 'success');
        }
        return true;
      }
    } catch (err) {
      console.warn('[ChatLock] Biometric registration skipped or cancelled:', err);
    }
    return false;
  }

  // ── Lock Confirmation Warning Modal ─────────────────────────────
  function showWarningModal(target) {
    pendingLockTarget = target;
    const modal = document.getElementById('chatLockWarningModal');
    if (!modal) {
      confirmLockChat();
      return;
    }
    const titleEl = document.getElementById('chatLockWarningTitle');
    if (titleEl) {
      const name = target.displayName || target.targetId || 'this chat';
      titleEl.textContent = `Lock chat with ${name}?`;
    }
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }

  function closeWarningModal() {
    const modal = document.getElementById('chatLockWarningModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
    pendingLockTarget = null;
  }

  async function confirmLockChat() {
    if (!pendingLockTarget) return;
    const { chatType, targetId, displayName } = pendingLockTarget;

    if (!hasSecurityPin) {
      closeWarningModal();
      showSetupModal();
      return;
    }

    try {
      const res = await fetch(window.SDH_DATA.chatLockToggleUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': window.SDH_DATA.csrfToken,
        },
        body: JSON.stringify({
          chat_type: chatType,
          target_id: targetId,
          locked: true,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        if (data.needs_setup) {
          closeWarningModal();
          showSetupModal();
          return;
        }
        if (window.SDH?.Chat?.showToast) {
          SDH.Chat.showToast(data.error || 'Failed to lock chat', 'error');
        }
        return;
      }

      if (chatType === 'saved') {
        isSavedMessagesLocked = true;
      } else if (chatType === 'group') {
        lockedGroupIds.add(String(targetId));
      } else {
        lockedUserIds.add(String(targetId));
      }

      // Immediately lock session and secure UI
      isUnlocked = false;
      folderExpanded = false;
      _clearAutoLockTimer();
      const active = window.SDH?.Chat?.getActiveUser?.() || sessionStorage.getItem('ndm_last_chat');
      if (active && isChatLocked(active, active.startsWith('group_'))) {
        if (window.SDH?.Chat?._resetConversationPanel) {
          window.SDH.Chat._resetConversationPanel();
        }
      }

      closeWarningModal();
      syncLockedItemsInDom();

      if (window.SDH?.Chat?.showToast) {
        SDH.Chat.showToast(`Chat with ${displayName || 'user'} is now locked 🔒`, 'success');
      }
    } catch (err) {
      console.error('[ChatLock] confirmLockChat error:', err);
      if (window.SDH?.Chat?.showToast) {
        SDH.Chat.showToast('Network error locking chat', 'error');
      }
    }
  }

  // ── Execute Unlock after Authentication ──────────────────────────
  async function executeUnlock(chatType, targetId, displayName) {
    try {
      const res = await fetch(window.SDH_DATA.chatLockToggleUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': window.SDH_DATA.csrfToken,
        },
        body: JSON.stringify({
          chat_type: chatType,
          target_id: targetId,
          locked: false,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        if (window.SDH?.Chat?.showToast) {
          SDH.Chat.showToast(data.error || 'Failed to unlock chat', 'error');
        }
        return;
      }

      if (chatType === 'saved') {
        isSavedMessagesLocked = false;
      } else if (chatType === 'group') {
        lockedGroupIds.delete(String(targetId));
      } else {
        lockedUserIds.delete(String(targetId));
      }

      syncLockedItemsInDom();
      if (window.SDH?.Chat?.showToast) {
        SDH.Chat.showToast(`Chat with ${displayName || 'user'} unlocked 🔓`, 'success');
      }
    } catch (err) {
      console.error('[ChatLock] executeUnlock error:', err);
    }
  }

  // ── Lock / Unlock from Item (Sidebar or Menu) ────────────────────
  function toggleLockFromItem(chatType, targetId, displayName = null) {
    if (chatType === 'user') chatType = 'direct';

    if (!displayName) {
      if (chatType === 'saved' || targetId === 'saved') {
        displayName = 'Saved Messages';
      } else if (chatType === 'group') {
        displayName = `Group #${targetId}`;
      } else {
        const uObj = window.SDH_DATA?.users?.find(u => String(u.id) === String(targetId) || u.username === targetId);
        displayName = uObj?.username || targetId;
      }
    }

    const locked = isChatLocked(targetId, chatType === 'group');

    if (!locked) {
      // Intention: Lock this chat! Show professional warning notice first.
      showWarningModal({ chatType, targetId, displayName });
    } else {
      // Intention: Unlock this chat! MUST require authentication!
      pendingUnlockTarget = { chatType, targetId, displayName };
      showAuthModal({
        reason: `Enter PIN or scan fingerprint to unlock ${displayName}`,
        onSuccess: () => {
          const target = pendingUnlockTarget;
          pendingUnlockTarget = null;
          if (target) {
            executeUnlock(target.chatType, target.targetId, target.displayName);
          }
        }
      });
    }
  }

  // ── Toggle Lock on Current Active Chat ───────────────────────────
  function toggleCurrentChatLock() {
    const active = window.SDH?.Chat?.getActiveUser?.() || sessionStorage.getItem('ndm_last_chat');
    const activeId = window.SDH?.Chat?.getActiveUserId?.() || sessionStorage.getItem('ndm_last_chat_id');
    const activeName = window.SDH?.Chat?.getActiveChatName?.() || sessionStorage.getItem('ndm_last_chat_name') || active;

    if (!active) {
      if (window.SDH?.Chat?.showToast) {
        SDH.Chat.showToast('Please select a chat first.', 'info');
      }
      return;
    }

    let chatType = 'direct';
    let targetId = active;

    if (active.startsWith('group_')) {
      chatType = 'group';
      targetId = active.replace('group_', '');
    } else if (active === window.SDH_DATA?.currentUser) {
      chatType = 'saved';
      targetId = 'saved';
    } else {
      chatType = 'direct';
      targetId = activeId || active;
    }

    toggleLockFromItem(chatType, targetId, activeName);
  }

  // ── Forgot PIN / Delete Data to Unlock Flow ──────────────────────
  function onForgotPinClicked() {
    closeAuthModal();

    const modal = document.getElementById('chatLockForgotModal');
    if (!modal) return;

    const warnTextEl = document.getElementById('chatLockForgotWarningText');
    const titleEl = document.getElementById('chatLockForgotTitle');
    const confirmBtn = document.getElementById('chatLockForgotConfirmBtn');

    if (pendingUnlockTarget) {
      const name = pendingUnlockTarget.displayName || 'this locked chat';
      if (titleEl) titleEl.textContent = `Unlock ${name}`;
      if (warnTextEl) {
        warnTextEl.textContent = `All messages, files, and media for "${name}" will be permanently deleted to remove the lock and restore this chat to your regular list.`;
      }
      if (confirmBtn) confirmBtn.textContent = `Delete & Unlock ${name}`;
    } else {
      const count = getLockedCount();
      if (titleEl) titleEl.textContent = `Reset & Unlock All Chats`;
      if (warnTextEl) {
        warnTextEl.textContent = `All messages, media, and data across your ${count} locked chat(s) will be permanently deleted to unlock all chats and reset your Security PIN.`;
      }
      if (confirmBtn) confirmBtn.textContent = `Delete All & Reset`;
    }

    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }

  function closeForgotModal() {
    const modal = document.getElementById('chatLockForgotModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  }

  async function confirmDeleteAndUnlock() {
    const target = pendingUnlockTarget;
    const payload = target ? {
      chat_type: target.chatType,
      target_id: target.targetId,
    } : { target_id: 'all' };

    try {
      const res = await fetch(window.SDH_DATA.chatLockUnlockClearUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': window.SDH_DATA.csrfToken,
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        if (window.SDH?.Chat?.showToast) {
          SDH.Chat.showToast(data.error || 'Failed to clear data and unlock', 'error');
        }
        return;
      }

      if (data.cleared_all) {
        lockedUserIds.clear();
        lockedGroupIds.clear();
        isSavedMessagesLocked = false;
        hasSecurityPin = false;
        biometricEnabled = false;
        isUnlocked = true;
      } else if (target) {
        if (target.chatType === 'saved') isSavedMessagesLocked = false;
        else if (target.chatType === 'group') lockedGroupIds.delete(String(target.targetId));
        else {
          lockedUserIds.delete(String(target.targetId));
          if (data.user_id) lockedUserIds.delete(String(data.user_id));
        }
      }

      // If viewing cleared chat, reset view
      if (window.SDH?.Chat?._resetConversationPanel) {
        window.SDH.Chat._resetConversationPanel();
      }

      closeForgotModal();
      pendingUnlockTarget = null;
      syncLockedItemsInDom();

      if (window.SDH?.Chat?.showToast) {
        SDH.Chat.showToast(data.message || 'Chat cleared and unlocked.', 'success');
      }
    } catch (err) {
      console.error('[ChatLock] confirmDeleteAndUnlock error:', err);
      if (window.SDH?.Chat?.showToast) {
        SDH.Chat.showToast('Network error while unlocking chat.', 'error');
      }
    }
  }

  // ── Lock Immediately ────────────────────────────────────────────
  async function lockNow(showNotification = true) {
    try {
      await fetch(window.SDH_DATA.chatLockNowUrl, {
        method: 'POST',
        headers: { 'X-CSRFToken': window.SDH_DATA.csrfToken }
      });
    } catch (e) {}

    isUnlocked = false;
    folderExpanded = false;
    _clearAutoLockTimer();
    syncLockedItemsInDom();

    // If currently viewing a locked chat, close it
    const active = window.SDH?.Chat?.getActiveUser?.() || sessionStorage.getItem('ndm_last_chat');
    if (active && isChatLocked(active, active.startsWith('group_'))) {
      if (window.SDH?.Chat?._resetConversationPanel) {
        window.SDH.Chat._resetConversationPanel();
      }
    }

    if (showNotification && window.SDH?.Chat?.showToast) {
      SDH.Chat.showToast('Locked chats secured 🔒', 'info');
    }
  }

  // ── Public API ──────────────────────────────────────────────────
  return {
    init,
    isChatLocked,
    getLockedCount,
    toggleLockedFolder,
    ensureChatAccessible,
    showAuthModal,
    closeAuthModal,
    enterPinDigit,
    clearPinDigit,
    resetPinBuffer,
    submitPin,
    authenticateBiometrics,
    showSetupModal,
    closeSetupModal,
    submitSetupPin,
    registerBiometrics,
    toggleCurrentChatLock,
    toggleLockFromItem,
    showWarningModal,
    closeWarningModal,
    confirmLockChat,
    onForgotPinClicked,
    closeForgotModal,
    confirmDeleteAndUnlock,
    lockNow,
    syncLockedItemsInDom,
    isUnlocked: () => isUnlocked,
  };
})();

// Auto-initialize immediately when script loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => SDH.ChatLock.init());
} else {
  SDH.ChatLock.init();
}
