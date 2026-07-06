// Shapes mirror the API contract in docs/superpowers/specs/2026-07-06-openkb-web-ui-design.md §4.

export interface KbCounts {
  documents: number;
  summaries: number;
  concepts: number;
  entities: number;
  explorations: number;
  reports: number;
  raw: number;
}

export interface KbStatus {
  kb_dir: string;
  model: string;
  language: string;
  counts: KbCounts;
  last_compile: string | null;
  last_lint: string | null;
  busy: boolean;
}

export interface ActivityEntry {
  timestamp: string;
  operation: string;
  description: string;
}

export interface HealthReport {
  broken_links: string[];
  orphans: string[];
  index_sync: string[];
  invalid_frontmatter: string[];
}

export interface PageSummary {
  kind: string;
  slug: string;
  target: string;
  title: string;
  description?: string | null;
  mtime: number;
}

export interface WikiLink {
  /** Inner text of the [[...]] occurrence, including any |alias part. */
  raw: string;
  /** Resolved wiki target ("concepts/attention") or null when unresolved. */
  target: string | null;
  /** Display text (part after the first |), or null when the link has no alias. */
  alias: string | null;
}

export interface PageDetail {
  target: string;
  kind: string;
  slug: string;
  frontmatter: Record<string, unknown>;
  body: string;
  mtime: number;
  wikilinks: WikiLink[];
}

export interface DocumentEntry {
  doc_name: string;
  name: string;
  type: string;
  display_type: string;
  pages: number | null;
  has_summary: boolean;
  raw_path: string | null;
  source_path: string | null;
}

export type RemovePlanAction = "DELETE" | "MODIFY" | "REGISTRY" | "PAGEINDEX";

export interface RemovePlanLine {
  action: RemovePlanAction;
  target: string;
}

export type JobState = "queued" | "running" | "succeeded" | "failed" | "skipped";

export interface Job {
  id: string;
  kind: string;
  label: string;
  state: JobState;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  detail: string;
}

export type JobEvent =
  | { type: "line"; line: string }
  | { type: "state"; state: JobState }
  | { type: "done"; state: JobState; detail: string };

export interface EnqueuedJob {
  job_id: string;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  turn_count: number;
  updated_at: string;
  model: string;
}

export interface ChatTurn {
  user: string;
  assistant: string;
}

export interface ChatSessionDetail {
  id: string;
  title: string;
  model: string;
  language: string;
  created_at: string;
  updated_at: string;
  turns: ChatTurn[];
}

export type ChatStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "done"; answer: string }
  | { type: "error"; message: string };

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  in: number;
  out: number;
  sources: string[];
  /** Present in OpenKB's build_graph output; not load-bearing for rendering. */
  description?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  types: string[];
}

/** Mirrors openkb.cli.SUPPORTED_EXTENSIONS (upload allowlist). */
export const SUPPORTED_EXTENSIONS = [
  ".pdf",
  ".md",
  ".markdown",
  ".docx",
  ".pptx",
  ".xlsx",
  ".xls",
  ".html",
  ".htm",
  ".txt",
  ".csv",
] as const;

export function hasSupportedExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
