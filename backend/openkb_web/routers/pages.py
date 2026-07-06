"""/api/pages, /api/pages/{target}, /api/wiki-file/{path}."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from openkb.agent.tools import _MIME_TYPES as _IMAGE_MIME_TYPES

from openkb_web import wiki

router = APIRouter()

# Images use read_wiki_image's allow-list; wiki also holds page markdown and
# long-doc page-source JSON. Anything else is not served.
_MIME_BY_SUFFIX: dict[str, str] = {
    **_IMAGE_MIME_TYPES,
    ".md": "text/markdown",
    ".json": "application/json",
}


@router.get("/pages")
async def get_pages(request: Request) -> list[dict[str, Any]]:
    kb = request.app.state.kb
    return await kb.read_locked(lambda: wiki.list_pages(kb.wiki_dir))


@router.get("/wiki-file/{path:path}")
async def get_wiki_file(path: str, request: Request) -> FileResponse:
    kb = request.app.state.kb
    resolved = kb.safe_wiki_path(path)
    media_type = _MIME_BY_SUFFIX.get(resolved.suffix.lower())
    if media_type is None or not resolved.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(resolved, media_type=media_type)


@router.get("/pages/{target:path}")
async def get_page(target: str, request: Request) -> dict[str, Any]:
    kb = request.app.state.kb
    page = await kb.read_locked(lambda: wiki.read_page(kb.wiki_dir, target))
    if page is None:
        raise HTTPException(status_code=404, detail=f"Page not found: {target}")
    return page
