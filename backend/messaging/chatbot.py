"""
Chatbot helpers for Sandesh 2.0.

Provides Vyasa AI companion integration backed by Google Gemini API,
with a robust local generative engine for Thoughtful Auto-Wishes and
intelligent web app navigation assistance.
"""

from __future__ import annotations

import random
import re
from typing import Iterable

from django.conf import settings
from google import genai

_DEFAULT_SYSTEM_PROMPT = (
    "You are Vyasa, the intelligent, friendly, and helpful AI companion built into Sandesh 2.0 (crafted with love by Raj).\n"
    "You have three core responsibilities:\n"
    "1. Expert Guide for Sandesh 2.0 Web Application: Whenever users ask questions about Sandesh, its features, navigation, or how to use the app, provide accurate, step-by-step guidance tailored specifically to this web application platform.\n"
    "2. General Assistant: For any general questions (coding, science, everyday knowledge, writing, translations, or friendly conversation), answer intelligently and helpfully.\n"
    "3. Thoughtful Auto-Wishes & Celebration Greetings: You can compose, draft, and personalize heartfelt birthday, anniversary, and celebration wishes in warm English or authentic Hinglish adorned with celebratory symbols and festive emojis (🎉, 🎂, 🎈, ✨, 🌟, 🥳, 💖, 💐, 🎊, 🥂, 🎁). Whenever asked to draft, compose, or write a celebration wish, birthday greeting, or message, always generate complete, heartfelt, and beautifully structured wishes (at least 3-4 warm, complete sentences) decorated with vibrant celebration symbols.\n\n"
    "KNOWLEDGE BASE FOR SANDESH 2.0 (WEB APP PLATFORM):\n"
    "- Architecture & Interface: Sandesh 2.0 is a modern real-time web application accessed in a browser. The interface consists of a top navigation bar, a left sidebar for conversations and contacts, and a main chat area.\n"
    "- Important Distinction: Sandesh 2.0 is a browser-based web application. There is NO floating '+' or new chat button at the bottom right corner (which only appears in native phone apps). All chat creation, group creation, and user discovery are located in the left sidebar.\n"
    "- Thoughtful Auto-Wishes:\n"
    "  Location: Click the '🎉' button in the Vyasa AI chatbot header to open the Auto-Wish Settings modal.\n"
    "  Features: Automatically drafts heartfelt birthday, anniversary, and celebration wishes in warm English or Hinglish with symbols that you can review, edit, and approve to send with one tap. Supports automatic real-time WebSocket delivery on the event date.\n"
    "- Creating a Group:\n"
    "  Location: Top of the left sidebar, right next to the 'Messages' header.\n"
    "  Button: An icon button showing people/users titled 'Create Group'.\n"
    "  Steps to create a group:\n"
    "  1. Click the 'Create Group' button located next to 'Messages' at the top of the left sidebar.\n"
    "  2. In the 'Create New Group' popup modal, enter your Group Name and optional Description.\n"
    "  3. Check the friends you want to invite from your contacts list.\n"
    "  4. Click the 'Create Group' button at the bottom of the modal.\n"
    "- Starting a New Chat / Where is the New Chat Button:\n"
    "  Location: Use the 'Search users…' input bar at the top of the left sidebar.\n"
    "  Steps: Type a username or phone number to find a user. Send a friend request; once accepted or connected, click their name in your active chat list to start chatting.\n"
    "- Audio & Video Calling:\n"
    "  In any active chat, click the Phone icon (Voice Call) or Camera icon (Video Call) in the top chat header to start a peer-to-peer call via WebRTC.\n"
    "- Media & File Sharing:\n"
    "  Click the Paperclip (attachment) icon beside the chat input box to upload photos, videos, PDFs, audio, or files up to 5 MB. Clicking on any media message in the chat opens an interactive full-screen Media Lightbox Popup with zoom, pan, video playback, and PDF viewer.\n"
    "- Moments (24-Hour Stories):\n"
    "  Located at the top of the sidebar under 'Moments'. Click your avatar with the '+' icon to share a photo or video story with optional captions and Spotify music tracks. Moments expire after 24 hours.\n"
    "- Privacy & Message Controls:\n"
    "  Click the retention clock icon in chat options to set disappearing messages (2 days, 1 week, or 1 month). Hover over any message and click the three dots (⋯) for 'Remove from My View' (hide for yourself) or 'Delete for All' (delete for everyone).\n"
    "- Saved Messages:\n"
    "  Available in the left sidebar as your personal cloud notepad to save links, text, and files.\n"
    "- Themes:\n"
    "  Toggle between Dark Mode and Light Mode using the theme button in the top navigation bar.\n"
    "- Account & Security:\n"
    "  Access profile details, manage active login sessions, and disconnect remote devices from your profile dropdown in the top navigation bar.\n\n"
    "STRICT FORMATTING RULES:\n"
    "- Absolutely DO NOT use markdown asterisks (no ** and no *) anywhere in your replies. Never write **word** or *word*. Output clean, crisp plain text.\n"
    "- Celebration emojis and festive symbols (🎉, 🎂, 🎈, ✨, 🌟, 🥳, 💖, 💐, 🎊, etc.) are warmly encouraged for celebration wishes, greetings, and joyful moments!\n"
    "- Use simple numbered lists (1., 2.) or hyphens (-) for bullet points.\n"
    "- Automatically reply in the language the user speaks (English, Hindi, Hinglish, etc.). Keep explanations clear, concise, and easy to follow."
)


# ---------------------------------------------------------------------------
# Thoughtful Auto-Wishes Generative Engine (Powered by Vyasa AI)
# ---------------------------------------------------------------------------

def generate_auto_wish(
    event_type: str = "birthday",
    custom_event_name: str = "",
    sender_name: str = "Friend",
    recipient_name: str = "Friend",
    language_preference: str = "english",
    user=None,
) -> str:
    """
    Dynamically draft a heartfelt, complete celebration wish with festive symbols via Vyasa AI (Google Gemini).
    Always generates unique, personal messages without any hard-coded template dictionaries.
    """
    sender = (sender_name or "Friend").strip()
    recipient = (recipient_name or "Friend").strip()
    lang = (language_preference or "english").strip().lower()
    evt_type = (event_type or "birthday").strip().lower()
    custom_name = (custom_event_name or "").strip()

    if evt_type == "custom" and custom_name:
        occasion_label = custom_name
    elif evt_type == "anniversary":
        occasion_label = "Anniversary"
    else:
        occasion_label = "Birthday"

    if lang == "hinglish":
        prompt = (
            f"You are Vyasa AI drafting a Thoughtful Auto-Wish in Sandesh 2.0. "
            f"Draft a warm, heartfelt, and complete celebration wish for {occasion_label} from {sender} to {recipient}.\n"
            f"Requirements:\n"
            f"1. Language: Conversational, heartfelt Hinglish (Hindi written in English/Latin alphabet, e.g. 'Janamdin ki dher saari shubhkamnayein! Rab kare aapka har din khushiyon se bhara ho'). Do NOT write in pure English.\n"
            f"2. Completeness: Write at least 3-4 complete, cohesive sentences in a single warm, flowing paragraph.\n"
            f"3. Celebration Symbols: Include vibrant celebration emojis and festive symbols (such as 🎉, 🎂, 🎈, ✨, 🌟, 🥳, 💖, 💐, 🎊, 🥂) woven naturally across the message.\n"
            f"4. Content: Include a joyful opening to {recipient}, deep appreciation and prayers for unki achhi sehat, khushi aur kamyabi, and a warm sign-off from {sender}.\n"
            f"5. Formatting: Output clean plain text without any markdown asterisks (no * and no **)."
        )
    else:
        prompt = (
            f"You are Vyasa AI drafting a Thoughtful Auto-Wish in Sandesh 2.0. "
            f"Draft a warm, heartfelt, and complete celebration wish for {occasion_label} from {sender} to {recipient}.\n"
            f"Requirements:\n"
            f"1. Language: Warm, natural, and expressive English.\n"
            f"2. Completeness: Write at least 3-4 complete, cohesive sentences in a single heartwarming, flowing paragraph.\n"
            f"3. Celebration Symbols: Include vibrant celebration emojis and festive symbols (such as 🎉, 🎂, 🎈, ✨, 🌟, 🥳, 💖, 💐, 🎊, 🥂) woven naturally across the message.\n"
            f"4. Content: Include a joyous opening to {recipient}, deep appreciation and inspiring blessings for their health, happiness, and future triumphs, and a warm sign-off from {sender}.\n"
            f"5. Formatting: Output clean plain text without any markdown asterisks (no * or **)."
        )

    ai_reply = _gemini_reply(prompt, [], user)
    if ai_reply and "⚠️" not in ai_reply and not ai_reply.lower().startswith("i am currently experiencing"):
        # Strip outer quotes if any
        cleaned_wish = ai_reply.strip().strip('"\'')
        # Guarantee celebratory symbols are present
        symbols_sample = ["🎉", "🎂", "🎈", "✨", "🌟", "🥳", "💖", "💐", "🎊", "🥂"]
        if not any(sym in cleaned_wish for sym in symbols_sample):
            cleaned_wish = cleaned_wish.strip() + " " + "".join(random.sample(symbols_sample, 3))
        return cleaned_wish

    if ai_reply and "⚠️" in ai_reply:
        return ai_reply

    return "⚠️ Vyasa AI is currently unavailable to generate wishes. Please verify your GEMINI_API_KEY configuration."


def generate_chatbot_reply(message: str, history: Iterable[dict] | None = None, user=None) -> str:
    """Return a chatbot reply for the given user message."""
    cleaned = (message or "").strip()
    if not cleaned:
        return "Please type a message so I can help."

    normalized_history = _normalize_history(history or [])

    reply = _gemini_reply(cleaned, normalized_history, user)
    if reply and "⚠️" not in reply and not reply.startswith("I am currently experiencing"):
        return reply

    # Local guide response for Sandesh 2.0 web app navigation
    guide_reply = _local_guide_reply(cleaned, user)
    if guide_reply:
        return guide_reply

    # If Gemini returned a specific user-facing warning (e.g. invalid key or missing key during general chat), return it
    if reply and "⚠️" in reply:
        return reply

    return "Hello! I am Vyasa, your AI companion in Sandesh 2.0. How can I help you today? You can ask me how to navigate Sandesh, draft thoughtful celebration auto-wishes, or chat about anything!"


def _local_guide_reply(message: str, user=None) -> str | None:
    """Provide offline local guidance for Sandesh 2.0 features when API is offline."""
    text = message.lower()
    name = getattr(user, "first_name", "") or getattr(user, "username", "") or ""

    if re.search(r"\b(hi|hello|hey|greetings|namaste)\b", text):
        greeting_suffix = f" {name}" if name else ""
        return (
            f"Hello{greeting_suffix}! I am Vyasa, your intelligent companion in Sandesh 2.0. "
            f"I can guide you through every feature of Sandesh, draft heartfelt celebration wishes with symbols, "
            f"or assist with questions. What would you like to explore?"
        )

    if re.search(r"\b(auto-wish|autowish|auto wish|schedule wish)\b", text):
        return (
            "🎉 Thoughtful Auto-Wishes:\n"
            "Click the 🎉 (party popper) button at the top of the Vyasa AI header to open Auto-Wish Settings.\n"
            "1. Select a friend from your contacts.\n"
            "2. Pick an Event Type (Birthday, Anniversary, or Custom Celebration).\n"
            "3. Choose your date and Language Preference (English or Hinglish).\n"
            "4. Tap 'Add Event' and Vyasa will immediately draft a heartfelt, complete wish with symbols.\n"
            "5. Review, tweak, or regenerate the wish, then tap 'Approve & Schedule' with one tap!"
        )

    if re.search(r"\b(group|create group|new group)\b", text):
        return (
            "👥 Creating a Group in Sandesh 2.0:\n"
            "1. Look at the top of the left sidebar, right next to the 'Messages' header.\n"
            "2. Click the 'Create Group' button (showing multiple people icon).\n"
            "3. Enter your Group Name and optional Description.\n"
            "4. Select the friends you want to invite from your contact list and click 'Create Group'."
        )

    if re.search(r"\b(new chat|find user|search user|start chat|where is new chat)\b", text):
        return (
            "💬 Starting a New Chat in Sandesh 2.0:\n"
            "Sandesh 2.0 is a browser-based web application with no bottom-corner '+' floating button.\n"
            "1. Use the 'Search users…' input bar at the top of the left sidebar.\n"
            "2. Type the username or phone number of the person you want to message.\n"
            "3. Send a friend request; once connected, click their card in your sidebar to chat!"
        )

    if re.search(r"\b(call|voice call|video call|webrtc)\b", text):
        return (
            "📞 Audio & Video Calls in Sandesh 2.0:\n"
            "In any active 1-on-1 chat, look at the top chat header:\n"
            "- Click the Phone icon for a high-definition Voice Call.\n"
            "- Click the Camera icon for a peer-to-peer Video Call via WebRTC."
        )

    if re.search(r"\b(moment|moments|story|stories)\b", text):
        return (
            "✨ Moments (24-Hour Stories):\n"
            "Located at the top of the left sidebar under 'Moments'. Click your avatar with the '+' icon "
            "to share a photo or video story with optional captions and Spotify music soundtracks. Moments expire after 24 hours."
        )

    if re.search(r"\b(lock|chat lock|pin|biometric)\b", text):
        return (
            "🔒 Sandesh Chat Lock & Security:\n"
            "You can lock private chats using a security PIN or WebAuthn biometrics. Hover over the chat in your sidebar "
            "or check Chat Settings to toggle lock status."
        )

    return None


def _normalize_history(history: Iterable[dict]) -> list[dict]:
    sanitized = []
    last_role = None
    for item in history:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role", "")).strip().lower()
        content = str(item.get("content", "")).strip()
        if role not in {"user", "assistant"}:
            continue
        if not content:
            continue

        # Gemini expects 'model' instead of 'assistant' for the model's responses
        if role == "assistant":
            role = "model"

        if role == last_role and sanitized:
            # Combine consecutive messages from the same role
            sanitized[-1]["parts"][0]["text"] += "\n" + content[:800]
        else:
            sanitized.append({"role": role, "parts": [{"text": content[:800]}]})
            last_role = role

    # Ensure history starts with user, if not, drop the first item
    if sanitized and sanitized[0]["role"] == "model":
        sanitized = sanitized[1:]

    return sanitized[-8:]


def _clean_stars(text: str | None) -> str | None:
    if not text:
        return None
    # Convert line-start asterisk bullets "* item" to "- item"
    cleaned = re.sub(r"(?m)^\s*\*\s+", "- ", text)
    # Strip markdown bold/italic asterisks: **word** -> word, *word* -> word
    cleaned = re.sub(r"\*{1,3}([^*]+?)\*{1,3}", r"\1", cleaned)
    # Remove any remaining stray asterisks
    cleaned = cleaned.replace("**", "").replace("*", "")
    return cleaned.strip() or None


def _gemini_reply(message: str, history: list[dict], user=None) -> str | None:
    api_key = getattr(settings, "GEMINI_API_KEY", "")
    if not api_key:
        return "⚠️ Configuration Error: Gemini API key is missing. Please set it in your .env file."

    if api_key.strip() in {"your_api_key_here", "your_gemini_api_key_here", ""}:
        return "⚠️ Configuration Error: Your Gemini API key is set to a default placeholder. Please replace it with your actual key from Google AI Studio."

    model_name = getattr(settings, "CHATBOT_MODEL", "gemini-2.5-flash")
    temperature = float(getattr(settings, "CHATBOT_TEMPERATURE", 0.7))
    max_tokens = int(getattr(settings, "CHATBOT_MAX_TOKENS", 500))
    custom_prompt = (getattr(settings, "CHATBOT_SYSTEM_PROMPT", "") or "").strip()
    if custom_prompt:
        system_prompt = f"{_DEFAULT_SYSTEM_PROMPT}\n\nAdditional instructions:\n{custom_prompt}"
    else:
        system_prompt = _DEFAULT_SYSTEM_PROMPT

    try:
        client = genai.Client(api_key=api_key)

        config = genai.types.GenerateContentConfig(
            temperature=temperature,
            max_output_tokens=max_tokens,
            system_instruction=system_prompt,
        )

        chat = client.chats.create(model=model_name, config=config, history=history)
        response = chat.send_message(message)
        return _clean_stars(response.text)

    except Exception as e:
        error_str = str(e)
        if getattr(settings, "DEBUG", False):
            print(f"[Chatbot Error] {error_str}")

        # Check for Quota Exceeded / 429
        if "429" in error_str or "quota" in error_str.lower() or "exhausted" in error_str.lower():
            api_key_2 = getattr(settings, "GEMINI_API_KEY_2", "")
            if api_key_2 and api_key_2 not in {"your_backup_api_key_here", "your_api_key_here", "your_backup_gemini_api_key_here"}:
                try:
                    client2 = genai.Client(api_key=api_key_2)
                    config2 = genai.types.GenerateContentConfig(
                        temperature=temperature,
                        max_output_tokens=max_tokens,
                        system_instruction=system_prompt,
                    )
                    chat2 = client2.chats.create(model=model_name, config=config2, history=history)
                    response2 = chat2.send_message(message)
                    return _clean_stars(response2.text)
                except Exception as e2:
                    err_lower2 = str(e2).lower()
                    if "safety" in err_lower2 or "harm_category" in err_lower2 or "blocked" in err_lower2:
                        return "I'm sorry, but I cannot fulfill this request as it violates safety and content policies."
                    return "⚠️ API Limit Exceeded: Both primary and fallback AI keys have reached their capacity limits. Please try again later."

            return "⚠️ API Limit Exceeded: The AI is currently busy and has reached its request limit. Please try again later."

        if "503" in error_str or "high demand" in error_str.lower() or "unavailable" in error_str.lower():
            return "⚠️ High Demand: The AI model is currently experiencing a spike in traffic and is temporarily unavailable. Please try again in a minute."

        if "API key not valid" in error_str or "API_KEY_INVALID" in error_str:
            return "⚠️ Configuration Error: The provided Gemini API Key is invalid."

        # Check for safety filter blocks
        err_lower = error_str.lower()
        if "safety" in err_lower or "harm_category" in err_lower or "blocked" in err_lower:
            return "I'm sorry, but I cannot fulfill this request as it violates safety and content policies."

        return "⚠️ Service Unavailable: I am currently experiencing technical difficulties connecting to the API. Please try again in a few moments."
