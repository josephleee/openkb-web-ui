# openkb-web-backend

FastAPI backend for the OpenKB web UI. See the repository root README for the
full picture; the short version:

```bash
uv sync
uv run openkb-web --kb-dir /path/to/your/kb        # or set OPENKB_WEB_KB_DIR
```

The server wraps exactly one OpenKB knowledge base:

- **Reads + chat** run in-process against the `openkb` package (there is no
  JSON CLI output mode), under OpenKB's shared read lock.
- **Mutations** (add / remove / recompile) run as `openkb` CLI subprocesses
  through a single-worker job queue, with stdout parsed into SSE progress
  events. Outcomes are classified by `[OK]`/`[ERROR]`/`[SKIP]` output markers
  because exit codes are unreliable.

Uploads are staged at `<kb>/.openkb-web-uploads/<original-name>` (outside
`wiki/`). The path is kept stable per filename on purpose: OpenKB identifies a
document by its source path, so re-uploading the same filename overwrites the
document in place instead of forking a `<stem>-<hash>` duplicate.

A production build of `../frontend/dist` is served automatically with an SPA
fallback when present; otherwise run the Vite dev server against
`http://127.0.0.1:8000` (CORS for `localhost:5173` is enabled by default,
override with `OPENKB_WEB_CORS_ORIGINS`).

For a KB to develop against without any LLM calls:

```bash
uv run python ../scripts/make_demo_kb.py /tmp/demo-kb
uv run openkb-web --kb-dir /tmp/demo-kb
```
