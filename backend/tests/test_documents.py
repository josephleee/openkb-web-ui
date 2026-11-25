"""/api/documents listing + source viewer + upload/url validation."""

from __future__ import annotations

import time
import tracemalloc
from pathlib import Path

import pytest

from openkb_web.routers.documents import MAX_PAGES_PER_REQUEST

SURVEY_SOURCE = "/api/documents/transformers-survey/source"  # 3-page pageindex doc


async def test_documents_join(client):
    resp = await client.get("/api/documents")
    assert resp.status_code == 200
    docs = {d["doc_name"]: d for d in resp.json()}
    assert set(docs) == {"demo-paper", "transformers-survey", "old-notes"}

    assert docs["demo-paper"] == {
        "doc_name": "demo-paper",
        "name": "demo-paper.md",
        "type": "md",
        "display_type": "short",
        "pages": None,
        "has_summary": True,
        "raw_path": "raw/demo-paper.md",
        "source_path": "wiki/sources/demo-paper.md",
    }

    survey = docs["transformers-survey"]
    assert survey["type"] == "long_pdf"
    assert survey["display_type"] == "pageindex"
    assert survey["pages"] == 42
    assert survey["has_summary"] is True
    assert survey["raw_path"] is None  # registry path exists, file does not
    assert survey["source_path"] == "wiki/sources/transformers-survey.json"


async def test_documents_legacy_minimal_entry_fallback_naming(client):
    """Legacy {"name","type"} entries derive doc_name from Path(name).stem."""
    resp = await client.get("/api/documents")
    legacy = next(d for d in resp.json() if d["name"] == "old-notes.txt")

    assert legacy["doc_name"] == "old-notes"
    assert legacy["type"] == "txt"
    assert legacy["display_type"] == "short"
    assert legacy["pages"] is None
    assert legacy["has_summary"] is False
    assert legacy["raw_path"] is None
    assert legacy["source_path"] is None


async def test_documents_legacy_raw_file_discovered(client, kb_dir: Path):
    (kb_dir / "raw" / "old-notes.txt").write_text("old notes\n", encoding="utf-8")
    resp = await client.get("/api/documents")
    legacy = next(d for d in resp.json() if d["name"] == "old-notes.txt")
    assert legacy["raw_path"] == "raw/old-notes.txt"


# --- /api/documents/{doc}/source ----------------------------------------------


async def test_document_source_pageindex(client):
    resp = await client.get("/api/documents/transformers-survey/source")
    assert resp.status_code == 200
    data = resp.json()
    assert data["doc_name"] == "transformers-survey"
    assert data["display_type"] == "pageindex"
    assert data["total_pages"] == 3
    assert [p["page"] for p in data["pages"]] == [1, 2, 3]
    assert set(data["pages"][0]) == {"page", "content", "images"}


async def test_document_source_pageindex_page_filter(client):
    resp = await client.get("/api/documents/transformers-survey/source?pages=1-2")
    data = resp.json()
    assert data["total_pages"] == 3  # total is unfiltered
    assert [p["page"] for p in data["pages"]] == [1, 2]

    resp = await client.get("/api/documents/transformers-survey/source?pages=3")
    assert [p["page"] for p in resp.json()["pages"]] == [3]


async def test_document_source_short(client):
    resp = await client.get("/api/documents/demo-paper/source")
    data = resp.json()
    assert data["doc_name"] == "demo-paper"
    assert data["display_type"] == "short"
    assert data["content"].startswith("# Demo Paper")
    assert "pages" not in data


async def test_document_source_404(client):
    resp = await client.get("/api/documents/old-notes/source")
    assert resp.status_code == 404
    resp = await client.get("/api/documents/nope/source")
    assert resp.status_code == 404


async def test_document_source_invalid_doc_name(client):
    resp = await client.get("/api/documents/-flag-injection/source")
    assert resp.status_code == 400
    resp = await client.get("/api/documents/.dotted/source")
    assert resp.status_code == 400


async def test_document_source_page_lists_and_overlaps(client):
    resp = await client.get(SURVEY_SOURCE, params={"pages": "1,3"})
    assert resp.status_code == 200
    assert [p["page"] for p in resp.json()["pages"]] == [1, 3]

    resp = await client.get(SURVEY_SOURCE, params={"pages": " 2 - 3 , 1-2 "})
    assert resp.status_code == 200
    assert [p["page"] for p in resp.json()["pages"]] == [1, 2, 3]

    resp = await client.get(SURVEY_SOURCE, params={"pages": ""})
    assert len(resp.json()["pages"]) == 3  # empty spec = no filter, as before


async def test_document_source_short_doc_ignores_valid_pages(client):
    resp = await client.get("/api/documents/demo-paper/source", params={"pages": "1-2"})
    assert resp.status_code == 200
    assert resp.json()["display_type"] == "short"


@pytest.mark.parametrize(
    "spec",
    ["abc", "1-", "-1", "0", "0-2", "3-1", "1--3", "1-3-5", "1,,3", "1.5", " ", "\u0661"],
)
async def test_document_source_rejects_malformed_pages(client, spec):
    resp = await client.get(SURVEY_SOURCE, params={"pages": spec})
    assert resp.status_code == 400, resp.text
    assert "page" in resp.json()["detail"].lower()


@pytest.mark.parametrize("spec", ["4", "2-4", "1,50"])
async def test_document_source_rejects_pages_past_document_end(client, spec):
    resp = await client.get(SURVEY_SOURCE, params={"pages": spec})
    assert resp.status_code == 400, resp.text
    assert "3 pages" in resp.json()["detail"]


async def test_document_source_rejects_oversized_page_span(client):
    resp = await client.get(SURVEY_SOURCE, params={"pages": f"1-{MAX_PAGES_PER_REQUEST + 1}"})
    assert resp.status_code == 400, resp.text
    assert f"at most {MAX_PAGES_PER_REQUEST}" in resp.json()["detail"]


async def test_document_source_huge_page_range_rejected_without_allocating(client):
    """Regression: ?pages=1-99999999999 was expanded into a set of every page
    number in the range (OpenKB's parse_pages) until the server ran out of
    memory. It must now be rejected up front, in bounded time and memory.

    The moderate span goes first so that, should the bug come back, this test
    fails on it instead of taking the whole test run down with the huge one.
    """
    for spec in ("1-2000000", "1-99999999999", "99999999999", "1-" + "9" * 5000):
        started = time.monotonic()
        tracemalloc.start()
        try:
            resp = await client.get(SURVEY_SOURCE, params={"pages": spec})
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        elapsed = time.monotonic() - started
        assert resp.status_code == 400, (spec[:20], resp.text[:200])
        assert peak < 10 * 1024 * 1024, f"{spec[:20]}: peak {peak} bytes"
        assert elapsed < 5, f"{spec[:20]}: took {elapsed:.1f}s"


# --- upload / url validation (no job enqueued on rejection) --------------------


async def test_upload_rejects_unsupported_extension(client):
    resp = await client.post(
        "/api/documents/upload",
        files={"file": ("evil.exe", b"MZ...", "application/octet-stream")},
    )
    assert resp.status_code == 400
    assert "allowed" in resp.json()["detail"]


async def test_upload_rejects_dot_and_dash_filenames(client):
    for name in (".hidden.md", "-flag.md"):
        resp = await client.post(
            "/api/documents/upload", files={"file": (name, b"# x", "text/markdown")}
        )
        assert resp.status_code == 400, name


async def test_upload_rejects_oversize_file(client, kb_dir: Path, monkeypatch):
    import openkb_web.routers.documents as documents

    monkeypatch.setattr(documents, "MAX_UPLOAD_BYTES", 10)
    resp = await client.post(
        "/api/documents/upload",
        files={"file": ("big.md", b"x" * 64, "text/markdown")},
    )
    assert resp.status_code == 413
    # The partial upload staging dir is cleaned up.
    uploads = kb_dir / ".openkb-web-uploads"
    assert not uploads.exists() or list(uploads.iterdir()) == []


async def test_url_endpoint_validates_scheme(client):
    for bad in ("notaurl", "ftp://host/x.pdf", "file:///etc/passwd", "https://"):
        resp = await client.post("/api/documents/url", json={"url": bad})
        assert resp.status_code == 400, bad


async def test_mutation_endpoints_validate_doc_name(client):
    resp = await client.post("/api/documents/-bad/remove")
    assert resp.status_code == 400
    resp = await client.post("/api/documents/-bad/recompile")
    assert resp.status_code == 400
    resp = await client.post("/api/documents/.bad/remove-plan")
    assert resp.status_code == 400
