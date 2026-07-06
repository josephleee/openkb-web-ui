"""KB context: paths, config access, shared read-lock helpers, path safety."""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, TypeVar

import portalocker
from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool

from openkb.config import load_config

T = TypeVar("T")

# Mutation subprocesses hold OpenKB's exclusive ingest lock for their entire
# run (minutes of LLM compilation), and the POSIX flock has no timeout — a
# blocking shared acquisition would hang every read endpoint (including
# /api/status, the busy signal itself) for the whole job while pinning one
# threadpool worker per waiter. Reads therefore acquire the shared lock
# non-blocking with a short retry budget and degrade to a lockless snapshot
# read on contention: OpenKB writes everything except log.md atomically, and
# the one log.md consumer (/api/activity) already tolerates a torn final line.
LOCK_WAIT_BUDGET = 1.0  # seconds
LOCK_RETRY_INTERVAL = 0.05


@dataclass(frozen=True)
class KBContext:
    """One server process serves exactly one knowledge base."""

    kb_dir: Path
    # Returns True while the job queue has a mutation queued/running; lets
    # read_locked skip even the non-blocking lock attempt during our own jobs.
    busy_probe: Callable[[], bool] | None = None

    @property
    def wiki_dir(self) -> Path:
        return self.kb_dir / "wiki"

    @property
    def openkb_dir(self) -> Path:
        return self.kb_dir / ".openkb"

    @property
    def raw_dir(self) -> Path:
        return self.kb_dir / "raw"

    @property
    def uploads_dir(self) -> Path:
        # Upload staging area at the KB root, deliberately OUTSIDE wiki/
        # (wiki/ is enumerated as page content; anything we drop there would
        # pollute listings and lint). Files are staged at a path that is
        # STABLE per filename: OpenKB keys document identity by source path
        # (converter.resolve_doc_name), so re-uploading the same filename
        # must land on the same path to overwrite the document in place.
        return self.kb_dir / ".openkb-web-uploads"

    def load_config(self) -> dict[str, Any]:
        return load_config(self.openkb_dir / "config.yaml")

    async def read_locked(self, fn: Callable[[], T]) -> T:
        """Run *fn* under OpenKB's shared KB lock in a worker thread, without
        ever queuing behind a long-running mutation.

        Fast path: when our own job queue reports a mutation queued/running,
        the exclusive lock is (or is about to be) held for minutes — read
        immediately without touching the lock. Otherwise acquire the shared
        flock non-blocking, retrying briefly to ride out short exclusive
        holders (e.g. a CLI journal drain), and fall back to a lockless
        snapshot read if the budget is exhausted. Acquisition and release
        happen on the same worker thread (flock is per open file
        description), hence the closure wrapper.
        """

        def _read() -> T:
            if self.busy_probe is not None and self.busy_probe():
                return fn()
            lock_path = self.openkb_dir / "ingest.lock"
            lock_path.parent.mkdir(parents=True, exist_ok=True)
            deadline = time.monotonic() + LOCK_WAIT_BUDGET
            with lock_path.open("a+", encoding="utf-8") as fh:
                while True:
                    try:
                        portalocker.lock(
                            fh, portalocker.LOCK_SH | portalocker.LOCK_NB
                        )
                    except portalocker.LockException:
                        if time.monotonic() >= deadline:
                            return fn()  # degrade to a lockless snapshot read
                        time.sleep(LOCK_RETRY_INTERVAL)
                        continue
                    try:
                        return fn()
                    finally:
                        portalocker.unlock(fh)

        return await run_in_threadpool(_read)

    def safe_wiki_path(self, rel: str) -> Path:
        """Resolve a wiki-root-relative path with a strict traversal guard."""
        wiki_root = self.wiki_dir.resolve()
        if not rel or rel.startswith(("/", "\\")) or "\x00" in rel:
            raise HTTPException(status_code=403, detail="Access denied")
        candidate = (wiki_root / rel).resolve()
        if not candidate.is_relative_to(wiki_root):
            raise HTTPException(status_code=403, detail="Access denied")
        return candidate
