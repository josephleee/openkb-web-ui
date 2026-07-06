"""Agent streaming -> SSE event mapping (spec 4.4).

Chat/query bypass the CLI's ``run_chat``/``run_query`` (hard-wired to
prompt_toolkit/rich terminal rendering) and consume
``Runner.run_streamed(...).stream_events()`` directly.
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator, Awaitable, Callable

from agents import RawResponsesStreamEvent, RunItemStreamEvent, Runner
from openai.types.responses import ResponseTextDeltaEvent
from starlette.responses import StreamingResponse

from openkb.agent.query import MAX_TURNS

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",  # disable proxy buffering (nginx)
    "Connection": "keep-alive",
}


def sse_event(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def sse_response(generator: AsyncIterator[str]) -> StreamingResponse:
    return StreamingResponse(
        generator, media_type="text/event-stream", headers=dict(SSE_HEADERS)
    )


async def stream_agent_events(
    agent: Any,
    input_items: Any,
    on_complete: Callable[[str, Any], Awaitable[None]] | None = None,
) -> AsyncIterator[str]:
    """Yield SSE strings for one streamed agent run.

    Event shapes:
      {"type": "text_delta", "delta": str}
      {"type": "tool_call", "name": str, "arguments": str}
      {"type": "done", "answer": str}
      {"type": "error", "message": str}

    *on_complete(answer, result)* is awaited after the ``done`` event —
    chat uses it to persist the turn via ``session.record_turn``.
    """
    collected: list[str] = []
    try:
        result = Runner.run_streamed(agent, input_items, max_turns=MAX_TURNS)
        async for event in result.stream_events():
            if isinstance(event, RawResponsesStreamEvent):
                if isinstance(event.data, ResponseTextDeltaEvent) and event.data.delta:
                    collected.append(event.data.delta)
                    yield sse_event({"type": "text_delta", "delta": event.data.delta})
            elif isinstance(event, RunItemStreamEvent):
                item = event.item
                if item.type == "tool_call_item":
                    raw_item = item.raw_item
                    name = getattr(raw_item, "name", "?")
                    arguments = getattr(raw_item, "arguments", "") or ""
                    yield sse_event(
                        {"type": "tool_call", "name": name, "arguments": arguments}
                    )
        answer = "".join(collected).strip()
        if not answer:
            answer = (result.final_output or "").strip()
    except Exception as exc:  # incl. MaxTurnsExceeded
        yield sse_event({"type": "error", "message": str(exc) or type(exc).__name__})
        return

    yield sse_event({"type": "done", "answer": answer})

    if on_complete is not None:
        try:
            await on_complete(answer, result)
        except Exception as exc:
            yield sse_event(
                {"type": "error", "message": f"Failed to persist turn: {exc}"}
            )
