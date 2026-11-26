"""App factory and server entry point.

KB selection is explicit only: ``--kb-dir`` CLI arg or ``OPENKB_WEB_KB_DIR``
env var — no walk-up magic. One server process serves one KB / one credential
context (``_setup_llm_key`` stashes litellm globals at startup).

Authentication is optional (see openkb_web.auth); ``main`` refuses to listen
on a non-loopback address unless a token is configured.
"""

from __future__ import annotations

import argparse
import logging
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import Headers
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.types import Receive, Scope, Send

from openkb_web.auth import (
    GENERATE_HINT,
    TOKEN_ENV,
    TOKEN_FILE_ENV,
    TokenAuth,
    TokenAuthMiddleware,
    is_loopback_host,
    resolve_token,
)
from openkb_web.jobqueue import JobQueue
from openkb_web.kb import KBContext
from openkb_web.openkb_guard import install_parse_pages_guard
from openkb_web.routers import auth, chat, documents, graph, jobs, pages, status

KB_DIR_ENV = "OPENKB_WEB_KB_DIR"
CORS_ENV = "OPENKB_WEB_CORS_ORIGINS"
_DEFAULT_CORS = "http://localhost:5173,http://127.0.0.1:5173"
ALLOWED_HOSTS_ENV = "OPENKB_WEB_ALLOWED_HOSTS"
# Host names always served (on any port); ALLOWED_HOSTS_ENV adds to these.
_DEFAULT_ALLOWED_HOSTS = ("localhost", "127.0.0.1", "[::1]")

# A Host header value: "[ipv6]" or a name, then an optional ":port".
_HOST_PORT_RE = re.compile(r"(\[[^\]]*\]|[^:\[\]]*)(?::[0-9]*)?")

_PACKAGE_DIR = Path(__file__).resolve().parent
# The built UI that hatch_build.py bundles into the sdist and wheel.
_PACKAGED_FRONTEND = _PACKAGE_DIR / "static"
# `npm run build` output, for running from a source checkout.
_CHECKOUT_FRONTEND = _PACKAGE_DIR.parents[1] / "frontend" / "dist"

logger = logging.getLogger(__name__)


def resolve_kb_dir(explicit: str | os.PathLike | None = None) -> Path:
    raw = str(explicit) if explicit else os.environ.get(KB_DIR_ENV, "")
    if not raw:
        raise RuntimeError(
            f"No knowledge base configured: pass --kb-dir or set {KB_DIR_ENV}"
        )
    kb_dir = Path(raw).expanduser().resolve()
    if not (kb_dir / ".openkb").is_dir():
        raise RuntimeError(
            f"{kb_dir} is not an OpenKB knowledge base (no .openkb/ directory)"
        )
    return kb_dir


def resolve_allowed_hosts() -> list[str]:
    """The loopback defaults plus the comma-separated ``ALLOWED_HOSTS_ENV``
    entries: names or IPs (a port is ignored), ``*.example.com`` wildcards, or
    ``*`` to turn the check off."""
    hosts = list(_DEFAULT_ALLOWED_HOSTS)
    for entry in os.environ.get(ALLOWED_HOSTS_ENV, "").split(","):
        if not entry.strip():
            continue
        host = _hostname(entry)
        if (
            not host
            or "*" in host[1:]
            or (host.startswith("*") and host != "*" and not host.startswith("*."))
        ):
            raise RuntimeError(
                f"Invalid {ALLOWED_HOSTS_ENV} entry {entry.strip()!r}: expected a "
                "host name or IP (port optional), '*.example.com', or '*'"
            )
        if host not in hosts:
            hosts.append(host)
    return hosts


def _hostname(value: str) -> str:
    """Host header (or allowlist entry) -> lower-case name without the port;
    ``""`` when malformed. ``[::1]:8000`` -> ``[::1]``, and a bare IPv6
    literal (only valid in an allowlist entry) is bracketed."""
    value = value.strip().lower()
    if value.count(":") > 1 and not value.startswith("["):
        value = f"[{value}]"
    m = _HOST_PORT_RE.fullmatch(value)
    return m.group(1) if m else ""


class _TrustedHostMiddleware(TrustedHostMiddleware):
    """Starlette's TrustedHostMiddleware, but IPv6-aware and case-insensitive.

    Upstream takes the name as ``host.split(":")[0]``, which turns
    ``[::1]:8000`` into ``[``, so the IPv6 loopback could never match.
    Allowlist semantics are otherwise the same (exact names on any port,
    ``*.example.com`` wildcards, ``*`` = allow any, no www-redirect), and
    rejections are JSON like the rest of the API.
    """

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not self.allow_any and scope["type"] in ("http", "websocket"):
            host = _hostname(Headers(scope=scope).get("host", ""))
            if not any(
                host == pattern
                or (pattern.startswith("*.") and host.endswith(pattern[1:]))
                for pattern in self.allowed_hosts
            ):
                response = JSONResponse(
                    status_code=400,
                    content={
                        "detail": "Invalid host header; to serve this UI under "
                        f"another name, add it to {ALLOWED_HOSTS_ENV}"
                    },
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


def create_app(kb_dir: str | Path | None = None) -> FastAPI:
    kb_path = resolve_kb_dir(kb_dir)
    allowed_hosts = resolve_allowed_hosts()
    token = resolve_token()
    # Temporary: bound openkb's parse_pages for the chat agent's page tool
    # (see openkb_guard). Process-global and idempotent; never raises.
    install_parse_pages_guard()
    jobqueue = JobQueue(kb_path)
    # busy_probe lets read endpoints skip even the non-blocking lock attempt
    # while our own mutation holds OpenKB's exclusive ingest lock.
    kb = KBContext(kb_path, busy_probe=lambda: jobqueue.busy)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Loads <kb>/.env then ~/.config/openkb/.env and fans LLM_API_KEY out
        # to litellm + provider env vars; applied once, process-global.
        from openkb.cli import _setup_llm_key

        await run_in_threadpool(_setup_llm_key, kb.kb_dir)
        app.state.jobqueue.start()
        yield
        await app.state.jobqueue.stop()

    app = FastAPI(title="OpenKB Web", lifespan=lifespan)
    app.state.kb = kb
    app.state.jobqueue = jobqueue
    app.state.chat_inflight = set()
    app.state.graph_cache = None
    # None = authentication off (no token configured).
    app.state.auth = TokenAuth(token) if token else None

    # Token check for every /api request except /api/auth/*. Added first =
    # innermost: CORS (below) answers preflights before it and adds its
    # headers to the 401s; the CSRF guard and Host allowlist run before both.
    if app.state.auth is not None:
        app.add_middleware(TokenAuthMiddleware, auth=app.state.auth)

    origins = [
        o.strip()
        for o in os.environ.get(CORS_ENV, _DEFAULT_CORS).split(",")
        if o.strip()
    ]
    app.state.allowed_origins = set(origins)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # CSRF guard: without a token the server is unauthenticated (local trusted
    # tool), and with one the browser holds an ambient session cookie; either
    # way a malicious page in the user's browser could otherwise fire state-
    # changing POSTs cross-origin (CORS blocks reading the reply, not the side
    # effect). SameSite=Strict keeps the cookie off cross-site requests, but
    # another port on the same host is the same site, so this check is still
    # needed. Reject any browser-originated mutation whose Origin is neither
    # same-origin nor in the allowlist. Non-browser clients send no Origin and
    # pass through unchanged.
    @app.middleware("http")
    async def csrf_guard(request, call_next):
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            origin = request.headers.get("origin")
            if origin is not None and not _origin_trusted(request, origin):
                return JSONResponse(
                    status_code=403, content={"detail": "Cross-origin request rejected"}
                )
        return await call_next(request)

    # DNS-rebinding guard. Binding to 127.0.0.1 is not enough on its own: a
    # hostile page can re-point its own domain at 127.0.0.1 and then reach this
    # server from the user's browser as "same-origin", which also passes the
    # CSRF guard above. Its requests still carry that domain in Host, so only
    # allowlisted Host names are served. Added last = outermost middleware, so
    # it runs before CORS and the CSRF guard.
    app.add_middleware(_TrustedHostMiddleware, allowed_hosts=allowed_hosts)

    for module in (auth, status, pages, documents, jobs, chat, graph):
        app.include_router(module.router, prefix="/api")

    _mount_frontend(app)
    return app


def _origin_trusted(request, origin: str) -> bool:
    if origin in request.app.state.allowed_origins:
        return True
    host = request.headers.get("host")
    return bool(host) and urlparse(origin).netloc == host


def find_frontend_dist() -> Path | None:
    """The built UI to serve: the copy bundled in the installed package, else
    ``frontend/dist`` of a source checkout; ``None`` when neither exists."""
    for candidate in (_PACKAGED_FRONTEND, _CHECKOUT_FRONTEND):
        if (candidate / "index.html").is_file():
            return candidate.resolve()
    return None


def _mount_frontend(app: FastAPI) -> None:
    """Serve the built UI with an SPA fallback when a build exists."""
    dist = find_frontend_dist()
    if dist is None:
        logger.warning(
            "No built frontend found (looked in %s and %s); serving the API "
            "only. Run `npm run build` in frontend/, or use the Vite dev server.",
            _PACKAGED_FRONTEND,
            _CHECKOUT_FRONTEND,
        )
        return

    # Registered after the API routers, so /api/* always wins.
    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str) -> FileResponse:
        if full_path == "api" or full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        if full_path:
            candidate = (dist / full_path).resolve()
            if candidate.is_file() and candidate.is_relative_to(dist):
                return FileResponse(candidate)
        return FileResponse(dist / "index.html")


class _RefuseTokenArgument(argparse.Action):
    """``--token`` exists only to be refused. A token given on the command line
    shows in the process list and shell history; and without this option,
    argparse's prefix matching would read ``--token X`` as ``--token-file X``
    and print X back in a "cannot read file" error."""

    def __call__(self, parser, namespace, values, option_string=None):
        parser.error(
            "--token is not supported: a token on the command line shows in the "
            f"process list. Set {TOKEN_ENV}, or pass --token-file PATH."
        )


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="openkb-web", description="Web UI server for an OpenKB knowledge base"
    )
    parser.add_argument(
        "--kb-dir",
        default=None,
        help=f"Knowledge base directory (default: ${KB_DIR_ENV})",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Bind address (default: 127.0.0.1). Anything other than a loopback "
        "address needs an access token.",
    )
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument(
        "--token-file",
        default=None,
        metavar="PATH",
        help="File holding the access token that turns on authentication "
        f"(or set ${TOKEN_ENV} or ${TOKEN_FILE_ENV}). There is deliberately no "
        "option taking the token itself, which would show in the process list.",
    )
    parser.add_argument(
        "--token", nargs="?", action=_RefuseTokenArgument, help=argparse.SUPPRESS
    )
    parser.add_argument("--reload", action="store_true", help="Dev auto-reload")
    args = parser.parse_args()

    if args.token_file is not None:
        # Through the environment so --reload worker processes see it too.
        os.environ[TOKEN_FILE_ENV] = str(Path(args.token_file).expanduser().resolve())
    try:
        kb_dir = resolve_kb_dir(args.kb_dir)
        resolve_allowed_hosts()  # fail fast on a malformed allowlist
        token_configured = resolve_token() is not None  # fail fast on a bad token
    except RuntimeError as exc:
        parser.error(str(exc))
        return
    if not token_configured and not is_loopback_host(args.host):
        parser.error(
            f"refusing to listen on {args.host} without an access token: anyone "
            "who can reach that address could read and change the knowledge base "
            f"and spend its LLM key. Set {TOKEN_ENV}, or put the token in a file "
            f"and pass --token-file PATH (or set {TOKEN_FILE_ENV}); or keep the "
            f"default --host 127.0.0.1. {GENERATE_HINT}"
        )
        return
    os.environ[KB_DIR_ENV] = str(kb_dir)  # visible to --reload worker processes

    import uvicorn

    uvicorn.run(
        "openkb_web.main:create_app",
        factory=True,
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
