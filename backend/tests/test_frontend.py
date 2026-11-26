"""Locating and serving the built frontend.

An installed wheel carries the UI inside the package (``openkb_web/static``,
bundled by hatch_build.py); a source checkout serves ``frontend/dist``.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

import openkb_web.main as main


def _fake_dist(path: Path, marker: str) -> Path:
    (path / "assets").mkdir(parents=True)
    (path / "index.html").write_text(f"<!doctype html><title>{marker}</title>")
    (path / "assets" / "index-abc123.js").write_text("console.log('ui')")
    return path


@pytest.fixture
def frontend_dirs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    packaged = tmp_path / "pkg" / "static"
    checkout = tmp_path / "repo" / "frontend" / "dist"
    monkeypatch.setattr(main, "_PACKAGED_FRONTEND", packaged)
    monkeypatch.setattr(main, "_CHECKOUT_FRONTEND", checkout)
    return packaged, checkout


def test_packaged_frontend_wins(frontend_dirs):
    packaged, checkout = frontend_dirs
    _fake_dist(packaged, "packaged")
    _fake_dist(checkout, "checkout")
    assert main.find_frontend_dist() == packaged.resolve()


def test_checkout_frontend_used_without_packaged_copy(frontend_dirs):
    packaged, checkout = frontend_dirs
    _fake_dist(checkout, "checkout")
    assert main.find_frontend_dist() == checkout.resolve()


def test_no_frontend_serves_api_only(frontend_dirs, kb_dir, caplog):
    assert main.find_frontend_dist() is None
    app = main.create_app(kb_dir)
    assert not any(
        getattr(route, "path", "") == "/{full_path:path}" for route in app.routes
    )
    assert "No built frontend found" in caplog.text


@pytest.fixture
async def ui_client(frontend_dirs, kb_dir, monkeypatch: pytest.MonkeyPatch):
    import openkb.cli

    monkeypatch.setattr(openkb.cli, "_setup_llm_key", lambda kb_dir=None: None)
    packaged, _ = frontend_dirs
    _fake_dist(packaged, "packaged")
    app = main.create_app(kb_dir)
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://localhost"
        ) as c:
            yield c


async def test_index_served_at_root(ui_client):
    resp = await ui_client.get("/")
    assert resp.status_code == 200
    assert "<title>packaged</title>" in resp.text


async def test_hashed_asset_served(ui_client):
    resp = await ui_client.get("/assets/index-abc123.js")
    assert resp.status_code == 200
    assert resp.text == "console.log('ui')"


async def test_client_route_falls_back_to_index(ui_client):
    resp = await ui_client.get("/wiki/concepts/attention-mechanism")
    assert resp.status_code == 200
    assert "<title>packaged</title>" in resp.text


async def test_api_routes_not_shadowed(ui_client):
    assert (await ui_client.get("/api/status")).status_code == 200
    missing = await ui_client.get("/api/no-such-endpoint")
    assert missing.status_code == 404
    assert missing.headers["content-type"].startswith("application/json")


async def test_path_traversal_falls_back_to_index(ui_client):
    resp = await ui_client.get("/%2e%2e/%2e%2e/pyproject.toml")
    assert resp.status_code == 200
    assert "<title>packaged</title>" in resp.text
