import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, onUnauthorized, request } from "./http";
import { openEventStream, postSse } from "./sse";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("401 handling", () => {
  it("request() announces a 401 and still rejects with ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(401, { detail: "Authentication required" })));
    const listener = vi.fn();
    const off = onUnauthorized(listener);

    const err = await request("/api/status").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(listener).toHaveBeenCalledOnce();
    off();
  });

  it("does not announce a 401 from the sign-in endpoints", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(401, { detail: "Invalid token" })));
    const listener = vi.fn();
    const off = onUnauthorized(listener);
    await request("/api/auth/login", { method: "POST" }).catch(() => {});
    expect(listener).not.toHaveBeenCalled();
    off();
  });

  it("does not announce other errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(403, { detail: "Cross-origin request rejected" })));
    const listener = vi.fn();
    const off = onUnauthorized(listener);
    await request("/api/documents/x/remove", { method: "POST" }).catch(() => {});
    expect(listener).not.toHaveBeenCalled();
    off();
  });

  it("postSse() announces a 401 from a streaming endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(401, { detail: "Authentication required" })));
    const listener = vi.fn();
    const off = onUnauthorized(listener);
    await expect(postSse("/api/query", { question: "q" }, () => {})).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(listener).toHaveBeenCalledOnce();
    off();
  });

  it("an EventSource that gives up rechecks the session (it cannot see the 401)", async () => {
    class FakeEventSource {
      static readonly CLOSED = 2;
      static last: FakeEventSource;
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((e: MessageEvent<string>) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly url: string) {
        FakeEventSource.last = this;
      }
      close() {}
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = vi.fn(async () => json(200, { auth_required: true, authenticated: false }));
    vi.stubGlobal("fetch", fetchMock);
    const listener = vi.fn();
    const off = onUnauthorized(listener);
    const connectionError = vi.fn();

    openEventStream("/api/jobs/j1/events", () => {}, { onConnectionError: connectionError });
    FakeEventSource.last.readyState = FakeEventSource.CLOSED;
    FakeEventSource.last.onerror?.();

    expect(connectionError).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/session", undefined);
    off();
  });
});
