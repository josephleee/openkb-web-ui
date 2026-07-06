"""KB context: paths, config access, shared read-lock helpers, path safety."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, TypeVar

from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool

from openkb.config import load_config
from openkb.locks import kb_read_lock

T = TypeVar("T")


@dataclass(frozen=True)
class KBContext:
    """One server process serves exactly one knowledge base."""

    kb_dir: Path

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
        # Per-upload staging area at the KB root, deliberately OUTSIDE wiki/
        # (wiki/ is enumerated as page content; anything we drop there would
        # pollute listings and lint). The original filename is preserved
        # inside a per-upload subdirectory because the filename is the
        # document's identity in OpenKB (doc_name = sanitized stem).
        return self.kb_dir / ".openkb-web-uploads"

    def load_config(self) -> dict[str, Any]:
        return load_config(self.openkb_dir / "config.yaml")

    async def read_locked(self, fn: Callable[[], T]) -> T:
        """Run *fn* under the shared KB read lock in a worker thread.

        OpenKB's lock is blocking and reentrant per-thread, so acquisition and
        release must happen on the same thread — hence the closure wrapper
        instead of separate acquire/release calls.
        """

        def _locked() -> T:
            with kb_read_lock(self.openkb_dir):
                return fn()

        return await run_in_threadpool(_locked)

    def safe_wiki_path(self, rel: str) -> Path:
        """Resolve a wiki-root-relative path with a strict traversal guard."""
        wiki_root = self.wiki_dir.resolve()
        if not rel or rel.startswith(("/", "\\")) or "\x00" in rel:
            raise HTTPException(status_code=403, detail="Access denied")
        candidate = (wiki_root / rel).resolve()
        if not candidate.is_relative_to(wiki_root):
            raise HTTPException(status_code=403, detail="Access denied")
        return candidate
