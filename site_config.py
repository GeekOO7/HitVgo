# -*- coding: utf-8 -*-
"""Site branding + SEO config (zh/en), persisted as data/site_config.json."""
from __future__ import annotations

import json
import os
import tempfile
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import config

SITE_CONFIG_FILE = config.DATA_DIR / "site_config.json"

LOCALES = ("zh", "en")
UI_KEYS = (
    "brandName",
    "pageTitle",
    "authTitle",
    "authSubtitleLogin",
    "authSubtitleRegister",
)
SEO_KEYS = (
    "title",
    "description",
    "keywords",
    "ogTitle",
    "ogDescription",
    "ogImage",
)

_CACHE = {"data": None}  # type: Dict[str, Optional[dict]]


def defaults() -> dict:
    return {
        "zh": {
            "ui": {
                "brandName": "HitVgo · 影高",
                "pageTitle": "HitVgo · 影高 — AI 视频创作平台",
                "authTitle": "HitVgo · 影高 — AI 视频创作平台",
                "authSubtitleLogin": "登录后使用多项目、任务队列与素材库",
                "authSubtitleRegister": "注册后即可使用多项目、任务队列与素材库",
            },
            "seo": {
                "title": "HitVgo · 影高 — AI 视频创作平台 | ComfyUI 工作流聚合",
                "description": (
                    "Geek007 开发的本机 AI 视频创作界面，对接你自己的 ComfyUI / RunningHub 工作流，"
                    "LLM 自动绑定参数，分镜写词、批量生成与时间轴剪接。"
                ),
                "keywords": (
                    "AI视频,ComfyUI,图生视频,视频剪辑,工作流,AI创作,HitVgo,影高,Geek007"
                ),
                "ogTitle": "HitVgo · 影高 — AI 视频创作平台",
                "ogDescription": "Geek007 出品——对接你自己的 ComfyUI 工作流，快速生成与剪接。",
                "ogImage": "",
            },
        },
        "en": {
            "ui": {
                "brandName": "HitVgo",
                "pageTitle": "HitVgo — AI Video Creation Platform",
                "authTitle": "HitVgo — AI Video Creation Platform",
                "authSubtitleLogin": "Sign in to use projects, job queue, and asset library",
                "authSubtitleRegister": "Register to use projects, job queue, and asset library",
            },
            "seo": {
                "title": "HitVgo — AI Video Creation Platform | ComfyUI Workflow Hub",
                "description": (
                    "A local AI video creation UI by Geek007 — connect your own ComfyUI / RunningHub workflows, "
                    "auto-bind with LLM, storyboard, batch-generate, and edit on a timeline."
                ),
                "keywords": (
                    "AI video,ComfyUI,image to video,video editing,workflow,HitVgo,Geek007"
                ),
                "ogTitle": "HitVgo — AI Video Creation Platform",
                "ogDescription": (
                    "By Geek007 — connect your own ComfyUI workflows; generate, review, and edit fast."
                ),
                "ogImage": "",
            },
        },
    }


def _as_str(value: Any, max_len: int = 2000) -> str:
    if value is None:
        return ""
    s = str(value).strip()
    if len(s) > max_len:
        s = s[:max_len]
    return s


def _normalize_locale_block(raw: Any, base: dict) -> dict:
    out = {
        "ui": {k: str(base["ui"].get(k, "")) for k in UI_KEYS},
        "seo": {k: str(base["seo"].get(k, "")) for k in SEO_KEYS},
    }
    if not isinstance(raw, dict):
        return out
    ui = raw.get("ui")
    if isinstance(ui, dict):
        for k in UI_KEYS:
            if k in ui:
                out["ui"][k] = _as_str(ui[k], 500)
    seo = raw.get("seo")
    if isinstance(seo, dict):
        for k in SEO_KEYS:
            if k in seo:
                limit = 2000 if k in ("description", "ogDescription", "keywords") else 500
                if k == "ogImage":
                    limit = 2000
                out["seo"][k] = _as_str(seo[k], limit)
    return out


def normalize(payload: Any) -> dict:
    base = defaults()
    raw = payload if isinstance(payload, dict) else {}
    return {
        loc: _normalize_locale_block(raw.get(loc), base[loc]) for loc in LOCALES
    }


def deep_merge(base: dict, override: Any) -> dict:
    """Merge override onto base for known locale/ui/seo keys only."""
    return normalize({**base, **(override if isinstance(override, dict) else {})})


def load(*, force_reload: bool = False) -> dict:
    if not force_reload and _CACHE["data"] is not None:
        return deepcopy(_CACHE["data"])
    data = defaults()
    if SITE_CONFIG_FILE.exists():
        try:
            raw = json.loads(SITE_CONFIG_FILE.read_text(encoding="utf-8"))
            data = deep_merge(data, raw)
        except (OSError, ValueError, json.JSONDecodeError):
            data = defaults()
    _CACHE["data"] = data
    return deepcopy(data)


def invalidate_cache() -> None:
    _CACHE["data"] = None


def save(payload: Any) -> Tuple[Optional[dict], Optional[str]]:
    """Validate, write atomically, refresh cache. Returns (data, error)."""
    if not isinstance(payload, dict):
        return None, "invalid payload"
    for loc in LOCALES:
        if loc not in payload or not isinstance(payload.get(loc), dict):
            return None, f"missing locale: {loc}"
        block = payload[loc]
        if not isinstance(block.get("ui"), dict) or not isinstance(block.get("seo"), dict):
            return None, f"locale {loc} needs ui and seo objects"
    data = normalize(payload)
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    fd = None
    tmp_path = None
    try:
        fd, tmp_path = tempfile.mkstemp(
            prefix="site_config_",
            suffix=".json",
            dir=str(config.DATA_DIR),
        )
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fd = None
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, SITE_CONFIG_FILE)
        tmp_path = None
    except OSError as e:
        return None, str(e)
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
    _CACHE["data"] = data
    return deepcopy(data), None


def for_locale(locale: str) -> dict:
    """Return {ui, seo} for a single locale (zh|en)."""
    loc = "en" if str(locale or "").lower().startswith("en") else "zh"
    cfg = load()
    return deepcopy(cfg[loc])
