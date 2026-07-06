"""App factory and server entry point.

KB selection is explicit only: ``--kb-dir`` CLI arg or ``OPENKB_WEB_KB_DIR``
env var — no walk-up magic. One server process serves one KB / one credential
context (``_setup_llm_key`` stashes litellm globals at startup).
"""

from __future__ import annotations

import argparse
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

from openkb_web.jobqueue import JobQueue
from openkb_web.kb import KBContext
from openkb_web.routers import chat, documents, graph, jobs, pages, status

KB_DIR_ENV = "OPENKB_WEB_KB_DIR"
CORS_ENV = "OPENKB_WEB_CORS_ORIGINS"
_DEFAULT_CORS = "http://localhost:5173,http://127.0.0.1:5173"

_FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"


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


def create_app(kb_dir: str | Path | None = None) -> FastAPI:
    kb = KBContext(resolve_kb_dir(kb_dir))

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
    app.state.jobqueue = JobQueue(kb.kb_dir)
    app.state.chat_inflight = set()
    app.state.graph_cache = None

    origins = [
        o.strip()
        for o in os.environ.get(CORS_ENV, _DEFAULT_CORS).split(",")
        if o.strip()
    ]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    for module in (status, pages, documents, jobs, chat, graph):
        app.include_router(module.router, prefix="/api")

    _mount_frontend(app)
    return app


def _mount_frontend(app: FastAPI) -> None:
    """Serve ../frontend/dist with an SPA fallback when a build exists."""
    dist = _FRONTEND_DIST.resolve()
    if not (dist / "index.html").is_file():
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


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="openkb-web", description="Web UI server for an OpenKB knowledge base"
    )
    parser.add_argument(
        "--kb-dir",
        default=None,
        help=f"Knowledge base directory (default: ${KB_DIR_ENV})",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--reload", action="store_true", help="Dev auto-reload")
    args = parser.parse_args()

    try:
        kb_dir = resolve_kb_dir(args.kb_dir)
    except RuntimeError as exc:
        parser.error(str(exc))
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
