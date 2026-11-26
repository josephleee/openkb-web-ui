"""Packaging invariants that are easy to break by editing one file only."""

from __future__ import annotations

from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]


def test_license_copy_matches_repo_license():
    # Packaging metadata can only reference files under backend/ (PEP 639),
    # so backend/LICENSE is a copy of the repository LICENSE.
    repo_license = BACKEND.parent / "LICENSE"
    assert (BACKEND / "LICENSE").read_text() == repo_license.read_text()


def test_build_hook_and_server_agree_on_bundle_location():
    import openkb_web.main as main

    hook_source = (BACKEND / "hatch_build.py").read_text()
    relative = main._PACKAGED_FRONTEND.relative_to(BACKEND).as_posix()
    assert f'PACKAGED_FRONTEND = "{relative}"' in hook_source
