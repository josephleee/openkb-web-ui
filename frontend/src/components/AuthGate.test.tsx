import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "../api/http";
import { AuthContext, useAuth } from "../lib/authContext";
import AppLayout from "./AppLayout";
import AuthGate from "./AuthGate";

const TOKEN = "right-token-0123456789";

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Stub fetch with "METHOD /path" handlers; returns the mock for call checks. */
function mockFetch(routes: Record<string, Handler>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected request: ${key}`);
    return handler(init);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const calls = (fn: ReturnType<typeof mockFetch>) =>
  fn.mock.calls.map(([input, init]) => `${init?.method ?? "GET"} ${String(input)}`);

/** Stands in for the real app: loads /api/status like AppLayout does. */
function FakeApp() {
  const { authRequired, signOut } = useAuth();
  const [status, setStatus] = useState("loading");
  useEffect(() => {
    request("/api/status").then(
      () => setStatus("loaded"),
      () => setStatus("failed"),
    );
  }, []);
  return (
    <div>
      <p>KB app: {status}</p>
      {authRequired && (
        <button type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      )}
    </div>
  );
}

function renderGate() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <FakeApp />
      </AuthGate>
    </QueryClientProvider>,
  );
}

function submitToken(value: string) {
  fireEvent.change(screen.getByLabelText("Access token"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

const loginRoute: Handler = (init) => {
  const { token } = JSON.parse(String(init?.body)) as { token: string };
  return token === TOKEN ? new Response(null, { status: 204 }) : json(401, { detail: "Invalid token" });
};

/** In-memory Web Storage, so the test can see everything the page stores
 *  (and does not depend on the runtime's own localStorage). */
function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, String(value)),
    removeItem: (key: string) => void items.delete(key),
    clear: () => items.clear(),
    key: (index: number) => [...items.keys()][index] ?? null,
    get length() {
      return items.size;
    },
    dump: () => JSON.stringify([...items]),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AuthGate", () => {
  it("renders the app directly when the server has no token", async () => {
    const fetchMock = mockFetch({
      "GET /api/auth/session": () => json(200, { auth_required: false, authenticated: false }),
      "GET /api/status": () => json(200, {}),
    });
    renderGate();

    expect(await screen.findByText("KB app: loaded")).toBeInTheDocument();
    expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    expect(calls(fetchMock)).toEqual(["GET /api/auth/session", "GET /api/status"]);
  });

  it("renders the app as before when the backend is unreachable", async () => {
    mockFetch({
      "GET /api/auth/session": () => Promise.reject(new TypeError("Failed to fetch")),
      "GET /api/status": () => Promise.reject(new TypeError("Failed to fetch")),
    });
    renderGate();
    expect(await screen.findByText("KB app: failed")).toBeInTheDocument();
  });

  it("asks for the token before loading anything when the server wants one", async () => {
    const fetchMock = mockFetch({
      "GET /api/auth/session": () => json(200, { auth_required: true, authenticated: false }),
    });
    renderGate();

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByLabelText("Access token")).toHaveAttribute("type", "password");
    expect(screen.queryByText(/KB app/)).not.toBeInTheDocument();
    expect(calls(fetchMock)).toEqual(["GET /api/auth/session"]);
  });

  it("shows an error for a wrong token, then continues to the app with the right one", async () => {
    const local = memoryStorage();
    const session = memoryStorage();
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", session);
    const fetchMock = mockFetch({
      "GET /api/auth/session": () => json(200, { auth_required: true, authenticated: false }),
      "POST /api/auth/login": loginRoute,
      "GET /api/status": () => json(200, {}),
    });
    renderGate();
    await screen.findByLabelText("Access token");

    submitToken("not-the-token-at-all");
    expect(await screen.findByRole("alert")).toHaveTextContent("That token is not correct");
    expect(screen.queryByText(/KB app/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Access token")).toHaveAttribute("aria-invalid", "true");

    submitToken(`  ${TOKEN} `);
    expect(await screen.findByText("KB app: loaded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();

    const logins = fetchMock.mock.calls.filter(([url]) => url === "/api/auth/login");
    expect(logins.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { token: "not-the-token-at-all" },
      { token: TOKEN }, // trimmed
    ]);
    // The cookie carries the session; the token is not kept in the browser.
    expect(local.dump()).not.toContain(TOKEN);
    expect(session.dump()).not.toContain(TOKEN);
    expect(document.cookie).not.toContain(TOKEN);
  });

  it("tells the user to wait while the server is throttling attempts", async () => {
    mockFetch({
      "GET /api/auth/session": () => json(200, { auth_required: true, authenticated: false }),
      "POST /api/auth/login": () => json(429, { detail: "Too many failed sign-in attempts" }),
    });
    renderGate();
    await screen.findByLabelText("Access token");
    submitToken(TOKEN);
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many failed attempts");
  });

  it("keeps the submit button disabled until something is typed", async () => {
    mockFetch({
      "GET /api/auth/session": () => json(200, { auth_required: true, authenticated: false }),
    });
    renderGate();
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeDisabled();
  });

  it("goes back to the sign-in screen when an API call answers 401", async () => {
    mockFetch({
      "GET /api/auth/session": () => json(200, { auth_required: true, authenticated: true }),
      "GET /api/status": () => json(401, { detail: "Authentication required" }),
    });
    renderGate();
    expect(await screen.findByLabelText("Access token")).toBeInTheDocument();
    expect(screen.queryByText(/KB app/)).not.toBeInTheDocument();
  });

  it("signs out: ends the server session and shows the sign-in screen", async () => {
    const fetchMock = mockFetch({
      "GET /api/auth/session": () => json(200, { auth_required: true, authenticated: true }),
      "GET /api/status": () => json(200, {}),
      "POST /api/auth/logout": () => new Response(null, { status: 204 }),
    });
    renderGate();
    await screen.findByText("KB app: loaded");

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByLabelText("Access token")).toBeInTheDocument();
    expect(calls(fetchMock)).toContain("POST /api/auth/logout");
  });
});

describe("AppLayout sign-out button", () => {
  function renderLayout(authRequired: boolean, signOut = vi.fn(async () => {})) {
    mockFetch({
      "GET /api/status": () =>
        json(200, {
          kb_dir: "/tmp/kb",
          model: "gpt-test",
          language: "en",
          counts: {},
          last_compile: null,
          last_lint: null,
          busy: false,
        }),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={{ authRequired, signOut }}>
          <MemoryRouter>
            <Routes>
              <Route element={<AppLayout />}>
                <Route path="/" element={<p>page</p>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>,
    );
    return signOut;
  }

  it("is shown when the server requires a token", async () => {
    const signOut = renderLayout(true);
    const button = await screen.findByRole("button", { name: "Sign out" });
    fireEvent.click(button);
    await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
  });

  it("is hidden when the server has no token", async () => {
    renderLayout(false);
    expect(await screen.findByText("gpt-test")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });
});
