"""In-memory job registry + single asyncio worker running openkb subprocesses.

Mutations (add/remove/recompile) run as ``openkb`` CLI subprocesses because
``add_single_file`` calls ``asyncio.run()`` internally, ``_setup_llm_key``
poisons process-global state, and OpenKB's advisory flock + journal recovery
are designed around process boundaries (a killed subprocess is auto-recovered
on the next exclusive lock acquisition).

One worker per process — the exclusive ingest lock blocks forever on POSIX,
so concurrent subprocesses would just pile up blocked.

Outcome classification parses ``[OK]``/``[ERROR]``/``[SKIP]`` output markers;
exit codes are unreliable (remove/recompile exit 0 on several failure paths).
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import sys
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MAX_BUFFERED_LINES = 2000
TERMINAL_STATES = ("succeeded", "failed", "skipped")

# The LLM spinner writes one dot per second to stdout with no tty check, so a
# completed step line arrives as "    Compiling short doc....... 45.2s (...)".
_DOT_RUN_RE = re.compile(r"\.{4,}")


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _openkb_argv() -> list[str]:
    """Locate the openkb CLI, preferring the script in this venv."""
    venv_bin = Path(sys.executable).parent
    exe = shutil.which("openkb", path=str(venv_bin)) or shutil.which("openkb")
    if exe:
        return [exe]
    return [sys.executable, "-m", "openkb"]


@dataclass
class Job:
    id: str
    kind: str
    label: str
    args: list[str]
    state: str = "queued"
    created_at: str = field(default_factory=_utcnow_iso)
    started_at: str | None = None
    finished_at: str | None = None
    detail: str = ""
    lines: list[str] = field(default_factory=list)
    dropped_lines: int = 0
    subscribers: set[asyncio.Queue] = field(default_factory=set)
    cleanup_dir: Path | None = None  # upload staging dir removed on success

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "label": self.label,
            "state": self.state,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "detail": self.detail,
        }


class JobQueue:
    def __init__(self, kb_dir: Path):
        self.kb_dir = kb_dir
        self.jobs: dict[str, Job] = {}
        self._queue: asyncio.Queue[Job] = asyncio.Queue()
        self._worker: asyncio.Task | None = None
        self._proc: asyncio.subprocess.Process | None = None

    @property
    def busy(self) -> bool:
        return any(j.state in ("queued", "running") for j in self.jobs.values())

    def start(self) -> None:
        if self._worker is None:
            self._worker = asyncio.get_running_loop().create_task(self._run())

    async def stop(self) -> None:
        if self._worker is not None:
            self._worker.cancel()
            try:
                await self._worker
            except asyncio.CancelledError:
                pass
            self._worker = None
        if self._proc is not None and self._proc.returncode is None:
            # OpenKB's journal drain recovers an interrupted mutation on the
            # next exclusive lock acquisition, so terminating is safe.
            self._proc.terminate()

    def enqueue(
        self,
        kind: str,
        label: str,
        args: list[str],
        *,
        cleanup_dir: Path | None = None,
    ) -> Job:
        job = Job(
            id=uuid.uuid4().hex[:12],
            kind=kind,
            label=label,
            args=args,
            cleanup_dir=cleanup_dir,
        )
        self.jobs[job.id] = job
        self._queue.put_nowait(job)
        return job

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    def list_jobs(self) -> list[dict[str, Any]]:
        return [j.to_dict() for j in reversed(self.jobs.values())]

    def subscribe(self, job: Job) -> tuple[list[dict[str, Any]], asyncio.Queue | None]:
        """Replay buffered events; a live queue is returned unless terminal.

        Synchronous on purpose: snapshot + queue registration happen without
        an await point, so no event can slip between replay and live.
        """
        replay: list[dict[str, Any]] = []
        if job.dropped_lines:
            replay.append(
                {"type": "line", "line": f"... ({job.dropped_lines} earlier lines dropped)"}
            )
        replay.extend({"type": "line", "line": line} for line in job.lines)
        replay.append({"type": "state", "state": job.state})
        if job.state in TERMINAL_STATES:
            replay.append({"type": "done", "state": job.state, "detail": job.detail})
            return replay, None
        q: asyncio.Queue = asyncio.Queue()
        job.subscribers.add(q)
        return replay, q

    def _publish(self, job: Job, event: dict[str, Any]) -> None:
        if event["type"] == "line":
            job.lines.append(event["line"])
            if len(job.lines) > MAX_BUFFERED_LINES:
                del job.lines[0]
                job.dropped_lines += 1
        for q in list(job.subscribers):
            q.put_nowait(event)

    async def _run(self) -> None:
        while True:
            job = await self._queue.get()
            try:
                await self._execute(job)
            except asyncio.CancelledError:
                if job.state == "running":
                    self._finish(job, "failed", "Server shut down while job was running")
                raise
            except Exception as exc:  # keep the worker alive on parser bugs
                self._finish(job, "failed", f"Internal job error: {exc}")

    async def _execute(self, job: Job) -> None:
        job.state = "running"
        job.started_at = _utcnow_iso()
        self._publish(job, {"type": "state", "state": "running"})

        env = dict(os.environ)
        env["OPENKB_DIR"] = str(self.kb_dir)
        env["PYTHONUNBUFFERED"] = "1"

        argv = _openkb_argv() + job.args
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                stdin=asyncio.subprocess.DEVNULL,
                env=env,
            )
        except OSError as exc:
            self._finish(job, "failed", f"Failed to spawn openkb: {exc}")
            return
        self._proc = proc

        first_error = ""
        first_skip = ""
        last_ok = ""
        last_line = ""

        def emit(raw: bytes) -> None:
            nonlocal first_error, first_skip, last_ok, last_line
            line = _DOT_RUN_RE.sub("...", raw.decode("utf-8", errors="replace").rstrip())
            if not line.strip():
                return
            stripped = line.strip()
            if "[ERROR]" in stripped and not first_error:
                first_error = stripped
            elif "No document matching" in stripped and not first_error:
                # remove/recompile exit 0 and print no [ERROR] marker here.
                first_error = stripped
            if "[SKIP]" in stripped and not first_skip:
                first_skip = stripped
            if "[OK]" in stripped or stripped.startswith("Done:"):
                last_ok = stripped
            last_line = stripped
            self._publish(job, {"type": "line", "line": line})

        try:
            buffer = b""
            assert proc.stdout is not None
            while True:
                chunk = await proc.stdout.read(4096)
                if not chunk:
                    break
                buffer += chunk
                *complete, buffer = buffer.split(b"\n")
                for raw in complete:
                    emit(raw)
            if buffer:
                emit(buffer)
            returncode = await proc.wait()
        finally:
            self._proc = None

        if first_error:
            self._finish(job, "failed", first_error)
        elif first_skip and not last_ok:
            self._finish(job, "skipped", first_skip)
        elif last_ok:
            self._finish(job, "succeeded", last_ok)
        elif returncode != 0:
            self._finish(job, "failed", f"openkb exited with code {returncode}")
        else:
            self._finish(job, "succeeded", last_line)

    def _finish(self, job: Job, state: str, detail: str) -> None:
        job.state = state
        job.detail = detail
        job.finished_at = _utcnow_iso()
        if job.cleanup_dir is not None and state in ("succeeded", "skipped"):
            # Keep the upload on failure so the file can be inspected/retried.
            shutil.rmtree(job.cleanup_dir, ignore_errors=True)
        self._publish(job, {"type": "done", "state": state, "detail": detail})
        job.subscribers.clear()
