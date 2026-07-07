import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState, type FormEvent } from "react";
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from "react-force-graph-2d";
import { useNavigate } from "react-router-dom";
import { getGraph } from "../api/client";
import type { GraphEdge, GraphNode } from "../api/types";
import { EmptyState, ErrorState, PageLoading } from "../components/States";
import { useIsDark } from "../lib/theme";

type FgNode = NodeObject<GraphNode>;
type FgLink = LinkObject<GraphNode, GraphEdge>;

// Canvas needs literal hex (not CSS vars). Node colors are keyed by the
// server's type name, with a per-theme light/dark pair each.
const NODE_COLORS: Record<string, { light: string; dark: string }> = {
  Concept: { light: "#7c50eb", dark: "#a78bfa" },
  Summary: { light: "#0a72c0", dark: "#38bdf8" },
  Organization: { light: "#d69614", dark: "#fbbf24" },
  Entity: { light: "#0c9a5f", dark: "#34d399" },
};
const FALLBACK_COLOR = { light: "#948a75", dark: "#8d7e68" };

function nodeRadius(node: GraphNode): number {
  return 2.5 + Math.sqrt(node.in + node.out);
}

export default function GraphPage() {
  const navigate = useNavigate();
  const dark = useIsDark();
  const graphQuery = useQuery({ queryKey: ["graph"], queryFn: getGraph });
  const graph = graphQuery.data;

  const [hiddenTypes, setHiddenTypes] = useState<ReadonlySet<string>>(new Set());
  const [search, setSearch] = useState("");
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const [size, setSize] = useState({ width: 0, height: 0 });
  const fgRef = useRef<ForceGraphMethods<FgNode, FgLink>>();
  const observerRef = useRef<ResizeObserver | null>(null);
  const didFitRef = useRef(false);

  // Callback ref, not useEffect: the container is not mounted during the
  // loading/error early-returns, so a mount-time useEffect would find a null
  // ref and never observe. A callback ref fires whenever the node actually
  // mounts (once the graph resolves), so size is always measured.
  const containerRef = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(el);
    observerRef.current = observer;
  }, []);

  // d3-force mutates node/link objects in place — always hand it copies.
  // Built once per fetched graph (NOT per legend toggle): react-force-graph
  // identifies nodes by object identity, so rebuilding the arrays would throw
  // away every accumulated x/y position and re-run the whole simulation.
  // Legend filtering happens via node/linkVisibility instead.
  const data = useMemo(() => {
    if (!graph) return { nodes: [] as FgNode[], links: [] as FgLink[] };
    const nodes = graph.nodes.map((n) => ({ ...n }));
    const ids = new Set(nodes.map((n) => n.id));
    const links = graph.edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ ...e }));
    return { nodes, links };
  }, [graph]);

  const typeById = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of graph?.nodes ?? []) map.set(node.id, node.type);
    return map;
  }, [graph]);

  const isNodeVisible = useCallback(
    (node: FgNode) => !hiddenTypes.has(node.type),
    [hiddenTypes],
  );

  const isLinkVisible = useCallback(
    (link: FgLink) => {
      // After the simulation starts, link endpoints are node objects; before
      // that they are still the raw string ids.
      const typeOf = (end: FgLink["source"]): string | undefined =>
        typeof end === "object" && end !== null
          ? (end as FgNode).type
          : typeById.get(String(end));
      const source = typeOf(link.source);
      const target = typeOf(link.target);
      return (
        source !== undefined &&
        target !== undefined &&
        !hiddenTypes.has(source) &&
        !hiddenTypes.has(target)
      );
    },
    [hiddenTypes, typeById],
  );

  const visibleCounts = useMemo(
    () => ({
      nodes: data.nodes.filter(isNodeVisible).length,
      links: data.links.filter(isLinkVisible).length,
    }),
    [data, isNodeVisible, isLinkVisible],
  );

  const colorFor = useCallback(
    (type: string) => {
      const entry = NODE_COLORS[type] ?? FALLBACK_COLOR;
      return dark ? entry.dark : entry.light;
    },
    [dark],
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
          isNodeVisible(n) &&
          (n.label.toLowerCase().includes(query) ||
            String(n.id).toLowerCase().includes(query)),
      )
      .slice(0, 8);
  }, [search, data, isNodeVisible]);

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
        ctx.strokeStyle = dark ? "#f0e7d5" : "#221d15";
        ctx.stroke();
      }
      if (scale > 1.4 || highlighted) {
        const fontSize = Math.max(11 / scale, 2);
        ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = dark ? "#c2b49a" : "#5b5344";
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
              nodeVisibility={isNodeVisible}
              linkVisibility={isLinkVisible}
              backgroundColor={dark ? "#1c1610" : "#f2ecdf"}
              nodeLabel={(node) => `${node.label} · ${node.type}`}
              nodeCanvasObject={drawNode}
              nodeCanvasObjectMode={() => "replace"}
              nodePointerAreaPaint={paintPointerArea}
              linkColor={() =>
                dark ? "rgba(255, 255, 255, 0.16)" : "rgba(20, 22, 28, 0.16)"
              }
              linkDirectionalArrowLength={3}
              linkDirectionalArrowRelPos={1}
              onNodeClick={(node) => navigate(`/wiki/${node.id}`)}
              onBackgroundClick={() => setHighlightId(null)}
              cooldownTicks={200}
              onEngineStop={() => {
                // Frame all nodes once the layout settles, but only the first
                // time — dragging a node reheats and re-stops the engine, and
                // refitting then would fight the user's pan/zoom.
                if (!didFitRef.current) {
                  didFitRef.current = true;
                  fgRef.current?.zoomToFit(400, 60);
                }
              }}
            />
          )}

          <form onSubmit={onSearchSubmit} className="absolute left-4 top-4 w-64">
            <input
              className="input shadow-card"
              placeholder="Search nodes…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search graph nodes"
            />
            {matches.length > 0 && (
              <ul className="card mt-1 max-h-64 divide-y divide-line overflow-y-auto p-0">
                {matches.map((node) => (
                  <li key={String(node.id)}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2"
                      onClick={() => {
                        focusNode(node);
                        setSearch("");
                      }}
                    >
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: colorFor(node.type) }}
                      />
                      <span className="min-w-0 flex-1 truncate text-ink">{node.label}</span>
                      <span className="shrink-0 font-mono text-[11px] text-ink-3">{node.type}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {search.trim() && matches.length === 0 && (
              <div className="card mt-1 px-3 py-2 text-xs text-ink-3">No matching nodes</div>
            )}
          </form>

          <div className="card absolute right-4 top-4 w-52 p-3">
            <div className="mb-2 font-mono text-xs font-semibold uppercase tracking-wide text-ink-3">
              Types
            </div>
            <div className="space-y-1">
              {graph.types.map((type) => (
                <label
                  key={type}
                  className="flex cursor-pointer items-center gap-2 text-xs text-ink-2"
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: colorFor(type) }}
                  />
                  <input
                    type="checkbox"
                    checked={!hiddenTypes.has(type)}
                    onChange={() => toggleType(type)}
                  />
                  <span className="min-w-0 flex-1 truncate">{type}</span>
                  <span className="shrink-0 font-mono text-ink-3">{typeCounts[type] ?? 0}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="absolute bottom-4 left-4 rounded-md bg-surface/80 px-2 py-1 text-[11px] text-ink-3 backdrop-blur">
            {visibleCounts.nodes} nodes · {visibleCounts.links} edges — click a node to open its page
          </div>
        </>
      )}
    </div>
  );
}
