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
    "You are Axiom, a helpful, general-purpose assistant. Answer a wide range of "
    "questions clearly and safely. Ask clarifying questions when needed. "
    "Default to 1-2 short sentences unless the user asks for detail."
)


def generate_chatbot_reply(message: str, history: Iterable[dict] | None = None, user=None) -> str:
    """Return a chatbot reply for the given user message."""
    cleaned = (message or "").strip()
    if not cleaned:
        return "Please type a message so I can help."

    normalized_history = _normalize_history(history or [])

    if _use_openai():
        reply = _openai_reply(cleaned, normalized_history, user)
        if reply:
            return reply

    return _local_reply(cleaned, user)


def _use_openai() -> bool:
    provider = str(getattr(settings, "CHATBOT_PROVIDER", "local") or "local").lower()
    api_key = getattr(settings, "CHATBOT_OPENAI_API_KEY", "")
    return provider == "openai" and bool(api_key)


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


def _local_reply(message: str, user=None) -> str:
    text = message.lower().strip()
    name = getattr(user, "username", "")

    greetings = [
        "Hi{suffix}! How can I help you today?",
        "Hello{suffix}! What can I help you with?",
        "Hey{suffix}! What do you want to work on today?",
    ]

    if re.search(r"\b(hi|hello|hey|yo|good morning|good evening)\b", text):
        suffix = f" {name}" if name else ""
        return random.choice(greetings).format(suffix=suffix)

    if re.search(r"\b(thanks|thank you|appreciate)\b", text):
        return "You are welcome. Want to explore a feature next?"

    if re.search(r"\b(who are you|what are you)\b", text):
        return "I am Axiom, your general-purpose assistant. Ask me anything."

    if re.search(r"\b(help|support|what can you do|capabilities)\b", text):
        return (
            "I can help with summaries, explanations, writing, brainstorming, planning, "
            "and troubleshooting."
        )

    if re.search(r"\b(summarize|summary|tl;dr)\b", text):
        return "Share the text and I will summarize it for you."

    if re.search(r"\b(explain|definition|what is|how does)\b", text):
        return "Tell me the concept or topic and the level of detail you want."

    if re.search(r"\b(write|draft|email|message|cover letter|proposal)\b", text):
        return "Tell me the audience, tone, and key points, and I will draft it."

    if re.search(r"\b(brainstorm|ideas|creative|name)\b", text):
        return "Share your goal, constraints, and style so I can brainstorm effectively."

    if re.search(r"\b(code|bug|error|stack trace|debug)\b", text):
        return "Paste the code or error message and describe what you expected to happen."

    if re.search(r"\b(math|calculate|equation)\b", text):
        return "Share the exact problem and I will work through it."

    return "I can help. Share a bit more context or your goal."
