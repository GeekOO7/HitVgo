import json
import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from project_schema import (
    normalize_project_payload,
    project_payload_default,
)

# Re-export for callers that historically imported from db.
# Project documents live only in SQLite projects.payload_json — see project_schema.


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(db_path):
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # Wait up to 5s on lock instead of failing under concurrent media/worker/poll.
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init_db(db_path):
    conn = connect(db_path)
    try:
        conn.executescript(
            """
            PRAGMA journal_mode=WAL;

            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                is_admin INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            -- Project timeline/config source of truth (not filesystem JSON).
            -- Shape: project_schema.project_payload_default / normalize_*.
            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                payload_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id)
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                project_id INTEGER NOT NULL,
                kind TEXT NOT NULL,
                ref_id TEXT NOT NULL,
                status TEXT NOT NULL,
                rh_task_id TEXT,
                request_json TEXT NOT NULL,
                result_json TEXT,
                error TEXT,
                seed_high TEXT,
                seed_low TEXT,
                canceled INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                submitted_at TEXT,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id),
                FOREIGN KEY(project_id) REFERENCES projects(id)
            );

            CREATE TABLE IF NOT EXISTS media_files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                task_id INTEGER,
                project_id INTEGER,
                kind TEXT NOT NULL,
                filename TEXT NOT NULL,
                play_path TEXT NOT NULL,
                thumb_path TEXT,
                prompt_snapshot TEXT,
                rh_file_name TEXT,
                size INTEGER,
                created_at TEXT NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id),
                FOREIGN KEY(task_id) REFERENCES tasks(id),
                FOREIGN KEY(project_id) REFERENCES projects(id)
            );

            CREATE INDEX IF NOT EXISTS idx_projects_user_updated
            ON projects(user_id, updated_at DESC);

            CREATE INDEX IF NOT EXISTS idx_tasks_status_created
            ON tasks(status, created_at);

            CREATE INDEX IF NOT EXISTS idx_tasks_user_status
            ON tasks(user_id, status, created_at);

            CREATE INDEX IF NOT EXISTS idx_media_user_created
            ON media_files(user_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS user_scripts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                format TEXT NOT NULL DEFAULT 'short',
                body_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id)
            );

            CREATE INDEX IF NOT EXISTS idx_user_scripts_user_updated
            ON user_scripts(user_id, updated_at DESC);
            """
        )
        conn.commit()
        _migrate_tasks_submitted_at_column(conn)
        _migrate_media_size_column(conn, db_path)
        _migrate_user_scripts_table(conn)
    finally:
        conn.close()


def _migrate_user_scripts_table(conn):
    """Create user_scripts if this DB predates the table."""
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='user_scripts'"
    ).fetchone()
    if row:
        return
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS user_scripts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            format TEXT NOT NULL DEFAULT 'short',
            body_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_user_scripts_user_updated
        ON user_scripts(user_id, updated_at DESC);
        """
    )
    conn.commit()


def _migrate_tasks_submitted_at_column(conn):
    """Add tasks.submitted_at if missing (set when remote API accepts the job)."""
    cols = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(tasks)").fetchall()
    }
    if "submitted_at" not in cols:
        conn.execute("ALTER TABLE tasks ADD COLUMN submitted_at TEXT")
        conn.commit()


def _migrate_media_size_column(conn, db_path):
    """Add media_files.size if missing and backfill from disk where possible."""
    cols = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(media_files)").fetchall()
    }
    if "size" not in cols:
        conn.execute("ALTER TABLE media_files ADD COLUMN size INTEGER")
        conn.commit()

    # Backfill NULL sizes from decoded/{user_id}/{filename}
    try:
        from config import BASE_DIR
    except Exception:
        return
    decoded_root = Path(BASE_DIR) / "decoded"
    rows = conn.execute(
        "SELECT id, user_id, filename, size FROM media_files WHERE size IS NULL OR size = 0"
    ).fetchall()
    for row in rows:
        path = decoded_root / str(row["user_id"]) / row["filename"]
        try:
            if path.is_file():
                sz = path.stat().st_size
                conn.execute(
                    "UPDATE media_files SET size = ? WHERE id = ?",
                    (sz, row["id"]),
                )
        except OSError:
            continue
    conn.commit()


def row_to_dict(row):
    if row is None:
        return None
    return {k: row[k] for k in row.keys()}


def parse_json(text: Optional[str], fallback):
    if not text:
        return fallback
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return fallback


def fetch_user_by_id(db_path, user_id: int):
    conn = connect(db_path)
    try:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return row_to_dict(row)
    finally:
        conn.close()


def fetch_user_by_username(db_path, username: str):
    conn = connect(db_path)
    try:
        row = conn.execute(
            "SELECT * FROM users WHERE username = ?",
            (username.strip(),),
        ).fetchone()
        return row_to_dict(row)
    finally:
        conn.close()


def create_user(db_path, username: str, password_hash: str, is_admin: bool = False):
    now = utc_now()
    conn = connect(db_path)
    try:
        cur = conn.execute(
            """
            INSERT INTO users (username, password_hash, is_admin, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (username.strip(), password_hash, 1 if is_admin else 0, now),
        )
        conn.commit()
        return fetch_user_by_id(db_path, cur.lastrowid)
    finally:
        conn.close()


def ensure_local_user(db_path):
    """Single implicit user for the standalone desktop build."""
    user = fetch_user_by_username(db_path, "local")
    if user:
        return user
    user = fetch_user_by_id(db_path, 1)
    if user:
        return user
    return create_user(db_path, "local", "local", is_admin=False)


def list_users(db_path) -> List[Dict[str, Any]]:
    """List all users with project/asset counts (no password_hash)."""
    conn = connect(db_path)
    try:
        rows = conn.execute(
            """
            SELECT
                u.id,
                u.username,
                u.is_admin,
                u.created_at,
                (SELECT COUNT(*) FROM projects p WHERE p.user_id = u.id) AS project_count,
                (SELECT COUNT(*) FROM media_files m WHERE m.user_id = u.id) AS asset_count
            FROM users u
            ORDER BY u.id ASC
            """
        ).fetchall()
        return [row_to_dict(r) for r in rows]
    finally:
        conn.close()


def count_admins(db_path) -> int:
    conn = connect(db_path)
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM users WHERE is_admin = 1"
        ).fetchone()
        return int(row["c"]) if row else 0
    finally:
        conn.close()


def update_user_password(db_path, user_id: int, password_hash: str) -> Optional[Dict[str, Any]]:
    conn = connect(db_path)
    try:
        cur = conn.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (password_hash, user_id),
        )
        conn.commit()
        if cur.rowcount == 0:
            return None
        return fetch_user_by_id(db_path, user_id)
    finally:
        conn.close()


def update_user_admin(db_path, user_id: int, is_admin: bool) -> Optional[Dict[str, Any]]:
    """Set is_admin. Raises ValueError if demoting the last admin."""
    user = fetch_user_by_id(db_path, user_id)
    if not user:
        return None
    currently_admin = bool(user.get("is_admin"))
    if currently_admin and not is_admin and count_admins(db_path) <= 1:
        raise ValueError("至少保留一名管理员")
    conn = connect(db_path)
    try:
        conn.execute(
            "UPDATE users SET is_admin = ? WHERE id = ?",
            (1 if is_admin else 0, user_id),
        )
        conn.commit()
        return fetch_user_by_id(db_path, user_id)
    finally:
        conn.close()


def delete_user(db_path, user_id: int) -> Optional[Dict[str, Any]]:
    """Cascade-delete user rows (tasks, media_files, projects, users).

    Returns the deleted user dict, or None if missing.
    Caller must remove decoded/{user_id}/ on disk.
    Raises ValueError if deleting the last admin.
    """
    user = fetch_user_by_id(db_path, user_id)
    if not user:
        return None
    if bool(user.get("is_admin")) and count_admins(db_path) <= 1:
        raise ValueError("至少保留一名管理员")
    conn = connect(db_path)
    try:
        conn.execute("DELETE FROM tasks WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM media_files WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM user_scripts WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM projects WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()
        return user
    finally:
        conn.close()


def get_media_file_by_id(db_path, media_id: int) -> Optional[Dict[str, Any]]:
    conn = connect(db_path)
    try:
        row = conn.execute(
            "SELECT * FROM media_files WHERE id = ?",
            (media_id,),
        ).fetchone()
        return row_to_dict(row)
    finally:
        conn.close()


def _normalize_project_payload(payload: Optional[Dict[str, Any]]):
    """Backward-compatible alias for project_schema.normalize_project_payload."""
    return normalize_project_payload(payload)


_SEQ_NAME_RES = (
    re.compile(r"^新建\s*(\d+)$"),
    re.compile(r"^[Nn]ew\s*(\d+)$"),
    re.compile(r"^项目\s*(\d+)$"),
    re.compile(r"^[Pp]roject\s*(\d+)$"),
)


def next_project_name(conn, user_id: int, name_template: Optional[str] = None) -> str:
    """Generate next sequential project name (新建N / New N / Project N).

    Scans existing names matching known patterns for max+1.
    name_template uses {n} placeholder (from i18n), default 新建{n}.
    """
    rows = conn.execute(
        "SELECT name FROM projects WHERE user_id = ?",
        (user_id,),
    ).fetchall()
    max_seq = 0
    for r in rows:
        name = (r["name"] or "").strip()
        for pat in _SEQ_NAME_RES:
            m = pat.match(name)
            if m:
                try:
                    max_seq = max(max_seq, int(m.group(1)))
                except ValueError:
                    pass
                break
    n = max_seq + 1
    tpl = (name_template or "新建{n}").strip() or "新建{n}"
    try:
        return tpl.format(n=n)
    except (KeyError, ValueError):
        return f"新建{n}"


def create_project(
    db_path,
    user_id: int,
    name: Optional[str] = None,
    payload: Optional[Dict[str, Any]] = None,
    name_template: Optional[str] = None,
):
    now = utc_now()
    conn = connect(db_path)
    try:
        clean_name = (name or "").strip()
        if not clean_name:
            clean_name = next_project_name(conn, user_id, name_template=name_template)
        cur = conn.execute(
            """
            INSERT INTO projects (user_id, name, payload_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                user_id,
                clean_name,
                json.dumps(_normalize_project_payload(payload), ensure_ascii=False),
                now,
                now,
            ),
        )
        conn.commit()
        return get_project(db_path, user_id, cur.lastrowid)
    finally:
        conn.close()


def list_projects(db_path, user_id: int) -> List[Dict[str, Any]]:
    conn = connect(db_path)
    try:
        rows = conn.execute(
            """
            SELECT id, name, created_at, updated_at
            FROM projects
            WHERE user_id = ?
            ORDER BY updated_at DESC, id DESC
            """,
            (user_id,),
        ).fetchall()
        return [row_to_dict(r) for r in rows]
    finally:
        conn.close()


def get_project(db_path, user_id: int, project_id: int):
    conn = connect(db_path)
    try:
        row = conn.execute(
            """
            SELECT *
            FROM projects
            WHERE id = ? AND user_id = ?
            """,
            (project_id, user_id),
        ).fetchone()
        if not row:
            return None
        data = row_to_dict(row)
        data["payload"] = parse_json(data.pop("payload_json"), project_payload_default())
        return data
    finally:
        conn.close()


def segment_slot_index(db_path, project_id: int, kind: str, ref_id: str) -> Optional[int]:
    """1-based slot index of ref_id within project mains/bridges/edits; None if missing."""
    conn = connect(db_path)
    try:
        row = conn.execute(
            "SELECT payload_json FROM projects WHERE id = ?",
            (project_id,),
        ).fetchone()
        if not row:
            return None
        payload = parse_json(row["payload_json"], project_payload_default())
        if kind == "main":
            key = "mains"
        elif kind == "bridge":
            key = "bridges"
        elif kind == "edit":
            key = "edits"
        else:
            return None
        items = payload.get(key) or []
        for i, item in enumerate(items):
            if item.get("id") == ref_id:
                return i + 1
        return None
    finally:
        conn.close()


def ensure_default_project(db_path, user_id: int):
    items = list_projects(db_path, user_id)
    if items:
        return get_project(db_path, user_id, items[0]["id"])
    return create_project(db_path, user_id, None, project_payload_default())


def update_project(
    db_path,
    user_id: int,
    project_id: int,
    *,
    name: Optional[str] = None,
    payload: Optional[Dict[str, Any]] = None,
):
    existing = get_project(db_path, user_id, project_id)
    if not existing:
        return None
    next_name = (name or existing["name"]).strip() or existing["name"]
    next_payload = (
        _normalize_project_payload(payload)
        if payload is not None
        else existing["payload"]
    )
    now = utc_now()
    conn = connect(db_path)
    try:
        conn.execute(
            """
            UPDATE projects
            SET name = ?, payload_json = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
            """,
            (
                next_name,
                json.dumps(next_payload, ensure_ascii=False),
                now,
                project_id,
                user_id,
            ),
        )
        conn.commit()
        return get_project(db_path, user_id, project_id)
    finally:
        conn.close()


def delete_project(db_path, user_id: int, project_id: int) -> List[Dict[str, Any]]:
    """Delete project, its tasks, and cloud media rows.

    Returns deleted media_files rows (for disk cleanup). Empty list if project
    was missing or not owned by user.
    """
    conn = connect(db_path)
    try:
        owned = conn.execute(
            "SELECT id FROM projects WHERE id = ? AND user_id = ?",
            (project_id, user_id),
        ).fetchone()
        if not owned:
            return []

        media_rows = conn.execute(
            "SELECT * FROM media_files WHERE user_id = ? AND project_id = ?",
            (user_id, project_id),
        ).fetchall()
        media = [row_to_dict(r) for r in media_rows]

        conn.execute(
            "DELETE FROM media_files WHERE user_id = ? AND project_id = ?",
            (user_id, project_id),
        )
        conn.execute(
            "DELETE FROM tasks WHERE user_id = ? AND project_id = ?",
            (user_id, project_id),
        )
        conn.execute(
            "DELETE FROM projects WHERE id = ? AND user_id = ?",
            (project_id, user_id),
        )
        _unbind_scripts_on_conn(conn, user_id, project_id)
        conn.commit()
        return media
    finally:
        conn.close()


def create_task(
    db_path,
    user_id: int,
    project_id: int,
    kind: str,
    ref_id: str,
    request_data: Dict[str, Any],
):
    now = utc_now()
    conn = connect(db_path)
    try:
        cur = conn.execute(
            """
            INSERT INTO tasks (
                user_id, project_id, kind, ref_id, status,
                request_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
            """,
            (
                user_id,
                project_id,
                kind,
                ref_id,
                json.dumps(request_data, ensure_ascii=False),
                now,
                now,
            ),
        )
        conn.commit()
        return get_task(db_path, cur.lastrowid)
    finally:
        conn.close()


def find_pending_task_for_ref(
    db_path,
    user_id: int,
    project_id: int,
    kind: str,
    ref_id: str,
):
    """Latest uncanceled pending cache row for the same segment ref."""
    conn = connect(db_path)
    try:
        row = conn.execute(
            """
            SELECT id
            FROM tasks
            WHERE user_id = ?
              AND project_id = ?
              AND kind = ?
              AND ref_id = ?
              AND status = 'pending'
              AND canceled = 0
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            """,
            (user_id, project_id, kind, ref_id),
        ).fetchone()
        if not row:
            return None
        return get_task(db_path, row["id"])
    finally:
        conn.close()


def upsert_pending_task(
    db_path,
    user_id: int,
    project_id: int,
    kind: str,
    ref_id: str,
    request_data: Dict[str, Any],
):
    """
    Cache-submit layer: if a pending row already exists for this ref, overwrite
    its request; otherwise insert a new pending task.
    Returns (task_dict, replaced: bool).
    """
    existing = find_pending_task_for_ref(
        db_path, user_id, project_id, kind, ref_id
    )
    if existing:
        now = utc_now()
        conn = connect(db_path)
        try:
            conn.execute(
                """
                UPDATE tasks
                SET request_json = ?,
                    error = NULL,
                    canceled = 0,
                    updated_at = ?
                WHERE id = ?
                  AND status = 'pending'
                  AND canceled = 0
                """,
                (
                    json.dumps(request_data, ensure_ascii=False),
                    now,
                    existing["id"],
                ),
            )
            conn.commit()
        finally:
            conn.close()
        task = get_task(db_path, existing["id"])
        if task and task.get("status") == "pending" and not task.get("canceled"):
            return task, True
        # Race: pending was promoted/canceled — fall through to insert
    task = create_task(db_path, user_id, project_id, kind, ref_id, request_data)
    return task, False


def count_user_queue_tasks(db_path, user_id: int) -> Dict[str, int]:
    """Counts for the current user's local cache + in-flight slots."""
    conn = connect(db_path)
    try:
        pending_row = conn.execute(
            """
            SELECT COUNT(*) AS n FROM tasks
            WHERE user_id = ? AND status = 'pending' AND canceled = 0
            """,
            (user_id,),
        ).fetchone()
        running_row = conn.execute(
            """
            SELECT COUNT(*) AS n FROM tasks
            WHERE user_id = ? AND status IN ('queued', 'running', 'finalizing')
            """,
            (user_id,),
        ).fetchone()
        return {
            "pendingCount": int(pending_row["n"] or 0),
            "runningCount": int(running_row["n"] or 0),
        }
    finally:
        conn.close()


def get_task(db_path, task_id: int):
    conn = connect(db_path)
    try:
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if not row:
            return None
        data = row_to_dict(row)
        data["request"] = parse_json(data.pop("request_json"), {})
        data["result"] = parse_json(data.pop("result_json"), None)
        return data
    finally:
        conn.close()


def list_tasks(
    db_path,
    user_id: int,
    *,
    active_only: bool = False,
    project_id: Optional[int] = None,
    limit: Optional[int] = None,
):
    params: List[Any] = [user_id]
    where = ["t.user_id = ?"]
    if active_only:
        where.append("t.status IN ('pending', 'queued', 'running', 'finalizing')")
    if project_id is not None:
        where.append("t.project_id = ?")
        params.append(project_id)
    limit_sql = ""
    if limit is not None and limit > 0:
        limit_sql = " LIMIT ?"
        params.append(int(limit))
    conn = connect(db_path)
    try:
        rows = conn.execute(
            f"""
            SELECT t.*, p.name AS project_name
            FROM tasks t
            LEFT JOIN projects p ON p.id = t.project_id
            WHERE {' AND '.join(where)}
            ORDER BY t.created_at DESC, t.id DESC
            {limit_sql}
            """,
            params,
        ).fetchall()
        items = []
        for row in rows:
            data = row_to_dict(row)
            data["request"] = parse_json(data.pop("request_json"), {})
            data["result"] = parse_json(data.pop("result_json"), None)
            items.append(data)
        return items
    finally:
        conn.close()


_ACTIVE_STATUSES = ("pending", "queued", "running", "finalizing")
_TERMINAL_STATUSES = ("success", "failed")
_KNOWN_STATUSES = set(_ACTIVE_STATUSES + _TERMINAL_STATUSES)


def _parse_task_time(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


def list_stale_active_tasks(db_path, stale_seconds: int):
    """Active rows whose updated_at is older than stale_seconds."""
    cutoff = datetime.now(timezone.utc).timestamp() - max(60, int(stale_seconds))
    conn = connect(db_path)
    try:
        rows = conn.execute(
            """
            SELECT *
            FROM tasks
            WHERE status IN ('pending', 'queued', 'running', 'finalizing')
            ORDER BY updated_at ASC, id ASC
            """
        ).fetchall()
        out = []
        for row in rows:
            data = row_to_dict(row)
            data["request"] = parse_json(data.pop("request_json"), {})
            data["result"] = parse_json(data.pop("result_json"), None)
            dt = _parse_task_time(data.get("updated_at") or data.get("created_at"))
            if dt is None or dt.timestamp() <= cutoff:
                out.append(data)
        return out
    finally:
        conn.close()


def list_invalid_status_tasks(db_path):
    """Rows whose status is outside the known lifecycle set (e.g. unknown)."""
    conn = connect(db_path)
    try:
        rows = conn.execute("SELECT * FROM tasks").fetchall()
        out = []
        for row in rows:
            data = row_to_dict(row)
            status = (data.get("status") or "").strip().lower()
            if status in _KNOWN_STATUSES:
                continue
            data["request"] = parse_json(data.pop("request_json"), {})
            data["result"] = parse_json(data.pop("result_json"), None)
            out.append(data)
        return out
    finally:
        conn.close()


def list_pending_tasks(db_path):
    conn = connect(db_path)
    try:
        rows = conn.execute(
            """
            SELECT *
            FROM tasks
            WHERE status = 'pending' AND canceled = 0
            ORDER BY created_at ASC, id ASC
            """
        ).fetchall()
        return [get_task(db_path, row["id"]) for row in rows]
    finally:
        conn.close()


def list_running_tasks(db_path):
    conn = connect(db_path)
    try:
        rows = conn.execute(
            """
            SELECT *
            FROM tasks
            WHERE status IN ('queued', 'running')
            ORDER BY updated_at ASC, id ASC
            """
        ).fetchall()
        return [get_task(db_path, row["id"]) for row in rows]
    finally:
        conn.close()


def count_running_tasks(db_path, user_id: Optional[int] = None) -> int:
    params = []
    sql = (
        "SELECT COUNT(*) AS n FROM tasks "
        "WHERE status IN ('queued', 'running', 'finalizing')"
    )
    if user_id is not None:
        sql += " AND user_id = ?"
        params.append(user_id)
    conn = connect(db_path)
    try:
        row = conn.execute(sql, params).fetchone()
        return int(row["n"] or 0)
    finally:
        conn.close()


def claim_task_for_finalize(db_path, task_id: int) -> bool:
    """Atomically claim a queued/running task for materialization.

    Returns True only for the winner. Prevents dual workers from both
    downloading and inserting duplicate media_files rows.
    """
    conn = connect(db_path)
    try:
        cur = conn.execute(
            """
            UPDATE tasks
            SET status = 'finalizing', updated_at = ?
            WHERE id = ?
              AND canceled = 0
              AND status IN ('queued', 'running')
            """,
            (utc_now(), int(task_id)),
        )
        conn.commit()
        return cur.rowcount == 1
    finally:
        conn.close()


def update_task(
    db_path,
    task_id: int,
    *,
    status: Optional[str] = None,
    rh_task_id: Optional[str] = None,
    result: Any = None,
    error: Optional[str] = None,
    seed_high: Optional[str] = None,
    seed_low: Optional[str] = None,
    canceled: Optional[bool] = None,
    submitted_at: Optional[str] = None,
):
    fields = []
    values: List[Any] = []
    if status is not None:
        fields.append("status = ?")
        values.append(status)
    if rh_task_id is not None:
        fields.append("rh_task_id = ?")
        values.append(rh_task_id)
    if result is not None:
        fields.append("result_json = ?")
        values.append(json.dumps(result, ensure_ascii=False))
    if error is not None:
        fields.append("error = ?")
        values.append(error)
    if seed_high is not None:
        fields.append("seed_high = ?")
        values.append(seed_high)
    if seed_low is not None:
        fields.append("seed_low = ?")
        values.append(seed_low)
    if canceled is not None:
        fields.append("canceled = ?")
        values.append(1 if canceled else 0)
    if submitted_at is not None:
        fields.append("submitted_at = ?")
        values.append(submitted_at)
    fields.append("updated_at = ?")
    values.append(utc_now())
    values.append(task_id)
    conn = connect(db_path)
    try:
        conn.execute(
            f"UPDATE tasks SET {', '.join(fields)} WHERE id = ?",
            values,
        )
        conn.commit()
        return get_task(db_path, task_id)
    finally:
        conn.close()


def update_project_payload(db_path, project_id: int, payload: Dict[str, Any]):
    now = utc_now()
    conn = connect(db_path)
    try:
        conn.execute(
            "UPDATE projects SET payload_json = ?, updated_at = ? WHERE id = ?",
            (json.dumps(_normalize_project_payload(payload), ensure_ascii=False), now, project_id),
        )
        conn.commit()
    finally:
        conn.close()


def patch_project_segment(
    db_path,
    project_id: int,
    kind: str,
    ref_id: str,
    updates: Dict[str, Any],
):
    conn = connect(db_path)
    try:
        row = conn.execute(
            "SELECT payload_json FROM projects WHERE id = ?",
            (project_id,),
        ).fetchone()
        if not row:
            return
        payload = parse_json(row["payload_json"], project_payload_default())
        if kind == "main":
            key = "mains"
        elif kind == "bridge":
            key = "bridges"
        elif kind == "edit":
            key = "edits"
        else:
            return
        changed = False
        for item in payload.get(key, []):
            if item.get("id") == ref_id:
                item.update(updates)
                changed = True
                break
        if changed:
            payload["savedAt"] = utc_now()
            if kind == "main" and updates.get("status") == "success":
                for bridge in payload.get("bridges", []):
                    if bridge.get("leftMainId") == ref_id or bridge.get("rightMainId") == ref_id:
                        bridge["needsReselect"] = True
                        if bridge.get("status") == "success":
                            bridge["label"] = "timeline.suggestReselect"
            conn.execute(
                "UPDATE projects SET payload_json = ?, updated_at = ? WHERE id = ?",
                (json.dumps(payload, ensure_ascii=False), utc_now(), project_id),
            )
            conn.commit()
    finally:
        conn.close()


def insert_media_file(
    db_path,
    *,
    user_id: int,
    kind: str,
    filename: str,
    play_path: str,
    task_id: Optional[int] = None,
    project_id: Optional[int] = None,
    thumb_path: Optional[str] = None,
    prompt_snapshot: Optional[str] = None,
    rh_file_name: Optional[str] = None,
    size: Optional[int] = None,
):
    now = utc_now()
    conn = connect(db_path)
    try:
        cur = conn.execute(
            """
            INSERT INTO media_files (
                user_id, task_id, project_id, kind, filename,
                play_path, thumb_path, prompt_snapshot, rh_file_name, created_at, size
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_id,
                task_id,
                project_id,
                kind,
                filename,
                play_path,
                thumb_path,
                prompt_snapshot,
                rh_file_name,
                now,
                int(size) if size is not None else None,
            ),
        )
        conn.commit()
        return get_media_file(db_path, cur.lastrowid)
    finally:
        conn.close()


def update_media_rh_file_name(db_path, media_id: int, rh_file_name: str):
    conn = connect(db_path)
    try:
        conn.execute(
            "UPDATE media_files SET rh_file_name = ? WHERE id = ?",
            (str(rh_file_name or "").strip() or None, int(media_id)),
        )
        conn.commit()
    finally:
        conn.close()


def get_media_file(db_path, media_id: int):
    conn = connect(db_path)
    try:
        row = conn.execute("SELECT * FROM media_files WHERE id = ?", (media_id,)).fetchone()
        return row_to_dict(row)
    finally:
        conn.close()


def list_media_files(db_path, user_id: int, *, include_uploads: bool = False):
    kinds = ("i2v", "flf", "edit", "upload", "audio")
    if not include_uploads:
        kinds = ("i2v", "flf", "edit", "audio")
    placeholders = ",".join("?" for _ in kinds)
    params = [user_id, *kinds]
    conn = connect(db_path)
    try:
        rows = conn.execute(
            f"""
            SELECT
                m.*,
                t.ref_id AS task_ref_id,
                t.kind AS task_segment_kind
            FROM media_files m
            LEFT JOIN tasks t ON t.id = m.task_id
            WHERE m.user_id = ? AND m.kind IN ({placeholders})
            ORDER BY m.created_at DESC, m.id DESC
            """,
            params,
        ).fetchall()
        return [row_to_dict(r) for r in rows]
    finally:
        conn.close()


def get_media_file_for_user(db_path, user_id: int, media_id: int):
    conn = connect(db_path)
    try:
        row = conn.execute(
            "SELECT * FROM media_files WHERE id = ? AND user_id = ?",
            (media_id, user_id),
        ).fetchone()
        return row_to_dict(row)
    finally:
        conn.close()


def get_user_storage_usage(decoded_root, user_id: int) -> int:
    """Sum byte size of all files under decoded/{user_id}/ (authoritative quota)."""
    root = Path(decoded_root) / str(user_id)
    if not root.is_dir():
        return 0
    total = 0
    try:
        for dirpath, _dirnames, filenames in os.walk(root):
            for name in filenames:
                try:
                    total += (Path(dirpath) / name).stat().st_size
                except OSError:
                    continue
    except OSError:
        return total
    return total


def delete_media_file_if_unused(db_path, user_id: int, media_id: int):
    """若 media_id 未被任何项目引用，则删除 DB 记录并返回已删除行；否则返回 None。"""
    refs = find_projects_referencing_media(db_path, user_id, media_id)
    if refs:
        return None
    existing = get_media_file_for_user(db_path, user_id, media_id)
    if not existing:
        return None
    conn = connect(db_path)
    try:
        conn.execute(
            "DELETE FROM media_files WHERE id = ? AND user_id = ?",
            (media_id, user_id),
        )
        conn.commit()
        return existing
    finally:
        conn.close()


def delete_media_file(db_path, user_id: int, media_id: int) -> Optional[Dict[str, Any]]:
    """Delete media_files row; returns the deleted row dict (for disk cleanup) or None."""
    existing = get_media_file_for_user(db_path, user_id, media_id)
    if not existing:
        return None
    conn = connect(db_path)
    try:
        conn.execute(
            "DELETE FROM media_files WHERE id = ? AND user_id = ?",
            (media_id, user_id),
        )
        conn.commit()
        return existing
    finally:
        conn.close()


def _media_id_matches(value, media_id: int) -> bool:
    if value is None:
        return False
    try:
        return int(value) == int(media_id)
    except (TypeError, ValueError):
        return False


def find_projects_referencing_media(
    db_path, user_id: int, media_id: int
) -> List[Dict[str, Any]]:
    """Return [{id, name, refs: [...]}] for projects that reference this media id."""
    conn = connect(db_path)
    try:
        rows = conn.execute(
            """
            SELECT id, name, payload_json
            FROM projects
            WHERE user_id = ?
            ORDER BY updated_at DESC, id DESC
            """,
            (user_id,),
        ).fetchall()
    finally:
        conn.close()

    results = []
    for row in rows:
        payload = parse_json(row["payload_json"], project_payload_default())
        refs = []
        if _media_id_matches(payload.get("sharedStartMediaId"), media_id):
            refs.append({"kind": "sharedStart", "label": "asset.sharedStart"})
        for m in payload.get("mains") or []:
            if _media_id_matches(m.get("mediaFileId"), media_id):
                refs.append(
                    {
                        "kind": "main",
                        "refId": m.get("id"),
                        "label": "asset.mainResult",
                    }
                )
        for b in payload.get("bridges") or []:
            if _media_id_matches(b.get("mediaFileId"), media_id):
                refs.append(
                    {
                        "kind": "bridge",
                        "refId": b.get("id"),
                        "label": "asset.bridgeResult",
                    }
                )
            sf = b.get("startFrame") or {}
            ef = b.get("endFrame") or {}
            if _media_id_matches(sf.get("mediaFileId"), media_id):
                refs.append(
                    {
                        "kind": "bridgeFrame",
                        "refId": b.get("id"),
                        "side": "start",
                        "label": "asset.bridgeStart",
                    }
                )
            if _media_id_matches(ef.get("mediaFileId"), media_id):
                refs.append(
                    {
                        "kind": "bridgeFrame",
                        "refId": b.get("id"),
                        "side": "end",
                        "label": "asset.bridgeEnd",
                    }
                )
        for ed in payload.get("edits") or []:
            if _media_id_matches(ed.get("mediaFileId"), media_id):
                refs.append(
                    {
                        "kind": "edit",
                        "refId": ed.get("id"),
                        "label": "asset.editResult",
                    }
                )
        if refs:
            results.append(
                {
                    "id": row["id"],
                    "name": row["name"],
                    "refs": refs,
                }
            )
    return results


def null_out_media_references(db_path, user_id: int, media_id: int) -> int:
    """Clear playUrl/mediaFileId (and frame refs) that point at media_id. Returns patched project count."""
    refs = find_projects_referencing_media(db_path, user_id, media_id)
    if not refs:
        return 0
    patched = 0
    for item in refs:
        project = get_project(db_path, user_id, item["id"])
        if not project:
            continue
        payload = project["payload"] or project_payload_default()
        changed = False
        if _media_id_matches(payload.get("sharedStartMediaId"), media_id):
            payload["sharedStartMediaId"] = None
            payload["sharedStartPlayUrl"] = None
            payload["sharedStartRhName"] = None
            changed = True
        for m in payload.get("mains") or []:
            if _media_id_matches(m.get("mediaFileId"), media_id):
                m["mediaFileId"] = None
                m["playUrl"] = None
                m["results"] = []
                m["dirty"] = True
                if m.get("status") == "success":
                    m["status"] = "pending"
                    m["label"] = "asset.resultDeleted"
                changed = True
        for b in payload.get("bridges") or []:
            if _media_id_matches(b.get("mediaFileId"), media_id):
                b["mediaFileId"] = None
                b["playUrl"] = None
                b["results"] = []
                b["dirty"] = True
                if b.get("status") == "success":
                    b["status"] = "pending"
                    b["label"] = "asset.resultDeleted"
                changed = True
            for side in ("startFrame", "endFrame"):
                frame = b.get(side)
                if isinstance(frame, dict) and _media_id_matches(
                    frame.get("mediaFileId"), media_id
                ):
                    b[side] = None
                    b["needsReselect"] = True
                    b["dirty"] = True
                    if b.get("status") != "running":
                        b["label"] = "timeline.suggestReselect"
                    changed = True
        for ed in payload.get("edits") or []:
            if _media_id_matches(ed.get("mediaFileId"), media_id):
                ed["mediaFileId"] = None
                ed["playUrl"] = None
                ed["results"] = []
                ed["dirty"] = True
                if ed.get("status") == "success":
                    ed["status"] = "pending"
                    ed["label"] = "asset.resultDeleted"
                changed = True
        if changed:
            payload["savedAt"] = utc_now()
            update_project_payload(db_path, item["id"], payload)
            patched += 1
    return patched


def delete_task(db_path, user_id: int, task_id: int) -> bool:
    """Delete a finished (success/failed) task belonging to user. Returns True if deleted."""
    task = get_task(db_path, task_id)
    if not task or int(task["user_id"]) != int(user_id):
        return False
    if task["status"] not in _TERMINAL_STATUSES:
        return False
    conn = connect(db_path)
    try:
        conn.execute(
            "DELETE FROM tasks WHERE id = ? AND user_id = ?",
            (task_id, user_id),
        )
        conn.commit()
        return True
    finally:
        conn.close()


def clear_finished_tasks(
    db_path, user_id: int, project_id: Optional[int] = None
) -> int:
    """Delete all success/failed tasks for user (optionally scoped to project)."""
    params: List[Any] = [user_id]
    sql = """
        DELETE FROM tasks
        WHERE user_id = ? AND status IN ('success', 'failed')
    """
    if project_id is not None:
        sql += " AND project_id = ?"
        params.append(int(project_id))
    conn = connect(db_path)
    try:
        cur = conn.execute(sql, params)
        conn.commit()
        return int(cur.rowcount or 0)
    finally:
        conn.close()


SCRIPT_EPISODE_MIN = 1
SCRIPT_EPISODE_MAX = 12


def _new_episode_id(index: int) -> str:
    return f"e{index}"


def empty_episode(index: int = 1) -> Dict[str, Any]:
    return {
        "id": _new_episode_id(index),
        "index": int(index),
        "title": "",
        "script": "",
        "beats": [],
        "boundProjectId": None,
    }


def normalize_script_body(
    body: Optional[Dict[str, Any]] = None,
    *,
    title: Optional[str] = None,
    format_name: Optional[str] = None,
) -> Dict[str, Any]:
    raw = dict(body) if isinstance(body, dict) else {}
    fmt = str(format_name or raw.get("format") or "short").strip().lower()
    if fmt not in ("short", "series"):
        fmt = "short"
    title_s = str(title if title is not None else raw.get("title") or "").strip()
    plot = str(raw.get("plotDirection") or raw.get("plot_direction") or "").strip()
    scene = str(raw.get("sceneBible") or raw.get("scene_bible") or "").strip()
    llm_pick = bool(raw.get("llmPickCount") or raw.get("llm_pick_count"))
    episodes_in = raw.get("episodes")
    episodes: List[Dict[str, Any]] = []
    if isinstance(episodes_in, list):
        for i, item in enumerate(episodes_in):
            if not isinstance(item, dict):
                continue
            idx = i + 1
            try:
                idx = int(item.get("index") or idx)
            except (TypeError, ValueError):
                idx = i + 1
            beats_raw = item.get("beats")
            beats = []
            if isinstance(beats_raw, list):
                for beat in beats_raw:
                    if isinstance(beat, dict):
                        beats.append(
                            {
                                "title": str(beat.get("title") or "").strip(),
                                "description": str(
                                    beat.get("description") or beat.get("text") or ""
                                ).strip(),
                            }
                        )
                    elif beat:
                        beats.append(
                            {"title": "", "description": str(beat).strip()}
                        )
            bound = item.get("boundProjectId")
            if bound is None:
                bound = item.get("bound_project_id")
            try:
                bound_id = int(bound) if bound not in (None, "", 0, "0") else None
            except (TypeError, ValueError):
                bound_id = None
            eid = str(item.get("id") or _new_episode_id(idx)).strip() or _new_episode_id(
                idx
            )
            episodes.append(
                {
                    "id": eid,
                    "index": idx,
                    "title": str(item.get("title") or "").strip(),
                    "script": str(item.get("script") or "").strip(),
                    "beats": beats,
                    "boundProjectId": bound_id,
                }
            )
    if fmt == "short":
        if not episodes:
            episodes = [empty_episode(1)]
        else:
            keep = dict(episodes[0])
            keep["index"] = 1
            keep["id"] = keep.get("id") or "e1"
            episodes = [keep]
    elif not episodes:
        episodes = [empty_episode(1)]
    if len(episodes) > SCRIPT_EPISODE_MAX:
        episodes = episodes[:SCRIPT_EPISODE_MAX]
    for i, ep in enumerate(episodes):
        ep["index"] = i + 1
        if not ep.get("id"):
            ep["id"] = _new_episode_id(i + 1)
    return {
        "title": title_s,
        "format": fmt,
        "plotDirection": plot,
        "sceneBible": scene,
        "llmPickCount": llm_pick,
        "episodes": episodes,
    }


def _serialize_script_row(row: Dict[str, Any], project_names: Optional[Dict[int, str]] = None):
    body = normalize_script_body(parse_json(row.get("body_json"), {}))
    names = project_names or {}
    episodes = []
    for ep in body["episodes"]:
        pid = ep.get("boundProjectId")
        item = dict(ep)
        if pid is not None and int(pid) in names:
            item["boundProjectName"] = names[int(pid)]
        elif pid is not None:
            item["boundProjectName"] = None
        else:
            item["boundProjectName"] = None
        episodes.append(item)
    return {
        "id": row["id"],
        "userId": row["user_id"],
        "title": body["title"] or str(row.get("title") or "").strip(),
        "format": body["format"],
        "plotDirection": body["plotDirection"],
        "sceneBible": body["sceneBible"],
        "llmPickCount": body["llmPickCount"],
        "episodes": episodes,
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
    }


def _project_name_map(conn, user_id: int) -> Dict[int, str]:
    rows = conn.execute(
        "SELECT id, name FROM projects WHERE user_id = ?",
        (user_id,),
    ).fetchall()
    return {int(r["id"]): str(r["name"] or "") for r in rows}


def list_user_scripts(db_path, user_id: int) -> List[Dict[str, Any]]:
    conn = connect(db_path)
    try:
        names = _project_name_map(conn, user_id)
        rows = conn.execute(
            """
            SELECT * FROM user_scripts
            WHERE user_id = ?
            ORDER BY updated_at DESC, id DESC
            """,
            (user_id,),
        ).fetchall()
        return [_serialize_script_row(row_to_dict(r), names) for r in rows]
    finally:
        conn.close()


def get_user_script(db_path, user_id: int, script_id: int) -> Optional[Dict[str, Any]]:
    conn = connect(db_path)
    try:
        row = conn.execute(
            "SELECT * FROM user_scripts WHERE id = ? AND user_id = ?",
            (script_id, user_id),
        ).fetchone()
        if not row:
            return None
        names = _project_name_map(conn, user_id)
        return _serialize_script_row(row_to_dict(row), names)
    finally:
        conn.close()


def create_user_script(
    db_path,
    user_id: int,
    body: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    now = utc_now()
    norm = normalize_script_body(body)
    title = norm["title"] or "未命名剧本"
    norm["title"] = title
    conn = connect(db_path)
    try:
        cur = conn.execute(
            """
            INSERT INTO user_scripts (user_id, title, format, body_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                user_id,
                title,
                norm["format"],
                json.dumps(norm, ensure_ascii=False),
                now,
                now,
            ),
        )
        conn.commit()
        script_id = cur.lastrowid
    finally:
        conn.close()
    return get_user_script(db_path, user_id, script_id)


def update_user_script(
    db_path,
    user_id: int,
    script_id: int,
    body: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    existing = get_user_script(db_path, user_id, script_id)
    if not existing:
        return None
    merged = {
        "title": existing["title"],
        "format": existing["format"],
        "plotDirection": existing["plotDirection"],
        "sceneBible": existing["sceneBible"],
        "llmPickCount": existing["llmPickCount"],
        "episodes": existing["episodes"],
    }
    if isinstance(body, dict):
        merged.update(body)
        if "episodes" not in body:
            merged["episodes"] = existing["episodes"]
    norm = normalize_script_body(merged)
    # Preserve bindings unless the incoming episodes explicitly include boundProjectId
    if isinstance(body, dict) and isinstance(body.get("episodes"), list):
        by_id = {ep["id"]: ep for ep in existing["episodes"]}
        for ep in norm["episodes"]:
            if ep.get("boundProjectId") is None and ep["id"] in by_id:
                incoming = None
                for raw in body["episodes"]:
                    if isinstance(raw, dict) and str(raw.get("id") or "") == ep["id"]:
                        incoming = raw
                        break
                if incoming is not None and (
                    "boundProjectId" in incoming or "bound_project_id" in incoming
                ):
                    continue
                ep["boundProjectId"] = by_id[ep["id"]].get("boundProjectId")
    else:
        by_id = {ep["id"]: ep for ep in existing["episodes"]}
        for ep in norm["episodes"]:
            if ep["id"] in by_id:
                ep["boundProjectId"] = by_id[ep["id"]].get("boundProjectId")
    title = norm["title"] or existing["title"] or "未命名剧本"
    norm["title"] = title
    now = utc_now()
    conn = connect(db_path)
    try:
        cur = conn.execute(
            """
            UPDATE user_scripts
            SET title = ?, format = ?, body_json = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
            """,
            (
                title,
                norm["format"],
                json.dumps(norm, ensure_ascii=False),
                now,
                script_id,
                user_id,
            ),
        )
        conn.commit()
        if cur.rowcount == 0:
            return None
    finally:
        conn.close()
    return get_user_script(db_path, user_id, script_id)


def delete_user_script(db_path, user_id: int, script_id: int) -> bool:
    conn = connect(db_path)
    try:
        cur = conn.execute(
            "DELETE FROM user_scripts WHERE id = ? AND user_id = ?",
            (script_id, user_id),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def _unbind_scripts_on_conn(conn, user_id: int, project_id: int) -> None:
    rows = conn.execute(
        "SELECT id, body_json FROM user_scripts WHERE user_id = ?",
        (user_id,),
    ).fetchall()
    now = utc_now()
    for row in rows:
        body = normalize_script_body(parse_json(row["body_json"], {}))
        changed = False
        for ep in body["episodes"]:
            if ep.get("boundProjectId") == int(project_id):
                ep["boundProjectId"] = None
                changed = True
        if changed:
            conn.execute(
                """
                UPDATE user_scripts
                SET body_json = ?, updated_at = ?
                WHERE id = ? AND user_id = ?
                """,
                (json.dumps(body, ensure_ascii=False), now, row["id"], user_id),
            )


def bind_script_episode(
    db_path,
    user_id: int,
    script_id: int,
    episode_id: str,
    project_id: int,
) -> Dict[str, Any]:
    """Bind one episode to a project (1:1). Raises ValueError on conflicts."""
    script = get_user_script(db_path, user_id, script_id)
    if not script:
        raise KeyError("script_not_found")
    project = get_project(db_path, user_id, project_id)
    if not project:
        raise KeyError("project_not_found")
    target = None
    for ep in script["episodes"]:
        if str(ep.get("id")) == str(episode_id):
            target = ep
            break
    if not target:
        raise KeyError("episode_not_found")
    bound = target.get("boundProjectId")
    if bound is not None and int(bound) != int(project_id):
        raise ValueError("episode_bound")
    # Unbind any other episode currently pointing at this project (this or other scripts)
    conn = connect(db_path)
    try:
        names = _project_name_map(conn, user_id)
        rows = conn.execute(
            "SELECT * FROM user_scripts WHERE user_id = ?",
            (user_id,),
        ).fetchall()
        now = utc_now()
        for row in rows:
            body = normalize_script_body(parse_json(row["body_json"], {}))
            changed = False
            for ep in body["episodes"]:
                if int(row["id"]) == int(script_id) and str(ep["id"]) == str(episode_id):
                    if ep.get("boundProjectId") != int(project_id):
                        ep["boundProjectId"] = int(project_id)
                        changed = True
                elif ep.get("boundProjectId") == int(project_id):
                    ep["boundProjectId"] = None
                    changed = True
            if changed:
                conn.execute(
                    """
                    UPDATE user_scripts
                    SET body_json = ?, updated_at = ?
                    WHERE id = ? AND user_id = ?
                    """,
                    (
                        json.dumps(body, ensure_ascii=False),
                        now,
                        row["id"],
                        user_id,
                    ),
                )
        conn.commit()
        _ = names
    finally:
        conn.close()
    payload = dict(project.get("payload") or {})
    payload["scriptAssetId"] = int(script_id)
    payload["episodeId"] = str(episode_id)
    update_project(db_path, user_id, project_id, payload=payload)
    return get_user_script(db_path, user_id, script_id)


def unbind_script_episode(
    db_path, user_id: int, script_id: int, episode_id: str, project_id: int
) -> Optional[Dict[str, Any]]:
    script = get_user_script(db_path, user_id, script_id)
    if not script:
        return None
    for ep in script["episodes"]:
        if str(ep.get("id")) == str(episode_id) and ep.get("boundProjectId") == int(
            project_id
        ):
            ep["boundProjectId"] = None
    return update_user_script(
        db_path,
        user_id,
        script_id,
        {
            "title": script["title"],
            "format": script["format"],
            "plotDirection": script["plotDirection"],
            "sceneBible": script["sceneBible"],
            "llmPickCount": script["llmPickCount"],
            "episodes": script["episodes"],
        },
    )
