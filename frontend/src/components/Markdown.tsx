import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Link } from "react-router-dom";
import remarkGfm from "remark-gfm";
import type { WikiLink } from "../api/types";
import { UNRESOLVED_HREF, transformWikilinks } from "../lib/wikilinks";

const ABSOLUTE_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Rewrite wiki-root-relative asset paths (OpenKB markdown references images
 * as `sources/images/{doc}/p1_img0.png` relative to wiki/) to the backend's
 * raw file route. Absolute URLs, root-relative paths, and anchors pass through.
 */
export function resolveWikiAsset(src: string): string {
  if (!src || ABSOLUTE_RE.test(src) || src.startsWith("/") || src.startsWith("#")) {
    return src;
  }
  return `/api/wiki-file/${encodeURI(src)}`;
}

const components: Components = {
  a({ href, children, title }) {
    const url = href ?? "";
    if (url === UNRESOLVED_HREF) {
      return (
        <span className="wikilink-unresolved" title="No matching page in this wiki">
          {children}
        </span>
      );
    }
    if (url.startsWith("/wiki/")) {
      return (
        <Link className="wikilink" to={url} title={title}>
          {children}
        </Link>
      );
    }
    if (url.startsWith("#")) {
      return (
        <a href={url} title={title}>
          {children}
        </a>
      );
    }
    // External URLs and relative wiki files (e.g. sources/paper.json) open in
    // a new tab; relative paths are served through the wiki-file API.
    return (
      <a href={resolveWikiAsset(url)} title={title} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
  img({ src, alt, title }) {
    return <img src={resolveWikiAsset(src ?? "")} alt={alt ?? ""} title={title} loading="lazy" />;
  },
};

interface MarkdownProps {
  children: string;
  /** Server-resolved wikilinks from the page API; omit for chat answers. */
  wikilinks?: WikiLink[];
  /** Resolve wikilinks optimistically when no resolution array is available. */
  assumeResolvedWikilinks?: boolean;
  className?: string;
}

export default function Markdown({
  children,
  wikilinks,
  assumeResolvedWikilinks,
  className,
}: MarkdownProps) {
  const text = useMemo(
    () =>
      transformWikilinks(children, wikilinks, {
        assumeResolved: assumeResolvedWikilinks,
      }),
    [children, wikilinks, assumeResolvedWikilinks],
  );
  return (
    <div className={className ? `markdown-body ${className}` : "markdown-body"}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
