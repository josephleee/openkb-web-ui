# Security Policy

## Reporting a vulnerability

Please report security problems privately through GitHub's private
vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**, or go directly to
<https://github.com/josephleee/openkb-web-ui/security/advisories/new>.

Please do **not** open a public issue, pull request or discussion for a
security problem. A useful report includes the commit you tested, steps to
reproduce, the impact you expect, and your setup (bind address,
`OPENKB_WEB_ALLOWED_HOSTS`, `OPENKB_WEB_CORS_ORIGINS`, any reverse proxy).

This is a one-maintainer project. Reports are handled on a best-effort basis,
without guaranteed response or fix times. Please give us a chance to ship a fix
before you disclose details publicly.

Ingestion, compilation and the chat agent are implemented by
[OpenKB](https://github.com/VectifyAI/OpenKB) (the `openkb` package, pinned to
`0.4.3`). Report vulnerabilities in OpenKB itself to that project, and let us
know here too if they affect this UI.

## Supported versions

There is no release yet. Fixes go to the latest `main` only. Once releases are
tagged, the latest release and `main` will receive fixes.

## Security model

OpenKB Web UI is a **local, single-user tool**: one server process serves one
knowledge base with one set of LLM credentials, for the person running it, on
the same machine.

**There is no authentication or authorization.** Anyone who can reach the
server's port has full control of the knowledge base: they can read every page
and source, add, remove and recompile documents, read and delete chat sessions,
and run chat turns billed to your LLM key (including choosing the model for a
new chat session).

### What protects it today

- **Loopback bind.** `openkb-web` listens on `127.0.0.1:8000` unless you pass
  `--host` / `--port`.
- **Host allowlist (DNS-rebinding guard).** Requests are served only when the
  `Host` header is `localhost`, `127.0.0.1` or `[::1]` (any port), or a name
  added through `OPENKB_WEB_ALLOWED_HOSTS`; anything else gets 400. This stops
  a web page that re-points its own domain at `127.0.0.1` from reaching the API
  through your browser. It is not access control: any non-browser client that
  can reach the port can send an allowed `Host` header.
- **CSRF guard.** A request with any method other than GET, HEAD or OPTIONS
  that carries an `Origin` header is rejected with 403 unless that origin is
  the server's own origin or is listed in `OPENKB_WEB_CORS_ORIGINS`. Requests
  without an `Origin` header (curl, scripts) pass, so this only defends against
  cross-site requests made by a browser.
- **CORS.** Only origins in `OPENKB_WEB_CORS_ORIGINS` may read API responses
  cross-origin. The default is the Vite dev server
  (`http://localhost:5173,http://127.0.0.1:5173`). Credentials are not allowed.
- **Input bounds and path checks.** `?pages=` on
  `/api/documents/{doc}/source` is parsed without expanding ranges and is
  capped at 100 pages per request. A temporary runtime guard makes OpenKB's
  `parse_pages` return no pages for a page spec covering more than 1000 pages,
  which bounds the chat agent's page tool. Page and wiki file paths are checked
  so they stay inside `wiki/`, and `/api/wiki-file` serves only `.md`, `.json`
  and raster image files. Document names and chat session IDs are validated
  before they reach the filesystem or the `openkb` command line. Uploads must
  have a supported file extension; any client-supplied directory part of the
  filename is dropped.
- **Rendering.** Wiki pages and chat answers are rendered with
  `react-markdown` without raw HTML.

### Known limitations

- **No authentication.** Do not expose the server to a network or the internet
  without your own authenticating reverse proxy in front of it.
- **Adding a document by URL makes the server fetch that URL (SSRF).**
  `POST /api/documents/url` accepts any `http(s)` URL and runs
  `openkb add <url>`. OpenKB fetches it from the server with no restriction on
  the destination, including loopback, private-network and link-local
  addresses such as cloud metadata endpoints, and it follows redirects. HTML
  and PDF responses are saved under `raw/` and compiled into the wiki, so their
  content becomes readable through the UI and is sent to your LLM provider.
  Fetch errors appear in the job log. PDF downloads have no size limit.
- **Upload size is checked only after the body is received.** The whole
  multipart request is received and the file is spooled to a temporary file
  (on disk beyond 1 MB) before the upload handler runs. The 200 MB limit is
  applied while that file is copied into the knowledge base, so an oversized
  upload uses its full size in bandwidth and temporary disk space before it is
  rejected with 413.
- **Ingested documents are untrusted input to an LLM (prompt injection).**
  Text from uploaded files and fetched URLs goes into OpenKB's compile prompts
  and into the chat and query agents' context. A crafted document can steer
  answers and what gets written into the wiki. The chat agent can read wiki
  pages and installed skill instructions, and it has a write tool that can
  create or overwrite files under `wiki/explorations/` and `output/` in the
  knowledge base.
- **No rate limits or quotas.** Every chat turn and every ingest spends LLM
  tokens on your key, and the job history is kept in memory without a cap.
- **No TLS.** The server speaks plain HTTP. Terminate TLS at your reverse proxy.

## Safe deployment

- **Keep the default bind** (`--host 127.0.0.1`). Binding to `0.0.0.0` or a LAN
  address exposes the unauthenticated API to that network, and the `Host`
  allowlist does not prevent this.
- **For remote access**, keep the backend on loopback and either use an SSH
  tunnel (`ssh -L 8000:127.0.0.1:8000 <host>`, then open
  `http://localhost:8000`) or put an authenticating, TLS-terminating reverse
  proxy in front and add only the proxy's hostname to
  `OPENKB_WEB_ALLOWED_HOSTS`.
- **Do not set `OPENKB_WEB_ALLOWED_HOSTS` to `*`.** It turns the `Host` check
  off, which removes the DNS-rebinding guard. A rebound page then counts as
  same-origin, also passes the CSRF guard, and any website you visit could read
  and change your knowledge base. List only the exact names you serve under.
- **Trust only origins you control in `OPENKB_WEB_CORS_ORIGINS`.** Whatever is
  served from a listed origin can read the API and send changes to it. If you
  use only the built frontend served by the backend, set it to an empty value
  (`OPENKB_WEB_CORS_ORIGINS=`) so that only same-origin requests are trusted.
  The Vite dev server needs the default.
- **Keep LLM keys out of version control.** OpenKB reads `LLM_API_KEY` from
  `<kb>/.env` or `~/.config/openkb/.env`. This repository's `.gitignore`
  ignores `.env` files; if your knowledge base directory is its own repository,
  ignore `.env` there too. Never put a key in `wiki/` or in a document you
  ingest: wiki content is served by the API and sent to the LLM.
- **Ingest only documents and URLs you trust**, and remember that anyone who
  can reach the API can make the server fetch internal URLs.
- **Run the server as an unprivileged user** that can access the knowledge
  base and little else.
