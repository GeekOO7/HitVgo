# -*- coding: utf-8 -*-
"""Build static/agent/vflow-local-agent.zip from local_agent/ for download."""
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "local_agent"
OUT_DIR = ROOT / "static" / "agent"
OUT = OUT_DIR / "vflow-local-agent.zip"

INCLUDE = {
    "app.py",
    "banner.py",
    "runners.py",
    "duck_decode.py",
    "requirements.txt",
    "start.bat",
    "README.md",
}

def _zip_bytes(name: str, path: Path) -> bytes:
    data = path.read_bytes()
    # Windows cmd.exe misparses .bat files that only have LF newlines
    # (e.g. "'cp' is not recognized" from a broken "chcp" line).
    if name.lower().endswith(".bat"):
        text = data.decode("utf-8-sig")
        text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\r\n")
        data = text.encode("ascii", errors="strict")
    return data


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name in sorted(INCLUDE):
            path = SRC / name
            if not path.is_file():
                raise SystemExit(f"missing {path}")
            arc = f"vflow-local-agent/{name}"
            zf.writestr(arc, _zip_bytes(name, path))
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")

if __name__ == "__main__":
    main()
