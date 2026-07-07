import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getPage, getPages, wikiFileUrl } from "../api/client";
import type { PageSummary } from "../api/types";
import Markdown from "../components/Markdown";
import { EmptyState, ErrorState, PageLoading, Spinner } from "../components/States";
import { formatRelativeFromEpoch } from "../lib/format";

const KIND_ORDER = ["summaries", "concepts", "entities", "explorations"];
const KIND_LABELS: Record<string, string> = {
  summaries: "Summaries",
  concepts: "Concepts",
  entities: "Entities",
  explorations: "Explorations",
};

// Type-colored dot per page kind (mapping: Summary=sky, Concept=violet,
// Entity=emerald, Organization/exploration=amber; unknown → neutral).
const KIND_DOT: Record<string, string> = {
  summaries: "bg-sky-fg",
  concepts: "bg-violet-fg",
  entities: "bg-em-fg",
  explorations: "bg-amber-fg",
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

// Page-type frontmatter chip color, following the status → color mapping.
function typeChipClass(type: string): string {
  switch (type) {
    case "Summary":
      return "chip-sky";
    case "Concept":
      return "chip-violet";
    case "Entity":
      return "chip-emerald";
    case "Organization":
      return "chip-amber";
    default:
      return "chip-neutral";
  }
}

function SourceChip({ source }: { source: string }) {
  // Frontmatter sources are either wiki page refs ("summaries/paper") or
  // source-file paths ("sources/paper.json") — branch on the prefix.
  if (source.startsWith("sources/")) {
    return (
      <a className="chip-neutral hover:underline" href={wikiFileUrl(source)} target="_blank" rel="noreferrer">
        {source}
      </a>
    );
  }
  return (
    <Link className="chip-neutral hover:underline" to={`/wiki/${source}`}>
      {source}
    </Link>
  );
}

function Sidebar({
  pages,
  activeTarget,
  loading,
  error,
  onRetry,
}: {
  pages: PageSummary[];
  activeTarget: string;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const [filter, setFilter] = useState("");

  const groups = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const matched = pages.filter(
      (p) =>
        p.kind !== "index" &&
        (!query ||
          p.title.toLowerCase().includes(query) ||
          p.target.toLowerCase().includes(query)),
    );
    const byKind = new Map<string, PageSummary[]>();
    for (const page of matched) {
      const list = byKind.get(page.kind) ?? [];
      list.push(page);
      byKind.set(page.kind, list);
    }
    const kinds = [
      ...KIND_ORDER.filter((k) => byKind.has(k)),
      ...[...byKind.keys()].filter((k) => !KIND_ORDER.includes(k)).sort(),
    ];
    return kinds.map((kind) => ({
      kind,
      pages: byKind.get(kind)!.slice().sort((a, b) => a.title.localeCompare(b.title)),
    }));
  }, [pages, filter]);

  return (
    <aside className="flex w-[250px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="border-b border-line p-3">
        <input
          className="input"
          placeholder="Filter pages…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter pages"
        />
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <Link
          to="/wiki"
          className={`flex items-center rounded-md border px-2.5 py-1.5 font-mono text-[13px] ${
            activeTarget === "index"
              ? "border-accent-line bg-accent-soft text-accent"
              : "border-transparent text-ink-2 hover:bg-surface-2 hover:text-ink"
          }`}
        >
          Index
        </Link>
        {groups.map((group) => (
          <div key={group.kind} className="mt-3">
            <div className="px-2.5 pb-1 font-mono text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              {kindLabel(group.kind)} ({group.pages.length})
            </div>
            {group.pages.map((page) => (
              <Link
                key={page.target}
                to={`/wiki/${page.target}`}
                title={page.description ?? page.target}
                className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 font-mono text-[13px] ${
                  activeTarget === page.target
                    ? "border-accent-line bg-accent-soft text-accent"
                    : "border-transparent text-ink-2 hover:bg-surface-2 hover:text-ink"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${KIND_DOT[group.kind] ?? "bg-neutral-fg"}`}
                  aria-hidden="true"
                />
                <span className="truncate">{page.slug}</span>
              </Link>
            ))}
          </div>
        ))}
        {loading && (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        )}
        {!loading && error && (
          <div className="px-2.5 py-2">
            <p className="text-xs text-rose-fg">Could not load pages.</p>
            <button className="btn btn-sm mt-1.5" onClick={onRetry}>
              Retry
            </button>
          </div>
        )}
        {!loading && !error && groups.length === 0 && (
          <p className="px-2.5 py-2 text-xs text-ink-3">
            {filter ? `No pages match “${filter}”.` : "No pages yet."}
          </p>
        )}
      </nav>
    </aside>
  );
}

export default function WikiPage() {
  const params = useParams();
  const splat = params["*"] ?? "";
  const target = splat.replace(/\/+$/, "") || "index";

  const pagesQuery = useQuery({ queryKey: ["pages"], queryFn: getPages });
  const pageQuery = useQuery({
    queryKey: ["page", target],
    queryFn: () => getPage(target),
  });

  const page = pageQuery.data;
  const frontmatter = page?.frontmatter ?? {};
  const fmType = typeof frontmatter.type === "string" ? frontmatter.type : null;
  const fmDocType = typeof frontmatter.doc_type === "string" ? frontmatter.doc_type : null;
  const fmDescription =
    typeof frontmatter.description === "string" ? frontmatter.description : null;
  const fmSources = Array.isArray(frontmatter.sources)
    ? frontmatter.sources.filter((s): s is string => typeof s === "string")
    : [];
  const fmFullText =
    typeof frontmatter.full_text === "string" ? frontmatter.full_text : null;

  return (
    <div className="flex h-full">
      <Sidebar
        pages={pagesQuery.data ?? []}
        activeTarget={target}
        loading={pagesQuery.isLoading}
        error={pagesQuery.isError}
        onRetry={() => void pagesQuery.refetch()}
      />
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl p-6">
          {pageQuery.isLoading ? (
            <PageLoading />
          ) : pageQuery.isError ? (
            <ErrorState error={pageQuery.error} onRetry={() => void pageQuery.refetch()} />
          ) : page ? (
            <article>
              <nav className="flex items-center gap-1.5 font-mono text-xs text-ink-3">
                <Link to="/wiki" className="hover:text-ink">
                  wiki
                </Link>
                {page.target !== "index" &&
                  page.target.split("/").map((part, i, parts) => (
                    <span key={i} className="flex items-center gap-1.5">
                      <span className="text-ink-3">/</span>
                      {i === parts.length - 1 ? (
                        <span className="text-ink-2">{part}</span>
                      ) : (
                        <span>{part}</span>
                      )}
                    </span>
                  ))}
              </nav>

              <header className="mt-2 border-b border-line pb-4">
                <h1 className="font-display text-[29px] font-semibold leading-tight tracking-tight text-ink">
                  {typeof frontmatter.title === "string" ? frontmatter.title : page.slug}
                </h1>
                {fmDescription && (
                  <p className="mt-1 text-sm text-ink-2">{fmDescription}</p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {fmType && <span className={typeChipClass(fmType)}>{fmType}</span>}
                  {fmDocType && (
                    <span className={fmDocType === "pageindex" ? "chip-violet" : "chip-neutral"}>
                      {fmDocType}
                    </span>
                  )}
                  {fmFullText && <SourceChip source={fmFullText} />}
                  {fmSources.map((source) => (
                    <SourceChip key={source} source={source} />
                  ))}
                  <span className="ml-auto font-mono text-[11px] text-ink-3">
                    Updated {formatRelativeFromEpoch(page.mtime)}
                  </span>
                </div>
              </header>

              {page.body.trim() ? (
                <Markdown wikilinks={page.wikilinks} className="mt-4">
                  {page.body}
                </Markdown>
              ) : (
                <div className="mt-6">
                  <EmptyState
                    title="This page is empty"
                    hint="Content appears here after documents are compiled into the wiki."
                  />
                </div>
              )}
            </article>
          ) : null}
        </div>
      </div>
    </div>
  );
}
