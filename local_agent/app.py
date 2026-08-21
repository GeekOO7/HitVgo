#!/usr/bin/env python3
"""
Vflow / HitVgo local agent — listens on all interfaces (0.0.0.0) by default.

The website talks to this process instead of calling RunningHub / Comfy / LLM
from the browser (avoids CORS). Credentials stay on the user's machine.
Set VFLOW_AGENT_HOST=127.0.0.1 if you only want loopback.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
from urllib.parse import quote


def _fix_stdio() -> None:
    """Avoid UnicodeEncodeError on Windows GBK consoles when printing Chinese."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


_fix_stdio()

from flask import Flask, Response, jsonify, request

# Allow running as script from any cwd
_ROOT = Path(__file__).resolve().parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from runners import (  # noqa: E402
    create_comfy_remote_task,
    create_rh_remote_task,
    comfy_poll_once,
    download_bytes,
    rh_poll_once,
    run_comfy_job,
    run_rh_job,
)
import duck_decode  # noqa: E402

VERSION = "0.1.7"
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 39281
CONFIG_DIR = Path.home() / ".vflow-agent"
CONFIG_PATH = CONFIG_DIR / "config.json"
DEFAULT_ASSETS_DIR = str(CONFIG_DIR / "assets")

ALLOWED_ORIGINS = {
    "https://hitvgo.geek007.com",
    "http://hitvgo.geek007.com",
    "https://cte.7766.org",
    "http://cte.7766.org",
    "http://127.0.0.1",
    "http://localhost",
}

_EXT_MIME = {
    "mp4": "video/mp4",
    "webm": "video/webm",
    "mov": "video/quicktime",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
    "bin": "application/octet-stream",
}


def _looks_like_video_bytes(data: bytes) -> bool:
    if not data or len(data) < 12:
        return False
    if data[4:8] == b"ftyp":
        return True
    if data[:4] == b"\x1a\x45\xdf\xa3":
        return True
    return False


def _is_png_bytes(data: bytes) -> bool:
    return bool(data) and data[:8] == b"\x89PNG\r\n\x1a\n"


def _replace_filename_ext(filename: str, ext: str) -> str:
    name = filename or f"local.{ext}"
    stem = Path(name).stem or "local"
    clean_ext = (ext or "mp4").lower().lstrip(".")
    return f"{stem}.{clean_ext}"


def _content_disposition(filename: str) -> str:
    """RFC 5987 Content-Disposition; HTTP headers must be latin-1 only."""
    download_name = Path(filename or "local.mp4").name or "local.mp4"
    ascii_source = download_name.encode("ascii", errors="ignore").decode("ascii")
    ascii_name = re.sub(r"[^A-Za-z0-9.\-]+", "_", ascii_source) or "download.bin"
    return (
        f'attachment; filename="{ascii_name}"; '
        f"filename*=UTF-8''{quote(download_name)}"
    )


def maybe_decrypt_output(
    raw: bytes, use_duck: bool, password: str, filename: str
) -> Tuple[bytes, str, str, bool]:
    """Return (bytes, filename, mimetype, decrypted)."""
    if not use_duck:
        # Plain image outputs (e.g. T2I SaveImage)
        if _is_png_bytes(raw):
            out_name = _replace_filename_ext(filename, "png")
            return raw, out_name, "image/png", False
        if raw[:3] == b"\xff\xd8\xff":
            out_name = _replace_filename_ext(filename, "jpg")
            return raw, out_name, "image/jpeg", False
        if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
            out_name = _replace_filename_ext(filename, "webp")
            return raw, out_name, "image/webp", False
        if _looks_like_video_bytes(raw):
            return raw, filename, "video/mp4", False
        # Keep caller filename/ext when unknown binary
        ext = Path(filename or "local.bin").suffix.lower().lstrip(".") or "bin"
        mime = _EXT_MIME.get(ext, "application/octet-stream")
        return raw, filename, mime, False
    if _looks_like_video_bytes(raw):
        return raw, filename, "video/mp4", False
    if not _is_png_bytes(raw):
        raise RuntimeError(
            "已开启鸭鸭图解密，但成片既不是视频也不是 PNG 鸭鸭图"
        )
    try:
        media_bytes, ext = duck_decode.decode_duck_bytes(raw, password or "")
    except ValueError as exc:
        raise RuntimeError(str(exc) or "鸭鸭图解密失败") from exc
    ext = (ext or "mp4").lower().lstrip(".")
    if ext not in _EXT_MIME:
        ext = "mp4"
    out_name = _replace_filename_ext(filename, ext)
    mime = _EXT_MIME.get(ext, "video/mp4")
    return media_bytes, out_name, mime, True

app = Flask(__name__)


def default_config() -> Dict[str, Any]:
    return {
        "rh": {
            "baseUrl": "https://www.runninghub.ai",
            "apiKey": "",
            "workflowIdI2v": "",
            "workflowIdFlf": "",
            "adapter": None,
        },
        "comfy": {
            "baseUrl": "http://127.0.0.1:8188",
            "authHeader": "",
            "adapter": None,
        },
        "llm": {
            "baseUrl": "https://openrouter.ai/api/v1",
            "apiKey": "",
            "model": "",
        },
        "assetsDir": DEFAULT_ASSETS_DIR,
    }


def load_config() -> Dict[str, Any]:
    cfg = default_config()
    if CONFIG_PATH.is_file():
        try:
            raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                for key in ("rh", "comfy", "llm"):
                    if isinstance(raw.get(key), dict):
                        cfg[key].update(raw[key])
                if raw.get("assetsDir"):
                    cfg["assetsDir"] = str(raw["assetsDir"])
        except Exception:
            pass
    return cfg


def get_assets_dir() -> Path:
    """Return the configured assets directory, ensuring it exists."""
    cfg = load_config()
    d = Path(cfg.get("assetsDir") or DEFAULT_ASSETS_DIR)
    d.mkdir(parents=True, exist_ok=True)
    return d


def save_config(cfg: Dict[str, Any]) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    try:
        os.chmod(CONFIG_PATH, 0o600)
    except Exception:
        pass


def cors_origin() -> str:
    origin = request.headers.get("Origin") or ""
    if not origin:
        return "*"
    if origin in ALLOWED_ORIGINS:
        return origin
    # Allow any site origin (custom deploy domains / public agent URL).
    if origin.startswith("http://") or origin.startswith("https://"):
        return origin
    return "null"


def apply_cors(resp: Response) -> Response:
    origin = cors_origin()
    resp.headers["Access-Control-Allow-Origin"] = origin
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = (
        "Content-Type, Authorization, X-Requested-With"
    )
    resp.headers["Access-Control-Allow-Private-Network"] = "true"
    resp.headers["Access-Control-Expose-Headers"] = (
        "X-Task-Id, X-Agent-Version, Content-Type, Content-Disposition, X-Decrypted"
    )
    if origin != "*":
        resp.headers["Vary"] = "Origin"
    return resp


@app.after_request
def _after(resp: Response) -> Response:
    return apply_cors(resp)


@app.route("/", methods=["GET", "OPTIONS"])
@app.route("/health", methods=["GET", "OPTIONS"])
def health():
    if request.method == "OPTIONS":
        return ("", 204)
    cfg = load_config()
    return jsonify(
        {
            "ok": True,
            "version": VERSION,
            "name": "vflow-local-agent",
            "channels": {
                "rh": bool((cfg.get("rh") or {}).get("apiKey")),
                "comfy": bool((cfg.get("comfy") or {}).get("baseUrl")),
                "llm": bool((cfg.get("llm") or {}).get("apiKey")),
            },
            "configPath": str(CONFIG_PATH),
        }
    )


@app.route("/config", methods=["GET", "PUT", "OPTIONS"])
def config_route():
    if request.method == "OPTIONS":
        return ("", 204)
    if request.method == "GET":
        return jsonify(load_config())
    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        return jsonify({"ok": False, "error": "Invalid JSON"}), 400
    cfg = load_config()
    for key in ("rh", "comfy", "llm"):
        if isinstance(body.get(key), dict):
            cfg[key].update(body[key])
    if "assetsDir" in body:
        new_dir = str(body["assetsDir"] or DEFAULT_ASSETS_DIR).strip()
        if new_dir:
            try:
                Path(new_dir).mkdir(parents=True, exist_ok=True)
            except Exception as e:
                return jsonify({"ok": False, "error": f"Cannot create assetsDir: {e}"}), 400
            cfg["assetsDir"] = new_dir
    save_config(cfg)
    return jsonify({"ok": True, "config": cfg})


def _file_tuple(name: str) -> Optional[Tuple[bytes, str]]:
    f = request.files.get(name)
    if not f:
        return None
    data = f.read()
    if not data:
        return None
    return data, f.filename or f"{name}.png"


@app.route("/v1/video/run", methods=["POST", "OPTIONS"])
def video_run():
    if request.method == "OPTIONS":
        return ("", 204)
    try:
        meta_raw = request.form.get("meta") or "{}"
        meta = json.loads(meta_raw)
        if not isinstance(meta, dict):
            raise RuntimeError("meta must be a JSON object")
        channel = str(meta.get("channel") or "")
        adapter_mode = meta.get("adapterMode") or {}
        values = meta.get("values") or {}
        if not isinstance(adapter_mode, dict) or not isinstance(values, dict):
            raise RuntimeError("adapterMode/values must be objects")

        cfg = load_config()
        # Prefer request-embedded credentials if provided (synced from settings)
        rh_cfg = {**(cfg.get("rh") or {}), **(meta.get("rh") or {})}
        comfy_cfg = {**(cfg.get("comfy") or {}), **(meta.get("comfy") or {})}

        start_image = _file_tuple("startImage")
        end_image = _file_tuple("endImage")
        input_video = _file_tuple("inputVideo")
        input_audio = _file_tuple("inputAudio")

        if channel == "custom_rh":
            video_bytes, task_id = run_rh_job(
                base_url=str(rh_cfg.get("baseUrl") or "https://www.runninghub.ai"),
                api_key=str(rh_cfg.get("apiKey") or ""),
                adapter_mode=adapter_mode,
                values=values,
                start_image=start_image,
                end_image=end_image,
                input_video=input_video,
                input_audio=input_audio,
            )
        elif channel == "comfyui":
            video_bytes, task_id = run_comfy_job(
                base_url=str(comfy_cfg.get("baseUrl") or "http://127.0.0.1:8188"),
                auth_header=str(comfy_cfg.get("authHeader") or ""),
                adapter_mode=adapter_mode,
                values=values,
                start_image=start_image,
                end_image=end_image,
                input_video=input_video,
                input_audio=input_audio,
            )
        else:
            raise RuntimeError(f"Unsupported channel: {channel}")

        use_duck = bool(meta.get("useDuckEncrypt"))
        password = str(meta.get("password") or "")
        filename = str(meta.get("filename") or f"local_{task_id}.mp4")
        out_bytes, filename, mime, decrypted = maybe_decrypt_output(
            video_bytes, use_duck, password, filename
        )
        resp = Response(out_bytes, mimetype=mime)
        resp.headers["Content-Disposition"] = _content_disposition(filename)
        resp.headers["X-Task-Id"] = str(task_id)
        resp.headers["X-Agent-Version"] = VERSION
        resp.headers["X-Decrypted"] = "1" if decrypted else "0"
        return resp
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@app.route("/v1/video/create", methods=["POST", "OPTIONS"])
def video_create():
    """Create remote task and return taskId immediately (no wait for output)."""
    if request.method == "OPTIONS":
        return ("", 204)
    try:
        meta_raw = request.form.get("meta") or "{}"
        meta = json.loads(meta_raw)
        if not isinstance(meta, dict):
            raise RuntimeError("meta must be a JSON object")
        channel = str(meta.get("channel") or "")
        adapter_mode = meta.get("adapterMode") or {}
        values = meta.get("values") or {}
        if not isinstance(adapter_mode, dict) or not isinstance(values, dict):
            raise RuntimeError("adapterMode/values must be objects")

        cfg = load_config()
        rh_cfg = {**(cfg.get("rh") or {}), **(meta.get("rh") or {})}
        comfy_cfg = {**(cfg.get("comfy") or {}), **(meta.get("comfy") or {})}

        start_image = _file_tuple("startImage")
        end_image = _file_tuple("endImage")
        input_video = _file_tuple("inputVideo")
        input_audio = _file_tuple("inputAudio")

        if channel == "custom_rh":
            task_id = create_rh_remote_task(
                base_url=str(rh_cfg.get("baseUrl") or "https://www.runninghub.ai"),
                api_key=str(rh_cfg.get("apiKey") or ""),
                adapter_mode=adapter_mode,
                values=values,
                start_image=start_image,
                end_image=end_image,
                input_video=input_video,
                input_audio=input_audio,
            )
        elif channel == "comfyui":
            task_id = create_comfy_remote_task(
                base_url=str(comfy_cfg.get("baseUrl") or "http://127.0.0.1:8188"),
                auth_header=str(comfy_cfg.get("authHeader") or ""),
                adapter_mode=adapter_mode,
                values=values,
                start_image=start_image,
                end_image=end_image,
                input_video=input_video,
                input_audio=input_audio,
            )
        else:
            raise RuntimeError(f"Unsupported channel: {channel}")

        return jsonify(
            {
                "ok": True,
                "taskId": str(task_id),
                "channel": channel,
                "agentVersion": VERSION,
            }
        )
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@app.route("/v1/video/poll", methods=["POST", "OPTIONS"])
def video_poll():
    """Poll remote task. On SUCCESS returns video bytes; otherwise JSON status."""
    if request.method == "OPTIONS":
        return ("", 204)
    try:
        body = request.get_json(silent=True) or {}
        channel = str(body.get("channel") or "")
        task_id = str(body.get("taskId") or "").strip()
        if not task_id:
            raise RuntimeError("taskId required")

        cfg = load_config()
        rh_cfg = {**(cfg.get("rh") or {}), **(body.get("rh") or {})}
        comfy_cfg = {**(cfg.get("comfy") or {}), **(body.get("comfy") or {})}

        if channel == "custom_rh":
            once = rh_poll_once(
                str(rh_cfg.get("baseUrl") or "https://www.runninghub.ai"),
                str(rh_cfg.get("apiKey") or ""),
                task_id,
            )
        elif channel == "comfyui":
            once = comfy_poll_once(
                str(comfy_cfg.get("baseUrl") or "http://127.0.0.1:8188"),
                str(comfy_cfg.get("authHeader") or ""),
                task_id,
            )
        else:
            raise RuntimeError(f"Unsupported channel: {channel}")

        status = str(once.get("status") or "RUNNING").upper()
        if status != "SUCCESS":
            return jsonify(
                {
                    "ok": True,
                    "done": status == "FAILED",
                    "status": status,
                    "taskId": task_id,
                    "error": once.get("error"),
                    "agentVersion": VERSION,
                }
            )

        file_url = once.get("fileUrl")
        if not file_url:
            return jsonify(
                {
                    "ok": False,
                    "done": True,
                    "status": "FAILED",
                    "taskId": task_id,
                    "error": "No fileUrl on success",
                }
            ), 400

        video_bytes = download_bytes(str(file_url))
        use_duck = bool(body.get("useDuckEncrypt"))
        password = str(body.get("password") or "")
        filename = str(body.get("filename") or f"local_{task_id}.mp4")
        out_bytes, filename, mime, decrypted = maybe_decrypt_output(
            video_bytes, use_duck, password, filename
        )
        resp = Response(out_bytes, mimetype=mime)
        resp.headers["Content-Disposition"] = _content_disposition(filename)
        resp.headers["X-Task-Id"] = str(task_id)
        resp.headers["X-Agent-Version"] = VERSION
        resp.headers["X-Decrypted"] = "1" if decrypted else "0"
        resp.headers["X-Poll-Status"] = "SUCCESS"
        return resp
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@app.route("/v1/llm/chat", methods=["POST", "OPTIONS"])
def llm_chat():
    if request.method == "OPTIONS":
        return ("", 204)
    try:
        import requests as req_lib

        body = request.get_json(silent=True) or {}
        cfg = load_config()
        llm = {**(cfg.get("llm") or {}), **(body.get("llm") or {})}
        api_key = str(llm.get("apiKey") or "")
        base_url = str(llm.get("baseUrl") or "").rstrip("/")
        model = str(llm.get("model") or body.get("model") or "")
        if not api_key:
            raise RuntimeError("Missing LLM API Key — configure in settings and sync")
        if not base_url:
            raise RuntimeError("Missing LLM baseUrl")
        if not model:
            raise RuntimeError("Missing LLM model")

        messages = body.get("messages")
        if not messages:
            system = body.get("system") or ""
            user_msg = body.get("userMsg") or body.get("user") or ""
            messages = [
                {"role": "system", "content": system},
                {"role": "user", "content": user_msg},
            ]

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        if "openrouter.ai" in base_url:
            headers["HTTP-Referer"] = "https://hitvgo.geek007.com"
            headers["X-Title"] = "HitVgo"

        payload = {
            "model": model,
            "messages": messages,
            "temperature": body.get("temperature", 0.7),
        }
        resp = req_lib.post(
            f"{base_url}/chat/completions",
            headers=headers,
            json=payload,
            timeout=180,
        )
        result = {}
        try:
            result = resp.json()
        except Exception:
            pass
        if not resp.ok:
            msg = (
                (result.get("error") or {}).get("message")
                if isinstance(result.get("error"), dict)
                else result.get("error") or result.get("message") or f"HTTP {resp.status_code}"
            )
            raise RuntimeError(str(msg))
        content = (
            ((result.get("choices") or [{}])[0].get("message") or {}).get("content")
        )
        if not content:
            raise RuntimeError("LLM returned empty choices")
        return jsonify({"ok": True, "content": content, "raw": result})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


# ─── Asset disk storage endpoints ────────────────────────────────────────────

def _asset_path(asset_id: str, ext: str = "") -> Path:
    """Resolve the file path for an asset id inside assetsDir."""
    # Sanitize id to prevent path traversal
    safe_id = re.sub(r"[^A-Za-z0-9_\-]", "", asset_id)
    if not safe_id:
        raise ValueError("Invalid asset id")
    suffix = f".{ext}" if ext else ""
    return get_assets_dir() / f"{safe_id}{suffix}"


def _find_asset_file(asset_id: str) -> Optional[Path]:
    """Find an asset file by id regardless of extension."""
    safe_id = re.sub(r"[^A-Za-z0-9_\-]", "", asset_id)
    if not safe_id:
        return None
    d = get_assets_dir()
    # Try exact match first (no extension)
    exact = d / safe_id
    if exact.is_file():
        return exact
    # Try with common extensions
    for ext in _EXT_MIME:
        p = d / f"{safe_id}.{ext}"
        if p.is_file():
            return p
    # Glob fallback
    matches = list(d.glob(f"{safe_id}.*"))
    return matches[0] if matches else None


@app.route("/v1/assets/<asset_id>", methods=["PUT", "OPTIONS"])
def asset_put(asset_id: str):
    """Save an uploaded blob to disk."""
    if request.method == "OPTIONS":
        return ("", 204)
    try:
        blob = request.get_data()
        if not blob:
            return jsonify({"ok": False, "error": "Empty body"}), 400
        ct = request.content_type or "application/octet-stream"
        # Determine extension from content-type
        ext = "bin"
        for e, m in _EXT_MIME.items():
            if m == ct:
                ext = e
                break
        p = _asset_path(asset_id, ext)
        p.write_bytes(blob)
        return jsonify({"ok": True, "id": asset_id, "path": str(p), "size": len(blob)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@app.route("/v1/assets/<asset_id>", methods=["GET"])
def asset_get(asset_id: str):
    """Serve a stored asset file."""
    try:
        p = _find_asset_file(asset_id)
        if not p or not p.is_file():
            return jsonify({"ok": False, "error": "Not found"}), 404
        ext = p.suffix.lstrip(".").lower()
        mime = _EXT_MIME.get(ext, "application/octet-stream")
        data = p.read_bytes()
        resp = Response(data, mimetype=mime)
        resp.headers["Content-Length"] = str(len(data))
        resp.headers["Cache-Control"] = "private, max-age=31536000, immutable"
        return resp
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@app.route("/v1/assets/<asset_id>", methods=["DELETE"])
def asset_delete(asset_id: str):
    """Delete an asset file from disk."""
    try:
        p = _find_asset_file(asset_id)
        if p and p.is_file():
            p.unlink()
        return jsonify({"ok": True, "id": asset_id})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@app.route("/v1/assets", methods=["GET", "OPTIONS"])
def asset_list():
    """List all asset files on disk (id + size)."""
    if request.method == "OPTIONS":
        return ("", 204)
    try:
        d = get_assets_dir()
        items = []
        for f in sorted(d.iterdir()):
            if f.is_file():
                items.append({"id": f.stem, "filename": f.name, "size": f.stat().st_size})
        return jsonify({"ok": True, "assets": items, "assetsDir": str(d)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


# ─── End asset endpoints ─────────────────────────────────────────────────────


def main() -> None:
    host = os.environ.get("VFLOW_AGENT_HOST", DEFAULT_HOST)
    port = int(os.environ.get("VFLOW_AGENT_PORT", str(DEFAULT_PORT)))
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if not CONFIG_PATH.is_file():
        save_config(default_config())

    bind_hint = (
        f"http://0.0.0.0:{port}（全部网卡，局域网/公网可达）"
        if host in ("0.0.0.0", "::")
        else f"http://{host}:{port}"
    )
    from banner import print_startup_banner

    print_startup_banner(
        [
            f"本机助手  v{VERSION}",
            f"监听      {bind_hint}",
            f"本机检测  http://127.0.0.1:{port}",
            "已就绪，请回到网页点击「检测连接」",
            f"配置      {CONFIG_PATH}",
            "保持本窗口开启；关闭即停止助手",
        ]
    )
    # threaded=True so long video jobs don't block health checks
    app.run(host=host, port=port, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
