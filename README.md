# 🕊️ Sandesh 2.0

> *"True communication isn't just about sending packets across a wire — it's about trust, privacy, and genuine human connection."*

**Crafted with care & passion by Raj** • [GitHub Repository](https://github.com/Garuda-Netra/Sandesh-2.0)

---

## 👋 Hey there, welcome to Sandesh!

Most modern messaging apps have gotten uncomfortably noisy. Between targeted advertisements, hidden analytics trackers, corporate surveillance, and cluttered feeds, it often feels like your private conversations are being mined rather than respected.

**Sandesh (संदेश)** was born out of a desire for something different: a real-time messaging space that is fast, beautiful, and unapologetically private. No tracking pixels, no algorithmic feeds, no data harvesting. Just you and the people you care about, communicating freely.

Whether you're unwinding late at night with our immersive **Deep Dark OLED mode** 🌙 or working under the sun with **Crisp Light mode** ☀️, every screen, transition, and chime was designed to feel natural, responsive, and delightful.

---

## 🪔 Ancient Heritage meets Modern Glassmorphism

Sandesh blends timeless Indian philosophical roots with clean, fluid modern design:

* 🕉️ **Sacred Heritage & Philosophy**: Drawing inspiration from ancient Indian messengers (*Sandeshvahaks*), the divine quill, and sacred scrolls representing truth, integrity, and wisdom.
* 📜 **Cinematic Sanskrit Canvas**: Ambient landing screen with wisdom-filled Shlokas celebrating friendship (*Maitri*), truth (*Satya*), and mindful speech.
* 🎨 **Bespoke Theme Palette**: High-contrast OLED dark mode and refined light mode that adapt gracefully to your system preferences without harsh contrasts or eye strain.
* 💫 **Tactile Micro-Interactions**: Glassmorphic frosted cards, subtle light shimmers, smooth spring transitions, and responsive hover feedback throughout the app.

---

## ✨ What Makes Sandesh Special?

### 📍 Interactive Location Sharing & Real-Time Tracking *(New!)*
* **Drop a Pin Anytime**: Search places, pinpoint landmarks, or drop a custom pin anywhere in the world.
* **Live Location Streaming**: Share your live movement in real time with an automatic timer (15 minutes, 1 hour, or 8 hours). When time runs out, sharing automatically turns off.
* **Clean & Professional Cards**: Built with crisp ESRI World Street Map tiles, zero third-party watermarks, a clean single-border card, and one-tap **Directions** via Google Maps.
* **Interactive Fullscreen Viewer**: Tap any map card to open a full Leaflet map view with zoom, pan, and real-time live beacon updates.

---

### 🔒 Client-Side End-to-End Encryption (E2EE)
* **Your Keys Stay on Your Device**: Powered directly by your browser’s native **Web Crypto API (SubtleCrypto)**. Private keys are generated locally and never touch our servers.
* **ECDH P-256 Key Exchange**: Authenticated key agreement creates unique shared secrets for every chat.
* **AES-GCM-256 Authenticated Encryption**: Every message is sealed with a fresh 12-byte initialization vector. 
* **Zero-Knowledge Architecture**: The server only routes ciphertext. Even if someone intercepts the database, your message contents look like unreadable random bytes.
* **Encrypted Group Chats**: Group keys are symmetrically rotated and encrypted individually for every member's public key.

---

### 🔐 Biometric Chat Lock & The Private Vault
* **Hide Sensitive Chats**: Lock any conversation or your private notebook. Locked chats disappear from the main list into a secure vault pinned at the top.
* **Hardware Biometrics (WebAuthn)**: Unlock instantly with your device's fingerprint sensor, Touch ID, Face ID, or Windows Hello.
* **PIN Fallback**: Set a 4–6 digit custom numeric security code with on-screen scramble keypad for dependable access on any machine.
* **Auto-Lock on Inactivity**: Automatically seals your locked chats after 5 minutes of inactivity, plus a one-click padlock button (`🔓`) to lock immediately.
* **Privacy Notifications**: Notifications for locked chats disguise the sender and content (`"🔒 Locked Chat: New message"`) until unlocked.

---

### 📲 Progressive Web App (PWA) & Offline Resilience
* **Install Anywhere**: Install Sandesh natively on Android, iPhone, Windows, macOS, or Linux. It runs in its own window with no URL bar, custom branding, and desktop/dock integration.
* **Smart Offline Screen**: If your WiFi drops or you go through a tunnel, Sandesh doesn't show a blank browser error. It shows a graceful offline screen with auto-reconnect polling.
* **Lightning Startup**: The service worker caches static assets, studio ringtones, and stylesheets so the app opens instantly.

---

### 👁️‍🗨️ View-Once Ephemeral Media
* **Send Self-Destructing Media**: Share photos and videos that can only be opened and watched once.
* **Real Physical Deletion**: The moment the viewer closes the photo or video, the file is permanently unlinked and deleted from storage and disk.
* **No Screenshot or Download Traps**: Direct downloads are blocked with HTTP 410 Expired, and save actions are disabled in the viewer.
* **Live Status Sync**: Both you and the recipient see the card update to `① Opened` in real time.

---

### 📞 Studio-Grade Audio & Crystal-Clear Calls
* **Peer-to-Peer Calls**: Free high-definition voice and video calls powered by WebRTC with global STUN/TURN traversal.
* **Acoustic Instrument Ringtones**: No harsh, electronic beeps that trigger phone anxiety. We synthesized warm, calming instrument tracks (`.wav`):
  * **Sandesh Modern**: Playful acoustic marimba & kalimba melody.
  * **Executive Suite**: Warm Rhodes electric piano with gentle tremolo.
  * **Acoustic Chime**: Shimmering crystal bell chimes with soft decay.
  * **Classic Bell**: Refined acoustic desk bell with dual-frequency resonance.
* **Realistic Outgoing Ringback**: Hear a natural ringing tone as soon as you dial someone so you know their phone is active.

---

### 📸 24-Hour Moments & Status Privacy
* **Ephemeral Stories**: Share photos or text thoughts that automatically disappear after 24 hours.
* **Granular Audience Filtering**:
  * *All Contacts:* Shared with all mutual friends.
  * *My Contacts Except...:* Keep specific individuals from seeing an update.
  * *Only Share With...:* Hand-pick the exact friends who can view it.
* **Spotify Soundtracks**: Attach a 30-second Spotify preview to your story to set the mood.

---

### 🤖 Vyasa AI Companion & Auto-Wishes
* **Built-in Assistant**: Have a question or need a quick translation? Chat with **Vyasa**, your built-in AI companion powered by Google Gemini (`google-genai`).
* **Thoughtful Auto-Wishes**: Automatically drafts heartfelt birthday and celebration wishes in warm English or Hinglish that you can review and send with one tap.

---

### 💬 Real-Time Messaging Details
* **Live Typing & Online Presence**: See when friends are active or typing without lag.
* **Message Delivery Receipts**: Track status from sent (`✓`), to delivered (`✓✓`), to read (`✓✓`).
* **Dual-Tier Message Deletion**: Choose between *"Remove from My View"* or *"Delete for Everyone"* (which broadcasts across WebSockets and immediately deletes associated media files).
* **Saved Messages**: Your personal digital notebook for quick thoughts, files, and links across all your devices.

---

## 🛠️ Tech Stack Under the Hood

| Component | Technology | Why It Was Chosen |
|---|---|---|
| **Backend Core** | Python 3.12 + Django 5.2 | Robust, secure, and battle-tested web foundation |
| **Real-Time Layer** | Django Channels 4.3 + Daphne | Full ASGI WebSocket pipeline for sub-millisecond updates |
| **Client Cryptography** | Web Crypto API (SubtleCrypto) | Hardware-accelerated browser-native ECDH + AES-GCM-256 |
| **Biometric Auth** | WebAuthn API | Passwordless biometric authentication using your device hardware |
| **PWA & Offline** | Service Workers + Cache Storage | Installable app shell with offline fallbacks and instant load times |
| **Maps & Location** | Leaflet.js + ESRI World Street Map | Fast, reliable mapping with zero tracking, no API keys, and zero watermarks |
| **Voice & Video** | WebRTC + STUN/TURN | Direct peer-to-peer audio and video streaming |
| **Artificial Intelligence** | Google Gemini (`google-genai`) | Context-aware, natural conversational intelligence |
| **Database & Cache** | PostgreSQL / SQLite + Redis | Reliable persistence with distributed pub/sub channels |
| **Media Hosting** | Cloudinary / Local Disk Storage | Fast asset delivery with automatic optimization |
| **Frontend UI** | Vanilla JS + Tailwind CSS + Custom CSS | Lightweight, zero heavy frontend framework overhead |

---

## 📂 Project Architecture

```text
Sandesh-2.0/
├── backend/
│   ├── messaging/         # Chat, WebSockets, Calls, Moments, Chat Lock & AI
│   ├── users/             # Authentication, Profiles, Sessions & Security
│   ├── sdh/               # Django settings, ASGI/WSGI entry points & routing
│   └── manage.py          # Django management CLI
├── frontend/
│   ├── static/
│   │   ├── js/            # Modular scripts (chat, e2eCrypto, locationShare, chatLock, webrtc)
│   │   ├── css/           # Glassmorphic CSS design system and theme tokens
│   │   ├── icons/         # PWA app icons and favicons
│   │   └── sounds/        # Studio-grade acoustic caller ringtones (.wav)
│   └── templates/         # Clean HTML templates (chat, auth, profile, offline)
├── .env.example           # Friendly configuration template
├── Procfile               # Cloud deployment descriptor (Daphne ASGI + Migrations)
└── requirements.txt       # Production dependencies
```

---

## 🚀 Getting Started Locally

Getting Sandesh running on your machine takes less than 3 minutes.

### 1. Clone the Repository
```bash
git clone https://github.com/Garuda-Netra/Sandesh-2.0.git
cd Sandesh-2.0
```

### 2. Set Up a Virtual Environment

**On Windows:**
```powershell
python -m venv .venv
.\.venv\Scripts\activate
```

**On macOS & Linux:**
```bash
python3 -m venv .venv
source .venv/bin/activate
```

### 3. Install Dependencies
```bash
pip install -r requirements.txt
```

### 4. Create Your Environment File
Copy the provided example file:
```bash
# On Windows PowerShell:
Copy-Item .env.example .env

# On macOS / Linux:
cp .env.example .env
```
*(By default, `.env.example` is preconfigured to run immediately with SQLite and in-memory WebSockets—no database setup required!)*

### 5. Apply Migrations & Create an Admin User
```bash
python backend/manage.py migrate
python backend/manage.py createsuperuser
```

### 6. Launch the Server!
```bash
python backend/manage.py runserver
```

Now open **[http://127.0.0.1:8000](http://127.0.0.1:8000)** in your browser, register a test account, and start exploring!

---

## ⏱️ Handy Maintenance Commands

Sandesh includes built-in background management commands for housekeeping:

```bash
# Purge disappearing messages that have reached their expiration date
python backend/manage.py cleanup_messages

# Delete expired 24-hour moments and cleanly unlink their media files
python backend/manage.py cleanup_moments

# Dispatch pending birthday and holiday wishes
python backend/manage.py send_auto_wishes
```

---

## ☁️ Deploying to the Cloud

Sandesh is ready to deploy out-of-the-box on platforms like **Render**, **Railway**, or **Heroku** using the included `Procfile`:

```procfile
web: python backend/manage.py migrate && daphne -b 0.0.0.0 -p $PORT sdh.asgi:application
```

### Production Checklist:
1. Set `DEBUG=False` in your cloud environment.
2. Generate a secure, random `SECRET_KEY`.
3. Provide a managed **PostgreSQL** connection string via `DATABASE_URL`.
4. Provide a managed **Redis** instance (e.g. Upstash Redis) via `REDIS_URL` for multi-worker WebSockets.
5. Add your **Cloudinary** credentials (`CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`) for persistent media storage.
6. Add your free **Google Gemini API Key** (`GEMINI_API_KEY`) if you'd like to enable Vyasa AI.

---

## 💌 A Note from the Creator

Building Sandesh 2.0 has been an incredible journey of exploring what happens when you combine engineering rigor, user empathy, and beautiful aesthetics. Every feature in here was crafted with intention—to give you a communication tool that respects your time, treats your privacy as sacred, and brings a little spark of joy every time you hear a chime or send a note.

If you like what you see or have ideas on how to make Sandesh even better, feel free to open an issue, submit a pull request, or drop a line!

Warm regards,  
**Raj**  
*Creator of Sandesh 2.0*
