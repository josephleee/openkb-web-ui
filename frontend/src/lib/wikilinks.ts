import type { WikiLink } from "../api/types";

/** Sentinel href marking a wikilink that resolves to no existing page. */
export const UNRESOLVED_HREF = "#--unresolved-wikilink";

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g; // OpenKB's lint._WIKILINK_RE
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

export interface WikilinkTransformOptions {
  /**
   * Resolve every wikilink to its literal target instead of requiring a
   * resolution entry. Used for chat answers, which arrive without a
   * server-resolved wikilinks array.
   */
  assumeResolved?: boolean;
}

/** Escape characters that would change meaning inside markdown link text. */
function escapeLinkText(text: string): string {
  return text.replace(/([\\[\]*_`])/g, "\\$1");
}

/** Percent-encode a destination for the angle-bracket markdown link form. */
function encodeDestination(target: string): string {
  return encodeURI(target).replace(/</g, "%3C").replace(/>/g, "%3E");
}

function buildIndex(links: WikiLink[] | undefined): Map<string, WikiLink> {
  const index = new Map<string, WikiLink>();
  for (const link of links ?? []) {
    index.set(link.raw, link);
    // Tolerate servers keying `raw` as the full [[...]] occurrence.
    const wrapped = /^\[\[([^\]]+)\]\]$/.exec(link.raw);
    if (wrapped) index.set(wrapped[1], link);
  }
  return index;
}

/**
 * Pre-transform OpenKB [[target]] / [[target|alias]] syntax into standard
 * markdown links that the Markdown component renders as router links.
 * Resolution comes from the page API's wikilinks array (OpenKB lint
 * semantics); unresolved links become UNRESOLVED_HREF anchors, rendered as
 * muted spans. Lines inside fenced code blocks are left untouched.
 */
export function transformWikilinks(
  body: string,
  links?: WikiLink[],
  opts?: WikilinkTransformOptions,
): string {
  if (!body.includes("[[")) return body;
  const index = buildIndex(links);

  let fenceChar: string | null = null;
  return body
    .split("\n")
    .map((line) => {
      const fence = FENCE_RE.exec(line);
      if (fence) {
        const char = fence[1][0];
        if (fenceChar === null) fenceChar = char;
        else if (fenceChar === char) fenceChar = null;
        return line;
      }
      if (fenceChar !== null) return line;

      return line.replace(WIKILINK_RE, (match, inner: string) => {
        const entry = index.get(inner) ?? index.get(match);
        const pipe = inner.indexOf("|");
        const rawTarget = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
        const rawAlias =
          pipe === -1 ? rawTarget : inner.slice(pipe + 1).trim() || rawTarget;
        const alias = entry?.alias?.trim() || rawAlias;
        const target = entry
          ? entry.target
          : opts?.assumeResolved
            ? rawTarget
            : null;
        if (!target) return `[${escapeLinkText(alias)}](${UNRESOLVED_HREF})`;
        return `[${escapeLinkText(alias)}](</wiki/${encodeDestination(target)}>)`;
      });
    })
    .join("\n");
}
