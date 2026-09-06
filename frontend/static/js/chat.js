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

SDH.Chat = (() => {

  // â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let activeUser = null;
  let activeUserId = null;
  let typingTimer = null;
  let isTyping = false;
  let pendingFile = null;
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
  const Notif = {
    requestPermission() {
      if (!('Notification' in window)) return;
      if (Notification.permission === 'default') Notification.requestPermission();
    },
    show(title, body, tag) {
      if (!('Notification' in window)) return;
      if (Notification.permission !== 'granted') return;
      if (document.visibilityState === 'visible') return;
      try {
        const n = new Notification(title, { body, tag, silent: false });
        n.onclick = () => { window.focus(); n.close(); };
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
      case 'typing': handleTypingIndicator(data); break;
      case 'delivered': _setMsgStatus(data.message_id, 'delivered'); break;
      case 'read_receipt': _markAllSentAsRead(); break;
      case 'message_status': _setMsgStatus(data.message_id, data.status); break;
      case 'presence': handlePresence(data); break;
      case 'message_removed': handleMessageRemoved(data); break;
      case 'chat_cleared': handleChatCleared(data); break;
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
      case 'new_moment': SDH.Moments?.handleNewMomentEvent?.(data.moment); break;
      case 'delete_moment': SDH.Moments?.handleDeleteMomentEvent?.(data.user_id, data.moment_id); break;
      case 'moment_viewed': SDH.Moments?.handleMomentViewedEvent?.(data.moment_id, data.viewer); break;
      case 'moment_reacted': SDH.Moments?.handleMomentReactedEvent?.(data.moment_id, data.reaction); break;
      case 'pong': break;
      case 'error':
        console.error('[Chat] Server error:', data.message);
        if (data?.message) showToast(data.message, 'error');
        break;
    }
  }

  async function handleFriendRequest(data) {
    await loadFriendRequests();
    showToast(`New friend request from ${data.sender}`, 'info');
    Notif.show(`New Friend Request`, `From ${data.sender}`, 'sdh-friend-request');
  }

  function handleFriendRequestAccepted(data) {
    showToast(`${data.new_friend} accepted your friend request!`, 'success');
    
    // Update internal state
    const u = window.SDH_DATA?.users?.find(x => x.username === data.new_friend);
    if (u) {
        u.is_friend = true;
    }
    
    _refreshSidebar();
    const searchInput = document.getElementById('searchUsers');
    if (searchInput?.value) SDH.Chat.filterUsers(searchInput.value);
  }

  function handleFriendRequestRejected(data) {
    // Refresh to allow sending a new request
    _refreshSidebar();
    const searchInput = document.getElementById('searchUsers');
    if (searchInput?.value) SDH.Chat.filterUsers(searchInput.value);
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
      const res = await fetch(location.href);
      const html = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const newUserListHTML = doc.getElementById('userList').innerHTML;
      const currentList = document.getElementById('userList');
      if (currentList) {
        currentList.innerHTML = newUserListHTML;
      }
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
    // Immediately notify the sender that we've read all messages in this chat
    if (activeUser && SDH.WS.isOpen() && !activeUser.startsWith('group_')) {
      SDH.WS.sendMessage({ type: 'read_receipt' });
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

        <div class="sdh-empty-divider mb-5"></div>
        <span class="sdh-empty-badge mb-3">SANDESH</span>
        <p class="sdh-empty-title mb-2">Select a contact to begin</p>
        <p class="sdh-empty-sub">Pick a conversation from the sidebar to start chatting</p>
      `;
  }

  function _setDefaultHeaderStatus() {
    if (_isSelfChat(activeUser)) {
      _setHeaderStatus('Only visible to you', 'connected');
    } else if (activeUser && activeUser.startsWith('group_')) {
      _setHeaderStatus('Group Chat', 'connected');
    } else {
      const userObj = window.SDH_DATA?.users?.find(u => u.username === activeUser);
      const userItem = document.getElementById(`user-item-${activeUser}`);
      const isBlocked = userItem?.dataset?.blocked === '1' || userItem?.dataset?.chatBlocked === '1';
      const isFriend = (userItem?.dataset?.friendship === 'friend') || (userObj ? userObj.is_friend : false);

      if (isBlocked || !isFriend) {
        _setHeaderStatus('', 'default');
      } else if (userObj && userObj.is_online) {
        _setHeaderStatus('Active', 'connected');
      } else if (userObj && userObj.last_seen) {
        _setHeaderStatus('Last seen ' + _relativeTime(userObj.last_seen), 'default');
      } else {
        _setHeaderStatus('Offline', 'default');
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

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  //  Incoming message handlers
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  async function handleIncomingMessage(data) {
    const isFromMe = data.sender === window.SDH_DATA.currentUser;

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
        return;
      }
      // If not upgraded, it was sent via REST (e.g., from moments.js)
      // Fall through to render it normally
    }

    const displayContent = data.message_type === 'text' ? (data.message || '') : null;

    const isGroupMsg = data.type === 'group_message' || !!data.group_id;
    const chatTarget = isGroupMsg ? `group_${data.group_id}` : (isFromMe ? data.receiver : data.sender);

    if (activeUser !== chatTarget) {
      if (!isFromMe) {
        unreadCounts[chatTarget] = (unreadCounts[chatTarget] || 0) + 1;
        updateUnreadBadge(chatTarget);

        let notifTitle = isGroupMsg ? `New message in Group` : `New message from ${data.sender}`;
        if (isGroupMsg && data.sender) notifTitle = `New message from ${data.sender} in Group`;

        Notif.show(
          notifTitle,
          data.message_type === 'text' ? (data.message || 'New message') : `📎 ${data.original_filename || 'File'}`,
          `sdh-${chatTarget}`,
        );
      }
      return;
    }

    if (renderedIds.has(String(data.message_id))) return;
    renderedIds.add(String(data.message_id));

    appendMessage({
      sender: data.sender, isFromMe: isFromMe, content: displayContent,
      messageType: data.message_type,
      originalFilename: data.original_filename, mimeType: data.mime_type,
      timestamp: data.timestamp, messageId: data.message_id,
      repliedMoment: data.replied_moment,
    });
    scrollToBottom();

    if (SDH.WS.isOpen()) {
      if (!activeUser.startsWith('group_')) {
        SDH.WS.sendMessage({ type: 'delivered_receipt', message_id: data.message_id });
        SDH.WS.sendMessage({ type: 'read_receipt' });
      } else {
        SDH.WS.sendMessage({ type: 'mark_read', message_id: data.message_id });
      }
    }
  }

  function appendSystemMessage(text) {
    const container = document.getElementById('messagesContainer');
    if (!container) return;
    const sep = document.createElement('div');
    sep.className = 'flex justify-center my-3 select-none';
    sep.innerHTML = `<span class="text-[11px] font-medium px-4 py-1.5 bg-divine-deep rounded-full border border-divine-gold/30 text-divine-gold/90">${escapeHtml(text)}</span>`;
    container.appendChild(sep);
    scrollToBottom();
  }

  function handleGroupMemberUpdate(data) {
    if (activeUser && activeUser.startsWith('group_')) {
      const gid = activeUser.split('_')[1];
      if (data.group_id == gid || (data.group_id === undefined)) {
        const modal = document.getElementById('userProfileModal');
        if (modal && !modal.classList.contains('hidden')) {
          SDH.Chat.showGroupProfile(gid);
        }
      }
    }
  }

  function handleChatSettingUpdate(data) {
    if (data.updated_by === activeUser || data.updated_by === window.SDH_DATA.currentUser) {
      const labels = { 2: '2 Days', 7: '1 Week', 30: '1 Month', 180: '6 Months' };
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
      Notif.show(
        `New file from ${data.sender}`,
        `📎 ${data.original_filename || 'File'}`,
        `sdh-${data.sender}`,
      );
      return;
    }

    if (renderedIds.has(String(data.message_id))) return;
    renderedIds.add(String(data.message_id));

    appendMessage({
      sender: data.sender, isFromMe: false, content: null,
      messageType: data.message_type,
      originalFilename: data.original_filename, mimeType: data.mime_type,
      timestamp: data.timestamp, messageId: data.message_id,
      hasServerFile: true, fileId: data.file_id,
    });
    scrollToBottom();

    if (SDH.WS.isOpen()) {
      if (!activeUser.startsWith('group_')) {
        SDH.WS.sendMessage({ type: 'delivered_receipt', message_id: data.message_id });
        SDH.WS.sendMessage({ type: 'read_receipt' });
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
    const bubble = document.getElementById(`msg-${message_id}`);

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

    const bubble = btn.closest('[data-message-id]');
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
    });
  }

  /** "Remove from My View" — hides the message only for the current user. */
  async function _removeFromMyView(btn) {
    const dropdown = btn.closest('.msg-dropdown');
    const bubble = (dropdown?._originalParent || btn).closest('[data-message-id]');
    const msgId = bubble?.dataset?.messageId;
    if (!msgId || msgId.startsWith('temp_')) return;
    btn.closest('.msg-dropdown')?.classList.add('hidden');
    try {
      const res = await fetch(`/messaging/api/message/${msgId}/remove-my-view/`, {
        method: 'POST',
        headers: { 'X-CSRFToken': window.SDH_DATA.csrfToken, 'Content-Type': 'application/json' },
      });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || res.statusText); }
      bubble.remove();
      _showRemoveMyViewToast();
    } catch (err) { showToast('Could not remove message: ' + err.message, 'error'); }
  }

  /** Opens the confirmation modal for "Delete for All Participants". */
  function _confirmDeleteForAll(btn) {
    const dropdown = btn.closest('.msg-dropdown');
    const bubble = (dropdown?._originalParent || btn).closest('[data-message-id]');
    const msgId = bubble?.dataset?.messageId;
    if (!msgId || msgId.startsWith('temp_')) return;
    btn.closest('.msg-dropdown')?.classList.add('hidden');
    const modal = document.getElementById('deleteForAllModal');
    if (modal) { modal.dataset.targetId = msgId; modal.classList.remove('hidden'); }
  }

  /** Executes the confirmed "Delete for All Participants" action. */
  async function executeDeleteForAll() {
    const modal = document.getElementById('deleteForAllModal');
    const msgId = modal?.dataset?.targetId;
    if (modal) modal.classList.add('hidden');
    if (!msgId) return;
    try {
      const res = await fetch(`/messaging/api/message/${msgId}/delete-for-all/`, {
        method: 'POST',
        headers: { 'X-CSRFToken': window.SDH_DATA.csrfToken, 'Content-Type': 'application/json' },
      });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || res.statusText); }
      showToast('Message deleted for all participants.', 'success');
    } catch (err) { showToast('Could not delete message: ' + err.message, 'error'); }
  }

  // Close open dropdowns on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.msg-menu-wrap')) {
      _closeAllMsgMenus();
    }
  }, false);

  // Close open user-context dropdowns on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.user-ctx-wrap') && !e.target.closest('.user-ctx-dropdown')) {
      _closeAllUserMenus();
    }
  }, false);

  // Close open kebab dropdown on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#kebabMenuWrapper')) {
      const dropdown = document.getElementById('kebabDropdown');
      if (dropdown) {
        dropdown.classList.add('hidden');
      }
    }

    // Close sidebar kebabs on outside click
    if (!e.target.closest('.sdh-sidebar-kebab')) {
      document.querySelectorAll('[id^="sidebarKebab-"]').forEach(el => el.classList.add('hidden'));
    }
  }, false);

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
    document.getElementById('callButtons')?.classList.add('hidden');
    document.getElementById('inputBar')?.classList.add('hidden');
  }

  /** Opens the "Remove User" confirmation modal for a sidebar contact. */
  function _confirmRemoveUser(userId, username) {
    // Close any open dropdown
    _closeAllUserMenus();
    const modal = document.getElementById('removeUserModal');
    if (!modal) return;
    modal.dataset.targetUserId = userId;
    modal.dataset.targetUsername = username;
    const nameEl = document.getElementById('removeUserModalName');
    if (nameEl) nameEl.textContent = username;
    modal.classList.remove('hidden');
  }

  /** Opens the "Block Contact" confirmation modal for the active conversation. */
  function _confirmBlockUser() {
    if (!activeUser || !activeUserId) return;
    if (_isSelfChat(activeUser)) return;

    const modal = document.getElementById('blockUserModal');
    if (!modal) return;

    modal.dataset.targetUserId = String(activeUserId);
    modal.dataset.targetUsername = String(activeUser);

    const nameEl = document.getElementById('blockUserModalName');
    if (nameEl) nameEl.textContent = activeUser;

    modal.classList.remove('hidden');
  }

  /** Executes the confirmed "Remove from My List" action. */
  async function executeRemoveUser() {
    const modal = document.getElementById('removeUserModal');
    if (!modal) return;
    const userId = modal.dataset.targetUserId;
    const username = modal.dataset.targetUsername;
    modal.classList.add('hidden');
    if (!userId) return;

    try {
      const res = await fetch(window.SDH_DATA.removeUserUrl, {
        method: 'POST',
        headers: {
          'X-CSRFToken': window.SDH_DATA.csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ target_user_id: parseInt(userId, 10) }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || res.statusText);
      }
      // Remove the user item from sidebar immediately
      _removeUserFromSidebar(username);
      // If this was the active conversation, reset panel
      if (activeUser === username) {
        _resetConversationPanel();
      }
      showToast(`${username} removed from your list.`, 'success');
    } catch (err) {
      showToast('Could not remove user: ' + err.message, 'error');
    }
  }

  /** Executes the confirmed "Block Contact" action.
   * WhatsApp-style: user stays in sidebar with a blocked indicator.
   */
  async function executeBlockUser() {
    const modal = document.getElementById('blockUserModal');
    if (!modal) return;
    const userId = modal.dataset.targetUserId;
    const username = modal.dataset.targetUsername;
    modal.classList.add('hidden');
    if (!userId || !username) return;

    try {
      const res = await fetch(window.SDH_DATA.removeUserUrl, {
        method: 'POST',
        headers: {
          'X-CSRFToken': window.SDH_DATA.csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ target_user_id: parseInt(userId, 10), block: true }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || res.statusText);
      }

      // Mark user item as blocked in sidebar (keep visible)
      const item = document.getElementById(`user-item-${username}`);
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

      // If this is the active conversation, update UI to blocked state
      if (activeUser === username) {
        _updateBlockUI(true);
      }

      showToast(`Blocked ${username}. Messages are disabled.`, 'success');
    } catch (err) {
      showToast('Could not block contact: ' + err.message, 'error');
    }
  }

  /** Opens the "Unblock Contact" confirmation modal. */
  function _confirmUnblockUser() {
    if (!activeUser || !activeUserId) return;
    if (_isSelfChat(activeUser)) return;

    const modal = document.getElementById('unblockUserModal');
    if (!modal) return;

    modal.dataset.targetUserId = String(activeUserId);
    modal.dataset.targetUsername = String(activeUser);

    const nameEl = document.getElementById('unblockUserModalName');
    if (nameEl) nameEl.textContent = activeUser;

    modal.classList.remove('hidden');
  }

  /** Executes the confirmed "Unblock Contact" action. */
  async function executeUnblockUser() {
    const modal = document.getElementById('unblockUserModal');
    if (!modal) return;
    const userId = modal.dataset.targetUserId;
    const username = modal.dataset.targetUsername;
    modal.classList.add('hidden');
    if (!userId || !username) return;

    try {
      const res = await fetch(window.SDH_DATA.unblockUserUrl, {
        method: 'POST',
        headers: {
          'X-CSRFToken': window.SDH_DATA.csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ target_user_id: parseInt(userId, 10) }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || res.statusText);
      }

      // Remove blocked state from sidebar
      const item = document.getElementById(`user-item-${username}`);
      if (item) {
        delete item.dataset.blocked;
        item.querySelector('.sdh-blocked-badge')?.remove();
      }

      // If this is the active conversation, restore normal UI
      if (activeUser === username) {
        _updateBlockUI(false);
      }

      showToast(`Unblocked ${username}. You can now exchange messages.`, 'success');
    } catch (err) {
      showToast('Could not unblock contact: ' + err.message, 'error');
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  //  Unfriend Contact
  // ═════════════════════════════════════════════════════════════════════

  /** Opens the "Unfriend" confirmation modal for a sidebar contact. */
  function _confirmUnfriend(userId, username) {
    _closeAllUserMenus();
    const modal = document.getElementById('unfriendUserModal');
    if (!modal) return;
    modal.dataset.targetUserId = String(userId);
    modal.dataset.targetUsername = String(username);
    const nameEl = document.getElementById('unfriendUserModalName');
    if (nameEl) nameEl.textContent = username;
    modal.classList.remove('hidden');
  }

  /** Executes the confirmed "Unfriend" action. */
  async function executeUnfriend() {
    const modal = document.getElementById('unfriendUserModal');
    if (!modal) return;
    const userId = modal.dataset.targetUserId;
    const username = modal.dataset.targetUsername;
    modal.classList.add('hidden');
    if (!userId || !username) return;

    try {
      const res = await fetch(window.SDH_DATA.unfriendUrl || '/users/api/unfriend/', {
        method: 'POST',
        headers: {
          'X-CSRFToken': window.SDH_DATA.csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ target_user_id: parseInt(userId, 10) }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || res.statusText);
      }

      // Remove the user entirely from the sidebar
      _removeUserFromSidebar(username);

      // If this was the active conversation, reset the panel
      if (activeUser === username) {
        _resetConversationPanel();
      }

      showToast(`You are no longer friends with ${username}.`, 'success');
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
      // UI cleared by the chat_cleared WebSocket event
    } catch (err) { showToast('Could not clear chat: ' + err.message, 'error'); }
  }

  /** Map: date-label string → separator DOM element (one per date). */
  const dateSeparators = new Map();
  const _esc = s => (s || '').replace(/'/g, '&#039;').replace(/"/g, '&quot;');

  function appendMessage(opts) {
    const container = document.getElementById('messagesContainer');
    if (!container) return;
    document.getElementById('emptyState')?.remove();

    const {
      sender, isFromMe, content, messageType,
      originalFilename, mimeType, timestamp, messageId,
      hasServerFile = false, fileId = null,
      isDelivered = false, isRead = false, repliedMoment = null
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
      messageType, content, originalFilename, mimeType, hasServerFile, fileId,
    });

    const isTemp = String(messageId).startsWith('temp_');

    // Determine initial tick status for outgoing messages
    let initTickStatus = '';
    if (isFromMe && !isTemp) {
      if (isRead) initTickStatus = 'read';
      else if (isDelivered) initTickStatus = 'delivered';
      else initTickStatus = 'sent';
    }

    const dlBtnHtml = (hasServerFile && fileId) ? `
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

    const bubble = document.createElement('div');
    bubble.id = `msg-${messageId}`;
    bubble.dataset.messageId = String(messageId);
    bubble.className = `flex ${isFromMe ? 'justify-end' : 'justify-start'} items-center gap-1.5 px-1 mb-1.5 animate-msg-appear group/msg`;
    bubble.innerHTML = `
        ${isFromMe ? menuHtml : ''}
        <div class="max-w-[85%] sm:max-w-[72%] space-y-0.5">
          ${!isFromMe
        ? `<p class="text-[11px] font-semibold text-divine-muted/70 pl-1 mb-0.5">${escapeHtml(sender)}</p>`
        : ''}
          <div class="msg-bubble px-3.5 py-2.5 rounded-2xl transition-shadow duration-300
            ${bubbleStyle}">
            ${repliedMomentHtml}
            ${innerHtml}
          </div>
          <div class="flex items-center gap-1 ${isFromMe ? 'justify-end pr-0.5' : 'justify-start pl-0.5'}">
            <span class="text-[11px] text-divine-muted/40 select-none">${time}</span>
            ${isFromMe ? `<span class="msg-status-tick leading-none select-none">${_tickHtml(initTickStatus)}</span>` : ''}
            ${(isFromMe && activeUser && activeUser.startsWith('group_') && !isTemp) ? `<button onclick="SDH.Chat.showGroupMessageDetails(${messageId})" class="ml-1 w-4 h-4 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white/50 hover:text-white/80 transition-colors" title="Message Details"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg></button>` : ''}
          </div>
        </div>
        ${!isFromMe ? menuHtml : ''}`;
    container.appendChild(bubble);
  }

  function _buildMessageContent({ messageType, content, originalFilename, mimeType,
    hasServerFile, fileId }) {
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

    if (messageType === 'text') {
      return `<p class="text-sm leading-relaxed break-words whitespace-pre-wrap">${escapeHtml(content || '')}</p>`;
    }

    if (messageType === 'image') {
      if (hasServerFile && fileId) {
        const fid = Number(fileId);
        setTimeout(() => {
          const imgEl = document.querySelector(`img[data-file-id="${fid}"][data-sdh-loaded=""]`);
          if (imgEl) SDH.FileUpload.downloadImage({ messageId: fid, mimeType, imgEl })
            .catch(e => console.error('[Chat] img load:', e));
        }, 120);
        return `
            <div class="file-msg media-msg">
              <div class="relative group/img overflow-hidden rounded-xl bg-divine-card/50 border border-divine-border/40 inline-block">
                <img src="" data-file-id="${fid}"
                    data-mime="${_esc(mimeType || 'image/jpeg')}" data-sdh-loaded=""
                    alt="${escapeHtml(originalFilename)}"
                    onclick="SDH.FileUpload.downloadImage({messageId:${fid},mimeType:this.dataset.mime,imgEl:this})"
                    class="max-w-xs max-h-56 rounded-xl object-cover cursor-pointer hover:opacity-95 transition-opacity"
                    loading="lazy" style="min-width:120px;min-height:80px;" />
                <button type="button"
                        onclick="event.stopPropagation(); SDH.FileUpload.downloadFile({messageId:${fid},fileName:'${_esc(originalFilename)}',mimeType:'${_esc(mimeType || 'image/jpeg')}',buttonEl:this})"
                        class="absolute top-2 right-2 px-2 py-1 rounded-lg bg-black/60 hover:bg-black/85 text-white/95 backdrop-blur-md border border-white/20 shadow-md hover:scale-105 active:scale-95 transition-all flex items-center gap-1.5 text-xs z-10 select-none cursor-pointer"
                        title="Download image">
                  <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                  </svg>
                  <span class="text-[10px] font-semibold tracking-wide">Save</span>
                </button>
              </div>
              <div class="flex items-center justify-between gap-2 mt-1.5 px-0.5 max-w-xs">
                <p class="text-[11px] text-divine-muted truncate flex-1 min-w-0" title="${escapeHtml(originalFilename)}">${escapeHtml(originalFilename)}</p>
                <button type="button"
                        onclick="SDH.FileUpload.downloadFile({messageId:${fid},fileName:'${_esc(originalFilename)}',mimeType:'${_esc(mimeType || 'image/jpeg')}',buttonEl:this})"
                        class="flex items-center gap-1 text-[11px] font-semibold text-divine-gold hover:text-divine-amber hover:underline transition-colors flex-shrink-0 select-none cursor-pointer"
                        title="Download ${escapeHtml(originalFilename)}">
                  <svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                  </svg>
                  <span>Download</span>
                </button>
              </div>
            </div>`;
      }
      return `
          <div class="file-msg media-msg">
            <div class="relative overflow-hidden rounded-xl bg-divine-card/50 border border-divine-border/40 inline-block">
              <img src="#" data-mime="${_esc(mimeType)}"
                  alt="${escapeHtml(originalFilename)}"
                  class="max-w-xs max-h-56 rounded-xl object-cover"
                  loading="lazy" />
            </div>
            <p class="text-[11px] text-divine-muted mt-1 truncate block max-w-full">${escapeHtml(originalFilename)}</p>
          </div>`;
    }

    if (messageType === 'video') {
      if (hasServerFile && fileId) {
        const fid = Number(fileId);
        return `
            <div class="file-msg media-msg">
              <div class="flex items-center gap-3 p-3 rounded-xl bg-divine-deep/60
                          border border-divine-border/50 hover:border-divine-gold/40 transition-all max-w-xs">
                <div class="w-10 h-10 rounded-lg bg-divine-gold/15 flex items-center justify-center text-xl flex-shrink-0 select-none">
                  🎬
                </div>
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-medium text-divine-text truncate" title="${escapeHtml(originalFilename)}">${escapeHtml(originalFilename)}</p>
                  <p class="text-xs text-divine-muted">Video · tap to download</p>
                </div>
                <button type="button"
                        onclick="SDH.FileUpload.downloadFile({messageId:${fid},fileName:'${_esc(originalFilename)}',mimeType:'${_esc(mimeType || 'video/mp4')}',buttonEl:this})"
                        class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-divine-gold/20 hover:bg-divine-gold/30 text-divine-gold text-xs font-semibold hover:scale-[1.02] active:scale-[0.98] transition-all flex-shrink-0 cursor-pointer"
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
          <div class="file-msg media-msg">
            <div class="flex items-center gap-2.5 p-3 rounded-xl bg-divine-deep/60
                        border border-divine-border/50 max-w-xs">
              <span class="text-2xl select-none">🎬</span>
              <div class="min-w-0">
                <p class="text-sm font-medium text-divine-text truncate">${escapeHtml(originalFilename)}</p>
                <p class="text-xs text-divine-muted">Video</p>
              </div>
            </div>
          </div>`;
    }

    // Generic file
    const fileIcon = '📄';
    if (hasServerFile && fileId) {
      const fid = Number(fileId);
      return `
          <div class="file-msg">
            <div class="flex items-center gap-3 p-3 rounded-xl bg-divine-deep/60
                        border border-divine-border/50 cursor-pointer hover:border-divine-gold/40 transition-all"
                onclick="SDH.FileUpload.downloadFile({messageId:${fid},fileName:'${_esc(originalFilename)}',mimeType:'${_esc(mimeType || 'application/octet-stream')}',buttonEl:this})">
              <span class="text-2xl select-none">${fileIcon}</span>
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium text-divine-text truncate">${escapeHtml(originalFilename)}</p>
                <p class="text-xs text-divine-muted">Tap to download</p>
              </div>
              <svg class="w-4 h-4 flex-shrink-0 text-divine-muted/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
              </svg>
            </div>
          </div>`;
    }
    return `
        <div class="file-msg">
          <div class="flex items-center gap-3 p-3 rounded-xl bg-divine-deep/60
                      border border-divine-border/50">
            <span class="text-2xl select-none">${fileIcon}</span>
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
  async function sendMessage() {
    if (!activeUser || !activeUserId) return;
    if (!SDH.WS.isOpen()) {
      showToast('Connection lost. Reconnecting...', 'warning');
      SDH.WS.connectWebSocket(activeUserId);
      return;
    }

    const input = document.getElementById('messageInput');
    const rawText = input.value.trim();
    if (!rawText && !pendingFile) return;

    try {
      if (pendingFile) {
        const { file } = pendingFile;
        clearFile();
        const hideUploadIndicator = showPersistentNotification('Uploading file...', 'info');
        let msgData;
        try {
          msgData = await SDH.FileUpload.handleFileUpload(
            file, activeUser, stage => console.debug('[Chat] File upload:', stage),
          );
        } catch (uploadErr) {
          console.error('[Chat] File upload error:', uploadErr);
          hideUploadIndicator();
          showToast(uploadErr.message || 'File upload failed.', 'error');
          return;
        }
        hideUploadIndicator();
        const tempId = `temp_${Date.now()}`;
        appendMessage({
          sender: window.SDH_DATA.currentUser, isFromMe: true, content: null,
          messageType: msgData.message_type,
          originalFilename: msgData.original_filename, mimeType: msgData.mime_type,
          timestamp: msgData.timestamp, messageId: tempId,
          hasServerFile: true, fileId: msgData.file_id,
        });
        scrollToBottom();
        showToast('File sent \u2713', 'success');
        return;
      }

      // Text message
      const payload = { type: 'chat_message', receiver: activeUser, message_type: 'text', message: rawText };
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
      return '<span style="color:#FF9933;font-size:11px;letter-spacing:-1px;">✓✓</span>';
    }
    if (status === 'delivered') {
      return '<span style="color:rgba(255,255,255,0.55);font-size:11px;letter-spacing:-1px;">✓✓</span>';
    }
    if (status === 'sent') {
      return '<span style="color:rgba(255,255,255,0.55);font-size:11px;">✓</span>';
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

  function appendSystemMessage(text) {
    const container = document.getElementById('messagesContainer');
    if (!container) return;
    container.insertAdjacentHTML('beforeend', `
        <div class="flex justify-center my-4">
          <span class="px-3 py-1 rounded-full bg-divine-surface text-divine-muted text-xs font-medium border border-divine-border">
            ${escapeHtml(text)}
          </span>
        </div>`);
    scrollToBottom();
  }

  //  Typing indicator
  // â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
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
    // Keep self-chat label/status stable in the UI.
    if (_isSelfChat(data.username)) return;

    const u = window.SDH_DATA?.users?.find(x => x.username === data.username);
    if (u && !u.is_friend) return; // Ignore presence updates for non-friends

    const userItem = document.getElementById(`user-item-${data.username}`);
    const isBlocked = userItem?.dataset?.blocked === '1' || userItem?.dataset?.chatBlocked === '1';
    const userObj = window.SDH_DATA?.users?.find(u => u.username === data.username);
    const isFriend = userItem?.dataset?.friendship === 'friend' || (userObj && userObj.is_friend);
    
    const isActive = data.status === 'active' && !isBlocked && isFriend;

    // Update sidebar status dot using CSS module classes (sdh-online-dot--on/off)
    const dot = document.getElementById(`online-dot-${data.username}`);
    if (dot && isFriend) {
      dot.classList.remove('sdh-online-dot--on', 'sdh-online-dot--off');
      dot.classList.add(isActive ? 'sdh-online-dot--on' : 'sdh-online-dot--off');
    }

    // Update last-seen sub-label in sidebar
    const lsEl = document.getElementById(`last-seen-${data.username}`);
    if (lsEl) {
      if (isBlocked || !isFriend) {
        lsEl.innerHTML = '&nbsp;';
        lsEl.className = 'text-[11px] sdh-status-inactive truncate mt-0.5';
      } else if (isActive) {
        lsEl.textContent = '● Active';
        lsEl.className = 'text-[11px] sdh-status-active truncate mt-0.5';
      } else if (data.last_seen) {
        lsEl.textContent = 'Last seen ' + _relativeTime(data.last_seen);
        lsEl.className = 'text-[11px] sdh-status-inactive truncate mt-0.5';
      } else {
        lsEl.textContent = 'Inactive';
        lsEl.className = 'text-[11px] sdh-status-inactive truncate mt-0.5';
      }
    }

    // Update internal user cache so if we select them later, it's correct
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
        _setHeaderStatus('Active', 'connected');
      } else {
        const rel = data.last_seen ? 'Last seen ' + _relativeTime(data.last_seen) : 'Offline';
        _setHeaderStatus(rel, 'disconnected');
      }
    }

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
    if (activeUser === username) return;
    activeUser = username; activeUserId = userId;
    sessionStorage.setItem('ndm_last_chat', username);
    if (userId) sessionStorage.setItem('ndm_last_chat_id', String(userId));

    if (SDH.WS) {
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
    if (!_isSelfChat(username)) SDH.WebRTC?.setRemoteUser(username);
    Notif.requestPermission();
  }

  function handleGroupMemberUpdate(data) {
    if (activeUser && activeUser.startsWith('group_')) {
      const gid = activeUser.split('_')[1];
      if (data.group_id == gid || (data.group_id === undefined)) {
        const modal = document.getElementById('userProfileModal');
        if (modal && !modal.classList.contains('hidden')) {
          SDH.Chat.showGroupProfile(gid);
        }
      }
    }
  }

  function handleChatSettingUpdate(data) {
    if (data.sender === activeUser && data.retention_days) {
      appendSystemMessage(`Retention set to ${data.retention_days} days.`);
    }
  }

  // â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
  //  Load history
  // â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
  async function loadHistory(username) {
    const container = document.getElementById('messagesContainer');
    try {
      const res = await fetch(`${window.SDH_DATA?.historyUrl || '/messaging/api/history/'}${username}/`);
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();

      if (container) container.innerHTML = '';
      dateSeparators.clear();

      if (data.messages.length === 0) {
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

      for (const msg of data.messages) {
        const isFromMe = msg.sender === window.SDH_DATA.currentUser;
        // Deleted-for-all messages render as a placeholder; no menu shown
        const effectiveType = msg.is_deleted_for_all ? 'deleted' : msg.message_type;
        const content = effectiveType === 'text' ? (msg.message || '') : null;
        renderedIds.add(String(msg.id));
        appendMessage({
          sender: msg.sender, isFromMe, content,
          messageType: effectiveType,
          originalFilename: msg.original_filename, mimeType: msg.mime_type,
          timestamp: msg.timestamp, messageId: msg.id,
          hasServerFile: !msg.is_deleted_for_all && (msg.has_file || false),
          fileId: msg.is_deleted_for_all ? null : (msg.file_id || null),
          isDelivered: msg.is_delivered || false,
          isRead: msg.is_read || false,
          repliedMoment: msg.replied_moment,
        });
      }

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
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  }

  // â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
  //  File handling
  // â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
  function handleFileSelect(input) {
    const file = input.files[0];
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) { showToast('File too large. Maximum 5 MB.', 'error'); input.value = ''; return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      pendingFile = { file, arrayBuffer: e.target.result };
      const preview = document.getElementById('filePreview');
      const name = document.getElementById('filePreviewName');
      if (preview && name) {
        name.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
        preview.classList.remove('hidden');
      }
    };
    reader.readAsArrayBuffer(file);
    input.value = '';
  }

  function clearFile() {
    pendingFile = null;
    document.getElementById('filePreview')?.classList.add('hidden');
  }


  // â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
  //  Emoji picker
  // â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• 
  function toggleEmojiPicker() { document.getElementById('emojiPicker')?.classList.toggle('hidden'); }

  function insertEmoji(emoji) {
    const input = document.getElementById('messageInput');
    if (input) {
      const pos = input.selectionStart ?? input.value.length;
      input.value = input.value.slice(0, pos) + emoji + input.value.slice(pos);
      input.focus(); input.setSelectionRange(pos + emoji.length, pos + emoji.length);
    }
  }

  document.addEventListener('click', (e) => {
    const picker = document.getElementById('emojiPicker');
    if (picker && !picker.contains(e.target) && !e.target.closest('[onclick*="toggleEmojiPicker"]'))
      picker.classList.add('hidden');
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

  function scrollToBottom(instant = false) {
    const el = document.getElementById('messagesContainer');
    if (!el) return;
    if (instant) {
      el.scrollTop = el.scrollHeight;
    } else {
      requestAnimationFrame(() => {
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

  function showToast(message, type = 'info') {
    // Avoid duplicate consecutive toasts in the queue
    const lastInQueue = toastQueue[toastQueue.length - 1];
    if (lastInQueue && lastInQueue.message === message) return;

    // Also avoid duplicate with currently showing toast
    const currentlyShowingEl = document.getElementById('chatToastContainer')?.firstElementChild;
    if (currentlyShowingEl && currentlyShowingEl.textContent === message) return;

    toastQueue.push({ message, type });
    processToastQueue();
  }

  function processToastQueue() {
    if (isShowingToast || toastQueue.length === 0) return;
    isShowingToast = true;

    const { message, type } = toastQueue.shift();

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
    toast.className = `pointer-events-auto px-5 py-3 rounded-xl border text-sm shadow-2xl animate-slide-in
                        ${colors[type] || colors.info}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.transition = 'opacity 0.4s';
      toast.style.opacity = '0';
      setTimeout(() => {
        toast.remove();
        isShowingToast = false;
        processToastQueue();
      }, 400);
    }, 2200);
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
    // Check if already open
    if (document.getElementById(`group-invite-modal-${invite.invite_id}`)) return;

    const modalHtml = `
        <div id="group-invite-modal-${invite.invite_id}" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in">
          <div class="bg-divine-card border border-divine-border rounded-2xl p-6 w-full max-w-sm shadow-2xl transform transition-all relative overflow-hidden" style="box-shadow: 0 10px 40px -10px rgba(0,0,0,0.1);">
            <!-- Decorative accent -->
            <div class="absolute -top-10 -right-10 w-32 h-32 rounded-full blur-2xl" style="background:rgba(139,92,246,0.1);"></div>
            
            <div class="flex items-center gap-4 mb-5">
              <div class="w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 text-xl font-bold" style="background:rgba(139,92,246,0.15); color:rgba(139,92,246,0.9);">
                ${(invite.group_name && invite.group_name[0]) ? invite.group_name[0].toUpperCase() : 'G'}
              </div>
              <div>
                <h3 class="text-lg font-bold text-divine-text leading-tight">Group Invitation</h3>
                <p class="text-sm text-divine-muted mt-1"><span class="font-medium" style="color:rgba(139,92,246,0.9);">${invite.inviter}</span> invited you to join <span class="text-divine-text font-medium">${invite.group_name}</span></p>
              </div>
            </div>
            
            <div class="flex gap-3 mt-6">
              <button onclick="SDH.Chat.respondGroupInvite(${invite.invite_id}, 'decline')" class="flex-1 py-2.5 rounded-xl border border-divine-border text-divine-muted hover:bg-divine-border/50 hover:text-divine-text font-medium text-sm transition-all focus:outline-none focus:ring-2 focus:ring-divine-border">
                Decline Invite
              </button>
              <button onclick="SDH.Chat.respondGroupInvite(${invite.invite_id}, 'accept')" class="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-purple-500 to-indigo-500 text-white hover:from-purple-600 hover:to-indigo-600 font-bold text-sm transition-all shadow-lg hover:shadow-xl hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-purple-500/50">
                Join Group
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
      setTimeout(() => modal.remove(), 200);
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
        showToast(action === 'accept' ? 'Joined group successfully!' : 'Invite declined.', 'success');
        if (action === 'accept') {
          // Soft refresh sidebar instead of full reload
          _refreshSidebar();
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
            <div class="flex items-center gap-2 py-1.5" data-fr-id="${fr.id}">
              <div class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold select-none"
                style="background:rgba(139,92,246,0.15);color:rgba(139,92,246,0.9);">
                ${escapeHtml((fr.username || '?')[0].toUpperCase())}
              </div>
              <span class="text-xs font-medium flex-1 truncate" style="color:var(--c-text)">${escapeHtml(fr.username)}</span>
              <button onclick="SDH.Chat.respondFriendRequest(${fr.id}, 'accept')" class="text-[10px] font-semibold px-2 py-1 rounded-lg transition-colors"
                style="background:rgba(74,222,128,0.15);color:rgba(74,222,128,0.9);">
                Accept
              </button>
              <button onclick="SDH.Chat.respondFriendRequest(${fr.id}, 'reject')" class="text-[10px] font-semibold px-2 py-1 rounded-lg transition-colors"
                style="background:rgba(239,68,68,0.1);color:rgba(239,68,68,0.7);">
                Reject
              </button>
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
        _refreshSidebar();
        const searchInput = document.getElementById('searchUsers');
        if (searchInput?.value) SDH.Chat.filterUsers(searchInput.value);
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

  async function respondFriendRequest(requestId, action) {
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

      // If accepted, refresh the sidebar to show the new friend
      if (action === 'accept') {
        _refreshSidebar();
        const searchInput = document.getElementById('searchUsers');
        if (searchInput?.value) SDH.Chat.filterUsers(searchInput.value);
      }

      // Remove the request from the UI
      const frEl = document.querySelector(`[data-fr-id="${requestId}"]`);
      if (frEl) frEl.remove();

      // Hide panel if no more requests
      const remaining = document.querySelectorAll('#friendRequestsList [data-fr-id]');
      if (remaining.length === 0) {
        document.getElementById('friendRequestsPanel')?.classList.add('hidden');
      } else {
        const badge = document.getElementById('frCountBadge');
        if (badge) badge.textContent = String(remaining.length);
      }

      if (action === 'accept') {
        showToast('Friend request accepted! They now appear in your chat list.', 'success');
        // Soft refresh sidebar instead of full reload
        _refreshSidebar();
      } else {
        showToast('Friend request rejected.', 'info');
      }
    } catch (err) {
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

  async function showUserProfile(username, userId) {
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
    if (inviteBtnInit) inviteBtnInit.classList.add('hidden');

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
    avatarWrapper.style.borderColor = 'rgba(168,85,247,0.3)';
    avatarWrapper.style.boxShadow = '0 0 20px rgba(168,85,247,0.15)';
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

          membersList.innerHTML = groupData.members.map(m => {
            const isMe = m.username === window.SDH_DATA.currentUser;
            const canRemove = isAdminOrOwner && !isMe && m.role !== 'owner';
            return `
              <div class="flex items-center justify-between hover:bg-white/5 p-2 rounded-xl transition-colors">
                <div class="flex items-center gap-3 cursor-pointer flex-1 min-w-0" onclick="document.getElementById('userProfileModal').classList.add('hidden'); SDH.Chat.showUserProfile('${m.username}', ${m.user_id})">
                  ${m.avatar_url ?
                `<img src="${m.avatar_url}" class="w-8 h-8 rounded-full object-cover bg-divine-surface" />` :
                `<div class="w-8 h-8 rounded-full bg-divine-surface border border-divine-border flex items-center justify-center text-xs font-bold text-divine-text shrink-0">${m.username[0].toUpperCase()}</div>`
              }
                  <div class="flex-1 min-w-0">
                    <p class="text-[13px] font-bold truncate text-divine-text">${isMe ? 'You' : (m.display_name || m.username)}</p>
                    <p class="text-[10px] uppercase tracking-widest text-divine-gold truncate">
                      ${m.role}
                      <span class="mx-1 opacity-50 capitalize normal-case font-normal text-divine-muted">•</span>
                      <span class="normal-case tracking-normal font-medium ${m.is_online ? 'text-green-500' : 'text-divine-muted/70'}">${m.state === 'invited' ? 'Invited' : (m.is_online ? 'Active' : (m.last_seen ? 'Last seen ' + _relativeTime(m.last_seen) : 'Offline'))}</span>
                    </p>
                  </div>
                </div>
                ${canRemove ? `<button onclick="SDH.Chat.removeGroupMember(${groupId}, ${m.user_id})" class="ml-2 text-red-400 hover:text-red-300 text-[11px] font-bold px-2.5 py-1.5 bg-red-400/10 hover:bg-red-400/20 rounded-lg transition-colors border border-red-400/20 whitespace-nowrap">Remove</button>` : ''}
              </div>
            `}).join('');

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

      // Update bio
      bioEl.textContent = data.bio ? data.bio : (isGroup ? 'No description provided.' : 'No biography provided.');
      if (!data.bio || data.bio === 'No description provided.') {
        bioEl.classList.add('text-divine-muted');
        bioEl.classList.remove('text-divine-text');
      } else {
        bioEl.classList.remove('text-divine-muted');
        bioEl.classList.add('text-divine-text');
      }

      // Update contacts
      emailEl.textContent = data.email || 'No email shared';
      phoneEl.textContent = data.phone_number || 'Not specified';

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
        if (data.is_online && !isBlocked) {
          statusDot.className = 'w-2 h-2 rounded-full sdh-pulse-dot bg-green-500';
          statusText.textContent = 'Active';
          statusText.className = 'text-[11px] font-bold uppercase tracking-widest text-green-400';
          avatarWrapper.style.borderColor = 'rgba(74,222,128,0.5)';
          avatarWrapper.style.boxShadow = '0 0 25px rgba(74,222,128,0.25)';
          lastSeenEl.textContent = 'Active now';
        } else {
          statusDot.className = 'w-2 h-2 rounded-full bg-purple-500/50';
          statusText.textContent = isBlocked ? 'Blocked' : 'Offline';
          statusText.className = 'text-[11px] font-bold uppercase tracking-widest text-divine-muted';
          avatarWrapper.style.borderColor = 'rgba(168,85,247,0.3)';
          avatarWrapper.style.boxShadow = '0 0 20px rgba(168,85,247,0.15)';
          if (isBlocked) {
            lastSeenEl.textContent = 'Blocked';
          } else if (data.last_seen) {
            lastSeenEl.textContent = 'Last seen ' + _relativeTime(data.last_seen);
          } else {
            lastSeenEl.textContent = 'Offline';
          }
        }
      }

      // Wire message button
      messageBtn.onclick = () => {
        modal.classList.add('hidden');
        selectUser(data.username, userId);
      };

    } catch (err) {
      console.error('[Chat] showUserProfile error:', err);
      displayNameEl.textContent = 'Error Loading Profile';
      bioEl.textContent = err.message || 'Could not load profile details.';
      bioEl.classList.add('text-red-400/80');
      showToast(err.message || 'Could not load profile details.', 'error');
    }
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
    }
  }

  function handleCallButtonClick(callType) {
    if (activeUser && activeUser.startsWith('group_')) {
      initiateGroupCall(callType);
    } else {
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
        list.innerHTML = '<p class="sdh-cg-empty-msg text-xs p-3 text-center">No other users available.</p>';
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
      if (!res.ok) throw new Error(await res.text());
      showToast('Group created successfully!', 'success');
      closeCreateGroupModal();
      _refreshSidebar();
    } catch (err) {
      showToast('Failed to create group: ' + err.message, 'error');
    }
  }

  async function selectGroup(groupId, groupName) {
    if (window.innerWidth < 640) closeSidebar();
    if (activeUser === `group_${groupId}`) return;
    activeUser = `group_${groupId}`;
    activeUserId = groupId;
    sessionStorage.setItem('ndm_last_chat', activeUser);
    sessionStorage.setItem('ndm_last_chat_id', String(groupId));
    if (groupName) sessionStorage.setItem('ndm_last_chat_name', groupName);

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
        if (gInfo.avatar_url && avatarEl) {
          avatarEl.innerHTML = `<img src="${gInfo.avatar_url}" class="w-full h-full object-cover rounded-full" alt="" onerror="this.parentElement.innerHTML = '${(gInfo.name && gInfo.name[0] ? gInfo.name[0] : 'G').toUpperCase()}';">`;
        }
        if (gInfo.name && usernameEl) {
          usernameEl.textContent = gInfo.name;
          sessionStorage.setItem('ndm_last_chat_name', gInfo.name);
        }
      }
    } catch (e) { }

    await loadGroupHistory(groupId, groupName);

    unreadCounts[`group_${groupId}`] = 0;
    updateUnreadBadge(`group_${groupId}`);

    _setHeaderStatus('Group Chat', 'connected');
    closeSidebar();
    if (window.Notif) Notif.requestPermission();

    if (SDH.WS) {
      SDH.WS.connectWebSocket(groupId, true); // true for isGroup
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
        membersListEl.innerHTML = '';
        const isAdminOrOwner = data.my_role === 'owner' || data.my_role === 'admin';

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

        data.members.forEach(member => {
          const isMe = member.user_id === window.SDH_DATA.userId;
          const canRemove = isAdminOrOwner && !isMe && member.role !== 'owner';
          const div = document.createElement('div');
          div.className = 'flex items-center justify-between hover:bg-white/5 p-2 rounded-xl transition-colors mb-2';
          div.innerHTML = `
              <div class="flex items-center gap-3 cursor-pointer flex-1 min-w-0" onclick="document.getElementById('userProfileModal').classList.add('hidden'); SDH.Chat.showUserProfile('${member.username}', ${member.user_id})">
                ${member.avatar_url ?
              `<img src="${member.avatar_url}" class="w-8 h-8 rounded-full object-cover bg-divine-surface" />` :
              `<div class="w-8 h-8 rounded-full bg-divine-surface border border-divine-border flex items-center justify-center text-xs font-bold text-divine-text shrink-0">${member.username[0].toUpperCase()}</div>`
            }
                <div class="flex-1 min-w-0">
                  <p class="text-[13px] font-bold truncate text-divine-text">${isMe ? 'You' : (member.display_name || member.username)}</p>
                  <p class="text-[10px] uppercase tracking-widest text-divine-gold truncate">
                    ${member.role}
                    <span class="mx-1 opacity-50 capitalize normal-case font-normal text-divine-muted">•</span>
                    <span class="normal-case tracking-normal font-medium ${member.is_online ? 'text-green-500' : 'text-divine-muted/70'}">${member.state === 'invited' ? 'Invited' : (member.is_online ? 'Active' : (member.last_seen ? 'Last seen ' + _relativeTime(member.last_seen) : 'Offline'))}</span>
                  </p>
                </div>
              </div>
              ${canRemove ? `<button onclick="SDH.Chat.removeGroupMember(${data.id}, ${member.user_id})" class="ml-2 text-red-400 hover:text-red-300 text-[11px] font-bold px-2.5 py-1.5 bg-red-400/10 hover:bg-red-400/20 rounded-lg transition-colors border border-red-400/20 whitespace-nowrap">Remove</button>` : ''}
            `;
          membersListEl.appendChild(div);
        });
      }

      const disbandBtn = document.getElementById('disbandGroupBtn');
      if (disbandBtn) {
        if (data.my_role === 'owner' || data.my_role === 'admin') disbandBtn.classList.remove('hidden');
        else disbandBtn.classList.add('hidden');
      }
    } catch (err) {
      displayNameEl.textContent = 'Error Loading Group';
      bioEl.textContent = 'Could not load group details.';
      bioEl.classList.add('text-red-400/80');
      showToast(err.message, 'error');
    }
  }

  async function removeGroupMember(groupId, userId) {
    if (!confirm('Are you sure you want to remove this member?')) return;
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
      showToast('Member removed successfully', 'success');
      showGroupProfile(groupId);
    } catch (err) {
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
      if (!res.ok) throw new Error(res.statusText);
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
          appendSystemMessage(sysMsg);
          continue;
        }

        const content = effectiveType === 'text' ? (msg.message || '') : null;
        renderedIds.add(String(msg.id));
        appendMessage({
          sender: msg.sender,
          isFromMe: isFromMe,
          content: content,
          messageType: effectiveType,
          originalFilename: msg.original_filename,
          mimeType: msg.mime_type,
          timestamp: msg.timestamp,
          messageId: msg.id,
          hasServerFile: msg.has_file,
          fileId: msg.file_id,
          isDelivered: true,
          isRead: true
        });
      }
      scrollToBottom();
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

  // ── Aliases ─────────────────────────────────────────────────────────


  // â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  return {
    initializeChat,
    selectUser,
    sendMessage,
    onInput,
    onKeyDown,
    handleFileSelect,
    clearFile,
    filterUsers,
    openSidebar,
    closeSidebar,
    toggleEmojiPicker,
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
  };

})();
