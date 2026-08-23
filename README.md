# 🕊️ Sandesh 2.0

**Engineered & Crafted ❤️ by Raj**

Welcome to **Sandesh 2.0**! 🌟 A lightning-fast, ultra-secure, and beautifully designed real-time messaging app built to make chatting feel as natural and seamless as breathing.

I created Sandesh with a single, uncompromising vision: to give you a pristine, deeply personal space to connect. No ads, no trackers, no algorithmic clutter-just you and the people who matter most. Whether you love the sleek elegance of Dark Mode 🌙 or the crisp, vibrant feel of Light Theme ☀️, Sandesh effortlessly adapts to your vibe. Most importantly, it's a **privacy-first** platform where your conversations are strictly yours.

Your data. Your rules. Total peace of mind. 🛡️

---

## ✨ Features

- **🎨 Gorgeous & Responsive Design:** A modern, glassmorphism-inspired interface that looks stunning and works flawlessly on your phone, tablet, or desktop.
- **⚡ Real-Time Messaging:** Powered by highly optimized WebSockets, your messages fly across the screen instantly-no refreshing required!
- **🔒 Privacy-First Controls:** Take back control with disappearing messages. Set your chats to self-destruct after 2 days, 1 week, 1 month, or 6 months.
- **📸 Moments:** Share slices of your life via 24-hour status updates, complete with read receipts and emoji reactions.
- **📞 Crystal-Clear Calls:** Start high-quality voice and video calls directly from your browser, safely peer-to-peer using WebRTC.
- **🛡️ Seamless & Secure Authentication:** 
  - Log in effortlessly using Google, your email, username, or phone number. 
  - *New!* Enjoy a buttery-smooth **visual loading overlay** while authenticating with Google, replacing jarring page jumps. 
  - *New!* **Bulletproof Logout:** Our refined session logic ensures strict security. If you log out, your session is completely wiped, forcing a fresh, secure re-authentication on your next visit. No accidental auto-logins!
- **🔔 Missed Call Alerts:** Never miss a beat! Offline call attempts leave a clear "Missed Call" note right in your chat.
- **🟢 Live Indicators:** See exactly who's online and watch those satisfying typing indicators in real-time.
- **📝 Saved Messages:** Your own private digital notebook to securely stash links, files, and ideas.

---

## 🛠️ Technology Stack

Sandesh is built using robust and modern technologies:

| Component | Technology |
|---|---|
| **Backend** | Django 5, Python 3 |
| **Real-Time Engine** | Django Channels, WebSockets, Daphne |
| **Calling Integration**| WebRTC (with STUN/TURN fallback) |
| **Database** | PostgreSQL (Production) / SQLite (Local) |
| **File Storage** | Cloudinary (Production) / Local Filesystem |
| **Frontend** | Vanilla HTML, CSS, JavaScript |

---

## 🚀 Running Locally

Want to test Sandesh on your own machine? Getting started is easy. You only need Python installed—no Docker or complex database setups are required.

```bash
# 1. Clone the repository
git clone https://github.com/Garuda-Netra/Sandesh-2.0.git
cd Sandesh-2.0

# 2. Create and activate a virtual environment
python -m venv .venv

# On Windows:
.venv\Scripts\activate
# On Mac/Linux:
# source .venv/bin/activate

# 3. Install the dependencies
pip install -r backend/requirements.txt

# 4. Set up the database
cd backend
python manage.py migrate

# 5. Start the application
python manage.py runserver
```

You're all set! Open *http://127.0.0.1:8000* in your browser.

*(Tip: To access the admin panel, create a superuser by running `python manage.py createsuperuser` and logging in.)*

---

## ☁️ Deployment

Sandesh is ready for production and can be easily deployed to cloud platforms like **Railway**, **Render**, or **Heroku**. The application automatically switches from local settings to production services (like PostgreSQL and Cloudinary) when the appropriate environment variables are provided.

**Key Environment Variables for Production:**
- `SECRET_KEY`, `DEBUG=False`, `ALLOWED_HOSTS`
- `DATABASE_URL` (For PostgreSQL) & `REDIS_URL` (For WebSockets)
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
- `TURN_SERVER_URL`, `TURN_SERVER_USERNAME`, `TURN_SERVER_CREDENTIAL` (For WebRTC calls over different networks)
