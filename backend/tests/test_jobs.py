"""Job queue behavior via a fake `openkb` executable: outcome classification
for all four marker cases, SSE line streaming, serialization, remove-plan."""

from __future__ import annotations

import asyncio
from pathlib import Path

from helpers import parse_sse, wait_for_job


async def _upload(client, filename: str, content: bytes = b"# doc\n") -> str:
    resp = await client.post(
        "/api/documents/upload", files={"file": (filename, content, "text/markdown")}
    )
    assert resp.status_code == 202
    return resp.json()["job_id"]


def _uploads_root(kb_dir: Path) -> Path:
    return kb_dir / ".openkb-web-uploads"


# --- outcome classification ----------------------------------------------------


async def test_add_success_with_ok_marker(client, fake_openkb, kb_dir: Path):
    job_id = await _upload(client, "notes.md")

    resp = await client.get(f"/api/jobs/{job_id}/events")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    events = parse_sse(resp.text)

    # State transitions arrive first (replay snapshot or live), done last.
    assert events[0]["type"] == "state"
    assert events[0]["state"] in ("queued", "running")
    assert events[-1] == {
        "type": "done",
        "state": "succeeded",
        "detail": events[-1]["detail"],
    }
    assert "[OK]" in events[-1]["detail"] and "added" in events[-1]["detail"]

    lines = [e["line"] for e in events if e["type"] == "line"]
    assert any(l.startswith("Adding: ") for l in lines)

    # Spinner dot runs (>=4 dots) are collapsed to a "..." heartbeat.
    spinner = next(l for l in lines if "Compiling short doc" in l)
    assert spinner == "    Compiling short doc... 12.3s (in=100, out=50, cached=0)"

    job = (await client.get(f"/api/jobs/{job_id}")).json()
    assert job["state"] == "succeeded"
    assert job["kind"] == "add"
    assert job["label"] == "Add notes.md"
    assert job["started_at"] is not None and job["finished_at"] is not None

    # Upload is staged at a stable path keyed by filename (not a per-upload
    # dir) so a re-upload overwrites the same OpenKB document in place; it is
    # kept rather than deleted on success.
    assert (_uploads_root(kb_dir) / "notes.md").is_file()


async def test_upload_staging_path_is_stable_per_filename(client, fake_openkb, kb_dir: Path):
    """Re-uploading the same filename must reuse the same staged path so
    OpenKB (which keys identity by source path) overwrites in place."""
    await wait_for_job(client, await _upload(client, "paper.md", b"# v1\n"), "succeeded")
    await wait_for_job(client, await _upload(client, "paper.md", b"# v2 edited\n"), "succeeded")

    staged = [p for p in _uploads_root(kb_dir).iterdir() if not p.name.startswith(".")]
    assert staged == [_uploads_root(kb_dir) / "paper.md"]
    assert (_uploads_root(kb_dir) / "paper.md").read_text() == "# v2 edited\n"


async def test_add_skip_marker(client, fake_openkb, kb_dir: Path):
    job_id = await _upload(client, "skipme.md")
    events = parse_sse((await client.get(f"/api/jobs/{job_id}/events")).text)

    assert events[-1]["state"] == "skipped"
    assert "[SKIP]" in events[-1]["detail"]


async def test_add_error_marker_despite_exit_zero(client, fake_openkb, kb_dir: Path):
    job_id = await _upload(client, "failing.md")
    events = parse_sse((await client.get(f"/api/jobs/{job_id}/events")).text)

    assert events[-1]["state"] == "failed"
    assert "[ERROR]" in events[-1]["detail"]

    # Upload kept on failure for inspection/retry, at its stable path.
    assert (_uploads_root(kb_dir) / "failing.md").is_file()


async def test_add_nonzero_exit_without_markers(client, fake_openkb):
    job_id = await _upload(client, "crash.md")
    events = parse_sse((await client.get(f"/api/jobs/{job_id}/events")).text)

    assert events[-1]["state"] == "failed"
    assert "exited with code 3" in events[-1]["detail"]
    # The torn final stdout line (no trailing newline) is still streamed.
    lines = [e["line"] for e in events if e["type"] == "line"]
    assert "torn final line without newline" in lines


async def test_remove_no_match_output_classified_failed(client, fake_openkb):
    """remove prints 'No document matching' and exits 0 — must classify failed."""
    resp = await client.post("/api/documents/ghost-doc/remove")
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]

    job = await wait_for_job(client, job_id, "failed")
    assert "No document matching" in job["detail"]


async def test_recompile_done_line(client, fake_openkb):
    resp = await client.post("/api/documents/demo-paper/recompile")
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]

    job = await wait_for_job(client, job_id, "succeeded")
    assert job["kind"] == "recompile"
    assert job["detail"] == "Done: recompiled 1, skipped 0."


async def test_recompile_skip_not_reported_succeeded(client, fake_openkb):
    """A recompile that skipped everything prints '[SKIP]' + 'Done: recompiled
    0, skipped 1.' and exits 0 — the trailing Done: line must not mask it."""
    resp = await client.post("/api/documents/legacy-doc/recompile")
    job_id = resp.json()["job_id"]

    job = await wait_for_job(client, job_id, "skipped")
    assert "[SKIP]" in job["detail"]


async def test_recompile_multiple_match_classified_failed(client, fake_openkb):
    """recompile prints 'matches multiple documents' and exits 0 — classify failed."""
    resp = await client.post("/api/documents/multi-doc/recompile")
    job_id = resp.json()["job_id"]

    job = await wait_for_job(client, job_id, "failed")
    assert "matches multiple documents" in job["detail"]


async def test_remove_multiple_match_classified_failed(client, fake_openkb):
    """remove (non-dry) prints 'matches multiple documents' and exits 0 with no
    [OK] marker — classify failed rather than silently succeeded."""
    resp = await client.post("/api/documents/multi-doc/remove")
    job_id = resp.json()["job_id"]

    job = await wait_for_job(client, job_id, "failed")
    assert "matches multiple documents" in job["detail"]


async def test_remove_job_args_and_keep_raw(app, client, fake_openkb):
    resp = await client.post(
        "/api/documents/demo-paper/remove", json={"keep_raw": True}
    )
    job_id = resp.json()["job_id"]
    assert app.state.jobqueue.get(job_id).args == [
        "remove",
        "demo-paper",
        "--yes",
        "--keep-raw",
    ]

    resp = await client.post("/api/documents/demo-paper/remove")
    plain_id = resp.json()["job_id"]
    assert app.state.jobqueue.get(plain_id).args == ["remove", "demo-paper", "--yes"]

    await wait_for_job(client, job_id, "succeeded")
    await wait_for_job(client, plain_id, "succeeded")


# --- serialization & registry ----------------------------------------------------


async def test_second_job_queued_while_first_runs(client, fake_openkb, monkeypatch):
    monkeypatch.setenv("FAKE_OPENKB_SLEEP", "0.6")
    first = await _upload(client, "sleepy.md")
    await wait_for_job(client, first, "running")

    second = await _upload(client, "notes.md")
    assert (await client.get(f"/api/jobs/{second}")).json()["state"] == "queued"

    status = (await client.get("/api/status")).json()
    assert status["busy"] is True

    # Streaming the second job's events resolves only after the first finishes.
    events = parse_sse((await client.get(f"/api/jobs/{second}/events")).text)
    assert events[-1]["state"] == "succeeded"

    first_job = (await client.get(f"/api/jobs/{first}")).json()
    second_job = (await client.get(f"/api/jobs/{second}")).json()
    assert first_job["state"] == "succeeded"
    assert first_job["finished_at"] <= second_job["started_at"]

    status = (await client.get("/api/status")).json()
    assert status["busy"] is False


async def test_jobs_list_newest_first(client, fake_openkb):
    first = await _upload(client, "one.md")
    second = await _upload(client, "two.md")
    ids = [j["id"] for j in (await client.get("/api/jobs")).json()]
    assert ids.index(second) < ids.index(first)
    await wait_for_job(client, second, "succeeded")


async def test_events_replay_after_completion(client, fake_openkb):
    job_id = await _upload(client, "notes.md")
    live = parse_sse((await client.get(f"/api/jobs/{job_id}/events")).text)

    replay = parse_sse((await client.get(f"/api/jobs/{job_id}/events")).text)
    assert replay[-1]["type"] == "done"
    assert replay[-1]["state"] == "succeeded"
    # Every stdout line seen live is replayed for reconnecting clients.
    assert [e for e in live if e["type"] == "line"] == [
        e for e in replay if e["type"] == "line"
    ]


async def test_job_404(client):
    assert (await client.get("/api/jobs/nope")).status_code == 404
    assert (await client.get("/api/jobs/nope/events")).status_code == 404


# --- remove-plan (synchronous dry run) --------------------------------------------


async def test_remove_plan_parses_action_lines(client, fake_openkb):
    resp = await client.post("/api/documents/demo-paper/remove-plan")
    assert resp.status_code == 200
    plan = resp.json()

    assert [p["action"] for p in plan] == [
        "DELETE",
        "DELETE",
        "MODIFY",
        "REGISTRY",
        "PAGEINDEX",
    ]
    assert plan[0]["target"] == "wiki/summaries/demo-paper.md"
    assert plan[2]["target"] == (
        "wiki/concepts/attention-mechanism.md  (drop this doc from sources)"
    )


async def test_remove_plan_no_match_404(client, fake_openkb):
    resp = await client.post("/api/documents/ghost-doc/remove-plan")
    assert resp.status_code == 404
    assert "No document matching" in resp.json()["detail"]


async def test_remove_plan_ambiguous_409(client, fake_openkb):
    resp = await client.post("/api/documents/ambig/remove-plan")
    assert resp.status_code == 409
    assert "matches multiple" in resp.json()["detail"]


async def test_remove_plan_busy_409(client, fake_openkb, monkeypatch):
    monkeypatch.setenv("FAKE_OPENKB_SLEEP", "0.6")
    job_id = await _upload(client, "sleepy.md")

    resp = await client.post("/api/documents/demo-paper/remove-plan")
    assert resp.status_code == 409
    assert "busy" in resp.json()["detail"]

    await wait_for_job(client, job_id, "succeeded")


async def test_remove_plan_timeout_504(client, fake_openkb, monkeypatch):
    import openkb_web.routers.documents as documents

    monkeypatch.setattr(documents, "REMOVE_PLAN_TIMEOUT", 0.1)
    resp = await client.post("/api/documents/slowplan/remove-plan")
    assert resp.status_code == 504
