# 🕊️ Sandesh 2.0

**Engineered & Crafted ❤️ by Raj**

Welcome to **Sandesh 2.0**! 🌟 A lightning-fast, ultra-secure, and beautifully designed real-time messaging app built to make chatting feel as natural and seamless as breathing.

I created Sandesh with a single, uncompromising vision: to give you a pristine, deeply personal space to connect. No ads, no trackers, no algorithmic clutter—just you and the people who matter most. Whether you love the sleek elegance of Dark Mode 🌙 or the crisp, vibrant feel of Light Theme ☀️, Sandesh effortlessly adapts to your vibe. Most importantly, it is a **privacy-first** platform where your conversations are strictly yours.

Your data. Your rules. Total peace of mind. 🛡️

---

### 🪔 Ancient Aesthetics × Cyberpunk Glassmorphism
Sandesh uniquely harmonizes **Vedic philosophical depth** with **futuristic glassmorphism**:
- 🕉️ **Cinematic Landing Stage**: Ambient dark matter canvas featuring rotating Sanskrit Shlokas celebrating knowledge, truth, and meaningful connection.
- 🎨 **Adaptive Theme Palette**: High-contrast OLED Deep Dark Mode and Crisp Light Mode with buttery-smooth View Transitions.
- 💫 **Liquid Micro-Interactions**: Custom glass cards, glow effects, floating particles, and tactile responsive buttons.

---

## ✨ Features & Capabilities

- **🎨 Gorgeous & Responsive Design:** A modern, glassmorphism-inspired interface that looks stunning and works flawlessly on your phone, tablet, or desktop.
- **⚡ Real-Time Messaging:** Powered by highly optimized WebSockets (`/ws/chat/`), your messages fly across the screen instantly—no refreshing required!
- **✔️ Live Delivery & Read Receipts:** Instant WhatsApp-style visual tracking from sent ➔ delivered (`✓✓` grey) ➔ read (`✓✓` purple/gold).
- **🟢 Live Indicators & Anti-Flicker Presence:** See exactly who's online with persistent connection-counted presence tracking and watch satisfying typing indicators in real-time.
- **🔒 Privacy-First Controls & Disappearing Messages:** Take back control with disappearing messages. Set your chats to self-destruct after 2 days, 1 week, 1 month, or 6 months.
- **🗑️ Professional Dual-Tier Deletion:**
  - *Remove from My View:* Soft-hides chosen messages strictly on your personal screen.
  - *Delete for All Participants:* Sender-authorized deletion that broadcasts across all participant devices.
  - *Clear Chat History:* Single-click full wipe of any conversation history.
- **📸 Moments (24-Hour Stories) with Spotify:** Share slices of your life via 24-hour status updates, complete with viewer read receipts, emoji reactions, and background music integration via the Spotify API.
- **📞 Crystal-Clear Calls:** Start high-quality voice and video calls directly from your browser, safely peer-to-peer using WebRTC with STUN/TURN traversal.
- **🔔 Missed Call Alerts:** Never miss a beat! Offline call attempts leave a clear "Missed Call" card with timestamps right in your chat.
- **👥 Group Chats & Communities:** Create groups with custom branding, manage role permissions (Owner, Admin, Member), send group invites, track per-member read receipts, and clear your personal view of the group chat.
- **🤖 "Vyasa" AI Companion & Auto-Wish Engine:**
  - Built-in smart assistant powered by Google Gemini AI with automatic dual-key quota failover (`GEMINI_API_KEY` & `GEMINI_API_KEY_2`).
  - Automated birthday & event greetings generated in warm English or Hinglish with one-click approval and real-time delivery.
- **🛡️ Seamless & Secure Authentication:** 
  - Log in effortlessly using Google SSO (via Clerk JWT), your email, username, or phone number (E.164 verified via Google's `phonenumbers` library). 
  - *New!* Enjoy a buttery-smooth **visual loading overlay** while authenticating with Google, replacing jarring page jumps. 
  - *New!* **Bulletproof Logout:** Our refined session logic ensures strict security. If you log out, your session is completely wiped, forcing a fresh, secure re-authentication on your next visit. No accidental auto-logins!
- **🛡️ Session Anti-Hijack Defense:** Built-in middleware cryptographically hashes client IP and User-Agent using SHA-256, terminating sessions immediately upon fingerprint drift.
- **📱 Active Devices & Session Manager:** Inspect every device logged into your account (hardware type, OS, browser, IP, and geolocated city/country) and terminate remote sessions with one click.
- **🤝 Privacy-First Social Graph:** No public directory leaks! Discover users through exact username/phone search, connect via mutual two-way friend requests, or block unwanted contacts.
- **📎 Rich Media & File Sharing:** Securely share photos, videos, audio clips, PDFs, docs, and archives up to 5 MB with automatic disk and cloud cleanup upon deletion.
- **🛡️ Enterprise File & Image Upload Security:**
  - *Magic Byte Inspection:* Deep binary signature verification validates genuine file headers independently of client claims.
  - *Executable & Payload Blocker:* Instantly rejects Windows PE (`MZ`), Linux ELF, script shebangs (`#!`), Mach-O, Java bytecode, and shortcut files.
  - *Double Extension Defense:* Multi-segment scanning blocks disguised extensions (e.g., `exploit.php.png`, `invoice.pdf.exe`).
  - *Stored XSS Prevention:* Prohibits scriptable SVG formats and inspects text/CSV uploads for embedded `<script>` or HTML vectors.
  - *Decompression Bomb Defense:* Pillow integrity checks and `MAX_IMAGE_PIXELS` constraints block pixel flood memory DoS.
  - *Path Traversal & Bidi Neutralization:* Sanitizes directory traversal (`../`), null bytes, and Unicode RTL overrides (`\u202E`).
  - *Secure Streaming Headers:* Serves downloads with `X-Content-Type-Options: nosniff` and CSP sandboxing to prevent browser MIME confusion.
- **🖼️ Interactive Media Lightbox Popup:** Full-screen responsive lightbox modal for photos, videos, and PDFs with smooth zoom, pan, playback controls, and keyboard navigation.
- **📝 Saved Messages:** Your own private digital notebook to securely stash links, files, and ideas.

---

## 🛠️ Technology Stack

| Layer | Technologies & Libraries | Key Responsibility |
|---|---|---|
| **Core Backend** | Python 3.12, Django 5.2 | High-throughput web framework & business logic |
| **Real-Time Engine** | Django Channels 4.3, Daphne 4.2 | ASGI server, async WebSockets & event routing |
| **Data & Cache** | PostgreSQL / SQLite, Redis | Relational data persistence & distributed channel pub/sub |
| **P2P Audio/Video** | WebRTC, STUN/TURN | Browser-to-browser encrypted media streaming |
| **Artificial Intelligence** | Google Gemini (`google-genai`) | Vyasa conversational AI & Auto-Wish generation |
| **Storage & Static** | Cloudinary, WhiteNoise | Cloud media asset hosting & compressed static delivery |
| **Identity & SSO** | Django Auth, Clerk (JWT) | Multi-identifier credentials & Social Single Sign-On |
| **Frontend UI** | HTML5, Tailwind CSS, Vanilla JS | Glassmorphic, framework-free, ultra-lightweight client |

---

## 📂 Architecture Overview

```
Sandesh-2.0/
├── backend/
│   ├── messaging/         # WebSockets, Chat, Calling, Groups, Moments, AI & Auto-Wishes
│   ├── users/             # Auth, Clerk SSO, Profiles, Anti-Hijack Middleware & Sessions
│   ├── sdh/               # ASGI/WSGI entry points, Daphne routing & Django settings
│   └── manage.py          # Command-line administrative utility
├── frontend/
│   ├── static/            # Modular JS (chat, webrtc, moments, chatbot, websocket) & CSS
│   └── templates/         # Glassmorphic views (chat, calling, profile, auth, landing)
├── Procfile               # Cloud deployment descriptor (Daphne ASGI + Migrations)
└── requirements.txt       # Production Python dependencies
```

---

## 🚀 Quick Start (Local Setup)

### 1. Clone & Prepare Virtual Environment
```bash
git clone https://github.com/Garuda-Netra/Sandesh-2.0.git
cd Sandesh-2.0

# Create and activate virtual environment
python -m venv .venv

# On Windows:
.venv\Scripts\activate
# On macOS/Linux:
# source .venv/bin/activate
```

### 2. Install Dependencies
```bash
pip install -r requirements.txt
```

### 3. Initialize Database & Superuser
```bash
cd backend
python manage.py migrate
python manage.py createsuperuser
```

### 4. Run the Development Server
```bash
python manage.py runserver
```
Visit **http://127.0.0.1:8000** in your browser.

---

## ⏱️ Automated Background Commands

Sandesh includes built-in Django commands for maintenance and automated tasks:

```bash
# Deletes messages that have exceeded their retention timeline (2 days to 6 months)
python backend/manage.py cleanup_messages

# Cleans up 24-hour expired moments and unlinks media files from storage
python backend/manage.py cleanup_moments

# Dispatches scheduled event/birthday greetings in real-time via WebSockets
python backend/manage.py send_auto_wishes
```

---

## ☁️ Deployment

Sandesh is production-ready for deployment on **Render**, **Railway**, or **Heroku** using the included `Procfile`:

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
