"""RunningHub / ComfyUI runners for the local agent (server-side, no browser CORS)."""

from __future__ import annotations

import copy
import random
import re
import time
import uuid
from typing import Any, Dict, List, Optional, Set, Tuple

import requests

SEMANTIC_FIELDS = (
    "startImage",
    "endImage",
    "inputVideo",
    "inputAudio",
    "prompt",
    "negative",
    "width",
    "height",
    "length",
    "fps",
    "seedHigh",
    "seedLow",
    "duration",
    "refImage0",
    "refImage1",
    "refImage2",
    "refImage3",
    "refImage4",
    "refImage5",
    "refImage6",
    "refImage7",
    "refImage8",
    "refVideo0",
    "refVideo1",
    "refVideo2",
    "refAudio0",
    "refImage1Enable",
    "refImage2Enable",
    "refImage3Enable",
    "refVideo0Enable",
    "refVideoAudio0Enable",
    "refAudio0Enable",
)

SEED_INPUT_NAMES = frozenset({"noise_seed", "seed"})
VIDEO_SIZE_CLASS_RE = re.compile(
    r"MiniMaxH3(Image|Reference)ToVideo|WanImageToVideo|ImageToVideo",
    re.I,
)


def fresh_noise_seeds() -> Dict[str, str]:
    return {
        "seedHigh": str(random.randint(1, 2**63 - 1)),
        "seedLow": str(random.randint(1, 2**63 - 1)),
    }


def ensure_seed_values(values: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Fill missing seedHigh/seedLow so regenerations gacha instead of reusing workflow defaults."""
    vals = dict(values or {})
    fresh = fresh_noise_seeds()
    if vals.get("seedHigh") is None or vals.get("seedHigh") == "":
        vals["seedHigh"] = fresh["seedHigh"]
    if vals.get("seedLow") is None or vals.get("seedLow") == "":
        vals["seedLow"] = fresh["seedLow"]
    return vals


def _is_seed_field(name: str) -> bool:
    return str(name or "").strip() in SEED_INPUT_NAMES


def _is_link_input(val: Any) -> bool:
    return isinstance(val, (list, tuple)) and len(val) >= 2 and not isinstance(
        val, (str, bytes)
    )


def _explicit_param_seed_sigs(
    params: Optional[List[Dict[str, Any]]],
    param_values: Optional[Dict[str, Any]],
) -> Set[str]:
    """(nodeId:field) pairs the user explicitly set via paramValues (not baked defaults)."""
    covered: Set[str] = set()
    pv = param_values if isinstance(param_values, dict) else {}
    for item in params or []:
        if not isinstance(item, dict):
            continue
        param_id = str(item.get("id") or "")
        if not param_id or param_id not in pv:
            continue
        raw = pv.get(param_id)
        if raw is None or raw == "":
            continue
        node_id = str(item.get("nodeId") or "").strip()
        field_name = str(item.get("fieldName") or item.get("field") or "").strip()
        if node_id and field_name and _is_seed_field(field_name):
            covered.add(f"{node_id}:{field_name}")
    return covered


def _seed_binding_sigs(
    bindings: Optional[Dict[str, Any]], values: Optional[Dict[str, Any]]
) -> Set[str]:
    covered: Set[str] = set()
    vals = values or {}
    for key in ("seedHigh", "seedLow"):
        b = (bindings or {}).get(key)
        if not b or vals.get(key) is None or vals.get(key) == "":
            continue
        node_id = str(b.get("nodeId") or "").strip()
        field_name = str(b.get("fieldName") or "").strip()
        if node_id and field_name:
            covered.add(f"{node_id}:{field_name}")
    return covered


def randomize_unbound_seeds_in_graph(
    graph: Dict[str, Any],
    bindings: Optional[Dict[str, Any]] = None,
    values: Optional[Dict[str, Any]] = None,
    params: Optional[List[Dict[str, Any]]] = None,
    param_values: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Replace baked noise_seed/seed inputs not set by seed bindings or explicit user params."""
    covered = _seed_binding_sigs(bindings, values) | _explicit_param_seed_sigs(
        params, param_values
    )
    for node_id, node in (graph or {}).items():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for field_name, val in list(inputs.items()):
            if not _is_seed_field(field_name):
                continue
            if _is_link_input(val):
                continue
            sig = f"{node_id}:{field_name}"
            if sig in covered:
                continue
            inputs[field_name] = random.randint(1, 2**63 - 1)
    return graph


def _is_likely_dim(val: Any) -> bool:
    try:
        n = float(val)
    except (TypeError, ValueError):
        return False
    return 64 <= n <= 4096


def _is_likely_length(val: Any) -> bool:
    try:
        n = float(val)
    except (TypeError, ValueError):
        return False
    return 1 <= n <= 4000 and float(n) == int(n)


def _has_widget_slot(inp: Dict[str, Any]) -> bool:
    return bool(inp.get("widget"))


def _leftover_widget_names(
    node: Dict[str, Any], leftover: List[Any], used: Set[str]
) -> List[str]:
    if not leftover:
        return []
    props = node.get("properties") if isinstance(node.get("properties"), dict) else {}
    ue = props.get("widget_ue_connectable")
    if not isinstance(ue, dict):
        ue_props = props.get("ue_properties")
        if isinstance(ue_props, dict):
            ue = ue_props.get("widget_ue_connectable")
    if isinstance(ue, dict):
        from_ue = [k for k, v in ue.items() if v and k not in used]
        if len(from_ue) >= len(leftover):
            return from_ue[: len(leftover)]
    start = 0
    if isinstance(leftover[0], str) and len(str(leftover[0])) > 24:
        start = 1
    slice_vals = leftover[start:]
    inferred: List[str] = []
    if (
        len(slice_vals) >= 2
        and _is_likely_dim(slice_vals[0])
        and _is_likely_dim(slice_vals[1])
    ):
        for key in ("width", "height", "length"):
            if key in used or len(inferred) >= len(slice_vals):
                continue
            if key == "length" and (
                len(slice_vals) < 3 or not _is_likely_length(slice_vals[2])
            ):
                continue
            inferred.append(key)
    out: List[str] = []
    for i in range(len(leftover)):
        if i < start:
            out.append("widget_{0}".format(i))
            continue
        idx = i - start
        out.append(inferred[idx] if idx < len(inferred) else "widget_{0}".format(i))
    return out


def _param_seed_value(
    item: Dict[str, Any],
    values: Dict[str, Any],
    pv: Dict[str, Any],
) -> Any:
    """Resolve param value; for seed fields without explicit user value, gacha instead of default."""
    param_id = str(item.get("id") or "")
    field_name = str(item.get("fieldName") or item.get("field") or "").strip()
    val = pv.get(param_id) if param_id else None
    if val is not None and val != "":
        return val
    bind = str(item.get("bind") or "").strip()
    if bind and values.get(bind) not in (None, ""):
        return values.get(bind)
    fn = field_name.lower()
    if fn in ("width", "height", "length", "fps", "duration") and values.get(fn) not in (
        None,
        "",
    ):
        return values.get(fn)
    if fn == "frame_rate" and values.get("fps") not in (None, ""):
        return values.get("fps")
    if _is_seed_field(field_name):
        return random.randint(1, 2**63 - 1)
    if item.get("default") not in (None, ""):
        return item.get("default")
    return None


def _sanitize_api_field_name(field_name: str) -> str:
    """UI LoadImage exposes an upload button; RH/API only accept image."""
    fn = str(field_name or "").strip()
    if fn.lower() in ("upload", "choose file", "choose_file", "open"):
        return "image"
    return fn


def _collect_size_target_node_ids(
    bindings: Optional[Dict[str, Any]],
    params: Optional[List[Dict[str, Any]]],
    adapter_mode: Optional[Dict[str, Any]] = None,
    graph: Optional[Dict[str, Any]] = None,
) -> List[str]:
    ids: List[str] = []
    for key in ("width", "height"):
        b = (bindings or {}).get(key)
        if isinstance(b, dict) and b.get("nodeId"):
            ids.append(str(b.get("nodeId")))
    for item in params or []:
        if not isinstance(item, dict):
            continue
        fn = str(item.get("fieldName") or item.get("field") or "").strip().lower()
        bind = str(item.get("bind") or "").strip()
        if item.get("nodeId") and (
            fn in ("width", "height") or bind in ("width", "height")
        ):
            ids.append(str(item.get("nodeId")))
    resolved = graph
    if resolved is None and isinstance(adapter_mode, dict):
        wf = adapter_mode.get("workflow")
        wf_ui = adapter_mode.get("workflowUi")
        try:
            if isinstance(wf, dict) and wf:
                resolved = (
                    ui_workflow_to_api_prompt(wf) if is_comfy_ui_workflow(wf) else wf
                )
            elif isinstance(wf_ui, dict) and is_comfy_ui_workflow(wf_ui):
                resolved = ui_workflow_to_api_prompt(wf_ui)
        except Exception:
            resolved = None
    if isinstance(resolved, dict):
        for nid, node in resolved.items():
            if not isinstance(node, dict):
                continue
            ct = str(node.get("class_type") or "")
            inputs = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
            if VIDEO_SIZE_CLASS_RE.search(ct):
                ids.append(str(nid))
                continue
            w = inputs.get("width")
            h = inputs.get("height")
            if (
                w is not None
                and h is not None
                and not isinstance(w, (list, tuple))
                and not isinstance(h, (list, tuple))
            ):
                ids.append(str(nid))
    out: List[str] = []
    seen: Set[str] = set()
    for nid in ids:
        if nid and nid not in seen:
            seen.add(nid)
            out.append(nid)
    return out


def _node_accepts_wh(node: Optional[Dict[str, Any]], field: str) -> bool:
    if not isinstance(node, dict):
        return True
    ct = str(node.get("class_type") or "")
    if VIDEO_SIZE_CLASS_RE.search(ct):
        return True
    inputs = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
    val = inputs.get(field)
    return val is not None and not isinstance(val, (list, tuple))


def _inject_missing_size(
    out: List[Dict[str, str]],
    seen: Set[str],
    values: Dict[str, Any],
    bindings: Optional[Dict[str, Any]],
    params: Optional[List[Dict[str, Any]]],
    adapter_mode: Optional[Dict[str, Any]] = None,
) -> None:
    width = values.get("width")
    height = values.get("height")
    if width in (None, "") or height in (None, ""):
        return
    graph = None
    if isinstance(adapter_mode, dict):
        wf = adapter_mode.get("workflow")
        wf_ui = adapter_mode.get("workflowUi")
        try:
            if isinstance(wf, dict) and wf:
                graph = (
                    ui_workflow_to_api_prompt(wf) if is_comfy_ui_workflow(wf) else wf
                )
            elif isinstance(wf_ui, dict) and is_comfy_ui_workflow(wf_ui):
                graph = ui_workflow_to_api_prompt(wf_ui)
        except Exception:
            graph = None
    for nid in _collect_size_target_node_ids(bindings, params, adapter_mode, graph):
        node = graph.get(nid) if isinstance(graph, dict) else None
        for fn, val in (("width", width), ("height", height)):
            if node is not None and not _node_accepts_wh(node, fn):
                continue
            sig = f"{nid}:{fn}"
            if sig in seen:
                continue
            seen.add(sig)
            out.append(
                {
                    "nodeId": nid,
                    "fieldName": fn,
                    "fieldValue": str(val),
                }
            )


def apply_bindings_to_node_info_list(
    bindings: Dict[str, Any],
    values: Dict[str, Any],
    params: Optional[List[Dict[str, Any]]] = None,
    param_values: Optional[Dict[str, Any]] = None,
    adapter_mode: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, str]]:
    values = ensure_seed_values(values)
    out: List[Dict[str, str]] = []
    seen = set()
    for key in SEMANTIC_FIELDS:
        b = (bindings or {}).get(key)
        if not b or values.get(key) is None or values.get(key) == "":
            continue
        node_id = str(b.get("nodeId", ""))
        field_name = _sanitize_api_field_name(str(b.get("fieldName") or ""))
        sig = f"{node_id}:{field_name}"
        if sig in seen:
            continue
        seen.add(sig)
        out.append(
            {
                "nodeId": node_id,
                "fieldName": field_name,
                "fieldValue": str(values[key]),
            }
        )
    pv = param_values if isinstance(param_values, dict) else {}
    for item in params or []:
        if not isinstance(item, dict):
            continue
        node_id = str(item.get("nodeId") or "").strip()
        field_name = _sanitize_api_field_name(
            str(item.get("fieldName") or item.get("field") or "").strip()
        )
        if not node_id or not field_name:
            continue
        sig = f"{node_id}:{field_name}"
        if sig in seen:
            continue
        val = _param_seed_value(item, values, pv)
        if val is None or val == "":
            continue
        seen.add(sig)
        out.append(
            {
                "nodeId": node_id,
                "fieldName": field_name,
                "fieldValue": str(val),
            }
        )
    _inject_missing_size(out, seen, values, bindings, params, adapter_mode)
    return out


def is_comfy_ui_workflow(raw: Any) -> bool:
    if not isinstance(raw, dict):
        return False
    if isinstance(raw.get("nodes"), list) and isinstance(raw.get("links"), list):
        return True
    if "last_node_id" in raw and isinstance(raw.get("nodes"), list):
        return True
    return False


def ui_workflow_to_api_prompt(ui: Dict[str, Any]) -> Dict[str, Any]:
    """Convert ComfyUI canvas export (nodes/links) to API prompt map."""
    links = ui.get("links") or []
    link_map: Dict[Any, Dict[str, Any]] = {}
    for l in links:
        if not isinstance(l, (list, tuple)) or len(l) < 5:
            continue
        link_map[l[0]] = {
            "src": str(l[1]),
            "src_slot": l[2],
            "tgt": str(l[3]),
            "tgt_slot": l[4],
        }
    prompt: Dict[str, Any] = {}
    for node in ui.get("nodes") or []:
        if not isinstance(node, dict) or node.get("id") is None:
            continue
        node_id = str(node["id"])
        inputs: Dict[str, Any] = {}
        wvals = node.get("widgets_values") if isinstance(node.get("widgets_values"), list) else []
        w_idx = 0
        used: Set[str] = set()
        for inp in node.get("inputs") or []:
            if not isinstance(inp, dict):
                continue
            name = inp.get("name") or ((inp.get("widget") or {}).get("name"))
            if not name:
                continue
            if inp.get("link") is not None and inp.get("link") in link_map:
                lk = link_map[inp["link"]]
                inputs[name] = [lk["src"], lk["src_slot"]]
                used.add(str(name))
                if _has_widget_slot(inp) and w_idx < len(wvals):
                    w_idx += 1
                continue
            if not _has_widget_slot(inp):
                continue
            used.add(str(name))
            if w_idx < len(wvals):
                inputs[name] = wvals[w_idx]
                w_idx += 1
        leftover = wvals[w_idx:]
        leftover_names = _leftover_widget_names(node, leftover, used)
        for i, value in enumerate(leftover):
            name = leftover_names[i] if i < len(leftover_names) else "widget_{0}".format(w_idx + i)
            if name not in inputs:
                inputs[name] = value
        prompt[node_id] = {
            "class_type": node.get("type") or "Unknown",
            "inputs": inputs,
            "_meta": {"title": node.get("title") or ""},
        }
    if not prompt:
        raise RuntimeError("UI workflow convert produced empty prompt")
    return prompt


def resolve_comfy_workflow(adapter_mode: Dict[str, Any]) -> Dict[str, Any]:
    workflow = (adapter_mode or {}).get("workflow")
    if isinstance(workflow, dict) and workflow:
        if is_comfy_ui_workflow(workflow):
            return ui_workflow_to_api_prompt(workflow)
        return workflow
    workflow_ui = (adapter_mode or {}).get("workflowUi")
    if isinstance(workflow_ui, dict) and is_comfy_ui_workflow(workflow_ui):
        return ui_workflow_to_api_prompt(workflow_ui)
    raise RuntimeError("Comfy adapter needs bindings + workflow")


def apply_bindings_to_comfy_workflow(
    workflow: Dict[str, Any],
    bindings: Dict[str, Any],
    values: Dict[str, Any],
    params: Optional[List[Dict[str, Any]]] = None,
    param_values: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    values = ensure_seed_values(values)
    graph = copy.deepcopy(workflow or {})
    for key in SEMANTIC_FIELDS:
        b = (bindings or {}).get(key)
        if not b or values.get(key) is None or values.get(key) == "":
            continue
        node = graph.get(str(b.get("nodeId")))
        if not node:
            continue
        if "inputs" not in node or not isinstance(node["inputs"], dict):
            node["inputs"] = {}
        node["inputs"][_sanitize_api_field_name(str(b.get("fieldName") or ""))] = values[key]
    pv = param_values if isinstance(param_values, dict) else {}
    for item in params or []:
        if not isinstance(item, dict):
            continue
        node_id = str(item.get("nodeId") or "").strip()
        field_name = _sanitize_api_field_name(
            str(item.get("fieldName") or item.get("field") or "").strip()
        )
        if not node_id or not field_name:
            continue
        param_id = str(item.get("id") or "")
        val = _param_seed_value(item, values, pv)
        if val is None or val == "":
            continue
        node = graph.get(node_id)
        if not node:
            continue
        if "inputs" not in node or not isinstance(node["inputs"], dict):
            node["inputs"] = {}
        # Prefer semantic binding value already written for same target
        already = False
        for key in SEMANTIC_FIELDS:
            b = (bindings or {}).get(key)
            if (
                b
                and str(b.get("nodeId")) == node_id
                and _sanitize_api_field_name(str(b.get("fieldName") or "")) == field_name
                and values.get(key) not in (None, "")
            ):
                already = True
                break
        if already:
            continue
        node["inputs"][field_name] = val
    for nid in _collect_size_target_node_ids(bindings, params, graph=graph):
        node = graph.get(nid)
        if not isinstance(node, dict):
            continue
        if "inputs" not in node or not isinstance(node["inputs"], dict):
            node["inputs"] = {}
        width = values.get("width")
        height = values.get("height")
        if width not in (None, "") and _node_accepts_wh(node, "width"):
            node["inputs"]["width"] = width
        if height not in (None, "") and _node_accepts_wh(node, "height"):
            node["inputs"]["height"] = height
    return randomize_unbound_seeds_in_graph(
        graph, bindings, values, params, param_values
    )


def _rh_headers(api_key: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {api_key}"}


def rh_upload_image(
    base_url: str, api_key: str, file_bytes: bytes, filename: str
) -> str:
    url = f"{base_url.rstrip('/')}/task/openapi/upload"
    files = {"file": (filename or "image.png", file_bytes)}
    data = {"apiKey": api_key}
    resp = requests.post(url, headers=_rh_headers(api_key), data=data, files=files, timeout=120)
    json_body = {}
    try:
        json_body = resp.json()
    except Exception:
        pass
    if not resp.ok or (json_body.get("code") is not None and json_body.get("code") != 0):
        raise RuntimeError(
            json_body.get("msg")
            or json_body.get("message")
            or f"RH upload HTTP {resp.status_code}"
        )
    data_obj = json_body.get("data") or json_body
    name = (
        data_obj.get("fileName")
        or data_obj.get("file_name")
        or data_obj.get("filename")
    )
    if not name:
        raise RuntimeError("RH upload: no fileName")
    return str(name)


def rh_create_task(
    base_url: str, api_key: str, workflow_id: str, node_info_list: List[Dict[str, str]]
) -> str:
    url = f"{base_url.rstrip('/')}/task/openapi/create"
    payload = {
        "apiKey": api_key,
        "workflowId": workflow_id,
        "nodeInfoList": node_info_list,
    }
    resp = requests.post(
        url, headers={**_rh_headers(api_key), "Content-Type": "application/json"}, json=payload, timeout=60
    )
    json_body = {}
    try:
        json_body = resp.json()
    except Exception:
        pass
    if not resp.ok or json_body.get("code") != 0:
        raise RuntimeError(
            json_body.get("msg")
            or json_body.get("message")
            or f"RH create HTTP {resp.status_code}"
        )
    task_id = (json_body.get("data") or {}).get("taskId")
    if task_id is None:
        raise RuntimeError("RH create: no taskId")
    return str(task_id)


def rh_poll_once(
    base_url: str, api_key: str, task_id: str
) -> Dict[str, Any]:
    """Single RH outputs poll. status: QUEUED|RUNNING|SUCCESS|FAILED."""
    url = f"{base_url.rstrip('/')}/task/openapi/outputs"
    resp = requests.post(
        url,
        headers={**_rh_headers(api_key), "Content-Type": "application/json"},
        json={"apiKey": api_key, "taskId": task_id},
        timeout=60,
    )
    json_body: Dict[str, Any] = {}
    try:
        json_body = resp.json()
    except Exception:
        pass
    code = json_body.get("code")
    msg = str(json_body.get("msg") or json_body.get("message") or "")
    data = json_body.get("data")
    if code == 0 and isinstance(data, list) and data:
        file_url = (
            data[0].get("fileUrl")
            or data[0].get("url")
            or data[0].get("file_url")
            or ((data[0].get("files") or [None])[0])
        )
        if file_url:
            return {"status": "SUCCESS", "fileUrl": str(file_url), "error": None}
        return {"status": "RUNNING", "fileUrl": None, "error": None}
    if code == 813 or "QUEUE" in msg.upper() or "QUEUED" in msg.upper():
        return {"status": "QUEUED", "fileUrl": None, "error": None}
    if code == 804 or "RUNNING" in msg.upper():
        return {"status": "RUNNING", "fileUrl": None, "error": None}
    if code == 805 or "FAIL" in msg.upper() or "ERROR" in msg.upper():
        return {"status": "FAILED", "fileUrl": None, "error": msg or "RH task failed"}
    status = ""
    if isinstance(data, dict):
        status = str(data.get("taskStatus") or "")
    status_l = (status or msg).lower()
    if status_l and ("fail" in status_l or "error" in status_l):
        return {
            "status": "FAILED",
            "fileUrl": None,
            "error": msg or status or "RH task failed",
        }
    if code not in (0, 804, 813, None):
        return {
            "status": "FAILED",
            "fileUrl": None,
            "error": msg or f"RH error code {code}",
        }
    return {"status": "RUNNING", "fileUrl": None, "error": None}


def rh_poll_outputs(
    base_url: str, api_key: str, task_id: str, timeout_ms: int = 15 * 60 * 1000
) -> str:
    deadline = time.time() + timeout_ms / 1000.0
    while time.time() < deadline:
        once = rh_poll_once(base_url, api_key, task_id)
        status = once.get("status")
        if status == "SUCCESS" and once.get("fileUrl"):
            return str(once["fileUrl"])
        if status == "FAILED":
            raise RuntimeError(once.get("error") or "RH task failed")
        time.sleep(3)
    raise RuntimeError("RH poll timeout")


def download_bytes(url: str) -> bytes:
    resp = requests.get(url, timeout=300)
    if not resp.ok:
        raise RuntimeError(f"Download HTTP {resp.status_code}")
    return resp.content


def _prepare_rh_vals(
    *,
    base_url: str,
    api_key: str,
    adapter_mode: Dict[str, Any],
    values: Dict[str, Any],
    start_image: Optional[Tuple[bytes, str]],
    end_image: Optional[Tuple[bytes, str]],
    input_video: Optional[Tuple[bytes, str]] = None,
    input_audio: Optional[Tuple[bytes, str]] = None,
) -> Tuple[str, List[Dict[str, str]]]:
    bindings = (adapter_mode or {}).get("bindings") or {}
    workflow_id = str((adapter_mode or {}).get("workflowId") or "").strip()
    if not bindings:
        raise RuntimeError("Missing adapter bindings")
    if not workflow_id:
        raise RuntimeError("Missing workflowId")
    if not api_key:
        raise RuntimeError("Missing RunningHub API Key")

    vals = dict(values or {})
    vals = ensure_seed_values(vals)
    if start_image:
        vals["startImage"] = rh_upload_image(
            base_url, api_key, start_image[0], start_image[1] or "start.png"
        )
    if end_image:
        vals["endImage"] = rh_upload_image(
            base_url, api_key, end_image[0], end_image[1] or "end.png"
        )
    if input_video:
        vals["inputVideo"] = rh_upload_image(
            base_url, api_key, input_video[0], input_video[1] or "input.mp4"
        )
    if input_audio:
        vals["inputAudio"] = rh_upload_image(
            base_url, api_key, input_audio[0], input_audio[1] or "input.mp3"
        )
    if not vals.get("startImage") and not vals.get("inputVideo"):
        raise RuntimeError("Missing start image or input video")
    if bindings.get("inputAudio") and not vals.get("inputAudio"):
        raise RuntimeError("Missing input audio")

    params = (adapter_mode or {}).get("params") or []
    param_values = (values or {}).get("paramValues") if isinstance(values, dict) else None
    if not isinstance(param_values, dict):
        param_values = (adapter_mode or {}).get("paramValues") or {}
    node_info_list = apply_bindings_to_node_info_list(
        bindings, vals, params, param_values, adapter_mode
    )
    return workflow_id, node_info_list


def create_rh_remote_task(
    *,
    base_url: str,
    api_key: str,
    adapter_mode: Dict[str, Any],
    values: Dict[str, Any],
    start_image: Optional[Tuple[bytes, str]],
    end_image: Optional[Tuple[bytes, str]],
    input_video: Optional[Tuple[bytes, str]] = None,
    input_audio: Optional[Tuple[bytes, str]] = None,
) -> str:
    """Upload inputs and create RH task; return taskId without waiting for output."""
    workflow_id, node_info_list = _prepare_rh_vals(
        base_url=base_url,
        api_key=api_key,
        adapter_mode=adapter_mode,
        values=values,
        start_image=start_image,
        end_image=end_image,
        input_video=input_video,
        input_audio=input_audio,
    )
    return rh_create_task(base_url, api_key, workflow_id, node_info_list)


def run_rh_job(
    *,
    base_url: str,
    api_key: str,
    adapter_mode: Dict[str, Any],
    values: Dict[str, Any],
    start_image: Optional[Tuple[bytes, str]],
    end_image: Optional[Tuple[bytes, str]],
    input_video: Optional[Tuple[bytes, str]] = None,
    input_audio: Optional[Tuple[bytes, str]] = None,
) -> Tuple[bytes, str]:
    task_id = create_rh_remote_task(
        base_url=base_url,
        api_key=api_key,
        adapter_mode=adapter_mode,
        values=values,
        start_image=start_image,
        end_image=end_image,
        input_video=input_video,
        input_audio=input_audio,
    )
    file_url = rh_poll_outputs(base_url, api_key, task_id)
    return download_bytes(file_url), task_id


def _comfy_headers(auth_header: str) -> Dict[str, str]:
    h: Dict[str, str] = {}
    if auth_header:
        h["Authorization"] = auth_header
    return h


def comfy_upload_image(
    base_url: str, auth_header: str, file_bytes: bytes, filename: str
) -> str:
    url = f"{base_url.rstrip('/')}/upload/image"
    files = {"image": (filename or "image.png", file_bytes)}
    data = {"overwrite": "true"}
    resp = requests.post(
        url, headers=_comfy_headers(auth_header), data=data, files=files, timeout=120
    )
    json_body = {}
    try:
        json_body = resp.json()
    except Exception:
        pass
    if not resp.ok:
        raise RuntimeError(
            json_body.get("error") or f"Comfy upload HTTP {resp.status_code}"
        )
    name = json_body.get("name") or ((json_body.get("files") or [None])[0]) or filename
    return str(name)


def comfy_queue_prompt(
    base_url: str, auth_header: str, workflow: Dict[str, Any]
) -> str:
    url = f"{base_url.rstrip('/')}/prompt"
    client_id = f"cli_{uuid.uuid4().hex[:12]}"
    resp = requests.post(
        url,
        headers={**_comfy_headers(auth_header), "Content-Type": "application/json"},
        json={"prompt": workflow, "client_id": client_id},
        timeout=60,
    )
    json_body = {}
    try:
        json_body = resp.json()
    except Exception:
        pass
    if not resp.ok or json_body.get("error"):
        err = json_body.get("error")
        if isinstance(err, dict):
            msg = err.get("message") or str(err)
        else:
            msg = str(err or json_body) or f"Comfy prompt HTTP {resp.status_code}"
        raise RuntimeError(msg)
    prompt_id = json_body.get("prompt_id") or json_body.get("promptId")
    if not prompt_id:
        raise RuntimeError("Comfy: no prompt_id")
    return str(prompt_id)


def comfy_poll_once(
    base_url: str, auth_header: str, prompt_id: str
) -> Dict[str, Any]:
    """Single Comfy history poll. status: RUNNING|SUCCESS|FAILED."""
    hist_url = f"{base_url.rstrip('/')}/history/{prompt_id}"
    resp = requests.get(hist_url, headers=_comfy_headers(auth_header), timeout=60)
    if not resp.ok:
        return {"status": "RUNNING", "fileUrl": None, "error": None}
    try:
        json_body = resp.json()
    except Exception:
        return {"status": "RUNNING", "fileUrl": None, "error": None}
    entry = json_body.get(prompt_id)
    if not entry and isinstance(json_body, dict) and json_body:
        entry = next(iter(json_body.values()))
    if not entry:
        return {"status": "RUNNING", "fileUrl": None, "error": None}
    status_obj = entry.get("status") or {}
    if isinstance(status_obj, dict) and status_obj.get("status_str") == "error":
        msgs = status_obj.get("messages") or []
        return {
            "status": "FAILED",
            "fileUrl": None,
            "error": str(msgs or "Comfy task failed"),
        }
    if entry.get("outputs"):
        file_url = find_comfy_video_url(base_url, entry)
        if file_url:
            return {"status": "SUCCESS", "fileUrl": file_url, "error": None}
        return {
            "status": "FAILED",
            "fileUrl": None,
            "error": "Comfy: no video output",
        }
    return {"status": "RUNNING", "fileUrl": None, "error": None}


def comfy_wait_history(
    base_url: str, auth_header: str, prompt_id: str, timeout_ms: int = 15 * 60 * 1000
) -> Dict[str, Any]:
    deadline = time.time() + timeout_ms / 1000.0
    hist_url = f"{base_url.rstrip('/')}/history/{prompt_id}"
    while time.time() < deadline:
        once = comfy_poll_once(base_url, auth_header, prompt_id)
        if once.get("status") == "SUCCESS":
            # Re-fetch full entry for callers that need outputs
            resp = requests.get(hist_url, headers=_comfy_headers(auth_header), timeout=60)
            if resp.ok:
                json_body = resp.json()
                entry = json_body.get(prompt_id)
                if not entry and isinstance(json_body, dict) and json_body:
                    entry = next(iter(json_body.values()))
                if entry:
                    return entry
        if once.get("status") == "FAILED":
            raise RuntimeError(once.get("error") or "Comfy task failed")
        time.sleep(2)
    raise RuntimeError("Comfy poll timeout")


def find_comfy_video_url(base_url: str, history_entry: Dict[str, Any]) -> Optional[str]:
    outputs = (history_entry or {}).get("outputs") or {}
    for _node_id, o in outputs.items():
        videos = o.get("gifs") or o.get("videos") or o.get("images") or []
        for v in videos:
            if not v or not v.get("filename"):
                continue
            sub = ""
            if v.get("subfolder"):
                from urllib.parse import quote

                sub = f"&subfolder={quote(str(v['subfolder']))}"
            t = v.get("type") or "output"
            from urllib.parse import quote

            return (
                f"{base_url.rstrip('/')}/view?filename={quote(str(v['filename']))}"
                f"&type={quote(str(t))}{sub}"
            )
    return None


def _prepare_comfy_graph(
    *,
    base_url: str,
    auth_header: str,
    adapter_mode: Dict[str, Any],
    values: Dict[str, Any],
    start_image: Optional[Tuple[bytes, str]],
    end_image: Optional[Tuple[bytes, str]],
    input_video: Optional[Tuple[bytes, str]] = None,
    input_audio: Optional[Tuple[bytes, str]] = None,
) -> Dict[str, Any]:
    bindings = (adapter_mode or {}).get("bindings") or {}
    workflow = resolve_comfy_workflow(adapter_mode or {})
    if not bindings:
        raise RuntimeError("Comfy adapter needs bindings + workflow")

    vals = dict(values or {})
    vals = ensure_seed_values(vals)
    if start_image:
        vals["startImage"] = comfy_upload_image(
            base_url, auth_header, start_image[0], start_image[1] or "start.png"
        )
    if end_image:
        vals["endImage"] = comfy_upload_image(
            base_url, auth_header, end_image[0], end_image[1] or "end.png"
        )
    if input_video:
        vals["inputVideo"] = comfy_upload_image(
            base_url, auth_header, input_video[0], input_video[1] or "input.mp4"
        )
    if input_audio:
        vals["inputAudio"] = comfy_upload_image(
            base_url, auth_header, input_audio[0], input_audio[1] or "input.mp3"
        )
    if not vals.get("startImage") and not vals.get("inputVideo"):
        raise RuntimeError("Missing start image or input video")
    if bindings.get("inputAudio") and not vals.get("inputAudio"):
        raise RuntimeError("Missing input audio")

    params = (adapter_mode or {}).get("params") or []
    param_values = (values or {}).get("paramValues") if isinstance(values, dict) else None
    if not isinstance(param_values, dict):
        param_values = (adapter_mode or {}).get("paramValues") or {}
    return apply_bindings_to_comfy_workflow(
        workflow, bindings, vals, params, param_values
    )


def create_comfy_remote_task(
    *,
    base_url: str,
    auth_header: str,
    adapter_mode: Dict[str, Any],
    values: Dict[str, Any],
    start_image: Optional[Tuple[bytes, str]],
    end_image: Optional[Tuple[bytes, str]],
    input_video: Optional[Tuple[bytes, str]] = None,
    input_audio: Optional[Tuple[bytes, str]] = None,
) -> str:
    """Upload inputs and queue Comfy prompt; return prompt_id without waiting."""
    graph = _prepare_comfy_graph(
        base_url=base_url,
        auth_header=auth_header,
        adapter_mode=adapter_mode,
        values=values,
        start_image=start_image,
        end_image=end_image,
        input_video=input_video,
        input_audio=input_audio,
    )
    return comfy_queue_prompt(base_url, auth_header, graph)


def run_comfy_job(
    *,
    base_url: str,
    auth_header: str,
    adapter_mode: Dict[str, Any],
    values: Dict[str, Any],
    start_image: Optional[Tuple[bytes, str]],
    end_image: Optional[Tuple[bytes, str]],
    input_video: Optional[Tuple[bytes, str]] = None,
    input_audio: Optional[Tuple[bytes, str]] = None,
) -> Tuple[bytes, str]:
    prompt_id = create_comfy_remote_task(
        base_url=base_url,
        auth_header=auth_header,
        adapter_mode=adapter_mode,
        values=values,
        start_image=start_image,
        end_image=end_image,
        input_video=input_video,
        input_audio=input_audio,
    )
    hist = comfy_wait_history(base_url, auth_header, prompt_id)
    file_url = find_comfy_video_url(base_url, hist)
    if not file_url:
        raise RuntimeError("Comfy: no video output")
    return download_bytes(file_url), prompt_id
