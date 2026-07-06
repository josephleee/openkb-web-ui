"""/api/jobs — registry listing and per-job SSE progress streams."""

from __future__ import annotations

from typing import Any, AsyncIterator

from fastapi import APIRouter, HTTPException, Request

from openkb_web.chat_stream import sse_event, sse_response
from openkb_web.jobqueue import Job, JobQueue

router = APIRouter()


def _get_job(request: Request, job_id: str) -> tuple[JobQueue, Job]:
    queue: JobQueue = request.app.state.jobqueue
    job = queue.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {job_id}")
    return queue, job


@router.get("/jobs")
async def get_jobs(request: Request) -> list[dict[str, Any]]:
    return request.app.state.jobqueue.list_jobs()


@router.get("/jobs/{job_id}")
async def get_job(job_id: str, request: Request) -> dict[str, Any]:
    _, job = _get_job(request, job_id)
    return job.to_dict()


@router.get("/jobs/{job_id}/events")
async def get_job_events(job_id: str, request: Request):
    queue, job = _get_job(request, job_id)

    async def generate() -> AsyncIterator[str]:
        # Reconnect-safe: subscribe() replays the buffered lines first.
        replay, live = queue.subscribe(job)
        try:
            for event in replay:
                yield sse_event(event)
            if live is None:  # job already terminal
                return
            while True:
                event = await live.get()
                yield sse_event(event)
                if event["type"] == "done":
                    return
        finally:
            if live is not None:
                job.subscribers.discard(live)

    return sse_response(generate())
