"""Shared fixtures: synthetic KB, app + ASGI client, fake `openkb` CLI shim.

The KB fixture reuses scripts/make_demo_kb.py — the same synthetic OpenKB
layout served by the demo server — built fresh in tmp_path for every test so
tests may freely mutate wiki files.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from make_demo_kb import build_demo_kb  # noqa: E402

# Fake `openkb` executable emitting realistic CLI stdout (incl. the LLM
# spinner's dot runs and the [OK]/[ERROR]/[SKIP] outcome markers; remove and
# recompile exit 0 even on their failure paths, exactly like the real CLI).
# Behavior is keyed on substrings of the target argument.
FAKE_OPENKB_SH = """\
#!/bin/sh
cmd="$1"
[ $# -gt 0 ] && shift

case "$cmd" in
  add)
    target="$1"
    case "$target" in
      *sleepy*)
        echo "Adding: sleepy.md"
        sleep "${FAKE_OPENKB_SLEEP:-0.5}"
        echo "  [OK] sleepy.md added"
        ;;
      *skipme*)
        echo "Adding: skipme.md"
        echo "  [SKIP] skipme.md (already in knowledge base)"
        ;;
      *failing*)
        echo "Adding: failing.md"
        echo "    Compiling short doc..."
        echo "  [ERROR] Compile failed after retry"
        exit 0
        ;;
      *crash*)
        echo "Adding: crash.md"
        printf 'torn final line without newline'
        exit 3
        ;;
      *)
        echo "Adding: $target"
        echo "    Compiling short doc............ 12.3s (in=100, out=50, cached=0)"
        echo "  [OK] $target added"
        ;;
    esac
    ;;
  remove)
    ident="$1"
    dry=0
    for a in "$@"; do
      [ "$a" = "--dry-run" ] && dry=1
    done
    case "$ident" in
      *ghost*)
        echo "No document matching '$ident' found in the KB."
        echo 'Try `openkb list` to see indexed documents.'
        exit 0
        ;;
      *ambig*)
        echo "'$ident' matches multiple documents:"
        echo "  - a.md  (doc_name: a)"
        echo "  - ab.md  (doc_name: ab)"
        echo "Use a more specific name or the exact doc_name slug."
        exit 0
        ;;
    esac
    if [ "$dry" = "0" ]; then
      case "$ident" in
      *multi*)
        # remove (non-dry) prints the ambiguity notice and exits 0, no marker.
        echo "'$ident' matches multiple documents:"
        echo "Use a more specific name or the exact doc_name slug."
        exit 0
        ;;
      esac
    fi
    case "$ident" in
      *slowplan*)
        sleep "${FAKE_OPENKB_SLEEP:-0.5}"
        ;;
    esac
    if [ "$dry" = "1" ]; then
      echo "Remove plan for '$ident':"
      echo "  DELETE   wiki/summaries/$ident.md"
      echo "  DELETE   wiki/sources/$ident.md"
      echo "  MODIFY   wiki/concepts/attention-mechanism.md  (drop this doc from sources)"
      echo "  REGISTRY remove entry $ident"
      echo "  PAGEINDEX delete doc_id pi-demo-0001"
      echo "Dry run - no changes made."
    else
      echo "Removing '$ident'..."
      echo "  [OK] $ident removed"
    fi
    ;;
  recompile)
    name="$1"
    case "$name" in
      *legacy*)
        # Legacy long doc without doc_id: recompile skips it, exit 0.
        echo "[1/1] Recompiling $name"
        echo "  [SKIP] $name (missing doc_id; re-add to recompile)"
        echo "Done: recompiled 0, skipped 1."
        ;;
      *multi*)
        echo "'$name' matches multiple documents:"
        echo "Use a more specific name or the exact doc_name slug."
        exit 0
        ;;
      *)
        echo "[1/1] Recompiling $name"
        echo "  [OK] $name (12.3s)"
        echo "Done: recompiled 1, skipped 0."
        ;;
    esac
    ;;
  *)
    echo "fake openkb: unknown command '$cmd'" >&2
    exit 2
    ;;
esac
"""


@pytest.fixture
def kb_dir(tmp_path: Path) -> Path:
    kb = tmp_path / "kb"
    build_demo_kb(kb)
    return kb


@pytest.fixture
def app(kb_dir: Path, monkeypatch: pytest.MonkeyPatch):
    import openkb.cli

    # Tests never call an LLM; skip the process-global litellm/env mutation.
    monkeypatch.setattr(openkb.cli, "_setup_llm_key", lambda kb_dir=None: None)

    from openkb_web.main import create_app

    return create_app(kb_dir)


@pytest.fixture
async def client(app):
    # httpx's ASGITransport does not drive lifespan; run it explicitly so the
    # job queue worker starts (and stops) exactly like under uvicorn.
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(
            transport=transport, base_url="http://test", timeout=30.0
        ) as c:
            yield c


@pytest.fixture
def fake_openkb(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Install a fake `openkb` executable for job-queue tests.

    Prepended to PATH for realism, but `_openkb_argv` prefers the venv's real
    `openkb` script (which exists in this test venv), so both module
    references are pinned to the shim directly.
    """
    shim_dir = tmp_path / "fake-bin"
    shim_dir.mkdir()
    shim = shim_dir / "openkb"
    shim.write_text(FAKE_OPENKB_SH, encoding="utf-8")
    shim.chmod(0o755)

    monkeypatch.setenv("PATH", f"{shim_dir}{os.pathsep}{os.environ.get('PATH', '')}")

    import openkb_web.jobqueue as jobqueue
    import openkb_web.routers.documents as documents

    monkeypatch.setattr(jobqueue, "_openkb_argv", lambda: [str(shim)])
    # documents.py imports the name directly, so patch its reference too.
    monkeypatch.setattr(documents, "_openkb_argv", lambda: [str(shim)])
    return shim
