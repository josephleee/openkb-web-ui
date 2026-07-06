"""Chat session CRUD against real chat_session files + SSE streaming with a
mocked Runner.run_streamed layer, and /api/query."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from helpers import (
    FakeStreamedResult,
    ignored_item_event,
    ignored_raw_event,
    install_fake_runner,
    parse_sse,
    text_delta,
    tool_call,
)


@pytest.fixture
def session_id(kb_dir: Path) -> str:
    files = list((kb_dir / ".openkb" / "chats").glob("*.json"))
    assert len(files) == 1
    return files[0].stem


def _session_file(kb_dir: Path, session_id: str) -> dict:
    path = kb_dir / ".openkb" / "chats" / f"{session_id}.json"
    return json.loads(path.read_text(encoding="utf-8"))


# --- sessions CRUD ---------------------------------------------------------------


async def test_list_sessions(client, session_id):
    resp = await client.get("/api/chat/sessions")
    assert resp.status_code == 200
    sessions = resp.json()
    assert len(sessions) == 1
    assert sessions[0] == {
        "id": session_id,
        "title": "What is the attention mechanism?",
        "turn_count": 1,
        "updated_at": sessions[0]["updated_at"],
        "model": "gpt-5.4",
    }


async def test_get_session_detail_zips_turns(client, session_id):
    resp = await client.get(f"/api/chat/sessions/{session_id}")
    assert resp.status_code == 200
    detail = resp.json()

    assert set(detail) == {
        "id",
        "title",
        "model",
        "language",
        "created_at",
        "updated_at",
        "turns",
    }
    assert detail["id"] == session_id
    assert detail["language"] == "en"
    assert len(detail["turns"]) == 1
    turn = detail["turns"][0]
    assert turn["user"] == "What is the attention mechanism?"
    assert turn["assistant"].startswith("The [[concepts/attention-mechanism]]")
    assert "history" not in detail  # stays opaque


async def test_create_session_defaults_from_config(client, kb_dir: Path):
    resp = await client.post("/api/chat/sessions")
    assert resp.status_code == 201
    detail = resp.json()

    assert detail["model"] == "gpt-5.4"
    assert detail["language"] == "en"
    assert detail["turns"] == []
    assert detail["title"] == ""
    # Persisted by OpenKB itself under .openkb/chats/.
    path = kb_dir / ".openkb" / "chats" / f"{detail['id']}.json"
    assert path.is_file()
    assert json.loads(path.read_text())["model"] == "gpt-5.4"


async def test_create_session_with_overrides(client, kb_dir: Path):
    resp = await client.post(
        "/api/chat/sessions",
        json={"model": "anthropic/claude-sonnet-4-6", "language": "ko"},
    )
    assert resp.status_code == 201
    detail = resp.json()
    assert detail["model"] == "anthropic/claude-sonnet-4-6"
    assert detail["language"] == "ko"
    assert _session_file(kb_dir, detail["id"])["language"] == "ko"


async def test_delete_session(client, kb_dir: Path, session_id):
    resp = await client.delete(f"/api/chat/sessions/{session_id}")
    assert resp.status_code == 204
    assert not (kb_dir / ".openkb" / "chats" / f"{session_id}.json").exists()

    resp = await client.delete(f"/api/chat/sessions/{session_id}")
    assert resp.status_code == 404


async def test_session_id_validation_and_404(client):
    resp = await client.get("/api/chat/sessions/no-such-session")
    assert resp.status_code == 404
    resp = await client.get("/api/chat/sessions/bad.id")
    assert resp.status_code == 400
    resp = await client.delete("/api/chat/sessions/bad.id")
    assert resp.status_code == 400


# --- chat message SSE ---------------------------------------------------------------


async def test_chat_message_stream_and_persistence(
    client, kb_dir: Path, session_id, monkeypatch
):
    old = _session_file(kb_dir, session_id)
    new_history = old["history"] + [
        {"role": "user", "content": "And multi-head attention?"},
        {"role": "assistant", "content": "Attention is key."},
    ]
    events = [
        tool_call("read_file", '{"path": "index.md"}'),
        ignored_raw_event(),
        text_delta("Attention ", 0),
        ignored_item_event(),
        text_delta("is key.", 1),
    ]
    calls = install_fake_runner(
        monkeypatch, lambda: FakeStreamedResult(events, history=new_history)
    )

    resp = await client.post(
        f"/api/chat/sessions/{session_id}/messages",
        json={"message": "And multi-head attention?"},
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")

    sse = parse_sse(resp.text)
    assert sse == [
        {"type": "tool_call", "name": "read_file", "arguments": '{"path": "index.md"}'},
        {"type": "text_delta", "delta": "Attention "},
        {"type": "text_delta", "delta": "is key."},
        {"type": "done", "answer": "Attention is key."},
    ]

    # The agent got the stored history plus the new user message.
    assert len(calls) == 1
    assert calls[0].input_items == old["history"] + [
        {"role": "user", "content": "And multi-head attention?"}
    ]

    # record_turn persisted into the session JSON after the done event.
    saved = _session_file(kb_dir, session_id)
    assert saved["turn_count"] == 2
    assert saved["user_turns"][-1] == "And multi-head attention?"
    assert saved["assistant_texts"][-1] == "Attention is key."
    assert saved["history"] == new_history
    assert saved["title"] == old["title"]  # title set on first turn only


async def test_chat_stream_error_event_and_no_persistence(
    client, kb_dir: Path, session_id, monkeypatch
):
    install_fake_runner(
        monkeypatch,
        lambda: FakeStreamedResult(
            [text_delta("partial", 0)],
            error=RuntimeError("Max turns exceeded"),
        ),
    )

    resp = await client.post(
        f"/api/chat/sessions/{session_id}/messages", json={"message": "boom?"}
    )
    assert resp.status_code == 200
    sse = parse_sse(resp.text)
    assert sse[0] == {"type": "text_delta", "delta": "partial"}
    assert sse[-1] == {"type": "error", "message": "Max turns exceeded"}
    assert not any(e["type"] == "done" for e in sse)

    # Turn is not recorded on error (mirrors CLI interrupt semantics).
    assert _session_file(kb_dir, session_id)["turn_count"] == 1


async def test_chat_concurrent_turn_409(client, session_id, monkeypatch):
    gate = asyncio.Event()
    started = asyncio.Event()
    install_fake_runner(
        monkeypatch,
        lambda: FakeStreamedResult(
            [text_delta("thinking", 0)],
            history=[{"role": "user", "content": "first"}],
            gate=gate,
            started=started,
        ),
    )
    url = f"/api/chat/sessions/{session_id}/messages"

    first = asyncio.create_task(client.post(url, json={"message": "first"}))
    await asyncio.wait_for(started.wait(), timeout=5)

    second = await client.post(url, json={"message": "second"})
    assert second.status_code == 409
    assert "already running" in second.json()["detail"]

    gate.set()
    resp = await first
    assert resp.status_code == 200
    assert parse_sse(resp.text)[-1]["type"] == "done"

    # The in-flight guard is released after the stream completes.
    third = await client.post(url, json={"message": "third"})
    assert third.status_code == 200


async def test_chat_message_validation(client, session_id, monkeypatch):
    resp = await client.post(
        f"/api/chat/sessions/{session_id}/messages", json={"message": "   "}
    )
    assert resp.status_code == 400

    resp = await client.post(
        "/api/chat/sessions/does-not-exist/messages", json={"message": "hi"}
    )
    assert resp.status_code == 404


# --- /api/query ---------------------------------------------------------------------


async def test_query_stream(client, monkeypatch):
    install_fake_runner(
        monkeypatch,
        lambda: FakeStreamedResult(
            [text_delta("42", 0)], history=[], final_output="unused"
        ),
    )
    resp = await client.post("/api/query", json={"question": "What is attention?"})
    assert resp.status_code == 200
    sse = parse_sse(resp.text)
    assert sse == [
        {"type": "text_delta", "delta": "42"},
        {"type": "done", "answer": "42"},
    ]


async def test_query_answer_falls_back_to_final_output(client, monkeypatch):
    install_fake_runner(
        monkeypatch,
        lambda: FakeStreamedResult(
            [tool_call("read_file", "{}")], final_output="From final output"
        ),
    )
    resp = await client.post("/api/query", json={"question": "Q?"})
    sse = parse_sse(resp.text)
    assert sse[-1] == {"type": "done", "answer": "From final output"}


async def test_query_empty_question_400(client):
    resp = await client.post("/api/query", json={"question": "  "})
    assert resp.status_code == 400
