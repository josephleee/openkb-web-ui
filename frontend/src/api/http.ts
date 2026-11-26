export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

/** Pull the {"detail": str} payload FastAPI uses for errors, with a fallback. */
export async function extractDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body.detail === "string" && body.detail) return body.detail;
  } catch {
    // non-JSON error body
  }
  return `Request failed (${res.status})`;
}

// --- 401 handling -----------------------------------------------------------
// When the server has an access token configured, any API call made without a
// valid session answers 401. AuthGate subscribes here and swaps the app for the
// sign-in screen. The /api/auth/* endpoints are excluded: a wrong token on the
// sign-in screen is reported by that screen itself.

const AUTH_PREFIX = "/api/auth/";
const unauthorizedListeners = new Set<() => void>();

/** Subscribe to "the server wants a token"; returns an unsubscribe function. */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

export function notifyUnauthorized(): void {
  for (const listener of [...unauthorizedListeners]) listener();
}

/** The ApiError for a non-OK response, announcing a 401 to AuthGate. */
export async function responseError(res: Response, url: string): Promise<ApiError> {
  if (res.status === 401 && !url.startsWith(AUTH_PREFIX)) notifyUnauthorized();
  return new ApiError(res.status, await extractDetail(res));
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw await responseError(res, path);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.detail;
  if (err instanceof Error) return err.message;
  return String(err);
}
