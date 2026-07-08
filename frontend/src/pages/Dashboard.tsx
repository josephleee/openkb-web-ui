import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  createChatSession,
  getActivity,
  getGraph,
  getHealth,
  getStatus,
} from "../api/client";
import { errorMessage } from "../api/http";
import type { GraphData, GraphNode } from "../api/types";
import { EmptyState, ErrorState, Spinner } from "../components/States";
import { formatRelative } from "../lib/format";
import { nodeColor } from "../lib/graphColors";
import { useIsDark } from "../lib/theme";

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
          big ? "text-[30px]" : "text-xl"
        }`}
      >
        {value}
      </div>
      {sub && <div className="mt-2 text-[12px] text-ink-3">{sub}</div>}
    </div>
  );
}

function HealthSection({ label, items }: { label: string; items: string[] }) {
  return (
    <details className="group border-b border-line last:border-b-0">
      <summary className="flex cursor-pointer select-none items-center justify-between px-4 py-2.5 text-[13px]">
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

// --- mini knowledge graph -----------------------------------------------------

const GRAPH_W = 520;
const GRAPH_H = 320;
const GRAPH_PAD = 60; // generous margin so edge nodes' centered labels don't clip
const MAX_PREVIEW_NODES = 48;
const LABEL_LIMIT = 14; // only label nodes when the preview is uncluttered

interface LaidNode {
  node: GraphNode;
  x: number;
  y: number;
  r: number;
}

/**
 * Deterministic force layout for the dashboard preview (no d3 dependency, no
 * randomness so it never flickers between renders). The full interactive graph
 * lives on the Graph page; this is a static, clickable overview. Large KBs are
 * capped to the most-connected nodes.
 */
function computeLayout(graph: GraphData): {
  nodes: LaidNode[];
  links: { a: LaidNode; b: LaidNode }[];
  hidden: number;
} {
  const degree = (n: GraphNode) => n.in + n.out;
  const kept = [...graph.nodes]
    .sort((a, b) => degree(b) - degree(a))
    .slice(0, MAX_PREVIEW_NODES);
  const hidden = graph.nodes.length - kept.length;
  const n = kept.length;
  if (n === 0) return { nodes: [], links: [], hidden: 0 };

  const idx = new Map(kept.map((node, i) => [node.id, i]));
  const keptIds = new Set(idx.keys());
  const edges = graph.edges
    .filter((e) => keptIds.has(e.source) && keptIds.has(e.target))
    .map((e) => [idx.get(e.source)!, idx.get(e.target)!] as [number, number]);

  // Seed on a circle (deterministic), then relax.
  const p = kept.map((_, i) => {
    const a = (i / n) * Math.PI * 2;
    return { x: Math.cos(a) * 0.6, y: Math.sin(a) * 0.6 };
  });

  for (let it = 0; it < 260; it++) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = p[i].x - p[j].x;
        let dy = p[i].y - p[j].y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1e-4) {
          dx = (i - j) * 1e-3 + 1e-3;
          dy = 1e-3;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const rep = 0.02 / d2;
        p[i].x += (dx / d) * rep;
        p[i].y += (dy / d) * rep;
        p[j].x -= (dx / d) * rep;
        p[j].y -= (dy / d) * rep;
      }
    }
    for (const [a, b] of edges) {
      const dx = p[b].x - p[a].x;
      const dy = p[b].y - p[a].y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1e-4;
      const f = (d - 0.5) * 0.06;
      p[a].x += (dx / d) * f;
      p[a].y += (dy / d) * f;
      p[b].x -= (dx / d) * f;
      p[b].y -= (dy / d) * f;
    }
    for (let i = 0; i < n; i++) {
      p[i].x *= 0.995;
      p[i].y *= 0.995;
    }
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const q of p) {
    minX = Math.min(minX, q.x);
    maxX = Math.max(maxX, q.x);
    minY = Math.min(minY, q.y);
    maxY = Math.max(maxY, q.y);
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const innerW = GRAPH_W - GRAPH_PAD * 2;
  const innerH = GRAPH_H - GRAPH_PAD * 2;

  const laid: LaidNode[] = kept.map((node, i) => ({
    node,
    x: spanX < 0.01 ? GRAPH_W / 2 : ((p[i].x - minX) / spanX) * innerW + GRAPH_PAD,
    y: spanY < 0.01 ? GRAPH_H / 2 : ((p[i].y - minY) / spanY) * innerH + GRAPH_PAD,
    r: Math.min(13, 4.5 + Math.sqrt(degree(node)) * 2.1),
  }));
  const links = edges.map(([a, b]) => ({ a: laid[a], b: laid[b] }));
  return { nodes: laid, links, hidden };
}

function MiniGraph({ graph }: { graph: GraphData }) {
  const navigate = useNavigate();
  const dark = useIsDark();
  const { nodes, links, hidden } = useMemo(() => computeLayout(graph), [graph]);
  const showLabels = nodes.length <= LABEL_LIMIT;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${GRAPH_W} ${GRAPH_H}`}
        width="100%"
        height={GRAPH_H}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Knowledge graph with ${graph.nodes.length} pages`}
      >
        <g className="stroke-line-strong" strokeWidth={1}>
          {links.map((l, i) => (
            <line key={i} x1={l.a.x} y1={l.a.y} x2={l.b.x} y2={l.b.y} />
          ))}
        </g>
        {nodes.map((l) => (
          <g
            key={l.node.id}
            className="cursor-pointer [&:hover_text]:fill-ink"
            onClick={() => navigate(`/wiki/${l.node.id}`)}
            role="link"
            tabIndex={0}
            aria-label={`Open ${l.node.label}`}
            onKeyDown={(e) => {
              if (e.key === "Enter") navigate(`/wiki/${l.node.id}`);
            }}
          >
            <title>
              {l.node.label} · {l.node.type}
            </title>
            <circle
              cx={l.x}
              cy={l.y}
              r={l.r}
              fill={nodeColor(l.node.type, dark)}
              className="transition-[r]"
            />
            {showLabels && (
              <text
                x={l.x}
                y={l.y + l.r + 12}
                textAnchor="middle"
                className="fill-ink-2"
                style={{ fontSize: 11, fontFamily: "var(--font-ui)" }}
              >
                {l.node.label}
              </text>
            )}
          </g>
        ))}
      </svg>
      {hidden > 0 && (
        <div className="absolute bottom-2 left-3 font-mono text-[11px] text-ink-3">
          + {hidden} more nodes — open the full graph
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [question, setQuestion] = useState("");
  const status = useQuery({ queryKey: ["status"], queryFn: getStatus });
  const activity = useQuery({ queryKey: ["activity"], queryFn: () => getActivity(25) });
  const health = useQuery({ queryKey: ["health"], queryFn: getHealth });
  const graph = useQuery({ queryKey: ["graph"], queryFn: getGraph });

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
  const edgeCount = graph.data?.edges.length ?? 0;
  const nodeCount = graph.data?.nodes.length ?? 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1180px] px-8 py-8">
        <div className="mb-6">
          <h1 className="font-display text-[25px] font-semibold leading-tight tracking-tight text-ink">
            Dashboard
          </h1>
          <p className="mt-0.5 text-[14px] text-ink-3">Knowledge base at a glance.</p>
        </div>

        {/* Graph-first hero: the wikilink graph beside stats + health. */}
        <div className="grid gap-[18px] lg:grid-cols-[1.6fr_1fr]">
          <section className="card flex min-h-[380px] flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-line px-[17px] py-[13px]">
              <h2 className="text-[13px] font-semibold text-ink">Knowledge graph</h2>
              <div className="flex items-center gap-3">
                <span className="font-mono text-[11px] text-ink-3">
                  {nodeCount} nodes · {edgeCount} links
                </span>
                <Link
                  to="/graph"
                  className="text-[12.5px] font-medium text-accent hover:underline"
                >
                  Full graph →
                </Link>
              </div>
            </div>
            <div className="flex flex-1 items-center justify-center p-3">
              {graph.isError ? (
                <ErrorState error={graph.error} onRetry={() => void graph.refetch()} />
              ) : graph.isLoading ? (
                <div className="skeleton h-[300px] w-full" />
              ) : graph.data && graph.data.nodes.length > 0 ? (
                <MiniGraph graph={graph.data} />
              ) : (
                <EmptyState
                  title="The graph is empty"
                  hint="Add documents and the wikilink graph between summaries, concepts, and entities appears here."
                />
              )}
            </div>
          </section>

          <div className="grid content-start gap-[18px]">
            {status.isError ? (
              <ErrorState error={status.error} onRetry={() => void status.refetch()} />
            ) : status.isLoading ? (
              <div className="grid grid-cols-2 gap-3.5">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="skeleton h-[100px]" />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3.5">
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

        <form onSubmit={onAsk} className="mt-[18px] flex items-center gap-2.5">
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

        <section className="card mt-[18px] overflow-hidden">
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
      </div>
    </div>
  );
}
