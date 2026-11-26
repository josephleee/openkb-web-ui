"""Optional shared-token authentication.

Off unless a token is configured (``OPENKB_WEB_TOKEN``, or a file named by
``--token-file`` / ``OPENKB_WEB_TOKEN_FILE``). When it is on, every ``/api``
request except the three ``/api/auth/*`` endpoints needs one of:

- ``Authorization: Bearer <token>``, for scripts and other API clients;
- the session cookie that ``POST /api/auth/login`` sets after the browser
  posts the token once. It is HttpOnly (page scripts cannot read it),
  SameSite=Strict (other sites cannot make the browser send it) and scoped to
  ``/api``. A cookie is the only credential the UI's ``EventSource`` job
  stream can carry, and it keeps the token out of URLs and browser storage.

The cookie holds a random session id, never the token or anything derived from
it. Sessions live in this process's memory: signing out ends one for real, and
restarting the server (or changing the token) signs every browser out.

The token is compared in constant time (``hmac.compare_digest`` over SHA-256
digests, so the length does not leak either). After a wrong token, further
token checks are refused for ``FAILURE_DELAY`` seconds, which caps guessing at
about one attempt per second across all clients.

Nothing here logs the token, a submitted token, or a session id.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import logging
import os
import re
import secrets
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Literal

from starlette.requests import HTTPConnection
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocketClose

TOKEN_ENV = "OPENKB_WEB_TOKEN"
TOKEN_FILE_ENV = "OPENKB_WEB_TOKEN_FILE"
MIN_TOKEN_LENGTH = 16

SESSION_COOKIE = "openkb_web_session"
COOKIE_PATH = "/api"
SESSION_TTL = 30 * 24 * 3600  # seconds; also the cookie's Max-Age
MAX_SESSIONS = 64  # oldest dropped beyond this (only token holders add any)
FAILURE_DELAY = 1.0  # seconds

# /api endpoints that answer without credentials: the login screen needs them.
PUBLIC_API_PATHS = frozenset({"/api/auth/session", "/api/auth/login", "/api/auth/logout"})

GENERATE_HINT = (
    "Generate one with: python3 -c 'import secrets; print(secrets.token_urlsafe(32))'"
)

# Printable ASCII without spaces: the token travels in an HTTP header.
_TOKEN_RE = re.compile(r"[\x21-\x7e]+")

logger = logging.getLogger(__name__)

_now = time.monotonic  # patched in tests

Verdict = Literal["ok", "invalid", "throttled"]


def resolve_token(env: Mapping[str, str] | None = None) -> str | None:
    """The configured access token, or ``None`` when authentication is off.

    Raises ``RuntimeError`` (with a message that never contains the token) when
    both sources are set, the file cannot be read, or the token is empty, too
    short, or not printable ASCII.
    """
    env = os.environ if env is None else env
    raw = env.get(TOKEN_ENV)
    token_file = env.get(TOKEN_FILE_ENV)
    if raw is not None and token_file is not None:
        raise RuntimeError(
            f"Both {TOKEN_ENV} and a token file (--token-file / {TOKEN_FILE_ENV}) "
            "are set; use only one"
        )
    if token_file is not None:
        if not token_file.strip():
            raise RuntimeError(f"{TOKEN_FILE_ENV} is set but empty; give a file path")
        path = Path(token_file).expanduser()
        try:
            raw = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            raise RuntimeError(f"Token file {path} is not valid UTF-8 text") from None
        except OSError as exc:
            raise RuntimeError(
                f"Cannot read token file {path}: {exc.strerror or exc}"
            ) from None
        source = f"The token in {path}"
    elif raw is not None:
        source = TOKEN_ENV
    else:
        return None

    token = raw.strip()
    if not token:
        raise RuntimeError(f"{source} is empty. {GENERATE_HINT}")
    if len(token) < MIN_TOKEN_LENGTH:
        raise RuntimeError(
            f"{source} is too short; use at least {MIN_TOKEN_LENGTH} characters. "
            f"{GENERATE_HINT}"
        )
    if not _TOKEN_RE.fullmatch(token):
        raise RuntimeError(
            f"{source} must be printable ASCII without spaces (it is sent in an "
            f"HTTP header). {GENERATE_HINT}"
        )
    return token


def is_loopback_host(host: str) -> bool:
    """True for ``localhost`` and loopback IPs (127.0.0.0/8, ``::1``).

    ``0.0.0.0`` and ``::`` listen on every interface, so they are not loopback;
    neither is any other name (it is not resolved).
    """
    host = host.strip().lower()
    if host == "localhost":
        return True
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    return addr.is_loopback


def _digest(value: str) -> bytes:
    return hashlib.sha256(value.encode("utf-8", "replace")).digest()


class TokenAuth:
    """Token check, failed-attempt throttle and in-memory browser sessions.

    Keeps only a SHA-256 digest of the token and of each session id.
    """

    def __init__(
        self,
        token: str,
        *,
        failure_delay: float = FAILURE_DELAY,
        session_ttl: float = SESSION_TTL,
        max_sessions: int = MAX_SESSIONS,
    ) -> None:
        self._token_digest = _digest(token)
        self.failure_delay = failure_delay
        self.session_ttl = session_ttl
        self.max_sessions = max_sessions
        self._blocked_until = 0.0
        # sha256(session id) -> monotonic expiry; insertion order = age.
        self._sessions: dict[bytes, float] = {}

    # --- token ---------------------------------------------------------------

    def token_matches(self, candidate: str) -> bool:
        return hmac.compare_digest(_digest(candidate), self._token_digest)

    def retry_after(self) -> float:
        """Seconds until token checks are accepted again (0 when they are)."""
        return max(0.0, self._blocked_until - _now())

    async def verify(self, candidate: str, client: str = "unknown") -> Verdict:
        """Check a presented token, throttling failures.

        A failure blocks every further check (from any client) for
        ``failure_delay`` seconds and is answered only after that delay. The
        block is set before the first ``await``, so concurrent requests cannot
        slip extra guesses in.
        """
        if self.retry_after() > 0:
            return "throttled"
        if self.token_matches(candidate.strip()):
            return "ok"
        self._blocked_until = _now() + self.failure_delay
        logger.warning("Rejected an invalid access token from %s", client)
        await asyncio.sleep(self.failure_delay)
        return "invalid"

    # --- browser sessions ----------------------------------------------------

    def create_session(self) -> str:
        now = _now()
        for key in [k for k, expiry in self._sessions.items() if expiry <= now]:
            del self._sessions[key]
        session_id = secrets.token_urlsafe(32)
        self._sessions[_digest(session_id)] = now + self.session_ttl
        while len(self._sessions) > self.max_sessions:
            del self._sessions[next(iter(self._sessions))]
        return session_id

    def session_valid(self, session_id: str | None) -> bool:
        if not session_id:
            return False
        key = _digest(session_id)
        expiry = self._sessions.get(key)
        if expiry is None:
            return False
        if expiry <= _now():
            del self._sessions[key]
            return False
        return True

    def end_session(self, session_id: str | None) -> None:
        if session_id:
            self._sessions.pop(_digest(session_id), None)


def bearer_token(authorization: str | None) -> str | None:
    """The credential of an ``Authorization: Bearer <token>`` header."""
    if not authorization:
        return None
    scheme, _, credential = authorization.strip().partition(" ")
    if scheme.lower() != "bearer":
        return None
    return credential.strip() or None


def _route_path(scope: Scope) -> str:
    """The path the router matches on (``scope["path"]`` minus ``root_path``),
    as Starlette's routing computes it."""
    path: str = scope["path"]
    root_path: str = scope.get("root_path", "")
    if root_path and path.startswith(root_path):
        if path == root_path:
            return ""
        if path[len(root_path)] == "/":
            return path[len(root_path) :]
    return path


def requires_auth(path: str) -> bool:
    return (path == "/api" or path.startswith("/api/")) and path not in PUBLIC_API_PATHS


def throttled_response(retry_after: float) -> JSONResponse:
    return JSONResponse(
        status_code=429,
        content={"detail": "Too many failed sign-in attempts; wait a moment and try again"},
        headers={"Retry-After": str(max(1, round(retry_after + 0.5)))},
    )


def unauthorized_response(detail: str) -> JSONResponse:
    return JSONResponse(
        status_code=401,
        content={"detail": detail},
        headers={"WWW-Authenticate": 'Bearer realm="openkb-web"'},
    )


class TokenAuthMiddleware:
    """Rejects every ``/api`` request without a valid session cookie or bearer
    token, before routing, so no handler runs and no request body is read.
    Installed only when a token is configured."""

    def __init__(self, app: ASGIApp, auth: TokenAuth) -> None:
        self.app = app
        self.auth = auth

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket") or not requires_auth(
            _route_path(scope)
        ):
            await self.app(scope, receive, send)
            return

        conn = HTTPConnection(scope)
        if self.auth.session_valid(conn.cookies.get(SESSION_COOKIE)):
            await self.app(scope, receive, send)
            return

        token = bearer_token(conn.headers.get("authorization"))
        if token is None:
            response = unauthorized_response("Authentication required")
        else:
            client = conn.client.host if conn.client else "unknown"
            verdict = await self.auth.verify(token, client)
            if verdict == "ok":
                await self.app(scope, receive, send)
                return
            if verdict == "throttled":
                response = throttled_response(self.auth.retry_after())
            else:
                response = unauthorized_response("Invalid token")

        if scope["type"] == "websocket":
            await WebSocketClose(code=1008)(scope, receive, send)
        else:
            await response(scope, receive, send)
