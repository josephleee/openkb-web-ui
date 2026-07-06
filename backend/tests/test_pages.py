"""/api/pages, /api/pages/{target}, /api/wiki-file/{path}."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException

from openkb_web.kb import KBContext


# --- /api/pages --------------------------------------------------------------


async def test_pages_list_shape_and_order(client):
    resp = await client.get("/api/pages")
    assert resp.status_code == 200
    pages = resp.json()

    assert [p["target"] for p in pages] == [
        "summaries/demo-paper",
        "summaries/transformers-survey",
        "concepts/attention-mechanism",
        "concepts/sequence-modeling",
        "entities/vaswani-et-al",
        "index",
    ]
    for page in pages:
        assert set(page) == {"kind", "slug", "target", "title", "description", "mtime"}
        assert isinstance(page["mtime"], float)

    attention = next(p for p in pages if p["slug"] == "attention-mechanism")
    assert attention["kind"] == "concepts"
    assert attention["title"] == "attention-mechanism"  # no frontmatter title -> slug
    assert attention["description"] == "How models weigh input tokens against each other."

    index = pages[-1]
    assert index == {
        "kind": "index",
        "slug": "index",
        "target": "index",
        "title": "index",
        "description": "",
        "mtime": index["mtime"],
    }


async def test_pages_list_excludes_meta_files_and_sources(client, kb_dir: Path):
    wiki = kb_dir / "wiki"
    # Transient atomic-write temp file and a hidden markdown file: both skipped.
    (wiki / "concepts" / ".attention.abc123.tmp").write_text("tmp", encoding="utf-8")
    (wiki / "concepts" / ".hidden.md").write_text("hidden", encoding="utf-8")

    resp = await client.get("/api/pages")
    targets = [p["target"] for p in resp.json()]
    slugs = [p["slug"] for p in resp.json()]

    assert "AGENTS" not in slugs and "log" not in slugs
    assert not any(t.startswith("sources/") for t in targets)
    assert not any(s.startswith(".") for s in slugs)


async def test_pages_list_includes_explorations(client, kb_dir: Path):
    (kb_dir / "wiki" / "explorations" / "saved-query.md").write_text(
        "# Saved Query\n\nSee [[concepts/attention-mechanism]].\n", encoding="utf-8"
    )
    resp = await client.get("/api/pages")
    exploration = next(p for p in resp.json() if p["kind"] == "explorations")
    assert exploration["target"] == "explorations/saved-query"


# --- /api/pages/{target} ------------------------------------------------------


async def test_page_detail_exact_and_unresolved_links(client):
    resp = await client.get("/api/pages/concepts/attention-mechanism")
    assert resp.status_code == 200
    page = resp.json()

    assert page["target"] == "concepts/attention-mechanism"
    assert page["kind"] == "concepts"
    assert page["slug"] == "attention-mechanism"
    assert page["frontmatter"]["type"] == "Concept"
    assert page["frontmatter"]["sources"] == [
        "summaries/demo-paper.md",
        "summaries/transformers-survey.md",
    ]
    assert page["body"].lstrip().startswith("# Attention Mechanism")
    assert "---" not in page["body"].split("\n", 1)[0]  # frontmatter stripped
    assert isinstance(page["mtime"], float)

    links = {l["raw"]: l for l in page["wikilinks"]}
    assert links["concepts/sequence-modeling"]["target"] == "concepts/sequence-modeling"
    assert links["entities/vaswani-et-al"]["target"] == "entities/vaswani-et-al"
    assert links["summaries/demo-paper"]["target"] == "summaries/demo-paper"
    # The intentionally-broken ghost link resolves to null.
    assert links["concepts/missing-page"]["target"] is None
    assert links["concepts/missing-page"]["alias"] is None


async def test_page_detail_fuzzy_link_resolution(client):
    """Case/underscore near-misses resolve via OpenKB's build_norm_index."""
    resp = await client.get("/api/pages/concepts/sequence-modeling")
    page = resp.json()

    fuzzy = next(
        l for l in page["wikilinks"] if l["raw"] == "concepts/Attention_Mechanism"
    )
    assert fuzzy["target"] == "concepts/attention-mechanism"
    assert fuzzy["alias"] is None


async def test_page_detail_alias_split(client, kb_dir: Path):
    (kb_dir / "wiki" / "concepts" / "alias-test.md").write_text(
        "---\ntype: \"Concept\"\ndescription: \"Alias link fixture.\"\n---\n\n"
        "# Alias Test\n\n"
        "See [[concepts/attention-mechanism|the attention idea]] and\n"
        "[[concepts/nowhere|a ghost alias]].\n",
        encoding="utf-8",
    )

    resp = await client.get("/api/pages/concepts/alias-test")
    assert resp.status_code == 200
    links = resp.json()["wikilinks"]

    resolved = next(l for l in links if l["raw"].startswith("concepts/attention"))
    assert resolved == {
        "raw": "concepts/attention-mechanism|the attention idea",
        "target": "concepts/attention-mechanism",
        "alias": "the attention idea",
    }
    ghost = next(l for l in links if l["raw"].startswith("concepts/nowhere"))
    assert ghost["target"] is None
    assert ghost["alias"] == "a ghost alias"


async def test_page_detail_index(client):
    resp = await client.get("/api/pages/index")
    page = resp.json()
    assert page["target"] == "index"
    assert page["kind"] == "index"
    assert page["frontmatter"] == {}
    assert page["body"].startswith("# Knowledge Base Index")
    assert all(l["target"] is not None for l in page["wikilinks"])


async def test_page_detail_404s(client):
    for target in (
        "concepts/nope",  # missing page
        "sources/demo-paper",  # sources/ is content, not a page kind
        "reports/lint",  # not a page kind
        "concepts/%2e%2e",  # decoded ".." slug
        "concepts/.hidden",  # dotfile slug
        "concepts",  # malformed (no slug)
    ):
        resp = await client.get(f"/api/pages/{target}")
        assert resp.status_code == 404, target


# --- /api/wiki-file/{path} ----------------------------------------------------


async def test_wiki_file_markdown(client):
    resp = await client.get("/api/wiki-file/summaries/demo-paper.md")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/markdown")
    assert "attention-mechanism" in resp.text


async def test_wiki_file_image_mime(client):
    resp = await client.get("/api/wiki-file/sources/images/demo-paper/p1_img0.png")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/png"
    assert resp.content.startswith(b"\x89PNG")


async def test_wiki_file_more_image_mimes(client, kb_dir: Path):
    images = kb_dir / "wiki" / "sources" / "images" / "demo-paper"
    expected = {
        "a.jpg": "image/jpeg",
        "b.jpeg": "image/jpeg",
        "c.gif": "image/gif",
        "d.webp": "image/webp",
        "e.bmp": "image/bmp",
    }
    for name in expected:
        (images / name).write_bytes(b"fake-image-bytes")
    for name, mime in expected.items():
        resp = await client.get(f"/api/wiki-file/sources/images/demo-paper/{name}")
        assert resp.status_code == 200
        assert resp.headers["content-type"] == mime


async def test_wiki_file_json_source(client):
    resp = await client.get("/api/wiki-file/sources/transformers-survey.json")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/json")
    pages = resp.json()
    assert pages[0]["page"] == 1


async def test_wiki_file_404_on_missing(client):
    resp = await client.get("/api/wiki-file/summaries/nope.md")
    assert resp.status_code == 404


async def test_wiki_file_404_on_disallowed_suffix(client, kb_dir: Path):
    (kb_dir / "wiki" / "notes.txt").write_text("secret", encoding="utf-8")
    resp = await client.get("/api/wiki-file/notes.txt")
    assert resp.status_code == 404  # .txt is not in the serve allow-list


async def test_wiki_file_404_on_directory(client):
    # Directories are never served: no allow-listed suffix / not a file.
    resp = await client.get("/api/wiki-file/sources")
    assert resp.status_code == 404
    resp = await client.get("/api/wiki-file/sources/images/demo-paper")
    assert resp.status_code == 404
    # A trailing slash on a file collapses under pathlib and serves the file —
    # still inside the wiki root, so this is safe.
    resp = await client.get("/api/wiki-file/sources/transformers-survey.json/")
    assert resp.status_code == 200


async def test_wiki_file_traversal_rejected(client, kb_dir: Path):
    # %2e%2e survives httpx's dot-segment normalization and reaches the app
    # decoded as literal "..".
    resp = await client.get("/api/wiki-file/%2e%2e/%2e%2e/.openkb/hashes.json")
    assert resp.status_code == 403

    resp = await client.get("/api/wiki-file/%2e%2e/raw/demo-paper.md")
    assert resp.status_code == 403

    # Absolute path (double slash keeps the leading "/" in the path param).
    resp = await client.get("/api/wiki-file//etc/passwd")
    assert resp.status_code == 403

    # Sanity: the guard did not leak the registry.
    assert (kb_dir / ".openkb" / "hashes.json").exists()


def test_safe_wiki_path_literal_traversal(kb_dir: Path):
    """httpx normalizes literal ../ away before sending, so exercise the
    guard directly for the raw forms a non-normalizing client could send."""
    kb = KBContext(kb_dir)
    for rel in ("../.openkb/hashes.json", "../../etc/passwd", "/etc/passwd", "\\evil", ""):
        with pytest.raises(HTTPException) as exc_info:
            kb.safe_wiki_path(rel)
        assert exc_info.value.status_code == 403, rel

    # Benign relative paths still resolve inside the wiki root.
    inside = kb.safe_wiki_path("summaries/demo-paper.md")
    assert inside == (kb_dir / "wiki" / "summaries" / "demo-paper.md").resolve()
