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

    reply = _openai_reply(cleaned, normalized_history, user)
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
        sanitized.append({"role": role, "content": content[:800]})

    return sanitized[-8:]


def _openai_reply(message: str, history: list[dict], user=None) -> str | None:
    api_key = getattr(settings, "CHATBOT_OPENAI_API_KEY", "")
    model = getattr(settings, "CHATBOT_MODEL", "gpt-4o-mini")
    base_url = getattr(settings, "CHATBOT_OPENAI_BASE_URL", "https://api.openai.com/v1")
    temperature = float(getattr(settings, "CHATBOT_TEMPERATURE", 0.7))
    max_tokens = int(getattr(settings, "CHATBOT_MAX_TOKENS", 500))
    system_prompt = (getattr(settings, "CHATBOT_SYSTEM_PROMPT", "") or "").strip()
    if not system_prompt:
        system_prompt = _DEFAULT_SYSTEM_PROMPT

    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(history)
    messages.append({"role": "user", "content": message})

    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    user_id = str(getattr(user, "id", "") or "").strip()
    if user_id:
        payload["user"] = user_id

    url = base_url.rstrip("/") + "/chat/completions"
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read().decode("utf-8")
        payload = json.loads(raw)
        choices = payload.get("choices") or []
        if not choices:
            return None
        content = choices[0].get("message", {}).get("content", "").strip()
        return content or None
    except urllib.error.HTTPError:
        return None
    except Exception:
        return None
