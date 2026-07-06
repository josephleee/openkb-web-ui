import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { createChatSession, getActivity, getHealth, getStatus } from "../api/client";
import { errorMessage } from "../api/http";
import { EmptyState, ErrorState, Spinner } from "../components/States";
import { formatRelative } from "../lib/format";

const OPERATION_STYLES: Record<string, string> = {
  add: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  remove: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
  recompile: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  chat: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  query: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  lint: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
};

function operationStyle(op: string): string {
  return (
    OPERATION_STYLES[op.toLowerCase()] ??
    "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100">
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">{sub}</div>}
    </div>
  );
}

function HealthSection({ label, items }: { label: string; items: string[] }) {
  return (
    <details className="group rounded-lg border border-slate-200 dark:border-slate-800">
      <summary className="flex cursor-pointer select-none items-center justify-between px-3 py-2 text-sm">
        <span className="text-slate-600 dark:text-slate-300">{label}</span>
        {items.length === 0 ? (
          <span className="chip bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
            OK
          </span>
        ) : (
          <span className="chip bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
            {items.length}
          </span>
        )}
      </summary>
      {items.length > 0 && (
        <ul className="max-h-48 space-y-1 overflow-y-auto border-t border-slate-200 px-3 py-2 dark:border-slate-800">
          {items.map((item, i) => (
            <li key={i} className="break-words font-mono text-xs text-slate-500 dark:text-slate-400">
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
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <div>
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Dashboard
          </h1>
          <p className="text-sm text-slate-400 dark:text-slate-500">
            Knowledge base at a glance
          </p>
        </div>

        {status.isError ? (
          <ErrorState error={status.error} onRetry={() => void status.refetch()} />
        ) : (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="Documents" value={counts ? String(counts.documents) : "…"} sub={counts ? `${counts.raw} raw files` : undefined} />
            <StatCard label="Concepts" value={counts ? String(counts.concepts) : "…"} sub={counts ? `${counts.summaries} summaries` : undefined} />
            <StatCard label="Entities" value={counts ? String(counts.entities) : "…"} sub={counts ? `${counts.explorations} explorations` : undefined} />
            <StatCard
              label="Last compile"
              value={status.data ? formatRelative(status.data.last_compile) : "…"}
              sub={status.data ? `last lint ${formatRelative(status.data.last_lint)}` : undefined}
            />
          </div>
        )}

        <form onSubmit={onAsk} className="card flex items-center gap-2 p-3">
          <input
            className="input"
            placeholder="Ask the knowledge base anything…"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            aria-label="Quick ask"
          />
          <button className="btn btn-primary shrink-0" disabled={!question.trim() || ask.isPending}>
            {ask.isPending ? <Spinner className="h-4 w-4 text-white" /> : "Ask"}
          </button>
        </form>
        {ask.isError && (
          <p className="text-xs text-rose-600 dark:text-rose-400">
            Could not start a chat: {errorMessage(ask.error)}
          </p>
        )}

        <div className="grid gap-6 lg:grid-cols-3">
          <section className="card p-4 lg:col-span-2">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Recent activity
            </h2>
            <div className="mt-3">
              {activity.isError ? (
                <ErrorState error={activity.error} onRetry={() => void activity.refetch()} />
              ) : activity.data && activity.data.length === 0 ? (
                <EmptyState
                  title="No activity yet"
                  hint="Operations like add, remove, and recompile are logged here once you add your first document."
                />
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {(activity.data ?? []).map((entry, i) => (
                    <li key={i} className="flex items-start gap-3 py-2">
                      <span className={`chip mt-0.5 shrink-0 ${operationStyle(entry.operation)}`}>
                        {entry.operation}
                      </span>
                      <span className="min-w-0 flex-1 break-words text-sm text-slate-600 dark:text-slate-300">
                        {entry.description}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-slate-400 dark:text-slate-500">
                        {entry.timestamp}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="card h-fit p-4">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Wiki health
            </h2>
            <div className="mt-3 space-y-2">
              {health.isError ? (
                <ErrorState error={health.error} onRetry={() => void health.refetch()} />
              ) : health.data ? (
                <>
                  <HealthSection label="Broken links" items={health.data.broken_links} />
                  <HealthSection label="Orphan pages" items={health.data.orphans} />
                  <HealthSection label="Index sync" items={health.data.index_sync} />
                  <HealthSection
                    label="Invalid frontmatter"
                    items={health.data.invalid_frontmatter}
                  />
                </>
              ) : (
                <div className="flex justify-center py-4">
                  <Spinner />
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
