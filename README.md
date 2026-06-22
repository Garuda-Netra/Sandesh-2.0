# Sandesh 2.0

**Engineered & Crafted ❤️ by Raj**

Welcome to **Sandesh 2.0**, a fast, secure, and user-friendly real-time messaging application designed to make online communication feel natural and seamless.

I have created Sandesh with a clear vision: to provide a clean, intuitive, and deeply personal chat experience. My goal was simple—to build a messaging application that is incredibly fast, highly responsive, beautifully designed, and completely free of unnecessary clutter or invasive tracking. Whether you prefer the elegance of a sleek dark mode or the crispness of a light theme, Sandesh effortlessly adapts to your style while ensuring that your conversations remain entirely secure and private.

No ads, no tracking—just a reliable space to connect with the people who matter.

---

## ✨ Features

- **Responsive Design:** A modern, glassmorphism-inspired UI that looks great and works seamlessly across desktops, tablets, and mobile devices.
- **Real-Time Messaging:** Powered by highly optimized WebSockets, your messages are delivered instantly without the need to refresh.
- **Privacy Control:** Take control of your data with disappearing messages. You can set messages to automatically delete after 2 days, 1 week, 1 month, or 6 months.
- **Moments:** Share what you're up to with 24-hour status updates, complete with read receipts and reactions.
- **Voice & Video Calls:** Start high-quality, peer-to-peer calls directly from your browser using WebRTC.
- **Missed Call Alerts:** If someone tries to reach you while you're offline, you'll receive a clear "Missed Call" notification in your chat.
- **Flexible Login:** Sign in securely using your username, email, or phone number.
- **Real-Time Indicators:** See who is online and when they are typing to you. 
- **Saved Messages:** A dedicated private space to keep notes, files, or ideas just for yourself.

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
