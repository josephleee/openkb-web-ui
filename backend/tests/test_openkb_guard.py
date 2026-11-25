"""Runtime guard for openkb.agent.tools.parse_pages (see openkb_web.openkb_guard).

The chat agent's get_page_content tool hands an LLM-chosen page spec to
OpenKB's parse_pages, which expands every range into a set of page numbers —
so "1-99999999999" would run the server out of memory from /api/chat.
"""

from __future__ import annotations

import logging
import sys
import time
import tracemalloc

import openkb.agent.tools as openkb_tools
import pytest

from openkb_web import openkb_guard


@pytest.fixture
def unguarded(monkeypatch: pytest.MonkeyPatch):
    """Start from OpenKB's original parse_pages; restored after the test."""
    original = getattr(openkb_tools.parse_pages, "__wrapped__", openkb_tools.parse_pages)
    monkeypatch.setattr(openkb_tools, "parse_pages", original)
    return original


def test_create_app_installs_guard(app):
    assert getattr(openkb_tools.parse_pages, "__wrapped__", None) is not None


def test_oversized_spec_yields_no_pages_without_allocating(unguarded):
    assert openkb_guard.install_parse_pages_guard() is True
    # The moderate span goes first so that, should the guard stop working, the
    # test fails on it instead of taking the whole run down with the huge one.
    cap = openkb_guard.MAX_PARSE_PAGES
    for spec in (
        "1-2000000",
        "1-99999999999",
        f"1-{cap},{cap + 1}-{cap + 1}",  # the cap is on the total, not per part
        ",".join(f"{i * 1000 + 1}-{i * 1000 + 1000}" for i in range(2000)),
    ):
        started = time.monotonic()
        tracemalloc.start()
        try:
            result = openkb_tools.parse_pages(spec)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        assert result == [], spec[:20]
        assert peak < 10 * 1024 * 1024, f"{spec[:20]}: peak {peak} bytes"
        assert time.monotonic() - started < 5


def test_normal_specs_behave_exactly_as_before(unguarded):
    specs = ["3-5,7,10-12", "1-3,abc", "5", "", "-1", "9-7", f"1-{openkb_guard.MAX_PARSE_PAGES}"]
    expected = {spec: unguarded(spec) for spec in specs}
    openkb_guard.install_parse_pages_guard()
    for spec in specs:
        assert openkb_tools.parse_pages(spec) == expected[spec], spec


def test_agent_page_tool_path_is_bounded(unguarded, kb_dir):
    # get_wiki_page_content is what the chat agent's get_page_content tool calls;
    # it looks parse_pages up as a module global, so the guard covers it.
    openkb_guard.install_parse_pages_guard()
    wiki = str(kb_dir / "wiki")
    # Moderate span first, so a broken guard fails here rather than exhausting
    # memory on the huge one.
    for spec in ("1-2000000", "1-99999999999"):
        out = openkb_tools.get_wiki_page_content("transformers-survey", spec, wiki)
        assert out.startswith("No content found"), (spec, out[:80])
    out = openkb_tools.get_wiki_page_content("transformers-survey", "1-2", wiki)
    assert "[Page 1]" in out and "[Page 2]" in out and "[Page 3]" not in out


def test_install_is_idempotent(unguarded):
    openkb_guard.install_parse_pages_guard()
    first = openkb_tools.parse_pages
    assert openkb_guard.install_parse_pages_guard() is True
    assert openkb_tools.parse_pages is first
    assert first.__wrapped__ is unguarded


def test_missing_parse_pages_warns_and_continues(monkeypatch, caplog, kb_dir):
    monkeypatch.delattr(openkb_tools, "parse_pages")
    with caplog.at_level(logging.WARNING, logger="openkb_web.openkb_guard"):
        assert openkb_guard.install_parse_pages_guard() is False
    assert "not installed" in caplog.text

    import openkb.cli

    monkeypatch.setattr(openkb.cli, "_setup_llm_key", lambda kb_dir=None: None)
    from openkb_web.main import create_app

    create_app(kb_dir)  # startup must not crash


def test_moved_module_warns_and_continues(monkeypatch, caplog):
    monkeypatch.setitem(sys.modules, "openkb.agent.tools", None)  # import -> ImportError
    with caplog.at_level(logging.WARNING, logger="openkb_web.openkb_guard"):
        assert openkb_guard.install_parse_pages_guard() is False
    assert "not installed" in caplog.text
