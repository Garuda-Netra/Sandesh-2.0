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


import google.generativeai as genai

_DEFAULT_SYSTEM_PROMPT = (
    "You are Vyasa, a helpful, general-purpose assistant. You must answer every question the user asks. "
    "Give short and very simple answers by default so they are easy to understand."
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
            
        sanitized.append({"role": role, "parts": [content[:800]]})

    return sanitized[-8:]


def _gemini_reply(message: str, history: list[dict], user=None) -> str | None:
    api_key = getattr(settings, "GEMINI_API_KEY", "")
    if not api_key:
        return None
        
    model_name = getattr(settings, "CHATBOT_MODEL", "gemini-1.5-flash")
    temperature = float(getattr(settings, "CHATBOT_TEMPERATURE", 0.7))
    max_tokens = int(getattr(settings, "CHATBOT_MAX_TOKENS", 500))
    system_prompt = (getattr(settings, "CHATBOT_SYSTEM_PROMPT", "") or "").strip()
    if not system_prompt:
        system_prompt = _DEFAULT_SYSTEM_PROMPT

    try:
        genai.configure(api_key=api_key)
        
        # Configure model with system instruction and generation config
        generation_config = genai.types.GenerationConfig(
            temperature=temperature,
            max_output_tokens=max_tokens,
        )
        
        model = genai.GenerativeModel(
            model_name=model_name,
            system_instruction=system_prompt,
            generation_config=generation_config
        )
        
        # Start a chat session with the previous history
        chat = model.start_chat(history=history)
        
        # Send the new message
        response = chat.send_message(message)
        
        return response.text.strip() or None
    except Exception as e:
        print(f"Gemini API Error: {e}")
        return None
