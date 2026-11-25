"""TEMPORARY runtime guard for the pinned openkb (0.4.x): bound ``parse_pages``.

``openkb.agent.tools.parse_pages`` expands every ``a-b`` range into a set of
page numbers (``result.update(range(start, end + 1))``) before anything checks
the size. The chat agent's ``get_page_content`` tool (openkb.agent.query ->
``get_wiki_page_content`` -> ``parse_pages``) passes it a page spec chosen by
the LLM, and that agent serves /api/chat and /api/query. So a prompt-injected
document (e.g. an ingested URL) can get the agent to ask for
``1-99999999999`` and run this server out of memory, the same crash the
/api/documents/{doc}/source endpoint had.

``install_parse_pages_guard()`` swaps the module attribute for a wrapper that
sizes the spec arithmetically first and returns ``[]`` (no pages, which
parse_pages' tolerant contract already allows) when it covers more than
MAX_PARSE_PAGES pages. Every other spec goes to the original unchanged.
``get_wiki_page_content`` looks ``parse_pages`` up as a module global at call
time, so patching the attribute covers it.

Fail-safe: if openkb's internals have moved, it logs a warning and leaves
openkb alone instead of breaking startup. Delete this module once openkb bounds
``parse_pages`` itself.
"""

from __future__ import annotations

import contextlib
import functools
import importlib
import logging

logger = logging.getLogger(__name__)

# Most pages one spec may select. The same limit PageIndex's own parse_pages
# enforces, far above what an agent needs from a single tool call.
MAX_PARSE_PAGES = 1000

_TARGET_MODULE = "openkb.agent.tools"
_GUARD_MARKER = "_openkb_web_guarded"


def _requested_span(pages: str) -> int:
    """Pages the original parse_pages would expand ``pages`` into, counted
    without expanding anything. Mirrors its parsing: only an ``a-b`` part
    (exactly one ``-``, both ends int()-able) expands to a range; every
    other part adds at most one number."""
    total = 0
    for part in pages.split(","):
        segments = part.strip().split("-")
        if len(segments) == 2:
            with contextlib.suppress(ValueError):
                total += max(0, int(segments[1]) - int(segments[0]) + 1)
        else:
            total += 1
    return total


def install_parse_pages_guard() -> bool:
    """Wrap openkb's parse_pages once per process. Returns whether the guard is
    active; never raises."""
    try:
        tools = importlib.import_module(_TARGET_MODULE)
        original = tools.parse_pages
    except (ImportError, AttributeError) as exc:
        logger.warning(
            "%s.parse_pages not found (%s); page-range guard not installed. "
            "Check whether openkb still needs it.",
            _TARGET_MODULE,
            exc,
        )
        return False
    if getattr(original, _GUARD_MARKER, False):
        return True
    if not callable(original):
        logger.warning(
            "%s.parse_pages is not callable; page-range guard not installed.",
            _TARGET_MODULE,
        )
        return False

    @functools.wraps(original)
    def bounded_parse_pages(pages):
        if isinstance(pages, str):
            span = _requested_span(pages)
            if span > MAX_PARSE_PAGES:
                logger.warning(
                    "Refusing page spec covering %d pages (max %d): %.60r",
                    span,
                    MAX_PARSE_PAGES,
                    pages,
                )
                return []
        return original(pages)

    setattr(bounded_parse_pages, _GUARD_MARKER, True)
    tools.parse_pages = bounded_parse_pages
    return True
