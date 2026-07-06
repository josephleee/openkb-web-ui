"""/api/graph — openkb.visualize.build_graph served verbatim, mtime-cached."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request

from openkb.schema import PAGE_CONTENT_DIRS
from openkb.visualize import build_graph

router = APIRouter()


def _graph_key(wiki_dir: Path) -> tuple:
    """Cache key over the page dirs: file count + max file/dir mtimes.

    Dir mtimes catch deletions (a removed file lowers nothing else); compared
    by equality, never ordering.
    """
    count = 0
    max_file_mtime = 0.0
    dir_mtimes: list[float] = []
    for sub in PAGE_CONTENT_DIRS:
        d = wiki_dir / sub
        if not d.is_dir():
            continue
        dir_mtimes.append(d.stat().st_mtime)
        for p in d.glob("*.md"):
            count += 1
            max_file_mtime = max(max_file_mtime, p.stat().st_mtime)
    return (count, max_file_mtime, tuple(dir_mtimes))


@router.get("/graph")
async def get_graph(request: Request) -> dict[str, Any]:
    kb = request.app.state.kb
    app_state = request.app.state

    def compute() -> dict[str, Any]:
        key = _graph_key(kb.wiki_dir)
        cached = app_state.graph_cache
        if cached is not None and cached[0] == key:
            return cached[1]
        graph = build_graph(kb.wiki_dir)
        app_state.graph_cache = (key, graph)
        return graph

    # Blocking full-wiki scan: threadpool + shared read lock.
    return await kb.read_locked(compute)
