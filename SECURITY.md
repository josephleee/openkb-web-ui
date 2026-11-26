# Security Policy

## Reporting a vulnerability

Please report security problems privately through GitHub's private
vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**, or go directly to
<https://github.com/josephleee/openkb-web-ui/security/advisories/new>.

Please do **not** open a public issue, pull request or discussion for a
security problem. A useful report includes the commit you tested, steps to
reproduce, the impact you expect, and your setup (bind address, whether an
access token is configured, `OPENKB_WEB_ALLOWED_HOSTS`,
`OPENKB_WEB_CORS_ORIGINS`, any reverse proxy). Never include the token itself.

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

**Authentication is optional and off by default.** Without an access token,
anyone who can reach the server's port has full control of the knowledge base:
they can read every page and source, add, remove and recompile documents, read
and delete chat sessions, and run chat turns billed to your LLM key (including
choosing the model for a new chat session). With a token, the same is true for
anyone who has the token: there is one shared secret, no user accounts and no
roles.

### Optional access token

Set a token to require it for the API:

- `OPENKB_WEB_TOKEN=<token>` in the server's environment, or
- `--token-file PATH` (or `OPENKB_WEB_TOKEN_FILE=PATH`): a file holding the
  token, so it is not in your shell history or the server's environment. Keep
  the file readable only by you (`chmod 600`).

There is no option that takes the token itself, because command-line arguments
show in the process list (`openkb-web --token ...` is refused). The server
refuses to start when both sources are set, or when the token is empty, shorter
than 16 characters, or not printable ASCII without spaces. Use a random value,
for example `python3 -c 'import secrets; print(secrets.token_urlsafe(32))'`.

When a token is configured:

- **Every `/api` request needs it**, except `/api/auth/session`,
  `/api/auth/login` and `/api/auth/logout`. Anything else under `/api`,
  including unknown paths, gets 401 with a JSON body. The check runs before
  routing, so no handler runs and no request body (such as an upload) is used.
- **API clients** send `Authorization: Bearer <token>`.
- **The browser** posts the token once to `/api/auth/login` and gets a session
  cookie: a random 256-bit session id (never the token or anything derived from
  it), `HttpOnly` (page scripts cannot read it), `SameSite=Strict` (the browser
  does not send it with requests started by other sites), `Path=/api`, valid
  for 30 days. It is marked `Secure` when the browser reached the server over
  HTTPS through a reverse proxy on the same machine that sets
  `X-Forwarded-Proto`. A cookie is used because the UI's live job logs use
  `EventSource`, which cannot send an `Authorization` header, and because it
  keeps the token out of URLs and browser storage. The browser never stores
  the token.
- **Sessions live in the server's memory.** Signing out ends the session on the
  server, not only in the browser. Restarting the server, or changing the token
  (which needs a restart), signs every browser out.
- **Tokens are compared in constant time** (`hmac.compare_digest` over SHA-256
  digests, so the length does not leak either). The token is never logged, and
  it is removed from the environment of the `openkb` subprocesses.
- **Failed attempts are throttled.** After a wrong token (on the login endpoint
  or in a bearer header), the server answers that request only after one
  second and refuses every token check from any client during that second
  (429 with `Retry-After`). That caps guessing at about one attempt per second,
  86,400 a day: harmless against a random token, not enough to protect a
  guessable one. Requests that carry no token are not throttled, so a browser
  waiting at the sign-in screen cannot lock you out.
- **The token is never accepted in a URL or query string.** Do not put it in
  one: URLs end up in access logs and browser history.

What stays public with a token: the built frontend files (HTML, JavaScript,
CSS; they contain no knowledge-base data) so the sign-in screen can load;
FastAPI's API description at `/docs` and `/openapi.json` (the routes, no data);
and `/api/auth/session`, which says only whether a token is required and
whether this browser is signed in.

What the token does **not** do:

- **It does not encrypt anything.** The server speaks plain HTTP, so the token
  and the session cookie cross the network in clear text. Anyone who can watch
  that traffic (shared Wi-Fi, a LAN) can capture and reuse them. For access
  from another machine, use an SSH tunnel or a TLS-terminating reverse proxy
  (see below).
- **It does not add users.** Everyone with the token has full control. There is
  no per-user audit trail and no read-only access.
- **It does not limit what a signed-in client can do.** The limitations below
  (fetching any URL, prompt injection, LLM spend) still apply to whoever holds
  the token.
- **It does not isolate ports.** Browsers send cookies to every port of a host
  name, so another web app you open at the same host name on a different port
  receives the session cookie with its requests to `/api` paths (page scripts
  still cannot read it). Do not run untrusted web apps under the same host
  name.
- **It does not hide the token from your own account.** With
  `OPENKB_WEB_TOKEN`, other processes running as your user can read the
  server's environment; a token file has the same exposure as any file you own.

### Other protections

- **Loopback bind, and no network bind without a token.** `openkb-web` listens
  on `127.0.0.1:8000` unless you pass `--host` / `--port`. It refuses to start
  with a `--host` that is not a loopback address (`127.0.0.0/8`, `::1`,
  `localhost`) unless a token is configured; `0.0.0.0` and `::` (every
  interface) count as non-loopback. This check is part of the `openkb-web`
  command: running the app factory under another ASGI server
  (`uvicorn openkb_web.main:create_app --factory ...`) bypasses it.
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
  cross-site requests made by a browser. It still matters with a token: the
  session cookie is `SameSite=Strict`, but a page on another port of the same
  host is the same *site*, so its requests would carry the cookie, and only
  this check rejects their changes. The login and logout endpoints are covered
  too.
- **CORS.** Only origins in `OPENKB_WEB_CORS_ORIGINS` may read API responses
  cross-origin. The default is the Vite dev server
  (`http://localhost:5173,http://127.0.0.1:5173`). Credentials are not allowed,
  so a listed origin cannot read responses to requests that carry the session
  cookie.
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

- **Authentication is off by default, and the token is a single shared
  secret.** Without a token the API is open to anyone who can reach the port.
  With one there are still no user accounts, and the token travels in clear
  text unless you add TLS in front.
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
- **No rate limits or quotas** beyond the one-second pause after a wrong token.
  Every chat turn and every ingest spends LLM tokens on your key, and the job
  history is kept in memory without a cap.
- **No TLS.** The server speaks plain HTTP, so the access token and session
  cookie are not protected in transit. Terminate TLS at your reverse proxy, or
  use an SSH tunnel.

## Safe deployment

- **Keep the default bind** (`--host 127.0.0.1`). `openkb-web` refuses to bind
  to `0.0.0.0` or a LAN address without a token, and even with one, plain HTTP
  on a network exposes the token to anyone who can watch the traffic. If you do
  bind to a LAN address, add the name or IP you browse to to
  `OPENKB_WEB_ALLOWED_HOSTS`, or the `Host` check rejects it.
- **For remote access**, keep the backend on loopback and either use an SSH
  tunnel (`ssh -L 8000:127.0.0.1:8000 <host>`, then open
  `http://localhost:8000`) or put a TLS-terminating reverse proxy in front and
  add only the proxy's hostname to `OPENKB_WEB_ALLOWED_HOSTS`. Set an access
  token as well whenever anyone else can reach the port or the proxy (other
  users on a shared machine, other machines through the proxy); the proxy may
  add its own authentication on top.
- **Generate the token randomly and keep it in a file** readable only by you,
  passed with `--token-file`. Do not reuse a password. To revoke every browser
  session, change the token and restart the server.
- **Do not set `OPENKB_WEB_ALLOWED_HOSTS` to `*`.** It turns the `Host` check
  off, which removes the DNS-rebinding guard. A rebound page then counts as
  same-origin, also passes the CSRF guard, and any website you visit could read
  and change your knowledge base. List only the exact names you serve under.
- **Trust only origins you control in `OPENKB_WEB_CORS_ORIGINS`.** Whatever is
  served from a listed origin can read the API and send changes to it. If you
  use only the built frontend served by the backend, set it to an empty value
  (`OPENKB_WEB_CORS_ORIGINS=`) so that only same-origin requests are trusted;
  this matters more with a token, because a listed origin's pages can send
  changes with your session cookie. The Vite dev server needs the default.
- **Keep LLM keys out of version control.** OpenKB reads `LLM_API_KEY` from
  `<kb>/.env` or `~/.config/openkb/.env`. This repository's `.gitignore`
  ignores `.env` files; if your knowledge base directory is its own repository,
  ignore `.env` there too. Never put a key in `wiki/` or in a document you
  ingest: wiki content is served by the API and sent to the LLM.
- **Ingest only documents and URLs you trust**, and remember that anyone who
  can reach the API can make the server fetch internal URLs.
- **Run the server as an unprivileged user** that can access the knowledge
  base and little else.
