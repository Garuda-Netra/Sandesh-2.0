(function () {
  'use strict';

  window.SDH = window.SDH || {};

  const STORAGE_KEY = 'sdh_bot_history_v1';
  const OPEN_KEY = 'sdh_bot_open_v1';
  const MAX_HISTORY = 24;

  const Chatbot = {
    init() {
      this.panel = document.getElementById('sdhBotPanel');
      this.toggleBtn = document.getElementById('sdhBotToggle');
      this.closeBtn = document.getElementById('sdhBotClose');
      this.clearBtn = document.getElementById('sdhBotClear');
      this.messagesEl = document.getElementById('sdhBotMessages');
      this.inputEl = document.getElementById('sdhBotInput');
      this.sendBtn = document.getElementById('sdhBotSend');
      this.suggestionsEl = document.getElementById('sdhBotSuggestions');

      if (!this.panel || !this.toggleBtn || !this.messagesEl || !this.inputEl || !this.sendBtn) {
        return;
      }

      this.apiUrl = window.SDH_CHATBOT?.apiUrl || '/messaging/api/chatbot/';
      this.userName = window.SDH_CHATBOT?.userName || '';

      this.toggleBtn.addEventListener('click', () => this.toggle());
      this.closeBtn?.addEventListener('click', () => this.close());
      this.clearBtn?.addEventListener('click', () => this.clear());
      this.sendBtn.addEventListener('click', () => this.send());

      this.inputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          this.send();
        }
      });

      this.inputEl.addEventListener('input', () => this.autoResize());

      this.suggestionsEl?.querySelectorAll('[data-prompt]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const prompt = btn.getAttribute('data-prompt') || '';
          if (!prompt) return;
          this.inputEl.value = prompt;
          this.autoResize();
          this.send();
        });
      });

      this.restore();
      this.scrollToBottom();

      if (!this.messagesEl.children.length) {
        const greeting = this.userName
          ? `Hi ${this.userName}, I am Vyasa. How can I help?`
          : 'Hi, I am Vyasa. How can I help?';
        this.appendMessage('assistant', greeting);
      }

      if (this.isOpen()) {
        this.open(false);
      }

      this.fetchPendingWishes();
    },

    fetchPendingWishes() {
      fetch('/messaging/api/chatbot/pending-wishes/')
        .then(res => res.json())
        .then(data => {
          if (data.status === 'ok' && data.wishes && data.wishes.length > 0) {
            data.wishes.forEach(w => this.receiveWish(w.message));
          }
        })
        .catch(err => console.error('Error fetching pending wishes:', err));
    },

    receiveWish(message) {
      this.appendMessage('assistant', message);
      if (!this.isOpen()) {
        // Add a notification badge to the toggle button
        if (!this.toggleBtn.querySelector('.sdh-bot-badge')) {
          const badge = document.createElement('span');
          badge.className = 'sdh-bot-badge absolute -top-1 -right-1 flex h-3 w-3';
          badge.innerHTML = '<span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-divine-gold opacity-75"></span><span class="relative inline-flex rounded-full h-3 w-3 bg-divine-gold"></span>';
          this.toggleBtn.appendChild(badge);
        }
      }
    },

    isOpen() {
      return localStorage.getItem(OPEN_KEY) === '1';
    },

    open(updateState = true) {
      this.panel.classList.add('is-open');
      this.panel.setAttribute('aria-hidden', 'false');
      this.toggleBtn.setAttribute('aria-expanded', 'true');
      if (updateState) {
        localStorage.setItem(OPEN_KEY, '1');
      }
      this.scrollToBottom();
      
      // Remove badge if present
      const badge = this.toggleBtn.querySelector('.sdh-bot-badge');
      if (badge) badge.remove();
    },

    close() {
      this.panel.classList.remove('is-open');
      this.panel.setAttribute('aria-hidden', 'true');
      this.toggleBtn.setAttribute('aria-expanded', 'false');
      localStorage.setItem(OPEN_KEY, '0');
    },

    toggle() {
      if (this.panel.classList.contains('is-open')) {
        this.close();
      } else {
        this.open();
      }
    },

    clear() {
      localStorage.removeItem(STORAGE_KEY);
      this.messagesEl.innerHTML = '';
      const greeting = this.userName
        ? `Fresh slate, ${this.userName}. What should we work on?`
        : 'Fresh slate. What should we work on?';
      this.appendMessage('assistant', greeting);
    },

    autoResize() {
      this.inputEl.style.height = 'auto';
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + 'px';
    },

    send() {
      const text = (this.inputEl.value || '').trim();
      if (!text) return;

      const history = this.buildApiHistory();

      this.appendMessage('user', text);
      this.inputEl.value = '';
      this.autoResize();

      const typingEl = this.showTyping();
      this.sendBtn.disabled = true;

      const payload = {
        message: text,
        history,
      };

      fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': this.getCookie('csrftoken') || '',
        },
        body: JSON.stringify(payload),
      })
        .then(async (res) => {
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || res.statusText);
          }
          return res.json();
        })
        .then((data) => {
          const reply = (data?.reply || '').trim();
          if (reply) {
            this.appendMessage('assistant', reply);
          } else {
            this.appendMessage('assistant', 'I had trouble generating a reply. Try again.');
          }
        })
        .catch((err) => {
          this.appendMessage('assistant', `Sorry, I hit an error: ${err.message}`);
        })
        .finally(() => {
          typingEl?.remove();
          this.sendBtn.disabled = false;
          this.scrollToBottom();
        });
    },

    cleanStars(text) {
      if (!text) return '';
      // Convert line-start asterisk bullets "* item" to "- item"
      let cleaned = text.replace(/^([ \t]*)\*[ \t]+/gm, '$1- ');
      // Strip markdown bold/italic asterisks: **word** -> word, *word* -> word
      cleaned = cleaned.replace(/\*{1,3}([^*]+?)\*{1,3}/g, '$1');
      // Strip any leftover asterisks
      cleaned = cleaned.replace(/\*+/g, '');
      return cleaned.trim();
    },

    appendMessage(role, content) {
      const sanitized = role === 'user' ? content : this.cleanStars(content);
      const msg = document.createElement('div');
      msg.className = role === 'user' ? 'sdh-bot-msg sdh-bot-msg--user' : 'sdh-bot-msg sdh-bot-msg--bot';
      msg.textContent = sanitized;
      this.messagesEl.appendChild(msg);
      this.saveHistory(role, sanitized);
      this.scrollToBottom();
    },

    showTyping() {
      const msg = document.createElement('div');
      msg.className = 'sdh-bot-msg sdh-bot-msg--bot sdh-bot-msg--typing';
      msg.innerHTML = '<span class="sdh-bot-typing-dot"></span><span class="sdh-bot-typing-dot"></span><span class="sdh-bot-typing-dot"></span>';
      this.messagesEl.appendChild(msg);
      this.scrollToBottom();
      return msg;
    },

    scrollToBottom() {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    },

    saveHistory(role, content) {
      const history = this.loadHistory();
      history.push({ role, content, ts: Date.now() });
      const trimmed = history.slice(-MAX_HISTORY);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    },

    loadHistory() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        return [];
      }
      return [];
    },

    restore() {
      const history = this.loadHistory();
      history.forEach((item) => {
        if (!item || !item.role || !item.content) return;
        const role = item.role === 'user' ? 'user' : 'assistant';
        const sanitized = role === 'user' ? item.content : this.cleanStars(item.content);
        const msg = document.createElement('div');
        msg.className = role === 'user' ? 'sdh-bot-msg sdh-bot-msg--user' : 'sdh-bot-msg sdh-bot-msg--bot';
        msg.textContent = sanitized;
        this.messagesEl.appendChild(msg);
      });
    },

    buildApiHistory() {
      const history = this.loadHistory();
      return history
        .map((item) => ({
          role: item.role,
          content: item.role === 'assistant' ? this.cleanStars(item.content) : item.content,
        }))
        .slice(-8);
    },

    getCookie(name) {
      const value = `; ${document.cookie}`;
      const parts = value.split(`; ${name}=`);
      if (parts.length === 2) {
        return parts.pop().split(';').shift();
      }
      return '';
    },
  };

  window.SDH.Chatbot = Chatbot;

  document.addEventListener('DOMContentLoaded', () => {
    Chatbot.init();
  });
})();
