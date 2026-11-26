import { notifyUnauthorized, request } from "./http";

/** GET /api/auth/session: whether the server wants a token, and whether this
 *  browser holds a valid session cookie. */
export interface AuthSession {
  auth_required: boolean;
  authenticated: boolean;
}

export const getAuthSession = () => request<AuthSession>("/api/auth/session");

/** Trade the token for an HttpOnly session cookie (the token itself is never
 *  stored by the browser). Rejects with ApiError 401 for a wrong token and 429
 *  while the server is pausing after a failed attempt. */
export const login = (token: string) =>
  request<void>("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });

/** End the session on the server and clear the cookie. */
export const logout = () => request<void>("/api/auth/logout", { method: "POST" });

/** For transports that cannot see status codes (EventSource): ask the server
 *  whether we lost the session, and show the sign-in screen if so. */
export async function recheckAuth(): Promise<void> {
  try {
    const session = await getAuthSession();
    if (session.auth_required && !session.authenticated) notifyUnauthorized();
  } catch {
    // Backend unreachable: the regular error states cover that.
  }
}
