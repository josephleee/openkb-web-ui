"""CSRF / cross-origin guard on state-changing endpoints.

The server is unauthenticated by design, so a mutation carrying a browser
Origin header that is neither same-origin nor allowlisted must be rejected —
otherwise a hostile page in the user's browser could delete KB documents.
"""

from __future__ import annotations


async def test_cross_origin_mutation_rejected(client, fake_openkb):
    resp = await client.post(
        "/api/documents/demo-paper/remove",
        headers={"Origin": "http://evil.example"},
    )
    assert resp.status_code == 403
    assert "Cross-origin" in resp.json()["detail"]


async def test_same_origin_mutation_allowed(client, fake_openkb):
    # ASGITransport uses base_url http://test, so Host is "test".
    resp = await client.post(
        "/api/documents/demo-paper/remove",
        headers={"Origin": "http://test"},
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
