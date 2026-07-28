"""Persistent queue of scheduled vehicle actions.

Deliberately generic: a *group* is one thing the user asked for ("run climate
for 10 minutes"), made of one or more *jobs* (start now, stop at T+10). The
UI and the LLM talk in groups; the runner executes jobs. Charging schedules,
navigation, and periodic data logging can reuse this without schema changes.

Why SQLite rather than an in-process asyncio task: this deploys several times
a day, and every deploy recreates the api container. An in-memory timer would
silently vanish mid-flight — and the job that vanishes is the one that turns
climate *off*, which on this car is the only reliable stop (its own remote
climate auto-off is firmware-dependent: owners report anywhere from 30 min to
"runs until the battery hits 20%"). Overdue jobs therefore fire immediately on
startup rather than being skipped.
"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import time
from typing import Any

import aiosqlite

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "scheduled_actions.db")

POLL_INTERVAL_S = 5
# A failed stop_climate is the expensive failure (battery drain), so jobs get
# a few retries before being given up on rather than dying on one hiccup.
MAX_ATTEMPTS = 4
RETRY_BACKOFF_S = 30
# Finished groups linger briefly so the sidebar can show what just happened.
FINISHED_RETENTION_S = 24 * 3600

_write_lock = asyncio.Lock()


async def init_db() -> None:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                meta TEXT NOT NULL,
                action TEXT NOT NULL,
                params TEXT NOT NULL,
                run_at REAL NOT NULL,
                status TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                created_at REAL NOT NULL
            )
            """
        )
        await db.execute("CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs (status, run_at)")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_jobs_group ON jobs (group_id)")
        await db.commit()


def new_group_id() -> str:
    """Short enough that the assistant can repeat it back in chat to cancel."""
    return secrets.token_hex(3)


async def schedule_group(
    kind: str,
    meta: dict[str, Any],
    jobs: list[tuple[str, dict[str, Any], float]],
) -> str:
    """Persist one user-visible action. `jobs` is [(action, params, run_at)],
    where action is a tool name understood by app.tools.dispatch."""
    await init_db()
    group_id = new_group_id()
    now = time.time()
    async with _write_lock:
        async with aiosqlite.connect(DB_PATH) as db:
            for action, params, run_at in jobs:
                await db.execute(
                    """
                    INSERT INTO jobs
                        (group_id, kind, meta, action, params, run_at, status, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
                    """,
                    (
                        group_id,
                        kind,
                        json.dumps(meta),
                        action,
                        json.dumps(params),
                        run_at,
                        now,
                    ),
                )
            await db.commit()
    return group_id


def _group_state(rows: list[dict[str, Any]], meta: dict[str, Any]) -> str:
    """Collapse a group's jobs into the one word the UI shows.

    'running' means the action is already in effect and something is still
    queued to end it — e.g. climate is physically on and will be switched off
    later. That covers two shapes: the opening job ran from the queue, and
    the caller performed it inline before queueing only the closing job
    (meta.started — see actions.schedule_climate, which starts immediately so
    the user gets real errors rather than a hollow "scheduled").
    """
    statuses = [r["status"] for r in rows]
    if any(s == "cancelled" for s in statuses):
        return "cancelled"
    if any(s == "failed" for s in statuses):
        return "failed"
    if all(s == "done" for s in statuses):
        return "done"
    if any(s == "done" for s in statuses) or meta.get("started"):
        return "running"
    return "scheduled"


async def list_groups(include_finished: bool = True) -> list[dict[str, Any]]:
    await init_db()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM jobs ORDER BY run_at ASC"
        ) as cursor:
            rows = [dict(r) for r in await cursor.fetchall()]

    groups: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        groups.setdefault(row["group_id"], []).append(row)

    out: list[dict[str, Any]] = []
    for group_id, members in groups.items():
        meta = json.loads(members[0]["meta"])
        state = _group_state(members, meta)
        if not include_finished and state in ("done", "failed", "cancelled"):
            continue
        pending = [m for m in members if m["status"] == "pending"]
        errors = [m["error"] for m in members if m["error"]]
        out.append(
            {
                "id": group_id,
                "kind": members[0]["kind"],
                # Structured, not a rendered sentence — the app formats it in
                # whichever language the user picked (see mobile/src/i18n.ts).
                "meta": meta,
                "state": state,
                "created_at": members[0]["created_at"],
                "starts_at": min(m["run_at"] for m in members),
                "ends_at": max(m["run_at"] for m in members),
                "next_run_at": min((m["run_at"] for m in pending), default=None),
                "cancellable": bool(pending),
                "error": errors[0] if errors else None,
            }
        )
    out.sort(key=lambda g: g["created_at"], reverse=True)
    return out


async def cancel_group(group_id: str) -> bool:
    """Cancels every job in the group that hasn't run yet. Returns False if
    there was nothing left to cancel (already finished, or unknown id)."""
    await init_db()
    async with _write_lock:
        async with aiosqlite.connect(DB_PATH) as db:
            cursor = await db.execute(
                "UPDATE jobs SET status = 'cancelled' WHERE group_id = ? AND status = 'pending'",
                (group_id,),
            )
            await db.commit()
            return cursor.rowcount > 0


async def _claim_due_jobs() -> list[dict[str, Any]]:
    now = time.time()
    async with _write_lock:
        async with aiosqlite.connect(DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at ASC",
                (now,),
            ) as cursor:
                return [dict(r) for r in await cursor.fetchall()]


async def _finish_job(job_id: int, status: str, error: str | None = None) -> None:
    async with _write_lock:
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                "UPDATE jobs SET status = ?, error = ? WHERE id = ?",
                (status, error, job_id),
            )
            await db.commit()


async def _defer_job(job_id: int, attempts: int, error: str) -> None:
    async with _write_lock:
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                "UPDATE jobs SET attempts = ?, run_at = ?, error = ? WHERE id = ?",
                (attempts, time.time() + RETRY_BACKOFF_S, error, job_id),
            )
            await db.commit()


async def _purge_old() -> None:
    cutoff = time.time() - FINISHED_RETENTION_S
    async with _write_lock:
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                "DELETE FROM jobs WHERE status != 'pending' AND created_at < ?",
                (cutoff,),
            )
            await db.commit()


async def run_due_jobs(adapter: Any) -> None:
    """One pass of the runner. Separated from the loop so tests can drive it
    directly without waiting on wall-clock time."""
    from app.tools import dispatch  # imported here to avoid a circular import

    for job in await _claim_due_jobs():
        try:
            await dispatch(adapter, job["action"], json.loads(job["params"]))
        except Exception as e:
            attempts = job["attempts"] + 1
            if attempts >= MAX_ATTEMPTS:
                await _finish_job(job["id"], "failed", str(e))
            else:
                await _defer_job(job["id"], attempts, str(e))
            continue
        await _finish_job(job["id"], "done")


async def runner_loop(adapter: Any) -> None:
    """Background task started at app startup (see main.py's lifespan)."""
    await init_db()
    while True:
        try:
            await run_due_jobs(adapter)
            await _purge_old()
        except asyncio.CancelledError:
            raise
        except Exception:
            # Never let one bad pass kill the loop — the pending stop_climate
            # job it would strand is exactly what this module exists to
            # guarantee.
            pass
        await asyncio.sleep(POLL_INTERVAL_S)
