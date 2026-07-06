"""Wiki page enumeration, frontmatter split, wikilink resolution.

Wikilink semantics reproduce OpenKB's own lint/fix pipeline exactly:
``_WIKILINK_RE`` match, alias split on the first ``|``, exact match against
``list_existing_wiki_targets``, then fuzzy match via ``build_norm_index``.
``_WIKILINK_RE`` / ``_normalize_target`` are private openkb helpers — the
``openkb==0.4.3`` pin matters.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from openkb import frontmatter
from openkb.lint import (
    _WIKILINK_RE,
    _normalize_target,
    build_norm_index,
    list_existing_wiki_targets,
)
from openkb.schema import PAGE_CONTENT_DIRS

# Kinds enumerated as browsable wiki pages. sources/ is content, not pages;
# AGENTS.md / SCHEMA.md / log.md are meta files; reports/ are lint artifacts.
PAGE_KINDS: tuple[str, ...] = tuple(PAGE_CONTENT_DIRS) + ("explorations",)


def _is_page_file(path: Path) -> bool:
    # Atomic writes leave transient ".{name}.{rand}.tmp" files in wiki dirs.
    return path.suffix == ".md" and not path.name.startswith(".")


def _str_or(value: Any, default: str) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else default


def _page_summary(path: Path, kind: str, slug: str) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    fm = frontmatter.parse(text)
    target = "index" if kind == "index" else f"{kind}/{slug}"
    return {
        "kind": kind,
        "slug": slug,
        "target": target,
        "title": _str_or(fm.get("title"), slug),
        "description": _str_or(fm.get("description"), ""),
        "mtime": path.stat().st_mtime,
    }


def list_pages(wiki_dir: Path) -> list[dict[str, Any]]:
    """Enumerate browsable pages from the filesystem (index.md can drift)."""
    pages: list[dict[str, Any]] = []
    for kind in PAGE_KINDS:
        d = wiki_dir / kind
        if not d.is_dir():
            continue  # explorations/ is created lazily
        for p in sorted(d.glob("*.md")):
            if _is_page_file(p):
                pages.append(_page_summary(p, kind, p.stem))
    index_md = wiki_dir / "index.md"
    if index_md.is_file():
        pages.append(_page_summary(index_md, "index", "index"))
    return pages


def parse_target(target: str) -> tuple[str, str] | None:
    """Split a page target into (kind, slug); None when malformed/unsafe."""
    if target == "index":
        return "index", "index"
    kind, sep, slug = target.partition("/")
    if not sep or kind not in PAGE_KINDS:
        return None
    if not slug or "/" in slug or slug in (".", "..") or slug.startswith("."):
        return None
    return kind, slug


def resolve_wikilinks(text: str, wiki_dir: Path) -> list[dict[str, Any]]:
    """Resolve every [[wikilink]] in *text*; unresolved links get target=None."""
    known = list_existing_wiki_targets(wiki_dir)
    norm_index = build_norm_index(known)
    links: list[dict[str, Any]] = []
    for raw in _WIKILINK_RE.findall(text):
        target_part, sep, alias_part = raw.partition("|")
        raw_target = target_part.strip()
        alias = alias_part.strip() if sep else None
        if raw_target in known:
            resolved: str | None = raw_target
        else:
            resolved = norm_index.get(_normalize_target(raw_target))
        links.append({"raw": raw, "target": resolved, "alias": alias})
    return links


def read_page(wiki_dir: Path, target: str) -> dict[str, Any] | None:
    """Full page payload for GET /api/pages/{target}; None when missing."""
    parsed = parse_target(target)
    if parsed is None:
        return None
    kind, slug = parsed
    path = wiki_dir / "index.md" if kind == "index" else wiki_dir / kind / f"{slug}.md"
    if not path.is_file():
        return None
    text = path.read_text(encoding="utf-8")
    parts = frontmatter.split(text)
    body = parts[1] if parts else text
    return {
        "target": "index" if kind == "index" else f"{kind}/{slug}",
        "kind": kind,
        "slug": slug,
        "frontmatter": frontmatter.parse(text),
        "body": body,
        "mtime": path.stat().st_mtime,
        # Resolved against the body only — that is what the renderer links up.
        "wikilinks": resolve_wikilinks(body, wiki_dir),
    }
