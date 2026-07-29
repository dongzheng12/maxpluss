"""
Dedup 异步任务 store —— 跨 uvicorn worker 共享。

设计要点：
- SQLite WAL 模式做跨进程 job 队列（uvicorn --workers 2 共用一个 db 文件）
- 每个 worker 进程启动一个 daemon 线程持续 claim + 跑任务
- 文件 payload 写到 /tmp 目录（job_id.bin），DB 只存路径
- TTL 1 小时自动清理 db 行 + 落盘文件
- 容器重启即丢任务（store 在 /tmp，调用方需处理 'not_found'）
- 故障安全：worker thread 内任何异常都被 catch，不会让 daemon 退出

被 service.py 调用，仅给 /internal/jobs/* 端点用。
旧 /internal/extract-text 同步端点完全不依赖本模块。
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
import uuid
from typing import Any, Callable, Dict, Optional

log = logging.getLogger("dedup.jobs")

JOBS_DB_PATH = os.environ.get("BXZ_JOBS_DB_PATH", "/tmp/bxz_dedup_jobs.db")
JOBS_FILE_DIR = os.environ.get("BXZ_JOBS_FILE_DIR", "/tmp/bxz_dedup_jobs")
JOB_TTL_SECONDS = 3600
CLAIM_LOCK_SECONDS = 1800  # 单个 running job 最长持有 30 分钟，超过视为僵尸可被重新 claim

os.makedirs(JOBS_FILE_DIR, exist_ok=True)

_init_lock = threading.Lock()
_initialized = False
_processors: Dict[str, Callable[[dict], dict]] = {}
_worker_thread: Optional[threading.Thread] = None


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(JOBS_DB_PATH, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def _init_db() -> None:
    global _initialized
    with _init_lock:
        if _initialized:
            return
        with _connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL,
                    file_path TEXT,
                    meta TEXT,
                    result TEXT,
                    error TEXT,
                    error_code TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    claimed_at INTEGER
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_status_kind ON jobs(status, kind)")
        _initialized = True


def submit(kind: str, file_bytes: Optional[bytes], meta: dict) -> str:
    _init_db()
    job_id = uuid.uuid4().hex
    file_path = ""
    if file_bytes:
        file_path = os.path.join(JOBS_FILE_DIR, f"{job_id}.bin")
        with open(file_path, "wb") as f:
            f.write(file_bytes)
    now = int(time.time())
    with _connect() as conn:
        conn.execute(
            "INSERT INTO jobs (id, kind, status, file_path, meta, created_at, updated_at) "
            "VALUES (?, ?, 'pending', ?, ?, ?, ?)",
            (job_id, kind, file_path, json.dumps(meta or {}), now, now),
        )
    log.info(f"[jobs] submit {kind} job_id={job_id} file={'yes' if file_bytes else 'no'}")
    return job_id


def get(job_id: str) -> Optional[dict]:
    _init_db()
    with _connect() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if not row:
            return None
        return dict(row)


def _claim_one(kind: str) -> Optional[dict]:
    """原子领一条 pending 任务（或抢回 30 分钟以上的僵尸 running 任务）。"""
    _init_db()
    now = int(time.time())
    zombie_cutoff = now - CLAIM_LOCK_SECONDS
    with _connect() as conn:
        try:
            row = conn.execute(
                """
                UPDATE jobs SET status='running', updated_at=?, claimed_at=?
                WHERE id = (
                    SELECT id FROM jobs
                    WHERE kind = ?
                      AND (status = 'pending' OR (status = 'running' AND COALESCE(claimed_at, 0) < ?))
                    ORDER BY created_at LIMIT 1
                )
                RETURNING *
                """,
                (now, now, kind, zombie_cutoff),
            ).fetchone()
            return dict(row) if row else None
        except sqlite3.OperationalError as e:
            log.warning(f"[jobs] claim_one OperationalError: {e}")
            return None


def _mark_done(job_id: str, result: dict) -> None:
    now = int(time.time())
    with _connect() as conn:
        conn.execute(
            "UPDATE jobs SET status='done', result=?, updated_at=? WHERE id=?",
            (json.dumps(result), now, job_id),
        )


def _mark_failed(job_id: str, error: str, error_code: str = "SYSTEM_FAILURE") -> None:
    now = int(time.time())
    with _connect() as conn:
        conn.execute(
            "UPDATE jobs SET status='failed', error=?, error_code=?, updated_at=? WHERE id=?",
            (error, error_code, now, job_id),
        )


def _cleanup_expired() -> None:
    cutoff = int(time.time()) - JOB_TTL_SECONDS
    try:
        with _connect() as conn:
            rows = conn.execute(
                "SELECT id, file_path FROM jobs WHERE updated_at < ?",
                (cutoff,),
            ).fetchall()
            for r in rows:
                fp = r["file_path"]
                if fp and os.path.exists(fp):
                    try:
                        os.unlink(fp)
                    except Exception:
                        pass
            conn.execute("DELETE FROM jobs WHERE updated_at < ?", (cutoff,))
    except Exception as e:
        log.warning(f"[jobs] cleanup_expired failed: {e}")


def register_processor(kind: str, fn: Callable[[dict], dict]) -> None:
    _processors[kind] = fn


def _worker_loop() -> None:
    pid = os.getpid()
    log.info(f"[jobs] worker thread started in pid={pid}, processors={list(_processors.keys())}")
    last_cleanup = 0
    while True:
        try:
            now = int(time.time())
            if now - last_cleanup > 60:
                _cleanup_expired()
                last_cleanup = now

            picked_any = False
            for kind, fn in list(_processors.items()):
                job = _claim_one(kind)
                if not job:
                    continue
                picked_any = True
                job_id = job["id"]
                log.info(f"[jobs] pid={pid} pick {kind} {job_id}")
                try:
                    result = fn(job)
                    _mark_done(job_id, result)
                    log.info(f"[jobs] pid={pid} done {kind} {job_id}")
                except Exception as e:
                    log.error(f"[jobs] pid={pid} fail {kind} {job_id}: {e}", exc_info=True)
                    _mark_failed(job_id, str(e))
                finally:
                    fp = job.get("file_path")
                    if fp and os.path.exists(fp):
                        try:
                            os.unlink(fp)
                        except Exception:
                            pass

            if not picked_any:
                time.sleep(0.5)
        except Exception as e:
            log.error(f"[jobs] worker_loop unexpected error: {e}", exc_info=True)
            time.sleep(1.0)


def ensure_worker_started() -> None:
    """service.py 启动时调一次。重复调用幂等。"""
    global _worker_thread
    if _worker_thread is not None and _worker_thread.is_alive():
        return
    _init_db()
    _worker_thread = threading.Thread(
        target=_worker_loop,
        daemon=True,
        name="dedup-jobs-worker",
    )
    _worker_thread.start()
