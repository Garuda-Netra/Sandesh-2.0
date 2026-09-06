"""
Chatbot helpers for Sandesh.

Provides a local fallback response engine and optional OpenAI-backed replies
if configured through environment variables.
"""

from __future__ import annotations

import json
import random
import re
import urllib.error
import urllib.request
from typing import Iterable

from django.conf import settings


from google import genai

_DEFAULT_SYSTEM_PROMPT = (
    "You are Vyasa, the intelligent, friendly, and helpful AI companion built into Sandesh 2.0 (crafted with love by Raj).\n"
    "You have two core responsibilities:\n"
    "1. Expert Guide for Sandesh 2.0 Web Application: Whenever users ask questions about Sandesh, its features, navigation, or how to use the app, provide accurate, step-by-step guidance tailored specifically to this web application platform.\n"
    "2. General Assistant: For any general questions (coding, science, everyday knowledge, writing, translations, or friendly conversation), answer intelligently and helpfully.\n\n"
    "KNOWLEDGE BASE FOR SANDESH 2.0 (WEB APP PLATFORM):\n"
    "- Architecture & Interface: Sandesh 2.0 is a modern real-time web application accessed in a browser. The interface consists of a top navigation bar, a left sidebar for conversations and contacts, and a main chat area.\n"
    "- Important Distinction: Sandesh 2.0 is a browser-based web application. There is NO floating '+' or new chat button at the bottom right corner (which only appears in native phone apps). All chat creation, group creation, and user discovery are located in the left sidebar.\n"
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
    "  Click the retention clock icon in chat options to set disappearing messages (2 days, 1 week, 1 month, or 6 months). Hover over any message and click the three dots (⋯) for 'Remove from My View' (hide for yourself) or 'Delete for All' (delete for everyone).\n"
    "- Saved Messages:\n"
    "  Available in the left sidebar as your personal cloud notepad to save links, text, and files.\n"
    "- Themes:\n"
    "  Toggle between Dark Mode and Light Mode using the theme button in the top navigation bar.\n"
    "- Account & Security:\n"
    "  Access profile details, manage active login sessions, and disconnect remote devices from your profile dropdown in the top navigation bar.\n\n"
    "STRICT FORMATTING RULES:\n"
    "- Absolutely DO NOT use markdown asterisks (no ** and no *) anywhere in your replies. Never write **word** or *word*. Output clean, crisp plain text.\n"
    "- Use simple numbered lists (1., 2.) or hyphens (-) for bullet points.\n"
    "- Automatically reply in the language the user speaks (English, Hindi, Hinglish, etc.). Keep explanations clear, concise, and easy to follow."
)


def generate_chatbot_reply(message: str, history: Iterable[dict] | None = None, user=None) -> str:
    """Return a chatbot reply for the given user message."""
    cleaned = (message or "").strip()
    if not cleaned:
        return "Please type a message so I can help."

    normalized_history = _normalize_history(history or [])

    reply = _gemini_reply(cleaned, normalized_history, user)
    if reply:
        return reply

    return "I am currently experiencing technical difficulties. Please try again later."


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
    cleaned = re.sub(r'(?m)^\s*\*\s+', '- ', text)
    # Strip markdown bold/italic asterisks: **word** -> word, *word* -> word
    cleaned = re.sub(r'\*{1,3}([^*]+?)\*{1,3}', r'\1', cleaned)
    # Remove any remaining stray asterisks
    cleaned = cleaned.replace('**', '').replace('*', '')
    return cleaned.strip() or None


def _gemini_reply(message: str, history: list[dict], user=None) -> str | None:
    api_key = getattr(settings, "GEMINI_API_KEY", "")
    if not api_key:
        return "⚠️ Configuration Error: Gemini API key is missing. Please set it in your .env file."
    
    if api_key.strip() == "your_api_key_here" or api_key.strip() == "":
        return "⚠️ Configuration Error: Your Gemini API key is set to a default placeholder (your_api_key_here). Please replace it with your actual key from Google AI Studio."

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
            if api_key_2 and api_key_2 != "your_backup_api_key_here" and api_key_2 != "your_api_key_here":
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
