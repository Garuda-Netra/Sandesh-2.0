# Sandesh 2.0 — The Cosmic Edition 🌌

> **Engineered & Crafted with ❤️ by Raj**

Welcome to **Sandesh 2.0**—a beautifully crafted, ultra-fast real-time messaging experience that truly understands how human communication should feel. 

I built Sandesh because I was genuinely tired of the generic, soulless chat applications we use every day. I wanted to create something that didn't just work, but felt **alive, dynamic, and visually stunning**, while still being blazing fast, flawlessly responsive, and fiercely secure. The result? A premium chat ecosystem featuring an awe-inspiring "Cosmic" dark mode, an elegant "Saffron" light mode, buttery-smooth animations, and absolute zero clutter. 

No ads. No creepy tracking algorithms. Just you, your favorite people, and a beautiful space to connect.

---

## ✨ Why You'll Love Sandesh

- **Breathtaking Aesthetics & Cultural Touches:** Immerse yourself in a premium UI wrapped in deep glassmorphism. You'll love the glowing accents, beautifully rounded liquid buttons, and subtle cultural nods like the token-wise Sanskrit Shloka ("वसुधैव कुटुम्बकम्" - *The world is one family*) typing effect on our landing page. Designed to be fully responsive, it looks and feels gorgeous whether you're on your iPhone, Android, iPad, Mac, or Windows PC.
- **True Real-Time Messaging:** Powered by highly optimized WebSockets. When you hit send, it's there. No refreshing, no lagging, no waiting.
- **Disappearing Messages (Retention Period):** Need privacy? Set your messages to automatically vanish from the database after 1 day, 1 week, 1 month, or 6 months. Total control over your digital footprint, built right into the beautifully crafted User Profile modal.
- **Moments (24-hour Stories):** Share your day with beautifully implemented "Moments." View your friends' ephemeral stories indicated by sleek, glowing gradient rings (which gracefully adapt to both light and dark modes).
- **Crystal-Clear Voice & Video Calls:** Jump into high-quality peer-to-peer WebRTC calls directly from your browser. One click is all it takes to see or hear your friends.
- **Smart "Missed Call" System:** If you try to reach someone who is offline, Sandesh acts like a true assistant—instantly dropping a clean, professional "Missed Call" card into your chat feed. No communication is ever lost in the void.
- **Flexible & Secure Sign-in:** We all hate remembering usernames. With Sandesh, you can securely sign in using your **Username, Email, or Phone Number**. Phone numbers are instantly validated and neatly formatted with correct international country codes.
- **End-to-End Polish:** See exactly who is online in real time, watch typing indicators pop up seamlessly when someone is writing to you, and enjoy a strict layout that never breaks. No weird background scrolling or overlapping keyboards—just a perfectly stable, native app feel.
- **Your Personal Space:** Enjoy a dedicated "Saved Messages" space where you can drop quick notes, files, or ideas just for yourself. Complete with instant permanent deletion—because it's your data.

---

## 🛠️ What's Under the Hood?

Sandesh is engineered to be as robust and secure as it is beautiful.

| Component | Technology Powering It |
|---|---|
| **Backend Core** | Django 5, Python 3 |
| **Real-Time Engine** | Django Channels, WebSockets, Daphne (ASGI) |
| **P2P Calling** | WebRTC (with STUN/TURN fallback for reliability) |
| **Database** | PostgreSQL (Production) / SQLite (Local) |
| **Media & File Storage** | Cloudinary (Production) / Local filesystem |
| **Frontend UI** | Vanilla HTML, CSS, JavaScript (Zero heavy frameworks weighing it down!) |

---

## 🚀 Run It Locally in Minutes

Want to take Sandesh for a spin on your own machine? It's incredibly straightforward. All you need is Python installed—no Docker, no complicated database setups required.

```bash
# 1. Grab the code
git clone https://github.com/Garuda-Netra/Sandesh-2.0.git
cd Sandesh-2.0

# 2. Create your isolated environment
python -m venv .venv

# Activate it:
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # Mac / Linux

# 3. Install the magic ingredients
pip install -r backend/requirements.txt

# 4. Set up your local database
cd backend
python manage.py migrate

# 5. Bring Sandesh to life
python manage.py runserver
```

Boom. 💥 You're live! Open **http://127.0.0.1:8000** in your favorite browser.

*(Pro tip: Want full admin powers? Run `python manage.py createsuperuser` and log in to the admin panel!)*

---

## ☁️ Taking It to the Cloud (Production)

Ready to show it to the world? Sandesh is perfectly tuned to deploy flawlessly on platforms like **Railway**, **Render**, or **Heroku**. 
The engine automatically detects your environment and effortlessly switches from local SQLite and local storage to rock-solid PostgreSQL and Cloudinary the moment you feed it your production variables!

**Essential Environment Variables for Production:**
- `SECRET_KEY`, `DEBUG=False`, `ALLOWED_HOSTS`
- `DATABASE_URL` (Postgres) & `REDIS_URL` (For lightning-fast WebSockets)
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
- `TURN_SERVER_URL`, `TURN_SERVER_USERNAME`, `TURN_SERVER_CREDENTIAL` (For flawless WebRTC calls across any network)

---

### A final note from the creator

> *"Code should not just function; it should feel amazing to use. I poured my heart into every pixel and every line of code to make sure Sandesh respects your time and your eyes. I hope you enjoy messaging on Sandesh as much as I loved bringing it to life."* — **Raj**
