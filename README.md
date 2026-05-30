# Sandesh 2.0 — The Cosmic Edition 🌌

> **Engineered & Crafted with ❤️ by Raj**

Welcome to **Sandesh 2.0**—a real-time messaging platform that actually feels like a living, breathing space.

I built Sandesh because I was tired of using chat apps that felt stiff, cluttered, and soulless. I didn't want just another messaging clone; I wanted a platform that feels **alive, beautifully fluid, and incredibly fast**, while keeping your conversations totally secure. The result? A premium chat ecosystem wrapped in a gorgeous "Cosmic" dark mode (or a sleek "Saffron" light mode), filled with buttery-smooth animations, and completely free of clutter.

No ads. No creepy tracking algorithms. Just you, your favorite people, and a beautiful space to connect.

---

## ✨ Why You'll Love Sandesh

- **Breathtaking Aesthetics & Cultural Touches:** Jump into a premium UI designed with modern glassmorphism, glowing accents, and smooth liquid buttons. We've even added subtle cultural nods—like the typing effect on the landing page that spells out "वसुधैव कुटुम्बकम्" (*The world is one family*). It looks and feels stunning whether you're using it on an iPhone, Android, iPad, Mac, or Windows PC.
- **True Real-Time Messaging:** Powered by highly optimized WebSockets. When you hit send, it's there. No refreshing, no lagging, no waiting around.
- **Disappearing Messages:** Want more privacy? You can easily set your messages to automatically vanish after 1 day, 1 week, 1 month, or 6 months. It's your digital footprint, and you're in total control.
- **Moments (24-hour Stories):** Share your day with beautifully implemented "Moments." You can view your friends' stories, which are wrapped in sleek, glowing rings that adapt perfectly to both light and dark modes.
- **Crystal-Clear Voice & Video Calls:** Start high-quality peer-to-peer WebRTC calls directly from your browser. One click is all it takes to see or hear your friends.
- **Smart "Missed Call" System:** If you try to reach someone who is offline, Sandesh acts like your personal assistant, instantly dropping a clean, professional "Missed Call" card into your chat feed.
- **Flexible & Secure Sign-in:** Hate remembering usernames? We get it. You can securely sign in using your **Username, Email, or Phone Number**. Phone numbers are instantly validated and neatly formatted with correct international country codes.
- **End-to-End Polish:** See exactly who is online in real time, watch typing indicators pop up seamlessly when someone is writing to you, and enjoy a strict layout that never breaks. No weird background scrolling or overlapping keyboards—just a perfectly stable, native app feel.
- **Your Personal Space:** Need to drop quick notes, files, or ideas just for yourself? Enjoy a dedicated "Saved Messages" space built specifically for that.

---

## 🛠️ What's Under the Hood?

Sandesh is engineered to be as robust and secure as it is beautiful.

| Component | Technology Powering It |
|---|---|
| **Backend Core** | Django 5, Python 3 |
| **Real-Time Engine** | Django Channels, WebSockets, Daphne (ASGI) |
| **P2P Calling** | WebRTC (with STUN/TURN fallback for rock-solid reliability) |
| **Database** | PostgreSQL (Production) / SQLite (Local) |
| **Media & File Storage** | Cloudinary (Production) / Local filesystem |
| **Frontend UI** | Vanilla HTML, CSS, JavaScript (Zero heavy frameworks weighing it down!) |

---

## 🚀 Run It Locally in Minutes

Want to take Sandesh for a spin on your own machine? It's incredibly straightforward. All you need is Python installed—no Docker or complicated database setups required.

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
The engine automatically detects your environment and effortlessly switches from local SQLite and storage to rock-solid PostgreSQL and Cloudinary the moment you feed it your production variables!

**Essential Environment Variables for Production:**
- `SECRET_KEY`, `DEBUG=False`, `ALLOWED_HOSTS`
- `DATABASE_URL` (Postgres) & `REDIS_URL` (For lightning-fast WebSockets)
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
- `TURN_SERVER_URL`, `TURN_SERVER_USERNAME`, `TURN_SERVER_CREDENTIAL` (For flawless WebRTC calls across any network)

---

### A Final Note from the Creator

> *"Code shouldn't just function; it should feel amazing to use. I poured my heart into every pixel and every line of code to make sure Sandesh respects your time and your eyes. I hope you enjoy messaging on Sandesh as much as I loved bringing it to life."* — **Raj**
