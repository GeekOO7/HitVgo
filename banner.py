# -*- coding: utf-8 -*-
"""Startup terminal banner: 3D ASCII brand logo + official platform."""
from __future__ import annotations

import os
import sys
from typing import Iterable, List, Optional, Sequence

OFFICIAL_URL = "https://hitvgo.geek007.com"
BRAND_LINE = "HitVgo · 影高"
AUTHOR = "Geek007"

# ANSI Shadow style (figlet), ~50 columns
_LOGO_LINES = (
    " ██╗  ██╗██╗████████╗██╗   ██╗ ██████╗  ██████╗ ",
    " ██║  ██║██║╚══██╔══╝██║   ██║██╔════╝ ██╔═══██╗",
    " ███████║██║   ██║   ██║   ██║██║  ███╗██║   ██║",
    " ██╔══██║██║   ██║   ╚██╗ ██╔╝██║   ██║██║   ██║",
    " ██║  ██║██║   ██║    ╚████╔╝ ╚██████╔╝╚██████╔╝",
    " ╚═╝  ╚═╝╚═╝   ╚═╝     ╚═══╝   ╚═════╝  ╚═════╝ ",
)

_CYAN = "\033[96m"
_RESET = "\033[0m"


def _fix_stdio() -> None:
    """Avoid UnicodeEncodeError on Windows GBK consoles."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def _use_color() -> bool:
    if os.environ.get("NO_COLOR"):
        return False
    if not hasattr(sys.stdout, "isatty") or not sys.stdout.isatty():
        return False
    return True


def format_startup_banner(extra_lines: Optional[Sequence[str]] = None) -> str:
    """Return banner text (no trailing flush)."""
    color = _use_color()
    parts: List[str] = [""]
    for line in _LOGO_LINES:
        parts.append(f"{_CYAN}{line}{_RESET}" if color else line)
    parts.append("")
    parts.append(f"  {BRAND_LINE}")
    parts.append(f"  官方平台  {OFFICIAL_URL}")
    parts.append(f"  作者      {AUTHOR}")
    if extra_lines:
        parts.append("")
        for line in extra_lines:
            parts.append(f"  {line}" if line and not line.startswith("  ") else line)
    parts.append("")
    return "\n".join(parts)


def print_startup_banner(extra_lines: Optional[Iterable[str]] = None) -> None:
    """Print brand logo and official platform; optional extra info lines."""
    _fix_stdio()
    lines = list(extra_lines) if extra_lines is not None else None
    print(format_startup_banner(lines), flush=True)


def should_print_banner(*, debug: bool = False) -> bool:
    """Skip parent process when Werkzeug reloader would print twice."""
    if not debug:
        return True
    return os.environ.get("WERKZEUG_RUN_MAIN") == "true"
