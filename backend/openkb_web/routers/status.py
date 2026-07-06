"""/api/status, /api/activity, /api/health."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Query, Request

from openkb.lint import (
    check_index_sync,
    find_broken_links,
    find_invalid_frontmatter,
    find_orphans,
)
from openkb.schema import PAGE_CONTENT_DIRS

router = APIRouter()

# log.md heading format: "## [YYYY-MM-DD HH:MM:SS] operation | description"
_LOG_RE = re.compile(r"^## \[(.+?)\] (\w+) \| (.*)$")

_COUNT_DIRS = tuple(PAGE_CONTENT_DIRS) + ("explorations", "reports")


def _iso_from_mtime(mtime: float) -> str:
    return datetime.fromtimestamp(mtime, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _newest_mtime(paths: list[Path]) -> str | None:
    if not paths:
        return None
    return _iso_from_mtime(max(p.stat().st_mtime for p in paths))


def _md_files(directory: Path) -> list[Path]:
    if not directory.is_dir():
        return []
    return [p for p in directory.glob("*.md") if not p.name.startswith(".")]


@router.get("/status")
async def get_status(request: Request) -> dict[str, Any]:
    kb = request.app.state.kb

    def read() -> dict[str, Any]:
        config = kb.load_config()
        hashes_file = kb.openkb_dir / "hashes.json"
        documents = 0
        if hashes_file.exists():
            documents = len(json.loads(hashes_file.read_text(encoding="utf-8")))

        counts: dict[str, int] = {"documents": documents}
        for sub in _COUNT_DIRS:
            counts[sub] = len(_md_files(kb.wiki_dir / sub))
        counts["raw"] = (
            len([f for f in kb.raw_dir.iterdir() if f.is_file()])
            if kb.raw_dir.is_dir()
            else 0
        )

        compiled = [p for sub in PAGE_CONTENT_DIRS for p in _md_files(kb.wiki_dir / sub)]
        return {
            "kb_dir": str(kb.kb_dir),
            "model": config.get("model"),
            "language": config.get("language"),
            "counts": counts,
            "last_compile": _newest_mtime(compiled),
            "last_lint": _newest_mtime(_md_files(kb.wiki_dir / "reports")),
        }

    data = await kb.read_locked(read)
    data["busy"] = request.app.state.jobqueue.busy
    return data


@router.get("/activity")
async def get_activity(
    request: Request, limit: int = Query(default=50, ge=1, le=1000)
) -> list[dict[str, str]]:
    kb = request.app.state.kb
    log_path = kb.wiki_dir / "log.md"

    def read() -> list[dict[str, str]]:
        if not log_path.is_file():
            return []
        # errors="replace" + per-line regex tolerate a torn final line
        # (append_log is the one non-atomic write in OpenKB).
        text = log_path.read_text(encoding="utf-8", errors="replace")
        entries = [
            {"timestamp": m.group(1), "operation": m.group(2), "description": m.group(3)}
            for line in text.splitlines()
            if (m := _LOG_RE.match(line))
        ]
        entries.reverse()  # newest first
        return entries[:limit]

    return await kb.read_locked(read)


@router.get("/health")
async def get_health(request: Request) -> dict[str, list[str]]:
    kb = request.app.state.kb
    wiki = kb.wiki_dir

    def read() -> dict[str, list[str]]:
        return {
            "broken_links": find_broken_links(wiki),
            "orphans": find_orphans(wiki),
            "index_sync": check_index_sync(wiki),
            "invalid_frontmatter": find_invalid_frontmatter(wiki),
        }

    return await kb.read_locked(read)
