/**
 * SDH Chat Module  (production)
 * =================================
 * Features:
 *   - WebSocket connection lifecycle
 *   - Sending / receiving plain-text messages
 *   - Typing indicators with debounce
 *   - File attachment handling
 *   - Message rendering with date separators
 *   - Presence / online status + last-seen
 *   - Unread counts + sidebar badges
 *   - Browser push notifications (Notification API)
 *   - Sidebar behaviour (mobile)
 */
/* eslint-env browser */
/* global SDH, window, document, console, fetch, sessionStorage, setTimeout, clearTimeout, FileReader, confirm, location, WebSocket, FormData, Notification, URL, Blob, Image */

'use strict';

window.SDH = window.SDH || {};

// ════════════════════════════════════════════════════════════════
//  SDH.Mentions - Interactive @ Mention Autocomplete System
// ════════════════════════════════════════════════════════════════
SDH.Mentions = (function() {
  function _esc(s) {
    if (!s) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getCandidates(context = {}) {
    const currentU = (window.SDH_DATA?.currentUser || '').toLowerCase();
    const candidates = [];

    if (context.isGroup) {
      // 1. "@all" - broadcast to everyone in the group
      candidates.push({
        id: 'all',
        username: 'all',
        display_name: 'Everyone in group',
        avatar_url: null,
        is_online: true,
        isAll: true,
        badge: 'ALL'
      });

      // 2. Group members (from currentGroupMembers cache or fallback)
      const groupMembers = (typeof SDH.Chat?.getCurrentGroupMembers === 'function' ? SDH.Chat.getCurrentGroupMembers() : []) || [];
      if (groupMembers.length > 0) {
        groupMembers.forEach(m => {
          if ((m.username || '').toLowerCase() === currentU) return;
          candidates.push({
            id: m.user_id || m.id,
            username: m.username,
            display_name: m.display_name || m.username,
            avatar_url: m.avatar_url,
            is_online: Boolean(m.is_online),
            isAll: false,
            badge: m.role || 'Member'
          });
        });
        return candidates;
      }
    }

    // Direct chat or Moments or general contacts
    const users = window.SDH_DATA?.users || [];

    // In Direct Chat, place the active conversation partner at the top
    const activeU = (typeof SDH.Chat?.getActiveUser === 'function' ? SDH.Chat.getActiveUser() : '') || '';
    if (activeU && !activeU.startsWith('group_')) {
      const partner = users.find(u => u.username === activeU);
      if (partner) {
        candidates.push({
          id: partner.id,
          username: partner.username,
          display_name: partner.display_name || partner.username,
          avatar_url: partner.avatar_url,
          is_online: Boolean(partner.is_online),
          isAll: false,
          isPartner: true,
          badge: 'Active Chat'
        });
      }
    }

    // In Moments, if an author is provided, place author at top
    if (context.author && (!candidates.length || candidates[0].username !== context.author)) {
      const authorUser = users.find(u => u.username === context.author);
      if (authorUser && authorUser.username.toLowerCase() !== currentU) {
        candidates.push({
          id: authorUser.id,
          username: authorUser.username,
          display_name: authorUser.display_name || authorUser.username,
          avatar_url: authorUser.avatar_url,
          is_online: Boolean(authorUser.is_online),
          isAll: false,
          badge: 'Author'
        });
      }
    }

    users.forEach(u => {
      if ((u.username || '').toLowerCase() === currentU) return;
      if (candidates.some(c => c.username === u.username)) return;
      candidates.push({
        id: u.id,
        username: u.username,
        display_name: u.display_name || u.username,
        avatar_url: u.avatar_url,
        is_online: Boolean(u.is_online),
        isAll: false
      });
    });

    return candidates;
  }

  function attach(inputEl, options = {}) {
    if (!inputEl) return null;
    if (inputEl.dataset.sdhMentionsAttached === '1') return null;
    inputEl.dataset.sdhMentionsAttached = '1';

    let dropdownEl = options.dropdownEl;
    let listEl = dropdownEl ? dropdownEl.querySelector('#mentionList, .sdh-mention-list') : null;
    let isDynamicDropdown = false;
    let activeCandidates = [];
    let selectedIndex = 0;
    let atCharIndex = -1;

    if (!dropdownEl) {
      isDynamicDropdown = true;
      dropdownEl = document.createElement('div');
      dropdownEl.className = 'sdh-mention-dropdown hidden';
      dropdownEl.innerHTML = `
        <div class="sdh-mention-header">
          <span class="flex items-center gap-1.5">
            <span class="text-xs font-black text-indigo-400">@</span>
            <span>Mention User</span>
          </span>
          <span class="text-[9px] text-divine-muted lowercase font-normal opacity-75">↑↓ select • ↵ choose • esc</span>
        </div>
        <div class="sdh-mention-list custom-scrollbar"></div>
      `;
      listEl = dropdownEl.querySelector('.sdh-mention-list');

      const parent = inputEl.parentElement;
      if (parent && (window.getComputedStyle(parent).position !== 'static')) {
        parent.appendChild(dropdownEl);
      } else {
        document.body.appendChild(dropdownEl);
        dropdownEl.style.position = 'fixed';
      }
    }

    function positionDropdown() {
      if (!isDynamicDropdown) return;
      if (dropdownEl.style.position === 'fixed') {
        const rect = inputEl.getBoundingClientRect();
        dropdownEl.style.left = `${Math.max(12, rect.left)}px`;
        dropdownEl.style.bottom = `${Math.max(12, window.innerHeight - rect.top + 8)}px`;
      }
    }

    function hide() {
      dropdownEl.classList.add('hidden');
      activeCandidates = [];
      selectedIndex = 0;
      atCharIndex = -1;
    }

    function renderCandidates(candidates) {
      if (!listEl) return;
      listEl.innerHTML = candidates.map((item, idx) => {
        const isSel = idx === selectedIndex;
        if (item.isAll) {
          return `
            <div class="sdh-mention-item ${isSel ? 'is-selected' : ''}" data-idx="${idx}" data-username="${_esc(item.username)}">
              <div class="w-7 h-7 rounded-full bg-gradient-to-br from-amber-500 to-yellow-400 text-black flex items-center justify-center font-black text-xs shadow-sm flex-shrink-0">
                @
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5">
                  <span class="text-xs font-bold text-amber-300">@all</span>
                  <span class="text-[9px] font-extrabold px-1 py-0.2 rounded bg-amber-400/20 text-amber-300 uppercase">Group</span>
                </div>
                <p class="text-[10px] text-divine-muted truncate">${_esc(item.display_name)}</p>
              </div>
            </div>
          `;
        }

        const initial = (item.username && item.username[0] ? item.username[0] : '?').toUpperCase();
        return `
          <div class="sdh-mention-item ${isSel ? 'is-selected' : ''}" data-idx="${idx}" data-username="${_esc(item.username)}">
            <div class="relative w-7 h-7 flex-shrink-0">
              ${item.avatar_url ? `
                <img src="${item.avatar_url}" alt="" class="w-7 h-7 rounded-full object-cover border border-white/15" />
              ` : `
                <div class="w-7 h-7 rounded-full bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 flex items-center justify-center text-xs font-bold">
                  ${initial}
                </div>
              `}
              ${item.is_online ? `
                <span class="absolute bottom-0 right-0 w-2 h-2 rounded-full bg-emerald-500 ring-1 ring-black"></span>
              ` : ''}
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="text-xs font-semibold text-divine-text truncate">${_esc(item.display_name || item.username)}</span>
                ${item.badge ? `<span class="text-[9px] font-bold px-1.5 py-0.2 rounded bg-white/10 text-divine-muted uppercase">${_esc(item.badge)}</span>` : ''}
              </div>
              <p class="text-[10px] text-divine-muted truncate">@${_esc(item.username)}</p>
            </div>
          </div>
        `;
      }).join('');

      // Click selection handler
      listEl.querySelectorAll('.sdh-mention-item').forEach(row => {
        row.onmousedown = (e) => {
          e.preventDefault();
          const idx = parseInt(row.dataset.idx, 10);
          if (candidates[idx]) {
            chooseCandidate(candidates[idx]);
          }
        };
      });
    }

    function chooseCandidate(candidate) {
      if (!candidate) return;
      const val = inputEl.value;
      const cursorPos = inputEl.selectionStart;
      const start = atCharIndex >= 0 ? atCharIndex : val.lastIndexOf('@', cursorPos - 1);
      if (start < 0) return;

      const before = val.slice(0, start);
      const after = val.slice(cursorPos);
      const insertText = `@${candidate.username} `;

      inputEl.value = before + insertText + after;
      const newPos = before.length + insertText.length;
      inputEl.setSelectionRange(newPos, newPos);

      // Trigger standard input/resize events
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      hide();
      inputEl.focus();
    }

    function onInputChange() {
      const val = inputEl.value;
      const cursorPos = inputEl.selectionStart;
      const textBefore = val.slice(0, cursorPos);
      const match = /(?:^|\s)@([a-zA-Z0-9_]*)$/.exec(textBefore);

      if (!match) {
        hide();
        return;
      }

      const activeQuery = match[1].toLowerCase();
      atCharIndex = match.index + (match[0].startsWith(' ') || match[0].startsWith('\n') ? 1 : 0);

      const ctx = typeof options.getContext === 'function' ? options.getContext() : {};
      const allCandidates = getCandidates(ctx);
      const filtered = allCandidates.filter(c => {
        if (!activeQuery) return true;
        return (c.username.toLowerCase().includes(activeQuery) ||
                (c.display_name && c.display_name.toLowerCase().includes(activeQuery)));
      });

      if (!filtered.length) {
        hide();
        return;
      }

      activeCandidates = filtered;
      selectedIndex = 0;

      renderCandidates(filtered);
      positionDropdown();
      dropdownEl.classList.remove('hidden');
    }

    function onKeyDown(e) {
      if (dropdownEl.classList.contains('hidden') || !activeCandidates.length) {
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        selectedIndex = (selectedIndex + 1) % activeCandidates.length;
        updateSelectedHighlight();
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        selectedIndex = (selectedIndex - 1 + activeCandidates.length) % activeCandidates.length;
        updateSelectedHighlight();
        return;
      }

      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        chooseCandidate(activeCandidates[selectedIndex]);
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        hide();
        return;
      }
    }

    function updateSelectedHighlight() {
      if (!listEl) return;
      const items = listEl.querySelectorAll('.sdh-mention-item');
      items.forEach((item, idx) => {
        item.classList.toggle('is-selected', idx === selectedIndex);
        if (idx === selectedIndex) {
          item.scrollIntoView({ block: 'nearest' });
        }
      });
    }

    inputEl.addEventListener('input', onInputChange);
    inputEl.addEventListener('keydown', onKeyDown);
    inputEl.addEventListener('blur', () => {
      setTimeout(hide, 200);
    });

    return {
      hide,
      getCandidates: () => getCandidates(typeof options.getContext === 'function' ? options.getContext() : {})
    };
  }

  function format(rawText) {
    if (!rawText) return '';
    const mentionRegex = /@([a-zA-Z0-9_]+)/g;
    let lastIndex = 0;
    let match;
    const parts = [];
    const currentU = (window.SDH_DATA?.currentUser || '').toLowerCase();

    while ((match = mentionRegex.exec(rawText)) !== null) {
      if (match.index > lastIndex) {
        parts.push(_esc(rawText.slice(lastIndex, match.index)));
      }
      const uname = match[1];
      const isSelf = uname.toLowerCase() === currentU;
      const isAll = uname.toLowerCase() === 'all';

      if (isAll) {
        parts.push(`<span class="sdh-mention-pill sdh-mention-me">@all</span>`);
      } else if (isSelf) {
        parts.push(`<span class="sdh-mention-pill sdh-mention-me" onclick="event.stopPropagation(); SDH.Chat?.showUserProfile?.('${_esc(uname)}')">@${_esc(uname)}</span>`);
      } else {
        parts.push(`<span class="sdh-mention-pill" onclick="event.stopPropagation(); SDH.Chat?.showUserProfile?.('${_esc(uname)}')">@${_esc(uname)}</span>`);
      }
      lastIndex = mentionRegex.lastIndex;
    }

    if (lastIndex < rawText.length) {
      parts.push(_esc(rawText.slice(lastIndex)));
    }
    return parts.join('');
  }

  return {
    getCandidates,
    attach,
    format
  };
})();

SDH.Chat = (() => {

  // â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let activeUser = null;
  let activeUserId = null;
  let currentGroupMembers = [];
  let typingTimer = null;
  let isTyping = false;
  let pendingFiles = [];
  let isViewOnceActive = false;
  let unreadCounts = {};
  const toastQueue = [];
  let isShowingToast = false;

  // Maps tempId â†’ null until server echo assigns real id
  const pendingAckMap = new Map();
  // Set of rendered message IDs (prevents duplicate renders from WS echo)
  const renderedIds = new Set();

  // â”€â”€ Constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const MAX_FILE_SIZE = 5 * 1024 * 1024;
  const TYPING_TIMEOUT = 2500;

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  //  Browser Notification
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // ── Audio & Title Notifications ─────────────────────────────
  let _sharedAudioCtx = null;
  function _getAudioContext() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      if (!_sharedAudioCtx) {
        _sharedAudioCtx = new AudioCtx();
      }
      if (_sharedAudioCtx.state === 'suspended') {
        _sharedAudioCtx.resume().catch(() => {});
      }
      return _sharedAudioCtx;
    } catch {
      return null;
    }
  }

  function playNotificationSound() {
    if (window.SDH_SETTINGS && window.SDH_SETTINGS.message_sound_enabled === false) {
      return;
    }
    try {
      const ctx = _getAudioContext();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      // Harmonic pleasant two-tone notification chime (D5 -> A5)
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.35);
    } catch { /* AudioContext suppressed by browser policy — fail silently */ }
  }

  function playSentSound() {
    if (window.SDH_SETTINGS && window.SDH_SETTINGS.message_sound_enabled === false) {
      return;
    }
    try {
      const ctx = _getAudioContext();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      // Harmonic subtle sent pop/chime (G5 -> C6)
      osc.frequency.setValueAtTime(783.99, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1046.50, ctx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.15);
    } catch { /* AudioContext suppressed by policy */ }
  }

  const _baseDocumentTitle = document.title || 'Sandesh';
  function updateDocumentTitle() {
    let totalUnread = 0;
    if (unreadCounts && typeof unreadCounts === 'object') {
      for (const count of Object.values(unreadCounts)) {
        if (typeof count === 'number' && count > 0) totalUnread += count;
      }
    }
    const cleanTitle = _baseDocumentTitle.replace(/^\(\d+\)\s*/, '');
    if (totalUnread > 0) {
      document.title = `(${totalUnread}) ${cleanTitle}`;
    } else {
      document.title = cleanTitle;
    }
  }

  const Notif = {
    requestPermission() {
      if (!('Notification' in window)) return;
      if (Notification.permission === 'default') Notification.requestPermission();
    },
    show(title, body, tag, onClick = null) {
      if (!('Notification' in window)) return;
      if (Notification.permission !== 'granted') return;
      if (document.visibilityState === 'visible' && document.hasFocus()) return;
      try {
        const n = new Notification(title, { body, tag, silent: false });
        n.onclick = () => {
          window.focus();
          if (typeof onClick === 'function') {
            try { onClick(); } catch (e) { console.error(e); }
          }
          n.close();
        };
        setTimeout(() => n.close(), 6000);
      } catch { /* Firefox private mode */ }
    },
  };

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  //  WebSocket message dispatcher
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  async function _onWsMessage(data) {
    switch (data.type) {
      case 'chat_message': await handleIncomingMessage(data); break;
      case 'group_message': await handleIncomingMessage(data); break;
      case 'file_notification': await handleIncomingFileNotification(data); break;
      case 'view_once_opened': handleViewOnceOpened(data); break;
      case 'typing': handleTypingIndicator(data); break;
      case 'delivered': _setMsgStatus(data.message_id, 'delivered'); break;
      case 'read_receipt': _markAllSentAsRead(); break;
      case 'message_status': _setMsgStatus(data.message_id, data.status); break;
      case 'group_message_status': _setMsgStatus(data.message_id, data.status); break;
      case 'message_read': _setMsgStatus(data.message_id, 'read'); break;
      case 'presence': handlePresence(data); break;
      case 'message_removed': handleMessageRemoved(data); break;
      case 'message_starred': handleMessageStarred(data); break;
      case 'chat_cleared': handleChatCleared(data); break;
      case 'live_location_updated':
        window.SDH?.LocationShare?.handleIncomingLiveUpdate?.(data);
        break;
      case 'live_location_stopped':
        window.SDH?.LocationShare?.handleIncomingLiveStopped?.(data);
        break;
      case 'user_removed': handleUserRemoved(data); break;
      case 'chat_setting_update': handleChatSettingUpdate(data); break;
      case 'friend_request': handleFriendRequest(data); break;
      case 'friend_request_accepted': handleFriendRequestAccepted(data); break;
      case 'friend_request_rejected': handleFriendRequestRejected(data); break;
      case 'user_unfriended': handleUserUnfriended(data); break;
      case 'group_invite': handleGroupInvite(data); break;
      case 'group_deleted': handleGroupDeleted(data); break;
      case 'group_member_update': handleGroupMemberUpdate(data); break;
      case 'user_blocked': handleUserBlocked(data); break;
      case 'user_unblocked': handleUserUnblocked(data); break;
      case 'user_settings_updated': handleUserSettingsUpdated(data); break;
      case 'new_moment': SDH.Moments?.handleNewMomentEvent?.(data.moment); break;
      case 'delete_moment': SDH.Moments?.handleDeleteMomentEvent?.(data.user_id, data.moment_id); break;
      case 'moment_viewed': SDH.Moments?.handleMomentViewedEvent?.(data.moment_id, data.viewer); break;
      case 'moment_reacted': SDH.Moments?.handleMomentReactedEvent?.(data.moment_id, data.reaction); break;
      case 'system_notification':
        Notif.show(data.title || 'Sandesh Alert', data.body || '', 'sdh-system-alert');
        if (typeof showToast === 'function') showToast(data.body || '', 'info');
        playNotificationSound();
        break;
      case 'pong': break;
      case 'error':
        console.error('[Chat] Server error:', data.message);
        if (data?.message) showToast(data.message, 'error');
        break;
    }
  }

  function handleUserSettingsUpdated(data) {
    if (data.settings) {
      window.SDH_SETTINGS = Object.assign(window.SDH_SETTINGS || {}, data.settings);
      if (window.SDH_DATA) {
        window.SDH_DATA.userSettings = window.SDH_SETTINGS;
      }
    }
  }

  async function handleFriendRequest(data) {
    await loadFriendRequests();
    showToast(`New friend request from ${data.sender}`, 'info');
    Notif.show(`New Friend Request`, `From ${data.sender}`, 'sdh-friend-request');
  }

  function handleFriendRequestAccepted(data) {
    if (data.new_friend) {
      showToast(`${data.new_friend} is now your friend!`, 'success');
    }

    // Clear search input so user sees the newly added friend in Direct Messages
    const searchInput = document.getElementById('searchUsers');
    if (searchInput) {
      searchInput.value = '';
    }

    // Refresh friend requests panel in case a request was pending
    loadFriendRequests();

    _refreshSidebar();
  }

  function handleFriendRequestRejected(data) {
    loadFriendRequests();
    _refreshSidebar();
  }

  function handleUserUnfriended(data) {
    const target = data.unfriender_username === window.SDH_DATA.currentUser ? data.unfriended_username : data.unfriender_username;

    // Update internal state
    const u = window.SDH_DATA?.users?.find(x => x.username === target);
    if (u) {
      u.is_friend = false;
    }

    // Hide dot
    const dot = document.getElementById(`online-dot-${target}`);
    if (dot) dot.remove();

    // Clear last seen if not blocked
    const lsEl = document.getElementById(`last-seen-${target}`);
    if (lsEl) {
      lsEl.innerHTML = '&nbsp;';
      lsEl.className = 'text-[11px] truncate mt-0.5 sdh-status-offline';
    }

    // Update dataset
    const userItem = document.getElementById(`user-item-${target}`);
    if (userItem) {
      userItem.dataset.friendship = 'none';
    }

    // If active chat, update header
    if (activeUser === target) {
      _setDefaultHeaderStatus();
    }

    _refreshSidebar();
  }

  // ── Real-time Sidebar Refresher ──────────────────────────────────────────
  async function _refreshSidebar() {
    try {
      const sep = location.href.includes('?') ? '&' : '?';
      const res = await fetch(`${location.href}${sep}_nocache=${Date.now()}`, {
        cache: 'no-store',
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
      });
      if (!res.ok) return;
      const html = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      const newUserList = doc.getElementById('userList');
      if (newUserList) {
        const newUserListHTML = newUserList.innerHTML;
        const currentList = document.getElementById('userList');
        const searchInput = document.getElementById('searchUsers');
        const isSearching = !!(searchInput && searchInput.value.trim().length > 0);

        if (currentList && !isSearching) {
          currentList.innerHTML = newUserListHTML;
          if (activeUser) {
            document.getElementById(`user-item-${activeUser}`)?.classList.add('active-chat-item');
          }
        }

        // Keep SDH.UserSearch originalHTML in sync so future searches or clears don't revert to stale HTML
        if (window.SDH?.UserSearch?.updateOriginal) {
          window.SDH.UserSearch.updateOriginal(newUserListHTML);
        }
      }

      // Update embedded SDH_DATA.users if available
      const usersDataScript = doc.getElementById('sdh-users-data');
      if (usersDataScript && window.SDH_DATA) {
        try {
          window.SDH_DATA.users = JSON.parse(usersDataScript.textContent);
        } catch (e) { }
      }

      // Update embedded SDH_DATA.groups if available
      const groupsDataScript = doc.getElementById('sdh-groups-data');
      if (groupsDataScript && window.SDH_DATA) {
        try {
          window.SDH_DATA.groups = JSON.parse(groupsDataScript.textContent || '[]');
        } catch (e) { }
      }

      // Re-apply any existing unread badges
      if (unreadCounts) {
        Object.keys(unreadCounts).forEach(u => updateUnreadBadge(u));
      }
      _updateOnlineCount();
    } catch (err) {
      console.error('[Chat] Failed to refresh sidebar:', err);
    }
  }

  function handleGroupInvite(data) {
    Notif.show(`Group Invitation`, `${data.inviter} invited you to join ${data.group_name}`, `sdh-group-invite-${data.invite_id}`);
    showGroupInviteModal(data);
  }

  function handleGroupDeleted(data) {
    const deletedGroupKey = `group_${data.group_id}`;

    // 1. Remove the group from the sidebar
    const sidebarItem = document.getElementById(`group-item-${data.group_id}`);
    if (sidebarItem) sidebarItem.remove();

    // 2. Clear any unread badge state for this group
    delete unreadCounts[deletedGroupKey];

    // 3. Close the userProfileModal if it's open (group info panel)
    const profileModal = document.getElementById('userProfileModal');
    if (profileModal && !profileModal.classList.contains('hidden')) {
      profileModal.classList.add('hidden');
    }

    // 4. If the user is currently viewing this group chat, clean up completely
    if (activeUser === deletedGroupKey) {
      _resetConversationPanel();

      // Additional header cleanup that _resetConversationPanel misses
      const avatarEl = document.getElementById('chatAvatar');
      if (avatarEl) {
        avatarEl.innerHTML = '—';
        avatarEl.style.backgroundImage = '';
        avatarEl.className = 'sdh-chat-avatar w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold select-none flex-shrink-0';
      }

      _setHeaderStatus('Choose someone to start messaging', 'default');

      const groupMenuBtn = document.getElementById('groupChatMenuBtn');
      if (groupMenuBtn) groupMenuBtn.classList.add('hidden');
    }

    // 5. Show a toast notification
    const deletedBy = data.deleted_by || 'The owner';
    if (data.reason === 'removed') {
      showToast(`You have been removed from the group "${data.group_name}" by ${deletedBy}.`, 'info');
    } else {
      showToast(`"${data.group_name}" was deleted by ${deletedBy}.`, 'info');
    }
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  //  WebSocket lifecycle callbacks
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  function _onWsOpen() {
    _setDefaultHeaderStatus();
    fetchPendingGroupInvites();
    // Immediately notify the sender that we've read all messages in this chat
    if (activeUser && SDH.WS.isOpen() && !activeUser.startsWith('group_')) {
      if (!window.SDH_SETTINGS || window.SDH_SETTINGS.read_receipts_enabled !== false) {
        SDH.WS.sendMessage({ type: 'read_receipt' });
      }
    }
  }

  function _onWsClose(event) {
    _setHeaderStatus('Disconnected', 'disconnected');
    if (event.code === 4001) showToast('Session expired. Please log in again.', 'error');
    else if (event.code === 4004) showToast('User not found.', 'error');
  }

  function _isSelfChat(username) {
    return !!username && username === window.SDH_DATA?.currentUser;
  }

  function _displayNameFor(username) {
    return _isSelfChat(username) ? 'Saved Messages' : username;
  }

  function _defaultEmptyStateInnerHtml() {
    return `
        <div class="sdh-empty-orb mb-7">
          <div class="sdh-orb-glow"></div>
          <div class="sdh-orb-ring"></div>
          <div class="sdh-flying-bubbles" aria-hidden="true"><span></span><span></span><span></span></div>
          <div class="sdh-sandesh-hero select-none">
            <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" class="w-full h-full">
              <defs>
                <linearGradient id="bbFill" x1="11" y1="8" x2="61" y2="42" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stop-color="#c084fc" stop-opacity="0.28" />
                  <stop offset="100%" stop-color="#7c3aed" stop-opacity="0.07" />
                </linearGradient>
                <linearGradient id="bbStroke" x1="11" y1="8" x2="61" y2="42" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stop-color="#c084fc" />
                  <stop offset="100%" stop-color="#818cf8" />
                </linearGradient>
                <linearGradient id="fbFill" x1="3" y1="22" x2="53" y2="56" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stop-color="#818cf8" stop-opacity="0.22" />
                  <stop offset="100%" stop-color="#a855f7" stop-opacity="0.05" />
                </linearGradient>
                <linearGradient id="fbStroke" x1="3" y1="22" x2="53" y2="56" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stop-color="#a855f7" />
                  <stop offset="100%" stop-color="#c084fc" />
                </linearGradient>
                <linearGradient id="dotGrad" x1="0" y1="0" x2="0" y2="4.4" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stop-color="#f3e8ff" />
                  <stop offset="100%" stop-color="#c084fc" />
                </linearGradient>
              </defs>
              <path d="M52 8H20a9 9 0 00-9 9v15a9 9 0 009 9h3l-2 7 9-7h22a9 9 0 009-9V17a9 9 0 00-9-9z"
                fill="url(#bbFill)" stroke="url(#bbStroke)" stroke-width="1.5" stroke-linejoin="round" />
              <path d="M44 22H12a9 9 0 00-9 9v13a9 9 0 009 9h3l-2 7 9-7h22a9 9 0 009-9V31a9 9 0 00-9-9z"
                fill="url(#fbFill)" stroke="url(#fbStroke)" stroke-width="1.5" stroke-linejoin="round" />
              <circle cx="21" cy="37.5" r="2.3" fill="url(#dotGrad)" />
              <circle cx="28" cy="37.5" r="2.3" fill="url(#dotGrad)" />
              <circle cx="35" cy="37.5" r="2.3" fill="url(#dotGrad)" />
            </svg>
          </div>
        </div>

        <div class="sdh-empty-divider"></div>
        <span class="sdh-empty-badge mb-3">SANDESH</span>
        <p class="sdh-empty-title mb-2">Select a contact to begin</p>
        <p class="sdh-empty-sub">Pick a conversation from the sidebar to start chatting</p>
      `;
  }

  // ── Contact Sidebar Helpers ─────────────────────────────────────────
  function _moveContactToTop(targetUsername) {
    if (!targetUsername || _isSelfChat(targetUsername) || targetUsername.startsWith('group_')) return;
    const isLocked = window.SDH?.ChatLock?.isChatLocked?.(targetUsername, false);
    if (isLocked) return;

    const targetItem = document.getElementById(`user-item-${targetUsername}`);
    if (!targetItem) return;

    const container = targetItem.parentNode || document.getElementById('dmsContainer') || document.getElementById('userList');
    if (!container) return;

    const savedMsgItem = container.querySelector('[data-self="1"]');
    if (savedMsgItem && savedMsgItem !== targetItem) {
      if (savedMsgItem.nextSibling !== targetItem) {
        container.insertBefore(targetItem, savedMsgItem.nextSibling);
      }
    } else if (!savedMsgItem) {
      container.prepend(targetItem);
    }
  }

  function _ensureUserInSidebar(username, userId) {
    if (!username || _isSelfChat(username) || username.startsWith('group_')) return;

    const existing = document.getElementById(`user-item-${username}`);
    if (existing) {
      if (!window.SDH?.ChatLock?.isChatLocked?.(username, false)) {
        _moveContactToTop(username);
      }
      return existing;
    }

    if (!userId) {
      const uObj = window.SDH_DATA?.users?.find(u => u.username === username);
      if (uObj?.id) userId = uObj.id;
      else if (sessionStorage.getItem('ndm_last_chat') === username) {
        userId = sessionStorage.getItem('ndm_last_chat_id');
      }
    }

    const initial = (username[0] || '?').toUpperCase();
    const displayName = _displayNameFor(username);
    const itemHTML = `
      <div id="user-item-${username}" class="sdh-user-item user-item relative w-full flex items-center gap-3 px-4 py-3.5 group/usr"
           data-username="${username}" data-userid="${userId || ''}" data-friendship="friend">
        <div class="flex items-center gap-3 flex-1 min-w-0 cursor-pointer"
             onclick="SDH.Chat.selectUser('${username}', '${userId || ''}')">
          <div class="relative flex-shrink-0 cursor-pointer" onclick="event.stopPropagation(); SDH.Chat.showUserProfile('${username}', '${userId || ''}')">
            <div class="sdh-avatar sdh-avatar-initial w-11 h-11 rounded-full flex items-center justify-center text-sm font-bold select-none">
              ${initial}
            </div>
            <span id="online-dot-${username}" class="sdh-online-dot absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 flex-shrink-0 sdh-online-dot--off"></span>
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between gap-2">
              <span class="sdh-user-name text-sm font-semibold truncate" style="color:var(--c-text)">${displayName}</span>
              <span id="unread-${username}" class="sdh-unread-badge hidden flex-shrink-0 text-[10px] font-bold leading-none px-1.5 py-0.5 rounded-full"></span>
            </div>
            <p id="last-seen-${username}" class="text-[11px] truncate mt-0.5 sdh-status-offline">Ready to chat</p>
          </div>
        </div>
        <div class="user-ctx-wrap relative flex-shrink-0 z-10 opacity-100 sm:opacity-0 sm:group-hover/usr:opacity-100 transition-opacity duration-150" onclick="event.stopPropagation()">
          <button onclick="SDH.Chat._toggleUserMenu(this)" class="w-7 h-7 flex items-center justify-center rounded-full text-divine-muted/50 hover:text-divine-gold hover:bg-divine-card/80 border border-transparent hover:border-divine-border/60 transition-all leading-none select-none" title="User options">⋯</button>
          <div class="user-ctx-dropdown hidden z-[9999] w-52 bg-divine-card border border-divine-border/80 rounded-xl shadow-2xl overflow-hidden py-1">
            <button onclick="SDH.Chat.showUserProfile('${username}', '${userId || ''}')" class="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-divine-muted hover:text-divine-text hover:bg-divine-surface transition-colors text-left">
              <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
              View Profile
            </button>
            <button onclick="SDH.ChatLock.toggleLockFromItem('direct', '${userId || username}', '${username}'); SDH.Chat._closeAllUserMenus();" class="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-purple-400/90 hover:text-purple-300 hover:bg-divine-surface transition-colors text-left">
              <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
              Lock / Unlock Chat
            </button>
            <div class="border-t border-divine-border/40 mx-2 my-0.5"></div>
            <button onclick="SDH.Chat._confirmUnfriend('${userId || ''}', '${username}')" class="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-red-400/80 hover:text-red-400 hover:bg-divine-surface transition-colors text-left">
              <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 11c1.657 0 3-1.343 3-3S17.657 5 16 5M21 21v-2a4 4 0 00-3-3.874M13 7a4 4 0 11-8 0 4 4 0 018 0zM9 14a6 6 0 00-6 6v1h12v-1a6 6 0 00-6-6zM21 12h-6" /></svg>
              Unfriend
            </button>
            <button onclick="SDH.Chat._confirmRemoveUser('${userId || ''}', '${username}')" class="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-divine-muted hover:text-divine-text hover:bg-divine-surface transition-colors text-left">
              <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7a4 4 0 11-8 0 4 4 0 018 0zM9 14a6 6 0 00-6 6v1h12v-1a6 6 0 00-6-6zM21 12h-6" /></svg>
              Remove from My List
            </button>
          </div>
        </div>
      </div>
    `;

    if (window.SDH?.UserSearch?.addUser) {
      window.SDH.UserSearch.addUser(username, userId, itemHTML);
    } else if (dms) {
      const savedMsg = dms.querySelector('[data-self="1"]');
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = itemHTML;
      const newEl = tempDiv.firstElementChild;
      if (newEl) {
        if (savedMsg && savedMsg.nextSibling) {
          dms.insertBefore(newEl, savedMsg.nextSibling);
        } else if (savedMsg) {
          dms.appendChild(newEl);
        } else {
          dms.prepend(newEl);
        }
      }
    }

    if (activeUser === username) {
      document.getElementById(`user-item-${username}`)?.classList.add('active-chat-item');
    }

    if (window.SDH_DATA?.users && !window.SDH_DATA.users.some(u => u.username === username)) {
      window.SDH_DATA.users.push({
        id: userId ? (parseInt(userId, 10) || userId) : null,
        username: username,
        is_friend: true,
        is_online: false,
        is_blocked: false,
        is_chat_blocked: false
      });
    }
    _updateOnlineCount();
  }

  function _setDefaultHeaderStatus() {
    const e2eTag = ' • 🔒 E2E Encrypted';
    if (_isSelfChat(activeUser)) {
      _setHeaderStatus('Only visible to you' + e2eTag, 'connected');
    } else if (activeUser && activeUser.startsWith('group_')) {
      _setHeaderStatus('Group Chat' + e2eTag, 'connected');
    } else {
      const userObj = window.SDH_DATA?.users?.find(u => u.username === activeUser);
      const userItem = document.getElementById(`user-item-${activeUser}`);
      const isBlocked = userItem?.dataset?.blocked === '1' || userItem?.dataset?.chatBlocked === '1';

      if (isBlocked) {
        _setHeaderStatus('', 'default');
      } else if (userObj && userObj.is_online) {
        _setHeaderStatus('Active now' + e2eTag, 'connected');
      } else if (userObj && userObj.last_seen) {
        _setHeaderStatus('Last seen ' + _relativeTime(userObj.last_seen) + e2eTag, 'default');
      } else {
        _setHeaderStatus('Offline' + e2eTag, 'default');
      }
    }
  }

  function _onWsReconnecting(attempt) {
    _setHeaderStatus(`Reconnecting (${attempt}/5)`, 'reconnecting');
    if (attempt === 1) showToast('Connection lost. Reconnecting', 'warning');
  }

  function _setHeaderStatus(text, state) {
    const el = document.getElementById('chatTypingStatus');
    if (!el) return;
    el.textContent = text;
    const classes = {
      connected: 'text-green-400/80',
      disconnected: 'text-red-400/70',
      reconnecting: 'text-yellow-400/70',
      typing: 'text-divine-gold/80',
      default: 'text-divine-muted',
    };
    el.className = `text-xs truncate transition-colors ${classes[state] || classes.default}`;
  }

  // ═════════════════════════════════════════════════════════════════════
  //  Incoming message handlers
  // ═════════════════════════════════════════════════════════════════════
  async function handleIncomingMessage(data) {
    const isFromMe = data.sender === window.SDH_DATA.currentUser;

    // Decrypt incoming message content if E2E encrypted
    if (data.is_encrypted && data.encryption_iv && data.message && window.SDH?.E2E) {
      if (data.type === 'group_message' || !!data.group_id) {
        data.message = await window.SDH.E2E.decryptGroupMessage(data.message, data.encryption_iv, data.group_id);
      } else {
        const peerName = isFromMe ? data.receiver : data.sender;
        data.message = await window.SDH.E2E.decrypt(data.message, data.encryption_iv, peerName);
      }
    }

    if (isFromMe && data.message_id) {
      // Server echo: upgrade the optimistic temp bubble to the real ID
      const upgraded = _upgradeTempBubble(data.message_id);
      if (upgraded) {
        if (data.receiver === window.SDH_DATA.currentUser) {
          _setMsgStatus(data.message_id, 'read');
        } else {
          _setMsgStatus(data.message_id, 'sent');
        }
        renderedIds.add(String(data.message_id));

        // Make sure direct chat partner is in sidebar & moved to top!
        if (data.receiver && !_isSelfChat(data.receiver)) {
          _ensureUserInSidebar(data.receiver, data.receiver_id);
          _moveContactToTop(data.receiver);
        }
        return;
      }
      // If not upgraded, it was sent via REST (e.g., from moments.js)
      // Fall through to render it normally
    }

    const displayContent = data.message_type === 'text' ? (data.message || '') : null;

    const isGroupMsg = data.type === 'group_message' || !!data.group_id;
    const chatTarget = isGroupMsg ? `group_${data.group_id}` : (isFromMe ? data.receiver : data.sender);

    // If direct message partner is not in sidebar, ensure they are in sidebar
    if (!isGroupMsg && chatTarget && chatTarget !== window.SDH_DATA.currentUser) {
      const targetUserId = isFromMe ? data.receiver_id : data.sender_id;
      _ensureUserInSidebar(chatTarget, targetUserId);
      _moveContactToTop(chatTarget);
    }

    // Immediately send delivered receipt upon message arrival on this client device
    if (!isFromMe && data.message_id && SDH.WS && SDH.WS.isOpen()) {
      if (isGroupMsg || data.group_id) {
        SDH.WS.sendMessage({
          type: 'group_delivered_receipt',
          message_id: data.message_id,
          group_id: data.group_id
        });
      } else {
        SDH.WS.sendMessage({
          type: 'delivered_receipt',
          message_id: data.message_id
        });
      }
    }

    if (activeUser !== chatTarget) {
      if (!isFromMe) {
        unreadCounts[chatTarget] = (unreadCounts[chatTarget] || 0) + 1;
        updateUnreadBadge(chatTarget);
        updateDocumentTitle();

        const isLocked = window.SDH?.ChatLock?.isChatLocked?.(chatTarget, isGroupMsg);
        let notifTitle = isGroupMsg ? `New message in Group` : `New message from ${data.sender}`;
        if (isGroupMsg && data.sender) notifTitle = `New message from ${data.sender} in Group`;
        let previewText = data.message_type === 'text'
          ? (data.message || 'New message')
          : (data.message_type === 'location'
            ? (data.location?.is_live || data.is_live_location ? '🔴 Live Location' : '📍 Current Location')
            : `📎 ${data.original_filename || 'File'}`);

        if (isLocked && !window.SDH?.ChatLock?.isUnlocked?.()) {
          notifTitle = '🔒 Locked Chat';
          previewText = 'New message';
        }

        const clickHandler = () => {
          if (isGroupMsg) {
            if (typeof selectGroup === 'function') selectGroup(data.group_id);
          } else {
            selectUser(data.sender, data.sender_id || null);
          }
        };

        Notif.show(
          notifTitle,
          previewText,
          `sdh-${chatTarget}`,
          clickHandler
        );

        showToast(`${notifTitle}: ${previewText}`, 'info', clickHandler);
        playNotificationSound();

        // Move contact to top under Saved Messages only if not locked
        if (!isLocked) {
          _moveContactToTop(chatTarget);
        }
      }
      return;
    }

    if (renderedIds.has(String(data.message_id))) return;
    renderedIds.add(String(data.message_id));

    const isViewOnce = Boolean(data.is_view_once);
    const viewOnceOpened = Boolean(data.view_once_opened);
    const hasFile = !(isViewOnce && viewOnceOpened) && !!(data.has_file || data.file_id || data.message_type === 'file' || data.message_type === 'image' || data.message_type === 'video');

    const locPayload = data.location || (data.message_type === 'location' ? {
      latitude: data.latitude,
      longitude: data.longitude,
      location_name: data.location_name,
      location_address: data.location_address,
      is_live: Boolean(data.is_live || data.is_live_location),
      is_live_location: Boolean(data.is_live || data.is_live_location),
      live_duration: data.live_duration,
      live_expires_at: data.live_expires_at,
      is_live_ended: Boolean(data.is_live_ended),
      is_group: isGroupMsg
    } : null);

    appendMessage({
      sender: data.sender, isFromMe: isFromMe, content: displayContent,
      messageType: data.message_type,
      location: locPayload,
      originalFilename: data.original_filename, mimeType: data.mime_type,
      timestamp: data.timestamp, messageId: data.message_id,
      hasServerFile: hasFile,
      fileId: hasFile ? (data.file_id || data.message_id) : null,
      repliedMoment: data.replied_moment,
      isViewOnce: isViewOnce,
      viewOnceOpened: viewOnceOpened,
      isStarred: Boolean(data.is_starred),
    });
    scrollToBottom();

    if (!isFromMe) {
      playNotificationSound();
      if (document.visibilityState !== 'visible' || !document.hasFocus()) {
        const notifTitle = isGroupMsg ? `New message in Group` : `New message from ${data.sender}`;
        const previewText = data.message_type === 'text'
          ? (data.message || 'New message')
          : (data.message_type === 'location'
            ? (data.location?.is_live || data.is_live_location ? '🔴 Live Location' : '📍 Current Location')
            : `📎 ${data.original_filename || 'File'}`);
        Notif.show(notifTitle, previewText, `sdh-${chatTarget}`);
      }
    }

    // Since message is actively being viewed, send read receipt
    if (SDH.WS && SDH.WS.isOpen() && !isFromMe) {
      if (!activeUser.startsWith('group_')) {
        if (!window.SDH_SETTINGS || window.SDH_SETTINGS.read_receipts_enabled !== false) {
          SDH.WS.sendMessage({ type: 'read_receipt' });
        }
      } else {
        SDH.WS.sendMessage({ type: 'mark_read', message_id: data.message_id });
      }
    }
  }

  function appendSystemMessage(text, targetContainer = null) {
    const container = targetContainer || document.getElementById('messagesContainer');
    if (!container) return;
    const sep = document.createElement('div');
    sep.className = 'flex justify-center my-3 select-none';
    sep.innerHTML = `<span class="text-[11px] font-medium px-4 py-1.5 bg-divine-deep rounded-full border border-divine-gold/30 text-divine-gold/90">${escapeHtml(text)}</span>`;
    container.appendChild(sep);
    if (!targetContainer) scrollToBottom();
  }

  function handleGroupMemberUpdate(data) {
    if (data.action === 'joined') {
      if (data.username && data.username !== window.SDH_DATA?.currentUser) {
        showToast(`${data.username} joined ${data.group_name || 'the group'}!`, 'info');
      }
      _refreshSidebar();
    } else if (data.action === 'removed') {
      const isMe = (data.user_id === window.SDH_DATA?.currentUserId || data.username === window.SDH_DATA?.currentUser);
      if (isMe) {
        showToast(`You have been removed from ${data.group_name || 'the group'}.`, 'warning');
        if (activeUser === `group_${data.group_id}`) {
          activeUser = null;
          activeUserId = null;
          document.getElementById('inputBar')?.classList.add('hidden');
          const container = document.getElementById('messagesContainer');
          if (container) container.innerHTML = '<div class="flex items-center justify-center py-16 text-divine-muted/60 text-sm font-medium">You are no longer a member of this group.</div>';
          document.getElementById('userProfileModal')?.classList.add('hidden');
        }
        _refreshSidebar();
        return;
      } else {
        const row = document.getElementById(`upm-member-row-${data.group_id}-${data.user_id}`);
        if (row) {
          row.style.transition = 'all 0.25s ease';
          row.style.opacity = '0';
          row.style.transform = 'scale(0.95)';
          setTimeout(() => row.remove(), 250);
        }
        const countBadge = document.getElementById('upmMembersCount');
        if (countBadge && data.member_count !== undefined) {
          countBadge.textContent = `(${data.member_count})`;
        }
      }
    }
    if (activeUser && activeUser.startsWith('group_')) {
      const gid = activeUser.split('_')[1];
      if (data.group_id == gid || (data.group_id === undefined)) {
        const modal = document.getElementById('userProfileModal');
        if (modal && !modal.classList.contains('hidden') && data.action !== 'removed') {
          SDH.Chat.showGroupProfile(gid);
        }
      }
    }
  }

  function handleChatSettingUpdate(data) {
    if (data.updated_by === activeUser || data.updated_by === window.SDH_DATA.currentUser) {
      const labels = { 2: '2 Days', 7: '1 Week', 30: '1 Month' };
      const label = labels[data.retention_days] || (data.retention_days + ' days');

      appendSystemMessage(`${data.updated_by === window.SDH_DATA.currentUser ? 'You' : data.updated_by} set the message retention period to ${label}.`);

      // Update modal radio if open
      const radios = document.getElementsByName('retention_days');
      radios.forEach(r => {
        if (parseInt(r.value, 10) === data.retention_days) {
          r.checked = true;
        }
      });
    }
  }

  async function handleIncomingFileNotification(data) {
    const isFromMe = data.sender === window.SDH_DATA.currentUser;
    if (isFromMe) return; // sender already rendered optimistically

    if (data.sender !== activeUser) {
      unreadCounts[data.sender] = (unreadCounts[data.sender] || 0) + 1;
      updateUnreadBadge(data.sender);
      updateDocumentTitle();

      const notifTitle = `New file from ${data.sender}`;
      const previewText = `📎 ${data.original_filename || 'File'}`;
      const clickHandler = () => selectUser(data.sender, data.sender_id || null);

      Notif.show(notifTitle, previewText, `sdh-${data.sender}`, clickHandler);
      showToast(`${notifTitle}: ${previewText}`, 'info', clickHandler);
      playNotificationSound();

      const targetItem = document.getElementById(`user-item-${data.sender}`);
      if (targetItem) {
        const userList = document.getElementById('userList');
        if (userList) {
          const savedMsgItem = userList.querySelector('[data-self="1"]');
          if (savedMsgItem && savedMsgItem.nextSibling) {
            userList.insertBefore(targetItem, savedMsgItem.nextSibling);
          } else {
            userList.prepend(targetItem);
          }
        }
      } else {
        _refreshSidebar();
      }
      return;
    }

    if (renderedIds.has(String(data.message_id))) return;
    renderedIds.add(String(data.message_id));

    const isViewOnce = Boolean(data.is_view_once);
    const viewOnceOpened = Boolean(data.view_once_opened);
    appendMessage({
      sender: data.sender, isFromMe: false, content: null,
      messageType: data.message_type,
      originalFilename: data.original_filename, mimeType: data.mime_type,
      timestamp: data.timestamp, messageId: data.message_id,
      hasServerFile: !(isViewOnce && viewOnceOpened), fileId: data.file_id,
      isViewOnce: isViewOnce,
      viewOnceOpened: viewOnceOpened,
    });
    scrollToBottom();

    playNotificationSound();
    if (document.visibilityState !== 'visible' || !document.hasFocus()) {
      const previewText = isViewOnce
        ? (data.message_type === 'video' ? '① Video' : '① Photo')
        : `📎 ${data.original_filename || 'File'}`;
      Notif.show(`New file from ${data.sender}`, previewText, `sdh-${data.sender}`);
    }

    if (SDH.WS.isOpen()) {
      if (!activeUser.startsWith('group_')) {
        SDH.WS.sendMessage({ type: 'delivered_receipt', message_id: data.message_id });
        if (!window.SDH_SETTINGS || window.SDH_SETTINGS.read_receipts_enabled !== false) {
          SDH.WS.sendMessage({ type: 'read_receipt' });
        }
      } else {
        SDH.WS.sendMessage({ type: 'mark_read', message_id: data.message_id });
      }
    }
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  //  Message bubble renderer
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // ═════════════════════════════════════════════════════════════════════
  //  Professional Message Removal Handlers (Step 3 & 4)
  // ═════════════════════════════════════════════════════════════════════

  function handleMessageRemoved(data) {
    const { message_id, removal_scope, removed_by } = data;
    if (window.SDH?.MediaViewer?.evictBlob) {
      window.SDH.MediaViewer.evictBlob(message_id);
    }
    _closeAllMsgMenus();

    const bubble = document.getElementById(`msg-${message_id}`)
      || document.querySelector(`[data-message-id="${message_id}"]`)
      || document.querySelector(`[data-file-id="${message_id}"]`)?.closest('[data-message-id]')
      || document.querySelector(`[data-file-id="${message_id}"]`)?.closest('.animate-msg-appear');

    if (removal_scope === 'self') {
      // Only affect the user who initiated the removal
      if (removed_by === window.SDH_DATA.currentUser) {
        bubble?.remove();
      }
    } else if (removal_scope === 'all') {
      if (bubble) {
        // Dynamic merging of deleted messages
        let prev = bubble.previousElementSibling;
        let next = bubble.nextElementSibling;

        let count = 1;
        let groupToKeep = null;

        if (prev && prev.classList.contains('sdh-deleted-group')) {
          count += parseInt(prev.dataset.deletedCount || 1, 10);
          groupToKeep = prev;
        }
        if (next && next.classList.contains('sdh-deleted-group')) {
          count += parseInt(next.dataset.deletedCount || 1, 10);
          if (groupToKeep) {
            next.remove(); // merge into prev
          } else {
            groupToKeep = next;
          }
        }

        const label = count === 1 ? 'Message deleted' : `${count} messages deleted`;

        if (groupToKeep) {
          groupToKeep.dataset.deletedCount = count;
          groupToKeep.innerHTML = `<span class="text-[11px] font-medium px-3 py-1 bg-divine-deep rounded-full border border-divine-border/30 text-divine-muted/70">${label}</span>`;
          bubble.remove();
        } else {
          const newGroup = document.createElement('div');
          newGroup.className = 'sdh-deleted-group flex justify-center my-3 select-none';
          newGroup.dataset.deletedCount = 1;
          newGroup.innerHTML = `<span class="text-[11px] font-medium px-3 py-1 bg-divine-deep rounded-full border border-divine-border/30 text-divine-muted/70">${label}</span>`;
          bubble.replaceWith(newGroup);
        }
      }
    }
  }

  /** Toggle the three-dot dropdown for a specific message bubble. */
  function _toggleMsgMenu(btn) {
    const dropdown = btn.nextElementSibling;
    if (!dropdown) return;

    // Close any other open message menus first
    _closeAllMsgMenus(dropdown);

    const wasVisible = !dropdown.classList.contains('hidden');
    if (wasVisible) {
      _closeAllMsgMenus();
      return;
    }

    // Remember original parent so we can restore DOM order
    dropdown._originalParent = dropdown.parentElement;
    dropdown._targetBubble = btn.closest('[data-message-id]');

    // Append to body so it escapes overflow clipping (composer bar, containers)
    document.body.appendChild(dropdown);
    dropdown.classList.remove('hidden');

    // Position fixed relative to the button and clamp to viewport
    const rect = btn.getBoundingClientRect();

    // Ensure it is measurable
    dropdown.style.position = 'fixed';
    dropdown.style.zIndex = '9999';
    dropdown.style.left = '0px';
    dropdown.style.top = '0px';

    const dropdownWidth = dropdown.offsetWidth || 224;
    const dropdownHeight = dropdown.offsetHeight || 80;

    const bubble = dropdown._targetBubble || btn.closest('[data-message-id]');
    const isRightAligned = bubble?.classList?.contains('justify-end');

    let left = isRightAligned
      ? (rect.right - dropdownWidth)
      : rect.left;

    // Prefer opening downward, but flip up if it would go off-screen
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    let top = rect.bottom + 6;
    if (spaceBelow < dropdownHeight + 12 && spaceAbove > dropdownHeight + 12) {
      top = rect.top - dropdownHeight - 6;
    }

    // Clamp to viewport with a small gutter
    const gutter = 8;
    left = Math.max(gutter, Math.min(left, window.innerWidth - dropdownWidth - gutter));
    top = Math.max(gutter, Math.min(top, window.innerHeight - dropdownHeight - gutter));

    dropdown.style.left = `${left}px`;
    dropdown.style.top = `${top}px`;
  }

  function _closeAllMsgMenus(exceptDropdown = null) {
    document.querySelectorAll('.msg-dropdown:not(.hidden)').forEach(dropdown => {
      if (exceptDropdown && dropdown === exceptDropdown) return;
      dropdown.classList.add('hidden');
      dropdown.style.cssText = '';
      if (dropdown._originalParent && dropdown.parentElement === document.body) {
        dropdown._originalParent.appendChild(dropdown);
        delete dropdown._originalParent;
      }
      delete dropdown._targetBubble;
    });
  }

  /** "Remove from My View" — hides the message only for the current user. */
  async function _removeFromMyView(btn) {
    const dropdown = btn.closest('.msg-dropdown');
    const bubble = dropdown?._targetBubble || (dropdown?._originalParent || btn).closest('[data-message-id]');
    const msgId = bubble?.dataset?.messageId;
    if (!msgId || msgId.startsWith('temp_')) return;
    _closeAllMsgMenus();
    try {
      const res = await fetch(`/messaging/api/message/${msgId}/remove-my-view/`, {
        method: 'POST',
        headers: { 'X-CSRFToken': window.SDH_DATA.csrfToken, 'Content-Type': 'application/json' },
      });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || res.statusText); }
      if (bubble) bubble.remove();
      _showRemoveMyViewToast();
    } catch (err) { showToast('Could not remove message: ' + err.message, 'error'); }
  }

  /** Opens the confirmation modal for "Delete for All Participants". */
  function _confirmDeleteForAll(btn) {
    const dropdown = btn.closest('.msg-dropdown');
    const bubble = dropdown?._targetBubble || (dropdown?._originalParent || btn).closest('[data-message-id]');
    const msgId = bubble?.dataset?.messageId;
    if (!msgId || msgId.startsWith('temp_')) return;
    _closeAllMsgMenus();
    const modal = document.getElementById('deleteForAllModal');
    if (modal) { modal.dataset.targetId = msgId; modal.classList.remove('hidden'); }
  }

  /** Executes the confirmed "Delete for All Participants" action. */
  async function executeDeleteForAll() {
    const modal = document.getElementById('deleteForAllModal');
    const msgId = modal?.dataset?.targetId;
    if (modal) modal.classList.add('hidden');
    if (!msgId) return;
    _closeAllMsgMenus();
    try {
      const res = await fetch(`/messaging/api/message/${msgId}/delete-for-all/`, {
        method: 'POST',
        headers: { 'X-CSRFToken': window.SDH_DATA.csrfToken, 'Content-Type': 'application/json' },
      });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || res.statusText); }
      // Immediately reflect deletion on local client!
      handleMessageRemoved({
        message_id: msgId,
        removal_scope: 'all',
        removed_by: window.SDH_DATA.currentUser,
      });
      showToast('Message deleted for all participants.', 'success');
    } catch (err) { showToast('Could not delete message: ' + err.message, 'error'); }
  }

  // Close open dropdowns and menus on outside click (single unified delegated listener)
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.msg-menu-wrap')) {
      _closeAllMsgMenus();
    }
    if (!e.target.closest('.user-ctx-wrap') && !e.target.closest('.user-ctx-dropdown')) {
      _closeAllUserMenus();
    }
    if (!e.target.closest('#kebabMenuWrapper')) {
      const dropdown = document.getElementById('kebabDropdown');
      if (dropdown) dropdown.classList.add('hidden');
    }
    if (!e.target.closest('.sdh-sidebar-kebab')) {
      document.querySelectorAll('[id^="sidebarKebab-"]').forEach(el => el.classList.add('hidden'));
    }
    const picker = document.getElementById('emojiPicker');
    if (picker && !picker.contains(e.target) && !e.target.closest('[onclick*="toggleEmojiPicker"]')) {
      picker.classList.add('hidden');
    }
  }, { passive: true });

  // ═════════════════════════════════════════════════════════════════════
  //  "Remove from My List" — sidebar user context menu
  // ═════════════════════════════════════════════════════════════════════

  /** Toggle the three-dot dropdown for a specific sidebar user item. */
  function _toggleUserMenu(btn) {
    const dropdown = btn.nextElementSibling;
    if (!dropdown) return;

    // Close all other open user dropdowns first
    _closeAllUserMenus(dropdown);

    const wasVisible = !dropdown.classList.contains('hidden');

    if (wasVisible) {
      // Hide it and return to original DOM position
      dropdown.classList.add('hidden');
      dropdown.style.cssText = '';
      // Move back to original parent if appended to body
      if (dropdown._originalParent && dropdown.parentElement === document.body) {
        dropdown._originalParent.appendChild(dropdown);
        delete dropdown._originalParent;
      }
      return;
    }

    // Remember original parent so we can move it back later
    dropdown._originalParent = dropdown.parentElement;

    // Append to body so it escapes all overflow clipping
    document.body.appendChild(dropdown);

    // Show it (remove hidden) so we can measure
    dropdown.classList.remove('hidden');

    // Position fixed relative to the button
    const rect = btn.getBoundingClientRect();
    const dropdownWidth = dropdown.offsetWidth || 208;
    const dropdownHeight = dropdown.offsetHeight || 50;

    let top = rect.bottom + 4;
    let left = rect.right - dropdownWidth;

    // Keep within viewport
    if (left < 8) left = 8;
    if (top + dropdownHeight > window.innerHeight) {
      top = rect.top - dropdownHeight - 4;
    }

    dropdown.style.position = 'fixed';
    dropdown.style.top = top + 'px';
    dropdown.style.left = left + 'px';
    dropdown.style.zIndex = '9999';
  }

  /** Close all open user context dropdowns. */
  function _closeAllUserMenus(except) {
    document.querySelectorAll('.user-ctx-dropdown:not(.hidden)').forEach(d => {
      if (d === except) return;
      d.classList.add('hidden');
      d.style.cssText = '';
      if (d._originalParent && d.parentElement === document.body) {
        d._originalParent.appendChild(d);
        delete d._originalParent;
      }
    });
  }

  function _removeUserFromSidebar(username) {
    if (!username) return;
    if (window.SDH?.UserSearch?.forgetUser) {
      SDH.UserSearch.forgetUser(username);
    } else {
      const item = document.getElementById(`user-item-${username}`);
      if (item) item.remove();
    }
    _updateOnlineCount();
  }

  function _resetConversationPanel() {
    activeUser = null;
    activeUserId = null;
    SDH.WS?.connectWebSocket?.('global');
    sessionStorage.removeItem('ndm_last_chat');
    sessionStorage.removeItem('ndm_last_chat_id');
    sessionStorage.removeItem('ndm_last_chat_name');
    sessionStorage.removeItem('ndm_last_chat_user');

    const container = document.getElementById('messagesContainer');
    if (container) {
      container.innerHTML = '';
      const emptyState = document.createElement('div');
      emptyState.id = 'emptyState';
      emptyState.className = 'flex flex-col items-center justify-center h-full text-center sdh-empty-state';
      emptyState.innerHTML = _defaultEmptyStateInnerHtml();
      container.appendChild(emptyState);
    }

    const usernameEl = document.getElementById('chatUsername');
    if (usernameEl) usernameEl.textContent = 'Select a contact';

    const avatarEl = document.getElementById('chatAvatar');
    if (avatarEl) avatarEl.textContent = '—';

    const statusEl = document.getElementById('chatTypingStatus');
    if (statusEl) statusEl.textContent = 'Choose someone to start messaging';

    document.getElementById('callButtons')?.classList.add('hidden');
    document.getElementById('inputBar')?.classList.add('hidden');
    document.getElementById('kebabUserOptions')?.classList.add('hidden');
    document.getElementById('kebabGroupOptions')?.classList.add('hidden');
    document.getElementById('kebabDropdown')?.classList.add('hidden');

    document.querySelectorAll('.user-item').forEach(el =>
      el.classList.remove('active-chat-item'));
  }

  function _resolveTargetUser(userId, username) {
    let targetName = username || activeUser;
    if (!targetName) {
      targetName = sessionStorage.getItem('ndm_last_chat');
    }
    if (!targetName) {
      const uEl = document.getElementById('chatUsername');
      if (uEl && uEl.textContent && uEl.textContent.trim() !== 'Select a contact') {
        targetName = uEl.textContent.trim();
      }
    }

    let targetId = userId || activeUserId;
    if (!targetId && targetName) {
      const uObj = window.SDH_DATA?.users?.find(u => u.username === targetName);
      if (uObj?.id) {
        targetId = uObj.id;
      } else {
        const itemEl = document.getElementById(`user-item-${targetName}`);
        targetId = itemEl?.dataset?.userid || itemEl?.getAttribute('data-userid');
      }
      if (!targetId && sessionStorage.getItem('ndm_last_chat') === targetName) {
        targetId = sessionStorage.getItem('ndm_last_chat_id');
      }
    }
    return {
      targetId: targetId ? (parseInt(targetId, 10) || targetId) : null,
      targetName: targetName ? String(targetName).trim() : null
    };
  }

  /** Opens the "Remove User" confirmation modal for a sidebar contact or active user. */
  function _confirmRemoveUser(userId, username) {
    // Close any open dropdown
    _closeAllUserMenus();
    const { targetId, targetName } = _resolveTargetUser(userId, username);
    if (!targetName) return;

    const modal = document.getElementById('removeUserModal');
    if (!modal) return;
    modal.dataset.targetUserId = targetId ? String(targetId) : '';
    modal.dataset.targetUsername = String(targetName);
    const nameEl = document.getElementById('removeUserModalName');
    if (nameEl) nameEl.textContent = _displayNameFor(targetName);
    modal.classList.remove('hidden');
  }

  /** Opens the "Block Contact" confirmation modal for the active conversation or sidebar contact. */
  function _confirmBlockUser(userId, username) {
    const { targetId, targetName } = _resolveTargetUser(userId, username);
    if (!targetName || _isSelfChat(targetName)) return;

    const modal = document.getElementById('blockUserModal');
    if (!modal) return;

    modal.dataset.targetUserId = targetId ? String(targetId) : '';
    modal.dataset.targetUsername = String(targetName);

    const nameEl = document.getElementById('blockUserModalName');
    if (nameEl) nameEl.textContent = _displayNameFor(targetName);

    modal.classList.remove('hidden');
  }

  /** Executes the confirmed "Remove from My List" action. */
  async function executeRemoveUser() {
    const modal = document.getElementById('removeUserModal');
    if (!modal) return;
    const rawUserId = modal.dataset.targetUserId;
    const rawUsername = modal.dataset.targetUsername;
    modal.classList.add('hidden');

    let cleanUserId = (rawUserId && rawUserId !== 'undefined' && !isNaN(parseInt(rawUserId, 10)))
      ? parseInt(rawUserId, 10)
      : null;
    let cleanUsername = (rawUsername && rawUsername !== 'undefined') ? rawUsername : null;

    if (!cleanUserId && cleanUsername) {
      const resolved = _resolveTargetUser(null, cleanUsername);
      if (resolved.targetId) cleanUserId = resolved.targetId;
    }

    if (!cleanUserId && !cleanUsername) return;

    try {
      const res = await fetch(window.SDH_DATA.removeUserUrl, {
        method: 'POST',
        headers: {
          'X-CSRFToken': window.SDH_DATA.csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          target_user_id: cleanUserId,
          target_username: cleanUsername,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || res.statusText);
      }
      // Remove the user item from sidebar immediately
      if (cleanUsername) {
        _removeUserFromSidebar(cleanUsername);
      }
      // If this was the active conversation, reset panel
      if (activeUser === cleanUsername) {
        _resetConversationPanel();
      }
      showToast(`${cleanUsername || 'Contact'} removed from your list.`, 'success');
    } catch (err) {
      showToast('Could not remove user: ' + err.message, 'error');
    }
  }

  /** Executes the confirmed "Block Contact" action.
   * User stays in sidebar with a blocked indicator.
   */
  async function executeBlockUser() {
    const modal = document.getElementById('blockUserModal');
    if (!modal) return;
    const rawUserId = modal.dataset.targetUserId;
    const rawUsername = modal.dataset.targetUsername;
    modal.classList.add('hidden');

    let cleanUserId = (rawUserId && rawUserId !== 'undefined' && !isNaN(parseInt(rawUserId, 10)))
      ? parseInt(rawUserId, 10)
      : null;
    let cleanUsername = (rawUsername && rawUsername !== 'undefined') ? rawUsername : null;

    if (!cleanUserId && cleanUsername) {
      const resolved = _resolveTargetUser(null, cleanUsername);
      if (resolved.targetId) cleanUserId = resolved.targetId;
    }

    if (!cleanUserId && !cleanUsername) return;

    try {
      const res = await fetch(window.SDH_DATA.removeUserUrl, {
        method: 'POST',
        headers: {
          'X-CSRFToken': window.SDH_DATA.csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          target_user_id: cleanUserId,
          target_username: cleanUsername,
          block: true,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || res.statusText);
      }

      // Mark user item as blocked in sidebar (keep visible)
      if (cleanUsername) {
        const item = document.getElementById(`user-item-${cleanUsername}`);
        if (item) {
          item.dataset.blocked = '1';
          // Add blocked badge if not already present
          const nameEl = item.querySelector('.sdh-user-name');
          if (nameEl && !item.querySelector('.sdh-blocked-badge')) {
            const badge = document.createElement('span');
            badge.className = 'sdh-blocked-badge text-[10px] font-semibold px-1.5 py-0.5 rounded-full';
            badge.style.cssText = 'background:rgba(239,68,68,0.15);color:rgba(239,68,68,0.7);';
            badge.textContent = 'Blocked';
            nameEl.insertAdjacentElement('afterend', badge);
          }
        }
      }

      // If this is the active conversation, update UI to blocked state
      if (activeUser === cleanUsername) {
        _updateBlockUI(true);
      }

      showToast(`Blocked ${cleanUsername || 'contact'}. Messages are disabled.`, 'success');
    } catch (err) {
      showToast('Could not block contact: ' + err.message, 'error');
    }
  }

  /** Opens the "Unblock Contact" confirmation modal. */
  function _confirmUnblockUser(userId, username) {
    const { targetId, targetName } = _resolveTargetUser(userId, username);
    if (!targetName || _isSelfChat(targetName)) return;

    const modal = document.getElementById('unblockUserModal');
    if (!modal) return;

    modal.dataset.targetUserId = targetId ? String(targetId) : '';
    modal.dataset.targetUsername = String(targetName);

    const nameEl = document.getElementById('unblockUserModalName');
    if (nameEl) nameEl.textContent = _displayNameFor(targetName);

    modal.classList.remove('hidden');
  }

  /** Executes the confirmed "Unblock Contact" action. */
  async function executeUnblockUser() {
    const modal = document.getElementById('unblockUserModal');
    if (!modal) return;
    const rawUserId = modal.dataset.targetUserId;
    const rawUsername = modal.dataset.targetUsername;
    modal.classList.add('hidden');

    let cleanUserId = (rawUserId && rawUserId !== 'undefined' && !isNaN(parseInt(rawUserId, 10)))
      ? parseInt(rawUserId, 10)
      : null;
    let cleanUsername = (rawUsername && rawUsername !== 'undefined') ? rawUsername : null;

    if (!cleanUserId && cleanUsername) {
      const resolved = _resolveTargetUser(null, cleanUsername);
      if (resolved.targetId) cleanUserId = resolved.targetId;
    }

    if (!cleanUserId && !cleanUsername) return;

    try {
      const res = await fetch(window.SDH_DATA.unblockUserUrl, {
        method: 'POST',
        headers: {
          'X-CSRFToken': window.SDH_DATA.csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          target_user_id: cleanUserId,
          target_username: cleanUsername,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || res.statusText);
      }

      // Remove blocked state from sidebar
      if (cleanUsername) {
        const item = document.getElementById(`user-item-${cleanUsername}`);
        if (item) {
          delete item.dataset.blocked;
          item.querySelector('.sdh-blocked-badge')?.remove();
        }
      }

      // If this is the active conversation, restore normal UI
      if (activeUser === cleanUsername) {
        _updateBlockUI(false);
      }

      showToast(`Unblocked ${cleanUsername || 'contact'}. You can now exchange messages.`, 'success');
    } catch (err) {
      showToast('Could not unblock contact: ' + err.message, 'error');
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  //  Unfriend Contact
  // ═════════════════════════════════════════════════════════════════════

  /** Opens the "Unfriend" confirmation modal for a sidebar contact or active user. */
  function _confirmUnfriend(userId, username) {
    _closeAllUserMenus();
    const { targetId, targetName } = _resolveTargetUser(userId, username);
    if (!targetName) return;

    const modal = document.getElementById('unfriendUserModal');
    if (!modal) return;
    modal.dataset.targetUserId = targetId ? String(targetId) : '';
    modal.dataset.targetUsername = String(targetName);
    const nameEl = document.getElementById('unfriendUserModalName');
    if (nameEl) nameEl.textContent = _displayNameFor(targetName);
    modal.classList.remove('hidden');
  }

  /** Executes the confirmed "Unfriend" action. */
  async function executeUnfriend() {
    const modal = document.getElementById('unfriendUserModal');
    if (!modal) return;
    const rawUserId = modal.dataset.targetUserId;
    const rawUsername = modal.dataset.targetUsername;
    modal.classList.add('hidden');

    let cleanUserId = (rawUserId && rawUserId !== 'undefined' && !isNaN(parseInt(rawUserId, 10)))
      ? parseInt(rawUserId, 10)
      : null;
    let cleanUsername = (rawUsername && rawUsername !== 'undefined') ? rawUsername : null;

    if (!cleanUserId && cleanUsername) {
      const resolved = _resolveTargetUser(null, cleanUsername);
      if (resolved.targetId) cleanUserId = resolved.targetId;
    }

    if (!cleanUserId && !cleanUsername) {
      showToast('Could not find user to unfriend', 'error');
      return;
    }

    try {
      const res = await fetch(window.SDH_DATA.unfriendUrl || '/users/api/unfriend/', {
        method: 'POST',
        headers: {
          'X-CSRFToken': window.SDH_DATA.csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          target_user_id: cleanUserId,
          target_username: cleanUsername,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        throw new Error(data.error || res.statusText || 'Failed to unfriend contact');
      }

      // Remove the user entirely from the sidebar
      if (cleanUsername) {
        _removeUserFromSidebar(cleanUsername);
      }

      // If this was the active conversation, reset the panel
      if (activeUser === cleanUsername) {
        _resetConversationPanel();
      }

      showToast(`You are no longer friends with ${cleanUsername || 'this user'}.`, 'success');
    } catch (err) {
      showToast('Could not unfriend: ' + err.message, 'error');
    }
  }

  /**
   * Toggle the input bar and block/unblock buttons based on blocked state.
   */
  function _updateBlockUI(isBlocked) {
    const inputBar = document.getElementById('inputBar');
    const blockBtn = document.getElementById('blockBtn');
    const unblockBtn = document.getElementById('unblockBtn');

    if (isBlocked) {
      // Show blocked indicator in place of input bar
      if (inputBar) {
        inputBar.classList.add('hidden');
      }
      // Show "blocked" banner below messages
      let blockedBanner = document.getElementById('blockedBanner');
      if (!blockedBanner) {
        blockedBanner = document.createElement('div');
        blockedBanner.id = 'blockedBanner';
        blockedBanner.className = 'flex items-center justify-center gap-2 px-4 py-3 flex-shrink-0 text-xs';
        blockedBanner.style.cssText = 'background:rgba(239,68,68,0.08);border-top:1px solid rgba(239,68,68,0.15);color:rgba(239,68,68,0.7);';
        blockedBanner.innerHTML = `
            <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M12 22s8-4 8-10V6l-8-4-8 4v6c0 6 8 10 8 10z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 9l6 6M15 9l-6 6" />
            </svg>
            <span>You blocked this contact. Unblock to send messages.</span>`;
        inputBar?.parentElement?.appendChild(blockedBanner);
      }
      blockedBanner.classList.remove('hidden');
      // Toggle buttons
      if (!_isSelfChat(activeUser)) {
        blockBtn?.classList.add('hidden');
        unblockBtn?.classList.remove('hidden');
      } else {
        blockBtn?.classList.add('hidden');
        unblockBtn?.classList.add('hidden');
      }
    } else {
      // Restore input bar
      if (inputBar) {
        inputBar.classList.remove('hidden');
      }
      document.getElementById('blockedBanner')?.classList.add('hidden');
      // Toggle buttons
      if (!_isSelfChat(activeUser)) {
        blockBtn?.classList.remove('hidden');
        unblockBtn?.classList.add('hidden');
      } else {
        blockBtn?.classList.add('hidden');
        unblockBtn?.classList.add('hidden');
      }
    }
  }

  /**
   * Handles the "user_removed" WebSocket event.
   * Sent by the server when the current user hides someone
   * (optional real-time confirmation path).
   */
  function handleUserBlocked(data) {
    // Find the user we need to obscure (the other person)
    const otherUser = data.blocker_username === window.SDH_DATA.currentUser ? data.blocked_username : data.blocker_username;

    const item = document.getElementById(`user-item-${otherUser}`);
    if (item) {
      item.dataset.chatBlocked = '1';
      // Set default avatar
      const img = item.querySelector('img.sdh-avatar-img');
      if (img) img.src = '/static/images/default_avatar.png';

      // Hide online indicator
      const statusDot = item.querySelector('.sdh-status-dot');
      if (statusDot) statusDot.remove();

      // Hide last seen
      const lastSeen = item.querySelector('.sdh-last-seen');
      if (lastSeen) lastSeen.textContent = '';
    }

    // If the active chat is with this user, update chat header
    if (activeUser === otherUser) {
      const headerImg = document.getElementById('chatHeaderAvatar');
      if (headerImg) headerImg.src = '/static/images/default_avatar.png';
      const headerStatus = document.getElementById('chatHeaderStatus');
      if (headerStatus) headerStatus.textContent = '';
    }

    // If we are the blocker, update the UI
    if (data.blocker_username === window.SDH_DATA.currentUser && activeUser === otherUser) {
      _updateBlockUI(true);
    }
  }

  function handleUserUnblocked(data) {
    _refreshSidebar();

    const otherUser = data.unblocker_username === window.SDH_DATA.currentUser ? data.unblocked_username : data.unblocker_username;
    const item = document.getElementById(`user-item-${otherUser}`);
    if (item) {
      delete item.dataset.chatBlocked;
    }

    if (data.unblocker_username === window.SDH_DATA.currentUser && activeUser === otherUser) {
      _updateBlockUI(false);
    }
    if (activeUser === otherUser) {
      selectConversation(otherUser);
    }
  }

  function handleUserRemoved(data) {
    const username = data.removed_username;
    if (!username) return;
    _removeUserFromSidebar(username);

    // If the removed user is currently active, reset the chat panel
    if (activeUser === username) {
      _resetConversationPanel();
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  //  Clear All Chat Handlers
  // ═════════════════════════════════════════════════════════════════════

  /** Handles the real-time chat_cleared event for both participants or groups. */
  function handleChatCleared(data) {
    const { cleared_by, other_user, group_id } = data;
    const me = window.SDH_DATA.currentUser;

    let partner = null;
    if (group_id) {
      // For groups, the partner is group_X
      partner = 'group_' + group_id;
      // Group chat clears are one-sided, so only process if I cleared it
      if (cleared_by !== me) return;
    } else {
      // For 1-on-1 chats
      partner = cleared_by === me ? other_user : cleared_by;
    }

    if (activeUser !== partner) return;

    renderedIds.clear();
    dateSeparators.clear();

    const container = document.getElementById('messagesContainer');
    if (container) {
      // Apply smooth slide-away animation to all message elements
      const children = Array.from(container.children);
      children.forEach(child => {
        child.style.transition = 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
        child.style.opacity = '0';
        child.style.transform = 'translateY(20px) scale(0.95)';
      });

      // Wait for animation, then clear and show empty state
      setTimeout(() => {
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center h-full text-center text-divine-muted py-16 animate-msg-appear">
              <div class="text-5xl mb-4 opacity-20">&#x1F4AC;</div>
              <p class="text-sm font-medium">No messages yet</p>
              <p class="text-xs mt-2 opacity-50">Start a conversation</p>
            </div>
          `;
      }, 400);
    }

    if (!group_id && cleared_by !== me) {
      showToast(`${cleared_by} cleared the chat history.`, 'info');
    } else {
      showToast('Chat history cleared.', 'success');
    }
  }

  /** Opens the Clear All Chat confirmation modal. */
  function _confirmClearChat() {
    if (!activeUser) return;
    document.getElementById('clearChatModal')?.classList.remove('hidden');
  }

  /** POSTs the clear-chat request after user confirms. */
  async function executeClearChat() {
    document.getElementById('clearChatModal')?.classList.add('hidden');
    if (!activeUser) return;
    try {
      let endpointUrl = `/messaging/api/clear-chat/${activeUser}/`;
      if (activeUser.startsWith('group_') && activeUserId) {
        endpointUrl = `/messaging/api/groups/${activeUserId}/clear/`;
      }
      const res = await fetch(endpointUrl, {
        method: 'POST',
        headers: { 'X-CSRFToken': window.SDH_DATA.csrfToken, 'Content-Type': 'application/json' },
      });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || res.statusText); }
      handleChatCleared({
        cleared_by: window.SDH_DATA.currentUser,
        other_user: activeUser,
        group_id: activeUser.startsWith('group_') ? activeUserId : null
      });
    } catch (err) { showToast('Could not clear chat: ' + err.message, 'error'); }
  }

  /** Map: date-label string → separator DOM element (one per date). */
  const dateSeparators = new Map();
  const _esc = s => String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '')
    .replace(/\n/g, ' ');

  function appendMessage(opts, targetContainer = null) {
    const container = targetContainer || document.getElementById('messagesContainer');
    if (!container) return;
    if (!targetContainer) document.getElementById('emptyState')?.remove();

    const {
      sender, isFromMe, content, messageType,
      originalFilename, mimeType, timestamp, messageId,
      hasServerFile = false, fileId = null, fileData = null,
      isDelivered = false, isRead = false, repliedMoment = null,
      isViewOnce = false, viewOnceOpened = false, isStarred = false,
      location = null
    } = opts;

    // ── Date separator ───────────────────────────────────────────────────
    if (timestamp) {
      const label = _dateLabel(timestamp);
      if (!dateSeparators.has(label)) {
        const sep = document.createElement('div');
        sep.className = 'flex items-center gap-3 my-4 px-2 select-none';
        sep.innerHTML = `
            <div class="flex-1 h-px bg-divine-border/40"></div>
            <span class="text-[11px] text-divine-muted/50 font-medium px-2
                        bg-divine-deep rounded-full border border-divine-border/30 py-0.5">
              ${escapeHtml(label)}
            </span>
            <div class="flex-1 h-px bg-divine-border/40"></div>`;
        container.appendChild(sep);
        dateSeparators.set(label, sep);
      }
    }

    if (messageType === 'deleted') {
      const lastEl = container.lastElementChild;
      if (lastEl && lastEl.classList.contains('sdh-deleted-group')) {
        let count = parseInt(lastEl.dataset.deletedCount || 1, 10) + 1;
        lastEl.dataset.deletedCount = count;
        lastEl.innerHTML = `<span class="text-[11px] font-medium px-3 py-1 bg-divine-deep rounded-full border border-divine-border/30 text-divine-muted/70">${count} messages deleted</span>`;
      } else {
        const newGroup = document.createElement('div');
        newGroup.className = 'sdh-deleted-group flex justify-center my-3 select-none';
        newGroup.dataset.deletedCount = 1;
        newGroup.innerHTML = `<span class="text-[11px] font-medium px-3 py-1 bg-divine-deep rounded-full border border-divine-border/30 text-divine-muted/70">Message deleted</span>`;
        container.appendChild(newGroup);
      }
      return;
    }

    const time = timestamp
      ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';

    const innerHtml = _buildMessageContent({
      messageType, content, originalFilename, mimeType, hasServerFile, fileId, fileData,
      isViewOnce, viewOnceOpened, messageId, location, isFromMe, sender, timestamp
    });

    const isTemp = String(messageId).startsWith('temp_');

    // Determine initial tick status for outgoing messages
    let initTickStatus = '';
    if (isFromMe && !isTemp) {
      if (isRead) initTickStatus = 'read';
      else if (isDelivered) initTickStatus = 'delivered';
      else initTickStatus = 'sent';
    }

    const dlBtnHtml = (hasServerFile && fileId && !isViewOnce) ? `
            <button onclick="SDH.MediaViewer?.open({fileId:${Number(fileId)},fileName:'${_esc(originalFilename)}',mimeType:'${_esc(mimeType)}',messageType:'${_esc(messageType)}'})"
                    class="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-divine-text hover:bg-divine-surface transition-colors text-left font-medium">
              <svg class="w-3.5 h-3.5 flex-shrink-0 text-divine-gold" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
              </svg>
              Preview / Open
            </button>
            <button onclick="SDH.FileUpload.downloadFile({messageId:${Number(fileId)},fileName:'${_esc(originalFilename)}',mimeType:'${_esc(mimeType)}',buttonEl:this})"
                    class="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-divine-gold hover:text-divine-text hover:bg-divine-surface transition-colors text-left font-medium">
              <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
              </svg>
              Download ${messageType === 'image' ? 'Image' : messageType === 'video' ? 'Video' : 'File'}
            </button>
            <div class="border-t border-divine-border/40 mx-2 my-0.5"></div>` : '';

    const menuHtml = isTemp ? '' : `
        <div class="msg-menu-wrap flex-shrink-0 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-150 relative self-center">
          <button onclick="SDH.Chat._toggleMsgMenu(this)"
                  class="w-7 h-7 flex items-center justify-center rounded-full text-divine-muted/50 hover:text-divine-gold hover:bg-divine-card/80 border border-transparent hover:border-divine-border/60 transition-all leading-none select-none"
                  title="Message options">⋯</button>
          <div class="msg-dropdown hidden absolute ${isFromMe ? 'right-0' : 'left-0'} top-full mt-1 z-[35] w-56 bg-divine-card border border-divine-border/80 rounded-xl shadow-2xl overflow-hidden py-1">
            ${dlBtnHtml}
            <button onclick="SDH.Chat.toggleStarMessage(${messageId})"
                    class="msg-star-btn w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-amber-400 hover:text-amber-300 hover:bg-divine-surface transition-colors text-left font-medium">
              <svg class="w-3.5 h-3.5 flex-shrink-0 text-amber-400 fill-current" viewBox="0 0 24 24">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
              </svg>
              <span class="msg-star-text">${isStarred ? 'Unstar Message' : 'Star Message'}</span>
            </button>
            <div class="border-t border-divine-border/40 mx-2 my-0.5"></div>
            <button onclick="SDH.Chat._removeFromMyView(this)"
                    class="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-divine-muted hover:text-divine-text hover:bg-divine-surface transition-colors text-left">
              <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"/>
              </svg>
              Remove from My View
            </button>
            ${isFromMe && !_isSelfChat(activeUser) ? `
            <div class="border-t border-divine-border/40 mx-2 my-0.5"></div>
            <button onclick="SDH.Chat._confirmDeleteForAll(this)"
                    class="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-red-400/80 hover:text-red-300 hover:bg-red-950/40 transition-colors text-left">
              <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
              </svg>
              Delete for All Participants
            </button>` : ''}
          </div>
        </div>`;

    // Bubble style: normal → colored via custom.css
    const bubbleStyle = isFromMe
      ? 'msg-bubble-sender'
      : 'msg-bubble-receiver';

    let repliedMomentHtml = '';
    if (repliedMoment) {
      const rm = repliedMoment;
      let mediaPreview = '';
      if (rm.moment_type === 'image' || rm.moment_type === 'video') {
        mediaPreview = rm.media_url ? `<img src="${rm.media_url}" class="w-8 h-10 object-cover rounded border border-white/10" />` : `<div class="w-8 h-10 bg-black/20 rounded border border-white/10 flex items-center justify-center text-[9px] text-white/50">Exp</div>`;
      } else {
        mediaPreview = `<div class="w-8 h-10 bg-black/20 rounded border border-white/10 flex items-center justify-center text-[8px] overflow-hidden p-1 text-center text-white/80">${escapeHtml(rm.text_content ? rm.text_content.substring(0, 10) : 'Text')}</div>`;
      }

      repliedMomentHtml = `
          <div class="flex items-center gap-2 bg-black/10 p-1.5 rounded-lg mb-2 border-l-4 border-divine-gold select-none">
            ${mediaPreview}
            <div class="flex flex-col flex-1 min-w-0 pr-2">
              <span class="text-[10px] font-bold text-divine-gold uppercase tracking-widest">Story</span>
              <span class="text-xs text-divine-text/80 truncate opacity-80">Replying to moment</span>
            </div>
          </div>
        `;
    }

    const isMedia = (messageType === 'image' || messageType === 'video');
    const bubblePadding = isMedia ? 'p-1.5 sm:p-2' : 'px-3.5 py-2.5';
    const mediaBubbleClass = isMedia ? 'msg-bubble-media' : '';

    const bubble = document.createElement('div');
    bubble.id = `msg-${messageId}`;
    bubble.dataset.messageId = String(messageId);
    bubble.dataset.isStarred = isStarred ? '1' : '0';
    bubble.className = `flex ${isFromMe ? 'justify-end' : 'justify-start'} items-center gap-1.5 px-1 mb-1.5 animate-msg-appear group/msg`;
    bubble.innerHTML = `
        ${isFromMe ? menuHtml : ''}
        <div class="max-w-[85%] sm:max-w-[72%] space-y-0.5">
          ${!isFromMe
        ? `<p class="text-[11px] font-semibold text-divine-muted/70 pl-1 mb-0.5">${escapeHtml(sender)}</p>`
        : ''}
          <div class="msg-bubble ${bubblePadding} ${mediaBubbleClass} rounded-2xl transition-shadow duration-300
            ${bubbleStyle}">
            ${repliedMomentHtml}
            ${innerHtml}
          </div>
          <div class="flex items-center gap-1 ${isFromMe ? 'justify-end pr-0.5' : 'justify-start pl-0.5'}">
            <span class="msg-star-indicator ${isStarred ? '' : 'hidden'} text-amber-400 text-xs select-none" title="Starred">★</span>
            <span class="text-[11px] text-divine-muted/40 select-none">${time}</span>
            ${isFromMe ? `<span class="msg-status-tick leading-none select-none">${_tickHtml(initTickStatus)}</span>` : ''}
            ${(isFromMe && activeUser && activeUser.startsWith('group_') && !isTemp) ? `<button onclick="SDH.Chat.showGroupMessageDetails(${messageId})" class="ml-1 w-4 h-4 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white/50 hover:text-white/80 transition-colors" title="Message Details"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg></button>` : ''}
          </div>
        </div>
        ${!isFromMe ? menuHtml : ''}`;
    container.appendChild(bubble);
  }

  function _buildViewOnceIconSvg({ opened = false, sizeClass = 'w-7 h-7', extraClass = '' } = {}) {
    const dash = opened ? 'stroke-dasharray="3.5 2.5"' : '';
    const fillOp = opened ? '0' : '0.12';
    return `<svg class="${sizeClass} ${extraClass} flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <circle cx="12" cy="12" r="9.5" stroke-width="2" fill="currentColor" fill-opacity="${fillOp}" ${dash} />
      <path d="M10.8 10.5 L13.2 8 V16" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none" />
    </svg>`;
  }

  function _buildMessageContent({ messageType, content, originalFilename, mimeType,
    hasServerFile, fileId, isViewOnce, viewOnceOpened, messageId, location, isFromMe, sender, timestamp }) {

    if (messageType === 'location' || location) {
      if (window.SDH?.LocationShare?.buildCardHtml) {
        return window.SDH.LocationShare.buildCardHtml({
          location,
          content,
          messageId,
          isFromMe,
          timestamp
        });
      }
    }
    if (isViewOnce) {
      if (viewOnceOpened) {
        return `
          <div class="sdh-view-once-bubble sdh-view-once-opened flex items-center gap-3 py-1.5 px-2 select-none">
            ${_buildViewOnceIconSvg({ opened: true, sizeClass: 'w-7 h-7', extraClass: 'sdh-view-once-badge' })}
            <div class="flex flex-col min-w-0">
              <span class="sdh-vo-title text-sm font-semibold tracking-wide">Opened</span>
              <span class="sdh-vo-sub text-[11px] leading-tight">View once</span>
            </div>
          </div>
        `;
      } else {
        const mediaLabel = (messageType === 'video') ? 'Video' : 'Photo';
        const fid = Number(fileId || messageId);
        return `
          <div class="sdh-view-once-bubble sdh-view-once-unopened flex items-center gap-3 py-1.5 px-2 cursor-pointer select-none group/vo transition-all"
               id="vo-card-${fid}"
               onclick="SDH.Chat.openViewOnceMedia(${fid}, '${_esc(originalFilename)}', '${_esc(mimeType || (messageType === 'video' ? 'video/mp4' : 'image/jpeg'))}', '${_esc(messageType)}')">
            ${_buildViewOnceIconSvg({ opened: false, sizeClass: 'w-7 h-7', extraClass: 'sdh-view-once-badge group-hover/vo:scale-105 transition-all' })}
            <div class="flex flex-col min-w-0">
              <span class="sdh-vo-title text-sm font-bold tracking-wide flex items-center gap-1.5">
                ${mediaLabel}
              </span>
              <span class="sdh-vo-sub text-[11px] leading-tight">Tap to view</span>
            </div>
          </div>
        `;
      }
    }

    if (messageType === 'call') {
      const isVideo = content && content.toLowerCase().includes('video');
      const icon = isVideo ? '📹' : '📞';
      const callTypeArgs = isVideo ? "'video', 'medium'" : "'voice', 'medium'";
      return `
          <div class="call-msg-card flex flex-col items-center gap-1.5 text-center w-[195px] max-w-full sm:w-[215px] pt-1 pb-0.5 box-border overflow-hidden">
            <div class="w-12 h-12 rounded-full flex flex-shrink-0 items-center justify-center text-2xl bg-red-500/15 text-red-500 mb-1">
              ${icon}
            </div>
            <div class="w-full flex flex-col items-center px-1">
              <p class="text-[14px] sm:text-[15px] font-semibold leading-tight max-w-full whitespace-normal break-words" style="color:var(--c-text)">${escapeHtml(content || 'Missed Call')}</p>
              <p class="text-[10px] sm:text-[11px] font-bold text-red-500 mt-1 uppercase tracking-wider">Missed</p>
            </div>
            <div class="w-full mt-2 box-border">
              <button onclick="SDH.WebRTC.startCall(${callTypeArgs})" class="flex items-center justify-center gap-2 w-full py-2 px-3 rounded-xl bg-divine-text text-divine-surface font-semibold text-sm hover:scale-[0.98] active:scale-[0.96] transition-all shadow-sm box-border">
                <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/></svg>
                <span class="truncate">Call Back</span>
              </button>
            </div>
          </div>
        `;
    }

  function _linkifyHtml(html) {
    if (!html) return '';
    const urlPattern = /(?:https?:\/\/|www\.)[^\s<>"']+|[a-zA-Z0-9][-a-zA-Z0-9]*\.(?:com|org|net|edu|gov|io|co|in|ai|me|app|dev|link|info)(?:\/[^\s<>"']*)?/gi;
    return html.replace(urlPattern, (match) => {
      const cleanUrl = match.replace(/[.,!?:;)"']+$/, '');
      const trailing = match.slice(cleanUrl.length);
      const href = cleanUrl.startsWith('http://') || cleanUrl.startsWith('https://')
        ? cleanUrl
        : `https://${cleanUrl}`;
      return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="sdh-chat-link underline underline-offset-2 break-all transition-colors" onclick="event.stopPropagation()">${cleanUrl}</a>${trailing}`;
    });
  }

    if (messageType === 'text') {
      let formatted = window.SDH?.Mentions?.format
        ? window.SDH.Mentions.format(content || '')
        : escapeHtml(content || '');
      formatted = _linkifyHtml(formatted);
      return `<p class="text-sm leading-relaxed break-words whitespace-pre-wrap">${formatted}</p>`;
    }

    if (messageType === 'image') {
      if (fileData) {
        return `
            <div class="file-msg media-msg w-[260px] sm:w-[310px] max-w-full flex flex-col box-border">
              <div class="relative group/img overflow-hidden rounded-xl bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/10 shadow-sm w-full box-border cursor-pointer select-none"
                   onclick="SDH.MediaViewer?.open({fileName:'${_esc(originalFilename)}',mimeType:'${_esc(mimeType || 'image/jpeg')}',messageType:'image',src:'${fileData}'})">
                <img src="${fileData}"
                    alt="${escapeHtml(originalFilename)}"
                    class="w-full max-h-80 object-cover rounded-xl hover:opacity-95 transition-all block"
                    loading="lazy" style="min-height:120px;" />
              </div>
              <div class="flex items-center justify-between gap-2 mt-1.5 px-2.5 py-1.5 rounded-xl bg-black/[0.04] dark:bg-white/[0.06] border border-black/5 dark:border-white/10 w-full min-w-0 box-border">
                <p class="text-[11px] font-medium text-divine-text/80 truncate flex-1 min-w-0">${escapeHtml(originalFilename)}</p>
                <a href="${fileData}" download="${escapeHtml(originalFilename)}" class="sdh-file-download-btn flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all flex-shrink-0 shadow-sm">Download</a>
              </div>
            </div>`;
      }
      if (hasServerFile && fileId) {
        const fid = Number(fileId);
        const autoDl = window.SDH_SETTINGS?.media_auto_download || 'all';
        let shouldAutoDownload = true;
        if (autoDl === 'never') {
          shouldAutoDownload = false;
        } else if (autoDl === 'wifi') {
          const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
          if (conn && conn.type && conn.type !== 'wifi' && conn.type !== 'ethernet') {
            shouldAutoDownload = false;
          }
        }

        if (shouldAutoDownload) {
          setTimeout(() => {
            const imgEl = document.querySelector(`img[data-file-id="${fid}"][data-sdh-loaded=""]`);
            if (imgEl) SDH.FileUpload.downloadImage({ messageId: fid, mimeType, imgEl })
              .catch(e => console.error('[Chat] img load:', e));
          }, 120);
        }

        return `
            <div class="file-msg media-msg w-[260px] sm:w-[310px] max-w-full flex flex-col box-border">
              <div class="relative group/img overflow-hidden rounded-xl bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/10 shadow-sm w-full box-border cursor-pointer select-none"
                   onclick="SDH.MediaViewer?.open({fileId:${fid},fileName:'${_esc(originalFilename)}',mimeType:'${_esc(mimeType || 'image/jpeg')}',messageType:'image',imgEl:this.querySelector('img')})">
                <img src="" data-file-id="${fid}"
                    data-mime="${_esc(mimeType || 'image/jpeg')}" data-sdh-loaded=""
                    alt="${escapeHtml(originalFilename)}"
                    class="w-full max-h-80 object-cover rounded-xl hover:opacity-95 transition-all block"
                    loading="lazy" style="min-height:120px;" />
                ${!shouldAutoDownload ? `
                <div class="sdh-tap-download absolute inset-0 bg-black/55 backdrop-blur-xs flex flex-col items-center justify-center p-3 text-center cursor-pointer hover:bg-black/65 transition-all z-10"
                     onclick="event.stopPropagation(); this.remove(); const img=document.querySelector('img[data-file-id=\\'${fid}\\']'); if (img) SDH.FileUpload.downloadImage({messageId:${fid},mimeType:'${_esc(mimeType || 'image/jpeg')}',imgEl:img});">
                  <span class="w-10 h-10 rounded-full bg-purple-600/90 text-white flex items-center justify-center mb-1.5 shadow-lg">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                  </span>
                  <span class="text-xs font-semibold text-white/95">Tap to download</span>
                </div>` : ''}
                <!-- Hover Expand Overlay Indicator -->
                <div class="absolute inset-0 bg-black/25 opacity-0 group-hover/img:opacity-100 transition-opacity duration-200 flex items-center justify-center pointer-events-none">
                  <span class="p-2.5 rounded-full bg-black/60 text-white backdrop-blur-md border border-white/25 shadow-xl scale-90 group-hover/img:scale-100 transition-transform">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/>
                    </svg>
                  </span>
                </div>
              </div>
              <div class="flex items-center justify-between gap-2 mt-1.5 px-2.5 py-1.5 rounded-xl bg-black/[0.04] dark:bg-white/[0.06] border border-black/5 dark:border-white/10 w-full min-w-0 box-border">
                <div class="flex items-center gap-1.5 min-w-0 flex-1 cursor-pointer"
                     onclick="SDH.MediaViewer?.open({fileId:${fid},fileName:'${_esc(originalFilename)}',mimeType:'${_esc(mimeType || 'image/jpeg')}',messageType:'image',imgEl:this.parentElement.previousElementSibling.querySelector('img')})">
                  <svg class="w-3.5 h-3.5 text-divine-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <p class="text-[11px] font-medium text-divine-text/80 truncate" title="${escapeHtml(originalFilename)}">${escapeHtml(originalFilename)}</p>
                </div>
                <button type="button"
                        onclick="SDH.FileUpload.downloadFile({messageId:${fid},fileName:'${_esc(originalFilename)}',mimeType:'${_esc(mimeType || 'image/jpeg')}',buttonEl:this})"
                        class="sdh-file-download-btn flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all flex-shrink-0 select-none cursor-pointer active:scale-95 shadow-sm"
                        title="Download ${escapeHtml(originalFilename)}">
                  <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                  </svg>
                  <span>Download</span>
                </button>
              </div>
            </div>`;
      }
      return `
          <div class="file-msg media-msg w-[260px] sm:w-[310px] max-w-full flex flex-col box-border">
            <div class="relative overflow-hidden rounded-xl bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/10 shadow-sm w-full box-border cursor-pointer"
                 onclick="const img=this.querySelector('img'); if(img && img.src && img.src!=='#') SDH.MediaViewer?.open({fileName:'${_esc(originalFilename)}',mimeType:'${_esc(mimeType)}',messageType:'image',src:img.src});">
              <img src="#" data-mime="${_esc(mimeType)}"
                  alt="${escapeHtml(originalFilename)}"
                  class="w-full max-h-80 object-cover rounded-xl block"
                  loading="lazy" />
            </div>
            <div class="flex items-center gap-1.5 mt-1.5 px-2.5 py-1.5 rounded-xl bg-black/[0.04] dark:bg-white/[0.06] border border-black/5 dark:border-white/10 w-full min-w-0 box-border">
              <svg class="w-3.5 h-3.5 text-divine-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <p class="text-[11px] font-medium text-divine-text/80 truncate flex-1 min-w-0">${escapeHtml(originalFilename)}</p>
            </div>
          </div>`;
    }

    if (messageType === 'video') {
      if (fileData) {
        return `
            <div class="file-msg media-msg w-[260px] sm:w-[310px] max-w-full">
              <div class="relative overflow-hidden rounded-xl bg-black/10 border border-white/10">
                <video src="${fileData}" controls class="w-full max-h-80 rounded-xl object-contain"></video>
              </div>
            </div>`;
      }
      if (hasServerFile && fileId) {
        const fid = Number(fileId);
        return `
            <div class="file-msg media-msg w-[260px] sm:w-[310px] max-w-full">
              <div class="group/vid flex items-center gap-3 p-3 rounded-xl bg-divine-deep/60
                          border border-divine-border/50 hover:border-divine-gold/40 transition-all w-full box-border cursor-pointer"
                   onclick="SDH.MediaViewer?.open({fileId:${fid},fileName:'${_esc(originalFilename)}',mimeType:'${_esc(mimeType || 'video/mp4')}',messageType:'video'})">
                <div class="w-10 h-10 rounded-lg bg-divine-gold/20 flex items-center justify-center flex-shrink-0 select-none group-hover/vid:scale-105 transition-transform text-divine-gold shadow-sm">
                  <svg class="w-5 h-5 ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                </div>
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-medium text-divine-text truncate" title="${escapeHtml(originalFilename)}">${escapeHtml(originalFilename)}</p>
                  <p class="text-xs text-divine-gold/90 font-semibold">Video · Tap to play</p>
                </div>
                <button type="button"
                        onclick="event.stopPropagation(); SDH.FileUpload.downloadFile({messageId:${fid},fileName:'${_esc(originalFilename)}',mimeType:'${_esc(mimeType || 'video/mp4')}',buttonEl:this})"
                        class="sdh-file-download-btn flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-black/5 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20 text-slate-800 dark:text-white border border-black/10 dark:border-white/10 text-xs font-semibold hover:scale-[1.02] active:scale-[0.98] transition-all flex-shrink-0 cursor-pointer shadow-sm"
                        title="Download video">
                  <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                  </svg>
                  <span>Download</span>
                </button>
              </div>
            </div>`;
      }
      return `
          <div class="file-msg media-msg w-[260px] sm:w-[310px] max-w-full">
            <div class="flex items-center gap-2.5 p-3 rounded-xl bg-divine-deep/60
                        border border-divine-border/50 w-full box-border">
              <span class="text-2xl select-none">🎬</span>
              <div class="min-w-0">
                <p class="text-sm font-medium text-divine-text truncate">${escapeHtml(originalFilename)}</p>
                <p class="text-xs text-divine-muted">Video</p>
              </div>
            </div>
          </div>`;
    }

    if (fileData) {
      return `
          <div class="file-msg w-[260px] sm:w-[310px] max-w-full">
            <div class="flex items-center gap-3 p-3 rounded-xl bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/10">
              <div class="w-10 h-10 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center flex-shrink-0 font-bold text-xs">FILE</div>
              <div class="min-w-0 flex-1">
                <p class="text-xs font-semibold text-divine-text truncate">${escapeHtml(originalFilename)}</p>
                <span class="text-[10px] text-emerald-400 font-bold">Nearby Direct</span>
              </div>
              <a href="${fileData}" download="${escapeHtml(originalFilename)}" class="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm transition-all">Save</a>
            </div>
          </div>`;
    }

    // Generic file & PDF & Audio handling
    if (hasServerFile && fileId) {
      const fid = Number(fileId);
      const isPdf = (mimeType === 'application/pdf') || (originalFilename && originalFilename.toLowerCase().endsWith('.pdf'));
      const isAudio = (mimeType && mimeType.startsWith('audio/')) || (originalFilename && /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(originalFilename));

      if (isPdf) {
        return `
            <div class="file-msg w-[260px] sm:w-[310px] max-w-full">
              <div class="group/pdf flex items-center gap-3 p-3 rounded-xl bg-divine-deep/60
                          border border-rose-500/25 hover:border-rose-500/60 cursor-pointer transition-all w-full box-border"
                   onclick="SDH.MediaViewer?.open({fileId:${fid},fileName:'${_esc(originalFilename)}',mimeType:'application/pdf',messageType:'file'})">
                <div class="w-10 h-10 rounded-lg bg-rose-500/20 border border-rose-500/30 flex items-center justify-center flex-shrink-0 text-rose-400 font-extrabold text-[11px] group-hover/pdf:scale-105 transition-transform tracking-wider shadow-sm">
                  PDF
                </div>
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-medium text-divine-text truncate" title="${escapeHtml(originalFilename)}">${escapeHtml(originalFilename)}</p>
                  <p class="text-xs text-rose-400 font-medium">PDF · Tap to preview</p>
                </div>
                <button type="button"
                        onclick="event.stopPropagation(); SDH.FileUpload.downloadFile({messageId:${fid},fileName:'${_esc(originalFilename)}',mimeType:'application/pdf',buttonEl:this})"
                        class="sdh-file-download-btn p-2 rounded-lg bg-black/5 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20 text-slate-800 dark:text-white border border-black/10 dark:border-white/10 transition-all flex-shrink-0 cursor-pointer hover:scale-105 active:scale-95 shadow-sm"
                        title="Download PDF">
                  <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                  </svg>
                </button>
              </div>
            </div>`;
      }

      if (isAudio) {
        return `
            <div class="file-msg w-[260px] sm:w-[310px] max-w-full">
              <div class="group/aud flex items-center gap-3 p-3 rounded-xl bg-divine-deep/60
                          border border-amber-500/25 hover:border-amber-500/60 cursor-pointer transition-all w-full box-border"
                   onclick="SDH.MediaViewer?.open({fileId:${fid},fileName:'${_esc(originalFilename)}',mimeType:'${_esc(mimeType || 'audio/mpeg')}',messageType:'file'})">
                <div class="w-10 h-10 rounded-lg bg-amber-500/20 border border-amber-500/30 flex items-center justify-center flex-shrink-0 text-amber-400 text-lg group-hover/aud:scale-105 transition-transform shadow-sm">
                  🎵
                </div>
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-medium text-divine-text truncate" title="${escapeHtml(originalFilename)}">${escapeHtml(originalFilename)}</p>
                  <p class="text-xs text-amber-400 font-medium">Audio · Tap to play</p>
                </div>
                <button type="button"
                        onclick="event.stopPropagation(); SDH.FileUpload.downloadFile({messageId:${fid},fileName:'${_esc(originalFilename)}',mimeType:'${_esc(mimeType || 'audio/mpeg')}',buttonEl:this})"
                        class="sdh-file-download-btn p-2 rounded-lg bg-black/5 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20 text-slate-800 dark:text-white border border-black/10 dark:border-white/10 transition-all flex-shrink-0 cursor-pointer hover:scale-105 active:scale-95 shadow-sm"
                        title="Download Audio">
                  <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                  </svg>
                </button>
              </div>
            </div>`;
      }

      return `
          <div class="file-msg w-[260px] sm:w-[310px] max-w-full">
            <div class="group/doc flex items-center gap-3 p-3 rounded-xl bg-divine-deep/60
                        border border-divine-border/50 cursor-pointer hover:border-divine-gold/40 transition-all w-full box-border"
                 onclick="SDH.MediaViewer?.open({fileId:${fid},fileName:'${_esc(originalFilename)}',mimeType:'${_esc(mimeType || 'application/octet-stream')}',messageType:'file'})">
              <span class="text-2xl select-none group-hover/doc:scale-110 transition-transform">📄</span>
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium text-divine-text truncate" title="${escapeHtml(originalFilename)}">${escapeHtml(originalFilename)}</p>
                <p class="text-xs text-divine-muted">Tap to open / download</p>
              </div>
              <button type="button"
                      onclick="event.stopPropagation(); SDH.FileUpload.downloadFile({messageId:${fid},fileName:'${_esc(originalFilename)}',mimeType:'${_esc(mimeType || 'application/octet-stream')}',buttonEl:this})"
                      class="sdh-file-download-btn p-2 rounded-lg bg-black/5 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20 text-slate-800 dark:text-white border border-black/10 dark:border-white/10 transition-all flex-shrink-0 cursor-pointer hover:scale-105 active:scale-95 shadow-sm"
                      title="Download ${escapeHtml(originalFilename)}">
                <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                </svg>
              </button>
            </div>
          </div>`;
    }
    return `
        <div class="file-msg">
          <div class="flex items-center gap-3 p-3 rounded-xl bg-divine-deep/60
                      border border-divine-border/50">
            <span class="text-2xl select-none">📄</span>
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium text-divine-text truncate block max-w-full">${escapeHtml(originalFilename)}</p>
              <p class="text-xs text-divine-muted">File</p>
            </div>
            <svg class="w-4 h-4 flex-shrink-0 text-divine-muted/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
            </svg>
          </div>
        </div>`;
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  //  Send message
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  async function _encryptOutgoingText(text, targetUser) {
    if (!window.SDH?.E2E || !text) {
      return { message: text, encryption_iv: '', is_encrypted: false };
    }
    try {
      if (targetUser && targetUser.startsWith('group_')) {
        const gid = activeUserId || parseInt(targetUser.replace('group_', ''), 10);
        const enc = await window.SDH.E2E.encryptGroupMessage(text, gid);
        if (enc && enc.is_encrypted) {
          return { message: enc.ciphertext, encryption_iv: enc.iv, is_encrypted: true };
        }
      } else if (targetUser) {
        const enc = await window.SDH.E2E.encrypt(text, targetUser);
        if (enc && enc.is_encrypted) {
          return { message: enc.ciphertext, encryption_iv: enc.iv, is_encrypted: true };
        }
      }
    } catch (err) {
      console.warn('[E2EE] Encryption failed, sending unencrypted fallback:', err);
    }
    return { message: text, encryption_iv: '', is_encrypted: false };
  }

  async function sendMessage() {
    if (!activeUser || !activeUserId) return;
    if (!SDH.WS.isOpen()) {
      showToast('Connection lost. Reconnecting...', 'warning');
      SDH.WS.connectWebSocket(activeUserId);
      return;
    }

    const input = document.getElementById('messageInput');
    const rawText = input.value.trim();
    if (!rawText && !pendingFiles.length) return;

    try {
      if (pendingFiles.length > 0) {
        const filesToSend = [...pendingFiles];
        const viewOnceForBatch = isViewOnceActive;
        clearFiles();
        isViewOnceActive = false;
        updateViewOnceBtn();

        const totalFiles = filesToSend.length;
        const hideUploadIndicator = showPersistentNotification(
          totalFiles === 1 ? `Uploading ${filesToSend[0].file.name}...` : `Uploading 1 of ${totalFiles} files...`,
          'info'
        );

        let successCount = 0;
        for (let i = 0; i < totalFiles; i++) {
          const item = filesToSend[i];
          const file = item.file;
          try {
            let msgData;
            const isNearbyMode = window.SDH?.TransportManager?.getMode() === 'nearby';
            if (isNearbyMode && window.SDH?.NearbyFileTransfer) {
              const transferRes = await window.SDH.NearbyFileTransfer.sendFile(
                file,
                activeUser,
                {
                  isViewOnce: viewOnceForBatch,
                  onProgress: (fId, sent, total, pct) => {
                    console.debug('[Chat] Nearby transfer:', file.name, `${pct}%`);
                  }
                }
              );
              msgData = {
                message_id: 'msg_' + transferRes.file_id,
                file_id: transferRes.file_id,
                message_type: transferRes.mime_type.startsWith('image/') ? 'image' : (transferRes.mime_type.startsWith('video/') ? 'video' : 'file'),
                original_filename: transferRes.filename,
                mime_type: transferRes.mime_type,
                timestamp: new Date().toISOString(),
                is_view_once: Boolean(transferRes.is_view_once),
                view_once_opened: false,
                file_data: URL.createObjectURL(file)
              };

              // Persist locally in IndexedDB
              if (window.SDH?.LocalIdentity?.saveNearbyMessage) {
                await window.SDH.LocalIdentity.saveNearbyMessage({
                  ...msgData,
                  sender: window.SDH_DATA.currentUser,
                  receiver: activeUser,
                  has_file: true
                });
              }
            } else {
              msgData = await SDH.FileUpload.handleFileUpload(
                file, activeUser, stage => console.debug('[Chat] File upload:', file.name, stage),
                viewOnceForBatch,
              );
            }

            const realMsgId = msgData.message_id || msgData.file_id;
            if (realMsgId) {
              renderedIds.add(String(realMsgId));
            }
            appendMessage({
              sender: window.SDH_DATA.currentUser, isFromMe: true, content: null,
              messageType: msgData.message_type,
              originalFilename: msgData.original_filename, mimeType: msgData.mime_type,
              timestamp: msgData.timestamp, messageId: realMsgId,
              hasServerFile: !msgData.file_data, fileId: msgData.file_id || realMsgId,
              fileData: msgData.file_data || null,
              isViewOnce: Boolean(msgData.is_view_once),
              viewOnceOpened: Boolean(msgData.view_once_opened),
            });
            scrollToBottom();
            successCount++;
          } catch (uploadErr) {
            console.error('[Chat] File upload error:', file.name, uploadErr);
            showToast(`Failed to upload ${file.name}: ${uploadErr.message || 'Error'}`, 'error');
          }
        }

        hideUploadIndicator();
        if (successCount > 0) {
          playSentSound();
          showToast(successCount === 1 ? 'File sent ✓' : `${successCount} files sent ✓`, 'success');
        }

        if (rawText) {
          const encResult = await _encryptOutgoingText(rawText, activeUser);
          const payload = {
            type: 'chat_message',
            receiver: activeUser,
            message_type: 'text',
            message: encResult.message,
            encryption_iv: encResult.encryption_iv,
            is_encrypted: encResult.is_encrypted,
          };
          if (activeUser.startsWith('group_')) {
            payload.type = 'group_message';
          }

          const tempId = `temp_${Date.now()}_txt`;
          appendMessage({
            sender: window.SDH_DATA.currentUser, isFromMe: true,
            content: rawText, messageType: 'text',
            originalFilename: '', mimeType: '',
            timestamp: new Date().toISOString(), messageId: tempId,
          });
          pendingAckMap.set(tempId, null);
          scrollToBottom();
          stopTyping();
          input.value = '';
          input.style.height = 'auto';

          SDH.WS.sendMessage(payload);
          playSentSound();

          if (!activeUser.startsWith('group_') && !_isSelfChat(activeUser)) {
            _ensureUserInSidebar(activeUser, activeUserId);
            _moveContactToTop(activeUser);
            setTimeout(_refreshSidebar, 350);
          }
        }

        return;
      }

      // Text message
      const encResult = await _encryptOutgoingText(rawText, activeUser);
      const payload = {
        type: 'chat_message',
        receiver: activeUser,
        message_type: 'text',
        message: encResult.message,
        encryption_iv: encResult.encryption_iv,
        is_encrypted: encResult.is_encrypted,
      };
      if (activeUser.startsWith('group_')) {
        payload.type = 'group_message';
      }

      const tempId = `temp_${Date.now()}`;
      appendMessage({
        sender: window.SDH_DATA.currentUser, isFromMe: true,
        content: rawText, messageType: 'text',
        originalFilename: '', mimeType: '',
        timestamp: new Date().toISOString(), messageId: tempId,
      });
      pendingAckMap.set(tempId, null);
      scrollToBottom();
      stopTyping();
      input.value = '';
      input.style.height = 'auto';

      SDH.WS.sendMessage(payload);
      playSentSound();

      if (!activeUser.startsWith('group_') && !_isSelfChat(activeUser)) {
        _ensureUserInSidebar(activeUser, activeUserId);
        _moveContactToTop(activeUser);
        setTimeout(_refreshSidebar, 350);
      }

    } catch (err) {
      console.error('[Chat] Send error:', err);
      showToast('Failed to send message: ' + err.message, 'error');
    }
  }

  /** Registers a temp message ID so it can be deduplicated when the server echoes it back. */
  function registerTempMessage(tempId) {
    pendingAckMap.set(tempId, null);
  }

  /** Replace a temp bubble's DOM id with the real server message_id. */
  function _upgradeTempBubble(realId) {
    for (const [tempId, val] of pendingAckMap) {
      if (val === null) {
        const bubble = document.getElementById(`msg-${tempId}`);
        if (bubble) {
          bubble.id = `msg-${realId}`;
          bubble.dataset.messageId = String(realId);
          // Inject the 3-dot menu now that we have a real ID
          const existingMenu = bubble.querySelector('.msg-menu-wrap');
          if (!existingMenu) {
            const fileImg = bubble.querySelector('[data-file-id]');
            const fileId = fileImg?.dataset?.fileId;
            const mimeType = fileImg?.dataset?.mime || 'application/octet-stream';
            const fileName = fileImg?.alt || 'media';
            const dlHtml = fileId ? `
                  <button onclick="SDH.MediaViewer?.open({fileId:${fileId},fileName:'${_esc(fileName)}',mimeType:'${_esc(mimeType)}'})"
                          class="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-divine-text hover:bg-divine-surface transition-colors text-left font-medium">
                    <svg class="w-3.5 h-3.5 flex-shrink-0 text-divine-gold" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
                    </svg>
                    Preview / Open
                  </button>
                  <button onclick="SDH.FileUpload.downloadFile({messageId:${fileId},fileName:'${_esc(fileName)}',mimeType:'${_esc(mimeType)}',buttonEl:this})"
                          class="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-divine-gold hover:text-divine-text hover:bg-divine-surface transition-colors text-left font-medium">
                    <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                    </svg>
                    Download File
                  </button>
                  <div class="border-t border-divine-border/40 mx-2 my-0.5"></div>` : '';

            const menuWrap = document.createElement('div');
            menuWrap.className = 'msg-menu-wrap flex-shrink-0 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-150 relative self-center';
            menuWrap.innerHTML = `
                <button onclick="SDH.Chat._toggleMsgMenu(this)"
                        class="w-7 h-7 flex items-center justify-center rounded-full text-divine-muted/50 hover:text-divine-gold hover:bg-divine-card/80 border border-transparent hover:border-divine-border/60 transition-all leading-none select-none"
                        title="Message options">⋯</button>
                <div class="msg-dropdown hidden absolute right-0 top-full mt-1 z-[35] w-56 bg-divine-card border border-divine-border/80 rounded-xl shadow-2xl overflow-hidden py-1">
                  ${dlHtml}
                  <button onclick="SDH.Chat.toggleStarMessage(${realId})"
                          class="msg-star-btn w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-amber-400 hover:text-amber-300 hover:bg-divine-surface transition-colors text-left font-medium">
                    <svg class="w-3.5 h-3.5 flex-shrink-0 text-amber-400 fill-current" viewBox="0 0 24 24">
                      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
                    </svg>
                    <span class="msg-star-text">Star Message</span>
                  </button>
                  <div class="border-t border-divine-border/40 mx-2 my-0.5"></div>
                  <button onclick="SDH.Chat._removeFromMyView(this)"
                          class="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-divine-muted hover:text-divine-text hover:bg-divine-surface transition-colors text-left">
                    <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                            d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"/>
                    </svg>
                    Remove from My View
                  </button>
                  ${!_isSelfChat(activeUser) ? `
                  <div class="border-t border-divine-border/40 mx-2 my-0.5"></div>
                  <button onclick="SDH.Chat._confirmDeleteForAll(this)"
                          class="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-red-400/80 hover:text-red-300 hover:bg-red-950/40 transition-colors text-left">
                    <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                    </svg>
                    Delete for All Participants
                  </button>
                  ` : ''}
                </div>`;
            // For sender (right-aligned) put menu on left side
            bubble.insertBefore(menuWrap, bubble.firstChild);
          }
        }
        pendingAckMap.delete(tempId);
        return true;
      }
    }
    return false;
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  //  Delivery / read status
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * Returns inner HTML for a message status tick.
   *   sent      → single ✓   (white/muted)
   *   delivered → double ✓✓  (white/muted)
   *   read      → double ✓✓  (saffron #FF9933)
   */
  function _tickHtml(status) {
    if (status === 'read') {
      return '<span class="inline-flex items-center font-bold tracking-tighter text-[11px]" style="color:#FF9933 !important;" title="Read">✓✓</span>';
    }
    if (status === 'delivered') {
      return '<span class="inline-flex items-center font-bold tracking-tighter text-[11px]" style="color:#94a3b8 !important;" title="Delivered">✓✓</span>';
    }
    if (status === 'sent') {
      return '<span class="inline-flex items-center text-[11px]" style="color:#94a3b8 !important;" title="Sent">✓</span>';
    }
    return '';
  }

  /** Update tick indicator on an already-rendered sender bubble. */
  function _setMsgStatus(messageId, status) {
    if (!messageId) return;
    const bubble = document.getElementById(`msg-${messageId}`);
    if (!bubble) return;
    const tick = bubble.querySelector('.msg-status-tick');
    if (!tick) return;
    tick.innerHTML = _tickHtml(status);
  }

  /** Mark every visible outgoing tick in the current chat as read (saffron). */
  function _markAllSentAsRead() {
    document.querySelectorAll('.msg-status-tick').forEach(tick => {
      tick.innerHTML = _tickHtml('read');
    });
  }



  //  Typing indicator
  // ──────────────────────────────────────────────────────────────────────────
  function sendTyping(state) {
    if (SDH.WS.isOpen()) SDH.WS.sendMessage({ type: 'typing', is_typing: state });
  }

  function stopTyping() {
    if (isTyping) { isTyping = false; sendTyping(false); }
    clearTimeout(typingTimer);
  }

  function handleTypingIndicator(data) {
    if (_isSelfChat(activeUser)) return;
    if (data.sender === window.SDH_DATA.currentUser) return;

    // Prevent cross-display of typing indicators
    if (data.group_id) {
      if (activeUser !== `group_${data.group_id}`) return;
    } else {
      if (!activeUser || activeUser.startsWith('group_') || activeUser !== data.sender) return;
    }

    const bubble = document.getElementById('typingBubble');
    const name = document.getElementById('typingName');
    if (!bubble) return;
    if (data.is_typing) {
      if (name) name.textContent = data.sender;
      bubble.classList.remove('hidden');
      _setHeaderStatus(`${data.sender} is typing...`, 'typing');
      scrollToBottom();
    } else {
      bubble.classList.add('hidden');
      _setDefaultHeaderStatus();
    }
  }

  // â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
  //  Presence (online / offline + last seen)
  // â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
  function handlePresence(data) {
    if (!data || !data.username) return;
    // Keep self-chat label/status stable in the UI.
    if (_isSelfChat(data.username)) return;

    const userItem = document.getElementById(`user-item-${data.username}`);
    const isBlocked = userItem?.dataset?.blocked === '1' || userItem?.dataset?.chatBlocked === '1';
    const isActive = (data.status === 'active') && !isBlocked;

    // Update sidebar status dot using CSS module classes (sdh-online-dot--on/off)
    const dot = document.getElementById(`online-dot-${data.username}`);
    if (dot) {
      dot.classList.remove('sdh-online-dot--on', 'sdh-online-dot--off');
      dot.classList.add(isActive ? 'sdh-online-dot--on' : 'sdh-online-dot--off');
    }

    // Update last-seen sub-label in sidebar
    const lsEl = document.getElementById(`last-seen-${data.username}`);
    if (lsEl) {
      if (isBlocked) {
        lsEl.innerHTML = '&nbsp;';
        lsEl.className = 'text-[11px] sdh-status-inactive truncate mt-0.5';
      } else if (isActive) {
        lsEl.textContent = '● Active';
        lsEl.className = 'text-[11px] sdh-status-active truncate mt-0.5';
      } else if (data.last_seen) {
        lsEl.textContent = 'Last seen ' + _relativeTime(data.last_seen);
        lsEl.className = 'text-[11px] sdh-status-inactive truncate mt-0.5';
      } else {
        lsEl.textContent = 'Offline';
        lsEl.className = 'text-[11px] sdh-status-inactive truncate mt-0.5';
      }
    }

    // Update internal user cache so if we select them later, it's correct
    const u = window.SDH_DATA?.users?.find(x => x.username === data.username);
    if (u) {
      u.is_online = isActive;
      if (data.last_seen) u.last_seen = data.last_seen;
    }

    // Update chat header for the active conversation
    if (data.username === activeUser) {
      if (_isSelfChat(activeUser)) return;
      if (isBlocked) {
        _setHeaderStatus('', 'default');
      } else if (isActive) {
        _setHeaderStatus('Active now', 'connected');
      } else {
        const rel = data.last_seen ? 'Last seen ' + _relativeTime(data.last_seen) : 'Offline';
        _setHeaderStatus(rel, 'disconnected');
      }
    }

    _updateOnlineCount();
    _reorderSidebar();
  }

  function _reorderSidebar() {
    // Reorder direct messages
    const dmList = document.getElementById('dmsContainer');
    if (dmList) {
      const items = Array.from(dmList.querySelectorAll('.user-item'));
      items.sort((a, b) => {
        const aSelf = a.dataset.self === '1' ? 0 : 1;
        const bSelf = b.dataset.self === '1' ? 0 : 1;
        if (aSelf !== bSelf) return aSelf - bSelf;
        const aO = document.getElementById(`online-dot-${a.dataset.username}`)?.classList.contains('sdh-online-dot--on') ? 0 : 1;
        const bO = document.getElementById(`online-dot-${b.dataset.username}`)?.classList.contains('sdh-online-dot--on') ? 0 : 1;
        return aO !== bO ? aO - bO : (a.dataset.username || '').localeCompare(b.dataset.username || '');
      });
      items.forEach(el => dmList.appendChild(el));
    }

    // Reorder groups
    const groupList = document.getElementById('groupsContainer');
    if (groupList) {
      const gItems = Array.from(groupList.querySelectorAll('.user-item'));
      gItems.sort((a, b) => {
        const aName = a.querySelector('.sdh-user-name')?.textContent.trim() || '';
        const bName = b.querySelector('.sdh-user-name')?.textContent.trim() || '';
        return aName.localeCompare(bName);
      });
      gItems.forEach(el => groupList.appendChild(el));
    }

    _updateOnlineCount();
  }

  function _updateOnlineCount() {
    const active = [...document.querySelectorAll('[id^="online-dot-"]')]
      .filter(d => {
        if (!d.classList.contains('sdh-online-dot--on')) return false;
        const row = d.closest('.user-item');
        return row?.dataset?.self !== '1';
      }).length;
    const badge = document.getElementById('onlineCountBadge');
    if (!badge) return;
    if (active > 0) {
      badge.textContent = `${active} active`;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  // â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
  //  Select user
  // â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
  async function selectUser(username, userId) {
    if (window.innerWidth < 640) closeSidebar();
    if (!userId) {
      const uObj = window.SDH_DATA?.users?.find(u => u.username === username);
      if (uObj?.id) userId = uObj.id;
      else {
        const itemEl = document.getElementById(`user-item-${username}`);
        userId = itemEl?.dataset?.userid || itemEl?.getAttribute('data-userid');
      }
      if (!userId && sessionStorage.getItem('ndm_last_chat') === username) {
        userId = sessionStorage.getItem('ndm_last_chat_id');
      }
    }

    if (userId) {
      userId = parseInt(userId, 10) || userId;
      sessionStorage.setItem('ndm_last_chat_id', String(userId));
    }

    // Chat Lock Verification
    if (window.SDH?.ChatLock?.isChatLocked?.(username, false)) {
      if (!window.SDH.ChatLock.isUnlocked()) {
        window.SDH.ChatLock.ensureChatAccessible(username, false, () => {
          selectUser(username, userId);
        });
        return;
      }
    }

    if (activeUser === username) {
      if (userId && (!activeUserId || activeUserId !== userId)) {
        activeUserId = userId;
      }
      return;
    }
    clearFiles();
    activeUser = username; activeUserId = userId;
    currentGroupMembers = [];
    sessionStorage.setItem('ndm_last_chat', username);
    if (userId) sessionStorage.setItem('ndm_last_chat_id', String(userId));
    sessionStorage.setItem('ndm_last_chat_user', window.SDH_DATA?.currentUser || '');

    // Ensure user exists in sidebar list & originalHTML
    if (!_isSelfChat(username) && !username.startsWith('group_')) {
      _ensureUserInSidebar(username, userId);
      if (window.SDH?.E2E?.getPeerPublicKey) {
        window.SDH.E2E.getPeerPublicKey(username);
      }
    }

    if (SDH.WS && userId) {
      SDH.WS.connectWebSocket(userId, false);
    }

    renderedIds.clear();
    dateSeparators.clear();

    document.querySelectorAll('.user-item').forEach(el =>
      el.classList.remove('active-chat-item'));
    document.getElementById(`user-item-${username}`)
      ?.classList.add('active-chat-item');

    const avatarEl = document.getElementById('chatAvatar');
    if (avatarEl) avatarEl.textContent = (username[0] || '?').toUpperCase();
    const usernameEl = document.getElementById('chatUsername');
    if (usernameEl) usernameEl.textContent = _displayNameFor(username);

    _setHeaderStatus('Connecting...', 'reconnecting');
    document.getElementById('inputBar')?.classList.remove('hidden');
    document.getElementById('kebabGroupOptions')?.classList.add('hidden');
    document.getElementById('kebabUserOptions')?.classList.remove('hidden');
    const viewProf = document.getElementById('kebabViewProfileText');
    if (viewProf) viewProf.textContent = 'View Profile';
    if (_isSelfChat(username)) {
      document.getElementById('voiceCallBtn')?.classList.add('hidden');
      document.getElementById('videoCallBtn')?.classList.add('hidden');

      // Hide non-applicable kebab menu options for Saved Messages
      document.getElementById('removeContactBtn')?.classList.add('hidden');
      document.getElementById('unfriendBtn')?.classList.add('hidden');
      document.getElementById('kebabDividerBottom')?.classList.add('hidden');
      document.getElementById('blockBtn')?.classList.add('hidden');
      document.getElementById('unblockBtn')?.classList.add('hidden');
    } else {
      document.getElementById('voiceCallBtn')?.classList.remove('hidden');
      document.getElementById('videoCallBtn')?.classList.remove('hidden');

      // Show kebab options for normal users (blockBtn visibility is handled by _updateBlockUI)
      document.getElementById('removeContactBtn')?.classList.remove('hidden');
      document.getElementById('unfriendBtn')?.classList.remove('hidden');
      document.getElementById('kebabDividerBottom')?.classList.remove('hidden');
    }
    document.getElementById('callButtons')?.classList.remove('hidden');
    const container = document.getElementById('messagesContainer');
    if (container) container.innerHTML = `
        <div class="flex items-center justify-center py-8">
          <div class="w-5 h-5 border-2 border-divine-gold border-t-transparent rounded-full animate-spin"></div>
        </div>`;

    unreadCounts[username] = 0;
    updateUnreadBadge(username);
    updateDocumentTitle();

    // Check if this contact is blocked by us
    const userItem = document.getElementById(`user-item-${username}`);
    const isBlocked = userItem?.dataset?.blocked === '1';
    _updateBlockUI(isBlocked);

    const userObj = window.SDH_DATA.users.find(u => u.username === username);
    if (userObj) {
      const headerAvatar = document.getElementById('chatAvatar');
      if (headerAvatar) {
        if (userObj.avatar_url && userObj.avatar_url.trim() !== '') {
          headerAvatar.innerHTML = `<img src="${userObj.avatar_url}" class="w-full h-full object-cover rounded-full" alt="" onerror="this.parentElement.innerHTML = '${(username[0] || '?').toUpperCase()}';">`;
        } else {
          headerAvatar.innerHTML = '';
          headerAvatar.textContent = (username[0] || '?').toUpperCase();
        }
      }
    }

    await loadHistory(username);

    // Fetch retention setting
    try {
      const res = await fetch(`/messaging/api/chat-setting/${username}/`);
      if (res.ok) {
        const data = await res.json();
        if (data.retention_days) {
          const radios = document.getElementsByName('retention_days');
          radios.forEach(r => {
            if (parseInt(r.value, 10) === data.retention_days) r.checked = true;
          });
        }
      }
    } catch (err) {
      console.error('Failed to fetch chat settings', err);
    }

    _setDefaultHeaderStatus();

    closeSidebar();
    if (!_isSelfChat(username)) {
      SDH.WebRTC?.setRemoteUser(username);
      if (SDH.WS && SDH.WS.isOpen()) {
        if (!window.SDH_SETTINGS || window.SDH_SETTINGS.read_receipts_enabled !== false) {
          SDH.WS.sendMessage({ type: 'read_receipt' });
        }
      }
    }
    Notif.requestPermission();
  }



  // â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
  //  Load history
  // â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
  async function loadHistory(username) {
    const container = document.getElementById('messagesContainer');
    try {
      let messages = [];

      // If in Nearby Mode, read from local IndexedDB store
      if (window.SDH?.TransportManager?.getMode() === 'nearby' && window.SDH?.LocalIdentity) {
        messages = await window.SDH.LocalIdentity.getNearbyHistory(username);
      } else {
        const res = await fetch(`${window.SDH_DATA?.historyUrl || '/messaging/api/history/'}${username}/`);
        if (!res.ok) {
          if (res.status === 423) {
            if (window.SDH?.ChatLock) {
              window.SDH.ChatLock.showAuthModal({
                reason: `Unlock to view this chat`,
                onSuccess: () => loadHistory(username)
              });
            }
            return;
          }
          // If offline fetch failed, fallback to local IndexedDB
          if (window.SDH?.LocalIdentity) {
            messages = await window.SDH.LocalIdentity.getNearbyHistory(username);
          } else {
            throw new Error(res.statusText);
          }
        } else {
          const data = await res.json();
          messages = data.messages || [];
        }
      }

      if (container) container.innerHTML = '';
      dateSeparators.clear();

      if (messages.length === 0) {
        if (container) {
          const title = _isSelfChat(username) ? 'Saved Messages' : 'No messages yet';
          const subtitle = _isSelfChat(username) ? 'Write notes and keep things handy' : 'Start a conversation';
          container.innerHTML = `
              <div class="flex flex-col items-center justify-center h-full text-center text-divine-muted py-16">
                <div class="text-5xl mb-4 opacity-20">&#x1F4AC;</div>
                <p class="text-sm font-medium">${title}</p>
                <p class="text-xs mt-2 opacity-50">${subtitle}</p>
              </div>`;
        }
        _setDefaultHeaderStatus();
        return;
      }

      const fragment = document.createDocumentFragment();
      for (const msg of messages) {
        const isFromMe = msg.sender === window.SDH_DATA.currentUser;
        // Deleted-for-all messages render as a placeholder; no menu shown
        const effectiveType = msg.is_deleted_for_all ? 'deleted' : msg.message_type;
        let content = (effectiveType === 'text' || effectiveType === 'location') ? (msg.message || '') : null;
        if (effectiveType === 'text' && msg.is_encrypted && msg.encryption_iv && window.SDH?.E2E) {
          content = await window.SDH.E2E.decrypt(msg.message, msg.encryption_iv, username);
        }
        const realMsgId = msg.id || msg.message_id;
        renderedIds.add(String(realMsgId));
        appendMessage({
          sender: msg.sender, isFromMe, content,
          messageType: effectiveType,
          location: msg.location || null,
          originalFilename: msg.original_filename, mimeType: msg.mime_type,
          timestamp: msg.timestamp, messageId: realMsgId,
          hasServerFile: !msg.is_deleted_for_all && !(msg.is_view_once && msg.view_once_opened) && (msg.has_file || Boolean(msg.file_id)),
          fileId: msg.is_deleted_for_all ? null : (msg.file_id || null),
          fileData: msg.file_data || null,
          isDelivered: msg.is_delivered || false,
          isRead: msg.is_read || false,
          repliedMoment: msg.replied_moment,
          isViewOnce: Boolean(msg.is_view_once),
          viewOnceOpened: Boolean(msg.view_once_opened),
          isStarred: Boolean(msg.is_starred),
        }, fragment);
      }
      if (container) container.appendChild(fragment);

      _setDefaultHeaderStatus();
      scrollToBottom(true);
    } catch (err) {
      console.error('[Chat] loadHistory error:', err);
      if (container) container.innerHTML = `
          <p class="text-center text-red-400/70 text-sm py-8">Failed to load messages.</p>`;
    }
  }

  // â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
  //  Unread counts
  // â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
  async function loadUnreadCounts() {
    try {
      const res = await fetch('/messaging/api/unread/');
      const data = await res.json();
      unreadCounts = data.unread || {};
      Object.entries(unreadCounts).forEach(([u, c]) => { if (c > 0) updateUnreadBadge(u); });
      updateDocumentTitle();
    } catch { /* non-critical */ }
  }

  function updateUnreadBadge(username) {
    const badge = document.getElementById(`unread-${username}`);
    if (!badge) return;
    const count = unreadCounts[username] || 0;
    if (count > 0) { badge.textContent = count > 99 ? '99+' : String(count); badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  }

  // â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
  //  Input handlers
  // â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
  function onInput(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 128) + 'px';
    if (!isTyping && activeUser) { isTyping = true; sendTyping(true); }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => { isTyping = false; sendTyping(false); }, TYPING_TIMEOUT);
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (window.SDH_SETTINGS && window.SDH_SETTINGS.enter_is_send === false) {
        return;
      }
      e.preventDefault();
      sendMessage();
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  File handling (Multi-file support)
  // ════════════════════════════════════════════════════════════════
  const MAX_BATCH_FILES = 10;

  function _formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function _getFileIconSvg(mimeType, fileName) {
    const ext = (fileName || '').split('.').pop().toLowerCase();
    if (mimeType?.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
      return `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>`;
    }
    if (mimeType?.startsWith('video/') || ['mp4', 'webm', 'ogg', 'mov'].includes(ext)) {
      return `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.069A1 1 0 0121 8.868v6.264a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>`;
    }
    if (mimeType === 'application/pdf' || ext === 'pdf') {
      return `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>`;
    }
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
      return `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"/></svg>`;
    }
    return `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>`;
  }

  function handleFileSelect(input) {
    const rawFiles = Array.from(input.files || []);
    if (!rawFiles.length) return;
    addFilesToPending(rawFiles);
    input.value = '';
  }

  function addFilesToPending(files) {
    if (!files || !files.length) return;

    let addedCount = 0;
    let oversizedCount = 0;

    for (const file of files) {
      if (pendingFiles.length >= MAX_BATCH_FILES) {
        showToast(`Maximum ${MAX_BATCH_FILES} files can be selected at once.`, 'warning');
        break;
      }

      if (file.size > MAX_FILE_SIZE) {
        oversizedCount++;
        continue;
      }

      // Prevent duplicate files in the same batch
      const isDuplicate = pendingFiles.some(item =>
        item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified
      );
      if (isDuplicate) continue;

      const id = 'f_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
      let thumbUrl = null;
      if (file.type && file.type.startsWith('image/')) {
        try { thumbUrl = URL.createObjectURL(file); } catch (e) { }
      }

      pendingFiles.push({ id, file, thumbUrl });
      addedCount++;
    }

    if (oversizedCount > 0) {
      showToast(`${oversizedCount} file(s) exceeded the 5 MB limit and were skipped.`, 'error');
    }

    renderFilePreviews();
    updateViewOnceBtn();
  }

  function removeFile(fileId) {
    const idx = pendingFiles.findIndex(item => item.id === fileId);
    if (idx !== -1) {
      const item = pendingFiles[idx];
      if (item.thumbUrl) {
        try { URL.revokeObjectURL(item.thumbUrl); } catch (e) { }
      }
      pendingFiles.splice(idx, 1);
      renderFilePreviews();
      updateViewOnceBtn();
    }
  }

  function clearFiles() {
    pendingFiles.forEach(item => {
      if (item.thumbUrl) {
        try { URL.revokeObjectURL(item.thumbUrl); } catch (e) { }
      }
    });
    pendingFiles = [];
    const container = document.getElementById('filePreviewContainer');
    if (container) {
      container.innerHTML = '';
      container.classList.add('hidden');
      container.style.display = 'none';
    }
    const legacyPreview = document.getElementById('filePreview');
    if (legacyPreview) {
      legacyPreview.classList.add('hidden');
      legacyPreview.style.display = 'none';
    }
    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.value = '';
    isViewOnceActive = false;
    updateViewOnceBtn();
  }

  // Backward compatibility alias
  const clearFile = clearFiles;

  function renderFilePreviews() {
    const container = document.getElementById('filePreviewContainer');
    if (!container) return;

    if (!pendingFiles.length) {
      container.innerHTML = '';
      container.classList.add('hidden');
      container.style.display = 'none';
      return;
    }

    container.classList.remove('hidden');
    container.style.display = 'flex';

    let chipsHtml = '';
    pendingFiles.forEach(item => {
      const f = item.file;
      const sizeStr = _formatFileSize(f.size);
      const isImg = Boolean(item.thumbUrl);
      const iconHtml = isImg
        ? `<img src="${item.thumbUrl}" alt="preview" class="w-5 h-5 rounded object-cover flex-shrink-0" />`
        : `<div class="w-5 h-5 rounded bg-divine-gold/20 text-divine-gold flex items-center justify-center flex-shrink-0">${_getFileIconSvg(f.type, f.name)}</div>`;

      chipsHtml += `
        <div class="sdh-file-chip inline-flex items-center gap-2 max-w-[240px] sm:max-w-[280px] min-w-0 px-2.5 py-1.5 rounded-xl text-xs box-border" data-file-id="${item.id}">
          ${iconHtml}
          <div class="flex flex-col min-w-0 flex-1">
            <span class="sdh-file-chip-name truncate font-medium" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
            <span class="text-[10px] opacity-70">${sizeStr}</span>
          </div>
          <button type="button" onclick="event.stopPropagation(); SDH.Chat.removeFile('${item.id}')"
            class="sdh-file-chip-remove p-1 rounded-lg text-divine-muted hover:text-red-400 hover:bg-red-500/15 transition-all flex-shrink-0 cursor-pointer"
            title="Remove ${escapeHtml(f.name)}">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      `;
    });

    const hasMedia = pendingFiles.some(f => f.file && f.file.type && (f.file.type.startsWith('image/') || f.file.type.startsWith('video/')));
    if (hasMedia) {
      chipsHtml += `
        <button type="button" onclick="event.stopPropagation(); SDH.Chat.toggleViewOnce()"
          class="sdh-view-once-chip-btn inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold cursor-pointer transition-all self-center select-none ${isViewOnceActive ? 'active' : ''}"
          title="View Once: Recipient can only view once">
          ${_buildViewOnceIconSvg({ opened: false, sizeClass: 'w-4 h-4' })}
          <span>View Once${isViewOnceActive ? ' (On)' : ''}</span>
        </button>
      `;
    }

    if (pendingFiles.length > 1) {
      chipsHtml += `
        <button type="button" onclick="event.stopPropagation(); SDH.Chat.clearFiles()"
          class="px-2.5 py-1 text-[11px] font-semibold rounded-lg text-red-400 hover:bg-red-500/15 transition-colors cursor-pointer flex-shrink-0 self-center"
          title="Remove all files">
          Clear all (${pendingFiles.length})
        </button>
      `;
    }

    container.innerHTML = chipsHtml;
  }


  // ─────────────────────────────────────────────────────────────
  //  Emoji Picker (Categorized & Dynamic)
  // ─────────────────────────────────────────────────────────────
  const EMOJI_CATEGORIES = {
    happy: [
      "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "🥲", "🥹",
      "☺️", "😊", "😇", "🙂", "🙃", "😉", "😌", "😍", "🥰", "😘",
      "😗", "😙", "😚", "😋", "😛", "😝", "😜", "🤪", "🤩", "🥳",
      "😎", "🤗", "🤠", "😸", "😹", "😻", "😺", "😼", "💃", "🕺",
      "✨", "🎉", "🎊", "🥂", "🍾", "🎈", "🌞", "🌻"
    ],
    upset: [
      "😢", "😭", "🥺", "😞", "😔", "😟", "😕", "🙁", "☹️", "😣",
      "😖", "😫", "😩", "😿", "💔", "🥀", "🩹", "🌧️", "🌧", "🖤",
      "🪦", "😶‍🌫️", "🫂", "🤦", "🤦‍♂️", "🤦‍♀️", "🫥", "😠", "😡", "🤬",
      "😤", "😮‍💨", "😪", "😥", "😰", "😨", "😱", "🥶", "🥵", "🤕",
      "🤒", "🤢", "🤮", "🤐", "🤧", "🥴", "😵", "😵‍💫", "🥱", "😓",
      "😒", "🙄", "😬", "😮", "😯", "😧", "🤯", "💀", "☠️"
    ],
    love: [
      "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💔",
      "❣️", "💕", "💞", "💓", "💗", "💖", "💘", "💝", "💟", "💌",
      "💋", "🫶", "💐", "🌹", "🌷", "🌸", "🌺", "💍", "🕊️", "🏩"
    ],
    gestures: [
      "👍", "👎", "👏", "🙌", "🫶", "🤝", "👊", "✊", "🤛", "🤜",
      "✌️", "🤞", "🤟", "🤘", "🤙", "👋", "🫡", "🙏", "✍️", "💪",
      "🧠", "👀", "👁️", "👂", "👃", "👣", "🗣️", "🫰", "👌", "🤌"
    ],
    cool: [
      "🔥", "✨", "⚡", "💯", "🎉", "🚀", "💎", "👑", "🏆", "🌟",
      "💫", "🌙", "☀️", "🌈", "🎯", "🔮", "💡", "🛡️", "⚔️", "💣",
      "💥", "☕", "🍕", "🍔", "🍿", "🎵", "🎶", "🎸", "🎮", "🕹️",
      "📱", "💻", "🦋", "🦄", "🍀", "🕶️", "🦾", "👾", "🤖"
    ]
  };

  let activeEmojiCategory = 'all';

  function initEmojiPicker() {
    renderEmojiGrid(activeEmojiCategory);
  }

  const CATEGORY_NAMES = {
    all: 'All',
    happy: 'Happy',
    upset: 'Upset',
    love: 'Love',
    gestures: 'Hands',
    cool: 'Cool'
  };

  function filterEmojiCategory(category, btnElement) {
    activeEmojiCategory = category;
    if (btnElement && btnElement.parentElement) {
      btnElement.parentElement.querySelectorAll('.sdh-emoji-cat-btn').forEach(btn => {
        btn.classList.remove('active');
      });
      btnElement.classList.add('active');
    }
    const titleEl = document.getElementById('emojiCategoryTitle');
    if (titleEl) {
      titleEl.textContent = CATEGORY_NAMES[category] || category;
    }
    renderEmojiGrid(category);
  }

  function renderEmojiGrid(category = 'all') {
    const grid = document.getElementById('emojiGrid');
    if (!grid) return;

    let emojis = [];
    if (category === 'all') {
      const set = new Set();
      Object.values(EMOJI_CATEGORIES).forEach(arr => arr.forEach(e => set.add(e)));
      emojis = Array.from(set);
    } else if (EMOJI_CATEGORIES[category]) {
      emojis = EMOJI_CATEGORIES[category];
    } else {
      emojis = EMOJI_CATEGORIES.happy;
    }

    const countBadge = document.getElementById('emojiPickerCount');
    if (countBadge) {
      countBadge.textContent = `${emojis.length}`;
    }

    grid.innerHTML = emojis
      .map(e => `<button type="button" class="sdh-emoji-btn" onclick="SDH.Chat.insertEmoji('${e}')" title="${e}" aria-label="Emoji ${e}">${e}</button>`)
      .join('');
  }

  function toggleEmojiPicker() {
    const picker = document.getElementById('emojiPicker');
    if (picker) {
      const isHidden = picker.classList.contains('hidden');
      if (isHidden) {
        initEmojiPicker();
      }
      picker.classList.toggle('hidden');
    }
  }

  function insertEmoji(emoji) {
    const input = document.getElementById('messageInput');
    if (input) {
      const pos = input.selectionStart ?? input.value.length;
      input.value = input.value.slice(0, pos) + emoji + input.value.slice(pos);
      input.focus();
      input.setSelectionRange(pos + emoji.length, pos + emoji.length);
    }
  }



  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const picker = document.getElementById('emojiPicker');
      if (picker && !picker.classList.contains('hidden')) {
        picker.classList.add('hidden');
      }
    }
  });

  // â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
  //  Sidebar
  // â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
  function filterUsers(query) {
    const q = query.toLowerCase();
    document.querySelectorAll('.user-item').forEach(el => {
      const username = el.dataset.username?.toLowerCase() || '';
      const groupName = el.querySelector('.sdh-user-name')?.textContent.toLowerCase() || '';
      if (username.includes(q) || groupName.includes(q)) {
        el.style.display = '';
      } else {
        el.style.display = 'none';
      }
    });
  }

  function openSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
      sidebar.classList.remove('-translate-x-full');
      sidebar.classList.add('translate-x-0');
      sidebar.style.pointerEvents = 'auto';
    }
    document.getElementById('sidebarOverlay')?.classList.remove('hidden');
  }

  function closeSidebar() {
    if (window.innerWidth >= 640) return; // Desktop sidebar is always visible
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
      sidebar.classList.remove('translate-x-0');
      sidebar.classList.add('-translate-x-full');
      // Disable pointer-events while off-screen so the hidden sidebar
      // doesn't intercept taps on mobile (especially the hamburger button).
      sidebar.style.pointerEvents = 'none';
    }
    document.getElementById('sidebarOverlay')?.classList.add('hidden');
  }

  // ── Clipboard paste attachment support ─────────────────────────────────────
  document.addEventListener('paste', (e) => {
    const input = document.getElementById('messageInput');
    if (!input || document.activeElement !== input) return;
    const items = e.clipboardData?.items;
    if (!items || !items.length) return;
    const files = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const f = items[i].getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      addFilesToPending(files);
    }
  });

  // ── Scroll + Toast ────────────────────────────────────────────────────────
  let isScrollingTimeout = null;

  function _initScrollOptimization() {
    const container = document.getElementById('messagesContainer');
    if (!container) return;
    container.addEventListener('scroll', () => {
      if (!container.classList.contains('is-scrolling')) {
        container.classList.add('is-scrolling');
      }
      clearTimeout(isScrollingTimeout);
      isScrollingTimeout = setTimeout(() => {
        container.classList.remove('is-scrolling');
      }, 150); // Re-enable pointer events 150ms after scroll stops
    }, { passive: true });
  }

  // Call this once on load
  document.addEventListener('DOMContentLoaded', _initScrollOptimization);

  let _scrollRaf = null;
  function scrollToBottom(instant = false) {
    const el = document.getElementById('messagesContainer');
    if (!el) return;
    if (_scrollRaf) {
      cancelAnimationFrame(_scrollRaf);
      _scrollRaf = null;
    }
    if (instant) {
      el.scrollTop = el.scrollHeight;
    } else {
      _scrollRaf = requestAnimationFrame(() => {
        _scrollRaf = null;
        el.scrollTo({
          top: el.scrollHeight,
          behavior: 'smooth'
        });
      });
    }
  }

  function showPersistentNotification(message, type = 'info') {
    let container = document.getElementById('chatToastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'chatToastContainer';
      container.className = 'fixed top-6 left-1/2 -translate-x-1/2 z-[9999] flex flex-col gap-2 items-center pointer-events-none';
      document.body.appendChild(container);
    }
    const colors = {
      info: 'bg-divine-card border-divine-border text-divine-text',
      success: 'bg-green-900/80 border-green-700 text-green-200',
      warning: 'bg-yellow-900/80 border-yellow-700 text-yellow-200',
      error: 'bg-red-900/80 border-red-700 text-red-200',
    };
    const toast = document.createElement('div');
    toast.className = `pointer-events-auto px-5 py-3 rounded-xl border text-sm shadow-2xl animate-slide-in flex items-center gap-3 ${colors[type] || colors.info}`;
    toast.innerHTML = `
      <svg class="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24" style="color: inherit;">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
      <span>${message}</span>
    `;
    container.appendChild(toast);

    return function hide() {
      toast.style.transition = 'opacity 0.4s';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 400);
    };
  }

  function showToast(message, type = 'info', onClick = null) {
    // Avoid duplicate consecutive toasts in the queue
    const lastInQueue = toastQueue[toastQueue.length - 1];
    if (lastInQueue && lastInQueue.message === message) return;

    // Also avoid duplicate with currently showing toast
    const currentlyShowingEl = document.getElementById('chatToastContainer')?.firstElementChild;
    if (currentlyShowingEl && currentlyShowingEl.textContent === message) return;

    toastQueue.push({ message, type, onClick });
    processToastQueue();
  }

  function processToastQueue() {
    if (isShowingToast || toastQueue.length === 0) return;
    isShowingToast = true;

    const { message, type, onClick } = toastQueue.shift();

    const colors = {
      info: 'bg-divine-card border-divine-border text-divine-text',
      success: 'bg-green-900/80 border-green-700 text-green-200',
      warning: 'bg-yellow-900/80 border-yellow-700 text-yellow-200',
      error: 'bg-red-900/80 border-red-700 text-red-200',
    };

    let container = document.getElementById('chatToastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'chatToastContainer';
      container.className = 'fixed top-6 left-1/2 -translate-x-1/2 z-[9999] flex flex-col gap-2 items-center pointer-events-none';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `sdh-toast sdh-toast-${type} pointer-events-auto px-5 py-3 rounded-xl border text-sm shadow-2xl animate-slide-in
                        ${colors[type] || colors.info}`;
    toast.textContent = message;

    if (typeof onClick === 'function') {
      toast.style.cursor = 'pointer';
      toast.title = 'Click to view';
      toast.onclick = () => {
        try { onClick(); } catch (e) { console.error(e); }
        toast.remove();
        isShowingToast = false;
        processToastQueue();
      };
    }

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.transition = 'opacity 0.4s';
      toast.style.opacity = '0';
      setTimeout(() => {
        toast.remove();
        isShowingToast = false;
        processToastQueue();
      }, 400);
    }, 2800);
  }

  let removeMyViewCount = 0;
  let removeMyViewTimer = null;
  function _showRemoveMyViewToast() {
    removeMyViewCount++;
    if (removeMyViewTimer) clearTimeout(removeMyViewTimer);

    // We want to clear the previous toast from this action if it's aggregating
    const container = document.getElementById('chatToastContainer');
    if (container) {
      const existingRemoveToasts = Array.from(container.children).filter(t => t.textContent.includes('removed from your view'));
      existingRemoveToasts.forEach(t => t.remove());
    }

    removeMyViewTimer = setTimeout(() => {
      if (removeMyViewCount > 1) {
        showToast(`${removeMyViewCount} messages removed from your view.`, 'success');
      } else {
        showToast('Message removed from your view.', 'success');
      }
      removeMyViewCount = 0;
    }, 300);
  }

  // â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
  //  Bootstrap
  // â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
  async function initializeChat() {
    try {
      window.SDH?.ChatLock?.init?.();
    } catch (e) {
      console.warn('[Chat] ChatLock init error:', e);
    }
    await loadUnreadCounts();
    _updateOnlineCount();
    // Load friend requests
    await loadFriendRequests();
    // Load pending group invites
    await fetchPendingGroupInvites();
    // Show notification permission banner if not yet decided
    if ('Notification' in window && Notification.permission === 'default') {
      const banner = document.getElementById('notifPrompt');
      if (banner) banner.classList.replace('hidden', 'flex');
    }
    updateViewOnceBtn();

    // Initialize Mention autocomplete on message input
    const msgInput = document.getElementById('messageInput');
    const mentionDropdown = document.getElementById('mentionDropdown');
    if (msgInput && window.SDH?.Mentions) {
      window.SDH.Mentions.attach(msgInput, {
        dropdownEl: mentionDropdown,
        getContext: () => ({
          isGroup: Boolean(activeUser && activeUser.startsWith('group_')),
          groupId: activeUserId
        })
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Group Invite Functions
  // ═══════════════════════════════════════════════════════════════════

  async function fetchPendingGroupInvites() {
    if (!window.SDH_DATA.groupPendingInvitesUrl) return;
    try {
      const res = await fetch(window.SDH_DATA.groupPendingInvitesUrl);
      if (!res.ok) return;
      const data = await res.json();
      if (data.invites && data.invites.length > 0) {
        // Display them one by one or all at once. Showing sequentially via delay or stacking them
        data.invites.forEach((invite, idx) => {
          setTimeout(() => {
            showGroupInviteModal(invite);
          }, idx * 500);
        });
      }
    } catch (err) {
      console.error('[Chat] fetchPendingGroupInvites error:', err);
    }
  }

  function showGroupInviteModal(invite) {
    if (!invite || !invite.invite_id) return;
    // Check if already open
    if (document.getElementById(`group-invite-modal-${invite.invite_id}`)) return;

    const initial = (invite.group_name && invite.group_name[0]) ? invite.group_name[0].toUpperCase() : 'G';
    const inviterName = escapeHtml(invite.inviter || 'Someone');
    const groupName = escapeHtml(invite.group_name || 'Group');

    const modalHtml = `
        <div id="group-invite-modal-${invite.invite_id}" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-md p-4 transition-all duration-300 animate-fade-in">
          <div class="bg-divine-card border border-divine-border/80 rounded-2xl p-6 w-full max-w-sm shadow-2xl transform transition-all relative overflow-hidden text-center" style="box-shadow: 0 20px 50px -10px rgba(0,0,0,0.35);">
            <!-- Decorative accent ambient glow -->
            <div class="absolute -top-12 -right-12 w-36 h-36 rounded-full blur-3xl pointer-events-none" style="background: rgba(139, 92, 246, 0.2);"></div>
            <div class="absolute -bottom-12 -left-12 w-36 h-36 rounded-full blur-3xl pointer-events-none" style="background: rgba(99, 102, 241, 0.15);"></div>

            <!-- Group Avatar Icon with Glow -->
            <div class="mx-auto mb-4 w-16 h-16 rounded-2xl flex items-center justify-center text-2xl font-black shadow-lg relative" style="background: linear-gradient(135deg, rgba(139,92,246,0.25), rgba(99,102,241,0.15)); border: 1px solid rgba(139,92,246,0.4); color: #c084fc;">
              ${initial}
              <span class="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-emerald-500 border-2 border-divine-card flex items-center justify-center text-[10px] text-white">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"/></svg>
              </span>
            </div>

            <!-- Title & Cool Professional Sentence -->
            <h3 class="text-base font-bold text-divine-text tracking-tight mb-2">Group Invitation</h3>
            <p class="text-sm text-divine-muted leading-relaxed px-1">
              <span class="font-semibold text-purple-400">@${inviterName}</span> wants to add you to the group <span class="font-bold text-divine-text">"${groupName}"</span>. Connect, collaborate, and chat together.
            </p>

            <!-- Action Buttons: Deny & Allow -->
            <div class="flex items-center gap-3 mt-6">
              <button type="button" onclick="SDH.Chat.respondGroupInvite(${invite.invite_id}, 'decline')"
                class="flex-1 py-2.5 px-4 rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:text-red-300 font-semibold text-sm transition-all focus:outline-none focus:ring-2 focus:ring-red-500/30 active:scale-[0.98]">
                Deny
              </button>
              <button type="button" onclick="SDH.Chat.respondGroupInvite(${invite.invite_id}, 'accept')"
                class="flex-1 py-2.5 px-4 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold text-sm transition-all shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40 hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-purple-500/50 active:scale-[0.98]">
                Allow
              </button>
            </div>
          </div>
        </div>
      `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
  }

  async function respondGroupInvite(inviteId, action) {
    const modal = document.getElementById(`group-invite-modal-${inviteId}`);
    if (modal) {
      modal.classList.add('opacity-0', 'scale-95');
      setTimeout(() => modal.remove(), 250);
    }

    try {
      const url = window.SDH_DATA.groupInviteRespondUrl.replace('/0/', `/${inviteId}/`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRFToken': window.SDH_DATA.csrfToken },
        body: JSON.stringify({ action })
      });
      const data = await res.json();
      if (res.ok) {
        if (action === 'accept') {
          showToast(`Joined ${data.group_name || 'the group'} successfully!`, 'success');
          // Soft refresh sidebar in real-time so the new group appears under GROUPS immediately
          await _refreshSidebar();
          // Automatically navigate into the group
          if (data.group_id) {
            selectGroup(data.group_id, data.group_name || 'Group');
          }
        } else {
          showToast('Group invitation denied.', 'info');
        }
      } else {
        showToast(data.error || 'Failed to respond to invite', 'error');
      }
    } catch (err) {
      showToast('Network error responding to invite', 'error');
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Friend Request Functions
  // ═══════════════════════════════════════════════════════════════════

  async function loadFriendRequests() {
    try {
      const res = await fetch(window.SDH_DATA.friendRequestsUrl || '/users/api/friend-requests/');
      if (!res.ok) return;
      const data = await res.json();
      const incoming = data.incoming || [];
      const panel = document.getElementById('friendRequestsPanel');
      const list = document.getElementById('friendRequestsList');
      const badge = document.getElementById('frCountBadge');

      if (incoming.length === 0) {
        panel?.classList.add('hidden');
        return;
      }

      panel?.classList.remove('hidden');
      if (badge) {
        badge.textContent = String(incoming.length);
        badge.classList.remove('hidden');
      }

      if (list) {
        list.innerHTML = incoming.map(fr => `
            <div class="p-2.5 rounded-2xl transition-all duration-200 hover:bg-white/[0.04] border border-white/[0.06] bg-white/[0.02] shadow-sm space-y-2.5 group" data-fr-id="${fr.id}">
              <!-- Clickable Profile Header (Instagram style) -->
              <div class="flex items-center gap-2.5 cursor-pointer select-none"
                   onclick="SDH.Chat.showUserProfile('${escapeHtml(fr.username)}', ${fr.user_id || 'null'}, { isPendingFriendRequest: true, requestId: ${fr.id} })"
                   title="Click to view @${escapeHtml(fr.username)}'s profile">
                <div class="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold select-none shadow-md flex-shrink-0 relative overflow-hidden"
                  style="background: linear-gradient(135deg, rgba(168,85,247,0.3), rgba(129,140,248,0.22)); color: #c084fc; border: 1.5px solid rgba(168,85,247,0.35);">
                  ${fr.avatar_url ? `<img src="${escapeHtml(fr.avatar_url)}" class="w-full h-full object-cover" />` : escapeHtml((fr.display_name || fr.username || '?')[0].toUpperCase())}
                </div>
                <div class="flex flex-col min-w-0 flex-1">
                  <div class="flex items-center gap-1">
                    <span class="text-xs font-bold truncate leading-tight group-hover:text-purple-400 transition-colors" style="color:var(--c-text)">
                      ${escapeHtml(fr.display_name || fr.username)}
                    </span>
                  </div>
                  <div class="flex items-center gap-1 text-[10px] text-divine-muted truncate mt-0.5">
                    <span class="font-medium text-purple-400/90">@${escapeHtml(fr.username)}</span>
                    <span>•</span>
                    <span class="text-divine-muted/70 group-hover:text-divine-gold transition-colors flex items-center gap-0.5">
                      View Profile
                      <svg class="w-2.5 h-2.5 inline group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7" />
                      </svg>
                    </span>
                  </div>
                </div>
              </div>

              <!-- Liquid Action Buttons -->
              <div class="flex items-center gap-2 pt-0.5">
                <button onclick="SDH.Chat.respondFriendRequest(${fr.id}, 'accept', this)"
                  class="sdh-liquid-action-btn btn-liquid-accept flex-1 !py-1.5 justify-center" aria-label="Accept friend request">
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
                  </svg>
                  <span>Accept</span>
                </button>
                <button onclick="SDH.Chat.respondFriendRequest(${fr.id}, 'reject', this)"
                  class="sdh-liquid-action-btn btn-liquid-reject flex-1 !py-1.5 justify-center" aria-label="Reject friend request">
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
                  </svg>
                  <span>Reject</span>
                </button>
              </div>
            </div>
          `).join('');
      }
    } catch (e) {
      console.error('[Chat] loadFriendRequests error:', e);
    }
  }

  async function sendFriendRequest(userId, btnElement) {
    try {
      const res = await fetch(window.SDH_DATA.sendFriendRequestUrl || '/users/api/send-friend-request/', {
        method: 'POST',
        headers: {
          'X-CSRFToken': window.SDH_DATA.csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ target_user_id: parseInt(userId, 10) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);

      if (data.status === 'accepted') {
        showToast(data.message || 'Friend request accepted!', 'success');
        const searchInput = document.getElementById('searchUsers');
        if (searchInput) searchInput.value = '';
        _refreshSidebar();
      } else {
        showToast('Friend request sent!', 'success');
        if (btnElement) {
          btnElement.outerHTML = `
            <div class="flex-shrink-0 z-10 px-2.5 py-1 text-[10px] font-semibold rounded-lg
                        border border-divine-border bg-divine-surface text-divine-muted select-none"
                 onclick="event.stopPropagation()">
              Awaiting Confirmation
            </div>
          `;
        }
      }
    } catch (err) {
      if (err.message === 'Request already sent') {
        showToast('Request already sent', 'info');
      } else {
        showToast(err.message || 'Could not send friend request.', 'error');
      }
    }
  }

  async function respondFriendRequest(requestId, action, btnElement) {
    const frEl = document.querySelector(`[data-fr-id="${requestId}"]`);
    if (frEl) {
      const buttons = frEl.querySelectorAll('button');
      buttons.forEach(b => {
        b.disabled = true;
        b.style.pointerEvents = 'none';
        b.style.opacity = '0.5';
      });
    }

    try {
      const res = await fetch(window.SDH_DATA.respondFriendRequestUrl || '/users/api/respond-friend-request/', {
        method: 'POST',
        headers: {
          'X-CSRFToken': window.SDH_DATA.csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ request_id: requestId, action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);

      // Smooth liquid dissolve out animation
      if (frEl) {
        frEl.style.transition = 'all 0.28s cubic-bezier(0.4, 0, 0.2, 1)';
        frEl.style.opacity = '0';
        frEl.style.transform = 'translateX(12px) scale(0.96)';
        setTimeout(() => {
          frEl.remove();
          // Hide panel if no more requests
          const remaining = document.querySelectorAll('#friendRequestsList [data-fr-id]');
          if (remaining.length === 0) {
            document.getElementById('friendRequestsPanel')?.classList.add('hidden');
          } else {
            const badge = document.getElementById('frCountBadge');
            if (badge) badge.textContent = String(remaining.length);
          }
        }, 260);
      }

      if (action === 'accept') {
        showToast('Friend request accepted! They now appear in your chat list.', 'success');
        const searchInput = document.getElementById('searchUsers');
        if (searchInput) searchInput.value = '';
        _refreshSidebar();
      } else {
        showToast('Friend request rejected.', 'info');
      }
    } catch (err) {
      if (frEl) {
        const buttons = frEl.querySelectorAll('button');
        buttons.forEach(b => {
          b.disabled = false;
          b.style.pointerEvents = '';
          b.style.opacity = '1';
        });
      }
      showToast(err.message || 'Could not respond to request.', 'error');
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Utility
  // ═══════════════════════════════════════════════════════════════════
  function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function _dateLabel(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    const today = new Date();
    const diffD = Math.floor(
      (new Date(today.getFullYear(), today.getMonth(), today.getDate()) -
        new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000,
    );
    if (diffD === 0) return 'Today';
    if (diffD === 1) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  }

  function _relativeTime(isoString) {
    if (!isoString) return '';
    const diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
    return new Date(isoString).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  /** Fetch and display a friend's user profile in the premium modal. */
  function openAvatarViewer() {
    const upmAvatarImg = document.getElementById('upmAvatarImg');
    if (upmAvatarImg && !upmAvatarImg.classList.contains('hidden') && upmAvatarImg.src) {
      const viewerModal = document.getElementById('avatarViewerModal');
      const viewerImg = document.getElementById('avatarViewerImg');
      if (viewerModal && viewerImg) {
        viewerImg.src = upmAvatarImg.src;
        viewerModal.classList.remove('hidden');
      }
    }
  }

  function _sortGroupMembers(members) {
    if (!Array.isArray(members)) return [];
    const roleWeights = { owner: 1, admin: 2, member: 3 };
    return [...members].sort((a, b) => {
      const wA = roleWeights[(a.role || 'member').toLowerCase()] || 4;
      const wB = roleWeights[(b.role || 'member').toLowerCase()] || 4;
      if (wA !== wB) return wA - wB;
      const nameA = (a.display_name || a.username || '').toLowerCase();
      const nameB = (b.display_name || b.username || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });
  }

  function _renderGroupMemberCard(m, groupId, isAdminOrOwner) {
    const isMe = (m.user_id && m.user_id === window.SDH_DATA?.userId) ||
                 (m.username === window.SDH_DATA?.currentUser);
    const canRemove = Boolean(isAdminOrOwner && !isMe && m.role !== 'owner');
    const roleLower = (m.role || 'member').toLowerCase();

    // High-end role badge with contextual icon
    let roleBadge = '';
    if (roleLower === 'owner') {
      roleBadge = `
        <span class="sdh-member-tag-owner inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide bg-amber-500/10 text-amber-400 dark:text-amber-300 border border-amber-500/20">
          <svg class="w-2.5 h-2.5 text-amber-400 shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/>
          </svg>
          Owner
        </span>`;
    } else if (roleLower === 'admin') {
      roleBadge = `
        <span class="sdh-member-tag-admin inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide bg-purple-500/10 text-purple-400 dark:text-purple-300 border border-purple-500/20">
          <svg class="w-2.5 h-2.5 text-purple-400 shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M10 1.944A11.954 11.954 0 012.166 5C2.056 5.649 2 6.319 2 7c0 5.225 3.34 9.67 8 11.317C14.66 16.67 18 12.225 18 7c0-.682-.057-1.35-.166-2.001A11.954 11.954 0 0110 1.944z" clip-rule="evenodd"/>
          </svg>
          Admin
        </span>`;
    } else {
      roleBadge = `
        <span class="sdh-member-tag-member text-[11px] font-medium text-slate-400 dark:text-slate-400">
          Member
        </span>`;
    }

    // Modern status indicator
    let statusHtml = '';
    if (m.state === 'invited') {
      statusHtml = `
        <span class="sdh-member-status-text inline-flex items-center gap-1 text-[11px] font-medium text-amber-400/90">
          <span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span> Invited
        </span>`;
    } else if (m.is_online) {
      statusHtml = `
        <span class="sdh-member-status-text inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> Active
        </span>`;
    } else if (m.last_seen) {
      statusHtml = `
        <span class="sdh-member-status-text inline-flex items-center gap-1 text-[11px] text-slate-400">
          <span class="w-1.5 h-1.5 rounded-full bg-slate-500/60"></span> Last seen ${_relativeTime(m.last_seen)}
        </span>`;
    } else {
      statusHtml = `
        <span class="sdh-member-status-text inline-flex items-center gap-1 text-[11px] text-slate-400">
          <span class="w-1.5 h-1.5 rounded-full bg-slate-500/60"></span> Offline
        </span>`;
    }

    const initial = (m.username || 'U')[0].toUpperCase();
    const displayName = isMe ? 'You' : (m.display_name || m.username);

    return `
      <div id="upm-member-row-${groupId}-${m.user_id}" class="sdh-member-card flex items-center justify-between py-2 px-2.5 rounded-lg group transition-colors">
        <div class="flex items-center gap-2.5 sm:gap-3 cursor-pointer flex-1 min-w-0" 
             onclick="document.getElementById('userProfileModal').classList.add('hidden'); SDH.Chat.showUserProfile('${escapeHtml(m.username)}', ${m.user_id})">
          <div class="relative shrink-0">
            ${m.avatar_url ?
              `<img src="${escapeHtml(m.avatar_url)}" class="w-8 h-8 rounded-full object-cover ring-1 ring-white/10" alt="${escapeHtml(displayName)}" />` :
              `<div class="w-8 h-8 rounded-full bg-gradient-to-br from-violet-600/30 to-purple-800/40 border border-purple-500/30 flex items-center justify-center text-xs font-bold text-purple-200">${initial}</div>`
            }
            <span class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-[#0c0a1d] dark:ring-[#0c0a1d] ${m.is_online ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.7)]' : 'bg-slate-500/80'}"></span>
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1.5 min-w-0">
              <p class="sdh-member-name text-[13px] font-semibold truncate text-slate-100 group-hover:text-purple-300 transition-colors">${escapeHtml(displayName)}</p>
              ${isMe ? `<span class="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.2 rounded bg-purple-500/20 text-purple-300 shrink-0">You</span>` : ''}
            </div>
            <div class="flex items-center gap-1.5 mt-0.5 flex-wrap">
              ${roleBadge}
              <span class="text-white/20 dark:text-white/20 text-[10px]">•</span>
              ${statusHtml}
            </div>
          </div>
        </div>
        ${canRemove ? `
          <button type="button" 
                  onclick="event.stopPropagation(); SDH.Chat.removeGroupMember(${groupId}, ${m.user_id})" 
                  class="ml-2 text-[11px] font-semibold px-2 py-1 text-rose-400 hover:text-white hover:bg-rose-500/20 rounded-md transition-all duration-150 flex items-center gap-1 shrink-0 active:scale-95"
                  title="Remove member">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
            </svg>
            <span>Remove</span>
          </button>
        ` : ''}
      </div>
    `;
  }

  async function showUserProfile(username, userId, options = {}) {
    if (!username) return;
    if (username === window.SDH_DATA.currentUser) return;

    // Close context menus
    _closeAllUserMenus();

    const modal = document.getElementById('userProfileModal');
    if (!modal) return;

    // Select DOM elements inside the modal
    const avatarWrapper = document.getElementById('upmAvatarWrapper');
    const avatarText = document.getElementById('upmAvatarText');
    const avatarImg = document.getElementById('upmAvatarImg');
    const displayNameEl = document.getElementById('upmDisplayName');
    const usernameEl = document.getElementById('upmUsername');
    const statusDot = document.getElementById('upmStatusDot');
    const statusText = document.getElementById('upmStatusText');
    const bioEl = document.getElementById('upmBio');
    const emailEl = document.getElementById('upmEmail');
    const phoneEl = document.getElementById('upmPhone');
    const joinedEl = document.getElementById('upmJoined');
    const lastSeenEl = document.getElementById('upmLastSeen');
    const messageBtn = document.getElementById('upmMessageBtn');
    const inviteBtnInit = document.getElementById('upmInviteMemberBtn');
    const pendingSection = document.getElementById('upmPendingRequestSection');
    const membersSectionInit = document.getElementById('upmMembersSection');
    const upmAcceptBtn = document.getElementById('upmAcceptBtn');
    const upmRejectBtn = document.getElementById('upmRejectBtn');
    const navigationSuite = document.getElementById('upmNavigationSuite');

    if (inviteBtnInit) inviteBtnInit.classList.add('hidden');
    if (pendingSection) pendingSection.classList.add('hidden');
    if (membersSectionInit) membersSectionInit.classList.add('hidden');
    if (navigationSuite) navigationSuite.classList.add('hidden');
    if (messageBtn) messageBtn.classList.remove('hidden');

    // Set skeleton / loading states
    displayNameEl.textContent = 'Loading...';
    usernameEl.textContent = `@${username}`;
    bioEl.textContent = 'Fetching biography...';
    emailEl.textContent = '—';
    phoneEl.textContent = '—';
    joinedEl.textContent = 'Joined —';
    lastSeenEl.textContent = 'Last seen —';
    lastSeenEl.classList.remove('hidden');

    avatarText.textContent = username[0].toUpperCase();
    avatarText.classList.remove('hidden');
    avatarImg.classList.add('hidden');
    avatarImg.src = '';

    // Reset dynamic border glows
    avatarWrapper.style.borderColor = '';
    avatarWrapper.style.boxShadow = '';
    statusDot.className = 'w-2 h-2 rounded-full sdh-pulse-dot bg-purple-500';
    statusText.textContent = 'Offline';
    statusText.className = 'text-[11px] font-semibold text-divine-muted';

    // Open the modal immediately so user sees the premium skeleton
    modal.classList.remove('hidden');

    try {
      let data;
      let isGroup = username.startsWith('group_');

      if (isGroup) {
        const groupId = username.replace('group_', '');
        const response = await fetch(`/messaging/api/groups/${groupId}/`);
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || response.statusText);
        }
        const groupData = await response.json();
        data = {
          avatar_url: groupData.avatar_url,
          display_name: groupData.name,
          username: username,
          bio: groupData.description || 'No description provided.',
          email: 'Group Chat',
          phone_number: `${groupData.members ? groupData.members.length : 0} members`,
          date_joined: null,
          is_online: true,
          last_seen: null
        };

        if (lastSeenEl) lastSeenEl.classList.add('hidden');

        // Show members section
        const membersSection = document.getElementById('upmMembersSection');
        const membersList = document.getElementById('upmMembersList');
        if (membersSection && membersList && groupData.members) {
          membersSection.classList.remove('hidden');

          const myMember = groupData.members.find(m => m.username === window.SDH_DATA.currentUser);
          const isAdminOrOwner = myMember && (myMember.role === 'owner' || myMember.role === 'admin');

          const countBadge = document.getElementById('upmMembersCount');
          if (countBadge) {
            countBadge.textContent = `${groupData.members.length} member${groupData.members.length === 1 ? '' : 's'}`;
          }

          const sortedMembers = _sortGroupMembers(groupData.members);
          membersList.innerHTML = sortedMembers.map(m => _renderGroupMemberCard(m, groupId, isAdminOrOwner)).join('');

          // Unhide Invite Member button for all members
          const inviteBtn = document.getElementById('upmInviteMemberBtn');
          const myMemberRef = groupData.members.find(m => m.username === window.SDH_DATA.currentUser);
          if (myMember) {
            if (inviteBtn) {
              inviteBtn.classList.remove('hidden');
              inviteBtn.onclick = () => {
                document.getElementById('userProfileModal').classList.add('hidden');
                openInviteMemberModal(groupId, groupData.members.map(m => m.user_id));
              };
            }
          } else {
            if (inviteBtn) inviteBtn.classList.add('hidden');
          }
        }
      } else {
        const membersSection = document.getElementById('upmMembersSection');
        if (membersSection) membersSection.classList.add('hidden');
        const contactSection = document.getElementById('upmContactSection');
        if (contactSection) contactSection.classList.remove('hidden');

        const profileApiBase = window.SDH_DATA?.userProfileApiUrl || '/api/profile/';
        const response = await fetch(`${profileApiBase}${encodeURIComponent(username)}/`);
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || response.statusText);
        }
        data = await response.json();
      }

      // Update avatar display
      if (data.avatar_url) {
        avatarImg.src = data.avatar_url;
        avatarImg.classList.remove('hidden');
        avatarText.classList.add('hidden');
      } else {
        avatarText.textContent = isGroup ? (data.display_name ? data.display_name[0].toUpperCase() : 'G') : username[0].toUpperCase();
        avatarText.classList.remove('hidden');
        avatarImg.classList.add('hidden');
        avatarImg.src = '';
      }

      // Update basic names
      displayNameEl.textContent = data.display_name || (isGroup ? 'Group Chat' : data.username);
      usernameEl.textContent = isGroup ? `Group Chat` : `@${data.username}`;

      // Update bio & sensitive contacts (strictly protected for non-friends)
      const isMe = data.username === (window.SDH_DATA?.currentUser || '');
      const isNotFriend = (!isGroup && !isMe && data.is_friend === false);

      if (isNotFriend) {
        bioEl.textContent = data.bio || '🔒 Private (Friends only)';
        bioEl.classList.add('text-divine-muted');
        bioEl.classList.remove('text-divine-text');
        emailEl.textContent = '🔒 Friends only';
        phoneEl.textContent = '🔒 Friends only';
      } else {
        bioEl.textContent = data.bio ? data.bio : (isGroup ? 'No description provided.' : 'No biography provided.');
        if (!data.bio || data.bio === 'No description provided.') {
          bioEl.classList.add('text-divine-muted');
          bioEl.classList.remove('text-divine-text');
        } else {
          bioEl.classList.remove('text-divine-muted');
          bioEl.classList.add('text-divine-text');
        }
        emailEl.textContent = data.email || 'No email shared';
        phoneEl.textContent = data.phone_number || 'Not specified';
      }

      // Update dates
      joinedEl.textContent = data.date_joined ? `Joined ${data.date_joined}` : 'Joined —';

      // Update online status and dynamic glow
      const statusWrapper = document.getElementById('upmStatusDotWrapper');
      const statusTextContainer = document.getElementById('upmStatusTextContainer');

      let isBlocked = false;
      const userItem = document.getElementById(`user-item-${username}`);
      if (userItem) {
        isBlocked = userItem.dataset.blocked === '1' || userItem.dataset.chatBlocked === '1';
      }

      if (isGroup) {
        if (statusWrapper) statusWrapper.classList.add('hidden');
        if (statusTextContainer) statusTextContainer.classList.add('hidden');
        avatarWrapper.style.borderColor = 'rgba(255,255,255,0.05)';
        avatarWrapper.style.boxShadow = 'none';
      } else {
        if (statusWrapper) statusWrapper.classList.remove('hidden');
        if (statusTextContainer) statusTextContainer.classList.remove('hidden');
        const pill = document.getElementById('upmStatusPill');
        const pillDot = document.getElementById('upmStatusPillDot');

        if (data.is_online && !isBlocked) {
          statusDot.className = 'w-3.5 h-3.5 rounded-full sdh-pulse-dot bg-emerald-500';
          statusText.textContent = 'Active now';
          if (pill) {
            pill.className = 'sdh-profile-status-pill flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25';
          }
          if (pillDot) {
            pillDot.className = 'w-2 h-2 rounded-full bg-emerald-500 sdh-pulse-dot';
          }
          lastSeenEl.textContent = 'Active now';
        } else {
          statusDot.className = 'w-3.5 h-3.5 rounded-full bg-slate-400 dark:bg-slate-500';
          statusText.textContent = isBlocked ? 'Blocked' : 'Offline';
          if (pill) {
            pill.className = 'sdh-profile-status-pill flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider bg-slate-500/10 text-slate-600 dark:text-slate-400 border border-slate-500/20';
          }
          if (pillDot) {
            pillDot.className = 'w-2 h-2 rounded-full bg-slate-400 dark:bg-slate-500';
          }
          if (isBlocked) {
            lastSeenEl.textContent = 'Blocked';
          } else if (data.last_seen) {
            lastSeenEl.textContent = 'Last seen ' + _relativeTime(data.last_seen);
          } else {
            lastSeenEl.textContent = 'Offline';
          }
        }
      }

      // Check if this user is a pending friend request (Instagram-style preview mode)
      const isPendingRequest = Boolean(data.has_pending_request || options.isPendingFriendRequest);
      const reqId = data.request_id || options.requestId;

      const defaultActions = document.getElementById('upmDefaultActions');

      if (isPendingRequest && reqId) {
        // Disable messaging and calling capabilities because they are not confirmed friends yet
        if (messageBtn) messageBtn.classList.add('hidden');
        if (defaultActions) defaultActions.classList.add('hidden');
        if (pendingSection) pendingSection.classList.remove('hidden');
        // Strictly hide media, storage, and starred messages portal during pending requests
        if (navigationSuite) navigationSuite.classList.add('hidden');

        // Sensitive details remain strictly hidden
        emailEl.textContent = '🔒 Hidden until connected';
        phoneEl.textContent = '🔒 Hidden until connected';
        statusDot.className = 'w-3.5 h-3.5 rounded-full bg-purple-400 animate-pulse';
        statusText.textContent = 'Pending Request';
        const pill = document.getElementById('upmStatusPill');
        const pillDot = document.getElementById('upmStatusPillDot');
        if (pill) {
          pill.className = 'sdh-profile-status-pill flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider bg-purple-500/10 text-purple-600 dark:text-purple-300 border border-purple-500/25';
        }
        if (pillDot) {
          pillDot.className = 'w-2 h-2 rounded-full bg-purple-400 animate-pulse';
        }
        lastSeenEl.textContent = 'Sent a request';

        // Wire modal Accept button
        if (upmAcceptBtn) {
          upmAcceptBtn.disabled = false;
          upmAcceptBtn.onclick = async () => {
            upmAcceptBtn.disabled = true;
            if (upmRejectBtn) upmRejectBtn.disabled = true;
            await respondFriendRequest(reqId, 'accept', upmAcceptBtn);

            // Dynamic instant transition to accepted state:
            // 1. Reveal navigation suite portal now that request is accepted!
            if (navigationSuite) navigationSuite.classList.remove('hidden');
            if (pendingSection) pendingSection.classList.add('hidden');
            if (defaultActions) defaultActions.classList.remove('hidden');
            if (messageBtn) {
              messageBtn.classList.remove('hidden');
              messageBtn.onclick = () => {
                modal.classList.add('hidden');
                selectUser(data.username, userId);
              };
            }

            // 2. Restore bio and contact visibility
            bioEl.textContent = data.bio || 'No biography provided.';
            bioEl.classList.remove('text-divine-muted');
            bioEl.classList.add('text-divine-text');
            emailEl.textContent = data.email || 'No email shared';
            phoneEl.textContent = data.phone_number || 'Not specified';
            lastSeenEl.textContent = data.is_online ? 'Active now' : (data.last_seen ? 'Last seen ' + _relativeTime(data.last_seen) : 'Offline');

            if (pill) {
              pill.className = data.is_online
                ? 'sdh-profile-status-pill flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25'
                : 'sdh-profile-status-pill flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider bg-slate-500/10 text-slate-600 dark:text-slate-400 border border-slate-500/20';
            }
            if (pillDot) {
              pillDot.className = data.is_online ? 'w-2 h-2 rounded-full bg-emerald-500 sdh-pulse-dot' : 'w-2 h-2 rounded-full bg-slate-400 dark:bg-slate-500';
            }

            // 3. Load media & starred for the newly confirmed friend
            loadProfileMedia(data.username, null);
            loadStarredMessages(data.username, null);
          };
        }

        // Wire modal Reject button
        if (upmRejectBtn) {
          upmRejectBtn.disabled = false;
          upmRejectBtn.onclick = async () => {
            if (upmAcceptBtn) upmAcceptBtn.disabled = true;
            upmRejectBtn.disabled = true;
            await respondFriendRequest(reqId, 'reject', upmRejectBtn);
            modal.classList.add('hidden');
          };
        }
      } else {
        if (pendingSection) pendingSection.classList.add('hidden');
        if (isNotFriend) {
          if (defaultActions) defaultActions.classList.add('hidden');
          if (messageBtn) messageBtn.classList.add('hidden');
          if (navigationSuite) navigationSuite.classList.add('hidden');
        } else {
          if (defaultActions) defaultActions.classList.remove('hidden');
          if (navigationSuite) navigationSuite.classList.remove('hidden');
          if (messageBtn) {
            messageBtn.classList.remove('hidden');
            messageBtn.onclick = () => {
              modal.classList.add('hidden');
              selectUser(data.username, userId);
            };
          }
        }
      }

      // Populate All Files & Media and Starred Messages only if confirmed friend, group, or self
      if (!isPendingRequest && (!isNotFriend || isGroup || isMe)) {
        const mediaUser = isGroup ? null : username;
        const mediaGroup = isGroup ? (username.startsWith('group_') ? username.replace('group_', '') : null) : null;
        loadProfileMedia(mediaUser, mediaGroup);
        loadStarredMessages(mediaUser, mediaGroup);
      }

    } catch (err) {
      console.error('[Chat] showUserProfile error:', err);
      displayNameEl.textContent = 'Error Loading Profile';
      bioEl.textContent = err.message || 'Could not load profile details.';
      bioEl.classList.add('text-red-400/80');
      showToast(err.message || 'Could not load profile details.', 'error');
    }
  }

  function copyProfileEmail(btn) {
    const emailEl = document.getElementById('upmEmail');
    if (!emailEl) return;
    const text = emailEl.textContent.trim();
    if (!text || text === '—' || text.startsWith('🔒') || text === 'No email shared') return;
    navigator.clipboard.writeText(text).then(() => {
      showToast('Email copied to clipboard', 'info');
      if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = `<svg class="w-3.5 h-3.5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>`;
        setTimeout(() => { btn.innerHTML = orig; }, 1800);
      }
    }).catch(() => {
      showToast('Failed to copy', 'error');
    });
  }

  /** Triggered by clicking the active chat header */
  function showActiveUserProfile() {
    if (!activeUser || !activeUserId) return;
    if (_isSelfChat(activeUser)) {
      window.location.href = '/profile/';
      return;
    }
    showUserProfile(activeUser, activeUserId);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  All Files & Media, Storage Management, and Starred Messages Suite
  // ─────────────────────────────────────────────────────────────────────────────
  let currentMediaCategory = 'visual';
  let currentProfileTarget = { targetUser: null, groupId: null, isGroup: false };
  let profileMediaItems = { visual_assets: [], documents: [], web_links: [], stats: {} };
  let isMediaLoading = false;
  let selectedStorageIds = new Set();
  let starredMessagesData = [];

  function copyLink(url) {
    if (!url) return;
    navigator.clipboard.writeText(url).then(() => {
      showToast('Link copied to clipboard', 'info');
    }).catch(() => {
      showToast('Failed to copy link', 'error');
    });
  }

  function switchMediaTab(category) {
    currentMediaCategory = category;
    const tabVisual = document.getElementById('upmTabVisual');
    const tabDocs = document.getElementById('upmTabDocs');
    const tabLinks = document.getElementById('upmTabLinks');
    const listVisual = document.getElementById('upmVisualAssetsList');
    const listDocs = document.getElementById('upmDocumentsList');
    const listLinks = document.getElementById('upmWebLinksList');

    const tabs = [
      { id: 'visual', btn: tabVisual, el: listVisual },
      { id: 'documents', btn: tabDocs, el: listDocs },
      { id: 'links', btn: tabLinks, el: listLinks },
    ];

    tabs.forEach(t => {
      if (!t.btn || !t.el) return;
      if (t.id === category) {
        t.btn.classList.add('sdh-media-tab-active');
        t.btn.classList.remove('text-divine-muted');
        t.el.classList.remove('hidden');
      } else {
        t.btn.classList.remove('sdh-media-tab-active');
        t.btn.classList.add('text-divine-muted');
        t.el.classList.add('hidden');
      }
    });
  }

  async function loadProfileMedia(targetUser, groupId) {
    currentProfileTarget = {
      targetUser: targetUser || null,
      groupId: groupId || null,
      isGroup: Boolean(groupId),
      displayName: groupId ? (document.getElementById('upmDisplayName')?.textContent || 'Group Chat') : (targetUser || 'User')
    };
    selectedStorageIds.clear();

    const visualList = document.getElementById('upmVisualAssetsList');
    const docsList = document.getElementById('upmDocumentsList');
    const linksList = document.getElementById('upmWebLinksList');
    const totalBadge = document.getElementById('upmMediaTotalCount');
    const visualCountEl = document.getElementById('upmVisualCount');
    const docsCountEl = document.getElementById('upmDocsCount');
    const linksCountEl = document.getElementById('upmLinksCount');
    const storageBadge = document.getElementById('upmStorageBadge');
    const storageText = document.getElementById('upmStorageUsedText');
    const visualProg = document.getElementById('upmVisualProgress');
    const docsProg = document.getElementById('upmDocsProgress');
    const selectAllCb = document.getElementById('upmSelectAllCheckbox');
    const selectedCountEl = document.getElementById('upmSelectedCount');
    const downloadBtn = document.getElementById('upmBatchDownloadBtn');
    const deleteBtn = document.getElementById('upmBatchDeleteBtn');

    if (selectAllCb) selectAllCb.checked = false;
    if (selectedCountEl) selectedCountEl.textContent = '(0 selected)';
    if (downloadBtn) downloadBtn.disabled = true;
    if (deleteBtn) deleteBtn.disabled = true;

    if (visualList) visualList.innerHTML = '<div class="col-span-3 py-6 text-center text-xs text-divine-muted animate-pulse">Loading visual assets...</div>';
    if (docsList) docsList.innerHTML = '';
    if (linksList) linksList.innerHTML = '';

    try {
      isMediaLoading = true;
      let url = (window.SDH_DATA?.chatMediaUrl || '/messaging/api/chat-media/') + '?';
      if (groupId) {
        url += `group_id=${encodeURIComponent(groupId)}`;
      } else if (targetUser) {
        url += `target_user=${encodeURIComponent(targetUser)}`;
      }

      const res = await fetch(url);
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();

      // ── Process Web Links (including E2EE-encrypted candidates & active messages) ──
      const urlRegex = /(?:https?:\/\/|www\.)[^\s<>"']+|[a-zA-Z0-9][-a-zA-Z0-9]*\.(?:com|org|net|edu|gov|io|co|in|ai|me|app|dev|link|info)(?:\/[^\s<>"']*)?/gi;
      data.web_links = data.web_links || [];
      const seenUrls = new Set(data.web_links.map(item => item.url));

      if (Array.isArray(data.encrypted_candidates) && data.encrypted_candidates.length > 0 && window.SDH?.E2E) {
        for (const cand of data.encrypted_candidates) {
          try {
            let plaintext = '';
            if (cand.is_group && cand.group_id) {
              plaintext = await window.SDH.E2E.decryptGroupMessage(cand.ciphertext, cand.encryption_iv, cand.group_id);
            } else {
              // In 1-on-1 direct chat, shared secret is derived with the chat partner (targetUser).
              const peer = targetUser || (cand.is_from_me ? (cand.receiver || cand.sender) : (cand.sender || cand.receiver));
              plaintext = await window.SDH.E2E.decrypt(cand.ciphertext, cand.encryption_iv, peer);
              // Fallback retry with cand.sender if different
              if ((!plaintext || plaintext.startsWith('🔒')) && cand.sender && cand.sender !== peer) {
                plaintext = await window.SDH.E2E.decrypt(cand.ciphertext, cand.encryption_iv, cand.sender);
              }
              // Fallback retry with cand.receiver if different
              if ((!plaintext || plaintext.startsWith('🔒')) && cand.receiver && cand.receiver !== peer) {
                plaintext = await window.SDH.E2E.decrypt(cand.ciphertext, cand.encryption_iv, cand.receiver);
              }
            }

            // Also check if ciphertext itself is already plaintext containing a URL (e.g. unencrypted fallback)
            let textToScan = plaintext && !plaintext.startsWith('🔒') ? plaintext : '';
            if (!textToScan && cand.ciphertext && (cand.ciphertext.includes('http://') || cand.ciphertext.includes('https://') || cand.ciphertext.includes('www.'))) {
              textToScan = cand.ciphertext;
            }

            if (textToScan) {
              const matches = textToScan.match(urlRegex);
              if (matches) {
                for (let rawUrl of matches) {
                  const cleanedUrl = rawUrl.replace(/[.,!?:;)"']+$/, '');
                  if (!cleanedUrl) continue;
                  const normUrl = cleanedUrl.startsWith('http://') || cleanedUrl.startsWith('https://')
                    ? cleanedUrl
                    : `https://${cleanedUrl}`;
                  if (!seenUrls.has(normUrl)) {
                    seenUrls.add(normUrl);
                    let domain = normUrl;
                    try {
                      domain = new URL(normUrl).hostname || normUrl;
                    } catch (_) {}
                    data.web_links.push({
                      id: cand.id,
                      message_id: cand.message_id,
                      is_group: cand.is_group,
                      group_id: cand.group_id,
                      url: normUrl,
                      display_url: cleanedUrl,
                      domain: domain,
                      snippet: textToScan.slice(0, 140),
                      timestamp: cand.timestamp,
                      sender: cand.sender,
                      is_from_me: cand.is_from_me,
                    });
                  }
                }
              }
            }
          } catch (decErr) {
            console.warn('[Chat] Failed to decrypt candidate message for links:', decErr);
          }
        }
      }

      // Also merge any links from currently active chat messages in DOM if viewing active chat
      const isCurrentChat = (groupId && activeUser === `group_${groupId}`) ||
                            (!groupId && targetUser && activeUser && targetUser.toLowerCase() === activeUser.toLowerCase());
      if (isCurrentChat) {
        const msgItems = document.querySelectorAll('#messagesContainer [data-message-id], #messagesContainer [id^="msg-"], #messagesContainer .group\\/msg');
        msgItems.forEach(el => {
          const msgId = el.dataset.messageId || el.id?.replace('msg-', '');
          const pEl = el.querySelector('.msg-bubble p');
          const aTags = el.querySelectorAll('.msg-bubble a');
          const isMine = el.classList.contains('justify-end') || Boolean(el.querySelector('.msg-status-tick'));
          let msgSender = targetUser || 'User';
          if (isMine) {
            msgSender = window.SDH_DATA?.currentUser || 'You';
          } else {
            const senderP = el.querySelector('p.text-\\[11px\\].font-semibold') || el.querySelector('p.text-\\[11px\\]');
            if (senderP && senderP.textContent) {
              msgSender = senderP.textContent.trim();
            }
          }

          // Check direct <a> tags first
          aTags.forEach(a => {
            const rawHref = a.getAttribute('href') || a.href;
            if (rawHref) {
              const cleanedUrl = rawHref.replace(/[.,!?:;)"']+$/, '');
              if (!cleanedUrl) return;
              const normUrl = cleanedUrl.startsWith('http://') || cleanedUrl.startsWith('https://')
                ? cleanedUrl
                : `https://${cleanedUrl}`;
              if (!seenUrls.has(normUrl)) {
                seenUrls.add(normUrl);
                let domain = normUrl;
                try {
                  domain = new URL(normUrl).hostname || normUrl;
                } catch (_) {}
                data.web_links.push({
                  id: msgId || Date.now(),
                  message_id: msgId || Date.now(),
                  is_group: Boolean(groupId),
                  group_id: groupId || null,
                  url: normUrl,
                  display_url: cleanedUrl,
                  domain: domain,
                  snippet: (pEl?.textContent || cleanedUrl).slice(0, 140),
                  timestamp: new Date().toISOString(),
                  sender: msgSender,
                  is_from_me: Boolean(isMine),
                });
              }
            }
          });

          // Also check text content for urls
          if (pEl) {
            const text = pEl.textContent || '';
            const matches = text.match(urlRegex);
            if (matches) {
              for (let rawUrl of matches) {
                const cleanedUrl = rawUrl.replace(/[.,!?:;)"']+$/, '');
                if (!cleanedUrl) continue;
                const normUrl = cleanedUrl.startsWith('http://') || cleanedUrl.startsWith('https://')
                  ? cleanedUrl
                  : `https://${cleanedUrl}`;
                if (!seenUrls.has(normUrl)) {
                  seenUrls.add(normUrl);
                  let domain = normUrl;
                  try {
                    domain = new URL(normUrl).hostname || normUrl;
                  } catch (_) {}
                  data.web_links.push({
                    id: msgId || Date.now(),
                    message_id: msgId || Date.now(),
                    is_group: Boolean(groupId),
                    group_id: groupId || null,
                    url: normUrl,
                    display_url: cleanedUrl,
                    domain: domain,
                    snippet: text.slice(0, 140),
                    timestamp: new Date().toISOString(),
                    sender: msgSender,
                    is_from_me: Boolean(isMine),
                  });
                }
              }
            }
          }
        });
      }

      // Sort web links newest first
      data.web_links.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      // Recalculate stats
      data.stats = data.stats || {};
      data.stats.web_link_count = data.web_links.length;
      data.stats.total_count = (data.stats.visual_count || 0) + (data.stats.document_count || 0) + data.stats.web_link_count;

      profileMediaItems = data;

      const stats = data.stats || {};
      if (totalBadge) totalBadge.textContent = `${stats.total_count || 0} item${stats.total_count === 1 ? '' : 's'}`;
      if (visualCountEl) visualCountEl.textContent = `(${stats.visual_count || 0})`;
      if (docsCountEl) docsCountEl.textContent = `(${stats.document_count || 0})`;
      if (linksCountEl) linksCountEl.textContent = `(${stats.web_link_count || 0})`;

      if (storageBadge) storageBadge.textContent = stats.total_formatted || '0 B';
      if (storageText) {
        storageText.textContent = `${stats.total_formatted || '0 B'} footprint • ${stats.visual_formatted || '0 B'} Visual • ${stats.document_formatted || '0 B'} Docs`;
      }

      // ── Update Profile Navigation Badges ──
      const navMediaBadge = document.getElementById('upmMediaNavBadge');
      const navStorageBadge = document.getElementById('upmStorageNavBadge');
      const navStorageSubtitle = document.getElementById('upmStorageNavSubtitle');
      if (navMediaBadge) navMediaBadge.textContent = String(stats.total_count || 0);
      if (navStorageBadge) navStorageBadge.textContent = stats.total_formatted || '0 B';
      if (navStorageSubtitle) {
        navStorageSubtitle.textContent = `${stats.total_formatted || '0 B'} footprint • data controls`;
      }

      const totalB = stats.total_bytes || 0;
      const vPct = totalB > 0 ? Math.round(((stats.visual_bytes || 0) / totalB) * 100) : 0;
      const dPct = totalB > 0 ? Math.round(((stats.document_bytes || 0) / totalB) * 100) : 0;
      if (visualProg) visualProg.style.width = `${vPct}%`;
      if (docsProg) docsProg.style.width = `${dPct}%`;

      // Render Visual Assets (Modal fallback if elements exist)
      if (visualList) {
        if (!data.visual_assets || data.visual_assets.length === 0) {
          visualList.innerHTML = '<div class="col-span-3 py-6 text-center text-xs text-divine-muted/60">No photos or videos shared yet</div>';
        } else {
          visualList.innerHTML = data.visual_assets.map(item => `
            <div class="sdh-media-item-card relative group rounded-xl overflow-hidden bg-black/20 border border-white/[0.08] hover:border-indigo-500/40 transition-all" data-media-id="${item.message_id}">
              <div class="absolute top-1.5 left-1.5 z-10">
                <input type="checkbox" onchange="SDH.Chat.toggleMediaItemSelection(${item.message_id}, this.checked)"
                       class="sdh-storage-item-cb rounded border-white/30 text-indigo-600 focus:ring-indigo-500/30 bg-black/60 w-3.5 h-3.5 cursor-pointer backdrop-blur-sm"
                       data-id="${item.message_id}" data-url="${escapeHtml(item.file_url)}" data-filename="${escapeHtml(item.filename)}" />
              </div>
              ${item.message_type === 'video' ? `
                <div class="w-full h-20 bg-slate-900/80 flex items-center justify-center cursor-pointer relative group-hover:scale-105 transition-transform duration-300"
                     onclick="SDH.MediaViewer?.open({fileId:${item.message_id},fileName:'${escapeHtml(item.filename)}',mimeType:'${escapeHtml(item.mime_type)}',messageType:'video'})">
                  <div class="w-7 h-7 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center text-white shadow-lg">
                    <svg class="w-3.5 h-3.5 fill-current ml-0.5" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                  </div>
                  <span class="absolute bottom-1 right-1 px-1 py-0.5 rounded text-[8px] font-bold bg-black/75 text-white/90 backdrop-blur-sm">${item.size_formatted}</span>
                </div>
              ` : `
                <div class="w-full h-20 bg-slate-900/40 relative cursor-pointer overflow-hidden"
                     onclick="SDH.MediaViewer?.open({fileId:${item.message_id},fileName:'${escapeHtml(item.filename)}',mimeType:'${escapeHtml(item.mime_type)}',messageType:'image'})">
                  <img src="${item.file_url}" alt="${escapeHtml(item.filename)}" loading="lazy" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                  <span class="absolute bottom-1 right-1 px-1 py-0.5 rounded text-[8px] font-bold bg-black/75 text-white/90 backdrop-blur-sm">${item.size_formatted}</span>
                </div>
              `}
              <div class="p-1 text-[9px] text-divine-muted truncate font-medium bg-black/40 border-t border-white/[0.04]" title="${escapeHtml(item.filename)}">
                ${escapeHtml(item.filename)}
              </div>
            </div>
          `).join('');
        }
      }

      // Render Documents (Modal fallback)
      if (docsList) {
        if (!data.documents || data.documents.length === 0) {
          docsList.innerHTML = '<div class="py-6 text-center text-xs text-divine-muted/60">No documents shared yet</div>';
        } else {
          docsList.innerHTML = data.documents.map(item => `
            <div class="sdh-media-item-card flex items-center justify-between p-2 rounded-xl bg-black/20 hover:bg-white/[0.04] border border-white/[0.08] transition-all gap-2" data-media-id="${item.message_id}">
              <div class="flex items-center gap-2.5 min-w-0 flex-1">
                <input type="checkbox" onchange="SDH.Chat.toggleMediaItemSelection(${item.message_id}, this.checked)"
                       class="sdh-storage-item-cb rounded border-white/30 text-indigo-600 focus:ring-indigo-500/30 bg-black/60 w-3.5 h-3.5 cursor-pointer flex-shrink-0"
                       data-id="${item.message_id}" data-url="${escapeHtml(item.file_url)}" data-filename="${escapeHtml(item.filename)}" />
                <div class="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 flex items-center justify-center flex-shrink-0 font-bold text-[9px] tracking-wider uppercase">
                  ${escapeHtml(item.extension || 'DOC')}
                </div>
                <div class="min-w-0 flex-1">
                  <p class="text-xs font-medium text-divine-text truncate" title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</p>
                  <p class="text-[10px] text-divine-muted">${item.size_formatted} • ${new Date(item.timestamp).toLocaleDateString()}</p>
                </div>
              </div>
              <a href="${item.file_url}" download="${escapeHtml(item.filename)}" onclick="event.stopPropagation()"
                 class="p-1.5 rounded-lg text-divine-muted hover:text-divine-text hover:bg-white/10 transition-colors flex-shrink-0" title="Download Document">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                </svg>
              </a>
            </div>
          `).join('');
        }
      }

      // Render Web Links (Modal fallback)
      if (linksList) {
        if (!data.web_links || data.web_links.length === 0) {
          linksList.innerHTML = '<div class="py-6 text-center text-xs text-divine-muted/60">No web links shared yet</div>';
        } else {
          linksList.innerHTML = data.web_links.map(item => `
            <div class="sdh-media-item-card flex items-start justify-between p-2.5 rounded-xl bg-black/20 hover:bg-white/[0.04] border border-white/[0.08] transition-all gap-2">
              <div class="flex items-start gap-2.5 min-w-0 flex-1">
                <div class="w-7 h-7 rounded-lg bg-blue-500/15 dark:bg-sky-500/15 border border-blue-500/25 dark:border-sky-500/25 text-blue-600 dark:text-sky-400 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/>
                  </svg>
                </div>
                <div class="min-w-0 flex-1">
                  <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer"
                     class="text-xs font-semibold text-blue-600 dark:text-sky-400 hover:text-blue-700 dark:hover:text-sky-300 hover:underline inline-flex items-center gap-1 max-w-full truncate">
                    <span class="truncate">${escapeHtml(item.display_url)}</span>
                    <svg class="w-3 h-3 flex-shrink-0 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
                    </svg>
                  </a>
                  ${item.snippet ? `<p class="text-[10px] text-divine-muted/80 line-clamp-1 mt-0.5">${escapeHtml(item.snippet)}</p>` : ''}
                  <p class="text-[9px] text-divine-muted/60 mt-0.5">${escapeHtml(item.sender)} • ${new Date(item.timestamp).toLocaleDateString()}</p>
                </div>
              </div>
              <button type="button" onclick="SDH.Chat.copyLink(this.dataset.url)" data-url="${escapeHtml(item.url)}"
                      class="p-1 rounded-lg text-divine-muted hover:text-divine-text hover:bg-white/10 transition-colors flex-shrink-0" title="Copy Link">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"/>
                </svg>
              </button>
            </div>
          `).join('');
        }
      }

      // If dedicated workspace is open, refresh active workspace view
      const dwsModal = document.getElementById('dedicatedWorkspaceModal');
      if (dwsModal && !dwsModal.classList.contains('hidden')) {
        loadDedicatedMedia();
        loadDedicatedStorage();
      }

    } catch (err) {
      console.error('[Chat] loadProfileMedia error:', err);
      if (visualList) visualList.innerHTML = '<div class="col-span-3 py-6 text-center text-xs text-red-400/80">Could not load files</div>';
    } finally {
      isMediaLoading = false;
    }
  }

  function toggleSelectAllStorage(isChecked) {
    const checkboxes = document.querySelectorAll('.sdh-storage-item-cb');
    selectedStorageIds.clear();
    checkboxes.forEach(cb => {
      cb.checked = isChecked;
      const id = parseInt(cb.dataset.id, 10);
      if (isChecked && id) {
        selectedStorageIds.add(id);
      }
      const card = cb.closest('.sdh-media-item-card');
      if (card) {
        card.classList.toggle('is-selected', isChecked);
      }
    });
    _updateStorageSelectionUI();
  }

  function toggleMediaItemSelection(messageId, isChecked) {
    const id = parseInt(messageId, 10);
    if (!id) return;
    if (isChecked) {
      selectedStorageIds.add(id);
    } else {
      selectedStorageIds.delete(id);
    }

    const cb = document.querySelector(`.sdh-storage-item-cb[data-id="${id}"]`);
    if (cb) {
      cb.checked = isChecked;
      const card = cb.closest('.sdh-media-item-card');
      if (card) card.classList.toggle('is-selected', isChecked);
    }

    const allCbs = document.querySelectorAll('.sdh-storage-item-cb');
    const selectAllCb = document.getElementById('upmSelectAllCheckbox');
    if (selectAllCb && allCbs.length > 0) {
      selectAllCb.checked = (selectedStorageIds.size === allCbs.length);
    }
    _updateStorageSelectionUI();
  }

  function _updateStorageSelectionUI() {
    const count = selectedStorageIds.size;
    const countEl = document.getElementById('upmSelectedCount');
    if (countEl) countEl.textContent = `(${count} selected)`;
    const downloadBtn = document.getElementById('upmBatchDownloadBtn');
    if (downloadBtn) downloadBtn.disabled = (count === 0);
    const deleteBtn = document.getElementById('upmBatchDeleteBtn');
    if (deleteBtn) deleteBtn.disabled = (count === 0);
  }

  async function downloadSelectedStorage() {
    if (selectedStorageIds.size === 0) return;
    const itemsToDownload = [];
    selectedStorageIds.forEach(id => {
      const cb = document.querySelector(`.sdh-storage-item-cb[data-id="${id}"]`);
      if (cb && cb.dataset.url) {
        itemsToDownload.push({ url: cb.dataset.url, filename: cb.dataset.filename || `file_${id}` });
      }
    });

    if (itemsToDownload.length === 0) return;
    showToast(`Downloading ${itemsToDownload.length} file(s)...`, 'info');

    itemsToDownload.forEach((item, index) => {
      setTimeout(() => {
        const link = document.createElement('a');
        link.href = item.url;
        link.download = item.filename;
        link.target = '_blank';
        document.body.appendChild(link);
        link.click();
        link.remove();
      }, index * 250);
    });
  }

  async function deleteSelectedStorage() {
    const count = selectedStorageIds.size;
    if (count === 0) return;

    const confirmed = confirm(`Are you sure you want to delete ${count} selected item${count > 1 ? 's' : ''}? This will permanently remove them from storage and chat.`);
    if (!confirmed) return;

    const deleteBtn = document.getElementById('upmBatchDeleteBtn');
    if (deleteBtn) {
      deleteBtn.disabled = true;
      deleteBtn.innerHTML = '<span class="animate-pulse">Deleting...</span>';
    }

    const csrf = window.SDH_DATA?.csrfToken || document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
    const endpoint = window.SDH_DATA?.batchStorageDeleteUrl || '/messaging/api/storage/batch-delete/';

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': csrf,
        },
        body: JSON.stringify({
          message_ids: Array.from(selectedStorageIds),
          is_group: currentProfileTarget.isGroup,
          removal_scope: 'all'
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || res.statusText);
      }

      const data = await res.json();
      showToast(`Successfully deleted ${data.deleted_count || count} item(s) (${data.freed_formatted || 'freed'}).`, 'success');

      selectedStorageIds.forEach(id => {
        handleMessageRemoved({
          message_id: id,
          removal_scope: 'all',
          removed_by: window.SDH_DATA?.currentUser,
        });
      });

      selectedStorageIds.clear();
      await loadProfileMedia(currentProfileTarget.targetUser, currentProfileTarget.groupId);

    } catch (err) {
      console.error('[Chat] deleteSelectedStorage error:', err);
      showToast('Deletion failed: ' + err.message, 'error');
    } finally {
      if (deleteBtn) {
        deleteBtn.innerHTML = `
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
          </svg>
          <span>Delete</span>`;
        _updateStorageSelectionUI();
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  Dedicated Workspaces: Media, Storage, and Starred Messages
  // ─────────────────────────────────────────────────────────────────────────────
  let currentDedicatedMediaCategory = 'visual';
  let dedicatedStorageSelectedIds = new Set();

  function openDedicatedMediaWorkspace() {
    const profileModal = document.getElementById('userProfileModal');
    if (profileModal) profileModal.classList.add('hidden');

    const dwsModal = document.getElementById('dedicatedWorkspaceModal');
    if (!dwsModal) return;
    dwsModal.classList.remove('hidden');

    switchWorkspaceView('media');
    loadDedicatedMedia();

    // If media items are empty and we have a target user or group, trigger fresh load
    const effectiveTargetUser = currentProfileTarget.targetUser || (activeUser && !activeUser.startsWith('group_') ? activeUser : null);
    const effectiveGroupId = currentProfileTarget.groupId || (activeUser && activeUser.startsWith('group_') ? activeUser.replace('group_', '') : null);

    if ((!profileMediaItems || !profileMediaItems.stats || profileMediaItems.stats.total_count === 0) &&
        (effectiveTargetUser || effectiveGroupId)) {
      loadProfileMedia(effectiveTargetUser, effectiveGroupId);
    }
  }

  function openDedicatedStorageWorkspace() {
    const profileModal = document.getElementById('userProfileModal');
    if (profileModal) profileModal.classList.add('hidden');

    const dwsModal = document.getElementById('dedicatedWorkspaceModal');
    if (!dwsModal) return;
    dwsModal.classList.remove('hidden');

    switchWorkspaceView('storage');
    loadDedicatedStorage();
  }

  function openDedicatedStarredWorkspace() {
    const profileModal = document.getElementById('userProfileModal');
    if (profileModal) profileModal.classList.add('hidden');

    const dwsModal = document.getElementById('dedicatedWorkspaceModal');
    if (!dwsModal) return;
    dwsModal.classList.remove('hidden');

    switchWorkspaceView('starred');
    loadDedicatedStarred();
  }

  function backToProfileModal() {
    const dwsModal = document.getElementById('dedicatedWorkspaceModal');
    if (dwsModal) dwsModal.classList.add('hidden');

    const profileModal = document.getElementById('userProfileModal');
    if (profileModal) profileModal.classList.remove('hidden');
  }

  function closeDedicatedWorkspace() {
    const dwsModal = document.getElementById('dedicatedWorkspaceModal');
    if (dwsModal) dwsModal.classList.add('hidden');
  }

  function _updateWorkspaceHeader(title) {
    const titleEl = document.getElementById('dwsHeaderTitle');
    const subEl = document.getElementById('dwsHeaderSubtitle');
    if (titleEl) titleEl.textContent = title;
    if (subEl) {
      if (currentProfileTarget.isGroup) {
        subEl.textContent = currentProfileTarget.displayName || 'Group Chat';
      } else {
        subEl.textContent = currentProfileTarget.targetUser ? `@${currentProfileTarget.targetUser}` : 'Active Chat';
      }
    }
  }

  function switchWorkspaceView(view) {
    const mediaView = document.getElementById('dwsMediaView');
    const storageView = document.getElementById('dwsStorageView');
    const starredView = document.getElementById('dwsStarredView');

    const tabMedia = document.getElementById('dwsQuickTabMedia');
    const tabStorage = document.getElementById('dwsQuickTabStorage');
    const tabStarred = document.getElementById('dwsQuickTabStarred');

    const views = [
      { id: 'media', title: 'All Files & Media', el: mediaView, tab: tabMedia, load: loadDedicatedMedia },
      { id: 'storage', title: 'Storage Management', el: storageView, tab: tabStorage, load: loadDedicatedStorage },
      { id: 'starred', title: 'Starred Messages', el: starredView, tab: tabStarred, load: loadDedicatedStarred },
    ];

    views.forEach(v => {
      if (v.id === view) {
        if (v.el) v.el.classList.remove('hidden');
        if (v.tab) {
          v.tab.className = 'px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all bg-white/[0.12] text-divine-text shadow-sm';
        }
        _updateWorkspaceHeader(v.title);
        if (typeof v.load === 'function') v.load();
      } else {
        if (v.el) v.el.classList.add('hidden');
        if (v.tab) {
          v.tab.className = 'px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all text-divine-muted hover:text-divine-text';
        }
      }
    });
  }

  // ── Dedicated Media View Controllers ──
  function switchDedicatedMediaTab(category) {
    currentDedicatedMediaCategory = category;
    const tabVisual = document.getElementById('dwsTabVisual');
    const tabDocs = document.getElementById('dwsTabDocs');
    const tabLinks = document.getElementById('dwsTabLinks');

    const listVisual = document.getElementById('dwsVisualAssetsList');
    const listDocs = document.getElementById('dwsDocumentsList');
    const listLinks = document.getElementById('dwsWebLinksList');

    const tabs = [
      { id: 'visual', btn: tabVisual, el: listVisual },
      { id: 'documents', btn: tabDocs, el: listDocs },
      { id: 'links', btn: tabLinks, el: listLinks },
    ];

    tabs.forEach(t => {
      if (!t.btn || !t.el) return;
      if (t.id === category) {
        t.btn.classList.add('sdh-media-tab-active');
        t.btn.classList.remove('text-divine-muted');
        t.el.classList.remove('hidden');
      } else {
        t.btn.classList.remove('sdh-media-tab-active');
        t.btn.classList.add('text-divine-muted');
        t.el.classList.add('hidden');
      }
    });

    const searchInput = document.getElementById('dwsMediaSearch');
    if (searchInput) {
      searchInput.value = '';
      filterDedicatedMedia('');
    }
  }

  function loadDedicatedMedia() {
    const stats = profileMediaItems.stats || {};
    const visualCount = document.getElementById('dwsVisualCount');
    const docsCount = document.getElementById('dwsDocsCount');
    const linksCount = document.getElementById('dwsLinksCount');

    if (visualCount) visualCount.textContent = `(${stats.visual_count || 0})`;
    if (docsCount) docsCount.textContent = `(${stats.document_count || 0})`;
    if (linksCount) linksCount.textContent = `(${stats.web_link_count || 0})`;

    const visualList = document.getElementById('dwsVisualAssetsList');
    const docsList = document.getElementById('dwsDocumentsList');
    const linksList = document.getElementById('dwsWebLinksList');

    // Populate Visual Assets Grid
    if (visualList) {
      if (!profileMediaItems.visual_assets || profileMediaItems.visual_assets.length === 0) {
        visualList.innerHTML = '<div class="col-span-full py-16 text-center text-xs text-divine-muted/60">No photos or videos shared yet</div>';
      } else {
        visualList.innerHTML = profileMediaItems.visual_assets.map(item => `
          <div class="sdh-media-item-card dws-media-item relative group rounded-2xl overflow-hidden bg-black/30 border border-white/[0.08] hover:border-indigo-500/50 transition-all cursor-pointer shadow-md"
               data-filename="${escapeHtml(item.filename.toLowerCase())}">
            ${item.message_type === 'video' ? `
              <div class="w-full h-28 bg-slate-900/90 flex items-center justify-center relative group-hover:scale-105 transition-transform duration-300"
                   onclick="SDH.MediaViewer?.open({fileId:${item.message_id},fileName:'${escapeHtml(item.filename)}',mimeType:'${escapeHtml(item.mime_type)}',messageType:'video'})">
                <div class="w-9 h-9 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center text-white shadow-xl">
                  <svg class="w-4 h-4 fill-current ml-0.5" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                </div>
                <span class="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded-md text-[9px] font-bold bg-black/80 text-white backdrop-blur-sm">${item.size_formatted}</span>
              </div>
            ` : `
              <div class="w-full h-28 bg-slate-900/50 relative overflow-hidden"
                   onclick="SDH.MediaViewer?.open({fileId:${item.message_id},fileName:'${escapeHtml(item.filename)}',mimeType:'${escapeHtml(item.mime_type)}',messageType:'image'})">
                <img src="${item.file_url}" alt="${escapeHtml(item.filename)}" loading="lazy" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                <span class="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded-md text-[9px] font-bold bg-black/80 text-white backdrop-blur-sm">${item.size_formatted}</span>
              </div>
            `}
            <div class="p-2 text-[10px] text-divine-muted truncate font-medium bg-black/50 border-t border-white/[0.05]" title="${escapeHtml(item.filename)}">
              ${escapeHtml(item.filename)}
            </div>
          </div>
        `).join('');
      }
    }

    // Populate Documents List
    if (docsList) {
      if (!profileMediaItems.documents || profileMediaItems.documents.length === 0) {
        docsList.innerHTML = '<div class="py-16 text-center text-xs text-divine-muted/60">No documents shared yet</div>';
      } else {
        docsList.innerHTML = profileMediaItems.documents.map(item => `
          <div class="sdh-media-item-card dws-media-item flex items-center justify-between p-3 rounded-2xl bg-black/30 hover:bg-white/[0.05] border border-white/[0.08] transition-all gap-3"
               data-filename="${escapeHtml(item.filename.toLowerCase())}">
            <div class="flex items-center gap-3 min-w-0 flex-1">
              <div class="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 flex items-center justify-center flex-shrink-0 font-bold text-xs tracking-wider uppercase">
                ${escapeHtml(item.extension || 'DOC')}
              </div>
              <div class="min-w-0 flex-1">
                <p class="text-xs font-semibold text-divine-text truncate" title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</p>
                <p class="text-[11px] text-divine-muted mt-0.5">${item.size_formatted} • ${new Date(item.timestamp).toLocaleDateString()}</p>
              </div>
            </div>
            <a href="${item.file_url}" download="${escapeHtml(item.filename)}" onclick="event.stopPropagation()"
               class="p-2 rounded-xl text-divine-muted hover:text-divine-text hover:bg-white/10 transition-all flex-shrink-0" title="Download Document">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
              </svg>
            </a>
          </div>
        `).join('');
      }
    }

    // Populate Web Links List
    if (linksList) {
      if (isMediaLoading && (!profileMediaItems.web_links || profileMediaItems.web_links.length === 0)) {
        linksList.innerHTML = '<div class="py-16 text-center text-xs text-divine-muted/70 animate-pulse">Scanning and loading web links...</div>';
      } else if (!profileMediaItems.web_links || profileMediaItems.web_links.length === 0) {
        linksList.innerHTML = '<div class="py-16 text-center text-xs text-divine-muted/60">No web links shared yet</div>';
      } else {
        linksList.innerHTML = profileMediaItems.web_links.map(item => `
          <div class="sdh-media-item-card dws-media-item flex items-start justify-between p-3 rounded-2xl bg-black/30 hover:bg-white/[0.05] border border-white/[0.08] transition-all gap-3"
               data-filename="${escapeHtml((item.url + ' ' + (item.snippet || '')).toLowerCase())}">
            <div class="flex items-start gap-3 min-w-0 flex-1">
              <div class="w-9 h-9 rounded-xl bg-blue-500/15 dark:bg-sky-500/15 border border-blue-500/25 dark:border-sky-500/25 text-blue-600 dark:text-sky-400 flex items-center justify-center flex-shrink-0 mt-0.5">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/>
                </svg>
              </div>
              <div class="min-w-0 flex-1">
                <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer"
                   class="text-xs font-bold text-blue-600 dark:text-sky-400 hover:text-blue-700 dark:hover:text-sky-300 hover:underline inline-flex items-center gap-1 max-w-full truncate">
                  <span class="truncate">${escapeHtml(item.display_url)}</span>
                  <svg class="w-3.5 h-3.5 flex-shrink-0 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
                  </svg>
                </a>
                ${item.snippet ? `<p class="text-[11px] text-divine-muted/90 line-clamp-1 mt-0.5">${escapeHtml(item.snippet)}</p>` : ''}
                <p class="text-[10px] text-divine-muted/60 mt-0.5">${escapeHtml(item.sender)} • ${new Date(item.timestamp).toLocaleDateString()}</p>
              </div>
            </div>
            <button type="button" onclick="SDH.Chat.copyLink(this.dataset.url)" data-url="${escapeHtml(item.url)}"
                    class="p-2 rounded-xl text-divine-muted hover:text-divine-text hover:bg-white/10 transition-colors flex-shrink-0" title="Copy Link">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"/>
              </svg>
            </button>
          </div>
        `).join('');
      }
    }

    switchDedicatedMediaTab(currentDedicatedMediaCategory || 'visual');
  }

  function clearDedicatedMediaSearch() {
    const searchInput = document.getElementById('dwsMediaSearch');
    if (searchInput) {
      searchInput.value = '';
      searchInput.focus();
    }
    filterDedicatedMedia('');
  }

  function filterDedicatedMedia(query) {
    const q = (query || '').toLowerCase().trim();
    const clearBtn = document.getElementById('dwsMediaClearBtn');
    if (clearBtn) clearBtn.classList.toggle('hidden', !q);

    let currentContainer = null;
    if (currentDedicatedMediaCategory === 'visual') {
      currentContainer = document.getElementById('dwsVisualAssetsList');
    } else if (currentDedicatedMediaCategory === 'documents') {
      currentContainer = document.getElementById('dwsDocumentsList');
    } else {
      currentContainer = document.getElementById('dwsWebLinksList');
    }

    if (!currentContainer) return;
    const items = currentContainer.querySelectorAll('.dws-media-item');
    let visibleCount = 0;
    items.forEach(el => {
      const match = !q || (el.dataset.filename && el.dataset.filename.includes(q));
      el.style.display = match ? '' : 'none';
      if (match) visibleCount++;
    });

    const emptyEl = document.getElementById('dwsMediaEmpty');
    if (emptyEl) {
      emptyEl.classList.toggle('hidden', visibleCount > 0 || items.length === 0);
    }
  }

  // ── Dedicated Storage View Controllers ──
  function loadDedicatedStorage() {
    dedicatedStorageSelectedIds.clear();
    const stats = profileMediaItems.stats || {};

    const badge = document.getElementById('dwsStorageBadge');
    const usedText = document.getElementById('dwsStorageUsedText');
    const vProg = document.getElementById('dwsVisualProgress');
    const dProg = document.getElementById('dwsDocsProgress');
    const vText = document.getElementById('dwsVisualFootprintText');
    const dText = document.getElementById('dwsDocsFootprintText');

    if (badge) badge.textContent = stats.total_formatted || '0 B';
    if (usedText) {
      usedText.textContent = `${stats.total_formatted || '0 B'} footprint across conversations`;
    }
    if (vText) vText.textContent = `Visual Assets: ${stats.visual_formatted || '0 B'}`;
    if (dText) dText.textContent = `Documents: ${stats.document_formatted || '0 B'}`;

    const totalB = stats.total_bytes || 0;
    const vPct = totalB > 0 ? Math.round(((stats.visual_bytes || 0) / totalB) * 100) : 0;
    const dPct = totalB > 0 ? Math.round(((stats.document_bytes || 0) / totalB) * 100) : 0;
    if (vProg) vProg.style.width = `${vPct}%`;
    if (dProg) dProg.style.width = `${dPct}%`;

    const allFiles = [
      ...(profileMediaItems.visual_assets || []).map(x => ({ ...x, category: 'Visual' })),
      ...(profileMediaItems.documents || []).map(x => ({ ...x, category: 'Document' }))
    ];

    const list = document.getElementById('dwsStorageItemList');
    const emptyEl = document.getElementById('dwsStorageEmpty');
    const selectAllCb = document.getElementById('dwsSelectAllCheckbox');
    if (selectAllCb) selectAllCb.checked = false;
    _updateDedicatedStorageSelectionUI();

    if (!allFiles.length) {
      if (list) list.innerHTML = '';
      if (emptyEl) emptyEl.classList.remove('hidden');
      return;
    }

    if (emptyEl) emptyEl.classList.add('hidden');
    if (list) {
      list.innerHTML = allFiles.map(item => `
        <div class="sdh-storage-row flex items-center justify-between p-3 rounded-2xl bg-black/25 hover:bg-white/[0.05] border border-white/[0.08] transition-all gap-3 cursor-pointer group"
             id="dwsStorageRow-${item.message_id}"
             onclick="SDH.Chat.toggleDedicatedStorageItem(${item.message_id})">
          <div class="flex items-center gap-3 min-w-0 flex-1">
            <input type="checkbox"
                   id="dwsStorageCb-${item.message_id}"
                   class="dws-storage-cb rounded border-white/30 text-indigo-600 focus:ring-indigo-500/30 bg-black/60 w-4 h-4 cursor-pointer flex-shrink-0"
                   data-id="${item.message_id}"
                   data-url="${escapeHtml(item.file_url)}"
                   data-filename="${escapeHtml(item.filename)}"
                   data-bytes="${item.file_size || 0}"
                   onclick="event.stopPropagation(); SDH.Chat.toggleDedicatedStorageItem(${item.message_id})" />
            
            <div class="w-10 h-10 rounded-xl ${item.category === 'Visual' ? 'bg-indigo-500/10 border border-indigo-500/25 text-indigo-400' : 'bg-emerald-500/10 border border-emerald-500/25 text-emerald-400'} flex items-center justify-center flex-shrink-0 overflow-hidden">
              ${item.message_type === 'image' ? `
                <img src="${item.file_url}" alt="" class="w-full h-full object-cover" />
              ` : `
                <span class="font-bold text-[10px] uppercase">${escapeHtml(item.extension || (item.category === 'Visual' ? 'VID' : 'DOC'))}</span>
              `}
            </div>

            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <p class="text-xs font-semibold text-divine-text truncate" title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</p>
                <span class="text-[9px] font-bold px-1.5 py-0.2 rounded-md ${item.category === 'Visual' ? 'bg-indigo-500/20 text-indigo-300' : 'bg-emerald-500/20 text-emerald-300'} flex-shrink-0">${item.category}</span>
              </div>
              <p class="text-[11px] text-divine-muted mt-0.5">${item.size_formatted} • ${new Date(item.timestamp).toLocaleDateString()}</p>
            </div>
          </div>

          <div class="flex items-center gap-1 flex-shrink-0" onclick="event.stopPropagation()">
            <a href="${item.file_url}" download="${escapeHtml(item.filename)}"
               class="p-2 rounded-xl text-divine-muted hover:text-divine-text hover:bg-white/10 transition-colors" title="Download">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
              </svg>
            </a>
          </div>
        </div>
      `).join('');
    }
  }

  function toggleDedicatedStorageItem(messageId) {
    const id = parseInt(messageId, 10);
    if (!id) return;
    const cb = document.getElementById(`dwsStorageCb-${id}`);
    const row = document.getElementById(`dwsStorageRow-${id}`);

    if (dedicatedStorageSelectedIds.has(id)) {
      dedicatedStorageSelectedIds.delete(id);
      if (cb) cb.checked = false;
      if (row) row.classList.remove('bg-indigo-500/10', 'border-indigo-500/30');
    } else {
      dedicatedStorageSelectedIds.add(id);
      if (cb) cb.checked = true;
      if (row) row.classList.add('bg-indigo-500/10', 'border-indigo-500/30');
    }

    const allCbs = document.querySelectorAll('.dws-storage-cb');
    const selectAllCb = document.getElementById('dwsSelectAllCheckbox');
    if (selectAllCb && allCbs.length > 0) {
      selectAllCb.checked = (dedicatedStorageSelectedIds.size === allCbs.length);
    }
    _updateDedicatedStorageSelectionUI();
  }

  function toggleDedicatedSelectAllStorage(isChecked) {
    const allCbs = document.querySelectorAll('.dws-storage-cb');
    dedicatedStorageSelectedIds.clear();

    allCbs.forEach(cb => {
      cb.checked = isChecked;
      const id = parseInt(cb.dataset.id, 10);
      const row = document.getElementById(`dwsStorageRow-${id}`);
      if (isChecked && id) {
        dedicatedStorageSelectedIds.add(id);
        if (row) row.classList.add('bg-indigo-500/10', 'border-indigo-500/30');
      } else {
        if (row) row.classList.remove('bg-indigo-500/10', 'border-indigo-500/30');
      }
    });

    _updateDedicatedStorageSelectionUI();
  }

  function _updateDedicatedStorageSelectionUI() {
    const count = dedicatedStorageSelectedIds.size;
    let totalSelectedBytes = 0;
    dedicatedStorageSelectedIds.forEach(id => {
      const cb = document.getElementById(`dwsStorageCb-${id}`);
      if (cb && cb.dataset.bytes) totalSelectedBytes += parseInt(cb.dataset.bytes, 10) || 0;
    });

    const countEl = document.getElementById('dwsSelectedCount');
    if (countEl) {
      countEl.textContent = count > 0 ? `(${count} selected • ${_formatBytes(totalSelectedBytes)})` : `(0 selected)`;
    }

    const dlBtn = document.getElementById('dwsBatchDownloadBtn');
    if (dlBtn) dlBtn.disabled = (count === 0);

    const delBtn = document.getElementById('dwsBatchDeleteBtn');
    if (delBtn) delBtn.disabled = (count === 0);
  }

  function _formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let val = bytes;
    let unitIdx = 0;
    while (val >= 1024 && unitIdx < units.length - 1) {
      val /= 1024;
      unitIdx++;
    }
    return `${val.toFixed(unitIdx === 0 ? 0 : 1)} ${units[unitIdx]}`;
  }

  async function downloadDedicatedSelectedStorage() {
    if (dedicatedStorageSelectedIds.size === 0) return;
    const items = [];
    dedicatedStorageSelectedIds.forEach(id => {
      const cb = document.getElementById(`dwsStorageCb-${id}`);
      if (cb && cb.dataset.url) {
        items.push({ url: cb.dataset.url, filename: cb.dataset.filename || `file_${id}` });
      }
    });

    if (items.length === 0) return;
    showToast(`Downloading ${items.length} file(s)...`, 'info');

    items.forEach((item, index) => {
      setTimeout(() => {
        const link = document.createElement('a');
        link.href = item.url;
        link.download = item.filename;
        link.target = '_blank';
        document.body.appendChild(link);
        link.click();
        link.remove();
      }, index * 250);
    });
  }

  async function deleteDedicatedSelectedStorage() {
    const count = dedicatedStorageSelectedIds.size;
    if (count === 0) return;

    const confirmed = confirm(`Permanently delete ${count} selected item${count > 1 ? 's' : ''}? This will free up storage and remove them from chat history.`);
    if (!confirmed) return;

    const delBtn = document.getElementById('dwsBatchDeleteBtn');
    if (delBtn) {
      delBtn.disabled = true;
      delBtn.innerHTML = '<span class="animate-pulse">Deleting...</span>';
    }

    const csrf = window.SDH_DATA?.csrfToken || document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
    const endpoint = window.SDH_DATA?.batchStorageDeleteUrl || '/messaging/api/storage/batch-delete/';

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': csrf,
        },
        body: JSON.stringify({
          message_ids: Array.from(dedicatedStorageSelectedIds),
          is_group: currentProfileTarget.isGroup,
          removal_scope: 'all'
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || res.statusText);
      }

      const data = await res.json();
      showToast(`Deleted ${data.deleted_count || count} item(s) (${data.freed_formatted || 'freed'}).`, 'success');

      dedicatedStorageSelectedIds.forEach(id => {
        handleMessageRemoved({
          message_id: id,
          removal_scope: 'all',
          removed_by: window.SDH_DATA?.currentUser,
        });
      });

      dedicatedStorageSelectedIds.clear();
      await loadProfileMedia(currentProfileTarget.targetUser, currentProfileTarget.groupId);
      loadDedicatedStorage();

    } catch (err) {
      console.error('[Chat] deleteDedicatedSelectedStorage error:', err);
      showToast('Deletion failed: ' + err.message, 'error');
    } finally {
      if (delBtn) {
        delBtn.innerHTML = `
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
          </svg>
          <span>Delete</span>`;
        _updateDedicatedStorageSelectionUI();
      }
    }
  }

  // ── Starred Messages Controllers ──
  async function toggleStarMessage(messageId) {
    if (!messageId) return;
    _closeAllMsgMenus();

    const isGroup = Boolean(activeUser && activeUser.startsWith('group_'));
    const csrf = window.SDH_DATA?.csrfToken || document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';

    try {
      const res = await fetch(`/messaging/api/messages/${messageId}/star/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': csrf,
        },
        body: JSON.stringify({ is_group: isGroup })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || res.statusText);
      }
      const data = await res.json();

      _applyStarStatusToBubble(messageId, data.is_starred);
      showToast(data.is_starred ? 'Message starred' : 'Message unstarred', 'info');

      // Reload starred messages
      loadStarredMessages(currentProfileTarget.targetUser, currentProfileTarget.groupId);
    } catch (err) {
      console.error('[Chat] toggleStarMessage error:', err);
      showToast('Could not update starred status: ' + err.message, 'error');
    }
  }

  function _applyStarStatusToBubble(messageId, isStarred) {
    const bubble = document.getElementById(`msg-${messageId}`);
    if (bubble) {
      bubble.dataset.isStarred = isStarred ? '1' : '0';
      const starIndicator = bubble.querySelector('.msg-star-indicator');
      if (starIndicator) {
        starIndicator.classList.toggle('hidden', !isStarred);
      }
      const starBtnText = bubble.querySelector('.msg-star-text');
      if (starBtnText) {
        starBtnText.textContent = isStarred ? 'Unstar Message' : 'Star Message';
      }
    }
  }

  function handleMessageStarred(data) {
    if (!data || !data.message_id) return;
    _applyStarStatusToBubble(data.message_id, data.is_starred);
    loadStarredMessages(currentProfileTarget.targetUser, currentProfileTarget.groupId);
  }

  async function toggleStarFromProfile(messageId, isGroup) {
    if (!messageId) return;
    const csrf = window.SDH_DATA?.csrfToken || document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
    try {
      const res = await fetch(`/messaging/api/messages/${messageId}/star/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': csrf,
        },
        body: JSON.stringify({ is_group: Boolean(isGroup) })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || res.statusText);
      }
      const data = await res.json();
      _applyStarStatusToBubble(messageId, data.is_starred);
      showToast(data.is_starred ? 'Message starred' : 'Message unstarred', 'info');

      if (!data.is_starred) {
        starredMessagesData = starredMessagesData.filter(m => m.message_id !== messageId);
      }
      loadStarredMessages(currentProfileTarget.targetUser, currentProfileTarget.groupId);
      loadDedicatedStarred();
    } catch (err) {
      showToast('Failed to toggle star: ' + err.message, 'error');
    }
  }

  async function loadStarredMessages(targetUser, groupId) {
    const emptyEl = document.getElementById('upmStarredEmpty');
    const listEl = document.getElementById('upmStarredList');
    const badgeEl = document.getElementById('upmStarredBadge');
    const navStarredBadge = document.getElementById('upmStarredNavBadge');

    if (badgeEl) badgeEl.textContent = '...';

    try {
      let url = (window.SDH_DATA?.starredMessagesUrl || '/messaging/api/starred-messages/') + '?';
      if (groupId) {
        url += `group_id=${encodeURIComponent(groupId)}`;
      } else if (targetUser) {
        url += `target_user=${encodeURIComponent(targetUser)}`;
      }

      const res = await fetch(url);
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      starredMessagesData = data.starred_messages || [];

      if (badgeEl) badgeEl.textContent = String(data.count || 0);
      if (navStarredBadge) navStarredBadge.textContent = String(data.count || 0);

      // Decrypt any encrypted messages if needed
      for (const item of starredMessagesData) {
        if (item.is_encrypted && item.encryption_iv && item.content && window.SDH?.E2E) {
          try {
            if (item.is_group && item.group_id) {
              item.content = await window.SDH.E2E.decryptGroupMessage(item.content, item.encryption_iv, item.group_id);
            } else {
              item.content = await window.SDH.E2E.decrypt(item.content, item.encryption_iv, item.sender);
            }
          } catch (e) {
            // Keep original content if decryption fails
          }
        }
      }

      // If dedicated workspace is open, refresh dedicated starred list
      const dwsModal = document.getElementById('dedicatedWorkspaceModal');
      if (dwsModal && !dwsModal.classList.contains('hidden')) {
        loadDedicatedStarred();
      }

      if (!starredMessagesData.length) {
        if (emptyEl) emptyEl.classList.remove('hidden');
        if (listEl) listEl.innerHTML = '';
        return;
      }

      if (emptyEl) emptyEl.classList.add('hidden');

      if (listEl) {
        listEl.innerHTML = starredMessagesData.map(item => `
          <div class="sdh-starred-card p-2.5 rounded-xl bg-black/20 hover:bg-white/[0.04] border border-white/[0.08] transition-all space-y-1.5" data-starred-msg-id="${item.message_id}">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-1.5">
                <span class="text-[11px] font-bold text-divine-text">${escapeHtml(item.sender)}</span>
                <span class="text-[9px] text-amber-400">★</span>
              </div>
              <span class="text-[9px] text-divine-muted/60">${new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • ${new Date(item.timestamp).toLocaleDateString()}</span>
            </div>
            <div class="text-xs text-divine-text/90 line-clamp-2 leading-relaxed font-normal">
              ${item.file_url ? `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/10 text-[10px] text-divine-gold mr-1">📎 ${escapeHtml(item.filename || 'Attachment')}</span>` : ''}
              ${escapeHtml(item.content || '')}
            </div>
            <div class="flex items-center justify-between pt-1 border-t border-white/[0.04]">
              <button type="button" onclick="SDH.Chat.jumpToMessage(${item.message_id})"
                      class="text-[10px] font-semibold text-indigo-400 hover:text-indigo-300 flex items-center gap-1 transition-colors">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"/>
                </svg>
                <span>Jump to message</span>
              </button>
              <div class="flex items-center gap-1">
                ${item.content ? `
                <button type="button" onclick="navigator.clipboard.writeText('${escapeHtml(item.content)}'); showToast('Copied to clipboard', 'info')"
                        class="p-1 rounded text-divine-muted hover:text-divine-text hover:bg-white/10 transition-colors" title="Copy Text">
                  <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"/>
                  </svg>
                </button>` : ''}
                <button type="button" onclick="SDH.Chat.toggleStarFromProfile(${item.message_id}, ${item.is_group})"
                        class="p-1 rounded text-amber-400/80 hover:text-amber-400 hover:bg-amber-400/10 transition-colors" title="Unstar">
                  <svg class="w-3 h-3 fill-current" viewBox="0 0 24 24">
                    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        `).join('');
      }
    } catch (err) {
      console.error('[Chat] loadStarredMessages error:', err);
      if (badgeEl) badgeEl.textContent = '0';
      if (navStarredBadge) navStarredBadge.textContent = '0';
      if (emptyEl) emptyEl.classList.remove('hidden');
    }
  }

  // ── Dedicated Starred View Controllers ──
  function loadDedicatedStarred() {
    const list = document.getElementById('dwsStarredList');
    const emptyEl = document.getElementById('dwsStarredEmpty');
    const countBadge = document.getElementById('dwsStarredCountBadge');

    if (countBadge) countBadge.textContent = `${starredMessagesData.length} starred`;

    if (!starredMessagesData.length) {
      if (list) list.innerHTML = '';
      if (emptyEl) emptyEl.classList.remove('hidden');
      return;
    }

    if (emptyEl) emptyEl.classList.add('hidden');
    if (list) {
      list.innerHTML = starredMessagesData.map(item => `
        <div class="sdh-starred-card dws-starred-item p-3.5 rounded-2xl bg-black/30 hover:bg-white/[0.05] border border-white/[0.08] transition-all space-y-2 shadow-sm"
             data-starred-id="${item.message_id}"
             data-search-content="${escapeHtml(((item.content || '') + ' ' + (item.sender || '') + ' ' + (item.filename || '')).toLowerCase())}">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="text-xs font-bold text-divine-text">${escapeHtml(item.sender)}</span>
              <span class="text-amber-400 text-xs">★</span>
            </div>
            <span class="text-[10px] text-divine-muted/70">${new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • ${new Date(item.timestamp).toLocaleDateString()}</span>
          </div>

          <div class="text-xs text-divine-text leading-relaxed font-normal">
            ${item.file_url ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-white/10 text-[11px] text-divine-gold font-medium mr-1.5">📎 ${escapeHtml(item.filename || 'Attachment')}</span>` : ''}
            ${escapeHtml(item.content || '')}
          </div>

          <div class="flex items-center justify-between pt-1.5 border-t border-white/[0.06]">
            <button type="button" onclick="SDH.Chat.jumpToMessage(${item.message_id})"
                    class="text-[11px] font-semibold text-indigo-400 hover:text-indigo-300 flex items-center gap-1.5 transition-colors group">
              <svg class="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"/>
              </svg>
              <span>Jump to message</span>
            </button>

            <div class="flex items-center gap-1.5">
              ${item.content ? `
              <button type="button" onclick="navigator.clipboard.writeText('${escapeHtml(item.content)}'); showToast('Copied to clipboard', 'info')"
                      class="p-1.5 rounded-lg text-divine-muted hover:text-divine-text hover:bg-white/10 transition-colors" title="Copy Text">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"/>
                </svg>
              </button>` : ''}

              <button type="button" onclick="SDH.Chat.toggleStarFromProfile(${item.message_id}, ${item.is_group})"
                      class="p-1.5 rounded-lg text-amber-400/80 hover:text-amber-400 hover:bg-amber-400/10 transition-colors" title="Unstar">
                <svg class="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      `).join('');
    }

    const searchInput = document.getElementById('dwsStarredSearch');
    if (searchInput) {
      searchInput.value = '';
      filterDedicatedStarred('');
    }
  }

  function clearDedicatedStarredSearch() {
    const searchInput = document.getElementById('dwsStarredSearch');
    if (searchInput) {
      searchInput.value = '';
      searchInput.focus();
    }
    filterDedicatedStarred('');
  }

  function filterDedicatedStarred(query) {
    const q = (query || '').toLowerCase().trim();
    const clearBtn = document.getElementById('dwsStarredClearBtn');
    if (clearBtn) clearBtn.classList.toggle('hidden', !q);

    const list = document.getElementById('dwsStarredList');
    if (!list) return;

    const items = list.querySelectorAll('.dws-starred-item');
    let visibleCount = 0;
    items.forEach(el => {
      const match = !q || (el.dataset.searchContent && el.dataset.searchContent.includes(q));
      el.style.display = match ? '' : 'none';
      if (match) visibleCount++;
    });

    const emptyEl = document.getElementById('dwsStarredEmpty');
    if (emptyEl) {
      emptyEl.classList.toggle('hidden', visibleCount > 0 || items.length === 0);
    }
  }

  function jumpToMessage(messageId) {
    if (!messageId) return;
    const modal = document.getElementById('userProfileModal');
    if (modal) modal.classList.add('hidden');
    const dwsModal = document.getElementById('dedicatedWorkspaceModal');
    if (dwsModal) dwsModal.classList.add('hidden');

    const msgEl = document.getElementById(`msg-${messageId}`);
    if (msgEl) {
      msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      msgEl.classList.remove('sdh-message-highlight');
      void msgEl.offsetWidth; // trigger reflow
      msgEl.classList.add('sdh-message-highlight');
      setTimeout(() => {
        msgEl.classList.remove('sdh-message-highlight');
      }, 3600);
    } else {
      showToast('Message is not in the currently loaded timeline.', 'info');
    }
  }

  function openRetentionModal() {
    if (!activeUser) return;
    document.getElementById('retentionModal').classList.remove('hidden');
  }

  function closeRetentionModal() {
    document.getElementById('retentionModal').classList.add('hidden');
  }

  async function saveRetentionSetting() {
    if (!activeUser) return;
    const checked = document.querySelector('input[name="retention_days"]:checked');
    if (!checked) return;
    const val = checked.value;
    try {
      const res = await fetch(`/messaging/api/chat-setting/${activeUser}/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': window.SDH_DATA.csrfToken
        },
        body: JSON.stringify({ retention_days: val })
      });
      if (res.ok) {
        if (SDH.WS && SDH.WS.isOpen()) {
          SDH.WS.sendMessage({ type: 'retention_update', retention_days: parseInt(val, 10) });
        }
        closeRetentionModal();
        showToast('Retention period updated.', 'success');
      } else {
        showToast('Failed to update retention.', 'error');
      }
    } catch (e) {
      showToast('Error updating retention.', 'error');
    }
  }

  // ── Group Functions ────────────────────────────────────────────────────────

  function toggleKebabMenu() {
    const dropdown = document.getElementById('kebabDropdown');
    if (dropdown) {
      dropdown.classList.toggle('hidden');
      if (!dropdown.classList.contains('hidden') && window.SDH?.ChatLock) {
        const isGroup = activeUser && activeUser.startsWith('group_');
        const locked = window.SDH.ChatLock.isChatLocked(activeUser, isGroup);
        const lockChatBtnText = document.getElementById('lockChatBtnText');
        const lockGroupBtnText = document.getElementById('lockGroupBtnText');
        if (lockChatBtnText) {
          lockChatBtnText.textContent = locked ? 'Unlock Chat' : 'Lock Chat';
        }
        if (lockGroupBtnText) {
          lockGroupBtnText.textContent = locked ? 'Unlock Group' : 'Lock Group';
        }
      }
    }
  }

  function handleCallButtonClick(callType) {
    if (activeUser && activeUser.startsWith('group_')) {
      initiateGroupCall(callType);
    } else {
      if (SDH.WebRTC?.isCallInProgress?.()) {
        if (callType === 'video' && SDH.WebRTC.getCallType?.() === 'voice') {
          return SDH.WebRTC.requestVideoUpgrade();
        }
      }
      SDH.WebRTC.startCall(callType);
    }
  }

  let pendingGroupCallType = null;
  async function initiateGroupCall(callType) {
    if (!activeUser?.startsWith('group_') || !activeUserId) return;
    pendingGroupCallType = callType;

    const modal = document.getElementById('groupCallModal');
    const listEl = document.getElementById('groupCallMembersList');
    if (!modal || !listEl) return;

    listEl.innerHTML = '<div class="text-center text-xs text-white/50 py-4">Loading members...</div>';
    modal.classList.remove('hidden');

    try {
      const res = await fetch(`/messaging/api/groups/${activeUserId}/`);
      if (!res.ok) throw new Error('Failed to fetch details');
      const data = await res.json();

      listEl.innerHTML = '';
      const members = data.members || [];
      const otherMembers = members.filter(m => String(m.user_id) !== String(window.SDH_DATA.currentUserId));

      if (otherMembers.length === 0) {
        listEl.innerHTML = '<div class="text-center text-xs text-white/50 py-4">No other members in this group.</div>';
        return;
      }

      otherMembers.forEach(member => {
        const div = document.createElement('div');
        div.className = 'flex items-center justify-between bg-black/20 p-2.5 rounded-xl mb-2 hover:bg-white/5 transition-colors cursor-pointer';
        div.onclick = () => {
          modal.classList.add('hidden');
          SDH.WebRTC.setRemoteUser(member.username);
          SDH.WebRTC.startCall(pendingGroupCallType);
        };

        let avatarHtml = `<div class="w-8 h-8 rounded-full bg-divine-surface flex items-center justify-center text-xs font-bold text-divine-gold shrink-0">${member.username.charAt(0).toUpperCase()}</div>`;
        if (member.avatar_url) avatarHtml = `<img src="${member.avatar_url}" class="w-8 h-8 rounded-full object-cover shrink-0" onerror="this.parentElement.innerHTML = '${member.username.charAt(0).toUpperCase()}';">`;

        div.innerHTML = `
            <div class="flex items-center gap-3 overflow-hidden">
              ${avatarHtml}
              <p class="text-xs font-medium text-divine-text truncate">${member.username}</p>
            </div>
            <button class="text-xs font-bold px-3 py-1.5 rounded-lg text-divine-deep bg-divine-gold hover:bg-yellow-400 hover:shadow-[0_0_10px_rgba(250,204,21,0.4)] transition-all">
              Call
            </button>
          `;
        listEl.appendChild(div);
      });
    } catch (err) {
      listEl.innerHTML = `<div class="text-center text-xs text-red-400/80 py-4">${err.message}</div>`;
    }
  }

  function openCreateGroupModal() {
    const modal = document.getElementById('createGroupModal');
    const list = document.getElementById('cgMembersList');
    if (modal && list) {
      list.innerHTML = '';
      const userItems = document.querySelectorAll('.user-item');
      let count = 0;
      userItems.forEach(el => {
        const uId = el.dataset.userid;
        if (!uId || uId == window.SDH_DATA.currentUserId) return;
        if (el.dataset.self === '1') return;

        const uName = el.querySelector('.sdh-user-name')?.textContent.trim() || 'Unknown';
        const uImg = el.querySelector('img')?.src || '';

        const div = document.createElement('label');
        div.className = 'sdh-cg-member-row flex items-center justify-between px-3 py-2.5 rounded-xl cursor-pointer transition-all';

        let avatarHtml = `<div class="w-8 h-8 rounded-full bg-divine-surface flex items-center justify-center text-xs font-bold text-divine-gold shrink-0">${uName.charAt(0).toUpperCase()}</div>`;
        if (uImg) {
          avatarHtml = `<div class="w-8 h-8 rounded-full bg-divine-surface flex items-center justify-center text-xs font-bold text-divine-gold shrink-0"><img src="${uImg}" class="w-8 h-8 object-cover rounded-full shrink-0" alt="" onerror="this.parentElement.innerHTML = '${uName.charAt(0).toUpperCase()}';"></div>`;
        }

        div.innerHTML = `
             <div class="flex items-center gap-3">
               ${avatarHtml}
               <span class="text-sm font-medium text-divine-text">${uName}</span>
             </div>
             <input type="checkbox" value="${uId}" class="cg-member-checkbox w-4 h-4 rounded border-divine-border text-divine-gold focus:ring-divine-gold bg-divine-surface cursor-pointer">
           `;
        list.appendChild(div);
        count++;
      });
      if (count === 0) {
        list.innerHTML = `
          <div class="flex flex-col items-center justify-center py-4 px-3 text-center">
            <svg class="w-7 h-7 text-amber-500/60 dark:text-divine-gold/50 mb-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            <p class="sdh-cg-empty-msg text-xs font-medium text-slate-500 dark:text-slate-400">No other users available.</p>
          </div>`;
      }
      modal.classList.remove('hidden');
    }
  }

  function closeCreateGroupModal() {
    const modal = document.getElementById('createGroupModal');
    if (modal) {
      modal.classList.add('hidden');
      document.getElementById('cgName').value = '';
      document.getElementById('cgDescription').value = '';
    }
  }

  let currentInviteGroupId = null;

  function openInviteMemberModal(groupId, currentMemberIds) {
    currentInviteGroupId = groupId;
    const modal = document.getElementById('inviteMemberModal');
    if (modal) {
      const list = document.getElementById('imMembersList');
      list.innerHTML = '';

      let count = 0;
      document.querySelectorAll('.sdh-user-item').forEach(el => {
        const uId = parseInt(el.dataset.userid, 10);
        if (!uId || uId === window.SDH_DATA.userId || currentMemberIds.includes(uId)) return;

        const uName = el.querySelector('.sdh-user-name')?.textContent.trim() || 'Unknown';
        const uImg = el.querySelector('img')?.src || '';

        const div = document.createElement('label');
        div.className = 'sdh-im-member-row flex items-center justify-between px-3 py-2.5 rounded-xl cursor-pointer transition-all hover:bg-white/5';

        let avatarHtml = `<div class="w-8 h-8 rounded-full bg-divine-surface flex items-center justify-center text-xs font-bold text-divine-gold shrink-0">${uName.charAt(0).toUpperCase()}</div>`;
        if (uImg) {
          avatarHtml = `<div class="w-8 h-8 rounded-full bg-divine-surface flex items-center justify-center text-xs font-bold text-divine-gold shrink-0"><img src="${uImg}" class="w-8 h-8 object-cover rounded-full shrink-0" alt="" onerror="this.parentElement.innerHTML = '${uName.charAt(0).toUpperCase()}';"></div>`;
        }

        div.innerHTML = `
             <div class="flex items-center gap-3">
               ${avatarHtml}
               <span class="text-sm font-medium text-divine-text">${uName}</span>
             </div>
             <input type="checkbox" value="${uId}" class="im-member-checkbox w-4 h-4 rounded border-divine-border text-divine-gold focus:ring-divine-gold bg-divine-surface cursor-pointer">
           `;
        list.appendChild(div);
        count++;
      });
      if (count === 0) {
        list.innerHTML = `
            <div class="flex flex-col items-center justify-center p-6 text-center">
              <svg class="w-8 h-8 text-fuchsia-400/50 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
              <p class="sdh-im-empty-msg text-xs font-medium text-divine-text opacity-70">No eligible users available to invite.</p>
            </div>`;
      }
      modal.classList.remove('hidden');
    }
  }

  function closeInviteMemberModal() {
    const modal = document.getElementById('inviteMemberModal');
    if (modal) {
      modal.classList.add('hidden');
      currentInviteGroupId = null;
    }
  }

  async function submitInviteMember() {
    if (!currentInviteGroupId) return;
    const checkboxes = document.querySelectorAll('.im-member-checkbox:checked');
    const memberIds = Array.from(checkboxes).map(c => parseInt(c.value, 10));

    if (memberIds.length === 0) {
      showToast('Please select at least one member to invite.', 'error');
      return;
    }

    const btn = event.currentTarget;
    const originalHtml = btn.innerHTML;
    btn.innerHTML = '<span>Sending...</span>';
    btn.disabled = true;

    try {
      const res = await fetch(`/messaging/api/groups/${currentInviteGroupId}/members/add/`, {
        method: 'POST',
        headers: {
          'X-CSRFToken': window.SDH_DATA.csrfToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ member_ids: memberIds })
      });

      if (!res.ok) {
        const j = await res.json().catch(e => { });
        throw new Error(j?.error || 'Failed to send invites');
      }

      showToast('Invites sent successfully!', 'success');
      const groupIdToRefresh = currentInviteGroupId;
      closeInviteMemberModal();
      if (groupIdToRefresh) {
        showGroupProfile(groupIdToRefresh); // Refresh member list/data
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.innerHTML = originalHtml;
      btn.disabled = false;
    }
  }

  async function submitCreateGroup() {
    const name = document.getElementById('cgName').value.trim();
    const desc = document.getElementById('cgDescription').value.trim();
    const checkboxes = document.querySelectorAll('.cg-member-checkbox:checked');
    const memberIds = Array.from(checkboxes).map(c => parseInt(c.value, 10));

    if (!name) {
      showToast('Group name is required.', 'error');
      return;
    }

    if (memberIds.length === 0) {
      showToast('Please select at least one member to create a group.', 'error');
      return;
    }

    try {
      const res = await fetch('/messaging/api/groups/create/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': window.SDH_DATA.csrfToken
        },
        body: JSON.stringify({ name: name, description: desc, member_ids: memberIds })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to create group');
      }
      const resData = await res.json();
      showToast('Group created! Invitations sent.', 'success');
      closeCreateGroupModal();
      await _refreshSidebar();
      if (resData.group && resData.group.id) {
        selectGroup(resData.group.id, resData.group.name);
      }
    } catch (err) {
      showToast('Failed to create group: ' + err.message, 'error');
    }
  }

  async function selectGroup(groupId, groupName) {
    if (window.innerWidth < 640) closeSidebar();

    // Chat Lock Verification
    if (window.SDH?.ChatLock?.isChatLocked?.(`group_${groupId}`, true)) {
      if (!window.SDH.ChatLock.isUnlocked()) {
        window.SDH.ChatLock.ensureChatAccessible(`group_${groupId}`, true, () => {
          selectGroup(groupId, groupName);
        });
        return;
      }
    }

    if (activeUser === `group_${groupId}`) return;
    clearFiles();
    activeUser = `group_${groupId}`;
    activeUserId = groupId;
    sessionStorage.setItem('ndm_last_chat', activeUser);
    sessionStorage.setItem('ndm_last_chat_id', String(groupId));
    if (groupName) sessionStorage.setItem('ndm_last_chat_name', groupName);
    sessionStorage.setItem('ndm_last_chat_user', window.SDH_DATA?.currentUser || '');

    renderedIds.clear();
    dateSeparators.clear();

    document.querySelectorAll('.user-item').forEach(el => el.classList.remove('active-chat-item'));
    document.getElementById(`group-item-${groupId}`)?.classList.add('active-chat-item');

    const avatarEl = document.getElementById('chatAvatar');
    if (avatarEl) avatarEl.textContent = (groupName && groupName[0] ? groupName[0] : 'G').toUpperCase(); // fallback
    const usernameEl = document.getElementById('chatUsername');
    if (usernameEl) usernameEl.textContent = groupName;

    _setHeaderStatus('Connecting...', 'reconnecting');
    document.getElementById('inputBar')?.classList.remove('hidden');

    document.getElementById('callButtons')?.classList.remove('hidden');
    document.getElementById('voiceCallBtn')?.classList.remove('hidden');
    document.getElementById('videoCallBtn')?.classList.remove('hidden');
    document.getElementById('kebabUserOptions')?.classList.add('hidden');
    document.getElementById('kebabGroupOptions')?.classList.remove('hidden');
    const viewProf = document.getElementById('kebabViewProfileText');
    if (viewProf) viewProf.textContent = 'Group Info';

    const container = document.getElementById('messagesContainer');
    if (container) container.innerHTML = `
        <div class="flex items-center justify-center py-8">
          <div class="w-5 h-5 border-2 border-divine-gold border-t-transparent rounded-full animate-spin"></div>
        </div>`;

    try {
      const infoRes = await fetch(`/messaging/api/groups/${groupId}/`);
      if (infoRes.ok) {
        const gInfo = await infoRes.json();
        currentGroupMembers = gInfo.members || [];
        if (gInfo.avatar_url && avatarEl) {
          avatarEl.innerHTML = `<img src="${gInfo.avatar_url}" class="w-full h-full object-cover rounded-full" alt="" onerror="this.parentElement.innerHTML = '${(gInfo.name && gInfo.name[0] ? gInfo.name[0] : 'G').toUpperCase()}';">`;
        }
        if (gInfo.name && usernameEl) {
          usernameEl.textContent = gInfo.name;
          sessionStorage.setItem('ndm_last_chat_name', gInfo.name);
        }
      }
    } catch (e) { }

    if (window.SDH?.E2E?.ensureGroupKeyDistributed) {
      try {
        await window.SDH.E2E.ensureGroupKeyDistributed(groupId);
      } catch (e2eGroupErr) {
        console.warn('[E2EE] Group key prefetch warning:', e2eGroupErr);
      }
    } else if (window.SDH?.E2E?.getGroupKey) {
      try {
        await window.SDH.E2E.getGroupKey(groupId);
      } catch (e2eGroupErr) {
        console.warn('[E2EE] Group key prefetch warning:', e2eGroupErr);
      }
    }

    await loadGroupHistory(groupId, groupName);

    unreadCounts[`group_${groupId}`] = 0;
    updateUnreadBadge(`group_${groupId}`);

    _setHeaderStatus('Group Chat', 'connected');
    closeSidebar();
    if (window.Notif) Notif.requestPermission();

    if (SDH.WS) {
      SDH.WS.connectWebSocket(groupId, true); // true for isGroup
      if (SDH.WS.isOpen()) {
        SDH.WS.sendMessage({ type: 'mark_read' });
      }
    }
  }

  async function showGroupProfile(groupId) {
    const modal = document.getElementById('userProfileModal');
    if (!modal) return;

    const avatarText = document.getElementById('upmAvatarText');
    const avatarImg = document.getElementById('upmAvatarImg');
    const displayNameEl = document.getElementById('upmDisplayName');
    const usernameEl = document.getElementById('upmUsername');
    const statusDot = document.getElementById('upmStatusDot');
    const statusText = document.getElementById('upmStatusText');
    const bioEl = document.getElementById('upmBio');
    const emailEl = document.getElementById('upmEmail');
    const phoneEl = document.getElementById('upmPhone');
    const joinedEl = document.getElementById('upmJoined');
    const lastSeenEl = document.getElementById('upmLastSeen');

    displayNameEl.textContent = 'Loading Group...';
    usernameEl.textContent = 'Fetching details';
    bioEl.textContent = '—';
    emailEl.textContent = '—';
    phoneEl.textContent = '—';
    joinedEl.textContent = '—';
    lastSeenEl.textContent = '—';
    lastSeenEl.classList.add('hidden');
    if (avatarText) { avatarText.textContent = 'G'; avatarText.classList.remove('hidden'); }
    if (avatarImg) { avatarImg.classList.add('hidden'); avatarImg.src = ''; }
    if (statusDot) statusDot.className = 'w-2 h-2 rounded-full bg-green-500';
    if (statusText) { statusText.textContent = 'Group Chat'; statusText.className = 'text-[11px] font-semibold text-green-400'; }

    const pendingSectionInit = document.getElementById('upmPendingRequestSection');
    const membersSectionInit = document.getElementById('upmMembersSection');
    const contactSectionInit = document.getElementById('upmContactSection');
    const msgBtnInit = document.getElementById('upmMessageBtn');
    if (pendingSectionInit) pendingSectionInit.classList.add('hidden');
    if (membersSectionInit) membersSectionInit.classList.add('hidden');
    if (contactSectionInit) contactSectionInit.classList.add('hidden');
    if (msgBtnInit) msgBtnInit.classList.add('hidden');

    modal.classList.remove('hidden');

    try {
      const res = await fetch(`/messaging/api/groups/${groupId}/`);
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();

      displayNameEl.textContent = data.name;
      usernameEl.textContent = `Group • ${data.members ? data.members.length : 0} members`;
      bioEl.textContent = data.description || 'No description provided.';
      bioEl.classList.remove('text-divine-muted/50');
      emailEl.textContent = `Creator: ${data.created_by || 'Unknown'}`;
      joinedEl.textContent = data.created_at ? `Created ${new Date(data.created_at).toLocaleDateString()}` : '—';

      if (data.avatar_url && avatarImg && avatarText) {
        avatarImg.src = data.avatar_url;
        avatarImg.classList.remove('hidden');
        avatarText.classList.add('hidden');
      }

      const membersSection = document.getElementById('upmMembersSection');
      const membersListEl = document.getElementById('upmMembersList');
      if (membersSection && membersListEl && data.members) {
        membersSection.classList.remove('hidden');
        const isAdminOrOwner = data.my_role === 'owner' || data.my_role === 'admin';

        const countBadge = document.getElementById('upmMembersCount');
        if (countBadge) {
          countBadge.textContent = `${data.members.length} member${data.members.length === 1 ? '' : 's'}`;
        }

        const inviteBtn = document.getElementById('upmInviteMemberBtn');
        if (inviteBtn) {
          if (isAdminOrOwner) {
            inviteBtn.classList.remove('hidden');
            inviteBtn.onclick = () => {
              const currentGroupMembers = data.members.map(m => m.user_id);
              SDH.Chat.openInviteMemberModal(groupId, currentGroupMembers);
            };
          } else {
            inviteBtn.classList.add('hidden');
          }
        }

        const sortedMembers = _sortGroupMembers(data.members);
        membersListEl.innerHTML = sortedMembers.map(member => _renderGroupMemberCard(member, data.id || groupId, isAdminOrOwner)).join('');
      }

      const disbandBtn = document.getElementById('disbandGroupBtn');
      if (disbandBtn) {
        if (data.my_role === 'owner' || data.my_role === 'admin') disbandBtn.classList.remove('hidden');
        else disbandBtn.classList.add('hidden');
      }

      // Populate All Files & Media and Starred Messages for group
      loadProfileMedia(null, groupId);
      loadStarredMessages(null, groupId);

    } catch (err) {
      displayNameEl.textContent = 'Error Loading Group';
      bioEl.textContent = 'Could not load group details.';
      bioEl.classList.add('text-red-400/80');
      showToast(err.message, 'error');
    }
  }

  async function removeGroupMember(groupId, userId) {
    if (!confirm('Are you sure you want to remove this member?')) return;
    const row = document.getElementById(`upm-member-row-${groupId}-${userId}`);
    if (row) {
      row.style.opacity = '0.5';
      row.style.pointerEvents = 'none';
    }
    try {
      const res = await fetch(`/messaging/api/groups/${groupId}/members/remove/`, {
        method: 'POST',
        headers: {
          'X-CSRFToken': window.SDH_DATA.csrfToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ user_id: userId })
      });
      if (!res.ok) {
        const j = await res.json().catch(e => { });
        throw new Error(j?.error || 'Failed to remove member');
      }
      const data = await res.json().catch(() => ({}));
      if (row) {
        row.style.transition = 'all 0.25s ease';
        row.style.opacity = '0';
        row.style.transform = 'scale(0.95)';
        setTimeout(() => row.remove(), 250);
      }
      const countBadge = document.getElementById('upmMembersCount');
      if (countBadge && data.member_count !== undefined) {
        countBadge.textContent = `(${data.member_count})`;
      }
      showToast('Member removed successfully', 'success');
    } catch (err) {
      if (row) {
        row.style.opacity = '1';
        row.style.pointerEvents = 'auto';
      }
      showToast(err.message, 'error');
    }
  }

  async function leaveCurrentGroup() {
    if (!activeUser?.startsWith('group_') || !activeUserId) return;

    try {
      const infoRes = await fetch(`/messaging/api/groups/${activeUserId}/`);
      if (infoRes.ok) {
        const gInfo = await infoRes.json();
        if (gInfo.my_role === 'owner' || gInfo.my_role === 'admin') {
          if (confirm('You are an admin of this group. Do you want to DELETE the entire group for everyone instead of just leaving?\n\nClick OK to DELETE the group.\nClick Cancel to continue with LEAVING.')) {
            return disbandCurrentGroup();
          }
        }
      }
    } catch (e) {
      console.error("Failed to check group role", e);
    }

    if (!confirm('Are you sure you want to leave this group?')) return;
    try {
      const res = await fetch(`/messaging/api/groups/${activeUserId}/members/leave/`, {
        method: 'POST',
        headers: {
          'X-CSRFToken': window.SDH_DATA.csrfToken,
          'Content-Type': 'application/json'
        }
      });
      if (!res.ok) throw new Error(await res.text());
      showToast('You left the group.', 'success');
      _resetConversationPanel();
      _refreshSidebar();
    } catch (err) {
      showToast('Could not leave group: ' + err.message, 'error');
    }
  }

  async function disbandCurrentGroup() {
    if (!activeUser?.startsWith('group_') || !activeUserId) return;
    if (!confirm('Are you sure you want to DELETE this group for everyone? This cannot be undone.')) return;
    try {
      const res = await fetch(`/messaging/api/groups/${activeUserId}/`, {
        method: 'DELETE',
        headers: {
          'X-CSRFToken': window.SDH_DATA.csrfToken,
        }
      });
      if (!res.ok) throw new Error('Forbidden or failed');
      // Real-time cleanup is handled by the group_deleted WebSocket event
    } catch (err) {
      showToast('Could not delete group: ' + err.message, 'error');
    }
  }

  function toggleSidebarKebab(event, groupId) {
    // Close all other sidebars
    document.querySelectorAll('[id^="sidebarKebab-"]').forEach(el => {
      if (el.id !== `sidebarKebab-${groupId}`) el.classList.add('hidden');
    });
    const dropdown = document.getElementById(`sidebarKebab-${groupId}`);
    if (dropdown) dropdown.classList.toggle('hidden');
  }

  async function deleteGroupFromSidebar(groupId) {
    if (!confirm('Are you sure you want to DELETE this group for everyone? This cannot be undone.')) return;
    try {
      const res = await fetch(`/messaging/api/groups/${groupId}/`, {
        method: 'DELETE',
        headers: {
          'X-CSRFToken': window.SDH_DATA.csrfToken,
        }
      });
      if (!res.ok) throw new Error('Forbidden or failed');
      // Real-time cleanup is handled by the group_deleted WebSocket event
    } catch (err) {
      showToast('Could not delete group: ' + err.message, 'error');
    }
  }

  /** Clear Group Chat */
  async function clearCurrentGroupChat() {
    if (!activeUser?.startsWith('group_') || !activeUserId) return;
    if (!confirm('Are you sure you want to clear your chat history for this group? This will only remove messages from your view.')) return;

    try {
      const res = await fetch(`/messaging/api/groups/${activeUserId}/clear/`, {
        method: 'POST',
        headers: {
          'X-CSRFToken': window.SDH_DATA.csrfToken,
          'Content-Type': 'application/json'
        }
      });
      if (!res.ok) throw new Error('Forbidden or failed');
      // UI cleared by chat_cleared WebSocket event
    } catch (err) {
      showToast('Could not clear chat: ' + err.message, 'error');
    }
  }

  async function loadGroupHistory(groupId, groupName) {
    const container = document.getElementById('messagesContainer');
    try {
      const res = await fetch(`/messaging/api/groups/${groupId}/history/`);
      if (!res.ok) {
        if (res.status === 423) {
          if (window.SDH?.ChatLock) {
            window.SDH.ChatLock.showAuthModal({
              reason: `Unlock to view this group chat`,
              onSuccess: () => loadGroupHistory(groupId, groupName)
            });
          }
          return;
        }
        throw new Error(res.statusText);
      }
      const data = await res.json();

      if (container) container.innerHTML = '';

      if (data.messages.length === 0) {
        if (container) {
          container.innerHTML = `
              <div class="flex flex-col items-center justify-center h-full text-center text-divine-muted py-16">
                <div class="text-5xl mb-4 opacity-20">💬</div>
                <p class="text-sm font-medium">${groupName}</p>
                <p class="text-xs mt-2 opacity-50">Say hello to the group</p>
              </div>`;
        }
        return;
      }

      const fragment = document.createDocumentFragment();
      for (const msg of data.messages) {
        const isFromMe = msg.sender === window.SDH_DATA.currentUser;
        const effectiveType = msg.is_system_message ? 'system' : msg.message_type;

        if (effectiveType === 'system') {
          let sysMsg = msg.message;
          if (sysMsg && window.SDH_DATA && window.SDH_DATA.currentUser) {
            // E.g., "Raj_123 created this group" -> "You created this group"
            const prefix = window.SDH_DATA.currentUser + " ";
            const suffix = " by " + window.SDH_DATA.currentUser + ".";
            if (sysMsg.startsWith(prefix)) {
              sysMsg = "You " + sysMsg.substring(prefix.length);
            }
            if (sysMsg.endsWith(suffix)) {
              sysMsg = sysMsg.substring(0, sysMsg.length - suffix.length) + " by You.";
            }
          }
          appendSystemMessage(sysMsg, fragment);
          continue;
        }

        let content = (effectiveType === 'text' || effectiveType === 'location') ? (msg.message || '') : null;
        if (effectiveType === 'text' && msg.is_encrypted && msg.encryption_iv && window.SDH?.E2E) {
          content = await window.SDH.E2E.decryptGroupMessage(msg.message, msg.encryption_iv, groupId);
        }
        renderedIds.add(String(msg.id));
        appendMessage({
          sender: msg.sender,
          isFromMe: isFromMe,
          content: content,
          messageType: effectiveType,
          location: msg.location || null,
          originalFilename: msg.original_filename,
          mimeType: msg.mime_type,
          timestamp: msg.timestamp,
          messageId: msg.id,
          hasServerFile: !(msg.is_view_once && msg.view_once_opened) && msg.has_file,
          fileId: msg.file_id,
          isDelivered: true,
          isRead: true,
          isViewOnce: Boolean(msg.is_view_once),
          viewOnceOpened: Boolean(msg.view_once_opened),
          isStarred: Boolean(msg.is_starred),
        }, fragment);
      }
      if (container) container.appendChild(fragment);
      scrollToBottom(true);
    } catch (err) {
      showToast('Failed to load group history.', 'error');
    }
  }

  async function showGroupMessageDetails(messageId) {
    const modal = document.getElementById('messageDetailsModal');
    const listEl = document.getElementById('mdReadersList');
    if (!modal || !listEl) return;

    listEl.innerHTML = '<div class="text-center text-xs text-white/50 py-4">Loading...</div>';
    modal.classList.remove('hidden');

    try {
      const res = await fetch(`/messaging/api/groups/messages/${messageId}/reads/`);
      if (!res.ok) throw new Error('Failed to fetch details');
      const data = await res.json();

      listEl.innerHTML = '';
      if (!data.readers || data.readers.length === 0) {
        listEl.innerHTML = '<div class="text-center text-xs text-white/50 py-4">Not read by anyone yet.</div>';
        return;
      }

      data.readers.forEach(reader => {
        const div = document.createElement('div');
        div.className = 'flex items-center gap-3 bg-black/20 p-2 rounded-lg mb-2';

        let avatarHtml = `<div class="w-8 h-8 rounded-full bg-divine-surface flex items-center justify-center text-xs font-bold text-divine-gold shrink-0">${reader.username.charAt(0).toUpperCase()}</div>`;
        if (reader.avatar_url) avatarHtml = `<img src="${reader.avatar_url}" class="w-8 h-8 rounded-full object-cover shrink-0">`;

        const timeStr = new Date(reader.read_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        div.innerHTML = `
            ${avatarHtml}
            <div class="flex-1 min-w-0">
              <p class="text-xs font-medium text-divine-text truncate">${reader.username}</p>
              <p class="text-[10px] text-blue-400 flex items-center gap-1">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>
                Read at ${timeStr}
              </p>
            </div>
          `;
        listEl.appendChild(div);
      });
    } catch (err) {
      listEl.innerHTML = `<div class="text-center text-xs text-red-400/80 py-4">${err.message}</div>`;
    }
  }


  // ── View Once Handlers ───────────────────────────────────────────────────
  function updateViewOnceBtn() {
    const btn = document.getElementById('viewOnceBtn');
    if (!btn) return;
    const hasMedia = pendingFiles && pendingFiles.length > 0;
    if (!hasMedia) {
      btn.classList.add('hidden');
      btn.style.display = 'none';
      isViewOnceActive = false;
      return;
    }

    // Media/file selected: reveal button
    btn.classList.remove('hidden');
    btn.style.display = 'inline-flex';

    if (isViewOnceActive) {
      btn.classList.add('active');
      btn.title = 'View Once is ON: Recipient can only view this media once';
    } else {
      btn.classList.remove('active');
      btn.title = 'View Once: Click to send as view once (disappears after viewing)';
    }
  }

  function toggleViewOnce() {
    const hasMedia = pendingFiles && pendingFiles.length > 0;
    if (!hasMedia) return;

    isViewOnceActive = !isViewOnceActive;
    updateViewOnceBtn();
    renderFilePreviews();
    if (isViewOnceActive) {
      showToast('Photo/video set to View Once', 'info');
    } else {
      showToast('View Once turned off', 'info');
    }
  }

  function handleViewOnceFileSelect(input) {
    const rawFiles = Array.from(input.files || []);
    if (!rawFiles.length) return;
    isViewOnceActive = true;
    addFilesToPending(rawFiles);
    input.value = '';
    updateViewOnceBtn();
    showToast('Photo/video staged as View Once', 'info');
  }

  function handleViewOnceOpened(data) {
    const msgId = String(data.message_id);
    const msgEl = document.getElementById(`msg-${msgId}`) || document.querySelector(`[data-message-id="${msgId}"]`);
    if (msgEl) {
      const voCard = msgEl.querySelector('.sdh-view-once-bubble') || msgEl.querySelector(`[id^="vo-card-"]`);
      if (voCard) {
        voCard.outerHTML = `
          <div class="sdh-view-once-bubble sdh-view-once-opened flex items-center gap-3 py-1.5 px-2 select-none">
            ${_buildViewOnceIconSvg({ opened: true, sizeClass: 'w-7 h-7', extraClass: 'sdh-view-once-badge' })}
            <div class="flex flex-col min-w-0">
              <span class="sdh-vo-title text-sm font-semibold tracking-wide">Opened</span>
              <span class="sdh-vo-sub text-[11px] leading-tight">View once</span>
            </div>
          </div>
        `;
      }
      const dropdown = msgEl.querySelector('.msg-dropdown');
      if (dropdown) {
        dropdown.querySelectorAll('button').forEach(btn => {
          if (btn.textContent.includes('Preview') || btn.textContent.includes('Download')) {
            btn.remove();
          }
        });
      }
    }
  }

  async function markViewOnceOpened(messageId) {
    if (!messageId) return;
    try {
      const csrf = window.SDH_DATA?.csrfToken || document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
      const res = await fetch(`/messaging/api/message/${messageId}/view-once-opened/`, {
        method: 'POST',
        headers: {
          'X-CSRFToken': csrf,
          'Content-Type': 'application/json',
        }
      });
      if (res.ok) {
        handleViewOnceOpened({ message_id: messageId });
      }
    } catch (e) {
      console.warn('[Chat] Failed to mark view-once opened:', e);
    }
  }

  function openViewOnceMedia(fileId, fileName, mimeType, messageType) {
    if (window.SDH?.MediaViewer) {
      window.SDH.MediaViewer.open({
        fileId: Number(fileId),
        fileName,
        mimeType,
        messageType,
        isViewOnce: true,
        messageId: Number(fileId),
      });
    }
  }

    // ── Aliases ─────────────────────────────────────────────────────────


  // â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  return {
    initializeChat,
    selectUser,
    sendMessage,
    onInput,
    onKeyDown,
    handleFileSelect,
    removeFile,
    clearFiles,
    clearFile,
    filterUsers,
    openSidebar,
    closeSidebar,
    toggleEmojiPicker,
    filterEmojiCategory,
    initEmojiPicker,
    insertEmoji,
    registerTempMessage,
    loadUnreadCounts,
    showToast,
    appendMessage,
    _onWsMessage,
    _onWsOpen,
    _onWsClose,
    _onWsReconnecting,
    // Professional deletion
    _toggleMsgMenu,
    _removeFromMyView,
    _confirmDeleteForAll,
    executeDeleteForAll,
    // Clear all chat
    _confirmClearChat,
    executeClearChat,
    // Remove user from my list
    _toggleUserMenu,
    _closeAllUserMenus,
    _confirmRemoveUser,
    executeRemoveUser,
    // Block contact
    _confirmBlockUser,
    executeBlockUser,
    // Unblock contact
    _confirmUnblockUser,
    executeUnblockUser,
    // Friend requests
    loadFriendRequests,
    sendFriendRequest,
    respondFriendRequest,
    // Unfriend
    _confirmUnfriend,
    executeUnfriend,
    // Badge util
    updateUnreadBadge,
    // Profiles
    openAvatarViewer,
    showUserProfile,
    showActiveUserProfile,
    copyProfileEmail,
    // Group Invites
    respondGroupInvite,
    openCreateGroupModal,
    closeCreateGroupModal,
    submitCreateGroup,
    openInviteMemberModal,
    closeInviteMemberModal,
    submitInviteMember,
    selectGroup,
    showGroupProfile,
    leaveCurrentGroup,
    disbandCurrentGroup,
    clearCurrentGroupChat,
    removeGroupMember,
    toggleSidebarKebab,
    deleteGroupFromSidebar,
    loadGroupHistory,
    showGroupMessageDetails,
    toggleKebabMenu,
    handleCallButtonClick,
    initiateGroupCall,
    openRetentionModal,
    closeRetentionModal,
    saveRetentionSetting,
    getActiveUser: () => activeUser,
    getActiveUserId: () => activeUserId,
    _resetConversationPanel,
    toggleViewOnce,
    openViewOnceMedia,
    markViewOnceOpened,
    handleViewOnceFileSelect,
    handleViewOnceOpened,
    // All Files & Media, Storage, and Starred Suite
    copyLink,
    switchMediaTab,
    loadProfileMedia,
    toggleSelectAllStorage,
    toggleMediaItemSelection,
    downloadSelectedStorage,
    deleteSelectedStorage,
    toggleStarMessage,
    toggleStarFromProfile,
    loadStarredMessages,
    jumpToMessage,
    handleMessageStarred,
    // Dedicated Workspaces
    openDedicatedMediaWorkspace,
    openDedicatedStorageWorkspace,
    openDedicatedStarredWorkspace,
    backToProfileModal,
    closeDedicatedWorkspace,
    switchWorkspaceView,
    switchDedicatedMediaTab,
    filterDedicatedMedia,
    clearDedicatedMediaSearch,
    loadDedicatedMedia,
    loadDedicatedStorage,
    toggleDedicatedSelectAllStorage,
    toggleDedicatedStorageItem,
    downloadDedicatedSelectedStorage,
    deleteDedicatedSelectedStorage,
    loadDedicatedStarred,
    filterDedicatedStarred,
    clearDedicatedStarredSearch,
    openUserProfileModal: (username, userId) => showUserProfile(username, userId),
    openGroupInfoModal: (groupId) => showGroupProfile(groupId),
    isCurrentChatGroup: () => Boolean(activeUser && activeUser.startsWith('group_')),
    getCurrentGroupMembers: () => currentGroupMembers,
    appendMessage: (opts, targetContainer) => appendMessage(opts, targetContainer),
    scrollToBottom: (instant) => scrollToBottom(instant),
  };

})();
