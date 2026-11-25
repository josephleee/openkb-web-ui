"""CSRF / cross-origin guard and Host allowlist (DNS-rebinding guard).

The server is unauthenticated by design, so a mutation carrying a browser
Origin header that is neither same-origin nor allowlisted must be rejected —
otherwise a hostile page in the user's browser could delete KB documents.

Binding to 127.0.0.1 is not enough on its own either: a page on evil.example
can re-point that name at 127.0.0.1 (DNS rebinding) and then talk to the server
from the user's browser as "same-origin". Its requests still carry
``Host: evil.example``, so any Host outside the allowlist must be rejected.
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from openkb_web.main import ALLOWED_HOSTS_ENV, create_app, resolve_allowed_hosts


async def test_cross_origin_mutation_rejected(client, fake_openkb):
    resp = await client.post(
        "/api/documents/demo-paper/remove",
        headers={"Origin": "http://evil.example"},
    )
    assert resp.status_code == 403
    assert "Cross-origin" in resp.json()["detail"]


async def test_same_origin_mutation_allowed(client, fake_openkb):
    # The test client's base_url is http://localhost, so Host is "localhost".
    resp = await client.post(
        "/api/documents/demo-paper/remove",
        headers={"Origin": "http://localhost"},
    )
    assert resp.status_code == 202


async def test_allowlisted_origin_mutation_allowed(app, client, fake_openkb):
    origin = next(iter(app.state.allowed_origins))
    resp = await client.post(
        "/api/documents/demo-paper/remove", headers={"Origin": origin}
    )
    assert resp.status_code == 202


async def test_no_origin_mutation_allowed(client, fake_openkb):
    # Non-browser clients (curl, other services) send no Origin and pass through.
    resp = await client.post("/api/documents/demo-paper/remove")
    assert resp.status_code == 202


async def test_cross_origin_read_allowed(client):
    # GETs are not state-changing; CORS already governs response readability.
    resp = await client.get("/api/status", headers={"Origin": "http://evil.example"})
    assert resp.status_code == 200


# --- Host allowlist (DNS rebinding) -------------------------------------------


@pytest.mark.parametrize(
    "host",
    [
        "evil.example",
        "evil.example:8000",
        "localhost.evil.example",
        "127.0.0.1.nip.io",
        "[::2]:8000",
        "[::1",
        "",
    ],
)
async def test_foreign_host_rejected(client, host):
    resp = await client.get("/api/status", headers={"Host": host})
    assert resp.status_code == 400
    assert ALLOWED_HOSTS_ENV in resp.json()["detail"]


async def test_rebound_host_cannot_pass_same_origin_check(client, fake_openkb):
    # Origin == Host satisfies the CSRF guard's same-origin rule, so for a
    # rebound page only the Host allowlist stands between it and a delete.
    resp = await client.post(
        "/api/documents/demo-paper/remove",
        headers={"Host": "evil.example:8000", "Origin": "http://evil.example:8000"},
    )
    assert resp.status_code == 400


@pytest.mark.parametrize(
    "host",
    [
        "localhost",
        "localhost:8000",
        "127.0.0.1",
        "127.0.0.1:5173",
        "[::1]",
        "[::1]:8000",
        "LocalHost:8000",
    ],
)
async def test_loopback_hosts_accepted(client, host):
    resp = await client.get("/api/status", headers={"Host": host})
    assert resp.status_code == 200


def test_default_allowed_hosts(monkeypatch):
    monkeypatch.delenv(ALLOWED_HOSTS_ENV, raising=False)
    assert resolve_allowed_hosts() == ["localhost", "127.0.0.1", "[::1]"]


@pytest.mark.parametrize("bad", ["kb.*.lan", "*kb.lan", "kb*"])
def test_invalid_allowed_host_pattern_fails_fast(monkeypatch, bad):
    monkeypatch.setenv(ALLOWED_HOSTS_ENV, f"kb.lan,{bad}")
    with pytest.raises(RuntimeError, match=ALLOWED_HOSTS_ENV):
        resolve_allowed_hosts()


async def test_configured_extra_hosts_accepted(kb_dir, monkeypatch):
    import openkb.cli

    monkeypatch.setattr(openkb.cli, "_setup_llm_key", lambda kb_dir=None: None)
    # Entries are trimmed and lower-cased; a port on an entry is ignored (hosts
    # match on any port), and a bare IPv6 literal is bracketed.
    monkeypatch.setenv(
        ALLOWED_HOSTS_ENV, " KB.example.lan:8443 , *.proxy.example ,, fe80::1 "
    )
    app = create_app(kb_dir)
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://localhost") as c:
            for host in (
                "kb.example.lan",
                "kb.example.lan:8000",
                "docs.proxy.example",
                "[fe80::1]:8000",
                "localhost:8000",  # defaults still apply
            ):
                resp = await c.get("/api/status", headers={"Host": host})
                assert resp.status_code == 200, host
            for host in ("proxy.example", "evil.example", "example.lan"):
                resp = await c.get("/api/status", headers={"Host": host})
                assert resp.status_code == 400, host
