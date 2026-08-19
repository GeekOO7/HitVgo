import logging
import threading
import time
from typing import Any, Callable, Dict

import config
import db


class TaskWorker(threading.Thread):
    def __init__(
        self,
        *,
        db_path,
        create_remote_task: Callable[[Dict[str, Any]], Dict[str, Any]],
        fetch_remote_outputs: Callable[[str], Dict[str, Any]],
        materialize_output: Callable[..., Dict[str, Any]],
    ):
        super().__init__(name="vflow-task-worker", daemon=True)
        self.db_path = db_path
        self.create_remote_task = create_remote_task
        self.fetch_remote_outputs = fetch_remote_outputs
        self.materialize_output = materialize_output
        self._stop_event = threading.Event()

    def stop(self):
        self._stop_event.set()

    def run(self):
        # Recover orphans left by process kill / unknown statuses before accepting work.
        try:
            self._reap_stale_and_invalid()
        except Exception:
            logging.exception("worker startup reap failed")
        while not self._stop_event.is_set():
            try:
                self._tick()
            except Exception:
                logging.exception("worker tick failed")
            self._stop_event.wait(config.WORKER_POLL_SECONDS)

    def _tick(self):
        self._reap_stale_and_invalid()
        self._start_pending_tasks()
        self._poll_running_tasks()

    def _reap_stale_and_invalid(self):
        stale_seconds = getattr(config, "JOB_STALE_SECONDS", 2700)
        for task in db.list_stale_active_tasks(self.db_path, stale_seconds):
            self._fail_task(
                task,
                f"task.timeout:{stale_seconds}",
            )
            logging.warning(
                "reaped stale task id=%s status=%s updated_at=%s",
                task.get("id"),
                task.get("status"),
                task.get("updated_at"),
            )
        for task in db.list_invalid_status_tasks(self.db_path):
            status = task.get("status") or "unknown"
            self._fail_task(
                task,
                f"task.bad_status:{status}",
            )
            logging.warning(
                "reaped invalid-status task id=%s status=%s",
                task.get("id"),
                status,
            )

    def _parse_concurrency(self, value, cap):
        try:
            n = int(str(value).strip())
        except (TypeError, ValueError, AttributeError):
            n = 1
        return max(1, min(n, cap))

    def _user_max_running_for_task(self, task):
        cap = config.PER_USER_MAX_RUNNING
        raw = None
        try:
            project = db.get_project(
                self.db_path, task["user_id"], task["project_id"]
            )
            payload = (project or {}).get("payload") or {}
            raw = payload.get("concurrency")
        except Exception:
            logging.debug("project concurrency lookup failed", exc_info=True)
        req = task.get("request") or {}
        candidates = []
        for value in (raw, req.get("concurrency")):
            if value not in (None, ""):
                candidates.append(self._parse_concurrency(value, cap))
        return max(candidates) if candidates else 1

    def _start_pending_tasks(self):
        pending = db.list_pending_tasks(self.db_path)
        for task in pending:
            if db.count_running_tasks(self.db_path) >= config.GLOBAL_MAX_RUNNING:
                break
            if (
                db.count_running_tasks(self.db_path, task["user_id"])
                >= self._user_max_running_for_task(task)
            ):
                continue
            # Re-check before remote submit (upsert/cancel race)
            fresh = db.get_task(self.db_path, task["id"])
            if (
                not fresh
                or fresh.get("status") != "pending"
                or fresh.get("canceled")
            ):
                continue
            req = fresh.get("request") or task.get("request") or {}
            try:
                created = self.create_remote_task(req, user_id=task["user_id"])
                task_id = str(created.get("taskId") or "").strip()
                if not task_id:
                    raise ValueError("task.no_id")
                db.update_task(
                    self.db_path,
                    task["id"],
                    status="running",
                    rh_task_id=task_id,
                    seed_high=str(created.get("seedHigh") or ""),
                    seed_low=str(created.get("seedLow") or ""),
                    submitted_at=db.utc_now(),
                    result={
                        "taskId": task_id,
                        "taskStatus": created.get("taskStatus"),
                        "playUrl": None,
                        "results": [],
                    },
                    error=None,
                )
                db.patch_project_segment(
                    self.db_path,
                    task["project_id"],
                    task["kind"],
                    task["ref_id"],
                    {
                        "status": "running",
                        "label": "task.submitted",
                        "taskId": task_id,
                        "seedHigh": str(created.get("seedHigh") or ""),
                        "seedLow": str(created.get("seedLow") or ""),
                        "meta": f"taskId {task_id} · seed {created.get('seedHigh') or ''}/{created.get('seedLow') or ''}",
                    },
                )
            except Exception as exc:
                self._fail_task(task, f"task.create_failed:{exc}")

    def _poll_running_tasks(self):
        running = db.list_running_tasks(self.db_path)
        for task in running:
            rh_task_id = (task.get("rh_task_id") or "").strip()
            if not rh_task_id:
                # Running/queued without remote id cannot progress — fail instead of hanging.
                self._fail_task(task, "task.missing_id")
                continue
            try:
                rh = self.fetch_remote_outputs(rh_task_id)
            except Exception as exc:
                logging.warning("poll task %s failed: %s", task["id"], exc)
                continue

            interp = rh.get("interp") or {}
            status = str(interp.get("status") or "RUNNING").upper()
            if interp.get("done") and status == "SUCCESS":
                self._complete_task(task, interp.get("urls") or [])
                continue
            if interp.get("done") and status == "FAILED":
                self._fail_task(task, interp.get("error") or "task.failed")
                continue

            # Only persist known active statuses; anything else would orphan the row.
            next_status = "queued" if status == "QUEUED" else "running"
            label = "task.queued" if next_status == "queued" else "task.running"
            db.update_task(
                self.db_path,
                task["id"],
                status=next_status,
                result={
                    "taskId": rh_task_id,
                    "rh": rh.get("rh"),
                    "results": [],
                    "playUrl": None,
                },
            )
            db.patch_project_segment(
                self.db_path,
                task["project_id"],
                task["kind"],
                task["ref_id"],
                {
                    "status": next_status,
                    "label": label,
                },
            )

    def _complete_task(self, task, urls):
        # Claim first so only one worker materializes (download can take seconds).
        if not db.claim_task_for_finalize(self.db_path, task["id"]):
            logging.info(
                "skip complete task id=%s — already claimed by another worker",
                task.get("id"),
            )
            return

        req = task["request"] or {}
        results = []
        first_play_url = None
        segment_kind = task.get("kind") or "main"
        project_id = task.get("project_id")
        slot_index = None
        if project_id and task.get("ref_id"):
            try:
                slot_index = db.segment_slot_index(
                    self.db_path,
                    int(project_id),
                    segment_kind,
                    task["ref_id"],
                )
            except Exception:
                logging.debug("slot index lookup failed", exc_info=True)
                slot_index = None

        for url in urls:
            media_kind = req.get("mode") or (
                "flf" if segment_kind == "bridge" else "i2v"
            )
            if media_kind == "t2i" or segment_kind == "t2i":
                media_kind = "upload"
            elif media_kind == "edit":
                media_kind = "edit"
            item = self.materialize_output(
                url=url,
                password=req.get("password") or "",
                user_id=task["user_id"],
                task_id=task["id"],
                project_id=task["project_id"],
                kind=media_kind,
                prompt_snapshot=req.get("prompt") or "",
                segment_kind=segment_kind if slot_index else None,
                slot_index=slot_index,
                use_duck=bool(req.get("useDuckEncrypt")),
            )
            results.append(item)
            play_url = item.get("playUrl")
            if play_url and not first_play_url:
                first_play_url = play_url

        if not first_play_url:
            self._fail_task(task, "task.no_playable")
            return

        db.update_task(
            self.db_path,
            task["id"],
            status="success",
            result={
                "taskId": task.get("rh_task_id"),
                "results": results,
                "playUrl": first_play_url,
            },
            error=None,
        )
        db.patch_project_segment(
            self.db_path,
            task["project_id"],
            task["kind"],
            task["ref_id"],
            {
                "status": "success",
                "label": "task.success",
                "results": results,
                "playUrl": first_play_url,
                "mediaFileId": (results[0].get("mediaFileId") if results else None),
                "dirty": False,
                "needsReselect": False,
            },
        )

    def _fail_task(self, task, message: str):
        db.update_task(
            self.db_path,
            task["id"],
            status="failed",
            error=message,
            result={"results": [{"error": message}], "playUrl": None},
        )
        db.patch_project_segment(
            self.db_path,
            task["project_id"],
            task["kind"],
            task["ref_id"],
            {
                "status": "failed",
                "label": "task.failed",
                "meta": message,
                "results": [{"error": message}],
            },
        )
