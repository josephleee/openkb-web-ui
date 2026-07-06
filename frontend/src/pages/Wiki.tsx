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

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
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
    <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="border-b border-slate-200 p-3 dark:border-slate-800">
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
          className={`block rounded-md px-3 py-1.5 text-sm font-medium ${
            activeTarget === "index"
              ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
              : "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          }`}
        >
          Index
        </Link>
        {groups.map((group) => (
          <div key={group.kind} className="mt-3">
            <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
              {kindLabel(group.kind)}
              <span className="ml-1 font-normal">({group.pages.length})</span>
            </div>
            {group.pages.map((page) => (
              <Link
                key={page.target}
                to={`/wiki/${page.target}`}
                title={page.description ?? page.target}
                className={`block truncate rounded-md px-3 py-1.5 text-sm ${
                  activeTarget === page.target
                    ? "bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                    : "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                }`}
              >
                {page.title}
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
          <div className="px-3 py-2">
            <p className="text-xs text-rose-600 dark:text-rose-400">
              Could not load pages.
            </p>
            <button className="btn btn-sm mt-1.5" onClick={onRetry}>
              Retry
            </button>
          </div>
        )}
        {!loading && !error && groups.length === 0 && (
          <p className="px-3 py-2 text-xs text-slate-400 dark:text-slate-500">
            {filter ? "No pages match the filter." : "No pages yet."}
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
              <nav className="flex items-center gap-1.5 text-xs text-slate-400 dark:text-slate-500">
                <Link to="/wiki" className="hover:text-slate-600 dark:hover:text-slate-300">
                  wiki
                </Link>
                {page.target !== "index" &&
                  page.target.split("/").map((part, i, parts) => (
                    <span key={i} className="flex items-center gap-1.5">
                      <span>/</span>
                      {i === parts.length - 1 ? (
                        <span className="text-slate-500 dark:text-slate-400">{part}</span>
                      ) : (
                        <span>{part}</span>
                      )}
                    </span>
                  ))}
              </nav>

              <header className="mt-2 border-b border-slate-200 pb-4 dark:border-slate-800">
                <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
                  {typeof frontmatter.title === "string" ? frontmatter.title : page.slug}
                </h1>
                {fmDescription && (
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    {fmDescription}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {fmType && <span className="chip-sky">{fmType}</span>}
                  {fmDocType && <span className="chip-violet">{fmDocType}</span>}
                  {fmFullText && <SourceChip source={fmFullText} />}
                  {fmSources.map((source) => (
                    <SourceChip key={source} source={source} />
                  ))}
                  <span className="ml-auto text-[11px] text-slate-400 dark:text-slate-500">
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
