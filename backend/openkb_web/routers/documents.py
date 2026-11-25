"""/api/documents — listing, source viewer, and mutations via the job queue."""

from __future__ import annotations

import asyncio
import json
import os
import re
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Request, UploadFile
from pydantic import BaseModel

from openkb.cli import SUPPORTED_EXTENSIONS, _display_type

from openkb_web.jobqueue import _openkb_argv, openkb_env

router = APIRouter()

MAX_UPLOAD_BYTES = 200 * 1024 * 1024  # OpenKB itself has no size limit
_UPLOAD_CHUNK = 1024 * 1024
REMOVE_PLAN_TIMEOUT = 60.0
# Most pages one ?pages= selection may cover (omit ?pages= to get the whole
# document). Checked on the parsed range bounds, before anything is allocated
# per page.
MAX_PAGES_PER_REQUEST = 100

# "  DELETE   wiki/summaries/x.md", "  MODIFY ...", "  REGISTRY ...", "  PAGEINDEX ..."
_PLAN_LINE_RE = re.compile(r"^\s{2}(DELETE|MODIFY|REGISTRY|PAGEINDEX)\s+(.+)$")

# doc_name is a sanitized slug; reject separators and option-looking values
# (a doc_name is interpolated into subprocess argv).
_DOC_NAME_RE = re.compile(r"^[^/\\]+$")

# One comma-separated part of ?pages=: "7" or "3-5", whitespace allowed around
# the numbers. ASCII digits only, at most 18 of them, so int() stays trivial
# and never raises on an absurdly long literal.
_PAGE_PART_RE = re.compile(r"\s*([0-9]{1,18})\s*(?:-\s*([0-9]{1,18})\s*)?")


class UrlIn(BaseModel):
    url: str


class RemoveIn(BaseModel):
    keep_raw: bool = False


def _check_doc_name(doc_name: str) -> str:
    if (
        not _DOC_NAME_RE.match(doc_name)
        or doc_name.startswith(("-", "."))
        or "\x00" in doc_name
    ):
        raise HTTPException(status_code=400, detail=f"Invalid document name: {doc_name!r}")
    return doc_name


def _parse_page_ranges(spec: str) -> list[tuple[int, int]]:
    """Parse a ?pages= spec ("3-5,7,10-12") into sorted, merged inclusive ranges.

    Replaces OpenKB's ``parse_pages``, which expands every range into a set of
    page numbers, so ``1-99999999999`` ran the server out of memory. Nothing
    proportional to the requested numbers is materialized here: the selection
    size comes from the range bounds and is capped at MAX_PAGES_PER_REQUEST.
    Also strict where ``parse_pages`` is tolerant: malformed, zero and
    reversed parts are rejected rather than silently dropped.
    """
    ranges: list[tuple[int, int]] = []
    for part in spec.split(","):
        m = _PAGE_PART_RE.fullmatch(part)
        if m is None:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid page range {part.strip()!r}; expected e.g. '3', '1-5' or '1-3,7'",
            )
        start = int(m.group(1))
        end = int(m.group(2) or m.group(1))
        if start < 1:
            raise HTTPException(status_code=400, detail="Page numbers start at 1")
        if start > end:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid page range {part.strip()!r}: start is after end",
            )
        ranges.append((start, end))

    merged: list[tuple[int, int]] = []
    for start, end in sorted(ranges):
        if merged and start <= merged[-1][1] + 1:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))

    count = sum(end - start + 1 for start, end in merged)
    if count > MAX_PAGES_PER_REQUEST:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Too many pages requested ({count}); at most {MAX_PAGES_PER_REQUEST} "
                "per request (omit 'pages' to get the whole document)"
            ),
        )
    return merged


def _busy_guard(request: Request) -> None:
    if request.app.state.jobqueue.busy:
        raise HTTPException(
            status_code=409,
            detail="Knowledge base is busy with another job; try again when it finishes.",
        )


@router.get("/documents")
async def get_documents(request: Request) -> list[dict[str, Any]]:
    kb = request.app.state.kb

    def read() -> list[dict[str, Any]]:
        hashes_file = kb.openkb_dir / "hashes.json"
        if not hashes_file.exists():
            return []
        hashes: dict[str, dict] = json.loads(hashes_file.read_text(encoding="utf-8"))
        docs: list[dict[str, Any]] = []
        for file_hash, meta in hashes.items():
            name = meta.get("name", "")
            # Legacy entries can be just {"name", "type"}; derive doc_name
            # the same way OpenKB does throughout state.py/converter.py.
            doc_name = meta.get("doc_name") or (Path(name).stem if name else file_hash[:12])
            doc_type = meta.get("type", "")

            raw_path = meta.get("raw_path")
            if raw_path and not (kb.kb_dir / raw_path).exists():
                raw_path = None
            if raw_path is None and not meta.get("raw_path") and name:
                legacy_raw = kb.raw_dir / name
                if legacy_raw.exists():
                    raw_path = f"raw/{name}"

            source_path = meta.get("source_path")
            if source_path and not (kb.kb_dir / source_path).exists():
                source_path = None
            if source_path is None:
                for suffix in (".md", ".json"):
                    candidate = kb.wiki_dir / "sources" / f"{doc_name}{suffix}"
                    if candidate.exists():
                        source_path = f"wiki/sources/{doc_name}{suffix}"
                        break

            docs.append(
                {
                    "doc_name": doc_name,
                    "name": name,
                    "type": doc_type,
                    "display_type": _display_type(doc_type),
                    "pages": meta.get("pages") or None,
                    "has_summary": (kb.wiki_dir / "summaries" / f"{doc_name}.md").exists(),
                    "raw_path": raw_path,
                    "source_path": source_path,
                }
            )
        return docs

    return await kb.read_locked(read)


@router.get("/documents/{doc_name}/source")
async def get_document_source(
    doc_name: str, request: Request, pages: str | None = None
) -> dict[str, Any]:
    kb = request.app.state.kb
    _check_doc_name(doc_name)
    # Validated (and size-capped) up front, before the KB is touched.
    ranges = _parse_page_ranges(pages) if pages else None

    def read() -> dict[str, Any] | None:
        json_path = kb.wiki_dir / "sources" / f"{doc_name}.json"
        md_path = kb.wiki_dir / "sources" / f"{doc_name}.md"
        if json_path.is_file():
            data = json.loads(json_path.read_text(encoding="utf-8"))
            total = len(data)
            if ranges is not None:
                last = ranges[-1][1]
                if last > total:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Page {last} is out of range: '{doc_name}' has {total} pages",
                    )
                # At most MAX_PAGES_PER_REQUEST numbers, and none past `total`.
                requested = {p for start, end in ranges for p in range(start, end + 1)}
                data = [entry for entry in data if entry.get("page") in requested]
            return {
                "doc_name": doc_name,
                "display_type": "pageindex",
                "total_pages": total,
                "pages": data,
            }
        if md_path.is_file():
            return {
                "doc_name": doc_name,
                "display_type": "short",
                "content": md_path.read_text(encoding="utf-8"),
            }
        return None

    result = await kb.read_locked(read)
    if result is None:
        raise HTTPException(status_code=404, detail=f"No source found for '{doc_name}'")
    return result


@router.post("/documents/upload", status_code=202)
async def upload_document(file: UploadFile, request: Request) -> dict[str, str]:
    kb = request.app.state.kb
    filename = Path(file.filename or "").name  # strip any client-supplied path
    if not filename or filename.startswith((".", "-")):
        raise HTTPException(status_code=400, detail="Invalid filename")
    if Path(filename).suffix.lower() not in SUPPORTED_EXTENSIONS:
        allowed = ", ".join(sorted(SUPPORTED_EXTENSIONS))
        raise HTTPException(
            status_code=400, detail=f"Unsupported file type; allowed: {allowed}"
        )

    # Stage at a STABLE path keyed by filename: OpenKB identifies a document by
    # its source path (converter.resolve_doc_name), so re-uploading the same
    # filename must land on the same path for the document to overwrite in
    # place rather than fork a "<stem>-<hash>" duplicate. Written via a temp
    # sibling + atomic replace; the single-worker job queue serializes adds.
    # Lives under <kb>/.openkb-web-uploads/, outside wiki/. Not auto-deleted —
    # kept so a later re-upload overwrites in place (and a failed add can be
    # inspected/retried); it is tiny next to raw/, which already holds a copy.
    kb.uploads_dir.mkdir(parents=True, exist_ok=True)
    dest = kb.uploads_dir / filename
    tmp = kb.uploads_dir / f".{uuid.uuid4().hex}.part"

    size = 0
    try:
        with tmp.open("wb") as out:
            while chunk := await file.read(_UPLOAD_CHUNK):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"File exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MB upload limit",
                    )
                out.write(chunk)
        os.replace(tmp, dest)
    except HTTPException:
        tmp.unlink(missing_ok=True)
        raise

    job = request.app.state.jobqueue.enqueue(
        "add", f"Add {filename}", ["add", str(dest)]
    )
    return {"job_id": job.id}


@router.post("/documents/url", status_code=202)
async def add_url(body: UrlIn, request: Request) -> dict[str, str]:
    url = body.url.strip()
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=400, detail="Only http(s) URLs are supported")
    job = request.app.state.jobqueue.enqueue("add", f"Add {url}", ["add", url])
    return {"job_id": job.id}


@router.post("/documents/{doc_name}/remove-plan")
async def remove_plan(doc_name: str, request: Request) -> list[dict[str, str]]:
    """Run `openkb remove <doc> --dry-run` synchronously (seconds, no LLM).

    The dry run still takes the exclusive ingest lock, so it would block
    behind a running mutation — hence the busy guard and the timeout.
    """
    kb = request.app.state.kb
    _check_doc_name(doc_name)
    _busy_guard(request)

    proc = await asyncio.create_subprocess_exec(
        *_openkb_argv(),
        "remove",
        doc_name,
        "--dry-run",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        stdin=asyncio.subprocess.DEVNULL,
        env=openkb_env(kb.kb_dir),
    )
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=REMOVE_PLAN_TIMEOUT)
    except asyncio.TimeoutError:
        proc.terminate()
        raise HTTPException(status_code=504, detail="Dry run timed out (KB busy?)")

    output = stdout.decode("utf-8", errors="replace")
    if "No document matching" in output:
        raise HTTPException(status_code=404, detail=f"No document matching '{doc_name}'")
    if "matches multiple documents" in output:
        raise HTTPException(
            status_code=409, detail=f"'{doc_name}' matches multiple documents"
        )

    plan = [
        {"action": m.group(1), "target": m.group(2).strip()}
        for line in output.splitlines()
        if (m := _PLAN_LINE_RE.match(line))
    ]
    if not plan and proc.returncode != 0:
        raise HTTPException(status_code=502, detail=f"openkb remove --dry-run failed:\n{output}")
    return plan


@router.post("/documents/{doc_name}/remove", status_code=202)
async def remove_document(
    doc_name: str, request: Request, body: RemoveIn | None = None
) -> dict[str, str]:
    _check_doc_name(doc_name)
    args = ["remove", doc_name, "--yes"]
    if body is not None and body.keep_raw:
        args.append("--keep-raw")
    job = request.app.state.jobqueue.enqueue("remove", f"Remove {doc_name}", args)
    return {"job_id": job.id}


@router.post("/documents/{doc_name}/recompile", status_code=202)
async def recompile_document(doc_name: str, request: Request) -> dict[str, str]:
    _check_doc_name(doc_name)
    job = request.app.state.jobqueue.enqueue(
        "recompile", f"Recompile {doc_name}", ["recompile", doc_name, "--yes"]
    )
    return {"job_id": job.id}
