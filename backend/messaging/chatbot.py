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
            
        sanitized.append({"role": role, "parts": [{"text": content[:800]}]})

    # Ensure history starts with user, if not, drop the first item
    history_slice = sanitized[-8:]
    if history_slice and history_slice[0]["role"] == "model":
        history_slice = history_slice[1:]
        
    return history_slice


def _gemini_reply(message: str, history: list[dict], user=None) -> str | None:
    api_key = getattr(settings, "GEMINI_API_KEY", "")
    if not api_key:
        return "⚠️ **Configuration Error**: Gemini API key is missing. Please set it in your `.env` file."
    
    if api_key.strip() == "your_api_key_here" or api_key.strip() == "":
        return "⚠️ **Configuration Error**: Your Gemini API key is set to a default placeholder (`your_api_key_here`). Please replace it with your actual key from Google AI Studio."

    model_name = getattr(settings, "CHATBOT_MODEL", "gemini-3.5-flash")
    temperature = float(getattr(settings, "CHATBOT_TEMPERATURE", 0.7))
    max_tokens = int(getattr(settings, "CHATBOT_MAX_TOKENS", 500))
    system_prompt = (getattr(settings, "CHATBOT_SYSTEM_PROMPT", "") or "").strip()
    if not system_prompt:
        system_prompt = _DEFAULT_SYSTEM_PROMPT

    # Default Safety Settings to block violent/sexual content
    safety_settings = [
        {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_MEDIUM_AND_ABOVE"},
        {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_MEDIUM_AND_ABOVE"},
        {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_LOW_AND_ABOVE"},
        {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_LOW_AND_ABOVE"},
    ]

    try:
        client = genai.Client(api_key=api_key)
        
        config = genai.types.GenerateContentConfig(
            temperature=temperature,
            max_output_tokens=max_tokens,
            system_instruction=system_prompt,
            safety_settings=safety_settings,
        )
        
        chat = client.chats.create(model=model_name, config=config, history=history)
        response = chat.send_message(message)
        return response.text.strip() or None
        
    except Exception as e:
        error_str = str(e)
        
        # Check for Quota Exceeded / 429
        if "429" in error_str or "quota" in error_str.lower() or "exhausted" in error_str.lower():
            api_key_2 = getattr(settings, "GEMINI_API_KEY_2", "")
            if api_key_2 and api_key_2 != "your_api_key_here":
                try:
                    client2 = genai.Client(api_key=api_key_2)
                    config2 = genai.types.GenerateContentConfig(
                        temperature=temperature,
                        max_output_tokens=max_tokens,
                        system_instruction=system_prompt,
                        safety_settings=safety_settings,
                    )
                    chat2 = client2.chats.create(model=model_name, config=config2, history=history)
                    response2 = chat2.send_message(message)
                    return response2.text.strip() or None
                except Exception as e2:
                    print(f"Gemini API Error (Fallback Key): {e2}")
                    err_lower2 = str(e2).lower()
                    if "safety" in err_lower2 or "harm_category" in err_lower2 or "blocked" in err_lower2:
                        return "I'm sorry, but I cannot fulfill this request as it violates safety and content policies."
                    return "⚠️ **API Limit Exceeded**: Both primary and fallback AI keys have reached their capacity limits. Please try again later."
            
            return "⚠️ **API Limit Exceeded**: The AI is currently busy and has reached its request limit. Please try again later."

        print(f"Gemini API Error: {error_str}")
        
        if "API key not valid" in error_str:
            return "⚠️ **Configuration Error**: The provided Gemini API Key is invalid."
        elif "API_KEY_INVALID" in error_str:
            return "⚠️ **Configuration Error**: Your Gemini API Key is missing or invalid."
            
        # Check for safety filter blocks
        err_lower = error_str.lower()
        if "safety" in err_lower or "harm_category" in err_lower or "blocked" in err_lower:
            return "I'm sorry, but I cannot fulfill this request as it violates safety and content policies."
            
        return "⚠️ **Service Unavailable**: I am currently experiencing technical difficulties connecting to the API. Please try again in a few moments."
