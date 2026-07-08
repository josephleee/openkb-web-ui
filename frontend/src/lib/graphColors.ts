// Canvas/SVG need literal hex (not CSS vars). Node colors are keyed by the
// server's type name, each with a per-theme light/dark pair. Shared by the
// full Graph page and the Dashboard mini-graph so both stay in sync.
export const NODE_COLORS: Record<string, { light: string; dark: string }> = {
  Concept: { light: "#7c50eb", dark: "#a78bfa" },
  Summary: { light: "#0a72c0", dark: "#38bdf8" },
  Organization: { light: "#d69614", dark: "#fbbf24" },
  Entity: { light: "#0c9a5f", dark: "#34d399" },
};

export const FALLBACK_NODE_COLOR = { light: "#948a75", dark: "#8d7e68" };

export function nodeColor(type: string, dark: boolean): string {
  const entry = NODE_COLORS[type] ?? FALLBACK_NODE_COLOR;
  return dark ? entry.dark : entry.light;
}
