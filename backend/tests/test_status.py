"""/api/status, /api/activity, /api/health against the synthetic KB."""

from __future__ import annotations

from pathlib import Path


async def test_status_shape_and_counts(client, kb_dir: Path):
    resp = await client.get("/api/status")
    assert resp.status_code == 200
    data = resp.json()

    assert data["kb_dir"] == str(kb_dir)
    assert data["model"] == "gpt-5.4"
    assert data["language"] == "en"
    assert data["counts"] == {
        "documents": 3,
        "summaries": 2,
        "concepts": 2,
        "entities": 1,
        "explorations": 0,
        "reports": 0,
        "raw": 1,
    }
    # last_compile = max mtime over PAGE_CONTENT_DIRS pages, ISO-8601 Z.
    assert isinstance(data["last_compile"], str)
    assert data["last_compile"].endswith("Z")
    assert data["last_lint"] is None  # no reports/ dir in the demo KB
    assert data["busy"] is False


async def test_status_last_lint_from_reports(client, kb_dir: Path):
    reports = kb_dir / "wiki" / "reports"
    reports.mkdir()
    (reports / "lint_20260706-120000.md").write_text("# Lint report\n", encoding="utf-8")

    resp = await client.get("/api/status")
    data = resp.json()
    assert data["counts"]["reports"] == 1
    assert isinstance(data["last_lint"], str) and data["last_lint"].endswith("Z")


async def test_activity_parses_log_newest_first(client):
    resp = await client.get("/api/activity")
    assert resp.status_code == 200
    entries = resp.json()

    assert len(entries) == 5
    assert [e["operation"] for e in entries] == [
        "lint",
        "query",
        "ingest",
        "ingest",
        "init",
    ]
    newest = entries[0]
    assert set(newest) == {"timestamp", "operation", "description"}
    assert newest["description"] == "Structural lint: 1 broken link found"
    # Timestamps are local-time "YYYY-MM-DD HH:MM:SS" headings from log.md.
    assert len(newest["timestamp"]) == 19
    # Newest-first ordering by construction of the log.
    assert entries[-1]["description"] == "Knowledge base initialized"


async def test_activity_limit(client):
    resp = await client.get("/api/activity?limit=2")
    entries = resp.json()
    assert len(entries) == 2
    assert entries[0]["operation"] == "lint"


async def test_activity_tolerates_torn_final_line(client, kb_dir: Path):
    log = kb_dir / "wiki" / "log.md"
    # append_log is OpenKB's one non-atomic write: simulate a torn append —
    # an incomplete heading ending in a truncated UTF-8 sequence, no newline.
    with log.open("ab") as f:
        f.write(b"## [2026-07-06 12:34:56] inge\xc3")

    resp = await client.get("/api/activity")
    assert resp.status_code == 200
    entries = resp.json()
    assert len(entries) == 5  # torn line excluded, everything else intact
    assert entries[0]["operation"] == "lint"


async def test_activity_missing_log(client, kb_dir: Path):
    (kb_dir / "wiki" / "log.md").unlink()
    resp = await client.get("/api/activity")
    assert resp.status_code == 200
    assert resp.json() == []


async def test_health_reports_broken_wikilinks(client):
    resp = await client.get("/api/health")
    assert resp.status_code == 200
    data = resp.json()
    assert set(data) == {"broken_links", "orphans", "index_sync", "invalid_frontmatter"}

    # The demo KB ships one intentionally-broken link plus a fuzzy-case link;
    # OpenKB's find_broken_links is exact-match, so it reports both.
    assert data["broken_links"] == [
        "Broken link [[concepts/Attention_Mechanism]] in concepts/sequence-modeling.md",
        "Broken link [[concepts/missing-page]] in concepts/attention-mechanism.md",
    ]
    assert data["orphans"] == []
    assert data["index_sync"] == []
    assert data["invalid_frontmatter"] == []


async def test_health_detects_orphans_and_index_drift(client, kb_dir: Path):
    lonely = kb_dir / "wiki" / "concepts" / "lonely.md"
    lonely.write_text("# Lonely\n\nNo links in or out.\n", encoding="utf-8")

    resp = await client.get("/api/health")
    data = resp.json()
    assert "concepts/lonely" in data["orphans"]
    assert "concepts/lonely.md not mentioned in index.md" in data["index_sync"]


async def test_health_detects_invalid_frontmatter(client, kb_dir: Path):
    bad = kb_dir / "wiki" / "concepts" / "bad-frontmatter.md"
    bad.write_text(
        "---\nbrief: value: with a stray colon\n---\n\n"
        "# Bad\n\nLinks to [[concepts/attention-mechanism]].\n",
        encoding="utf-8",
    )

    resp = await client.get("/api/health")
    data = resp.json()
    assert any(f.startswith("concepts/bad-frontmatter.md:") for f in data["invalid_frontmatter"])
