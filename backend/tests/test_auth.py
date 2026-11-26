"""Optional token authentication and the non-loopback bind rule.

Token off: nothing changes (the rest of the suite runs that way). Token on:
every /api request except /api/auth/* needs a bearer token or the session
cookie from POST /api/auth/login, on every transport the UI uses (fetch,
POST streaming, EventSource job streams, <img>/<a> wiki files).
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import sys
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

import openkb_web.auth as auth_module
import openkb_web.main as main_module
from helpers import FakeStreamedResult, install_fake_runner, parse_sse, text_delta, wait_for_job
from openkb_web.auth import (
    MIN_TOKEN_LENGTH,
    PUBLIC_API_PATHS,
    SESSION_COOKIE,
    TOKEN_ENV,
    TOKEN_FILE_ENV,
    TokenAuth,
    is_loopback_host,
    resolve_token,
)
from openkb_web.jobqueue import openkb_env
from openkb_web.main import create_app

TOKEN = "s3cret-Token-for-tests-0123456789"
BEARER = {"Authorization": f"Bearer {TOKEN}"}
WRONG = "wrong-token-but-long-enough-000"


def _new_app(kb_dir: Path, monkeypatch: pytest.MonkeyPatch, token: str | None = TOKEN):
    import openkb.cli

    monkeypatch.setattr(openkb.cli, "_setup_llm_key", lambda kb_dir=None: None)
    if token is not None:
        monkeypatch.setenv(TOKEN_ENV, token)
    app = create_app(kb_dir)
    if app.state.auth is not None:
        app.state.auth.failure_delay = 0.05  # keep the suite fast
    return app


@pytest.fixture
def auth_app(kb_dir: Path, monkeypatch: pytest.MonkeyPatch):
    return _new_app(kb_dir, monkeypatch)


@pytest.fixture
async def auth_client(auth_app):
    async with auth_app.router.lifespan_context(auth_app):
        transport = ASGITransport(app=auth_app)
        async with AsyncClient(
            transport=transport, base_url="http://localhost", timeout=30.0
        ) as c:
            yield c


async def _login(client: AsyncClient, token: str = TOKEN):
    return await client.post("/api/auth/login", json={"token": token})


def _cookie(session_id: str) -> dict[str, str]:
    """A raw Cookie header (the client's jar is cleared before use)."""
    return {"Cookie": f"{SESSION_COOKIE}={session_id}"}


def _session_cookie(resp) -> str:
    header = resp.headers["set-cookie"]
    m = re.match(rf"{SESSION_COOKIE}=([^;]+)", header)
    assert m, header
    return m.group(1)


# --- token off: unchanged behaviour --------------------------------------------


async def test_token_off_session_reports_no_auth(app, client):
    assert app.state.auth is None
    resp = await client.get("/api/auth/session")
    assert resp.json() == {"auth_required": False, "authenticated": False}
    # The API stays open, as before.
    assert (await client.get("/api/status")).status_code == 200
    assert (await client.get("/api/jobs")).status_code == 200


async def test_token_off_login_is_refused_without_cookie(client):
    resp = await _login(client)
    assert resp.status_code == 400
    assert "not enabled" in resp.json()["detail"]
    assert "set-cookie" not in resp.headers


async def test_token_off_logout_is_harmless(client):
    resp = await client.post("/api/auth/logout")
    assert resp.status_code == 204


# --- token on: everything under /api is protected --------------------------------


def _protected_requests(app) -> list[tuple[str, str]]:
    """(method, path) for every API operation, from the OpenAPI schema (which
    lists the routes of every included router)."""
    out = []
    for route_path, operations in app.openapi()["paths"].items():
        if not route_path.startswith("/api") or route_path in PUBLIC_API_PATHS:
            continue
        path = re.sub(r"\{[^}]+\}", "x", route_path)
        for method in operations:
            out.append((method.upper(), path))
    return out


async def test_every_api_route_requires_auth(auth_app, auth_client):
    requests = _protected_requests(auth_app)
    assert len(requests) >= 18, requests  # the walk really found the routers
    for method, path in requests:
        resp = await auth_client.request(method, path)
        assert resp.status_code == 401, (method, path, resp.status_code)
        assert resp.json() == {"detail": "Authentication required"}, (method, path)
        assert resp.headers["www-authenticate"].startswith("Bearer")


@pytest.mark.parametrize("path", ["/api", "/api/", "/api/nope", "/api/auth/session/"])
async def test_unknown_api_paths_require_auth(auth_client, path):
    # 401, not 404: unauthenticated clients cannot even probe for routes.
    resp = await auth_client.get(path)
    assert resp.status_code == 401


async def test_unauthenticated_upload_is_rejected_before_the_body_is_used(
    auth_client, kb_dir: Path, fake_openkb
):
    resp = await auth_client.post(
        "/api/documents/upload", files={"file": ("notes.md", b"# hi\n", "text/markdown")}
    )
    assert resp.status_code == 401
    assert not (kb_dir / ".openkb-web-uploads").exists()
    jobs = await auth_client.get("/api/jobs", headers=BEARER)
    assert jobs.json() == []


async def test_static_frontend_stays_public(kb_dir, tmp_path, monkeypatch):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>ui</title>")
    (dist / "assets" / "app.js").write_text("console.log('ui')")
    monkeypatch.setattr(main_module, "_PACKAGED_FRONTEND", dist)
    app = _new_app(kb_dir, monkeypatch)
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://localhost"
        ) as c:
            for path in ("/", "/wiki/concepts/x", "/assets/app.js"):
                assert (await c.get(path)).status_code == 200, path
            assert (await c.get("/api/status")).status_code == 401


async def test_session_endpoint_reveals_only_auth_state(auth_client):
    resp = await auth_client.get("/api/auth/session")
    assert resp.status_code == 200
    assert resp.json() == {"auth_required": True, "authenticated": False}


# --- bearer tokens (API clients) --------------------------------------------------


async def test_bearer_token_grants_access(auth_client):
    assert (await auth_client.get("/api/status", headers=BEARER)).status_code == 200
    lower = {"Authorization": f"bearer {TOKEN}"}
    assert (await auth_client.get("/api/pages", headers=lower)).status_code == 200


async def test_wrong_bearer_token_rejected(auth_client):
    resp = await auth_client.get("/api/status", headers={"Authorization": f"Bearer {WRONG}"})
    assert resp.status_code == 401
    assert resp.json() == {"detail": "Invalid token"}


@pytest.mark.parametrize(
    "value", ["Basic dXNlcjpwYXNz", "Bearer", "Bearer   ", TOKEN, f"Token {TOKEN}"]
)
async def test_malformed_authorization_header_rejected(auth_client, value):
    resp = await auth_client.get("/api/status", headers={"Authorization": value})
    assert resp.status_code == 401
    assert resp.json() == {"detail": "Authentication required"}


async def test_token_in_query_string_is_not_accepted(auth_client):
    resp = await auth_client.get(f"/api/status?token={TOKEN}")
    assert resp.status_code == 401


# --- browser sessions ----------------------------------------------------------------


async def test_login_sets_strict_httponly_session_cookie(auth_client):
    resp = await _login(auth_client)
    assert resp.status_code == 204
    header = resp.headers["set-cookie"]
    attrs = [a.strip().lower() for a in header.split(";")]
    assert "httponly" in attrs
    assert "samesite=strict" in attrs
    assert "path=/api" in attrs
    assert "max-age=2592000" in attrs
    assert "secure" not in attrs  # plain http; set behind an https proxy
    # The cookie is a random session id, not the token.
    session_id = _session_cookie(resp)
    assert TOKEN not in header and len(session_id) >= 40

    assert (await auth_client.get("/api/status")).status_code == 200
    session = await auth_client.get("/api/auth/session")
    assert session.json() == {"auth_required": True, "authenticated": True}


async def test_cookie_is_secure_behind_https(auth_app):
    async with AsyncClient(
        transport=ASGITransport(app=auth_app), base_url="https://localhost"
    ) as c:
        resp = await _login(c)
    assert resp.status_code == 204
    assert "secure" in [a.strip().lower() for a in resp.headers["set-cookie"].split(";")]


async def test_login_with_wrong_token(auth_client):
    resp = await _login(auth_client, WRONG)
    assert resp.status_code == 401
    assert resp.json() == {"detail": "Invalid token"}
    assert "set-cookie" not in resp.headers
    assert (await auth_client.get("/api/status")).status_code == 401


async def test_login_tolerates_surrounding_whitespace(auth_client):
    resp = await _login(auth_client, f"  {TOKEN}\n")
    assert resp.status_code == 204


@pytest.mark.parametrize(
    "body", [b"not json", b'{"token": 5}', b"[]", b'{"tok": "x"}', b""]
)
async def test_login_rejects_malformed_body(auth_client, body):
    resp = await auth_client.post(
        "/api/auth/login", content=body, headers={"Content-Type": "application/json"}
    )
    assert resp.status_code == 400


async def test_login_body_is_bounded(auth_client):
    resp = await auth_client.post("/api/auth/login", json={"token": "x" * 10_000})
    assert resp.status_code == 413


async def test_logout_revokes_the_session_server_side(auth_client):
    session_id = _session_cookie(await _login(auth_client))
    resp = await auth_client.post("/api/auth/logout")
    assert resp.status_code == 204
    cleared = [a.strip().lower() for a in resp.headers["set-cookie"].split(";")]
    assert "max-age=0" in cleared and "path=/api" in cleared

    # Even a client that kept the old cookie value is now refused.
    auth_client.cookies.clear()
    resp = await auth_client.get("/api/status", headers=_cookie(session_id))
    assert resp.status_code == 401


async def test_relogin_replaces_the_previous_session(auth_client):
    first = _session_cookie(await _login(auth_client))
    second = _session_cookie(await _login(auth_client))
    assert first != second
    auth_client.cookies.clear()
    assert (
        await auth_client.get("/api/status", headers=_cookie(first))
    ).status_code == 401
    assert (
        await auth_client.get("/api/status", headers=_cookie(second))
    ).status_code == 200


async def test_forged_session_cookie_rejected(auth_client):
    resp = await auth_client.get("/api/status", headers=_cookie(TOKEN))
    assert resp.status_code == 401


async def test_session_expires(auth_client, monkeypatch):
    await _login(auth_client)
    assert (await auth_client.get("/api/status")).status_code == 200
    real_now = auth_module._now
    monkeypatch.setattr(
        auth_module, "_now", lambda: real_now() + auth_module.SESSION_TTL + 1
    )
    assert (await auth_client.get("/api/status")).status_code == 401


def test_session_count_is_capped():
    auth = TokenAuth(TOKEN, max_sessions=2)
    first, second, third = (auth.create_session() for _ in range(3))
    assert not auth.session_valid(first)
    assert auth.session_valid(second) and auth.session_valid(third)


def test_only_digests_are_kept_in_memory():
    auth = TokenAuth(TOKEN)
    session_id = auth.create_session()
    state = repr(vars(auth))
    assert TOKEN not in state and session_id not in state


# --- every transport the UI uses ------------------------------------------------------


async def test_job_event_stream_needs_auth_and_works_with_cookie_or_bearer(
    auth_client, fake_openkb
):
    resp = await auth_client.post(
        "/api/documents/url", json={"url": "https://example.com/a"}, headers=BEARER
    )
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]
    await wait_for_job_with(auth_client, job_id, BEARER)

    events_url = f"/api/jobs/{job_id}/events"
    assert (await auth_client.get(events_url)).status_code == 401

    # EventSource cannot set headers; the browser sends only the cookie.
    await _login(auth_client)
    resp = await auth_client.get(events_url)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    assert parse_sse(resp.text)[-1]["type"] == "done"

    auth_client.cookies.clear()
    resp = await auth_client.get(events_url, headers=BEARER)
    assert resp.status_code == 200
    assert parse_sse(resp.text)[-1]["type"] == "done"


async def wait_for_job_with(client, job_id, headers):
    class _Authed:
        async def get(self, url):
            return await client.get(url, headers=headers)

    return await wait_for_job(_Authed(), job_id, "succeeded")


async def test_chat_stream_needs_auth(auth_client, kb_dir: Path, monkeypatch):
    install_fake_runner(
        monkeypatch, lambda: FakeStreamedResult([text_delta("Hi.", 0)], history=[])
    )
    session_id = next((kb_dir / ".openkb" / "chats").glob("*.json")).stem
    url = f"/api/chat/sessions/{session_id}/messages"

    resp = await auth_client.post(url, json={"message": "hello"})
    assert resp.status_code == 401

    await _login(auth_client)
    resp = await auth_client.post(url, json={"message": "hello"})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    assert parse_sse(resp.text)[-1] == {"type": "done", "answer": "Hi."}


async def test_query_stream_needs_auth(auth_client, monkeypatch):
    install_fake_runner(
        monkeypatch, lambda: FakeStreamedResult([text_delta("42", 0)], history=[])
    )
    resp = await auth_client.post("/api/query", json={"question": "q"})
    assert resp.status_code == 401
    resp = await auth_client.post("/api/query", json={"question": "q"}, headers=BEARER)
    assert resp.status_code == 200
    assert parse_sse(resp.text)[-1] == {"type": "done", "answer": "42"}


async def test_wiki_files_need_auth(auth_client):
    # Loaded by <img src> and <a href>, which carry only the cookie.
    url = "/api/wiki-file/sources/images/demo-paper/p1_img0.png"
    assert (await auth_client.get(url)).status_code == 401
    await _login(auth_client)
    resp = await auth_client.get(url)
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/png"


async def test_websocket_scope_is_refused(auth_app):
    sent: list[dict] = []

    async def receive():
        return {"type": "websocket.connect"}

    async def send(message):
        sent.append(message)

    middleware = auth_module.TokenAuthMiddleware(
        app=lambda *a: pytest.fail("reached the app"), auth=auth_app.state.auth
    )
    scope = {"type": "websocket", "path": "/api/anything", "headers": [], "root_path": ""}
    await middleware(scope, receive, send)
    assert sent == [{"type": "websocket.close", "code": 1008, "reason": ""}]


# --- the CSRF guard, Host allowlist and CORS still apply -------------------------------


async def test_csrf_guard_still_rejects_cross_origin_mutations(auth_client, fake_openkb):
    await _login(auth_client)
    evil = {"Origin": "http://evil.example"}
    resp = await auth_client.post("/api/documents/demo-paper/remove", headers=evil)
    assert resp.status_code == 403
    # Same site, other port: SameSite would send the cookie; the guard stops it.
    resp = await auth_client.post(
        "/api/documents/demo-paper/remove", headers={"Origin": "http://localhost:3000"}
    )
    assert resp.status_code == 403
    resp = await auth_client.post(
        "/api/documents/demo-paper/remove", headers={"Origin": "http://localhost"}
    )
    assert resp.status_code == 202


async def test_login_and_logout_are_csrf_protected(auth_client):
    evil = {"Origin": "http://evil.example"}
    resp = await auth_client.post("/api/auth/login", json={"token": TOKEN}, headers=evil)
    assert resp.status_code == 403
    assert "set-cookie" not in resp.headers
    await _login(auth_client)
    assert (await auth_client.post("/api/auth/logout", headers=evil)).status_code == 403
    assert (await auth_client.get("/api/status")).status_code == 200


async def test_host_allowlist_runs_before_auth(auth_client):
    resp = await auth_client.get(
        "/api/status", headers={**BEARER, "Host": "evil.example"}
    )
    assert resp.status_code == 400
    resp = await auth_client.post(
        "/api/auth/login",
        json={"token": TOKEN},
        headers={"Host": "evil.example:8000", "Origin": "http://evil.example:8000"},
    )
    assert resp.status_code == 400


async def test_cors_preflight_and_401_for_allowlisted_origin(auth_client):
    origin = "http://localhost:5173"
    preflight = await auth_client.options(
        "/api/status",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    assert preflight.status_code == 200
    resp = await auth_client.get("/api/status", headers={"Origin": origin})
    assert resp.status_code == 401
    assert resp.headers["access-control-allow-origin"] == origin
    # Credentials are still never allowed cross-origin.
    assert "access-control-allow-credentials" not in resp.headers


# --- brute-force resistance ------------------------------------------------------------


async def test_failed_attempt_blocks_further_checks_briefly(auth_app, auth_client):
    auth_app.state.auth.failure_delay = 0.4
    wrong = asyncio.create_task(_login(auth_client, WRONG))
    while auth_app.state.auth.retry_after() == 0:
        await asyncio.sleep(0.005)

    # During the block even the right token is not checked, via either route.
    resp = await auth_client.get("/api/status", headers=BEARER)
    assert resp.status_code == 429
    assert int(resp.headers["retry-after"]) >= 1
    assert (await _login(auth_client)).status_code == 429

    assert (await wrong).status_code == 401  # answered only after the delay
    assert auth_app.state.auth.retry_after() == 0
    assert (await auth_client.get("/api/status", headers=BEARER)).status_code == 200


async def test_concurrent_guesses_get_one_check_per_window(auth_app, auth_client):
    auth_app.state.auth.failure_delay = 0.3
    results = await asyncio.gather(
        *(
            auth_client.get(
                "/api/status", headers={"Authorization": f"Bearer {WRONG}{i}"}
            )
            for i in range(20)
        )
    )
    codes = sorted(r.status_code for r in results)
    assert codes.count(401) == 1 and codes.count(429) == 19


async def test_failed_attempt_is_answered_after_the_delay(auth_app, auth_client):
    auth_app.state.auth.failure_delay = 0.2
    loop = asyncio.get_running_loop()
    start = loop.time()
    assert (await _login(auth_client, WRONG)).status_code == 401
    assert loop.time() - start >= 0.19


async def test_missing_credentials_are_not_throttled(auth_app, auth_client):
    # The browser polls before signing in; that must not lock anyone out.
    auth_app.state.auth.failure_delay = 5
    for _ in range(5):
        assert (await auth_client.get("/api/status")).status_code == 401
    assert auth_app.state.auth.retry_after() == 0
    assert (await _login(auth_client)).status_code == 204


async def test_comparison_is_constant_time(auth_client, monkeypatch):
    import hmac

    calls: list[tuple[bytes, bytes]] = []
    real = hmac.compare_digest

    def spy(a, b):
        calls.append((a, b))
        return real(a, b)

    monkeypatch.setattr(auth_module.hmac, "compare_digest", spy)
    await auth_client.get("/api/status", headers=BEARER)
    await auth_client.get("/api/status", headers={"Authorization": "Bearer short"})
    await _login(auth_client)
    assert len(calls) == 3
    # Fixed-length digests, so not even the token length leaks.
    assert all(len(a) == len(b) == 32 for a, b in calls)


# --- configuration -----------------------------------------------------------------------


def test_resolve_token_off_by_default():
    assert resolve_token({}) is None


def test_resolve_token_from_env_strips_whitespace():
    assert resolve_token({TOKEN_ENV: f"  {TOKEN}\n"}) == TOKEN


@pytest.mark.parametrize(
    "value, message",
    [
        ("", "empty"),
        ("   \n", "empty"),
        ("abc12", "too short"),
        ("x" * (MIN_TOKEN_LENGTH - 1), "too short"),
        ("has a space but is long enough", "printable ASCII"),
        ("non-ascii-tökén-long-enough", "printable ASCII"),
    ],
)
def test_resolve_token_rejects_weak_or_malformed(value, message):
    with pytest.raises(RuntimeError, match=message) as excinfo:
        resolve_token({TOKEN_ENV: value})
    assert TOKEN_ENV in str(excinfo.value)
    if value.strip():
        assert value.strip() not in str(excinfo.value)  # never echoed


def test_resolve_token_from_file(tmp_path):
    path = tmp_path / "token"
    path.write_text(f"{TOKEN}\n")
    assert resolve_token({TOKEN_FILE_ENV: str(path)}) == TOKEN


def test_resolve_token_file_problems(tmp_path):
    with pytest.raises(RuntimeError, match="Cannot read token file"):
        resolve_token({TOKEN_FILE_ENV: str(tmp_path / "missing")})
    with pytest.raises(RuntimeError, match="empty"):
        resolve_token({TOKEN_FILE_ENV: ""})
    short = tmp_path / "short"
    short.write_text("abc\n")
    with pytest.raises(RuntimeError, match="too short") as excinfo:
        resolve_token({TOKEN_FILE_ENV: str(short)})
    assert str(short) in str(excinfo.value)


def test_resolve_token_rejects_two_sources(tmp_path):
    path = tmp_path / "token"
    path.write_text(TOKEN)
    with pytest.raises(RuntimeError, match="only one"):
        resolve_token({TOKEN_ENV: TOKEN, TOKEN_FILE_ENV: str(path)})


def test_create_app_refuses_a_short_token(kb_dir, monkeypatch):
    with pytest.raises(RuntimeError, match="too short"):
        _new_app(kb_dir, monkeypatch, token="tiny")


def test_subprocess_env_drops_the_token(kb_dir, monkeypatch):
    monkeypatch.setenv(TOKEN_ENV, TOKEN)
    monkeypatch.setenv(TOKEN_FILE_ENV, "/somewhere/token")
    env = openkb_env(kb_dir)
    assert TOKEN_ENV not in env and TOKEN_FILE_ENV not in env
    assert TOKEN not in "".join(env.values())


# --- startup: refuse non-loopback binds without a token -----------------------------------


@pytest.mark.parametrize(
    "host",
    ["127.0.0.1", "127.0.0.2", "127.255.255.254", "localhost", "LocalHost", "::1",
     "[::1]", "::ffff:127.0.0.1"],
)
def test_loopback_hosts(host):
    assert is_loopback_host(host)


@pytest.mark.parametrize(
    "host",
    ["0.0.0.0", "::", "[::]", "192.168.1.10", "10.0.0.1", "fe80::1", "kb.example.com",
     "127.0.0.1.nip.io", "localhost.", ""],
)
def test_non_loopback_hosts(host):
    assert not is_loopback_host(host)


@pytest.fixture
def run_main(kb_dir, monkeypatch):
    """Call main() with argv; returns the kwargs uvicorn.run got (None if it
    was not reached). os.environ is a throwaway copy, since main() writes it."""
    import uvicorn

    monkeypatch.setattr(os, "environ", os.environ.copy())
    runs: list[dict] = []
    monkeypatch.setattr(uvicorn, "run", lambda *a, **kw: runs.append(kw))

    def run(*argv: str):
        monkeypatch.setattr(sys, "argv", ["openkb-web", "--kb-dir", str(kb_dir), *argv])
        runs.clear()
        main_module.main()
        return runs[0] if runs else None

    return run


@pytest.mark.parametrize("host", ["0.0.0.0", "::", "192.168.1.10", "kb.example.com"])
def test_main_refuses_non_loopback_bind_without_token(run_main, capsys, host):
    with pytest.raises(SystemExit) as excinfo:
        run_main("--host", host)
    assert excinfo.value.code == 2
    err = capsys.readouterr().err
    assert f"refusing to listen on {host} without an access token" in err
    assert TOKEN_ENV in err and "--token-file" in err


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "::1"])
def test_main_allows_loopback_without_token(run_main, host):
    assert run_main("--host", host)["host"] == host


def test_main_default_host_needs_no_token(run_main):
    assert run_main()["host"] == "127.0.0.1"


def test_main_accepts_non_loopback_with_env_token(run_main, capsys):
    os.environ[TOKEN_ENV] = TOKEN
    assert run_main("--host", "0.0.0.0")["host"] == "0.0.0.0"
    out = capsys.readouterr()
    assert TOKEN not in out.out + out.err


def test_main_accepts_non_loopback_with_token_file(run_main, tmp_path):
    path = tmp_path / "token"
    path.write_text(f"{TOKEN}\n")
    assert run_main("--host", "0.0.0.0", "--token-file", str(path))["host"] == "0.0.0.0"
    # Passed on through the environment for --reload worker processes.
    assert os.environ[TOKEN_FILE_ENV] == str(path.resolve())


def test_main_rejects_short_token_at_startup(run_main, capsys):
    os.environ[TOKEN_ENV] = "tiny-token"
    with pytest.raises(SystemExit):
        run_main()
    err = capsys.readouterr().err
    assert "too short" in err and "tiny-token" not in err


def test_main_rejects_unreadable_token_file(run_main, tmp_path, capsys):
    with pytest.raises(SystemExit):
        run_main("--token-file", str(tmp_path / "nope"))
    assert "Cannot read token file" in capsys.readouterr().err


@pytest.mark.parametrize(
    "argv", [("--token", TOKEN), (f"--token={TOKEN}",), ("--token",), ("--tok", TOKEN)]
)
def test_main_refuses_a_token_on_the_command_line(run_main, capsys, argv):
    # Without an explicit refusal, argparse's prefix matching would read
    # `--token X` as `--token-file X` and echo X in "cannot read file X".
    with pytest.raises(SystemExit) as excinfo:
        run_main(*argv)
    assert excinfo.value.code == 2
    err = capsys.readouterr().err
    assert TOKEN not in err
    assert "--token" in err


# --- the token never reaches the logs ---------------------------------------------------


async def test_token_never_logged(kb_dir, monkeypatch, caplog, capsys, fake_openkb):
    caplog.set_level(logging.DEBUG)
    app = _new_app(kb_dir, monkeypatch)
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://localhost"
        ) as c:
            await c.get("/api/status")
            await c.get("/api/status", headers=BEARER)
            await c.get("/api/status", headers={"Authorization": f"Bearer {WRONG}"})
            await asyncio.sleep(0.06)
            await _login(c, WRONG)
            session_id = _session_cookie(await _login(c))
            resp = await c.post(
                "/api/documents/url", json={"url": "https://example.com/x"}
            )
            await wait_for_job(c, resp.json()["job_id"], "succeeded")
            await c.post("/api/auth/logout")

    assert "Rejected an invalid access token" in caplog.text  # logging was captured
    captured = capsys.readouterr()
    for secret in (TOKEN, WRONG, session_id):
        assert secret not in caplog.text
        assert secret not in captured.out + captured.err
