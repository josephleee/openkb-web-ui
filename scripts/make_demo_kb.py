#!/usr/bin/env python3
"""Build a realistic synthetic OpenKB knowledge base — no LLM calls, no network.

Replicates the exact on-disk layout OpenKB 0.4.x produces so the web backend,
tests, and E2E runs have something real to serve:

    <dest>/
    ├── .openkb/
    │   ├── config.yaml
    │   ├── hashes.json           # 3 entries incl. one legacy minimal entry
    │   └── chats/<id>.json       # one persisted chat session
    ├── raw/demo-paper.md
    └── wiki/
        ├── AGENTS.md, index.md, log.md
        ├── summaries/*.md  concepts/*.md  entities/*.md  explorations/
        └── sources/{demo-paper.md, transformers-survey.json,
                     images/demo-paper/p1_img0.png}

Conventions honored: JSON-quoted frontmatter values (kv_line style), wiki-root-
relative image links, '## [ts] op | desc' log headings, doc_name as the join
key across hashes.json / raw/ / sources/ / summaries/.

Usage: python scripts/make_demo_kb.py <dest> [--force]

Only stdlib + pyyaml (available in the backend venv via the openkb dependency).
"""

from __future__ import annotations

import argparse
import base64
import json
import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yaml

# A real 1x1 transparent PNG so image-serving code paths get valid bytes.
_TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    "AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)

AGENTS_MD = """\
# Wiki Schema

## Directory Structure
- sources/ — Document content. Short docs as .md, long docs as .json (per-page). Do not modify directly.
- sources/images/ — Extracted images from documents, referenced by sources.
- summaries/ — One per source document. Summary of key content.
- concepts/ — Cross-document topic synthesis. Created when a theme spans multiple documents.
- entities/ — Specific named things: people, organizations, places, products, named works, events. One page per entity, accumulated across documents.
- explorations/ — Saved query results, analyses, and comparisons worth keeping.
- reports/ — Lint health check reports. Auto-generated.

## Special Files
- index.md — Content catalog: every page with link, one-line summary, organized by category.
- log.md — Chronological append-only record of operations (ingests, queries, lints).
"""

INDEX_MD = """\
# Knowledge Base Index

## Documents
- [[summaries/demo-paper]] — Demo paper on attention mechanisms in sequence models. (short)
- [[summaries/transformers-survey]] — Survey of transformer architectures. (pageindex)

## Concepts
- [[concepts/attention-mechanism]] — How models weigh input tokens against each other.
- [[concepts/sequence-modeling]] — Approaches to modeling ordered data.

## Entities
- [[entities/vaswani-et-al]] — Authors of the original transformer paper.

## Explorations
"""

SUMMARY_DEMO_PAPER = """\
---
type: "Summary"
description: "Demo paper introducing scaled dot-product attention for sequence models."
doc_type: short
full_text: "sources/demo-paper.md"
---

# Demo Paper

This paper introduces the [[concepts/attention-mechanism]] as the core building
block for [[concepts/sequence-modeling]] without recurrence.

![image](sources/images/demo-paper/p1_img0.png)

Key results are attributed to [[entities/vaswani-et-al]].
"""

SUMMARY_SURVEY = """\
---
type: "Summary"
description: "Survey of transformer architectures and their applications."
doc_type: pageindex
full_text: "sources/transformers-survey.json"
---

# Transformers Survey (pages 1–42)

## Introduction (pages 1–5)
Summary: surveys the landscape of transformer models built on the
[[concepts/attention-mechanism]].

## Architectures (pages 6–30)
Summary: encoder-only, decoder-only, and encoder–decoder variants for
[[concepts/sequence-modeling]].
"""

CONCEPT_ATTENTION = """\
---
type: "Concept"
description: "How models weigh input tokens against each other."
sources: ["summaries/demo-paper.md", "summaries/transformers-survey.md"]
---

# Attention Mechanism

Attention lets a model attend to all positions of the input at once, replacing
recurrence in [[concepts/sequence-modeling]].

Introduced by [[entities/vaswani-et-al]]; see [[summaries/demo-paper]] for the
canonical formulation. A deeper treatment lives in [[concepts/missing-page]]
(not yet written).

## Related Documents
- [[summaries/demo-paper]]
- [[summaries/transformers-survey]]
"""

CONCEPT_SEQUENCE = """\
---
type: "Concept"
description: "Approaches to modeling ordered data such as text or time series."
sources: ["summaries/demo-paper.md"]
---

# Sequence Modeling

Sequence modeling maps ordered inputs to outputs. Modern approaches rely on the
[[concepts/Attention_Mechanism]] rather than recurrence — note the fuzzy-case
link that OpenKB's normalizer resolves to concepts/attention-mechanism.

## Related Documents
- [[summaries/demo-paper]]
"""

ENTITY_VASWANI = """\
---
type: "Organization"
description: "Research group behind the original transformer paper."
sources: ["summaries/demo-paper.md"]
---

# Vaswani et al.

The research group that introduced the transformer architecture and the
[[concepts/attention-mechanism]].
"""

SOURCE_DEMO_PAPER = """\
# Demo Paper: Attention Is What You Need Here

## Abstract

We propose a demo architecture based entirely on attention mechanisms,
dispensing with recurrence and convolutions entirely.

![image](sources/images/demo-paper/p1_img0.png)

## 1. Introduction

Recurrent models process tokens sequentially, which precludes parallelization.
Attention mechanisms allow modeling of dependencies without regard to their
distance in the input sequence.

## 2. Method

Scaled dot-product attention computes a weighted sum of values, where weights
come from the compatibility of queries with keys.
"""

SURVEY_PAGES = [
    {
        "page": 1,
        "content": (
            "# A Survey of Transformer Architectures\n\n"
            "Transformers have become the dominant architecture for sequence "
            "modeling across modalities."
        ),
        "images": [],
    },
    {
        "page": 2,
        "content": (
            "## 1. Introduction\n\nWe categorize transformer variants into "
            "encoder-only, decoder-only, and encoder-decoder families."
        ),
        "images": [],
    },
    {
        "page": 3,
        "content": (
            "## 2. Attention Variants\n\nSparse, linear, and windowed attention "
            "trade exactness for efficiency."
        ),
        "images": [],
    },
]


def _log_md(now: datetime) -> str:
    def ts(minutes_ago: int) -> str:
        return (now - timedelta(minutes=minutes_ago)).strftime("%Y-%m-%d %H:%M:%S")

    return (
        f"# Operations Log\n\n"
        f"## [{ts(180)}] init | Knowledge base initialized\n\n"
        f"## [{ts(120)}] ingest | demo-paper.md\n\n"
        f"## [{ts(60)}] ingest | transformers-survey.pdf\n\n"
        f"## [{ts(30)}] query | What is attention?\n\n"
        f"## [{ts(5)}] lint | Structural lint: 1 broken link found\n\n"
    )


def _hashes() -> dict:
    return {
        # Short markdown doc: full modern entry.
        "a3f8c1d2e4b5a6978081726354453627181920212223242526272829303132a1": {
            "name": "demo-paper.md",
            "doc_name": "demo-paper",
            "type": "md",
            "path": "raw/demo-paper.md",
            "raw_path": "raw/demo-paper.md",
            "source_path": "wiki/sources/demo-paper.md",
        },
        # Long PDF compiled via PageIndex: has doc_id + pages.
        "b4e9d2c3f5a6b7089192837465564738291021222324252627282930313233b2": {
            "name": "transformers-survey.pdf",
            "doc_name": "transformers-survey",
            "type": "long_pdf",
            "path": "raw/transformers-survey.pdf",
            "source_path": "wiki/sources/transformers-survey.json",
            "doc_id": "pi-demo-0001",
            "pages": 42,
        },
        # Legacy minimal entry (pre-doc_name registry format): just name+type.
        "c5fad3e4a6b7c8190a1b2c3d4e5f60718293a4b5c6d7e8f9012345678990aac3": {
            "name": "old-notes.txt",
            "type": "txt",
        },
    }


def _chat_session(now: datetime) -> tuple[str, dict]:
    created = (now - timedelta(minutes=45)).strftime("%Y-%m-%dT%H:%M:%SZ")
    updated = (now - timedelta(minutes=44)).strftime("%Y-%m-%dT%H:%M:%SZ")
    session_id = (now - timedelta(minutes=45)).strftime("%Y%m%d-%H%M%S") + "-k3x"
    return session_id, {
        "id": session_id,
        "created_at": created,
        "updated_at": updated,
        "model": "gpt-5.4",
        "language": "en",
        "title": "What is the attention mechanism?",
        "turn_count": 1,
        "history": [
            {"role": "user", "content": "What is the attention mechanism?"},
            {
                "role": "assistant",
                "content": (
                    "The [[concepts/attention-mechanism]] lets a model weigh "
                    "input tokens against each other; see "
                    "[[summaries/demo-paper]] for the canonical formulation."
                ),
            },
        ],
        "user_turns": ["What is the attention mechanism?"],
        "assistant_texts": [
            "The [[concepts/attention-mechanism]] lets a model weigh input "
            "tokens against each other; see [[summaries/demo-paper]] for the "
            "canonical formulation."
        ],
    }


def build_demo_kb(dest: Path) -> None:
    now = datetime.now(timezone.utc)
    openkb_dir = dest / ".openkb"
    wiki = dest / "wiki"

    for d in (
        openkb_dir / "chats",
        dest / "raw",
        wiki / "summaries",
        wiki / "concepts",
        wiki / "entities",
        wiki / "explorations",
        wiki / "sources" / "images" / "demo-paper",
    ):
        d.mkdir(parents=True, exist_ok=True)

    (openkb_dir / "config.yaml").write_text(
        yaml.safe_dump(
            {"model": "gpt-5.4", "language": "en", "pageindex_threshold": 20},
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    (openkb_dir / "hashes.json").write_text(
        json.dumps(_hashes(), indent=2) + "\n", encoding="utf-8"
    )

    session_id, session = _chat_session(now)
    (openkb_dir / "chats" / f"{session_id}.json").write_text(
        json.dumps(session, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    (wiki / "AGENTS.md").write_text(AGENTS_MD, encoding="utf-8")
    (wiki / "index.md").write_text(INDEX_MD, encoding="utf-8")
    (wiki / "log.md").write_text(_log_md(now), encoding="utf-8")

    (wiki / "summaries" / "demo-paper.md").write_text(SUMMARY_DEMO_PAPER, encoding="utf-8")
    (wiki / "summaries" / "transformers-survey.md").write_text(
        SUMMARY_SURVEY, encoding="utf-8"
    )
    (wiki / "concepts" / "attention-mechanism.md").write_text(
        CONCEPT_ATTENTION, encoding="utf-8"
    )
    (wiki / "concepts" / "sequence-modeling.md").write_text(
        CONCEPT_SEQUENCE, encoding="utf-8"
    )
    (wiki / "entities" / "vaswani-et-al.md").write_text(ENTITY_VASWANI, encoding="utf-8")

    (wiki / "sources" / "demo-paper.md").write_text(SOURCE_DEMO_PAPER, encoding="utf-8")
    (wiki / "sources" / "transformers-survey.json").write_text(
        json.dumps(SURVEY_PAGES, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (wiki / "sources" / "images" / "demo-paper" / "p1_img0.png").write_bytes(_TINY_PNG)

    (dest / "raw" / "demo-paper.md").write_text(SOURCE_DEMO_PAPER, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("dest", type=Path, help="Directory to create the demo KB in")
    parser.add_argument(
        "--force", action="store_true", help="Replace an existing KB at dest"
    )
    args = parser.parse_args()

    dest: Path = args.dest.expanduser().resolve()
    if (dest / ".openkb").exists():
        if not args.force:
            sys.exit(f"error: {dest} already contains a KB (use --force to replace)")
        shutil.rmtree(dest)

    build_demo_kb(dest)
    print(f"Demo KB created at {dest}")
    print(f"Run: openkb-web --kb-dir {dest}")


if __name__ == "__main__":
    main()
