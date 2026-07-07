import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router-dom";
import { getStatus } from "../api/client";
import { useTheme } from "../lib/theme";

const NAV = [
  {
    to: "/",
    label: "Dashboard",
    icon: "M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z",
  },
  {
    to: "/wiki",
    label: "Wiki",
    icon: "M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25",
  },
  {
    to: "/chat",
    label: "Chat",
    icon: "M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z",
  },
  {
    to: "/documents",
    label: "Documents",
    icon: "M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z",
  },
  {
    to: "/graph",
    label: "Graph",
    icon: "M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z",
  },
];

function NavIcon({ path }: { path: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4 shrink-0"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

/**
 * Collapse a leading home directory (`/Users/<name>/` or `/home/<name>/`) to
 * `~/` for display. The full absolute path is preserved for the tooltip.
 */
function abbreviateHome(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+\//, "~/");
}

export default function AppLayout() {
  const { theme, toggle } = useTheme();
  const { data: status } = useQuery({
    queryKey: ["status"],
    queryFn: getStatus,
    refetchInterval: 5_000,
  });

  return (
    <div className="flex h-full">
      <aside className="flex w-52 shrink-0 flex-col border-r border-line bg-panel">
        <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
          <span className="flex h-[27px] w-[27px] items-center justify-center rounded-lg bg-accent font-mono text-[11px] font-extrabold leading-none text-accent-fg shadow-card">
            KB
          </span>
          <span className="font-display text-[17px] font-semibold leading-none tracking-tight">
            OpenKB
          </span>
        </div>
        <nav className="flex-1 space-y-0.5 px-2.5 py-2" aria-label="Primary">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-lg border px-3 py-2 text-[13px] font-medium transition-colors ${
                  isActive
                    ? "border-accent-line bg-accent-soft text-accent"
                    : "border-transparent text-ink-2 hover:bg-surface-2 hover:text-ink"
                }`
              }
            >
              <NavIcon path={item.icon} />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-line px-4 py-3 text-[11px] text-ink-3">
          Web UI for OpenKB
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line bg-panel pl-4 pr-3">
          {status ? (
            <>
              <span
                className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-ink-2"
                title={status.kb_dir}
              >
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.4}
                  strokeLinejoin="round"
                  className="h-3.5 w-3.5 shrink-0"
                  aria-hidden="true"
                >
                  <path d="M2 4.3A1 1 0 0 1 3 3.3h3l1.3 1.4h5.7a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
                </svg>
                <span className="truncate">{abbreviateHome(status.kb_dir)}</span>
              </span>
              <span
                className="chip-neutral shrink-0 gap-1.5"
                title="Configured model"
              >
                <span className="h-[5px] w-[5px] rounded-full bg-em-fg" />
                {status.model}
              </span>
              <span className="chip-neutral shrink-0" title="Configured language">
                {status.language}
              </span>
              <div className="flex-1" />
              <button
                type="button"
                onClick={toggle}
                aria-label="Toggle theme"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-surface-2 text-ink-2 transition-colors hover:text-ink"
              >
                {theme === "dark" ? (
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.4}
                    strokeLinejoin="round"
                    className="h-[15px] w-[15px]"
                    aria-hidden="true"
                  >
                    <path d="M13.2 9.1A5.2 5.2 0 0 1 6.9 2.8 5.4 5.4 0 1 0 13.2 9.1z" />
                  </svg>
                ) : (
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.4}
                    strokeLinecap="round"
                    className="h-4 w-4"
                    aria-hidden="true"
                  >
                    <circle cx="8" cy="8" r="3.1" />
                    <path d="M8 1.4v1.6M8 13v1.6M1.4 8h1.6M13 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" />
                  </svg>
                )}
              </button>
              <div className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface-2 py-1.5 pl-2.5 pr-3">
                <span
                  className={`h-2 w-2 rounded-full ${
                    status.busy
                      ? "animate-pulse2 bg-amber-fg"
                      : "bg-em-fg"
                  }`}
                />
                <span
                  className={`text-[11.5px] font-semibold ${
                    status.busy ? "text-amber-fg" : "text-em-fg"
                  }`}
                >
                  {status.busy ? "Working" : "Idle"}
                </span>
              </div>
            </>
          ) : (
            <span className="text-xs text-ink-3">Connecting to backend…</span>
          )}
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
