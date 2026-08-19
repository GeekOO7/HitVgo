# -*- coding: utf-8 -*-
"""Backend message lookup by locale (X-Locale / Accept-Language)."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

import config

_BASE = Path(__file__).resolve().parent
_CACHE = {}  # type: dict[str, dict]


def _load(lang: str) -> dict:
    lang = "en" if lang == "en" else "zh"
    if lang in _CACHE:
        return _CACHE[lang]
    path = _BASE / ("messages_en.json" if lang == "en" else "messages_zh.json")
    data = {}
    if path.exists():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                data = {str(k): str(v) for k, v in raw.items()}
        except (OSError, ValueError, json.JSONDecodeError):
            data = {}
    _CACHE[lang] = data
    return data


def normalize_locale(raw: Optional[str]) -> str:
    if not raw:
        return "zh"
    s = str(raw).strip().lower().replace("_", "-")
    if s.startswith("en"):
        return "en"
    return "zh"


def request_locale(req=None) -> str:
    """Resolve locale from JSON body, X-Locale header, or Accept-Language."""
    from flask import request as flask_request

    r = req or flask_request
    # JSON body
    try:
        payload = r.get_json(silent=True) or {}
        if isinstance(payload, dict) and payload.get("locale"):
            return normalize_locale(payload.get("locale"))
    except Exception:
        pass
    hdr = (r.headers.get("X-Locale") or "").strip()
    if hdr:
        return normalize_locale(hdr)
    # query
    q = (r.args.get("locale") or "").strip()
    if q:
        return normalize_locale(q)
    accept = (r.headers.get("Accept-Language") or "").split(",")[0].strip()
    return normalize_locale(accept)


def t(key: str, locale: Optional[str] = None, **vars) -> str:
    lang = normalize_locale(locale) if locale else "zh"
    pack = _load(lang)
    fallback = _load("zh")
    text = pack.get(key) or fallback.get(key) or key
    if vars:
        try:
            text = text.format(**vars)
        except (KeyError, ValueError):
            pass
    return text


def msg(key: str, **vars) -> str:
    """Translate using current request locale."""
    return t(key, request_locale(), **vars)
