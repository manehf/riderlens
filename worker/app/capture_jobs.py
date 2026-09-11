"""Persistent, single-dispatch capture queue for one worker machine.

The caller stages inputs under ``queue.upload_dir`` and the injected handler
must persist the result before returning. SQLite state and inputs must share a
persistent volume in production (RIDERLENS_JOB_DIR=/data/jobs). A process lock
prevents two dispatchers recovering/running the same jobs in that directory.
This is a single-machine queue, not a distributed queue.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import threading
import time
from typing import Any, Callable, Iterator


logger = logging.getLogger("uvicorn.error")
REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{8,160}$")
TERMINAL_TTL_SECONDS = 45 * 60
PENDING_TTL_SECONDS = 24 * 60 * 60


class InvalidJobId(ValueError):
    pass


class JobConflict(ValueError):
    pass


class QueueFull(RuntimeError):
    pass


class JobProcessingError(RuntimeError):
    def __init__(self, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


@dataclass(frozen=True)
class CaptureJob:
    request_id: str
    upload_path: Path
    parameters: dict[str, Any]
    status: str
    error: str | None
    retryable: bool
    created_at: float
    updated_at: float


class CaptureJobQueue:
    def __init__(
        self,
        directory: Path | str | None,
        handler: Callable[[CaptureJob], None],
        *,
        max_jobs: int = 4,
        acquire_slot: Callable[[], bool] | None = None,
        release_slot: Callable[[], None] | None = None,
        terminal_ttl_seconds: float = TERMINAL_TTL_SECONDS,
        pending_ttl_seconds: float = PENDING_TTL_SECONDS,
        poll_interval: float = 0.25,
    ):
        if max_jobs < 1 or min(terminal_ttl_seconds, pending_ttl_seconds, poll_interval) <= 0:
            raise ValueError("Queue limits must be positive.")
        if (acquire_slot is None) != (release_slot is None):
            raise ValueError("Provide both slot callbacks or neither.")
        self.directory = Path(directory or os.getenv("RIDERLENS_JOB_DIR") or (
            Path(tempfile.gettempdir()) / "riderlens-jobs"
        )).resolve()
        self.upload_dir = self.directory / "uploads"
        self.upload_dir.mkdir(parents=True, exist_ok=True)
        self.database_path = self.directory / "jobs.sqlite3"
        self.handler = handler
        self.max_jobs = max_jobs
        self.acquire_slot = acquire_slot or (lambda: True)
        self.release_slot = release_slot or (lambda: None)
        self.terminal_ttl_seconds = terminal_ttl_seconds
        self.pending_ttl_seconds = pending_ttl_seconds
        self.poll_interval = poll_interval
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._lifecycle_lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._owner_file = None
        self._next_cleanup_at = 0.0
        with self._connection() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("""
                CREATE TABLE IF NOT EXISTS capture_jobs (
                    request_id TEXT PRIMARY KEY,
                    upload_path TEXT NOT NULL,
                    parameters TEXT NOT NULL,
                    fingerprint TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('queued','processing','ready','failed')),
                    error TEXT,
                    retryable INTEGER NOT NULL DEFAULT 0,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                )
            """)
            connection.execute("CREATE INDEX IF NOT EXISTS capture_jobs_status ON capture_jobs(status, created_at)")

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.database_path, timeout=10, isolation_level=None)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
        finally:
            connection.close()

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                yield connection
                connection.commit()
            except BaseException:
                connection.rollback()
                raise

    @staticmethod
    def validate_request_id(request_id: str) -> None:
        # Entropy comes from client-generated random IDs; preserve the existing
        # capture API's accepted syntax for clients already in the field.
        if not isinstance(request_id, str) or not REQUEST_ID_PATTERN.fullmatch(request_id):
            raise InvalidJobId("Invalid analysis request id.")

    @staticmethod
    def _job(row: sqlite3.Row) -> CaptureJob:
        return CaptureJob(
            request_id=row["request_id"], upload_path=Path(row["upload_path"]),
            parameters=json.loads(row["parameters"]), status=row["status"],
            error=row["error"], retryable=bool(row["retryable"]),
            created_at=row["created_at"], updated_at=row["updated_at"],
        )

    def get(self, request_id: str) -> CaptureJob | None:
        self.validate_request_id(request_id)
        with self._connection() as connection:
            row = connection.execute("SELECT * FROM capture_jobs WHERE request_id=?", (request_id,)).fetchone()
        if row is None:
            return None
        if row["status"] in ("ready", "failed") and time.time() - row["updated_at"] > self.terminal_ttl_seconds:
            self.cleanup()
            return None
        return self._job(row)

    def has_capacity(self) -> bool:
        """A preflight hint; submit still checks capacity atomically."""
        self.cleanup()
        with self._connection() as connection:
            count = connection.execute(
                "SELECT COUNT(*) FROM capture_jobs WHERE status IN ('queued','processing')"
            ).fetchone()[0]
        return count < self.max_jobs

    @staticmethod
    def _fingerprint(parameters: dict[str, Any], source_digest: str) -> tuple[str, str]:
        if not re.fullmatch(r"[0-9a-f]{64}", source_digest):
            raise ValueError("Invalid source SHA-256 digest.")
        serialized = json.dumps(parameters, sort_keys=True, separators=(",", ":"), allow_nan=False)
        return serialized, hashlib.sha256((source_digest + "\n" + serialized).encode()).hexdigest()

    def matches(self, request_id: str, parameters: dict[str, Any], source_digest: str) -> bool:
        """Check a duplicate's content without staging it or changing any state."""
        self.validate_request_id(request_id)
        _, fingerprint = self._fingerprint(parameters, source_digest)
        with self._connection() as connection:
            row = connection.execute(
                "SELECT fingerprint FROM capture_jobs WHERE request_id=?", (request_id,)
            ).fetchone()
        return row is not None and row["fingerprint"] == fingerprint

    def submit(
        self,
        request_id: str,
        upload_path: Path | str,
        parameters: dict[str, Any],
        *,
        source_digest: str | None = None,
    ) -> CaptureJob:
        """Adopt a staged input, or return its existing job on an exact retry.

        Caller must delete a duplicate staged file when its path differs from
        the returned job.upload_path. Failed retryable jobs explicitly resubmit
        with the same content/parameters; terminal failures stay failed.
        """
        self.validate_request_id(request_id)
        upload_path = Path(upload_path).resolve()
        if not upload_path.is_relative_to(self.upload_dir) or not upload_path.is_file():
            raise ValueError("Stage the video inside the queue upload directory.")
        if source_digest is None:
            digest = hashlib.sha256()
            with upload_path.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
            source_digest = digest.hexdigest()
        serialized, fingerprint = self._fingerprint(parameters, source_digest)
        now = time.time()
        self.cleanup(_protected_upload=upload_path)
        with self._transaction() as connection:
            existing = connection.execute("SELECT * FROM capture_jobs WHERE request_id=?", (request_id,)).fetchone()
            if existing is not None:
                if existing["fingerprint"] != fingerprint:
                    raise JobConflict("This analysis request id already belongs to different input.")
                if existing["status"] != "failed" or not existing["retryable"]:
                    return self._job(existing)
            if connection.execute(
                "SELECT 1 FROM capture_jobs WHERE upload_path=? AND request_id!=?",
                (str(upload_path), request_id),
            ).fetchone():
                raise JobConflict("This staged input already belongs to another analysis.")
            count = connection.execute(
                "SELECT COUNT(*) FROM capture_jobs WHERE status IN ('queued','processing')"
            ).fetchone()[0]
            if count >= self.max_jobs:
                raise QueueFull("The analysis queue is full. The record is saved on your device; retry shortly.")
            if existing is None:
                connection.execute("""
                    INSERT INTO capture_jobs
                    (request_id,upload_path,parameters,fingerprint,status,created_at,updated_at)
                    VALUES (?,?,?,?,'queued',?,?)
                """, (request_id, str(upload_path), serialized, fingerprint, now, now))
            else:
                connection.execute("""
                    UPDATE capture_jobs SET upload_path=?,status='queued',error=NULL,retryable=0,
                    created_at=?,updated_at=? WHERE request_id=?
                """, (str(upload_path), now, now, request_id))
            row = connection.execute("SELECT * FROM capture_jobs WHERE request_id=?", (request_id,)).fetchone()
        self._wake.set()
        return self._job(row)

    def start(self) -> None:
        """Recover interrupted jobs and start one dispatcher; never on import."""
        with self._lifecycle_lock:
            if self._thread is not None and self._thread.is_alive():
                return
            owner_file = (self.directory / "dispatcher.lock").open("a+")
            try:
                fcntl.flock(owner_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                owner_file.close()
                raise RuntimeError("Another capture dispatcher owns this job directory.") from None
            self._owner_file = owner_file
            try:
                with self._transaction() as connection:
                    connection.execute("""
                        UPDATE capture_jobs SET status='queued',updated_at=? WHERE status='processing'
                    """, (time.time(),))
                self.cleanup()
                self._stop.clear()
                self._thread = threading.Thread(target=self._run, name="capture-jobs", daemon=True)
                self._thread.start()
            except BaseException:
                self._owner_file = None
                owner_file.close()
                raise

    def stop(self, timeout: float = 5) -> bool:
        """Stop claiming work; return False if the current handler is still busy.

        A running pipeline is not killed. Its owner lock remains held until the
        handler finishes; a process exit leaves processing state for recovery.
        """
        self._stop.set()
        self._wake.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=max(0, timeout))
        return thread is None or not thread.is_alive()

    def _claim(self) -> CaptureJob | None:
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT * FROM capture_jobs WHERE status='queued' ORDER BY created_at,request_id LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            connection.execute(
                "UPDATE capture_jobs SET status='processing',updated_at=? WHERE request_id=? AND status='queued'",
                (time.time(), row["request_id"]),
            )
            row = connection.execute("SELECT * FROM capture_jobs WHERE request_id=?", (row["request_id"],)).fetchone()
            return self._job(row)

    def _finish(self, job: CaptureJob, error: Exception | None = None) -> None:
        status = "ready" if error is None else "failed"
        message = None
        retryable = False
        if error is not None:
            message = (
                str(error)[:2000] if isinstance(error, JobProcessingError)
                else "Analysis could not finish. Your video is saved; please retry."
            )
            http_status = getattr(error, "status_code", None)
            retryable = bool(getattr(error, "retryable", (
                http_status is None or http_status in (408, 429) or http_status >= 500
            )))
        with self._transaction() as connection:
            connection.execute("""
                UPDATE capture_jobs SET status=?,error=?,retryable=?,updated_at=?
                WHERE request_id=? AND status='processing'
            """, (status, message, int(retryable), time.time(), job.request_id))
        # Commit the terminal state before deleting its input: a crash must
        # never leave processing state pointing at an intentionally removed file.
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT status,upload_path FROM capture_jobs WHERE request_id=?", (job.request_id,)
            ).fetchone()
            if row is not None and row["status"] in ("ready", "failed") and row["upload_path"] == str(job.upload_path):
                self._remove_upload(job.upload_path)

    def _run(self) -> None:
        try:
            while not self._stop.is_set():
                self._wake.clear()
                try:
                    if time.monotonic() >= self._next_cleanup_at:
                        self.cleanup()
                        self._next_cleanup_at = time.monotonic() + 30
                    with self._connection() as connection:
                        waiting = connection.execute("SELECT 1 FROM capture_jobs WHERE status='queued' LIMIT 1").fetchone()
                    if waiting and not self._stop.is_set() and self.acquire_slot():
                        try:
                            if self._stop.is_set():
                                continue
                            job = self._claim()
                            if job is not None:
                                try:
                                    self.handler(job)
                                except Exception as error:
                                    logger.exception("capture queued analysis failed")
                                    self._finish(job, error)
                                else:
                                    self._finish(job)
                                continue
                        finally:
                            self.release_slot()
                except Exception:
                    # Database/storage failure must not kill the dispatcher.
                    # Do not reclaim a processing job here: its outcome may be
                    # unknown. Restart recovery handles interrupted processing.
                    logger.exception("capture queue dispatch failed")
                self._wake.wait(self.poll_interval)
        finally:
            owner_file = self._owner_file
            self._owner_file = None
            if owner_file is not None:
                owner_file.close()

    def _remove_upload(self, path: Path) -> None:
        try:
            if path.resolve().is_relative_to(self.upload_dir):
                path.unlink(missing_ok=True)
        except OSError:
            logger.warning("capture queue input cleanup failed")

    def cleanup(self, *, _protected_upload: Path | None = None) -> None:
        """Retain terminal status 45 minutes; fail queued inputs after 24 hours.

        A processing job is never expired by cleanup. Pending inputs survive
        restart; only explicit age expiry changes them into retryable failures.
        """
        now = time.time()
        with self._transaction() as connection:
            connection.execute("""
                UPDATE capture_jobs SET status='failed',error=?,retryable=1,updated_at=?
                WHERE status='queued' AND created_at<?
            """, ("The queued analysis expired. Send the video again to retry.", now, now - self.pending_ttl_seconds))
        # Expiry must commit before any source is removed, just as completion
        # does. A process crash cannot turn an expired row back into queued
        # state after its source has already been deleted.
        with self._transaction() as connection:
            terminal = connection.execute("SELECT upload_path FROM capture_jobs WHERE status IN ('ready','failed')").fetchall()
            for row in terminal:
                if Path(row["upload_path"]) != _protected_upload:
                    self._remove_upload(Path(row["upload_path"]))
            connection.execute(
                "DELETE FROM capture_jobs WHERE status IN ('ready','failed') AND updated_at<?",
                (now - self.terminal_ttl_seconds,),
            )
            active_paths = {row[0] for row in connection.execute(
                "SELECT upload_path FROM capture_jobs WHERE status IN ('queued','processing')"
            )}
            for path in self.upload_dir.iterdir():
                try:
                    if path != _protected_upload and path.is_file() and str(path.resolve()) not in active_paths and path.stat().st_mtime < now - self.pending_ttl_seconds:
                        self._remove_upload(path)
                except OSError:
                    continue
        result_directory = self.directory / "results"
        if result_directory.is_dir():
            for path in result_directory.iterdir():
                try:
                    if re.fullmatch(r"[0-9a-f]{64}\.json", path.name) and path.stat().st_mtime < now - self.terminal_ttl_seconds:
                        path.unlink(missing_ok=True)
                except OSError:
                    logger.warning("capture queue result cleanup failed")
