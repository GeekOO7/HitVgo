import json
import logging
import math
import os
import random
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import quote, urlparse

import requests
from flask import (
    Flask,
    g,
    jsonify,
    render_template,
    request,
    send_from_directory,
)
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.utils import secure_filename

import config
import db
import duck_decode
import site_config
from auth import current_user, login_required
from worker import TaskWorker
from i18n_messages import msg, request_locale

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 30 * 1024 * 1024
app.config["JSON_AS_ASCII"] = False
app.config["SECRET_KEY"] = config.get_session_secret()
app.json.ensure_ascii = False
# Behind HTTPS reverse proxy: trust X-Forwarded-* so secure cookies / urls work.
# Do NOT alias decoded/ as a static root — media stays behind the local-user gate.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
if (os.environ.get("SESSION_COOKIE_SECURE") or "").strip().lower() in (
    "1",
    "true",
    "yes",
):
    app.config["SESSION_COOKIE_SECURE"] = True

DECODED_DIR = config.BASE_DIR / "decoded"
DECODED_DIR.mkdir(parents=True, exist_ok=True)

_VIDEO_EXT_RE = re.compile(r"\.(mp4|webm|mov)(\?|$)", re.I)
_IMAGE_URL_EXT_RE = re.compile(r"\.(png|jpe?g|webp|gif|bmp)(\?|$)", re.I)
_SAFE_NAME_RE = re.compile(r"^[\w.\-]+$")

_http = requests.Session()
_http.trust_env = False

db.init_db(config.DB_PATH)
_worker: Optional[TaskWorker] = None
_worker_lock_fh = None


def _user_media_dir(user_id: int) -> Path:
    path = DECODED_DIR / str(user_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _upload_bytes_to_rh(raw: bytes, filename: str) -> str:
    """Upload bytes to platform RunningHub; return remote fileName."""
    api_key = config.get_api_key()
    url = f"{config.API_BASE}/task/openapi/upload"
    data = {"apiKey": api_key, "fileType": "input"}
    files = {
        "file": (
            filename or "upload.bin",
            raw,
            "application/octet-stream",
        )
    }
    resp = _http.post(
        url,
        headers={"Host": "www.runninghub.ai", "Authorization": f"Bearer {api_key}"},
        data=data,
        files=files,
        timeout=120,
    )
    body = resp.json()
    if body.get("code") != 0:
        raise ValueError(body.get("msg") or "upload failed")
    file_name = (body.get("data") or {}).get("fileName")
    if not file_name:
        raise ValueError("upload returned no fileName")
    return str(file_name)


def _is_rh_file_name(name: Optional[str]) -> bool:
    """RunningHub upload names look like `api/<hash>.ext`."""
    n = str(name or "").strip()
    return n.startswith("api/") and len(n) > 8


def resolve_request_images(user_id: int, request_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Freeze / restore RH image fileNames from local media snapshots bound at enqueue.
    Prefer request_json names when they look like real RH uploads; else media.rh_file_name;
    else re-upload local decoded copy.
    """
    req = dict(request_data or {})
    pairs = (
        ("imageMediaFileId", ("imageFileName", "startImageFileName")),
        ("startMediaFileId", ("startImageFileName", "imageFileName")),
        ("endMediaFileId", ("endImageFileName",)),
    )
    for mid_key, name_keys in pairs:
        mid_raw = req.get(mid_key)
        if mid_raw is None or mid_raw == "":
            continue
        try:
            mid = int(mid_raw)
        except (TypeError, ValueError):
            continue
        media = db.get_media_file_for_user(config.DB_PATH, user_id, mid)
        if not media:
            continue
        existing = ""
        for k in name_keys:
            existing = str(req.get(k) or "").strip()
            if existing:
                break
        if existing and _is_rh_file_name(existing):
            req[name_keys[0]] = existing
            continue
        rh_name = str(media.get("rh_file_name") or "").strip()
        if rh_name and _is_rh_file_name(rh_name):
            req[name_keys[0]] = rh_name
            continue
        safe = Path(str(media.get("filename") or "")).name
        if not safe:
            continue
        path = _user_media_dir(user_id) / safe
        if not path.is_file():
            continue
        uploaded = _upload_bytes_to_rh(path.read_bytes(), safe)
        req[name_keys[0]] = uploaded
        try:
            db.update_media_rh_file_name(config.DB_PATH, mid, uploaded)
        except Exception:
            pass
    return req


def _rh_headers(api_key=None):
    # type: (Optional[str]) -> Dict[str, str]
    headers = {
        "Host": "www.runninghub.ai",
        "Content-Type": "application/json",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _as_task_id_str(value):
    if value is None:
        return ""
    return str(value).strip()


def _ok(data=None, **extra):
    payload = {"success": True}
    if data is not None:
        payload["data"] = data
    payload.update(extra)
    return jsonify(payload)


def _err(message, status=400, **extra):
    payload = {"success": False, "message": message}
    payload.update(extra)
    return jsonify(payload), status


def _looks_like_video_url(url):
    path = urlparse(url).path.lower()
    return bool(_VIDEO_EXT_RE.search(path)) or "video" in path


def _looks_like_image_url(url):
    path = urlparse(url).path.lower()
    return bool(_IMAGE_URL_EXT_RE.search(path)) or "image" in path


def _image_ext_from_url(url, default="png"):
    path = urlparse(url).path.lower()
    m = _IMAGE_URL_EXT_RE.search(path)
    if not m:
        return default
    ext = m.group(1).lower()
    if ext == "jpeg":
        return "jpg"
    return ext


def _clamp_dim(val, default):
    try:
        n = int(val)
    except (TypeError, ValueError):
        return default
    n = max(256, min(1920, n))
    n = int(round(n / 16.0) * 16)
    return max(256, min(1920, n))


def _frames_from_duration_sec(duration_sec, fps=24):
    """MiniMax / 24fps length lattice:
    max(5, round(a * fps)) + (5 - (max(5, round(a * fps)) % 17)) % 17
    """
    try:
        a = float(duration_sec)
    except (TypeError, ValueError):
        a = 0.0
    try:
        rate = float(fps)
    except (TypeError, ValueError):
        rate = 24.0
    if not math.isfinite(rate) or rate <= 0:
        rate = 24.0
    x = max(5, int(round(a * rate)))
    return x + (5 - (x % 17)) % 17


def _clamp_length(val):
    """Wan length prefers 4n+1 within 17..241."""
    try:
        n = int(val)
    except (TypeError, ValueError):
        return config.VFLOW_DEFAULT_LENGTH
    n = max(17, min(241, n))
    n = int(round((n - 1) / 4.0) * 4) + 1
    return max(17, min(241, n))


def _clamp_minimax_length(val, default=None):
    """MiniMax H3 graph length on ≡5 mod 17 lattice (no Wan 241 cap)."""
    eng = config.get_storyboard_engine("minimax")
    fallback = int(default if default is not None else eng.get("defaultLength") or 243)
    try:
        n = int(val)
    except (TypeError, ValueError):
        n = fallback
    n = max(5, min(2000, n))
    return n + (5 - (n % 17)) % 17


def _clamp_length_for_engine(val, engine_profile=None, duration_sec=None):
    """Route length clamp: lattice engines / long custom lengths vs Wan 4n+1."""
    eng_id = str(engine_profile or "").strip().lower()
    eng = None
    if eng_id in getattr(config, "STORYBOARD_ENGINES", {}):
        eng = config.get_storyboard_engine(eng_id)
    uses_lattice = bool(
        eng
        and (
            eng.get("usesDurationSeconds")
            or eng.get("nativeFps") is not None
        )
    )
    try:
        raw = int(val) if val not in (None, "") else None
    except (TypeError, ValueError):
        raw = None
    # Custom engines may send lattice lengths > Wan's 241 hard cap.
    if not uses_lattice and raw is not None and raw > 241:
        uses_lattice = True
    if uses_lattice:
        fps = 24
        if eng:
            fps = eng.get("nativeFps") or eng.get("defaultFps") or 24
        if duration_sec not in (None, ""):
            return _frames_from_duration_sec(duration_sec, fps)
        return _clamp_minimax_length(val, raw if raw is not None else 243)
    return _clamp_length(val)


def _clamp_fps(val):
    try:
        n = int(val)
    except (TypeError, ValueError):
        return config.VFLOW_DEFAULT_FPS
    return max(8, min(30, n))


def _collect_urls_from_items(items, urls):
    if not isinstance(items, list):
        return
    for item in items:
        if not item:
            continue
        if isinstance(item, str) and re.match(r"^https?://", item, re.I):
            urls.append(item)
        elif isinstance(item, dict):
            if item.get("fileUrl"):
                urls.append(item["fileUrl"])
            elif item.get("url"):
                urls.append(item["url"])


def extract_urls(rh):
    urls = []
    data = rh and rh.get("data")
    if isinstance(data, list):
        _collect_urls_from_items(data, urls)
    elif isinstance(data, dict):
        if data.get("fileUrl"):
            urls.append(data["fileUrl"])
        if data.get("url") and re.match(r"^https?://", data["url"], re.I):
            urls.append(data["url"])
        for key in ("fileList", "outputs", "results", "files"):
            _collect_urls_from_items(data.get(key), urls)
    return list(dict.fromkeys(urls))


def format_failed_reason(data, msg):
    fr = data and data.get("failedReason")
    if fr and isinstance(fr, dict):
        node = fr.get("node_name") or fr.get("nodeName") or fr.get("node_id") or "?"
        detail = fr.get("exception_message") or fr.get("message") or json.dumps(fr, ensure_ascii=False)
        return f"节点 {node}：{detail}"
    return msg or "任务失败"


def interpret_outputs(rh):
    if not rh or not isinstance(rh, dict):
        return {"done": False, "status": "UNKNOWN", "urls": [], "error": "空响应"}
    code = rh.get("code")
    msg = (rh.get("msg") or "")
    data = rh.get("data")
    urls = extract_urls(rh)

    if code == 0 and urls:
        return {"done": True, "status": "SUCCESS", "urls": urls, "error": None}
    if code == 813 or re.search(r"APIKEY_TASK_IS_QUEUED", msg, re.I):
        return {"done": False, "status": "QUEUED", "urls": [], "error": None}
    if code == 804 or re.search(r"APIKEY_TASK_IS_RUNNING", msg, re.I):
        return {"done": False, "status": "RUNNING", "urls": [], "error": None}
    if code == 805 or re.search(r"APIKEY_TASK_STATUS_ERROR", msg, re.I):
        return {
            "done": True,
            "status": "FAILED",
            "urls": [],
            "error": format_failed_reason(data, msg),
        }

    task_status = (data and data.get("taskStatus")) or (data if isinstance(data, str) else None) or msg
    status_upper = str(task_status or "").upper()
    if "FAIL" in status_upper or re.search(r"fail|失败", msg, re.I):
        return {
            "done": True,
            "status": "FAILED",
            "urls": [],
            "error": format_failed_reason(data, msg) or json.dumps(rh, ensure_ascii=False)[:300],
        }
    if re.search(r"QUEUE", status_upper) or re.search(r"排队", msg):
        return {"done": False, "status": "QUEUED", "urls": [], "error": None}
    if re.search(r"RUN|CREATE|PENDING|运行", status_upper) or re.search(r"运行|处理中", msg):
        return {"done": False, "status": "RUNNING", "urls": [], "error": None}
    if code == 0 and not urls:
        return {"done": False, "status": "RUNNING", "urls": [], "error": None}
    if code not in (None, 0):
        return {
            "done": True,
            "status": "FAILED",
            "urls": [],
            "error": msg or f"API 错误码 {code}",
        }
    return {"done": False, "status": "RUNNING", "urls": [], "error": None}


def _cache_remote_file(url, user_id: int, preferred_ext="bin", filename: Optional[str] = None):
    resp = _http.get(url, timeout=180, stream=True)
    resp.raise_for_status()
    content = resp.content
    if not content:
        raise ValueError("远程文件为空")
    path = urlparse(url).path
    suffix = Path(path).suffix.lower().lstrip(".") or preferred_ext
    if suffix not in ("mp4", "webm", "mov", "png", "jpg", "jpeg", "webp", "bin"):
        suffix = preferred_ext
    name = _finalize_media_filename(user_id, filename, suffix)
    target = _user_media_dir(user_id) / name
    target.write_bytes(content)
    return name, len(content)


def _sanitize_name_part(value: Optional[str], fallback: str = "project") -> str:
    text = re.sub(r"[^\w.\-]+", "_", (value or "").strip())
    text = re.sub(r"_+", "_", text).strip("._-")
    return (text[:80] or fallback)


def _slot_label(segment_kind: str, slot_index: int) -> str:
    if segment_kind == "bridge":
        kind_key = "桥"
    elif segment_kind == "edit":
        kind_key = "编"
    else:
        kind_key = "主"
    return f"{kind_key}{int(slot_index)}"


def _slot_name_prefix(
    project_name: Optional[str],
    project_id: int,
    segment_kind: str,
    slot_index: int,
) -> str:
    proj = _sanitize_name_part(project_name, fallback=f"p{int(project_id)}")
    return f"{proj}_{_slot_label(segment_kind, slot_index)}"


def _allocate_slot_filename(
    user_id: int,
    project_id: int,
    segment_kind: str,
    slot_index: int,
    ext: str,
    project_name: Optional[str] = None,
) -> str:
    """
    Name video results as {project}_{主|桥}{slot}_{YYYYMMDDHHMMSS}.{ext}
    e.g. 我的项目_主1_20260725123045.mp4
    """
    ext = (ext or "mp4").lower().lstrip(".")
    if ext not in ("mp4", "webm", "mov", "png", "jpg", "jpeg", "webp", "bin"):
        ext = "mp4"
    name = project_name
    if not name:
        try:
            project = db.get_project(config.DB_PATH, user_id, int(project_id))
            if project:
                name = project.get("name") or ""
        except Exception:
            logging.debug("project name lookup failed", exc_info=True)
            name = None
    prefix = _slot_name_prefix(name, project_id, segment_kind, slot_index)
    ts = datetime.now().strftime("%Y%m%d%H%M%S")
    return f"{prefix}_{ts}.{ext}"


def _finalize_media_filename(
    user_id: int, preferred: Optional[str], ext: str
) -> str:
    ext = (ext or "bin").lower().lstrip(".")
    if preferred:
        base = Path(preferred).name
        stem = Path(base).stem
        if _SAFE_NAME_RE.match(f"{stem}.{ext}"):
            name = f"{stem}.{ext}"
            target = _user_media_dir(user_id) / name
            if not target.exists():
                return name
            # Collision: append short uuid suffix before extension
            return f"{stem}_{uuid.uuid4().hex[:6]}.{ext}"
    return f"{uuid.uuid4().hex}.{ext}"


def materialize_output(
    *,
    url: str,
    password: str,
    user_id: int,
    task_id: Optional[int] = None,
    project_id: Optional[int] = None,
    kind: str = "i2v",
    prompt_snapshot: str = "",
    filename: Optional[str] = None,
    segment_kind: Optional[str] = None,
    slot_index: Optional[int] = None,
    use_duck: Optional[bool] = None,
):
    if not url:
        raise ValueError("url 不能为空")
    if not re.match(r"^https?://", url, re.I):
        raise ValueError("url 必须是 http(s) 地址")

    # use_duck: explicit flag; fall back to "password present" for legacy callers.
    if use_duck is None:
        use_duck = bool((password or "").strip())

    def _resolve_name(ext: str) -> Optional[str]:
        if filename:
            return filename
        if (
            project_id
            and slot_index
            and (segment_kind or "") in ("main", "bridge", "edit")
        ):
            return _allocate_slot_filename(
                user_id,
                int(project_id),
                segment_kind,
                int(slot_index),
                ext,
            )
        return None

    if _looks_like_video_url(url):
        name, file_size = _cache_remote_file(
            url,
            user_id,
            preferred_ext="mp4",
            filename=_resolve_name("mp4"),
        )
        play = f"/media/{user_id}/{name}"
        media = db.insert_media_file(
            config.DB_PATH,
            user_id=user_id,
            kind=kind,
            filename=name,
            play_path=play,
            task_id=task_id,
            project_id=project_id,
            prompt_snapshot=prompt_snapshot,
            size=file_size,
        )
        return {
            "mediaFileId": media["id"],
            "playUrl": play,
            "downloadUrl": play,
            "filename": name,
            "ext": Path(name).suffix.lstrip("."),
            "decrypted": False,
            "sourceUrl": url,
            "size": file_size,
        }

    # Plain image outputs only when duck decrypt is off.
    if _looks_like_image_url(url) and not use_duck:
        img_ext = _image_ext_from_url(url, "png")
        media_kind = "upload" if kind in ("t2i", "upload") else kind
        if media_kind not in ("i2v", "flf", "edit", "upload"):
            media_kind = "upload"
        name, file_size = _cache_remote_file(
            url,
            user_id,
            preferred_ext=img_ext,
            filename=_resolve_name(img_ext),
        )
        play = f"/media/{user_id}/{name}"
        media = db.insert_media_file(
            config.DB_PATH,
            user_id=user_id,
            kind=media_kind,
            filename=name,
            play_path=play,
            task_id=task_id,
            project_id=project_id,
            prompt_snapshot=prompt_snapshot,
            size=file_size,
        )
        return {
            "mediaFileId": media["id"],
            "playUrl": play,
            "downloadUrl": play,
            "filename": name,
            "ext": Path(name).suffix.lstrip(".") or img_ext,
            "decrypted": False,
            "sourceUrl": url,
            "size": file_size,
        }

    resp = _http.get(url, timeout=180)
    resp.raise_for_status()
    png_bytes = resp.content
    if not png_bytes:
        raise ValueError("下载的文件为空")

    is_png = png_bytes[:8] == b"\x89PNG\r\n\x1a\n"
    if not is_png and _looks_like_video_url(url):
        name = _finalize_media_filename(user_id, _resolve_name("bin"), "bin")
        (_user_media_dir(user_id) / name).write_bytes(png_bytes)
        play = f"/media/{user_id}/{name}"
        media = db.insert_media_file(
            config.DB_PATH,
            user_id=user_id,
            kind=kind,
            filename=name,
            play_path=play,
            task_id=task_id,
            project_id=project_id,
            prompt_snapshot=prompt_snapshot,
            size=len(png_bytes),
        )
        return {
            "mediaFileId": media["id"],
            "playUrl": play,
            "downloadUrl": play,
            "filename": name,
            "ext": "bin",
            "decrypted": False,
            "sourceUrl": url,
            "size": len(png_bytes),
        }

    # Plain PNG (T2I / upload) when duck decrypt is off.
    if is_png and not use_duck and kind in ("upload", "t2i"):
        media_kind = "upload"
        name = _finalize_media_filename(user_id, _resolve_name("png"), "png")
        (_user_media_dir(user_id) / name).write_bytes(png_bytes)
        play = f"/media/{user_id}/{name}"
        media = db.insert_media_file(
            config.DB_PATH,
            user_id=user_id,
            kind=media_kind,
            filename=name,
            play_path=play,
            task_id=task_id,
            project_id=project_id,
            prompt_snapshot=prompt_snapshot,
            size=len(png_bytes),
        )
        return {
            "mediaFileId": media["id"],
            "playUrl": play,
            "downloadUrl": play,
            "filename": name,
            "ext": "png",
            "decrypted": False,
            "sourceUrl": url,
            "size": len(png_bytes),
        }

    media_bytes, ext = duck_decode.decode_duck_bytes(png_bytes, password)
    ext = (ext or "mp4").lower().lstrip(".")
    if ext not in ("mp4", "webm", "mov", "png", "jpg", "jpeg", "webp", "bin"):
        ext = re.sub(r"[^a-z0-9]", "", ext)[:8] or "bin"
    name = _finalize_media_filename(user_id, _resolve_name(ext), ext)
    (_user_media_dir(user_id) / name).write_bytes(media_bytes)
    play = f"/media/{user_id}/{name}"
    media = db.insert_media_file(
        config.DB_PATH,
        user_id=user_id,
        kind=kind,
        filename=name,
        play_path=play,
        task_id=task_id,
        project_id=project_id,
        prompt_snapshot=prompt_snapshot,
        size=len(media_bytes),
    )
    return {
        "mediaFileId": media["id"],
        "playUrl": play,
        "downloadUrl": play,
        "filename": name,
        "ext": ext,
        "decrypted": True,
        "sourceUrl": url,
        "size": len(media_bytes),
    }


def create_editor_task(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Submit a platform editor workflow to RunningHub for a timeline selection."""
    editor_id = (payload.get("editorId") or "").strip()
    editor = config.get_platform_editor(editor_id)
    if not editor:
        raise ValueError(f"未知的平台编辑器: {editor_id}")
    if not config.editor_is_configured(editor):
        raise ValueError(f"平台编辑器未配置工作流: {editor_id}")

    workflow_id = str(editor.get("workflowId") or "").strip()
    bindings = editor.get("bindings") or {}

    seed_high = payload.get("seedHigh")
    seed_low = payload.get("seedLow")
    if seed_high is None or seed_high == "":
        seed_high = random.randint(1, 2**63 - 1)
    if seed_low is None or seed_low == "":
        seed_low = random.randint(1, 2**63 - 1)

    lw, lh = config.VFLOW_LANDSCAPE
    values: Dict[str, Any] = {
        "startImage": (
            payload.get("startImageFileName")
            or payload.get("imageFileName")
            or ""
        ),
        "inputVideo": payload.get("inputVideoFileName") or "",
        "inputAudio": payload.get("inputAudioFileName") or "",
        "prompt": (payload.get("prompt") or "").strip(),
        "negative": (payload.get("negative") or config.DEFAULT_NEGATIVE).strip(),
        "width": _clamp_dim(payload.get("width"), lw),
        "height": _clamp_dim(payload.get("height"), lh),
        "length": _clamp_length_for_engine(
            payload.get("length"),
            payload.get("engineProfile"),
            payload.get("durationSec") or payload.get("duration"),
        ),
        "fps": _clamp_fps(payload.get("fps") or payload.get("frame_rate")),
        "seedHigh": str(seed_high),
        "seedLow": str(seed_low),
    }
    param_values = payload.get("paramValues") or {}
    if isinstance(param_values, dict):
        by_id = {}
        for item in editor.get("params") or []:
            if isinstance(item, dict) and item.get("id"):
                by_id[str(item.get("id"))] = item
        for param_id, raw_val in param_values.items():
            spec = by_id.get(str(param_id))
            if not spec:
                continue
            bind = str(spec.get("bind") or "").strip()
            if not bind or bind not in values:
                continue
            values[bind] = raw_val

    editor_input = editor.get("input") or "image"
    editor_output = editor.get("output") or "video"
    bindings_has_start = isinstance(bindings.get("startImage"), dict)
    bindings_has_video = isinstance(bindings.get("inputVideo"), dict)
    pure_t2i = (
        editor_output == "image"
        and not bindings_has_start
        and not bindings_has_video
    )
    if editor_input == "image" and not values.get("startImage") and not pure_t2i:
        raise ValueError("编辑器需要输入图片（startImage）")
    if editor_input == "video" and not values.get("inputVideo"):
        raise ValueError("编辑器需要输入视频（inputVideo）")
    if editor.get("needsAudio") and not values.get("inputAudio"):
        raise ValueError("编辑器需要输入语音（inputAudio）")
    if editor.get("needsPrompt") and not values.get("prompt"):
        raise ValueError("编辑器需要提示词（prompt）")

    seen = set()
    node_info_list = []
    for key, binding in bindings.items():
        if not isinstance(binding, dict):
            continue
        val = values.get(key)
        if val is None or val == "":
            continue
        node_id = str(binding.get("nodeId") or "")
        field_name = str(binding.get("fieldName") or "")
        if not node_id or not field_name:
            continue
        sig = f"{node_id}:{field_name}"
        if sig in seen:
            continue
        seen.add(sig)
        node_info_list.append(
            {"nodeId": node_id, "fieldName": field_name, "fieldValue": str(val)}
        )
    for item in editor.get("params") or []:
        if not isinstance(item, dict):
            continue
        node_id = str(item.get("nodeId") or "").strip()
        field_name = str(item.get("fieldName") or item.get("field") or "").strip()
        if not node_id or not field_name:
            continue
        sig = f"{node_id}:{field_name}"
        if sig in seen:
            continue
        param_id = str(item.get("id") or "")
        val = param_values.get(param_id) if isinstance(param_values, dict) else None
        if val is None or val == "":
            bind = str(item.get("bind") or "").strip()
            if bind and values.get(bind) not in (None, ""):
                val = values.get(bind)
            elif item.get("default") not in (None, ""):
                val = item.get("default")
        if val is None or val == "":
            continue
        seen.add(sig)
        node_info_list.append(
            {"nodeId": node_id, "fieldName": field_name, "fieldValue": str(val)}
        )
    if not node_info_list:
        raise ValueError("编辑器绑定为空，无法提交")

    api_key = config.get_api_key()
    body = {
        "apiKey": api_key,
        "workflowId": workflow_id,
        "nodeInfoList": node_info_list,
    }
    resp = _http.post(
        f"{config.API_BASE}/task/openapi/create",
        headers=_rh_headers(api_key),
        json=body,
        timeout=60,
    )
    result = resp.json()
    if result.get("code") != 0:
        raise ValueError(result.get("msg") or "创建任务失败")
    data = result.get("data") or {}
    task_id = data.get("taskId")
    if task_id is None:
        raise ValueError("创建成功但未返回 taskId")
    result_mode = "t2i" if pure_t2i else "edit"
    return {
        "taskId": _as_task_id_str(task_id),
        "taskStatus": data.get("taskStatus"),
        "clientId": data.get("clientId"),
        "promptTips": data.get("promptTips"),
        "seedHigh": str(seed_high),
        "seedLow": str(seed_low),
        "mode": result_mode,
        "editorId": editor_id,
        "workflowId": workflow_id,
    }


def create_remote_task(payload: Dict[str, Any], user_id: Optional[int] = None) -> Dict[str, Any]:
    if user_id is not None:
        payload = resolve_request_images(int(user_id), payload)
    mode = (payload.get("mode") or "i2v").strip().lower()
    if mode == "edit":
        return create_editor_task(payload)
    if mode == "t2i":
        # Default to platform Krea2 T2I editor when client omits editorId.
        if not (payload.get("editorId") or "").strip():
            payload = dict(payload)
            payload["editorId"] = "platform.t2i"
        created = create_editor_task(payload)
        created["mode"] = "t2i"
        return created
    if mode not in ("i2v", "flf"):
        raise ValueError("mode 必须是 i2v、flf、edit 或 t2i")

    engine_profile = (payload.get("engineProfile") or "wan").strip().lower()
    if engine_profile not in ("wan", "minimax"):
        engine_profile = "wan"
    if engine_profile == "minimax":
        return _create_minimax_remote_task(payload, mode)

    prompt = (payload.get("prompt") or "").strip()
    negative = (payload.get("negative") or config.DEFAULT_NEGATIVE).strip()
    start_name = (
        (payload.get("startImageFileName") or payload.get("imageFileName") or "").strip()
    )
    end_name = (payload.get("endImageFileName") or "").strip()
    if not prompt:
        raise ValueError("prompt 不能为空")
    if not start_name:
        raise ValueError("首帧 imageFileName / startImageFileName 不能为空")
    if not _is_rh_file_name(start_name):
        raise ValueError(
            "首帧尚未上传到平台（需要 RunningHub 文件名 api/...），请重新选择共享首帧后再试"
        )
    if mode == "flf" and not end_name:
        raise ValueError("flf 模式需要 endImageFileName（尾帧）")
    if mode == "flf" and not _is_rh_file_name(end_name):
        raise ValueError(
            "尾帧尚未上传到平台（需要 RunningHub 文件名 api/...），请重新准备桥接帧后再试"
        )

    seed_high = payload.get("seedHigh")
    seed_low = payload.get("seedLow")
    if seed_high is None or seed_high == "":
        seed_high = random.randint(1, 2**63 - 1)
    if seed_low is None or seed_low == "":
        seed_low = random.randint(1, 2**63 - 1)

    lw, lh = config.VFLOW_LANDSCAPE
    width = _clamp_dim(payload.get("width"), lw)
    height = _clamp_dim(payload.get("height"), lh)
    length = _clamp_length_for_engine(
        payload.get("length"),
        payload.get("engineProfile"),
        payload.get("durationSec") or payload.get("duration"),
    )
    fps = _clamp_fps(payload.get("fps") or payload.get("frame_rate"))

    api_key = config.get_api_key()
    use_duck = bool(payload.get("useDuckEncrypt"))
    if use_duck:
        workflow_id = (
            config.WORKFLOW_ID_FLF if mode == "flf" else config.WORKFLOW_ID
        )
        fps_node = config.VFLOW_FPS_NODE_DUCK
        fps_field = config.VFLOW_FPS_FIELD_DUCK
    else:
        workflow_id = (
            config.WORKFLOW_ID_FLF_NOA if mode == "flf" else config.WORKFLOW_ID_NOA
        )
        fps_node = config.VFLOW_FPS_NODE
        fps_field = config.VFLOW_FPS_FIELD
    size_node = config.VFLOW_FLF_SIZE_NODE if mode == "flf" else config.VFLOW_I2V_SIZE_NODE
    node_info_list = [
        {"nodeId": "62", "fieldName": "image", "fieldValue": start_name},
        {"nodeId": "6", "fieldName": "text", "fieldValue": prompt},
        {"nodeId": "7", "fieldName": "text", "fieldValue": negative},
        {"nodeId": "144", "fieldName": "noise_seed", "fieldValue": str(seed_high)},
        {"nodeId": "57", "fieldName": "noise_seed", "fieldValue": str(seed_low)},
        {"nodeId": size_node, "fieldName": "width", "fieldValue": str(width)},
        {"nodeId": size_node, "fieldName": "height", "fieldValue": str(height)},
        {"nodeId": size_node, "fieldName": "length", "fieldValue": str(length)},
        {
            "nodeId": fps_node,
            "fieldName": fps_field,
            "fieldValue": str(fps),
        },
    ]
    if mode == "flf":
        node_info_list.append({"nodeId": "137", "fieldName": "image", "fieldValue": end_name})

    body = {
        "apiKey": api_key,
        "workflowId": workflow_id,
        "nodeInfoList": node_info_list,
    }
    resp = _http.post(
        f"{config.API_BASE}/task/openapi/create",
        headers=_rh_headers(api_key),
        json=body,
        timeout=60,
    )
    result = resp.json()
    if result.get("code") != 0:
        raise ValueError(_format_rh_create_error(result))
    data = result.get("data") or {}
    task_id = data.get("taskId")
    if task_id is None:
        raise ValueError("创建成功但未返回 taskId")
    return {
        "taskId": _as_task_id_str(task_id),
        "taskStatus": data.get("taskStatus"),
        "clientId": data.get("clientId"),
        "promptTips": data.get("promptTips"),
        "seedHigh": str(seed_high),
        "seedLow": str(seed_low),
        "mode": mode,
        "engineProfile": "wan",
        "workflowId": workflow_id,
        "width": width,
        "height": height,
        "length": length,
    }


def _clamp_duration_sec(value, default, min_sec, max_sec):
    try:
        n = float(value)
    except (TypeError, ValueError):
        n = float(default)
    return max(float(min_sec), min(float(max_sec), n))


def _create_minimax_remote_task(payload: Dict[str, Any], mode: str) -> Dict[str, Any]:
    """Platform MiniMax H3 task with workflow-native frame and FPS controls."""
    eng = config.get_storyboard_engine("minimax")
    prompt = (payload.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("prompt 不能为空")

    seed_high = payload.get("seedHigh")
    if seed_high is None or seed_high == "":
        seed_high = random.randint(1, 2**63 - 1)

    duration = _clamp_duration_sec(
        payload.get("durationSec") or payload.get("duration"),
        eng["mainDefaultSec"] if mode == "i2v" else eng["bridgeDefaultSec"],
        eng["mainMinSec"] if mode == "i2v" else eng["bridgeMinSec"],
        eng["mainMaxSec"] if mode == "i2v" else eng["bridgeMaxSec"],
    )

    # Length follows duration lattice: max(5,round(a*24))+(5-(…%17))%17
    # e.g. 10s → 243, 15s → 362 — not Wan 4n+1 / fixed 243.
    width = _clamp_dim(payload.get("width"), 448)
    height = _clamp_dim(payload.get("height"), 672)
    fps = _clamp_fps(eng.get("nativeFps") or eng.get("defaultFps") or 24)
    length = _frames_from_duration_sec(duration, fps)
    if payload.get("length") not in (None, ""):
        length = _clamp_minimax_length(payload.get("length"), length)

    api_key = config.get_api_key()
    node_info_list = []

    if mode == "flf":
        workflow_id = config.WORKFLOW_ID_MINIMAX_FLF
        bindings = config.MINIMAX_FLF_BINDINGS
        start_name = (
            (payload.get("startImageFileName") or payload.get("imageFileName") or "")
            .strip()
        )
        end_name = (payload.get("endImageFileName") or "").strip()
        if not start_name or not _is_rh_file_name(start_name):
            raise ValueError("MiniMax 桥需要已上传的首帧")
        if not end_name or not _is_rh_file_name(end_name):
            raise ValueError("MiniMax 桥需要已上传的尾帧")
        b_start = bindings["startImage"]
        b_end = bindings["endImage"]
        b_prompt = bindings["prompt"]
        b_dur = bindings["duration"]
        b_w = bindings["width"]
        b_h = bindings["height"]
        b_seed = bindings["seedHigh"]
        node_info_list = [
            {
                "nodeId": b_start["nodeId"],
                "fieldName": b_start["fieldName"],
                "fieldValue": start_name,
            },
            {
                "nodeId": b_end["nodeId"],
                "fieldName": b_end["fieldName"],
                "fieldValue": end_name,
            },
            {
                "nodeId": b_prompt["nodeId"],
                "fieldName": b_prompt["fieldName"],
                "fieldValue": prompt,
            },
            {
                "nodeId": b_dur["nodeId"],
                "fieldName": b_dur["fieldName"],
                "fieldValue": str(length),
            },
            {
                "nodeId": b_w["nodeId"],
                "fieldName": b_w["fieldName"],
                "fieldValue": str(width),
            },
            {
                "nodeId": b_h["nodeId"],
                "fieldName": b_h["fieldName"],
                "fieldValue": str(height),
            },
            {
                "nodeId": b_seed["nodeId"],
                "fieldName": b_seed["fieldName"],
                "fieldValue": str(seed_high),
            },
        ]
    else:
        refs = payload.get("refImageFileNames")
        if not isinstance(refs, list):
            refs = []
        refs = [str(x or "").strip() for x in refs if str(x or "").strip()]
        # Picture 1 is always the shared start frame. User references are
        # therefore assigned to Picture 2 onward, even for direct API callers.
        primary = (
            payload.get("startImageFileName")
            or payload.get("imageFileName")
            or (refs[0] if refs else "")
        ).strip()
        if primary and (not refs or refs[0] != primary):
            refs.insert(0, primary)
        if not refs:
            raise ValueError("MiniMax 主段需要首帧/参考图：请上传共享首帧或至少一张参考图")
        for name in refs:
            if not _is_rh_file_name(name):
                raise ValueError(
                    "参考图尚未上传到平台（需要 RunningHub 文件名 api/...）"
                )

        video_names = payload.get("refVideoFileNames")
        if not isinstance(video_names, list):
            video_names = []
        video_names = [
            str(x or "").strip() for x in video_names if str(x or "").strip()
        ]
        audio_names = payload.get("refAudioFileNames")
        if not isinstance(audio_names, list):
            audio_names = []
        audio_names = [
            str(x or "").strip() for x in audio_names if str(x or "").strip()
        ]
        if not audio_names:
            one_aud = (payload.get("refAudioFileName") or "").strip()
            if one_aud:
                audio_names = [one_aud]

        primary_ref = refs[0]
        refs = (refs + [primary_ref] * 5)[:5]
        variant = config.resolve_minimax_ref2va_variant(
            len(refs),
            has_video=bool(video_names),
            has_audio=bool(audio_names),
        )
        workflow_id = variant["workflowId"]
        bindings = variant["bindings"]

        b_prompt = bindings["prompt"]
        b_length = bindings["length"]
        b_fps = bindings["fps"]
        b_w = bindings["width"]
        b_h = bindings["height"]
        b_seed = bindings["seedHigh"]
        node_info_list = [
            {
                "nodeId": b_prompt["nodeId"],
                "fieldName": b_prompt["fieldName"],
                "fieldValue": prompt,
            },
            {
                "nodeId": b_length["nodeId"],
                "fieldName": b_length["fieldName"],
                "fieldValue": str(length),
            },
            {
                "nodeId": b_fps["nodeId"],
                "fieldName": b_fps["fieldName"],
                "fieldValue": str(fps),
            },
            {
                "nodeId": b_w["nodeId"],
                "fieldName": b_w["fieldName"],
                "fieldValue": str(width),
            },
            {
                "nodeId": b_h["nodeId"],
                "fieldName": b_h["fieldName"],
                "fieldValue": str(height),
            },
            {
                "nodeId": b_seed["nodeId"],
                "fieldName": b_seed["fieldName"],
                "fieldValue": str(seed_high),
            },
        ]
        # Fixed-slot graphs: fill exactly nImages LoadImage nodes (no Enable switches)
        for i in range(variant["nImages"]):
            key = "refImage{0}".format(i)
            b = bindings.get(key)
            if not b:
                raise ValueError("MiniMax 工作流缺少绑定 {0}".format(key))
            name = refs[i] if i < len(refs) else ""
            if not name:
                raise ValueError(
                    "MiniMax 本档工作流需要 {0} 张参考图，第 {1} 张缺失".format(
                        variant["nImages"], i + 1
                    )
                )
            node_info_list.append(
                {
                    "nodeId": b["nodeId"],
                    "fieldName": b["fieldName"],
                    "fieldValue": name,
                }
            )

    body = {
        "apiKey": api_key,
        "workflowId": workflow_id,
        "nodeInfoList": node_info_list,
    }
    resp = _http.post(
        f"{config.API_BASE}/task/openapi/create",
        headers=_rh_headers(api_key),
        json=body,
        timeout=60,
    )
    result = resp.json()
    if result.get("code") != 0:
        raise ValueError(_format_rh_create_error(result))
    data = result.get("data") or {}
    task_id = data.get("taskId")
    if task_id is None:
        raise ValueError("创建成功但未返回 taskId")
    return {
        "taskId": _as_task_id_str(task_id),
        "taskStatus": data.get("taskStatus"),
        "clientId": data.get("clientId"),
        "promptTips": data.get("promptTips"),
        "seedHigh": str(seed_high),
        "mode": mode,
        "engineProfile": "minimax",
        "workflowId": workflow_id,
        "width": width,
        "height": height,
        "length": length,
        "fps": fps,
        "durationSec": duration,
    }


def _format_rh_create_error(result: Dict[str, Any]) -> str:
    """Prefer LoadImage / node validation details over opaque Comfy JSON."""
    raw = result.get("msg")
    text = raw if isinstance(raw, str) else ""
    details = []
    try:
        parsed = json.loads(text) if text.strip().startswith("{") else None
        if isinstance(parsed, dict):
            err = parsed.get("error") or {}
            node_errors = parsed.get("node_errors") or {}
            for node_id, node in node_errors.items():
                for e in (node or {}).get("errors") or []:
                    d = (e or {}).get("details") or (e or {}).get("message") or ""
                    if d:
                        details.append(str(d))
            if details:
                return "；".join(details)
            if err.get("message"):
                return str(err.get("message"))
    except Exception:
        pass
    return text or "创建任务失败"


def fetch_remote_outputs(task_id: str) -> Dict[str, Any]:
    api_key = config.get_api_key()
    body = {"apiKey": api_key, "taskId": task_id}
    resp = _http.post(
        f"{config.API_BASE}/task/openapi/outputs",
        headers=_rh_headers(api_key),
        json=body,
        timeout=60,
    )
    result = resp.json()
    interp = interpret_outputs(result)
    return {"rh": result, "interp": interp}


def _serialize_user(user):
    return {
        "id": user["id"],
        "username": user["username"],
    }


def _serialize_project(project):
    return {
        "id": project["id"],
        "name": project["name"],
        "payload": project["payload"],
        "createdAt": project["created_at"],
        "updatedAt": project["updated_at"],
    }


def _serialize_task(task):
    project_id = task.get("project_id")
    kind = task.get("kind") or ""
    ref_id = task.get("ref_id") or ""
    project_name = task.get("project_name") or ""
    if not project_name and project_id and task.get("user_id"):
        try:
            project = db.get_project(
                config.DB_PATH, int(task["user_id"]), int(project_id)
            )
            if project:
                project_name = project.get("name") or ""
        except Exception:
            logging.debug("serialize task project name lookup failed", exc_info=True)
    slot_index = None
    if project_id and ref_id and kind in ("main", "bridge", "edit"):
        try:
            slot_index = db.segment_slot_index(
                config.DB_PATH, int(project_id), kind, ref_id
            )
        except Exception:
            logging.debug("serialize task slot index lookup failed", exc_info=True)
            slot_index = None
    return {
        "id": task["id"],
        "projectId": project_id,
        "projectName": project_name,
        "kind": kind,
        "refId": ref_id,
        "slotIndex": slot_index,
        "status": task["status"],
        "rhTaskId": task.get("rh_task_id"),
        "request": task.get("request") or {},
        "result": task.get("result"),
        "error": task.get("error"),
        "seedHigh": task.get("seed_high"),
        "seedLow": task.get("seed_low"),
        "canceled": bool(task.get("canceled")),
        "createdAt": task.get("created_at"),
        "submittedAt": task.get("submitted_at"),
        "updatedAt": task.get("updated_at"),
    }


def _force_fail_task(task, *, message: str, canceled: bool = False, label: str = "失败"):
    """Mark a task failed locally and sync project segment. Does not call RunningHub cancel."""
    db.update_task(
        config.DB_PATH,
        task["id"],
        status="failed",
        canceled=canceled,
        error=message,
        result={"results": [{"error": message}], "playUrl": None},
    )
    db.patch_project_segment(
        config.DB_PATH,
        task["project_id"],
        task["kind"],
        task["ref_id"],
        {
            "status": "failed",
            "label": label,
            "meta": message,
            "results": [{"error": message}],
        },
    )


def _serialize_asset(asset):
    filename = asset.get("filename") or ""
    if not filename and asset.get("play_path"):
        filename = Path(str(asset["play_path"])).name
    ref_id = asset.get("task_ref_id") or asset.get("ref_id") or ""
    segment_kind = asset.get("task_segment_kind") or asset.get("segment_kind") or ""
    rh_file_name = str(asset.get("rh_file_name") or "").strip() or None
    return {
        "id": asset["id"],
        "kind": asset["kind"],
        "filename": filename,
        "playUrl": asset["play_path"],
        "promptSnapshot": asset.get("prompt_snapshot") or "",
        "projectId": asset.get("project_id"),
        "taskId": asset.get("task_id"),
        "refId": ref_id or None,
        "segmentKind": segment_kind or None,
        "createdAt": asset.get("created_at"),
        "size": int(asset["size"]) if asset.get("size") is not None else None,
        "rhFileName": rh_file_name,
        "fileName": rh_file_name,
    }


def _bootstrap_local_user():
    user = db.ensure_local_user(config.DB_PATH)
    db.ensure_default_project(config.DB_PATH, user["id"])
    return user


def _start_worker():
    global _worker, _worker_lock_fh
    if _worker is not None:
        return
    # Flask debug reloader imports the app twice; only the child should run the worker.
    if config.DEBUG and os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        return
    # Cross-process guard (second app instance / multi-worker WSGI).
    if not _acquire_worker_lock():
        logging.warning(
            "another TaskWorker already holds the lock — skipping start in this process"
        )
        return
    _worker = TaskWorker(
        db_path=config.DB_PATH,
        create_remote_task=create_remote_task,
        fetch_remote_outputs=fetch_remote_outputs,
        materialize_output=materialize_output,
    )
    _worker.start()
    logging.info("TaskWorker started (pid=%s)", os.getpid())


def _acquire_worker_lock() -> bool:
    """Non-blocking exclusive lock so only one process runs TaskWorker."""
    global _worker_lock_fh
    lock_path = config.DATA_DIR / "task_worker.lock"
    fh = None
    try:
        fh = open(lock_path, "a+b")
        if fh.tell() == 0:
            fh.write(b"0")
            fh.flush()
        fh.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        fh.seek(0)
        fh.truncate()
        fh.write(f"pid={os.getpid()}\n".encode("ascii", errors="ignore"))
        fh.flush()
        _worker_lock_fh = fh
        return True
    except OSError:
        if fh is not None:
            try:
                fh.close()
            except Exception:
                pass
        return False


@app.before_request
def load_current_user():
    g.current_user = db.ensure_local_user(config.DB_PATH)


@app.get("/")
def index():
    lw, lh = config.VFLOW_LANDSCAPE
    pw, ph = config.VFLOW_PORTRAIT
    locale = request_locale()
    site_block = site_config.for_locale(locale)
    return render_template(
        "index.html",
        default_negative=config.DEFAULT_NEGATIVE,
        vflow_width=lw,
        vflow_height=lh,
        vflow_length=config.VFLOW_DEFAULT_LENGTH,
        vflow_fps=config.VFLOW_DEFAULT_FPS,
        vflow_landscape_w=lw,
        vflow_landscape_h=lh,
        vflow_portrait_w=pw,
        vflow_portrait_h=ph,
        site_locale=locale,
        site_ui=site_block.get("ui") or {},
        site_seo=site_block.get("seo") or {},
    )


@app.get("/api/site-config")
def api_site_config():
    return _ok({"siteConfig": site_config.load()})


@app.get("/api/config")
def api_config():
    lw, lh = config.VFLOW_LANDSCAPE
    pw, ph = config.VFLOW_PORTRAIT
    user = current_user()
    # Use cache/fallback only — do not block page load on OpenRouter.
    free_models = config.cached_openrouter_free_models(limit=20)
    default_model = config.default_llm_model()
    platform_llm = config.llm_configured()
    platform_rh = config.platform_rh_available()
    return _ok(
        {
            "defaultNegative": config.DEFAULT_NEGATIVE,
            "llmConfigured": platform_llm,
            "platformLlmAvailable": platform_llm,
            "platformRhAvailable": platform_rh,
            "officialInstance": config.is_official_instance(),
            "platformWorkflows": config.public_platform_workflows(),
            "llmBaseUrlDefault": config.LLM_BASE_URL,
            "llmModelDefault": default_model,
            "llmModel": default_model,
            "llmFreeModels": free_models,
            "llmSegmentMin": config.LLM_SEGMENT_MIN,
            "llmSegmentMax": config.LLM_SEGMENT_MAX,
            "authRequired": False,
            "allowSelfRegister": False,
            "cloudAssets": False,
            "user": _serialize_user(user) if user else None,
            "vflowDefaults": {
                "length": config.VFLOW_DEFAULT_LENGTH,
                "fps": config.VFLOW_DEFAULT_FPS,
                "landscape": {"width": lw, "height": lh},
                "portrait": {"width": pw, "height": ph},
            },
        }
    )


@app.get("/api/editors")
@login_required
def api_editors():
    """Platform editor catalog (metadata only; workflowId/bindings stay server-side)."""
    if not config.is_official_instance():
        return _ok({"editors": [], "platformRhAvailable": False})
    editors = [
        config.public_editor_manifest(e) for e in config.get_platform_editors()
    ]
    return _ok(
        {
            "editors": editors,
            "platformRhAvailable": config.platform_rh_available(),
        }
    )


@app.get("/api/llm/models")
@login_required
def api_llm_models():
    """OpenRouter top-weekly free models for the storyboard LLM picker."""
    force = (request.args.get("refresh") or "").strip().lower() in (
        "1",
        "true",
        "yes",
    )
    models = config.fetch_openrouter_free_models(limit=30, force=force)
    default_model = models[0]["id"] if models else config.default_llm_model()
    return _ok(
        {
            "models": models,
            "defaultModel": default_model,
            "baseUrlDefault": config.LLM_BASE_URL,
        }
    )


@app.get("/api/auth/me")
def api_auth_me():
    user = current_user()
    if not user:
        return _err(msg("err.unauthorized"), 500)
    return _ok({"user": _serialize_user(user)})


@app.get("/api/projects")
@login_required
def api_projects_list():
    user = current_user()
    items = db.list_projects(config.DB_PATH, user["id"])
    return _ok({"projects": items})


@app.post("/api/projects")
@login_required
def api_projects_create():
    user = current_user()
    payload = request.get_json(silent=True) or {}
    # Name is locale-aware via X-Locale / body.locale (e.g. 新建1 / New 1).
    project = db.create_project(
        config.DB_PATH,
        user["id"],
        None,
        payload.get("payload"),
        name_template=msg("project.default_name"),
    )
    return _ok({"project": _serialize_project(project)})


@app.get("/api/projects/<int:project_id>")
@login_required
def api_projects_get(project_id):
    user = current_user()
    project = db.get_project(config.DB_PATH, user["id"], project_id)
    if not project:
        return _err(msg("err.project_not_found"), 404)
    return _ok({"project": _serialize_project(project)})


@app.put("/api/projects/<int:project_id>")
@login_required
def api_projects_update(project_id):
    user = current_user()
    payload = request.get_json(silent=True) or {}
    project = db.update_project(
        config.DB_PATH,
        user["id"],
        project_id,
        name=payload.get("name"),
        payload=payload.get("payload"),
    )
    if not project:
        return _err(msg("err.project_not_found"), 404)
    return _ok({"project": _serialize_project(project)})


@app.delete("/api/projects/<int:project_id>")
@login_required
def api_projects_delete(project_id):
    user = current_user()
    existing = db.get_project(config.DB_PATH, user["id"], project_id)
    if not existing:
        return _err(msg("err.project_not_found"), 404)

    # Stop active jobs first so workers do not keep writing into this project.
    active = db.list_tasks(
        config.DB_PATH,
        user["id"],
        active_only=True,
        project_id=project_id,
    )
    for task in active:
        _force_fail_task(
            task,
            message="项目已删除",
            canceled=True,
            label="已取消",
        )

    deleted_media = db.delete_project(config.DB_PATH, user["id"], project_id)
    for item in deleted_media:
        safe = Path(item.get("filename") or "").name
        if not safe or not _SAFE_NAME_RE.match(safe):
            continue
        path = _user_media_dir(user["id"]) / safe
        try:
            if path.is_file():
                path.unlink()
        except OSError:
            logging.warning("failed to unlink media file %s", path)

    return _ok()


@app.get("/api/scripts")
@login_required
def api_scripts_list():
    user = current_user()
    items = db.list_user_scripts(config.DB_PATH, user["id"])
    return _ok({"scripts": items})


@app.post("/api/scripts")
@login_required
def api_scripts_create():
    user = current_user()
    payload = request.get_json(silent=True) or {}
    script = db.create_user_script(config.DB_PATH, user["id"], payload)
    return _ok({"script": script})


@app.get("/api/scripts/<int:script_id>")
@login_required
def api_scripts_get(script_id):
    user = current_user()
    script = db.get_user_script(config.DB_PATH, user["id"], script_id)
    if not script:
        return _err(msg("err.script_not_found"), 404)
    return _ok({"script": script})


@app.put("/api/scripts/<int:script_id>")
@login_required
def api_scripts_update(script_id):
    user = current_user()
    payload = request.get_json(silent=True) or {}
    script = db.update_user_script(config.DB_PATH, user["id"], script_id, payload)
    if not script:
        return _err(msg("err.script_not_found"), 404)
    return _ok({"script": script})


@app.delete("/api/scripts/<int:script_id>")
@login_required
def api_scripts_delete(script_id):
    user = current_user()
    ok = db.delete_user_script(config.DB_PATH, user["id"], script_id)
    if not ok:
        return _err(msg("err.script_not_found"), 404)
    return _ok()


@app.post("/api/scripts/<int:script_id>/bind")
@login_required
def api_scripts_bind(script_id):
    user = current_user()
    payload = request.get_json(silent=True) or {}
    episode_id = str(payload.get("episodeId") or "").strip()
    try:
        project_id = int(payload.get("projectId"))
    except (TypeError, ValueError):
        return _err(msg("err.project_not_found"))
    if not episode_id:
        return _err(msg("err.episode_required"))
    try:
        script = db.bind_script_episode(
            config.DB_PATH, user["id"], script_id, episode_id, project_id
        )
    except KeyError as e:
        code = str(e)
        if code == "script_not_found":
            return _err(msg("err.script_not_found"), 404)
        if code == "project_not_found":
            return _err(msg("err.project_not_found"), 404)
        return _err(msg("err.episode_not_found"), 404)
    except ValueError:
        return _err(msg("err.episode_bound"), 409)
    project = db.get_project(config.DB_PATH, user["id"], project_id)
    return _ok({"script": script, "project": _serialize_project(project) if project else None})


@app.get("/api/assets")
@login_required
def api_assets_list():
    return _ok({"assets": [], "cloudAssets": False})


@app.delete("/api/assets/<int:asset_id>")
@login_required
def api_assets_delete(asset_id):
    user = current_user()
    force = (request.args.get("force") or "").strip().lower() in ("1", "true", "yes")
    existing = db.get_media_file_for_user(config.DB_PATH, user["id"], asset_id)
    if not existing:
        return _err(msg("err.asset_not_found"), 404)

    in_use = db.find_projects_referencing_media(config.DB_PATH, user["id"], asset_id)
    if in_use and not force:
        return (
            jsonify(
                {
                    "success": False,
                    "message": "该素材正在被项目使用，确认后可强制删除",
                    "code": "in_use",
                    "inUse": [
                        {"id": p["id"], "name": p["name"], "refs": p.get("refs") or []}
                        for p in in_use
                    ],
                }
            ),
            409,
        )

    if in_use and force:
        db.null_out_media_references(config.DB_PATH, user["id"], asset_id)

    deleted = db.delete_media_file(config.DB_PATH, user["id"], asset_id)
    if not deleted:
        return _err(msg("err.asset_not_found"), 404)

    # Remove file from disk
    safe = Path(deleted["filename"]).name
    if _SAFE_NAME_RE.match(safe):
        path = _user_media_dir(user["id"]) / safe
        try:
            if path.is_file():
                path.unlink()
        except OSError:
            logging.warning("failed to unlink media file %s", path)

    return _ok(
        {
            "deleted": asset_id,
            "forced": bool(force and in_use),
            "clearedProjects": [p["id"] for p in in_use] if force else [],
        }
    )


@app.post("/api/assets/import")
@login_required
def api_assets_import():
    return _err("单机版没有云端素材库，请用本机助手导入。", 403)


@app.post("/api/jobs")
@login_required
def api_jobs_create():
    if not config.is_official_instance():
        return _err(msg("err.platform_disabled"), 403)
    user = current_user()
    payload = request.get_json(silent=True) or {}
    project_id = payload.get("projectId")
    jobs = payload.get("jobs") or []
    if not project_id:
        return _err(msg("err.project_id_required"))
    if not isinstance(jobs, list) or not jobs:
        return _err(msg("err.jobs_required"))
    project = db.get_project(config.DB_PATH, user["id"], int(project_id))
    if not project:
        return _err(msg("err.project_not_found"), 404)

    created = []
    for item in jobs:
        kind = (item.get("kind") or "").strip().lower()
        ref_id = (item.get("refId") or "").strip()
        request_data = item.get("request") or {}
        if kind not in ("main", "bridge", "edit", "t2i"):
            return _err(msg("err.job_kind_invalid"))
        if not ref_id:
            return _err(msg("err.job_ref_required"))
        if kind == "edit":
            mode = "edit"
        elif kind == "t2i":
            mode = "t2i"
        else:
            mode = (request_data.get("mode") or ("flf" if kind == "bridge" else "i2v")).strip().lower()
        request_data["mode"] = mode
        if kind == "t2i" and not (request_data.get("editorId") or "").strip():
            request_data["editorId"] = "platform.t2i"
        task, replaced = db.upsert_pending_task(
            config.DB_PATH,
            user["id"],
            int(project_id),
            kind,
            ref_id,
            request_data,
        )
        db.patch_project_segment(
            config.DB_PATH,
            int(project_id),
            kind,
            ref_id,
            {
                "status": "queued",
                "label": "排队中" if not replaced else "排队参数已更新",
                "taskId": None,
                "meta": "",
            },
        )
        serialized = _serialize_task(task)
        serialized["replaced"] = bool(replaced)
        created.append(serialized)
    queue = db.count_user_queue_tasks(config.DB_PATH, user["id"])
    return _ok(
        {
            "jobs": created,
            "pendingCount": queue["pendingCount"],
            "runningCount": queue["runningCount"],
            "globalMaxRunning": config.GLOBAL_MAX_RUNNING,
            "perUserMaxRunning": config.PER_USER_MAX_RUNNING,
        }
    )


@app.get("/api/jobs")
@login_required
def api_jobs_list():
    user = current_user()
    active_only = (request.args.get("active") or "").strip() in ("1", "true", "yes")
    project_id = request.args.get("projectId")
    project_id_int = int(project_id) if project_id else None
    limit_raw = (request.args.get("limit") or "").strip()
    limit = None
    if limit_raw:
        try:
            limit = max(1, min(200, int(limit_raw)))
        except ValueError:
            limit = 50
    elif project_id_int is None:
        # User-wide panel default
        limit = 40
    items = db.list_tasks(
        config.DB_PATH,
        user["id"],
        active_only=active_only,
        project_id=project_id_int,
        limit=limit,
    )
    queue = db.count_user_queue_tasks(config.DB_PATH, user["id"])
    return _ok(
        {
            "jobs": [_serialize_task(item) for item in items],
            "staleSeconds": config.JOB_STALE_SECONDS,
            "globalMaxRunning": config.GLOBAL_MAX_RUNNING,
            "perUserMaxRunning": config.PER_USER_MAX_RUNNING,
            "pendingCount": queue["pendingCount"],
            "runningCount": queue["runningCount"],
        }
    )


@app.post("/api/jobs/cancel")
@login_required
def api_jobs_cancel():
    """Cancel waiting jobs. scope=all also force-fails running (local unlock only)."""
    user = current_user()
    payload = request.get_json(silent=True) or {}
    project_id = payload.get("projectId")
    scope = (payload.get("scope") or "waiting").strip().lower()
    if scope not in ("waiting", "all"):
        return _err(msg("err.scope_invalid"))
    # projectId optional when scope=all and clearing all user active jobs
    project_id_int = int(project_id) if project_id else None
    if project_id_int is None and scope == "waiting":
        return _err(msg("err.project_id_required"))
    if project_id_int is not None:
        project = db.get_project(config.DB_PATH, user["id"], project_id_int)
        if not project:
            return _err(msg("err.project_not_found"), 404)

    items = db.list_tasks(
        config.DB_PATH,
        user["id"],
        active_only=True,
        project_id=project_id_int,
    )
    canceled = 0
    for task in items:
        status = task["status"]
        if scope == "waiting" and status not in ("pending", "queued"):
            continue
        if scope == "all" and status not in ("pending", "queued", "running", "finalizing"):
            continue
        if status in ("running", "finalizing"):
            msg = (
                "已强制结束（本地解锁）。远端 RunningHub 任务可能仍在跑，但不再占用本站队列。"
            )
            label = "已强制结束"
        else:
            msg = "已取消"
            label = "已取消"
        _force_fail_task(task, message=msg, canceled=True, label=label)
        canceled += 1
    return _ok({"canceled": canceled, "scope": scope})


@app.post("/api/jobs/force-fail")
@login_required
def api_jobs_force_fail():
    """Force-fail active jobs by id and/or project. Unlocks local queue only."""
    user = current_user()
    payload = request.get_json(silent=True) or {}
    project_id = payload.get("projectId")
    job_ids = payload.get("jobIds") or []
    project_id_int = int(project_id) if project_id else None

    if project_id_int is not None:
        project = db.get_project(config.DB_PATH, user["id"], project_id_int)
        if not project:
            return _err(msg("err.project_not_found"), 404)

    id_set = set()
    if isinstance(job_ids, list):
        for jid in job_ids:
            try:
                id_set.add(int(jid))
            except (TypeError, ValueError):
                continue

    if not id_set and project_id_int is None:
        return _err(msg("err.job_target_required"))

    items = db.list_tasks(
        config.DB_PATH,
        user["id"],
        active_only=True,
        project_id=project_id_int,
    )
    if id_set:
        items = [t for t in items if int(t["id"]) in id_set]
        # Also allow force-fail of already-listed ids that might not be "active"
        # if caller passed explicit ids — fetch those specifically
        if not items and id_set:
            all_user = db.list_tasks(config.DB_PATH, user["id"], active_only=False, limit=200)
            items = [t for t in all_user if int(t["id"]) in id_set]

    failed = 0
    msg = (
        "已强制结束（本地解锁）。远端 RunningHub 任务可能仍在跑，但不再占用本站队列。"
    )
    for task in items:
        if task["status"] in ("success", "failed") and not id_set:
            continue
        if task["status"] in ("success", "failed"):
            continue
        _force_fail_task(task, message=msg, canceled=True, label="已强制结束")
        failed += 1
    return _ok({"failed": failed})


@app.post("/api/jobs/delete")
@login_required
def api_jobs_delete():
    """Delete finished (success/failed) job records. Does not delete media assets."""
    user = current_user()
    payload = request.get_json(silent=True) or {}
    scope = (payload.get("scope") or "").strip().lower()
    project_id = payload.get("projectId")
    job_ids = payload.get("jobIds") or []
    project_id_int = int(project_id) if project_id else None

    if project_id_int is not None:
        project = db.get_project(config.DB_PATH, user["id"], project_id_int)
        if not project:
            return _err(msg("err.project_not_found"), 404)

    if scope == "finished":
        deleted = db.clear_finished_tasks(
            config.DB_PATH, user["id"], project_id=project_id_int
        )
        return _ok({"deleted": deleted, "scope": "finished"})

    id_list = []
    if isinstance(job_ids, list):
        for jid in job_ids:
            try:
                id_list.append(int(jid))
            except (TypeError, ValueError):
                continue
    if not id_list:
        return _err(msg("err.job_ids_required"))

    deleted = 0
    skipped = 0
    for jid in id_list:
        if db.delete_task(config.DB_PATH, user["id"], jid):
            deleted += 1
        else:
            skipped += 1
    return _ok({"deleted": deleted, "skipped": skipped})


_PROMPT_META_LABEL = (
    r"(?:"
    r"前段|后段|前半(?:段)?|后半(?:段)?|"
    r"接上一段|继续上一段|承接上一段|接续上一段|"
    r"恢复上一段(?:的)?状态|"
    r"从上一段(?:末|结束)?(?:状态)?(?:开始|继续)?|"
    r"从首帧开始|"
    r"first\s+half|second\s+half|"
    r"previous(?:\s+segment|\s+part)?|next(?:\s+segment|\s+part)?|"
    r"continue\s+from\s+(?:the\s+)?previous|"
    r"restore\s+(?:the\s+)?previous\s+state|"
    r"start\s+from\s+(?:the\s+)?(?:first|start)\s+frame"
    r")"
)
_PROMPT_META_PREFIX_RE = re.compile(
    rf"^{_PROMPT_META_LABEL}\s*[:：\-–—]?\s*",
    re.I,
)
_PROMPT_META_LINE_RE = re.compile(
    rf"(?m)^(?:{_PROMPT_META_LABEL})\s*[:：]\s*",
    re.I,
)
_PROMPT_META_INLINE_RE = re.compile(
    rf"(?<=[。．.!?\n；;])\s*(?:{_PROMPT_META_LABEL})\s*[:：]\s*",
    re.I,
)


def _strip_prompt_meta_guides(text):
    """Remove meta process labels from I2V prompt text; keep scene content."""
    s = str(text or "").strip()
    if not s:
        return ""
    while True:
        new = _PROMPT_META_PREFIX_RE.sub("", s, count=1).strip()
        if new == s:
            break
        s = new
    s = _PROMPT_META_LINE_RE.sub("", s)
    s = _PROMPT_META_INLINE_RE.sub(" ", s)
    s = re.sub(r"([。．])\s+", r"\1", s)
    s = re.sub(r"([.!?])(?=[A-Za-z「『\"'])", r"\1 ", s)
    s = re.sub(r"[ \t]{2,}", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    s = re.sub(r"[。．]{2,}", "。", s)
    return s.strip()


def _parse_llm_prompts_content(content):
    text = (content or "").strip()
    if not text:
        raise ValueError("模型返回为空")
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.I)
    if fence:
        text = fence.group(1).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("模型未返回 JSON 对象")
        data = json.loads(text[start : end + 1])
    prompts = data.get("prompts") if isinstance(data, dict) else None
    if not isinstance(prompts, list) or not prompts:
        raise ValueError("JSON 缺少非空 prompts 数组")
    cleaned = []
    for p in prompts:
        s = _strip_prompt_meta_guides(p) if p is not None else ""
        if s:
            cleaned.append(s)
    if not cleaned:
        raise ValueError("prompts 全为空")
    return cleaned


def _clamp_storyboard_duration(value, default=5.0, allow_zero=False, max_sec=12.0, min_sec=2.0):
    try:
        n = float(value)
    except (TypeError, ValueError):
        n = default
    if allow_zero:
        return max(0.0, min(max_sec, round(n, 1)))
    return max(min_sec, min(max_sec, round(n, 1)))


def _clamp_target_duration_sec(value, default=30.0):
    try:
        n = float(value)
    except (TypeError, ValueError):
        n = default
    return max(10.0, min(120.0, round(n)))


BRIDGE_OVERLAP_SEC = 1.7
BRIDGE_MIN_SEC = round(2 * BRIDGE_OVERLAP_SEC, 1)  # both-side overlap coverage
# Legacy Wan defaults (prefer get_storyboard_engine)
MAIN_MAX_SEC = 7.0
BRIDGE_DEFAULT_SEC = MAIN_MAX_SEC
BRIDGE_MAX_SEC = 12.0
SOFT_CHAIN_UNIT_SEC = 21.0


def _coerce_engine_caps(raw):
    if not isinstance(raw, dict):
        return None
    if raw.get("mainMaxSec") is None and raw.get("mainMinSec") is None:
        return None

    def f(key, default):
        try:
            return float(raw.get(key, default))
        except (TypeError, ValueError):
            return float(default)

    return {
        "mainMinSec": f("mainMinSec", 2),
        "mainMaxSec": f("mainMaxSec", 7),
        "mainDefaultSec": f("mainDefaultSec", 5),
        "bridgeMinSec": f("bridgeMinSec", 3.4),
        "bridgeMaxSec": f("bridgeMaxSec", 12),
        "bridgeDefaultSec": f("bridgeDefaultSec", 7),
        "softChainUnitSec": f("softChainUnitSec", 21),
        "usesDurationSeconds": bool(raw.get("usesDurationSeconds")),
        "supportsMultiRef": bool(raw.get("supportsMultiRef")),
        "allowTimedBeats": bool(raw.get("allowTimedBeats")),
        "allowAudioInPrompt": bool(raw.get("allowAudioInPrompt")),
        "name": str(raw.get("name") or "").strip(),
    }


def _engine_timing(engine_profile=None):
    caps = getattr(g, "engine_caps", None)
    if caps:
        return {
            "mainMinSec": float(caps["mainMinSec"]),
            "mainMaxSec": float(caps["mainMaxSec"]),
            "mainDefaultSec": float(caps["mainDefaultSec"]),
            "bridgeMinSec": float(caps["bridgeMinSec"]),
            "bridgeMaxSec": float(caps["bridgeMaxSec"]),
            "bridgeDefaultSec": float(caps["bridgeDefaultSec"]),
            "softChainUnitSec": float(caps["softChainUnitSec"]),
            "usesDurationSeconds": bool(caps.get("usesDurationSeconds")),
        }
    eng = config.get_storyboard_engine(engine_profile or "wan")
    return {
        "mainMinSec": float(eng["mainMinSec"]),
        "mainMaxSec": float(eng["mainMaxSec"]),
        "mainDefaultSec": float(eng["mainDefaultSec"]),
        "bridgeMinSec": float(eng["bridgeMinSec"]),
        "bridgeMaxSec": float(eng["bridgeMaxSec"]),
        "bridgeDefaultSec": float(eng["bridgeDefaultSec"]),
        "softChainUnitSec": float(eng["softChainUnitSec"]),
        "usesDurationSeconds": bool(eng.get("usesDurationSeconds")),
    }


def _build_minimax_beat_skeleton(duration_sec, locale="zh"):
  # type: (float, str) -> str
    try:
        n = int(round(float(duration_sec)))
    except (TypeError, ValueError):
        return ""
    if n <= 0:
        return ""
    anchors = [0, min(3, n)]
    while anchors[-1] < n:
        cur = anchors[-1]
        remaining = n - cur
        if remaining <= 4:
            anchors.append(n)
        else:
            nxt = cur + 4
            anchors.append(n if nxt >= n else nxt)
    is_en = str(locale or "").strip().lower().startswith("en")
    unit = "s" if is_en else "秒"
    sep = "; " if is_en else "；"
    parts = []
    for i in range(len(anchors) - 1):
        parts.append("{0}—{1}{2}…".format(anchors[i], anchors[i + 1], unit))
    return sep.join(parts)


def _fix_minimax_prompt_duration(prompt, duration_sec, engine_profile=None):
  # type: (str, float, str) -> str
    caps = getattr(g, "engine_caps", None)
    timed = (engine_profile or "").strip().lower() == "minimax" or (
        caps and caps.get("allowTimedBeats")
    )
    if not timed:
        return prompt or ""
    text = str(prompt or "")
    try:
        dur = float(duration_sec)
    except (TypeError, ValueError):
        return text
    if not text or dur <= 0:
        return text
    text = re.sub(
        r"制作\s*\d+(?:\.\d+)?\s*秒",
        "制作{0:g}秒".format(dur),
        text,
    )
    text = re.sub(
        r"Make\s*\d+(?:\.\d+)?\s*-?\s*sec(?:ond)?s?",
        "Make {0:g}-sec".format(dur),
        text,
        flags=re.I,
    )
    return text


def _storyboard_bridge_fallback_sec(timing, segment_duration_sec=None):
  # type: (dict, float) -> float
    if timing.get("usesDurationSeconds") and segment_duration_sec is not None:
        try:
            return float(segment_duration_sec)
        except (TypeError, ValueError):
            pass
    return timing["bridgeDefaultSec"]


def _storyboard_bridge_stretch_sec(timing, segment_duration_sec=None):
  # type: (dict, float) -> float
    if timing.get("usesDurationSeconds") and segment_duration_sec is not None:
        try:
            return float(segment_duration_sec)
        except (TypeError, ValueError):
            pass
    return timing["bridgeMaxSec"]


def _max_soft_chain_wall_sec(main_count, engine_profile=None):
    t = _engine_timing(engine_profile)
    n = max(0, int(main_count or 0))
    if n <= 0:
        return 0.0
    if n == 1:
        return t["mainMaxSec"]
    bridge_net = max(0.0, t["bridgeMaxSec"] - 2 * BRIDGE_OVERLAP_SEC)
    return n * t["mainMaxSec"] + (n - 1) * bridge_net


def _min_mains_for_target_duration(target_sec, engine_profile=None):
    t = _engine_timing(engine_profile)
    try:
        target = float(target_sec)
    except (TypeError, ValueError):
        return 2
    if target <= 0:
        return 2
    bridge_net = max(0.0, t["bridgeMaxSec"] - 2 * BRIDGE_OVERLAP_SEC)
    denom = t["mainMaxSec"] + bridge_net
    n_full = int(math.ceil((target + bridge_net) / denom))
    n_unit = int(math.ceil(target / t["softChainUnitSec"])) + 1
    return max(2, min(config.LLM_SEGMENT_MAX, max(n_full, n_unit)))


def _estimate_storyboard_wall_sec(shots, bridges):
    estimated = sum(float(s.get("durationSec") or 0) for s in shots)
    for b in bridges:
        if b.get("needBridge"):
            estimated += max(0.0, float(b.get("durationSec") or 0) - 2 * BRIDGE_OVERLAP_SEC)
    return estimated


def _enforce_soft_chain_duration_budget(
    shots, bridges, target_sec, engine_profile=None, segment_duration_sec=None
):
    """Stretch already-soft bridges when under target.

    Only force all seams soft when even a full soft pack cannot reach ~85%
    (physical under-capacity). Never convert intentional hard camera-change
    seams to soft just to pad time in the reachable case.
    """
    t = _engine_timing(engine_profile)
    stretch_sec = _storyboard_bridge_stretch_sec(t, segment_duration_sec)
    try:
        target = float(target_sec)
    except (TypeError, ValueError):
        return shots, bridges
    if target <= 0 or len(shots) < 2:
        return shots, bridges
    max_possible = _max_soft_chain_wall_sec(len(shots), engine_profile)
    if max_possible < target * 0.85:
        for i in range(len(shots) - 1):
            shots[i]["cutToNext"] = "soft"
        shots[-1]["cutToNext"] = "hard"
        for i in range(len(bridges)):
            shot = shots[i]
            if shot["cutToNext"] == "hard":
                bridges[i] = {
                    "afterShot": shot["id"],
                    "needBridge": False,
                    "durationSec": 0.0,
                    "prompt": "",
                }
            else:
                prev = bridges[i] if i < len(bridges) else {}
                bridges[i] = {
                    "afterShot": shot["id"],
                    "needBridge": True,
                    "durationSec": stretch_sec,
                    "prompt": prev.get("prompt") or "",
                }
    else:
        estimated = _estimate_storyboard_wall_sec(shots, bridges)
        bridge_fallback = _storyboard_bridge_fallback_sec(t, segment_duration_sec)
        if estimated < target * 0.85:
            for i in range(len(bridges)):
                if shots[i]["cutToNext"] == "hard":
                    continue
                prev = bridges[i] if i < len(bridges) else {}
                bridges[i] = {
                    "afterShot": shots[i]["id"],
                    "needBridge": True,
                    "durationSec": _clamp_storyboard_duration(
                        max(
                            float(prev.get("durationSec") or 0),
                            stretch_sec * 0.7,
                        ),
                        bridge_fallback,
                        allow_zero=False,
                        max_sec=stretch_sec,
                        min_sec=max(BRIDGE_MIN_SEC, t["bridgeMinSec"]),
                    ),
                    "prompt": prev.get("prompt") or "",
                }
            estimated = _estimate_storyboard_wall_sec(shots, bridges)
            if estimated < target * 0.85:
                for b in bridges:
                    if b.get("needBridge"):
                        b["durationSec"] = stretch_sec
    return shots, bridges


def _normalize_storyboard_result(
    data, expected_n=None, target_duration_sec=None, engine_profile=None, default_main_sec=None
):
    timing = _engine_timing(engine_profile)
    try:
        segment_dur = (
            float(default_main_sec)
            if default_main_sec is not None
            else timing["mainDefaultSec"]
        )
    except (TypeError, ValueError):
        segment_dur = timing["mainDefaultSec"]
    bridge_fallback = _storyboard_bridge_fallback_sec(timing, segment_dur)
    if not isinstance(data, dict):
        raise ValueError("分镜 JSON 必须是对象")
    shots_raw = data.get("shots")
    if not isinstance(shots_raw, list) or not shots_raw:
        prompts = data.get("prompts")
        if isinstance(prompts, list) and prompts:
            shots_raw = []
            for i, p in enumerate(prompts):
                cleaned = _strip_prompt_meta_guides(p) if p is not None else ""
                if not cleaned:
                    continue
                shots_raw.append(
                    {
                        "id": f"s{i + 1}",
                        "title": f"片段 {i + 1}",
                        "beat": cleaned,
                        "prompt": cleaned,
                        "durationSec": segment_dur,
                        "camera": "",
                        "cutToNext": "soft" if i < len(prompts) - 1 else "hard",
                    }
                )
        else:
            raise ValueError("JSON 缺少非空 shots 数组")
    shots = []
    for i, raw in enumerate(shots_raw):
        if not isinstance(raw, dict):
            raise ValueError(f"shots[{i}] 必须是对象")
        prompt = _strip_prompt_meta_guides(raw.get("prompt") or "")
        if not prompt:
            raise ValueError(f"shots[{i}] 缺少 prompt")
        shot_id = str(raw.get("id") or f"s{i + 1}").strip() or f"s{i + 1}"
        title = str(raw.get("title") or f"片段 {i + 1}").strip() or f"片段 {i + 1}"
        beat = str(raw.get("beat") or prompt).strip() or prompt
        camera = str(raw.get("camera") or "").strip()
        cut = str(raw.get("cutToNext") or "soft").strip().lower()
        if cut not in ("hard", "soft"):
            cut = "soft"
        if i == len(shots_raw) - 1:
            cut = "hard"
        shots.append(
            {
                "id": shot_id,
                "title": title,
                "beat": beat,
                "prompt": _fix_minimax_prompt_duration(
                    prompt,
                    _clamp_storyboard_duration(
                        raw.get("durationSec"),
                        segment_dur,
                        max_sec=timing["mainMaxSec"],
                        min_sec=timing["mainMinSec"],
                    ),
                    engine_profile,
                ),
                "durationSec": _clamp_storyboard_duration(
                    raw.get("durationSec"),
                    segment_dur,
                    max_sec=timing["mainMaxSec"],
                    min_sec=timing["mainMinSec"],
                ),
                "camera": camera,
                "cutToNext": cut,
            }
        )
    if expected_n is not None:
        if len(shots) > expected_n:
            shots = shots[:expected_n]
        elif len(shots) < expected_n:
            raise ValueError(f"模型返回段数不匹配（got={len(shots)}, expected={expected_n}）")
    elif len(shots) < config.LLM_SEGMENT_MIN:
        raise ValueError(f"模型返回段数过少（{len(shots)}）")
    if len(shots) > config.LLM_SEGMENT_MAX:
        shots = shots[: config.LLM_SEGMENT_MAX]
    # Structural trailer only (no next seam); not a creative hard-cut signal.
    if shots:
        shots[-1]["cutToNext"] = "hard"

    plan_target = None
    if target_duration_sec is not None:
        try:
            plan_target = float(target_duration_sec)
        except (TypeError, ValueError):
            plan_target = None
    if plan_target is None and data.get("totalDurationSec") is not None:
        try:
            plan_target = float(data.get("totalDurationSec"))
        except (TypeError, ValueError):
            plan_target = None

    # Only when even a full soft pack cannot reach ~85% of target, force soft seams.
    if plan_target and plan_target > 0:
        if _max_soft_chain_wall_sec(len(shots), engine_profile) < plan_target * 0.85:
            for i in range(len(shots) - 1):
                shots[i]["cutToNext"] = "soft"
            shots[-1]["cutToNext"] = "hard"

    bridge_map = {}
    bridges_raw = data.get("bridges")
    if isinstance(bridges_raw, list):
        for i, raw in enumerate(bridges_raw):
            if not isinstance(raw, dict):
                continue
            after_shot = str(raw.get("afterShot") or "").strip()
            if not after_shot:
                continue
            bridge_map[after_shot] = {
                "afterShot": after_shot,
                "durationSec": raw.get("durationSec"),
                "prompt": _strip_prompt_meta_guides(raw.get("prompt") or ""),
            }
    bridges = []
    for i, shot in enumerate(shots[:-1]):
        existing = bridge_map.get(shot["id"], {})
        # cutToNext is the source of truth for needBridge.
        need_bridge = shot["cutToNext"] != "hard"
        if need_bridge:
            raw_dur = existing.get("durationSec")
            try:
                raw_dur_n = float(raw_dur)
            except (TypeError, ValueError):
                raw_dur_n = 0.0
            bridges.append(
                {
                    "afterShot": shot["id"],
                    "needBridge": True,
                    "durationSec": _clamp_storyboard_duration(
                        raw_dur if raw_dur_n > 0 else bridge_fallback,
                        bridge_fallback,
                        allow_zero=False,
                        max_sec=timing["bridgeMaxSec"],
                        min_sec=max(BRIDGE_MIN_SEC, timing["bridgeMinSec"]),
                    ),
                    "prompt": existing.get("prompt") or "",
                }
            )
        else:
            bridges.append(
                {
                    "afterShot": shot["id"],
                    "needBridge": False,
                    "durationSec": 0.0,
                    "prompt": "",
                }
            )

    if plan_target and plan_target > 0:
        shots, bridges = _enforce_soft_chain_duration_budget(
            shots, bridges, plan_target, engine_profile, segment_dur
        )

    synopsis = str(data.get("script_synopsis") or "").strip()
    if not synopsis:
        synopsis = " / ".join(shot["beat"] for shot in shots[:3])
    estimated = _estimate_storyboard_wall_sec(shots, bridges)
    max_possible = _max_soft_chain_wall_sec(len(shots), engine_profile)
    total = data.get("totalDurationSec")
    if total is None and target_duration_sec is not None:
        total = target_duration_sec
    if total is None:
        total = estimated
    try:
        total_n = float(total)
    except (TypeError, ValueError):
        total_n = estimated
    if total_n > max_possible:
        total_n = max_possible
    total = _clamp_target_duration_sec(total_n, estimated or 30.0)
    return {
        "totalDurationSec": total,
        "script_synopsis": synopsis,
        "shots": shots,
        "bridges": bridges,
        "engineProfile": (engine_profile or "wan"),
    }


def _parse_llm_storyboard_content(
    content, expected_n=None, target_duration_sec=None, engine_profile=None
):
    text = (content or "").strip()
    if not text:
        raise ValueError("模型返回为空")
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.I)
    if fence:
        text = fence.group(1).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("模型未返回 JSON 对象")
        data = json.loads(text[start : end + 1])
    return _normalize_storyboard_result(
        data,
        expected_n=expected_n,
        target_duration_sec=target_duration_sec,
        engine_profile=engine_profile,
    )


def _parse_llm_storyboard_patch_content(content, engine_profile=None):
    timing = _engine_timing(engine_profile)
    text = (content or "").strip()
    if not text:
        raise ValueError("模型返回为空")
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.I)
    if fence:
        text = fence.group(1).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("模型未返回 JSON 对象")
        data = json.loads(text[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError("patch JSON 必须是对象")
    patch = data.get("patch")
    if not isinstance(patch, dict):
        raise ValueError("patch 字段缺失")
    out = {"summary": str(data.get("summary") or "").strip(), "patch": {}}
    if "script_synopsis" in patch:
        out["patch"]["script_synopsis"] = str(patch.get("script_synopsis") or "").strip()
    shots = patch.get("shots")
    if isinstance(shots, list):
        out["patch"]["shots"] = []
        for i, raw in enumerate(shots):
            if not isinstance(raw, dict):
                continue
            shot_id = str(raw.get("id") or "").strip()
            if not shot_id:
                continue
            item = {"id": shot_id}
            for key in ("title", "beat", "camera"):
                if key in raw:
                    item[key] = str(raw.get(key) or "").strip()
            if "prompt" in raw:
                item["prompt"] = _strip_prompt_meta_guides(raw.get("prompt") or "")
            if "cutToNext" in raw:
                cut = str(raw.get("cutToNext") or "").strip().lower()
                item["cutToNext"] = cut if cut in ("hard", "soft") else "soft"
            if "durationSec" in raw:
                item["durationSec"] = _clamp_storyboard_duration(
                    raw.get("durationSec"),
                    timing["mainDefaultSec"],
                    max_sec=timing["mainMaxSec"],
                    min_sec=timing["mainMinSec"],
                )
            out["patch"]["shots"].append(item)
    bridges = patch.get("bridges")
    if isinstance(bridges, list):
        out["patch"]["bridges"] = []
        for i, raw in enumerate(bridges):
            if not isinstance(raw, dict):
                continue
            bridge_id = str(raw.get("id") or "").strip()
            after_shot = str(raw.get("afterShot") or "").strip()
            if not bridge_id and not after_shot:
                continue
            item = {}
            if bridge_id:
                item["id"] = bridge_id
            if after_shot:
                item["afterShot"] = after_shot
            if "needBridge" in raw:
                item["needBridge"] = bool(raw.get("needBridge"))
            if "cutToNext" in raw:
                cut = str(raw.get("cutToNext") or "").strip().lower()
                item["cutToNext"] = cut if cut in ("hard", "soft") else "soft"
            need_bridge = item.get("needBridge")
            if need_bridge is None and "cutToNext" in item:
                need_bridge = item["cutToNext"] != "hard"
            if need_bridge is None:
                need_bridge = True
            if "durationSec" in raw:
                item["durationSec"] = _clamp_storyboard_duration(
                    raw.get("durationSec"),
                    timing["bridgeDefaultSec"] if need_bridge else 0.0,
                    allow_zero=True,
                    max_sec=timing["bridgeMaxSec"],
                    min_sec=0.0
                    if not need_bridge
                    else max(BRIDGE_MIN_SEC, timing["bridgeMinSec"]),
                )
            if "prompt" in raw:
                item["prompt"] = (
                    _strip_prompt_meta_guides(raw.get("prompt") or "")
                    if need_bridge
                    else ""
                )
            out["patch"]["bridges"].append(item)
    return out


def _llm_chat_completion(*, api_key, base_url, model, system, user_msg):
    """Call OpenAI-compatible chat/completions. Returns (content, error_response)."""
    url = f"{base_url}/chat/completions"
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_msg},
        ],
        "temperature": 0.7,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    if "openrouter.ai" in base_url:
        headers["HTTP-Referer"] = request.host_url.rstrip("/")
        headers["X-Title"] = "HitVgo"
    try:
        resp = _http.post(url, headers=headers, json=body, timeout=120)
        result = resp.json()
    except requests.RequestException as e:
        return None, _err(msg("err.llm_request_failed_detail", detail=str(e)), 502)
    except ValueError:
        return None, _err(msg("err.llm_not_json"), 502)
    if resp.status_code >= 400:
        upstream_msg = (
            (result.get("error") or {}).get("message")
            if isinstance(result.get("error"), dict)
            else result.get("message") or result.get("error") or resp.text[:300]
        )
        return None, _err(
            msg(
                "err.llm_upstream_detail",
                status=resp.status_code,
                detail=str(upstream_msg),
            ),
            502,
        )
    try:
        content = result["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return None, _err(msg("err.llm_upstream"), 502, upstream=result)
    return content, None


def _resolve_llm_credentials(payload):
    """Platform LLM only: ignore client keys; use server credentials."""
    if not config.is_official_instance():
        return None, None, None, _err(msg("err.platform_disabled"), 403)
    api_key = config.get_llm_api_key()
    if not api_key:
        return None, None, None, _err(
            msg("err.llm_not_configured"),
            503,
        )
    # Optional client model pick for platform catalog; base_url stays server-side.
    base_url = config.LLM_BASE_URL
    model = (payload.get("llmModel") or "").strip() or config.default_llm_model()
    return api_key, base_url, model, None


def _storyboard_engine_constraint_block(payload, locale="zh"):
    """Dynamic capability + user-config block injected into LLM user messages."""
    caps = _coerce_engine_caps(payload.get("engineCaps"))
    g.engine_caps = caps
    raw_id = str(payload.get("engineProfile") or "wan").strip()
    if caps:
        engine_profile = raw_id or "user"
        eng = dict(config.get_storyboard_engine("wan"))
        eng.update(caps)
        eng["id"] = engine_profile
        if caps.get("name"):
            eng["name"] = caps["name"]
    else:
        engine_profile = raw_id.lower()
        if engine_profile not in ("wan", "minimax"):
            engine_profile = "wan"
        eng = config.get_storyboard_engine(engine_profile)
    timing = _engine_timing(engine_profile)
    shot_durs = payload.get("shotDurations")
    segment_dur = payload.get("defaultMainDurationSec")
    if isinstance(shot_durs, list) and shot_durs:
        try:
            segment_dur = float(shot_durs[0])
        except (TypeError, ValueError):
            pass
    try:
        segment_dur = float(segment_dur) if segment_dur is not None else timing["mainDefaultSec"]
    except (TypeError, ValueError):
        segment_dur = timing["mainDefaultSec"]
    segment_dur = _clamp_storyboard_duration(
        segment_dur,
        timing["mainDefaultSec"],
        False,
        timing["mainMaxSec"],
        timing["mainMinSec"],
    )
    use_multi = bool(payload.get("useMultiRef")) and bool(eng.get("supportsMultiRef"))
    refs = payload.get("refAssets")
    if not isinstance(refs, list):
        refs = []
    inject_refs = bool(refs) and (use_multi or engine_profile == "minimax")
    lines = []
    display_name = str(eng.get("name") or engine_profile)
    is_timed = bool(eng.get("allowTimedBeats")) or engine_profile == "minimax"
    if locale == "en":
        lines.append("【Engine】" + display_name)
        lines.append(
            "Main duration {0}–{1}s (default {2}); bridge {3}–{4}s.".format(
                eng["mainMinSec"],
                eng["mainMaxSec"],
                eng["mainDefaultSec"],
                eng["bridgeMinSec"],
                eng["bridgeMaxSec"],
            )
        )
        if eng.get("allowTimedBeats"):
            lines.append(
                "Write timed beats 0—Ns matching each shot's durationSec; "
                "audio/dialogue/SFX allowed."
            )
            if engine_profile == "minimax":
                beat_sk = _build_minimax_beat_skeleton(segment_dur, locale)
                lines.append(
                    "【Main prompt format】With <Picture 1> as the sole start frame, make {N}-sec … video; "
                    "do NOT write or paraphrase reference <Picture N>… for extra refs in the prompt body "
                    "(system injects fixed content/role from usedRefs); "
                    "at the start lock facial features, appearance, wardrobe and scene/lighting; "
                    "state re-anchor before the first beat; timed beats covering full N. "
                    "When the plot needs emotion/reveal/pressure/follow, write framing/moves and pose/expression beside that beat — "
                    "no mandated close-up/full-body, no empty camera boilerplate. "
                    "When characters speak, write the actual lines; silent beats get none. "
                    "Score …; SFX …. Sparse speech; no logos, watermarks; avoid drift/face collapse. "
                    "Do not use legacy <image N> tags."
                )
                lines.append(
                    "Skeleton ({0:g}s): With <Picture 1> as sole start frame, make {0:g}-sec …; "
                    "lock facial features, appearance, wardrobe…. {1}. "
                    "Score …; SFX …. No Logo/watermark; avoid drift/face collapse.".format(
                        segment_dur, beat_sk
                    )
                )
                lines.append(
                    "【Bridge duration】Same as main segment: {0:g}s when needBridge=true.".format(
                        segment_dur
                    )
                )
        else:
            lines.append(
                "Do NOT write seconds, dialogue, voice-over, or music in prompts."
            )
        if inject_refs:
            lines.append(
                "【References】<Picture 1>=shared start frame; extra stills from <Picture 2>; "
                "videos/audio as <Video N>/<Audio N> from 1. Cite only slots you have."
            )
            lines.append("  <Picture 1> shared start / first frame")
            img_i = 1
            vid_i = 0
            aud_i = 0
            for raw in refs:
                if not isinstance(raw, dict):
                    continue
                kind = str(raw.get("kind") or "image").strip().lower()
                content = (
                    str(raw.get("content") or "").strip()
                    or str(raw.get("note") or "").strip()
                    or "(no content)"
                )
                purpose = str(raw.get("purpose") or "").strip() or "(no role)"
                if kind == "video":
                    vid_i += 1
                    tag = "Video {0}".format(vid_i)
                elif kind == "audio":
                    aud_i += 1
                    tag = "Audio {0}".format(aud_i)
                else:
                    img_i += 1
                    tag = "Picture {0}".format(img_i)
                lines.append(
                    "  <{0}> content: {1} | role: {2}".format(tag, content, purpose)
                )
            if engine_profile == "minimax":
                lines.append(
                    "【Reference placement】For each extra ref, choose which main shot(s) need it "
                    "from the plot (usually one; more only if still relevant). Put those tags in "
                    "that shot's usedRefs (e.g. [\"Picture 2\"]). Do NOT write or paraphrase "
                    "reference <Picture N>… in prompt body — the system injects fixed content/role "
                    "verbatim. Omit unused slots from usedRefs and prompts. Every extra ref must "
                    "appear in at least one shot's usedRefs."
                )
        elif engine_profile == "minimax":
            lines.append(
                "【References】<Picture 1> is the sole shared start frame; do not invent other "
                "<Picture N> unless listed above. Open with <Picture 1> as sole start frame."
            )
        else:
            lines.append("【References】no multi-ref; do not invent <Picture N> tags.")
        shot_durs = payload.get("shotDurations")
        if isinstance(shot_durs, list) and shot_durs:
            lines.append(
                "【User shot durations】" + ", ".join(str(x) for x in shot_durs)
                + " — each main durationSec MUST match exactly; do not rewrite."
            )
        else:
            dmd = payload.get("defaultMainDurationSec")
            if dmd is not None:
                lines.append(
                    "【Default main duration】{0}s — use for every main unless listed otherwise.".format(
                        dmd
                    )
                )
    else:
        lines.append("【引擎】" + display_name)
        lines.append(
            "主段时长 {0}–{1} 秒（默认 {2}）；桥 {3}–{4} 秒。".format(
                eng["mainMinSec"],
                eng["mainMaxSec"],
                eng["mainDefaultSec"],
                eng["bridgeMinSec"],
                eng["bridgeMaxSec"],
            )
        )
        if eng.get("allowTimedBeats"):
            lines.append(
                "主段 prompt 按本段 durationSec 写 0—N 秒节拍；允许台词/配乐/音效。"
            )
            if engine_profile == "minimax":
                beat_sk = _build_minimax_beat_skeleton(segment_dur, locale)
                lines.append(
                    "【主段 prompt 格式】以<Picture 1>为唯一首帧，制作{N}秒…视频；"
                    "额外参考不要在正文自行撰写或改写 参考<Picture N>…（系统按 usedRefs 原样注入内容/作用）；"
                    "开始时锁定人物五官、外貌、着装与场景/光线；首节拍前状态回锚；节拍覆盖满 N 秒。"
                    "景别/运镜与姿态表情按剧情在需要处写入（情绪/揭示/压迫/跟随等），不硬性规定特写或全身，勿堆套话。"
                    "说话时写入具体话语内容，无言段落不硬编台词。配乐…；音效…。"
                    "全程少量自然口语，无Logo、水印，避免漂移脸崩。"
                    "禁止旧标签 <image N>；禁止「接上一段」「前段:」等元标签。"
                )
                lines.append(
                    "骨架（{0:g}秒）：以<Picture 1>为唯一首帧，制作{0:g}秒…视频；"
                    "开始时锁定人物五官、外貌、着装…；{1}。配乐…；音效…。"
                    "全程…无Logo、水印，避免漂移脸崩。".format(
                        segment_dur, beat_sk
                    )
                )
                lines.append(
                    "【桥段时长】与主段相同：{0:g}秒（软桥 needBridge=true 时 bridges[].durationSec 同此值）。".format(
                        segment_dur
                    )
                )
        else:
            lines.append("禁止在提示词中写秒数、配音、说话或配乐。")
        if inject_refs:
            lines.append(
                "【参考素材】<Picture 1>=共用首帧；额外参考图从 <Picture 2> 起；"
                "视频/音频为 <Video N>/<Audio N> 从 1 起。只引用实际有的槽位。"
            )
            lines.append("  <Picture 1> 共用首帧")
            img_i = 1
            vid_i = 0
            aud_i = 0
            for raw in refs:
                if not isinstance(raw, dict):
                    continue
                kind = str(raw.get("kind") or "image").strip().lower()
                content = (
                    str(raw.get("content") or "").strip()
                    or str(raw.get("note") or "").strip()
                    or "（无说明）"
                )
                purpose = str(raw.get("purpose") or "").strip() or "（无作用）"
                if kind == "video":
                    vid_i += 1
                    tag = "Video {0}".format(vid_i)
                elif kind == "audio":
                    aud_i += 1
                    tag = "Audio {0}".format(aud_i)
                else:
                    img_i += 1
                    tag = "Picture {0}".format(img_i)
                lines.append(
                    "  <{0}> 内容：{1}｜作用：{2}".format(tag, content, purpose)
                )
            if engine_profile == "minimax":
                lines.append(
                    "【参考段落选用】按剧情为每个额外参考选择放在哪些主段（通常 1 段；"
                    "剧情持续相关时可多段）。将该槽位写入对应 shot 的 usedRefs（如 [\"Picture 2\"]）。"
                    "禁止在 prompt 正文自行撰写或改写 参考<Picture N>…——系统会按用户填写的内容/作用原样注入。"
                    "未选用的槽位不要进 usedRefs，也不要在正文提。"
                    "每个额外参考至少出现在一个主段的 usedRefs。"
                )
        elif engine_profile == "minimax":
            lines.append(
                "【参考素材】共用首帧为 <Picture 1>；未列出额外参考时勿编造其他 <Picture N>。"
                "开篇须写 以<Picture 1>为唯一首帧。"
            )
        else:
            lines.append("【参考素材】未启用多参考；禁止编造 <Picture N>。")
        shot_durs = payload.get("shotDurations")
        if isinstance(shot_durs, list) and shot_durs:
            lines.append(
                "【用户指定各段时长】"
                + "、".join(str(x) for x in shot_durs)
                + "（各主段 durationSec 必须原样使用，勿改写）"
            )
        else:
            dmd = payload.get("defaultMainDurationSec")
            if dmd is not None:
                lines.append(
                    "【默认主段时长】{0} 秒——未另列各段时，每主段均用此值。".format(dmd)
                )
    return engine_profile, "\n".join(lines)


@app.get("/api/llm/prompt-templates")
@login_required
def api_llm_prompt_templates():
    """Return storyboard LLM prompt templates for the request locale (custom channel)."""
    locale = request_locale()
    cfg = config.get_llm_prompts(locale)
    return _ok(cfg)


def _parse_llm_json_object(content):
    text = (content or "").strip()
    if not text:
        raise ValueError("模型返回为空")
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.I)
    if fence:
        text = fence.group(1).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("模型未返回 JSON 对象")
        data = json.loads(text[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError("JSON 必须是对象")
    return data


def _normalize_script_llm_result(data, *, expected_n=None, format_name="short"):
    if not isinstance(data, dict):
        raise ValueError("剧本 JSON 必须是对象")
    fmt = str(format_name or data.get("format") or "short").strip().lower()
    if fmt not in ("short", "series"):
        fmt = "short"
    title = str(data.get("title") or "").strip()
    episodes_raw = data.get("episodes")
    if not isinstance(episodes_raw, list) or not episodes_raw:
        raise ValueError("JSON 缺少非空 episodes 数组")
    episodes = []
    for i, raw in enumerate(episodes_raw):
        if not isinstance(raw, dict):
            raise ValueError("episodes[{0}] 必须是对象".format(i))
        script_text = str(raw.get("script") or "").strip()
        if not script_text:
            raise ValueError("episodes[{0}] 缺少可读正文".format(i))
        beats_raw = raw.get("beats")
        beats = []
        if isinstance(beats_raw, list):
            for beat in beats_raw:
                if isinstance(beat, dict):
                    desc = str(beat.get("description") or beat.get("text") or "").strip()
                    if not desc:
                        continue
                    beats.append(
                        {
                            "title": str(beat.get("title") or "").strip(),
                            "description": desc,
                        }
                    )
                elif str(beat).strip():
                    beats.append({"title": "", "description": str(beat).strip()})
        episodes.append(
            {
                "id": str(raw.get("id") or "e{0}".format(i + 1)).strip() or "e{0}".format(i + 1),
                "index": i + 1,
                "title": str(raw.get("title") or "").strip() or "第{0}集".format(i + 1),
                "script": script_text,
                "beats": beats,
            }
        )
    if fmt == "short":
        episodes = episodes[:1]
        if episodes:
            episodes[0]["index"] = 1
            episodes[0]["id"] = episodes[0].get("id") or "e1"
        expected_n = 1
    if expected_n is not None:
        if len(episodes) > expected_n:
            episodes = episodes[:expected_n]
        elif len(episodes) < expected_n:
            raise ValueError(
                "模型返回集数不匹配（got={0}, expected={1}）".format(
                    len(episodes), expected_n
                )
            )
    if len(episodes) > config.LLM_SCRIPT_EPISODE_MAX:
        episodes = episodes[: config.LLM_SCRIPT_EPISODE_MAX]
    if not episodes:
        raise ValueError("episodes 为空")
    return {
        "title": title or (episodes[0]["title"] if episodes else ""),
        "format": fmt,
        "episodes": episodes,
    }


def _parse_script_polish_patch(content):
    data = _parse_llm_json_object(content)
    patch = data.get("patch")
    if not isinstance(patch, dict):
        raise ValueError("patch 字段缺失")
    summary = str(data.get("summary") or "").strip()
    out = {}
    if "title" in patch:
        out["title"] = str(patch.get("title") or "").strip()
    if "plotDirection" in patch or "plot_direction" in patch:
        out["plotDirection"] = str(
            patch.get("plotDirection") or patch.get("plot_direction") or ""
        ).strip()
    if "sceneBible" in patch or "scene_bible" in patch:
        out["sceneBible"] = str(
            patch.get("sceneBible") or patch.get("scene_bible") or ""
        ).strip()
    eps = patch.get("episodes")
    if isinstance(eps, list):
        cleaned = []
        for raw in eps:
            if not isinstance(raw, dict):
                continue
            item = {"id": str(raw.get("id") or "").strip()}
            if "title" in raw:
                item["title"] = str(raw.get("title") or "").strip()
            if "script" in raw:
                item["script"] = str(raw.get("script") or "").strip()
            if "beats" in raw and isinstance(raw.get("beats"), list):
                item["beats"] = raw["beats"]
            if item.get("id"):
                cleaned.append(item)
        out["episodes"] = cleaned
    return {"summary": summary, "patch": out}


@app.post("/api/llm/script")
@login_required
def api_llm_script():
    payload = request.get_json(silent=True) or {}
    api_key, base_url, model, cred_err = _resolve_llm_credentials(payload)
    if cred_err:
        return cred_err
    scene = (payload.get("sceneBible") or payload.get("sceneDescription") or "").strip()
    plot = (payload.get("plotDirection") or "").strip()
    if not scene and not plot:
        return _err(msg("err.script_plot_required"))
    fmt = str(payload.get("format") or "short").strip().lower()
    if fmt not in ("short", "series"):
        fmt = "short"
    locale = request_locale()
    expected_n = None
    if fmt == "short":
        expected_n = 1
        count_note = msg("llm.script_count_short")
    else:
        raw_count = payload.get("episodeCount", None)
        if raw_count is None or raw_count == "":
            count_note = msg(
                "llm.script_count_auto",
                min=config.LLM_SCRIPT_EPISODE_MIN,
                max=config.LLM_SCRIPT_EPISODE_MAX,
            )
        else:
            try:
                n = int(raw_count)
            except (TypeError, ValueError):
                return _err(msg("err.segment_count_invalid"))
            n = max(
                config.LLM_SCRIPT_EPISODE_MIN,
                min(config.LLM_SCRIPT_EPISODE_MAX, n),
            )
            expected_n = n
            count_note = msg("llm.script_count_exact", n=n)
    prompts_cfg = config.get_llm_prompts(locale)
    user_tpl = prompts_cfg.get(
        "script_user_template",
        "【画面设定】\n{scene}\n\n【剧情方向】\n{plot}\n\n【形态】\n{format}\n\n【集数】\n{count_note}",
    )
    system_tpl = prompts_cfg.get(
        "script_system",
        "你是编剧助手。只输出含 title、format、episodes 的 JSON。",
    )
    try:
        user_msg = user_tpl.format(
            scene=scene or "（未提供）",
            plot=plot or "（未提供）",
            format=fmt,
            count_note=count_note,
        )
    except KeyError:
        user_msg = "【画面设定】\n{0}\n\n【剧情方向】\n{1}\n\n【形态】{2}\n{3}".format(
            scene, plot, fmt, count_note
        )
    content, err = _llm_chat_completion(
        api_key=api_key,
        base_url=base_url,
        model=model,
        system=system_tpl,
        user_msg=user_msg,
    )
    if err:
        return err
    try:
        data = _parse_llm_json_object(content)
        script = _normalize_script_llm_result(
            data, expected_n=expected_n, format_name=fmt
        )
    except (ValueError, json.JSONDecodeError) as e:
        return _err(msg("err.llm_parse_failed_detail", detail=str(e)), 502)
    return _ok({"script": script})


@app.post("/api/llm/script-polish")
@login_required
def api_llm_script_polish():
    payload = request.get_json(silent=True) or {}
    api_key, base_url, model, cred_err = _resolve_llm_credentials(payload)
    if cred_err:
        return cred_err
    script = payload.get("script")
    if not isinstance(script, dict):
        return _err("script 必须是对象")
    instruction = str(payload.get("instruction") or "").strip()
    if not instruction:
        return _err("instruction 不能为空")
    scope = str(payload.get("scope") or "all").strip()
    locale = request_locale()
    prompts_cfg = config.get_llm_prompts(locale)
    user_tpl = prompts_cfg.get(
        "script_polish_user_template",
        "【范围】\n{scope}\n\n【修改指令】\n{instruction}\n\n【当前剧本】\n{script_json}",
    )
    system_tpl = prompts_cfg.get(
        "script_polish_system",
        "你是剧本打磨助手。只输出 {\"summary\",\"patch\"} JSON。",
    )
    try:
        user_msg = user_tpl.format(
            scope=scope,
            instruction=instruction,
            script_json=json.dumps(script, ensure_ascii=False, indent=2),
        )
    except KeyError:
        user_msg = "{0}\n{1}\n{2}".format(
            scope, instruction, json.dumps(script, ensure_ascii=False)
        )
    content, err = _llm_chat_completion(
        api_key=api_key,
        base_url=base_url,
        model=model,
        system=system_tpl,
        user_msg=user_msg,
    )
    if err:
        return err
    try:
        patch = _parse_script_polish_patch(content)
    except (ValueError, json.JSONDecodeError) as e:
        return _err(msg("err.llm_parse_failed_detail", detail=str(e)), 502)
    return _ok(patch)


@app.post("/api/llm/prompts")
@login_required
def api_llm_prompts():
    payload = request.get_json(silent=True) or {}
    api_key, base_url, model, cred_err = _resolve_llm_credentials(payload)
    if cred_err:
        return cred_err
    scene = (payload.get("sceneDescription") or "").strip()
    plot = (payload.get("plotDirection") or "").strip()
    episode_script = (payload.get("episodeScript") or "").strip()
    episode_beats = payload.get("episodeBeats")
    if not scene:
        return _err(msg("err.scene_required"))
    if not plot and not episode_script:
        return _err(msg("err.plot_required"))
    if episode_script:
        plot = episode_script
    raw_count = payload.get("segmentCount", None)
    count_note = ""
    expected_n = None
    locale = request_locale()
    engine_profile, constraint_block = _storyboard_engine_constraint_block(
        payload, locale
    )
    target_duration_sec = _clamp_target_duration_sec(
        payload.get("targetDurationSec"), 30.0
    )
    if raw_count is None or raw_count == "":
        count_note = msg(
            "llm.count_note_auto",
            min=config.LLM_SEGMENT_MIN,
            max=config.LLM_SEGMENT_MAX,
            suggest=_min_mains_for_target_duration(
                target_duration_sec, engine_profile
            ),
        )
    else:
        try:
            n = int(raw_count)
        except (TypeError, ValueError):
            return _err(msg("err.segment_count_invalid"))
        n = max(config.LLM_SEGMENT_MIN, min(config.LLM_SEGMENT_MAX, n))
        expected_n = n
        count_note = msg("llm.count_note_exact", n=n)
    prompts_cfg = config.get_llm_prompts(locale)
    use_timed = engine_profile == "minimax" or bool(
        (getattr(g, "engine_caps", None) or {}).get("allowTimedBeats")
    )
    if use_timed:
        user_tpl = prompts_cfg.get(
            "storyboard_user_template_minimax",
            prompts_cfg.get("storyboard_user_template", prompts_cfg["main_user_template"]),
        )
        system_tpl = prompts_cfg.get(
            "storyboard_system_minimax",
            prompts_cfg.get("storyboard_system", prompts_cfg["main_system"]),
        )
    else:
        user_tpl = prompts_cfg.get(
            "storyboard_user_template", prompts_cfg["main_user_template"]
        )
        system_tpl = prompts_cfg.get("storyboard_system", prompts_cfg["main_system"])
    try:
        user_msg = user_tpl.format(
            scene=scene,
            plot=plot,
            count_note=count_note,
            target_duration=int(target_duration_sec),
        )
    except KeyError:
        user_msg = prompts_cfg["main_user_template"].format(
            scene=scene, plot=plot, count_note=count_note
        )
    user_msg = user_msg + "\n\n" + constraint_block
    if episode_script:
        beat_lines = []
        if isinstance(episode_beats, list):
            for i, beat in enumerate(episode_beats):
                if isinstance(beat, dict):
                    title = str(beat.get("title") or "").strip()
                    desc = str(beat.get("description") or beat.get("text") or "").strip()
                    beat_lines.append(
                        "{0}. {1}{2}".format(
                            i + 1,
                            (title + " — ") if title else "",
                            desc,
                        )
                    )
                elif beat:
                    beat_lines.append("{0}. {1}".format(i + 1, str(beat).strip()))
        extra = "【本集可读剧本】\n" + episode_script
        if beat_lines:
            extra += "\n\n【本集场次】\n" + "\n".join(beat_lines)
        extra += "\n请按本集可读内容规划分镜，不要另编无关剧情。"
        user_msg = user_msg + "\n\n" + extra
    content, err = _llm_chat_completion(
        api_key=api_key,
        base_url=base_url,
        model=model,
        system=system_tpl,
        user_msg=user_msg,
    )
    if err:
        return err
    try:
        storyboard = _parse_llm_storyboard_content(
            content,
            expected_n=expected_n,
            target_duration_sec=target_duration_sec,
            engine_profile=engine_profile,
        )
    except (ValueError, json.JSONDecodeError) as e:
        return _err(msg("err.llm_parse_failed_detail", detail=str(e)), 502)
    # Force user-specified main durations (client also re-applies; keep API consistent)
    shot_durs = payload.get("shotDurations")
    timing = _engine_timing(engine_profile)
    default_main = payload.get("defaultMainDurationSec")
    try:
        default_main = float(default_main) if default_main is not None else timing["mainDefaultSec"]
    except (TypeError, ValueError):
        default_main = timing["mainDefaultSec"]
    default_main = _clamp_storyboard_duration(
        default_main,
        timing["mainDefaultSec"],
        False,
        timing["mainMaxSec"],
        timing["mainMinSec"],
    )
    if isinstance(shot_durs, list) and shot_durs:
        for i, shot in enumerate(storyboard.get("shots") or []):
            if i < len(shot_durs) and shot_durs[i] is not None:
                shot["durationSec"] = _clamp_storyboard_duration(
                    shot_durs[i],
                    default_main,
                    False,
                    timing["mainMaxSec"],
                    timing["mainMinSec"],
                )
            else:
                shot["durationSec"] = default_main
    else:
        for shot in storyboard.get("shots") or []:
            shot["durationSec"] = default_main
    for shot in storyboard.get("shots") or []:
        shot["prompt"] = _fix_minimax_prompt_duration(
            shot.get("prompt") or "",
            shot.get("durationSec"),
            engine_profile,
        )
    shot_by_id = {
        str(s.get("id") or ""): s for s in (storyboard.get("shots") or []) if s
    }
    for bridge in storyboard.get("bridges") or []:
        if bridge.get("needBridge"):
            after = str(bridge.get("afterShot") or "")
            shot = shot_by_id.get(after)
            bridge["durationSec"] = (
                shot.get("durationSec") if shot else default_main
            )
    prompts = [shot["prompt"] for shot in storyboard["shots"]]
    return _ok({"prompts": prompts, "storyboard": storyboard})


@app.post("/api/llm/bridges")
@login_required
def api_llm_bridges():
    """Generate FLF bridge prompts from adjacent main-segment prompt pairs."""
    payload = request.get_json(silent=True) or {}
    api_key, base_url, model, cred_err = _resolve_llm_credentials(payload)
    if cred_err:
        return cred_err
    raw_pairs = payload.get("pairs")
    if not isinstance(raw_pairs, list) or not raw_pairs:
        return _err(msg("err.pairs_required"))
    pairs = []
    for i, item in enumerate(raw_pairs):
        if not isinstance(item, dict):
            return _err(f"pairs[{i}] 必须是对象")
        left = (item.get("leftPrompt") or "").strip()
        right = (item.get("rightPrompt") or "").strip()
        if not left or not right:
            return _err(f"pairs[{i}] 需要非空 leftPrompt 与 rightPrompt")
        pairs.append({"leftPrompt": left, "rightPrompt": right, "index": i})
    expected_n = len(pairs)
    if expected_n > config.LLM_SEGMENT_MAX:
        return _err(f"桥段对数过多（{expected_n}），最多 {config.LLM_SEGMENT_MAX}")
    locale = request_locale()
    prompts_cfg = config.get_llm_prompts(locale)
    pair_tpl = prompts_cfg["bridge_pair_template"]
    pair_blocks = []
    for i, p in enumerate(pairs):
        pair_blocks.append(
            pair_tpl.format(
                i=i + 1,
                n=expected_n,
                left=p["leftPrompt"],
                right=p["rightPrompt"],
            )
        )
    intro = prompts_cfg["bridge_user_intro"].format(n=expected_n)
    user_msg = intro + "\n\n" + "\n\n".join(pair_blocks)
    content, err = _llm_chat_completion(
        api_key=api_key,
        base_url=base_url,
        model=model,
        system=prompts_cfg["bridge_system"],
        user_msg=user_msg,
    )
    if err:
        return err
    try:
        prompts = _parse_llm_prompts_content(content)
    except (ValueError, json.JSONDecodeError) as e:
        return _err(msg("err.llm_parse_failed_detail", detail=str(e)), 502)
    if len(prompts) > expected_n:
        prompts = prompts[:expected_n]
    elif len(prompts) < expected_n:
        return _err(msg("err.llm_prompt_count_detail", got=len(prompts), expected=expected_n), 502)
    return _ok({"prompts": prompts})


@app.post("/api/llm/storyboard-polish")
@login_required
def api_llm_storyboard_polish():
    payload = request.get_json(silent=True) or {}
    api_key, base_url, model, cred_err = _resolve_llm_credentials(payload)
    if cred_err:
        return cred_err
    storyboard = payload.get("storyboard")
    if not isinstance(storyboard, dict):
        return _err("storyboard 必须是对象")
    instruction = str(payload.get("instruction") or "").strip()
    if not instruction:
        return _err("instruction 不能为空")
    scope = str(payload.get("scope") or "global").strip()
    locale = request_locale()
    engine_profile, constraint_block = _storyboard_engine_constraint_block(
        payload, locale
    )
    prompts_cfg = config.get_llm_prompts(locale)
    user_msg = prompts_cfg.get(
        "storyboard_polish_user_template",
        "scope={scope}\ninstruction={instruction}\n{storyboard_json}",
    ).format(
        scope=scope,
        instruction=instruction,
        storyboard_json=json.dumps(storyboard, ensure_ascii=False, indent=2),
    )
    user_msg = user_msg + "\n\n" + constraint_block
    if engine_profile == "minimax" or bool(
        (getattr(g, "engine_caps", None) or {}).get("allowTimedBeats")
    ):
        polish_system = prompts_cfg.get(
            "storyboard_polish_system_minimax",
            prompts_cfg.get("storyboard_polish_system", prompts_cfg.get("storyboard_system", "")),
        )
    else:
        polish_system = prompts_cfg.get(
            "storyboard_polish_system", prompts_cfg.get("storyboard_system", "")
        )
    content, err = _llm_chat_completion(
        api_key=api_key,
        base_url=base_url,
        model=model,
        system=polish_system,
        user_msg=user_msg,
    )
    if err:
        return err
    try:
        patch = _parse_llm_storyboard_patch_content(
            content, engine_profile=engine_profile
        )
    except (ValueError, json.JSONDecodeError) as e:
        return _err(msg("err.llm_parse_failed_detail", detail=str(e)), 502)
    return _ok(patch)


def _strip_llm_plain_prompt(content):
    """Strip optional code fences / quotes from a plain-text image prompt."""
    text = (content or "").strip()
    if not text:
        return ""
    fence = re.search(r"```(?:\w+)?\s*([\s\S]*?)```", text, re.I)
    if fence:
        text = fence.group(1).strip()
    if (text.startswith('"') and text.endswith('"')) or (
        text.startswith("'") and text.endswith("'")
    ):
        text = text[1:-1].strip()
    return text.strip()


@app.post("/api/llm/t2i-expand")
@login_required
def api_llm_t2i_expand():
    """Expand/polish a short T2I prompt; output language follows UI locale templates."""
    payload = request.get_json(silent=True) or {}
    api_key, base_url, model, cred_err = _resolve_llm_credentials(payload)
    if cred_err:
        return cred_err
    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        return _err("prompt 不能为空")
    locale = request_locale()
    prompts_cfg = config.get_llm_prompts(locale)
    user_tpl = prompts_cfg.get("t2i_expand_user_template", "【需求】\n{prompt}")
    try:
        user_msg = user_tpl.format(prompt=prompt)
    except KeyError:
        user_msg = "【需求】\n" + prompt
    content, err = _llm_chat_completion(
        api_key=api_key,
        base_url=base_url,
        model=model,
        system=prompts_cfg.get("t2i_expand_system", ""),
        user_msg=user_msg,
    )
    if err:
        return err
    expanded = _strip_llm_plain_prompt(content)
    if not expanded:
        return _err(msg("err.llm_parse_failed_detail", detail="模型返回为空"), 502)
    return _ok({"prompt": expanded})


@app.post("/api/llm/adapter")
@login_required
def api_llm_adapter():
    """Generate workflow adapter draft from UI or API workflow via platform LLM."""
    payload = request.get_json(silent=True) or {}
    api_key, base_url, model, cred_err = _resolve_llm_credentials(payload)
    if cred_err:
        return cred_err
    provider = (payload.get("provider") or "").strip().lower()
    if provider not in ("runninghub", "comfyui"):
        return _err(msg("err.provider_invalid"))
    mode = (payload.get("mode") or "").strip().lower() or "i2v"
    if mode not in ("i2v", "flf", "editor", "extract"):
        return _err(msg("err.adapter_invalid"))
    workflow = payload.get("workflow")
    workflow_text = (payload.get("workflowText") or "").strip()
    if workflow is None and workflow_text:
        try:
            workflow = json.loads(workflow_text)
        except json.JSONDecodeError:
            return _err(msg("err.workflow_invalid"))
    nodes_hint = payload.get("nodes") or payload.get("nodesSummary")
    if workflow is None and not (isinstance(nodes_hint, list) and nodes_hint):
        return _err(msg("err.workflow_required"))
    workflow_id = (payload.get("workflowId") or "").strip()

    def _is_ui(wf):
        return isinstance(wf, dict) and (
            (isinstance(wf.get("nodes"), list) and isinstance(wf.get("links"), list))
            or ("last_node_id" in wf and isinstance(wf.get("nodes"), list))
        )

    def _summarize_ui(wf):
        links = wf.get("links") or []
        link_ids = {l[0] for l in links if isinstance(l, (list, tuple)) and l}
        out = []
        for node in wf.get("nodes") or []:
            if not isinstance(node, dict) or node.get("id") is None:
                continue
            widgets = []
            wvals = node.get("widgets_values") if isinstance(node.get("widgets_values"), list) else []
            w_idx = 0
            linked = []
            for inp in node.get("inputs") or []:
                if not isinstance(inp, dict):
                    continue
                name = inp.get("name") or ((inp.get("widget") or {}).get("name")) or ""
                if inp.get("link") is not None:
                    if name:
                        linked.append(name)
                    continue
                if name and w_idx < len(wvals):
                    widgets.append({"name": name, "value": wvals[w_idx], "linked": False})
                    w_idx += 1
            if (
                not widgets
                and wvals
                and str(node.get("type") or "").startswith("Primitive")
            ):
                for i, value in enumerate(wvals):
                    widgets.append(
                        {
                            "name": "value" if i == 0 else f"widget_{i}",
                            "value": value,
                            "linked": False,
                        }
                    )
            out.append(
                {
                    "nodeId": str(node["id"]),
                    "class_type": node.get("type") or "",
                    "title": node.get("title") or "",
                    "widgets": widgets,
                    "linkedInputs": linked,
                    "outputTypes": [
                        o.get("type")
                        for o in (node.get("outputs") or [])
                        if isinstance(o, dict) and o.get("type")
                    ],
                }
            )
        return out

    def _summarize_api(wf):
        graph = wf
        if isinstance(wf, dict) and isinstance(wf.get("prompt"), dict):
            graph = wf["prompt"]
        if not isinstance(graph, dict):
            return []
        out = []
        for nid, node in graph.items():
            if not isinstance(node, dict) or "class_type" not in node:
                continue
            inputs = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
            meta = node.get("_meta") if isinstance(node.get("_meta"), dict) else {}
            widgets = [
                {"name": k, "value": v, "linked": False}
                for k, v in inputs.items()
                if not isinstance(v, list)
            ]
            linked = [k for k, v in inputs.items() if isinstance(v, list)]
            out.append(
                {
                    "nodeId": str(nid),
                    "class_type": node.get("class_type") or "",
                    "title": meta.get("title") or "",
                    "widgets": widgets,
                    "linkedInputs": linked,
                    "outputTypes": [],
                    "fields": list(inputs.keys()),
                }
            )
        return out

    nodes_in = payload.get("nodes") or payload.get("nodesSummary")
    if isinstance(nodes_in, list) and nodes_in:
        nodes_summary = nodes_in
    else:
        if workflow is None:
            return _err(msg("err.workflow_required"))
        raw_summary = _summarize_ui(workflow) if _is_ui(workflow) else _summarize_api(workflow)
        if not raw_summary:
            return _err(msg("err.workflow_required"))
        # Drop widget values; group to slim {id,t,title,f}
        slim_by = {}
        for n in raw_summary:
            if not isinstance(n, dict):
                continue
            nid = str(n.get("nodeId") or "")
            if not nid:
                continue
            row = slim_by.setdefault(nid, {"id": nid, "t": n.get("class_type") or "", "f": []})
            title = n.get("title") or ""
            if title:
                row["title"] = title
            for w in n.get("widgets") or []:
                name = w.get("name") if isinstance(w, dict) else None
                if name and name not in row["f"]:
                    row["f"].append(name)
            for f in n.get("fields") or []:
                if f and f not in row["f"]:
                    row["f"].append(f)
        nodes_summary = list(slim_by.values())
    if not nodes_summary:
        return _err(msg("err.workflow_required"))

    locale = (payload.get("locale") or "zh").strip().lower()
    target = (payload.get("target") or "").strip().lower()
    if mode == "extract":
        if locale == "en":
            system = (
                "Label Comfy candidate inputs. JSON only, no markdown.\n"
                '{"v":1,"i":[{"n":"62","f":"image","b":"startImage"},{"n":"6","f":"text","b":"prompt"}]}\n'
                "n=nodeId f=field b=bind or \"\". binds: startImage,endImage,inputVideo,inputAudio,"
                "prompt,negative,width,height,length,fps,seedHigh,seedLow,duration,refImage0-8,refVideo0-2,refAudio0.\n"
                "Seconds→duration. Multi-ref images→refImage0.. in order. Prompt: PrimitiveString titled 提示词. Only bind nodes in the list. Omit k/l."
            )
        else:
            system = (
                "标注候选 Comfy 输入。只输出 JSON，不要 markdown。\n"
                '{"v":1,"i":[{"n":"62","f":"image","b":"startImage"},{"n":"6","f":"text","b":"prompt"}]}\n'
                "n=nodeId f=字段 b=语义槽或\"\"。槽: startImage,endImage,inputVideo,inputAudio,"
                "prompt,negative,width,height,length,fps,seedHigh,seedLow,duration,refImage0-8,refVideo0-2,refAudio0。\n"
                "秒→duration。多参考图按序 refImage0..。提示词优先标题含「提示词」的 PrimitiveString。只绑定列表中的节点。不要输出 k/l。"
            )
        user_msg = (
            f"provider={provider}\n"
            f"target={target or '(none)'}\n"
            f"workflowId={workflow_id or '(none)'}\n"
            "Label binds only. Do not echo nodes.\n\n"
            f"nodes:\n{json.dumps(nodes_summary, ensure_ascii=False)[:24000]}"
        )
    elif locale == "en":
        system = (
            "You are a ComfyUI / RunningHub workflow adapter assistant.\n"
            "The user provides a compact node list from a full canvas (UI) or API workflow.\n"
            "Output ONLY one valid JSON object. No Markdown, no comments, no trailing commas.\n"
            'Example:\n{"version":1,"name":"My I2V","provider":"comfyui","mode":"i2v","bindings":{"startImage":{"nodeId":"62","fieldName":"image"},"prompt":{"nodeId":"6","fieldName":"text"}},"params":[{"id":"prompt","type":"prompt","label":"Prompt","bind":"prompt","nodeId":"6","fieldName":"text","visibility":"shown"},{"id":"width","type":"number","label":"Width","bind":"width","nodeId":"63","fieldName":"width","default":720,"visibility":"collapsed"},{"id":"1776:value","type":"number","label":"Audio lip-sync start (sec)","bind":"","nodeId":"1776","fieldName":"value","default":0,"visibility":"shown"}]}\n'
            "Rules:\n"
            "- provider must match the user message exactly (runninghub or comfyui).\n"
            "- mode must match the user message (i2v, flf, or editor).\n"
            "- bindings keys only: startImage,endImage,inputVideo,inputAudio,prompt,negative,width,height,length,fps,seedHigh,seedLow,duration,refImage0..refImage8,refVideo0..refVideo2.\n"
            "- Prefer duration (seconds) for Duration controls (MiniMax); multi LoadImage → refImage0,refImage1,... in order.\n"
            "- Param type may be prompt,number,text,textarea,select,image,audio.\n"
            '- Each binding: {"nodeId":"...","fieldName":"..."}.\n'
            "- params: user-tunable fields; each needs id,type,label,bind,visibility (shown|collapsed|hidden), and MUST include nodeId+fieldName.\n"
            "- MUST also list PrimitiveFloat/PrimitiveInt/PrimitiveBoolean/PrimitiveString* with user-facing titles; use bind \"\" and id \"nodeId:fieldName\" when no semantic key fits.\n"
            "- Do NOT include workflow or workflowUi in output.\n"
            "- i2v: require startImage + prompt; video output; no inputAudio unless editor mode.\n"
            "- flf: require startImage + endImage + prompt.\n"
            "- editor: set input (image|video), output (image|video|audio), accepts, needsPrompt, needsAudio from bindings.\n"
            "- Prefer PrimitiveString* titled 提示词 for prompt (field value), not intermediate CLIPTextEncode.\n"
            "- Media/prompt/audio/custom Primitive*: visibility shown; size/fps: collapsed; seeds: hidden.\n"
            "- Only bind nodes present in the provided list (muted/bypass UI nodes are already omitted)."
        )
        user_msg = (
            f"provider={provider}\n"
            f"mode={mode}\n"
            f"workflowId={workflow_id or '(none)'}\n"
            f"Return bindings and params for mode={mode}. Do not echo full workflow.\n\n"
            f"nodes:\n{json.dumps(nodes_summary, ensure_ascii=False)[:80000]}"
        )
    else:
        system = (
            "你是 ComfyUI / RunningHub 工作流对接助手。\n"
            "用户会给出完整画布（UI）或 API 工作流的精简节点列表。\n"
            "请只输出一个合法 JSON 对象：不要 Markdown、不要注释、不要尾随逗号。\n"
            '示例：\n{"version":1,"name":"主段I2V","provider":"comfyui","mode":"i2v","bindings":{"startImage":{"nodeId":"62","fieldName":"image"},"prompt":{"nodeId":"6","fieldName":"text"}},"params":[{"id":"prompt","type":"prompt","label":"提示词","bind":"prompt","nodeId":"6","fieldName":"text","visibility":"shown"},{"id":"width","type":"number","label":"宽度","bind":"width","nodeId":"63","fieldName":"width","default":720,"visibility":"collapsed"},{"id":"1776:value","type":"number","label":"音频从几秒开始对口型","bind":"","nodeId":"1776","fieldName":"value","default":0,"visibility":"shown"}]}\n'
            "规则：\n"
            "- provider 必须与用户消息一致（runninghub 或 comfyui）。\n"
            "- mode 必须与用户消息一致（i2v / flf / editor）。\n"
            "- bindings 的 key 只能是: startImage,endImage,inputVideo,inputAudio,prompt,negative,width,height,length,fps,seedHigh,seedLow,duration,refImage0..refImage8,refVideo0..refVideo2。\n"
            "- 秒级时长绑 duration；多参考图按序绑 refImage0…；param type 可为 prompt/number/text/textarea/select/image/audio。\n"
            '- 每个 binding 为 {"nodeId":"...","fieldName":"..."}。\n'
            "- params 为可改值：含 id,type,label,bind,visibility（shown|collapsed|hidden），且每项必须含 nodeId、fieldName（便于与画布核对）。\n"
            "- 必须收录 PrimitiveFloat/PrimitiveInt/PrimitiveBoolean/PrimitiveString* 等带用户说明标题的控件（问号、例:、秒、对口型、strength 等）；无法映射语义 bind 时 bind 为空、id 用 nodeId:fieldName，勿跳过。\n"
            "- 不要输出 workflow / workflowUi。\n"
            "- i2v：必须 startImage + prompt；不要绑口播 inputAudio。\n"
            "- flf：必须 startImage + endImage + prompt。\n"
            "- editor：根据绑定推断 input/output/accepts/needsPrompt/needsAudio。\n"
            "- prompt 优先绑定标题含「提示词」的 PrimitiveString*（field 常为 value）。\n"
            "- 媒体/提示词/语音/自定义 Primitive*：visibility=shown；尺寸帧率：collapsed；种子：hidden。\n"
            "- 只绑定列表中已有的节点（禁用/BYPASS 节点不会出现在列表中）。"
        )
        user_msg = (
            f"provider={provider}\n"
            f"mode={mode}\n"
            f"workflowId={workflow_id or '(none)'}\n"
            f"Return bindings and params for mode={mode}. Do not echo full workflow.\n\n"
            f"nodes:\n{json.dumps(nodes_summary, ensure_ascii=False)[:80000]}"
        )
    content, err = _llm_chat_completion(
        api_key=api_key,
        base_url=base_url,
        model=model,
        system=system,
        user_msg=user_msg,
    )
    if err:
        return err
    text = (content or "").strip()
    text = text.lstrip("\ufeff")
    text = (
        text.replace("\u201c", '"')
        .replace("\u201d", '"')
        .replace("\u2018", "'")
        .replace("\u2019", "'")
    )
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.I)
    if fence:
        text = fence.group(1).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return _err(msg("err.llm_not_json"), 502)
    slice_text = text[start : end + 1]
    slice_text = re.sub(r",\s*([}\]])", r"\1", slice_text)
    slice_text = re.sub(
        r'"provider"\s*:\s*"(runninghub|comfyui)"\s*\|\s*"(runninghub|comfyui)"',
        r'"provider":"\1"',
        slice_text,
        flags=re.I,
    )
    try:
        draft = json.loads(slice_text)
    except json.JSONDecodeError as e:
        return _err(msg("err.adapter_parse_detail", detail=str(e)), 502)
    if not isinstance(draft, dict):
        return _err(msg("err.adapter_invalid"), 502)

    if mode == "extract":
        inputs = draft.get("i") if isinstance(draft.get("i"), list) else draft.get("inputs")
        if not isinstance(inputs, list):
            inputs = []
        draft["version"] = 1
        draft["v"] = 1
        draft["provider"] = provider
        draft["mode"] = "extract"
        draft["i"] = inputs
        draft["inputs"] = inputs
        return _ok({"draft": draft, "inputs": inputs, "raw": content})

    # Flatten legacy modes.* into top-level bindings if needed
    if not isinstance(draft.get("bindings"), dict):
        src_modes = draft.get("modes") if isinstance(draft.get("modes"), dict) else {}
        mval = src_modes.get(mode) if mode in src_modes else None
        if isinstance(mval, dict) and isinstance(mval.get("bindings"), dict):
            draft["bindings"] = mval["bindings"]
            if mval.get("params"):
                draft["params"] = mval["params"]
            if mval.get("workflowId"):
                draft["workflowId"] = mval["workflowId"]
    draft["version"] = 1
    draft["provider"] = provider
    draft["mode"] = mode
    if workflow_id and not draft.get("workflowId"):
        draft["workflowId"] = workflow_id
    return _ok({"draft": draft, "adapter": draft, "raw": content})


@app.post("/api/upload")
@login_required
def api_upload():
    if not config.is_official_instance():
        return _err(msg("err.platform_disabled"), 403)
    user = current_user()
    file = request.files.get("file")
    if not file or not file.filename:
        return _err(msg("err.image_required"))
    try:
        api_key = config.get_api_key()
    except (FileNotFoundError, ValueError) as e:
        return _err(str(e), 500)

    raw = file.read()
    if not raw:
        return _err(msg("err.upload_empty"))

    # Keep a local copy for preview / restore
    safe_name = secure_filename(file.filename) or "upload.bin"
    local_name = f"{uuid.uuid4().hex}_{safe_name}"
    (_user_media_dir(user["id"]) / local_name).write_bytes(raw)
    play = f"/media/{user['id']}/{local_name}"

    url = f"{config.API_BASE}/task/openapi/upload"
    data = {"apiKey": api_key, "fileType": "input"}
    files = {
        "file": (
            file.filename,
            raw,
            file.mimetype or "application/octet-stream",
        )
    }
    try:
        resp = _http.post(
            url,
            headers={"Host": "www.runninghub.ai", "Authorization": f"Bearer {api_key}"},
            data=data,
            files=files,
            timeout=120,
        )
        body = resp.json()
    except requests.RequestException as e:
        return _err(f"上传请求失败: {e}", 502)
    except ValueError:
        return _err(f"上传响应不是 JSON: {resp.text[:500]}", 502)

    if body.get("code") != 0:
        return _err(body.get("msg") or msg("err.upload_failed"), rh=body)

    file_name = (body.get("data") or {}).get("fileName")
    if not file_name:
        return _err(msg("err.upload_no_filename"), rh=body)

    project_id = None
    raw_project = (request.form.get("projectId") or request.args.get("projectId") or "").strip()
    if raw_project:
        try:
            pid = int(raw_project)
        except (TypeError, ValueError):
            return _err(msg("err.project_id_required"))
        project = db.get_project(config.DB_PATH, user["id"], pid)
        if not project:
            return _err(msg("err.project_not_found"), 404)
        project_id = pid

    media = db.insert_media_file(
        config.DB_PATH,
        user_id=user["id"],
        kind="upload",
        filename=local_name,
        play_path=play,
        project_id=project_id,
        rh_file_name=file_name,
        prompt_snapshot=safe_name,
        size=len(raw),
    )
    return _ok(
        {
            "fileName": file_name,
            "fileType": (body.get("data") or {}).get("fileType"),
            "mediaFileId": media["id"],
            "playUrl": play,
            "projectId": project_id,
        }
    )


@app.delete("/api/media_files/<int:media_id>")
@login_required
def api_delete_media_file(media_id):
    """Delete a media file if it is not referenced by any project."""
    user = current_user()
    deleted = db.delete_media_file_if_unused(config.DB_PATH, user["id"], media_id)
    if not deleted:
        return _err(msg("err.media_file_in_use_or_not_found"), 409)
    safe = Path(deleted.get("filename") or "").name
    if safe and _SAFE_NAME_RE.match(safe):
        path = _user_media_dir(user["id"]) / safe
        try:
            if path.is_file():
                path.unlink()
        except OSError:
            logging.warning("failed to unlink media file %s", path)
    return _ok({"deleted": True})


@app.get("/api/assets/<int:asset_id>/download")
@login_required
def api_assets_download(asset_id):
    """Authenticated attachment download. Never expose decoded/ via static alias."""
    user = current_user()
    asset = db.get_media_file_for_user(config.DB_PATH, user["id"], asset_id)
    if not asset:
        return _err(msg("err.asset_not_found"), 404)
    safe = Path(asset.get("filename") or "").name
    if not safe or not _SAFE_NAME_RE.match(safe):
        return _err(msg("err.invalid_filename"), 400)
    directory = _user_media_dir(user["id"])
    path = directory / safe
    if not path.is_file():
        return _err(msg("err.file_not_found"), 404)
    # Prefer stored filename for Content-Disposition; ASCII fallback for old clients.
    download_name = safe
    ascii_source = download_name.encode("ascii", errors="ignore").decode("ascii")
    ascii_name = re.sub(r"[^A-Za-z0-9.\-]+", "_", ascii_source) or "download.bin"
    resp = send_from_directory(
        directory,
        safe,
        as_attachment=True,
        download_name=download_name,
        max_age=0,
        conditional=True,
    )
    resp.headers["Content-Disposition"] = (
        f'attachment; filename="{ascii_name}"; '
        f"filename*=UTF-8''{quote(download_name)}"
    )
    resp.headers["Cache-Control"] = "private, no-store"
    return resp


@app.post("/api/decrypt")
@login_required
def api_decrypt():
    user = current_user()
    payload = request.get_json(silent=True) or {}
    url = (payload.get("url") or "").strip()
    password = payload.get("password") or ""
    if not url:
        return _err(msg("err.url_required"))
    try:
        result = materialize_output(
            url=url,
            password=password,
            user_id=user["id"],
            kind="i2v",
            prompt_snapshot="",
            use_duck=True,
        )
        return _ok(result)
    except requests.RequestException as e:
        return _err(f"下载失败: {e}", 502)
    except ValueError as e:
        return _err(str(e))
    except Exception as e:
        return _err(f"解密异常: {e}", 500)


@app.get("/media/<int:user_id>/<path:filename>")
@login_required
def media_file(user_id, filename):
    """Inline preview only. Downloads use /api/assets/<id>/download.
    Reverse proxies must forward this route to the app — never alias decoded/."""
    user = current_user()
    is_owner = int(user["id"]) == int(user_id)
    is_admin = bool(user.get("is_admin"))
    if not is_owner and not is_admin:
        return _err(msg("err.media_forbidden"), 403)
    safe = Path(filename).name
    if not _SAFE_NAME_RE.match(safe):
        return _err(msg("err.invalid_filename"), 400)
    directory = _user_media_dir(user_id)
    path = directory / safe
    if not path.is_file():
        return _err(msg("err.file_not_found"), 404)
    # Cache media so seeks/replays reuse bytes; templates keep SEND_FILE_MAX_AGE_DEFAULT=0.
    resp = send_from_directory(
        directory,
        safe,
        as_attachment=False,
        max_age=3600,
        conditional=True,
    )
    resp.headers["Accept-Ranges"] = "bytes"
    return resp


# Client often aborts Range requests when switching preview segments; do not 500.
@app.errorhandler(BrokenPipeError)
@app.errorhandler(ConnectionResetError)
@app.errorhandler(ConnectionAbortedError)
def _ignore_client_disconnect(exc):
    logging.debug("client disconnected during response: %s", exc)
    return ("", 204)


class _IgnoreClientDisconnectMiddleware:
    """Swallow client-abort I/O errors that occur while streaming media bodies."""

    def __init__(self, wsgi_app):
        self.wsgi_app = wsgi_app

    def __call__(self, environ, start_response):
        try:
            app_iter = self.wsgi_app(environ, start_response)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return []
        return _SafeAppIter(app_iter)


class _SafeAppIter:
    def __init__(self, app_iter):
        self.app_iter = app_iter

    def __iter__(self):
        try:
            for chunk in self.app_iter:
                yield chunk
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return

    def close(self):
        close = getattr(self.app_iter, "close", None)
        if close is not None:
            try:
                close()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass


_bootstrap_local_user()
_start_worker()

# Always reload templates/static when files change (even if DEBUG is off).
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.jinja_env.auto_reload = True
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
app.wsgi_app = _IgnoreClientDisconnectMiddleware(app.wsgi_app)


if __name__ == "__main__":
    import banner as _banner

    if _banner.should_print_banner(debug=bool(config.DEBUG)):
        _banner.print_startup_banner(
            [
                "本机地址  http://127.0.0.1:5000",
                "监听      http://0.0.0.0:5000",
            ]
        )
    app.run(host="0.0.0.0", port=5000, debug=config.DEBUG)
