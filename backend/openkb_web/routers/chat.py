"""/api/chat/sessions — session CRUD + streaming messages, and /api/query."""

from __future__ import annotations

import re
from typing import Any, AsyncIterator

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from openkb.agent.chat_session import (
    ChatSession,
    chats_dir,
    delete_session,
    list_sessions,
    load_session,
)
from openkb.agent.query import build_chat_agent, build_query_agent

from openkb_web.chat_stream import sse_response, stream_agent_events

router = APIRouter()

# Session ids are "YYYYMMDD-HHMMSS-<3 alnum>"; the id becomes a filename under
# .openkb/chats/, so reject anything that could traverse.
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


class MessageIn(BaseModel):
    message: str


class QueryIn(BaseModel):
    question: str


class SessionCreateIn(BaseModel):
    model: str | None = None
    language: str | None = None


def _check_session_id(session_id: str) -> str:
    if not _SESSION_ID_RE.match(session_id):
        raise HTTPException(status_code=400, detail=f"Invalid session id: {session_id!r}")
    return session_id


def _session_detail(session: ChatSession) -> dict[str, Any]:
    return {
        "id": session.id,
        "title": session.title,
        "model": session.model,
        "language": session.language,
        "created_at": session.created_at,
        "updated_at": session.updated_at,
        "turns": [
            {"user": user, "assistant": assistant}
            for user, assistant in zip(session.user_turns, session.assistant_texts)
        ],
    }


async def _load_session_or_404(request: Request, session_id: str) -> ChatSession:
    kb = request.app.state.kb
    _check_session_id(session_id)
    if not (chats_dir(kb.kb_dir) / f"{session_id}.json").is_file():
        raise HTTPException(status_code=404, detail=f"Unknown session: {session_id}")
    try:
        return await run_in_threadpool(load_session, kb.kb_dir, session_id)
    except (FileNotFoundError, ValueError, KeyError) as exc:
        raise HTTPException(status_code=404, detail=f"Cannot load session: {exc}")


@router.get("/chat/sessions")
async def get_sessions(request: Request) -> list[dict[str, Any]]:
    kb = request.app.state.kb
    return await run_in_threadpool(list_sessions, kb.kb_dir)


@router.post("/chat/sessions", status_code=201)
async def create_session(
    request: Request, body: SessionCreateIn | None = None
) -> dict[str, Any]:
    kb = request.app.state.kb

    def create() -> ChatSession:
        config = kb.load_config()
        model = (body.model if body else None) or config.get("model", "gpt-5.4")
        language = (body.language if body else None) or config.get("language", "en")
        session = ChatSession.new(kb.kb_dir, model, language)
        session.save()
        return session

    return _session_detail(await run_in_threadpool(create))


@router.get("/chat/sessions/{session_id}")
async def get_session(session_id: str, request: Request) -> dict[str, Any]:
    session = await _load_session_or_404(request, session_id)
    return _session_detail(session)


@router.delete("/chat/sessions/{session_id}", status_code=204)
async def remove_session(session_id: str, request: Request) -> None:
    kb = request.app.state.kb
    _check_session_id(session_id)
    deleted = await run_in_threadpool(delete_session, kb.kb_dir, session_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Unknown session: {session_id}")


@router.post("/chat/sessions/{session_id}/messages")
async def post_message(session_id: str, body: MessageIn, request: Request):
    kb = request.app.state.kb
    message = body.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="Message must not be empty")

    session = await _load_session_or_404(request, session_id)

    # record_turn replaces the whole stored history; concurrent turns on one
    # session would clobber each other, so a session runs one turn at a time.
    inflight: set[str] = request.app.state.chat_inflight
    if session_id in inflight:
        raise HTTPException(
            status_code=409, detail="A turn is already running for this session"
        )
    inflight.add(session_id)

    try:
        # Rebuild per turn with the session's stored model (CLI resume semantics).
        agent = await run_in_threadpool(
            build_chat_agent, kb.kb_dir, session.model, session.language
        )
    except BaseException:
        inflight.discard(session_id)
        raise

    input_items = session.history + [{"role": "user", "content": message}]

    async def on_complete(answer: str, result: Any) -> None:
        await run_in_threadpool(session.record_turn, message, answer, result.to_input_list())

    async def generate() -> AsyncIterator[str]:
        try:
            async for chunk in stream_agent_events(agent, input_items, on_complete):
                yield chunk
        finally:
            inflight.discard(session_id)

    return sse_response(generate())


@router.post("/query")
async def post_query(body: QueryIn, request: Request):
    kb = request.app.state.kb
    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question must not be empty")

    def build() -> Any:
        config = kb.load_config()
        return build_query_agent(
            str(kb.wiki_dir),
            config.get("model", "gpt-5.4"),
            language=config.get("language", "en"),
        )

    agent = await run_in_threadpool(build)
    return sse_response(stream_agent_events(agent, question))
