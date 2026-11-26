import { useState, type FormEvent } from "react";
import { login } from "../api/auth";
import { ApiError, errorMessage } from "../api/http";

function signInError(err: unknown): string {
  if (err instanceof ApiError && err.status === 401) {
    return "That token is not correct. Check it and try again.";
  }
  if (err instanceof ApiError && err.status === 429) {
    return "Too many failed attempts. Wait a moment, then try again.";
  }
  return `Could not sign in: ${errorMessage(err)}`;
}

/**
 * Token entry for a server started with an access token. The token is posted
 * once to /api/auth/login, which answers with an HttpOnly session cookie; the
 * token itself is never stored in the browser.
 */
export default function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const value = token.trim();
    if (!value || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await login(value);
    } catch (err) {
      setSubmitting(false);
      setError(signInError(err));
      return;
    }
    setToken("");
    onSignedIn();
  }

  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-bg px-4 py-10">
      <div className="w-full max-w-[360px] animate-pop">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="flex h-[27px] w-[27px] items-center justify-center rounded-lg bg-accent font-mono text-[11px] font-extrabold leading-none text-accent-fg shadow-card">
            KB
          </span>
          <span className="font-display text-[17px] font-semibold leading-none tracking-tight">
            OpenKB
          </span>
        </div>

        <form
          className="card px-6 pb-6 pt-5"
          onSubmit={(event) => void handleSubmit(event)}
          aria-labelledby="signin-title"
          noValidate
        >
          <h1 id="signin-title" className="text-[19px] text-ink">
            Sign in
          </h1>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
            This server is protected by an access token. Enter the token it was
            started with.
          </p>

          <label
            htmlFor="access-token"
            className="mb-1.5 mt-5 block text-xs font-semibold text-ink-2"
          >
            Access token
          </label>
          <input
            id="access-token"
            name="token"
            type="password"
            autoComplete="current-password"
            autoFocus
            spellCheck={false}
            className="input font-mono"
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
              setError(null);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "signin-error" : undefined}
          />

          {error && (
            <div
              id="signin-error"
              role="alert"
              className="mt-3 flex items-start gap-2 rounded-lg bg-rose-bg px-3 py-2 text-[12.5px] leading-snug text-rose-fg"
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
                className="mt-px h-3.5 w-3.5 shrink-0"
                aria-hidden="true"
              >
                <circle cx="8" cy="8" r="6.2" />
                <path d="M8 4.8v3.6M8 10.9v.1" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary mt-4 w-full py-2"
            disabled={submitting || !token.trim()}
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-4 text-center text-[11.5px] leading-relaxed text-ink-3">
          The token is set on the server with{" "}
          <code className="whitespace-nowrap font-mono">OPENKB_WEB_TOKEN</code> or{" "}
          <code className="whitespace-nowrap font-mono">--token-file</code>.
        </p>
      </div>
    </div>
  );
}
