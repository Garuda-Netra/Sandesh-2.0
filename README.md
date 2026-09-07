# 🕊️ Sandesh 2.0

**Engineered & Crafted with ❤️ by Raj**

Welcome to **Sandesh 2.0**! 🌟 A lightning-fast, privacy-first real-time messaging platform built to make staying in touch feel effortless, private, and genuinely delightful.

I built Sandesh with a clear conviction: your conversations belong strictly to you. No tracking pixels, no ad targeting, and zero algorithmic noise—just a clean, distraction-free environment to connect with people who matter most. Whether you love the immersive OLED Deep Dark Mode 🌙 or the airy elegance of Crisp Light Mode ☀️, Sandesh feels smooth, responsive, and tailored to your workflow.

Your conversations. Your privacy. Total peace of mind. 🛡️

---

### 🪔 Ancient Aesthetics × Futuristic Glassmorphism
Sandesh blends **timeless philosophy** with **modern, fluid aesthetics**:
- 🕉️ **Cinematic Landing Canvas**: Ambient dark matter background with rotating Sanskrit Shlokas celebrating wisdom, truth, and genuine human connection.
- 🎨 **Adaptive Theme Palette**: High-contrast OLED Deep Dark Mode and Crisp Light Mode with butter-smooth view transitions.
- 💫 **Tactile Micro-Interactions**: Glassmorphic cards, luminous gradients, floating particles, and responsive interactive feedback.

---

## ✨ Features & Capabilities

### 🔐 WhatsApp-Style Chat Lock & Biometric Security *(New!)*
- **Granular Per-Chat Locking**: Lock any individual direct chat, group conversation, or your private Saved Messages notebook with one click.
- **Dedicated "Locked Chats" Vault**: Pinned right at the top of your sidebar. When locked, conversations are completely tucked away from view.
- **Device Biometrics (WebAuthn)**: Seamlessly unlock with your fingerprint, Face ID, Touch ID, or Windows Hello using secure hardware-backed platform credentials.
- **4–6 Digit Security PIN**: Set a custom numeric PIN with an on-screen keypad and full keyboard support as a dependable fallback.
- **Brute-Force Rate Limiting**: Automatic lockout cooldown after 5 failed attempts prevents unauthorized guessing.
- **Inactivity Auto-Lock & Quick Lock**: Auto-locks after 5 minutes of inactivity, plus a one-click padlock button (`🔓`) to secure everything instantly.
- **Privacy Masking**: Incoming notifications for locked chats conceal sender details and message text (`"🔒 Locked Chat: New message"`) until unlocked.

---

### 💬 Messaging & Real-Time Connection
- **⚡ Real-Time WebSockets**: Instant bidirectional message delivery powered by Django Channels (`/ws/chat/`) with zero page reloading.
- **✔️ Live Delivery & Read Receipts**: Visual status tracking from sent (`✓`) to delivered (`✓✓` grey) to read (`✓✓` gold/purple).
- **🟢 Live Presence & Typing Signals**: Anti-flicker online presence indicators and real-time typing bubbles.
- **🔒 Disappearing Messages**: Set chats to self-destruct automatically after 2 days, 1 week, 1 month, or 6 months.
- **🗑️ Dual-Tier Message Deletion**:
  - *Remove from My View:* Cleans up messages solely on your device.
  - *Delete for Everyone:* Sender-authorized deletion broadcasted across all participants in real time.
  - *Clear Chat:* Wipe an entire conversation history with a single confirmation.
- **📝 Saved Messages**: Your personal, cloud-synced digital notebook for quick notes, links, and files.

---

### 📸 Moments, Status Privacy & Media
- **📸 24-Hour Moments (Stories)**: Post temporary visual stories with viewer tracking, emoji reactions, and built-in Spotify music integration.
- **👁️ WhatsApp-Style Status Privacy *(New!)* **: Granular audience control for every story update:
  - *My Contacts:* Visible to all mutual friends.
  - *My Contacts Except...:* Hide stories from specific individuals with contact exclusion counters.
  - *Only Share With...:* Whitelist specific friends who can view your moment.
  - *Persistent Defaults & Live Broadcast Filtering:* Settings persist across uploads and WebSocket events are strictly routed only to permitted friends.
- **🖼️ Interactive Media Lightbox**: High-resolution viewer modal for photos, videos, and PDFs with pan, zoom, playback controls, and keyboard navigation.
- **📎 Multi-File Attachments & Document Previews**: Send photos, videos, audio clips, PDFs, documents, and archives up to 5 MB with instant previews.

---

### 📞 Crystal-Clear Calling & Professional Ringtones
- **📞 Peer-to-Peer Voice & Video Calls**: Browser-native high-definition calling using WebRTC with global STUN/TURN fallback.
- **🎵 Studio-Grade Caller Ringtones *(New!)* **: Replaced basic beeps with 6 high-definition synthesized Web Audio API tones:
  - *Divine Shankha (Default / Signature):* Sacred acoustic conch shell resonance with natural breath swell, warm horn harmonics, and celestial temple echo.
  - *Celestial Chime:* Luxury multi-note harmonic arpeggio.
  - *Executive Lounge:* Refined corporate Rhodes vibraphone chords.
  - *Modern Marimba:* Crisp acoustic wooden percussion motif.
  - *Cosmic Horizon:* Ambient ethereal drifting pads with vibrato.
  - *Classic Bell:* Modernized dual-cadence telephone ring.
- **🔔 Realistic Outgoing Ringback Tone**: Instant audio feedback when placing an outgoing call so you know the recipient's phone is ringing.
- **🎛️ Ringtone Settings & Live Preview**: Real-time volume slider, tone preview buttons with sound wave indicators, and a 4-second interactive test call simulator.
- **🔔 Missed Call Alerts**: Automatically logs clear "Missed Call" summary cards with timestamps directly into the chat stream.
- **👥 Dynamic Group Chats**: Create groups with custom avatars, manage member roles (Owner, Admin, Member), invite friends, and track per-member read receipts.

---

### 🤖 Vyasa AI Companion & Auto-Wishes
- **🤖 Built-in Vyasa Assistant**: Context-aware AI companion powered by Google Gemini (`google-genai`) with dual-key quota failover.
- **🎂 Smart Auto-Wish Engine**: Automated, heartfelt birthday and celebration wishes in warm English or Hinglish with one-click approval and real-time delivery.

---

### 🛡️ Enterprise-Grade Security & Authentication
- **Multi-Identifier Login**: Sign in via Google SSO (Clerk JWT), verified phone number (E.164 via Google's `phonenumbers` library), email, or username.
- **Session Anti-Hijack Defense**: Continuous SHA-256 fingerprinting of client IP and User-Agent immediately invalidates stolen session cookies.
- **Active Devices & Session Manager**: Inspect every active login (device model, browser, IP address, geolocation) and revoke remote access on demand.
- **Deep File Inspection**: Binary magic byte header verification, double-extension blocking, stored XSS neutralization, and decompression bomb protection.

---

## 🛠️ Technology Stack

| Layer | Technologies & Libraries | Role |
|---|---|---|
| **Backend Core** | Python 3.12, Django 5.2 | High-throughput async web framework & API layer |
| **Real-Time Engine** | Django Channels 4.3, Daphne 4.2 | ASGI server, WebSockets & real-time event pipeline |
| **Database & Cache** | PostgreSQL / SQLite, Redis | Relational data persistence & channel layer pub/sub |
| **Audio/Video Engine** | WebRTC, STUN/TURN | Browser-to-browser encrypted media streaming |
| **Artificial Intelligence** | Google Gemini (`google-genai`) | Vyasa conversational AI & Auto-Wish engine |
| **Hardware Biometrics** | WebAuthn Platform Authenticator | Touch ID, Face ID, Windows Hello & Fingerprint auth |
| **Media Storage** | Cloudinary, WhiteNoise | Scalable asset hosting & compressed static delivery |
| **Identity & SSO** | Django Auth, Clerk (JWT) | Multi-identifier credentials & Social Single Sign-On |
| **Frontend UI** | HTML5, Vanilla JavaScript, Tailwind CSS | Framework-free, ultra-lightweight glassmorphic client |

---

## 📂 Architecture Overview

```
Sandesh-2.0/
├── backend/
│   ├── messaging/         # WebSockets, Chat, Calls, Chat Lock, Biometrics, Moments & AI
│   ├── users/             # Auth, Clerk SSO, Profiles, Device Sessions & Security Middleware
│   ├── sdh/               # ASGI/WSGI entry points, Daphne routing & Django settings
│   └── manage.py          # Administrative command utility
├── frontend/
│   ├── static/            # Modular JS (chat, chatLock, webrtc, moments, chatbot) & CSS
│   └── templates/         # Glassmorphic views (chat, calling, profile, auth, landing)
├── Procfile               # Cloud deployment descriptor (Daphne ASGI + Migrations)
└── requirements.txt       # Python production dependencies
```

---

## 🚀 Quick Start (Local Setup)

### 1. Clone & Setup Virtual Environment
```bash
git clone https://github.com/Garuda-Netra/Sandesh-2.0.git
cd Sandesh-2.0

# Create and activate virtual environment
python -m venv .venv

# On Windows (PowerShell / CMD):
.\.venv\Scripts\activate
# On macOS / Linux:
# source .venv/bin/activate
```

### 2. Install Dependencies
```bash
pip install -r requirements.txt
```

### 3. Apply Migrations & Create Superuser
```bash
python backend/manage.py migrate
python backend/manage.py createsuperuser
```

### 4. Start Development Server
```bash
python backend/manage.py runserver
```
Navigate to **http://127.0.0.1:8000** in your browser.

---

## ⏱️ Maintenance & Background Commands

Sandesh includes built-in commands for automated background hygiene:

```bash
# Deletes messages that have exceeded their configured retention lifespan
python backend/manage.py cleanup_messages

# Cleans up expired 24-hour moments and unlinks media files from storage
python backend/manage.py cleanup_moments

# Dispatches scheduled event/birthday greetings in real time
python backend/manage.py send_auto_wishes
```

---

## ☁️ Deployment

Sandesh is configured out-of-the-box for **Render**, **Railway**, or **Heroku** via the included `Procfile`:

```procfile
web: python backend/manage.py migrate && daphne -b 0.0.0.0 -p $PORT sdh.asgi:application
```

**Recommended Production Environment Variables:**
* `SECRET_KEY`, `DEBUG=False`, `ALLOWED_HOSTS`
* `DATABASE_URL` (PostgreSQL) & `REDIS_URL` (Redis for WebSockets)
* `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
* `GEMINI_API_KEY` (and optional `GEMINI_API_KEY_2`)
* `TURN_SERVER_URL`, `TURN_SERVER_USERNAME`, `TURN_SERVER_CREDENTIAL`

---

## 📄 License & Credits

* **Engineered & Crafted with ❤️ by**: **Raj**
* **Repository**: [Garuda-Netra/Sandesh-2.0](https://github.com/Garuda-Netra/Sandesh-2.0)
* **Philosophy**: *"Your conversations belong to you. No trackers, no clutter, pure connection."*
