# OpenKB Web UI — Design Spec

Date: 2026-07-06
Status: Approved (architecture: FastAPI + React; scope: full feature set; UI language: English)

## 1. Goal

A self-hostable web UI for [OpenKB](https://github.com/VectifyAI/OpenKB) (v0.4.x), the open-source
CLI tool that compiles documents into an LLM-maintained wiki knowledge base. OpenKB has **no REST
API and no web UI** — everything is CLI + files on disk. This project wraps one OpenKB knowledge
base with a FastAPI backend and a React frontend, giving it:

- **Dashboard** — KB status, activity feed (from `wiki/log.md`), structural health checks
- **Wiki browser** — rendered markdown pages with `[[wikilink]]` navigation and images
- **Chat** — streaming multi-turn chat over the wiki (sessions persisted by OpenKB itself), with
  tool-call provenance trail; one-shot query endpoint included
- **Documents** — list, upload files, add URLs, remove (plan → confirm), recompile, with live
  job progress
- **Graph** — interactive force-directed knowledge graph from OpenKB's own `build_graph()`

Published as a public repo `josephleee/openkb-web-ui`, MIT license, English UI + README.

## 2. Non-goals (v1)

- Multi-KB picker (one server instance = one KB, selected at startup)
- Skill/deck generation UIs, skill eval, LLM semantic lint (structural lint only)
- Authentication (local/trusted-network tool, same trust model as the CLI)
- Docker packaging
- Windows support guarantees (OpenKB's locks behave differently there; documented, untested)

## 3. Architecture

```
openkb-web-ui/
├── backend/                  # FastAPI, Python >=3.11, uv-managed
│   ├── pyproject.toml        # deps: fastapi, uvicorn, openkb==0.4.* (SSE hand-rolled via StreamingResponse)
│   └── openkb_web/
│       ├── main.py           # app factory, static serving of ../frontend/dist, CORS (dev)
│       ├── kb.py             # KB locator + shared read-lock helpers + path safety
│       ├── routers/
│       │   ├── status.py     # /api/status, /api/activity, /api/health
│       │   ├── pages.py      # /api/pages, /api/pages/{target}, /api/wiki-file/{path}
│       │   ├── documents.py  # /api/documents + mutations via job queue
│       │   ├── jobs.py       # /api/jobs, /api/jobs/{id}, /api/jobs/{id}/events (SSE)
│       │   ├── chat.py       # sessions CRUD + /messages (SSE) + /api/query
│       │   └── graph.py      # /api/graph
│       ├── jobqueue.py       # per-KB job queue, subprocess runner, stdout parser
│       ├── chat_stream.py    # Runner.run_streamed → SSE event mapping
│       └── wiki.py           # page enumeration, frontmatter, wikilink resolution
├── frontend/                 # Vite + React 18 + TypeScript + Tailwind
│   └── src/
│       ├── api/              # typed client + SSE helpers
│       ├── pages/            # Dashboard, Wiki, Chat, Documents, Graph
│       ├── components/       # Markdown (wikilink-aware), Layout, JobProgress, ...
│       └── ...
├── docs/superpowers/specs/   # this file
├── README.md                 # English; quick start, screenshots, architecture
└── LICENSE                   # MIT
```

### 3.1 Two integration modes (the load-bearing decision)

OpenKB's own code dictates a split:

1. **Reads + chat: in-process Python imports.**
   There is no `--json` flag anywhere in the CLI, so reads must use the package directly:
   `openkb.visualize.build_graph`, `openkb.frontmatter.parse/split`,
   `openkb.lint.list_existing_wiki_targets/_WIKILINK_RE/build_norm_index`, `hashes.json` via
   `json.loads`, `openkb.config.load_config`, `openkb.agent.chat_session` (full session CRUD).
   Chat/query streaming must bypass the CLI too: `run_chat()`/`run_query(stream=True)` are
   hard-wired to prompt_toolkit/rich terminal rendering. The server calls
   `build_chat_agent(kb_dir, model, language)` / `build_query_agent(...)` +
   `agents.Runner.run_streamed(...)` and consumes `result.stream_events()` itself.

2. **Mutations (add/remove/recompile): subprocess + per-KB job queue.**
   `add_single_file()` calls `asyncio.run()` internally (breaks inside a running event loop),
   `_setup_llm_key()` poisons process-global state, mutations hold an exclusive advisory flock
   (`.openkb/ingest.lock`) for minutes, and a killed subprocess is auto-recovered by OpenKB's
   journal drain on next lock acquisition. So mutations run as
   `openkb --kb-dir <kb> add|remove|recompile ...` subprocesses, **one at a time per KB**,
   with stdout parsed line-by-line into progress events relayed over SSE.
   Outcomes are classified by output markers (`[OK]`/`[ERROR]`/`[SKIP]`/`[WARN]`) — exit codes
   are unreliable (remove/recompile exit 0 on failure paths).

### 3.2 KB selection & LLM key

- KB dir comes from `OPENKB_WEB_KB_DIR` env or `--kb-dir` CLI arg to the server; validated as
  containing `.openkb/`. No walk-up magic — explicit only.
- At startup the server calls `openkb.cli._setup_llm_key(kb_dir)` once (loads `<kb>/.env` then
  `~/.config/openkb/.env`, sets `litellm.api_key` + provider env vars + extra_headers/timeout
  stashes). One server process serves one KB / one credential context by design.
- Model/language come from `.openkb/config.yaml` via `load_config()` (defaults merged).

## 4. API contract

All endpoints under `/api`. Errors: JSON `{"detail": str}` with proper status codes. The sandboxed
file helpers in `openkb/agent/tools.py` signal errors via sentinel strings — the backend maps
`"Access denied"` → 403, `"File not found"`/`"not found"` → 404.

### 4.1 Status / activity / health

- `GET /api/status` → `{kb_dir, model, language, counts: {documents, summaries, concepts,
  entities, explorations, reports, raw}, last_compile: iso|null, last_lint: iso|null, busy: bool}`
  Recomputed from `hashes.json` + per-dir globs (same logic as `print_status`); `last_compile` =
  max mtime over `PAGE_CONTENT_DIRS` pages; `busy` = job queue has an active mutation job.
- `GET /api/activity?limit=50` → `[{timestamp, operation, description}]` — regex-parse
  `^## \[(.+?)\] (\w+) \| (.*)$` headings from `wiki/log.md`, newest first; tolerate a torn
  final line (append-mode write).
- `GET /api/health` → `{broken_links: [...], orphans: [...], index_sync: [...],
  invalid_frontmatter: [...]}` via `openkb.lint.find_broken_links/find_orphans/check_index_sync/
  find_invalid_frontmatter` under the shared read lock (fast, no LLM).

### 4.2 Wiki

- `GET /api/pages` → `[{kind, slug, target, title, description, mtime}]` enumerated from the
  filesystem: `PAGE_CONTENT_DIRS = (summaries, concepts, entities)` + `explorations/` + `index`.
  Excludes `AGENTS.md`, `SCHEMA.md`, `log.md`, `sources/` and transient `.*.tmp` files.
  `title` = frontmatter title or slug; `description` from frontmatter when present.
- `GET /api/pages/{target:path}` (target like `concepts/attention` or `index`) →
  `{target, kind, slug, frontmatter, body, mtime, wikilinks: [{raw, target|null, alias}]}`.
  Body/frontmatter split via `openkb.frontmatter.split/parse`. Wikilinks resolved with OpenKB's
  exact semantics: `_WIKILINK_RE`, alias split on first `|`, exact match against
  `list_existing_wiki_targets`, then fuzzy via `build_norm_index`; unresolved → `target: null`
  (rendered as plain text).
- `GET /api/wiki-file/{path:path}` → raw file bytes from `<kb>/wiki/<path>` with MIME from the
  `read_wiki_image` allow-list for images (`.png .jpg .jpeg .gif .webp .bmp`), `text/markdown`
  for `.md`, `application/json` for `.json`. Strict traversal guard: `resolve()` +
  `is_relative_to(wiki_root)`. Serves page images (`sources/images/{doc}/p1_img0.png` — links in
  markdown are **wiki-root-relative**) and long-doc page sources (`sources/{doc}.json`).
- `GET /api/documents/{doc_name}/source?pages=1-5` → paged source viewer for long docs
  (reads `sources/{doc}.json`, the `[{page, content, images}]` array) or the `.md` for short docs.

### 4.3 Documents & jobs

- `GET /api/documents` → `[{doc_name, name, type, display_type, pages|null, has_summary,
  raw_path|null, source_path|null}]` — join of `hashes.json` entries with on-disk files; display
  name falls back to `Path(meta["name"]).stem` for legacy entries; `display_type` mirrors
  `_display_type` (pageindex/short).
- `POST /api/documents/upload` (multipart, size cap 200 MB, extension allowlist =
  `SUPPORTED_EXTENSIONS`) → saves to a per-upload temp dir preserving the original filename
  (filename is doc identity) → enqueues job `{"kind": "add"}` → `202 {job_id}`.
- `POST /api/documents/url` `{url}` (validated http/https) → enqueues `openkb add <url>` job.
- `POST /api/documents/{doc_name}/remove-plan` → runs `openkb remove <doc_name> --dry-run`
  synchronously (seconds, no LLM), returns parsed plan lines
  `[{action: DELETE|MODIFY|REGISTRY|PAGEINDEX, target}]` for the confirm dialog.
- `POST /api/documents/{doc_name}/remove` `{keep_raw?: bool}` → enqueues
  `openkb remove <doc_name> --yes [--keep-raw]`.
- `POST /api/documents/{doc_name}/recompile` → enqueues `openkb recompile <doc_name> --yes`.
- `GET /api/jobs` → `[{id, kind, label, state: queued|running|succeeded|failed|skipped,
  created_at, started_at|null, finished_at|null, detail}]` (in-memory registry, newest first).
- `GET /api/jobs/{id}/events` → SSE stream: `{"type":"line","line":str}` per parsed stdout line
  (spinner-dot heartbeats collapsed), `{"type":"state","state":...}`, terminal
  `{"type":"done","state":...,"detail":str}`. Reconnect-safe: replays buffered lines.

Job runner: single asyncio worker per process; subprocess spawned with
`OPENKB_DIR=<kb>` + `PYTHONUNBUFFERED=1`, stdout+stderr merged, decoded line-wise. Outcome
classification: any `[ERROR]` → failed; `[SKIP]` → skipped (dedup — surfaced distinctly);
`[OK]`/`Done:` → succeeded; nonzero exit without markers → failed.

### 4.4 Chat & query

- `GET /api/chat/sessions` → `list_sessions(kb_dir)` verbatim
  (`[{id, title, turn_count, updated_at, model}]`).
- `POST /api/chat/sessions` → `ChatSession.new(kb_dir, model, language).save()` → session dict.
- `GET /api/chat/sessions/{id}` → `{id, title, model, language, created_at, updated_at,
  turns: [{user, assistant}]}` (zips `user_turns`/`assistant_texts`; `history` stays opaque).
- `DELETE /api/chat/sessions/{id}` → `delete_session`.
- `POST /api/chat/sessions/{id}/messages` `{message}` → **SSE**:
  - `{"type":"text_delta","delta":str}` from `RawResponsesStreamEvent` +
    `ResponseTextDeltaEvent`
  - `{"type":"tool_call","name":str,"arguments":str}` from `RunItemStreamEvent`
    `tool_call_item` (rendered as the provenance trail)
  - `{"type":"done","answer":str}` then `session.record_turn(msg, answer,
    result.to_input_list())`
  - `{"type":"error","message":str}` on exceptions (incl. `MaxTurnsExceeded`)
  Per-session in-flight guard (409 if a turn is already running — `record_turn` replaces the
  whole history; concurrent turns would clobber each other). Agent rebuilt per turn with the
  **session's stored model**, mirroring CLI resume semantics. `append_log(wiki, "chat", ...)`
  under ingest lock for CLI parity is skipped in v1 (log noise); documented.
- `POST /api/query` `{question}` → SSE with the same event shapes, via `build_query_agent` +
  `Runner.run_streamed`; no persistence.

### 4.5 Graph

- `GET /api/graph` → `openkb.visualize.build_graph(kb_dir/"wiki")` verbatim
  (`{nodes:[{id,label,type,in,out,sources}], edges:[{source,target}], types:[str]}`), computed
  in a threadpool under the shared read lock, cached keyed on max mtime of page dirs.

## 5. Frontend

Vite + React 18 + TypeScript + Tailwind CSS v3. React Router. TanStack Query for data fetching.
`react-markdown` + `remark-gfm` for rendering; a rehype/remark-level transform turns resolved
`[[wikilinks]]` into router `<Link>`s (unresolved ones render as muted plain text) and rewrites
relative image srcs against `/api/wiki-file/`. Graph via `react-force-graph-2d` (canvas, no CDN;
node colors keyed off the server's `types` array, click → wiki page). SSE consumed with native
`EventSource` (GET) and `fetch` + ReadableStream parsing for POST-SSE (chat).

Pages:
- **Dashboard** `/` — status cards (docs/concepts/entities/last compile), busy indicator,
  activity feed, health panel (broken links etc.), quick-ask box that jumps into a new chat.
- **Wiki** `/wiki/:target?` — left sidebar grouped by kind with filter box; main pane renders the
  page; index by default; breadcrumbs; frontmatter chips (type, sources).
- **Chat** `/chat/:sessionId?` — session list sidebar (new/delete), message thread with streaming
  tokens, collapsible tool-call trail per answer, wikilinks in answers clickable.
- **Documents** `/documents` — table (name, type, pages, summary link), upload dropzone + URL
  form, per-row remove (dry-run plan modal → confirm) and recompile, jobs panel with live SSE
  progress lines.
- **Graph** `/graph` — full-viewport canvas, type legend/filter checkboxes, search-to-focus,
  click node → `/wiki/:target`.

## 6. Testing & verification

- **Backend (pytest + httpx AsyncClient):** a synthetic KB fixture built by hand in `tmp_path`
  (exact OpenKB layout: `.openkb/{config.yaml,hashes.json}`, `wiki/{index.md,log.md,AGENTS.md,
  summaries/,concepts/,entities/,sources/images/...}`, a chat session JSON) — no LLM, no network.
  Covers: every read endpoint's shape, wikilink resolution incl. fuzzy + ghost links, path
  traversal rejection (`../`, absolute, encoded), image MIME, document join with legacy entries,
  activity parsing with torn last line, job queue with a fake `openkb` executable (a stub script
  emitting realistic stdout), chat SSE with a mocked `Runner.run_streamed`.
- **Frontend:** `tsc --noEmit` + production build; vitest for the wikilink/markdown transform.
- **E2E:** run real backend against the synthetic KB + built frontend, drive with browser
  automation; screenshot each page.
- **Review:** multi-agent adversarial review (correctness, security, OpenKB fidelity) before push.

## 7. Delivery

Public GitHub repo `josephleee/openkb-web-ui` (MIT). README: what/why, screenshots, quick start
(`uv sync` + `npm install`, run modes), architecture section (the two integration modes and why),
config reference (env vars), roadmap (non-goals above). openkb pinned `==0.4.*` with a note that
in-process reads couple to some private helpers (`lint._WIKILINK_RE`) and the pin matters.
