import { useQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from "react-force-graph-2d";
import { useNavigate } from "react-router-dom";
import { getGraph } from "../api/client";
import type { GraphEdge, GraphNode } from "../api/types";
import { EmptyState, ErrorState, PageLoading } from "../components/States";
import { usePrefersDark } from "../lib/theme";

type FgNode = NodeObject<GraphNode>;
type FgLink = LinkObject<GraphNode, GraphEdge>;

// Node colors are keyed off the server's `types` array order (the legend contract).
const PALETTE = [
  "#0ea5e9",
  "#8b5cf6",
  "#f59e0b",
  "#10b981",
  "#ef4444",
  "#ec4899",
  "#14b8a6",
  "#f97316",
  "#6366f1",
  "#84cc16",
];
const FALLBACK_COLOR = "#94a3b8";

function nodeRadius(node: GraphNode): number {
  return 2.5 + Math.sqrt(node.in + node.out);
}

export default function GraphPage() {
  const navigate = useNavigate();
  const dark = usePrefersDark();
  const graphQuery = useQuery({ queryKey: ["graph"], queryFn: getGraph });
  const graph = graphQuery.data;

  const [hiddenTypes, setHiddenTypes] = useState<ReadonlySet<string>>(new Set());
  const [search, setSearch] = useState("");
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const fgRef = useRef<ForceGraphMethods<FgNode, FgLink>>();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // d3-force mutates node/link objects in place — always hand it copies.
  const data = useMemo(() => {
    if (!graph) return { nodes: [] as FgNode[], links: [] as FgLink[] };
    const nodes = graph.nodes
      .filter((n) => !hiddenTypes.has(n.type))
      .map((n) => ({ ...n }));
    const visibleIds = new Set(nodes.map((n) => n.id));
    const links = graph.edges
      .filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
      .map((e) => ({ ...e }));
    return { nodes, links };
  }, [graph, hiddenTypes]);

  const colorFor = useCallback(
    (type: string) => {
      const index = graph?.types.indexOf(type) ?? -1;
      return index === -1 ? FALLBACK_COLOR : PALETTE[index % PALETTE.length];
    },
    [graph],
  );

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const node of graph?.nodes ?? []) {
      counts[node.type] = (counts[node.type] ?? 0) + 1;
    }
    return counts;
  }, [graph]);

  const matches = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return [];
    return data.nodes
      .filter(
        (n) =>
          n.label.toLowerCase().includes(query) ||
          String(n.id).toLowerCase().includes(query),
      )
      .slice(0, 8);
  }, [search, data]);

  const focusNode = useCallback((node: FgNode) => {
    setHighlightId(String(node.id));
    const fg = fgRef.current;
    if (fg && typeof node.x === "number" && typeof node.y === "number") {
      fg.centerAt(node.x, node.y, 600);
      fg.zoom(5, 600);
    }
  }, []);

  const onSearchSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (matches.length > 0) focusNode(matches[0]);
  };

  const toggleType = (type: string) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const drawNode = useCallback(
    (node: FgNode, ctx: CanvasRenderingContext2D, scale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const r = nodeRadius(node);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle = colorFor(node.type);
      ctx.fill();

      const highlighted = highlightId === node.id;
      if (highlighted) {
        ctx.beginPath();
        ctx.arc(x, y, r + 3 / scale, 0, 2 * Math.PI);
        ctx.lineWidth = 2 / scale;
        ctx.strokeStyle = dark ? "#f8fafc" : "#0f172a";
        ctx.stroke();
      }
      if (scale > 1.4 || highlighted) {
        const fontSize = Math.max(11 / scale, 2);
        ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = dark ? "#cbd5e1" : "#334155";
        ctx.fillText(node.label, x, y + r + 2 / scale);
      }
    },
    [colorFor, highlightId, dark],
  );

  const paintPointerArea = useCallback(
    (node: FgNode, color: string, ctx: CanvasRenderingContext2D) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x ?? 0, node.y ?? 0, nodeRadius(node) + 2, 0, 2 * Math.PI);
      ctx.fill();
    },
    [],
  );

  if (graphQuery.isLoading) return <PageLoading />;
  if (graphQuery.isError) {
    return (
      <div className="p-6">
        <ErrorState error={graphQuery.error} onRetry={() => void graphQuery.refetch()} />
      </div>
    );
  }

  const empty = !graph || graph.nodes.length === 0;

  return (
    <div ref={containerRef} className="relative h-full overflow-hidden">
      {empty ? (
        <div className="flex h-full items-center justify-center p-6">
          <EmptyState
            title="The graph is empty"
            hint="Add documents and the wikilink graph between summaries, concepts, and entities appears here."
          />
        </div>
      ) : (
        <>
          {size.width > 0 && size.height > 0 && (
            <ForceGraph2D<GraphNode, GraphEdge>
              ref={fgRef}
              width={size.width}
              height={size.height}
              graphData={data}
              backgroundColor={dark ? "#020617" : "#f8fafc"}
              nodeLabel={(node) => `${node.label} · ${node.type}`}
              nodeCanvasObject={drawNode}
              nodeCanvasObjectMode={() => "replace"}
              nodePointerAreaPaint={paintPointerArea}
              linkColor={() =>
                dark ? "rgba(148, 163, 184, 0.3)" : "rgba(100, 116, 139, 0.3)"
              }
              linkDirectionalArrowLength={3}
              linkDirectionalArrowRelPos={1}
              onNodeClick={(node) => navigate(`/wiki/${node.id}`)}
              onBackgroundClick={() => setHighlightId(null)}
              cooldownTicks={200}
            />
          )}

          <form onSubmit={onSearchSubmit} className="absolute left-4 top-4 w-64">
            <input
              className="input shadow-sm"
              placeholder="Search nodes…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search graph nodes"
            />
            {matches.length > 0 && (
              <ul className="card mt-1 max-h-64 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
                {matches.map((node) => (
                  <li key={String(node.id)}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
                      onClick={() => {
                        focusNode(node);
                        setSearch("");
                      }}
                    >
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: colorFor(node.type) }}
                      />
                      <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200">
                        {node.label}
                      </span>
                      <span className="shrink-0 text-[11px] text-slate-400">{node.type}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {search.trim() && matches.length === 0 && (
              <div className="card mt-1 px-3 py-2 text-xs text-slate-400">No matching nodes</div>
            )}
          </form>

          <div className="card absolute right-4 top-4 w-52 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
              Types
            </div>
            <div className="space-y-1">
              {graph.types.map((type) => (
                <label
                  key={type}
                  className="flex cursor-pointer items-center gap-2 text-xs text-slate-600 dark:text-slate-300"
                >
                  <input
                    type="checkbox"
                    checked={!hiddenTypes.has(type)}
                    onChange={() => toggleType(type)}
                  />
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: colorFor(type) }}
                  />
                  <span className="min-w-0 flex-1 truncate">{type}</span>
                  <span className="shrink-0 text-slate-400 dark:text-slate-500">
                    {typeCounts[type] ?? 0}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="absolute bottom-4 left-4 rounded-md bg-white/80 px-2 py-1 text-[11px] text-slate-500 backdrop-blur dark:bg-slate-900/80 dark:text-slate-400">
            {data.nodes.length} nodes · {data.links.length} edges — click a node to open its page
          </div>
        </>
      )}
    </div>
  );
}
