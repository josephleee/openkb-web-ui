"""Shared test helpers (the tests directory is not a package; pytest puts it
on sys.path, so test modules do `import helpers`)."""

from __future__ import annotations

import asyncio
import json
import time
from types import SimpleNamespace
from typing import Any, Callable

from agents.stream_events import RawResponsesStreamEvent, RunItemStreamEvent
from openai.types.responses import ResponseTextDeltaEvent

TERMINAL_STATES = {"succeeded", "failed", "skipped"}


def parse_sse(body: str) -> list[dict[str, Any]]:
    """Decode `data: {...}` SSE payload lines from a buffered response body."""
    return [
        json.loads(line[len("data: ") :])
        for line in body.splitlines()
        if line.startswith("data: ")
    ]


async def wait_for_job(client, job_id: str, state: str, timeout: float = 10.0) -> dict:
    """Poll GET /api/jobs/{id} until the job reaches *state*."""
    deadline = time.monotonic() + timeout
    last: dict = {}
    while time.monotonic() < deadline:
        resp = await client.get(f"/api/jobs/{job_id}")
        assert resp.status_code == 200
        last = resp.json()
        if last["state"] == state:
            return last
        if state not in TERMINAL_STATES and last["state"] in TERMINAL_STATES:
            break  # job finished without ever being observed in *state*
        await asyncio.sleep(0.02)
    raise AssertionError(f"job {job_id} never reached {state!r}; last seen: {last}")


# --- Fakes for the agents-SDK streaming layer (chat / query SSE tests) ------


def text_delta(delta: str, seq: int = 0) -> RawResponsesStreamEvent:
    """A real RawResponsesStreamEvent wrapping a real ResponseTextDeltaEvent
    (stream_agent_events dispatches on isinstance)."""
    return RawResponsesStreamEvent(
        data=ResponseTextDeltaEvent(
            content_index=0,
            delta=delta,
            item_id="msg_1",
            logprobs=[],
            output_index=0,
            sequence_number=seq,
            type="response.output_text.delta",
        )
    )


def tool_call(name: str, arguments: str) -> RunItemStreamEvent:
    item = SimpleNamespace(
        type="tool_call_item",
        raw_item=SimpleNamespace(name=name, arguments=arguments),
    )
    return RunItemStreamEvent(name="tool_called", item=item)


def ignored_raw_event() -> RawResponsesStreamEvent:
    """A raw event whose data is not a text delta — must be dropped."""
    return RawResponsesStreamEvent(data=SimpleNamespace(type="response.created"))


def ignored_item_event() -> RunItemStreamEvent:
    """A run-item event that is not a tool call — must be dropped."""
    return RunItemStreamEvent(
        name="tool_output", item=SimpleNamespace(type="tool_call_output_item")
    )


class FakeStreamedResult:
    """Stand-in for Runner.run_streamed()'s RunResultStreaming."""

    def __init__(
        self,
        events: list[Any],
        *,
        history: list[dict] | None = None,
        final_output: str = "",
        error: BaseException | None = None,
        gate: asyncio.Event | None = None,
        started: asyncio.Event | None = None,
    ):
        self._events = list(events)
        self._history = history if history is not None else []
        self.final_output = final_output
        self._error = error
        self._gate = gate
        self._started = started

    async def stream_events(self):
        if self._started is not None:
            self._started.set()
        for event in self._events:
            yield event
        if self._gate is not None:
            await self._gate.wait()
        if self._error is not None:
            raise self._error

    def to_input_list(self) -> list[dict]:
        return list(self._history)


def install_fake_runner(
    monkeypatch, factory: Callable[[], FakeStreamedResult]
) -> list[SimpleNamespace]:
    """Replace the Runner used by stream_agent_events; returns the call log."""
    import openkb_web.chat_stream as chat_stream

    calls: list[SimpleNamespace] = []

    class FakeRunner:
        @staticmethod
        def run_streamed(agent, input_items, max_turns=None):
            calls.append(
                SimpleNamespace(agent=agent, input_items=input_items, max_turns=max_turns)
            )
            return factory()

    monkeypatch.setattr(chat_stream, "Runner", FakeRunner)
    return calls
