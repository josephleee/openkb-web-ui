import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { createChatSession, getActivity, getHealth, getStatus } from "../api/client";
import { errorMessage } from "../api/http";
import { EmptyState, ErrorState, Spinner } from "../components/States";
import { formatRelative } from "../lib/format";

const OPERATION_STYLES: Record<string, string> = {
  add: "chip-emerald",
  ingest: "chip-emerald",
  remove: "chip-rose",
  recompile: "chip-sky",
  query: "chip-sky",
  chat: "chip-violet",
  lint: "chip-amber",
  init: "chip-neutral",
};

function operationStyle(op: string): string {
  return OPERATION_STYLES[op.toLowerCase()] ?? "chip-neutral";
}

function StatCard({
  label,
  value,
  sub,
  big = true,
}: {
  label: string;
  value: string;
  sub?: string;
  big?: boolean;
}) {
  return (
    <div className="card p-4 transition-colors hover:border-line-strong">
      <div className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-ink-3">
        {label}
      </div>
      <div
        className={`mt-3 font-display font-semibold leading-none tracking-tight text-ink ${
          big ? "text-[34px]" : "text-2xl"
        }`}
      >
        {value}
      </div>
      {sub && <div className="mt-2 text-[12.5px] text-ink-3">{sub}</div>}
    </div>
  );
}

function HealthSection({ label, items }: { label: string; items: string[] }) {
  return (
    <details className="group border-b border-line last:border-b-0">
      <summary className="flex cursor-pointer select-none items-center justify-between px-4 py-3 text-[13.5px]">
        <span className="text-ink-2">{label}</span>
        {items.length === 0 ? (
          <span className="chip-emerald">OK</span>
        ) : (
          <span className="chip-rose">{items.length}</span>
        )}
      </summary>
      {items.length > 0 && (
        <ul className="max-h-48 space-y-1 overflow-y-auto border-t border-line px-4 py-2">
          {items.map((item, i) => (
            <li key={i} className="break-words font-mono text-xs text-ink-3">
              {item}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [question, setQuestion] = useState("");
  const status = useQuery({ queryKey: ["status"], queryFn: getStatus });
  const activity = useQuery({ queryKey: ["activity"], queryFn: () => getActivity(25) });
  const health = useQuery({ queryKey: ["health"], queryFn: getHealth });

  const ask = useMutation({
    mutationFn: async (q: string) => {
      const session = await createChatSession();
      return { session, q };
    },
    onSuccess: ({ session, q }) => {
      navigate(`/chat/${session.id}`, { state: { ask: q } });
    },
  });

  const onAsk = (e: FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (q && !ask.isPending) ask.mutate(q);
  };

  const counts = status.data?.counts;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1180px] px-8 py-8">
        <div className="mb-6">
          <h1 className="font-display text-[25px] font-semibold leading-tight tracking-tight text-ink">
            Dashboard
          </h1>
          <p className="mt-0.5 text-[14px] text-ink-3">Knowledge base at a glance.</p>
        </div>

        {status.isError ? (
          <ErrorState error={status.error} onRetry={() => void status.refetch()} />
        ) : status.isLoading ? (
          <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton h-[104px]" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
            <StatCard
              label="Documents"
              value={counts ? String(counts.documents) : "0"}
              sub={counts ? `${counts.raw} raw files` : undefined}
            />
            <StatCard
              label="Concepts"
              value={counts ? String(counts.concepts) : "0"}
              sub={counts ? `${counts.summaries} summaries` : undefined}
            />
            <StatCard
              label="Entities"
              value={counts ? String(counts.entities) : "0"}
              sub={counts ? `${counts.explorations} explorations` : undefined}
            />
            <StatCard
              label="Last compile"
              value={status.data ? formatRelative(status.data.last_compile) : "—"}
              sub={status.data ? `last lint ${formatRelative(status.data.last_lint)}` : undefined}
              big={false}
            />
          </div>
        )}

        <form onSubmit={onAsk} className="mt-6 flex max-w-[640px] items-center gap-2.5">
          <div className="relative flex-1">
            <svg
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <circle cx="7" cy="7" r="4.3" />
              <path d="M10.2 10.2 14 14" strokeLinecap="round" />
            </svg>
            <input
              className="input pl-9"
              placeholder="Ask the knowledge base…"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              aria-label="Ask the knowledge base"
            />
          </div>
          <button
            className="btn btn-primary shrink-0"
            disabled={!question.trim() || ask.isPending}
          >
            {ask.isPending ? <Spinner className="h-4 w-4 text-accent-fg" /> : "Ask →"}
          </button>
        </form>
        {ask.isError && (
          <p className="mt-2 text-xs text-rose-fg">
            Could not start a chat: {errorMessage(ask.error)}
          </p>
        )}

        <div className="mt-6 grid gap-[18px] lg:grid-cols-3">
          <section className="card overflow-hidden lg:col-span-2">
            <h2 className="border-b border-line px-[17px] py-[13px] text-[13px] font-semibold text-ink">
              Recent activity
            </h2>
            {activity.isError ? (
              <div className="p-4">
                <ErrorState error={activity.error} onRetry={() => void activity.refetch()} />
              </div>
            ) : activity.isLoading ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="skeleton h-6" />
                ))}
              </div>
            ) : activity.data && activity.data.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  title="No recent activity"
                  hint="Add documents to start building the knowledge base."
                />
              </div>
            ) : (
              <ul>
                {(activity.data ?? []).map((entry, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-[11px] border-b border-line px-[17px] py-[11px] last:border-b-0"
                  >
                    <span className={`shrink-0 ${operationStyle(entry.operation)}`}>
                      {entry.operation}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
                      {entry.description}
                    </span>
                    <span className="shrink-0 font-mono text-[11.5px] font-medium text-ink-3">
                      {entry.timestamp}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card h-fit overflow-hidden">
            <h2 className="border-b border-line px-[17px] py-[13px] text-[13px] font-semibold text-ink">
              Wiki health
            </h2>
            {health.isError ? (
              <div className="p-4">
                <ErrorState error={health.error} onRetry={() => void health.refetch()} />
              </div>
            ) : health.data ? (
              <div>
                <HealthSection label="Broken links" items={health.data.broken_links} />
                <HealthSection label="Orphan pages" items={health.data.orphans} />
                <HealthSection label="Index sync" items={health.data.index_sync} />
                <HealthSection
                  label="Invalid frontmatter"
                  items={health.data.invalid_frontmatter}
                />
              </div>
            ) : (
              <div className="space-y-2 p-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="skeleton h-6" />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
