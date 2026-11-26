"""/api/auth — browser sign-in for the optional access token.

All three endpoints answer without credentials (the login screen needs them)
and reveal only whether a token is required and whether this browser holds a
session. Login and logout are POSTs, so the CSRF guard rejects them when a
browser sends them from a foreign origin. See openkb_web.auth for the scheme.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response

from openkb_web.auth import (
    COOKIE_PATH,
    SESSION_COOKIE,
    TokenAuth,
    throttled_response,
)

router = APIRouter()

# Generous for {"token": "..."}; this endpoint is reachable without
# credentials, so the body is read in bounded chunks instead of all at once.
_MAX_LOGIN_BODY = 4096


def _auth(request: Request) -> TokenAuth | None:
    return request.app.state.auth


async def _read_bounded_body(request: Request) -> bytes:
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > _MAX_LOGIN_BODY:
            raise HTTPException(status_code=413, detail="Request body too large")
        chunks.append(chunk)
    return b"".join(chunks)


def _cookie_options(request: Request) -> dict[str, Any]:
    # Secure only when the browser reached us over https (a TLS-terminating
    # proxy on loopback sets X-Forwarded-Proto, which uvicorn honours); on
    # plain http a Secure cookie would never be sent back.
    return {
        "path": COOKIE_PATH,
        "httponly": True,
        "samesite": "strict",
        "secure": request.url.scheme == "https",
    }


@router.get("/auth/session")
async def get_session(request: Request) -> dict[str, bool]:
    """Whether a token is required, and whether this browser's session cookie
    is valid (bearer tokens are not checked here)."""
    auth = _auth(request)
    if auth is None:
        return {"auth_required": False, "authenticated": False}
    return {
        "auth_required": True,
        "authenticated": auth.session_valid(request.cookies.get(SESSION_COOKIE)),
    }


@router.post("/auth/login", status_code=204)
async def login(request: Request) -> Response:
    """Exchange the token for an HttpOnly session cookie. Body:
    ``{"token": "..."}``."""
    auth = _auth(request)
    if auth is None:
        raise HTTPException(
            status_code=400, detail="Token authentication is not enabled on this server"
        )
    try:
        payload = json.loads(await _read_bounded_body(request))
    except ValueError:
        payload = None
    token = payload.get("token") if isinstance(payload, dict) else None
    if not isinstance(token, str):
        raise HTTPException(status_code=400, detail='Expected a JSON body {"token": "..."}')

    client = request.client.host if request.client else "unknown"
    verdict = await auth.verify(token, client)
    if verdict == "throttled":
        return throttled_response(auth.retry_after())
    if verdict == "invalid":
        raise HTTPException(status_code=401, detail="Invalid token")

    # A fresh id on every sign-in; drop the one this browser had, if any.
    auth.end_session(request.cookies.get(SESSION_COOKIE))
    response = Response(status_code=204)
    response.set_cookie(
        SESSION_COOKIE,
        auth.create_session(),
        max_age=int(auth.session_ttl),
        **_cookie_options(request),
    )
    return response


@router.post("/auth/logout", status_code=204)
async def logout(request: Request) -> Response:
    """End this browser's session (server side) and clear its cookie."""
    auth = _auth(request)
    if auth is not None:
        auth.end_session(request.cookies.get(SESSION_COOKIE))
    response = Response(status_code=204)
    response.delete_cookie(SESSION_COOKIE, **_cookie_options(request))
    return response
