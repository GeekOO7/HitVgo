"""Private project document schema (SQLite-backed).

Architecture decision
---------------------
- Source of truth: SQLite ``projects.payload_json`` (see ``config.DB_PATH``).
- Do NOT use ``data/projects/*.json`` (or any per-project files) as the source
  of truth. File landing would expose the full schema and user timelines.
- Do NOT add public project-bundle export/import HTTP APIs. Clients read/write
  only via authenticated project endpoints; workers patch segments in-place.

UI currently persists version 5 (tracks + layout fields). Server defaults stay
at version 3 for empty projects; ``normalize_project_payload`` shallow-merges
incoming dicts and keeps unknown keys (including v5 fields).

Future storyboard / LLM timeline integration should call
``apply_storyboard_to_payload`` (or a successor) on the server, then
``db.update_project`` — not write files and not accept raw platform blobs
from the model.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

# Server default document version (empty / newly created projects).
PAYLOAD_VERSION_DEFAULT = 3

# Version the browser ``collectDraftPayload`` writes today (v6 adds audios + muteAudio).
PAYLOAD_VERSION_UI = 6

# Top-level keys the UI may persist beyond the server default (v4/v5).
# Private boundary for future storyboard writers — not a public schema.
UI_PAYLOAD_EXTRA_KEYS = (
    "imageName",
    "imageType",
    "sharedStartPlayUrl",
    "sharedStartMediaId",
    "llmAutoBridge",
    "tracks",
    "scriptAssetId",
    "episodeId",
)

# Timeline container keys (always present after normalize).
TIMELINE_KEYS = ("tracks", "mains", "bridges", "edits", "audios")


def project_payload_default() -> Dict[str, Any]:
    """Canonical empty project payload stored in SQLite."""
    return {
        "version": PAYLOAD_VERSION_DEFAULT,
        "sharedStartRhName": None,
        "sharedStartAsset": None,
        "negative": "",
        "concurrency": "1",
        "password": "",
        "sceneDescription": "",
        "plotDirection": "",
        "segmentCount": "3",
        "llmPickCount": False,
        "vflowOrient": "landscape",
        "vflowWidth": "",
        "vflowHeight": "",
        "vflowLength": "",
        "vflowFps": "",
        "mains": [],
        "bridges": [],
        "edits": [],
        "savedAt": None,
        "scriptAssetId": None,
        "episodeId": None,
    }


def normalize_project_payload(
    payload: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    """Shallow-merge ``payload`` onto defaults; migrate legacy ``wf*`` keys.

    Does not strip unknown fields (UI v5 keys such as ``tracks`` are kept).
    """
    base = project_payload_default()
    if isinstance(payload, dict):
        merged = dict(payload)
        # Migrate legacy wf* draft keys → vflow*
        for new_key, old_key in (
            ("vflowOrient", "wfOrient"),
            ("vflowWidth", "wfWidth"),
            ("vflowHeight", "wfHeight"),
            ("vflowLength", "wfLength"),
        ):
            if merged.get(new_key) in (None, "") and old_key in merged:
                merged[new_key] = merged.get(old_key)
        base.update(merged)
    return base


def apply_storyboard_to_payload(
    payload: Optional[Dict[str, Any]],
    storyboard_result: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    """Map a storyboard / LLM intermediate result onto a project payload.

    Intended for a future storyboard-generator integration. Not wired to UI
    or LLM endpoints yet.

    Constraints (when implemented):
    - May replace or rebuild ``mains`` / ``bridges`` / ``tracks`` layout
      (ids, prompts, startSec, overlaps, etc.).
    - Must preserve existing media references where possible
      (``playUrl``, ``mediaFileId``, ``results``, shared-start fields) unless
      ``storyboard_result`` explicitly requests a reset.
    - Must not invent a file-based project format; caller persists via DB.
    - ``edits`` and non-timeline settings should be left alone unless the
      intermediate format says otherwise.

    Current behavior: ignore ``storyboard_result`` and return a normalized
    copy of ``payload`` (no-op placeholder).
    """
    # storyboard_result reserved for: shots[], durations, bridge flags, etc.
    _ = storyboard_result
    return normalize_project_payload(payload)
