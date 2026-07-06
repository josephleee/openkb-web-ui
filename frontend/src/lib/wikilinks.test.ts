import { describe, expect, it } from "vitest";
import type { WikiLink } from "../api/types";
import { UNRESOLVED_HREF, transformWikilinks } from "./wikilinks";

const link = (raw: string, target: string | null, alias: string | null): WikiLink => ({
  raw,
  target,
  alias,
});

describe("transformWikilinks", () => {
  it("turns a resolved wikilink into a markdown link under /wiki/", () => {
    const out = transformWikilinks("See [[concepts/attention]].", [
      link("concepts/attention", "concepts/attention", "concepts/attention"),
    ]);
    expect(out).toBe("See [concepts/attention](</wiki/concepts/attention>).");
  });

  it("falls back to the target as link text when alias is null (backend shape)", () => {
    // The backend sends alias: null for pipe-less links.
    const out = transformWikilinks("See [[concepts/attention]].", [
      link("concepts/attention", "concepts/attention", null),
    ]);
    expect(out).toBe("See [concepts/attention](</wiki/concepts/attention>).");
  });

  it("uses the alias after | as the link text", () => {
    const out = transformWikilinks("See [[concepts/attention|Attention]].", [
      link("concepts/attention|Attention", "concepts/attention", "Attention"),
    ]);
    expect(out).toBe("See [Attention](</wiki/concepts/attention>).");
  });

  it("resolves fuzzy-matched targets to the server-resolved page", () => {
    const out = transformWikilinks("[[concepts/Gist_Memory]]", [
      link("concepts/Gist_Memory", "concepts/gist-memory", "concepts/Gist_Memory"),
    ]);
    expect(out).toBe("[concepts/Gist\\_Memory](</wiki/concepts/gist-memory>)");
  });

  it("renders unresolved wikilinks (target null) as the sentinel href", () => {
    const out = transformWikilinks("A [[concepts/missing]] link.", [
      link("concepts/missing", null, "concepts/missing"),
    ]);
    expect(out).toBe(`A [concepts/missing](${UNRESOLVED_HREF}) link.`);
  });

  it("treats wikilinks without a resolution entry as unresolved by default", () => {
    const out = transformWikilinks("A [[concepts/unknown]] link.", []);
    expect(out).toBe(`A [concepts/unknown](${UNRESOLVED_HREF}) link.`);
  });

  it("resolves optimistically in assumeResolved mode (chat answers)", () => {
    const out = transformWikilinks(
      "See [[concepts/attention|Attention]].",
      undefined,
      { assumeResolved: true },
    );
    expect(out).toBe("See [Attention](</wiki/concepts/attention>).");
  });

  it("accepts raw keys wrapped in [[...]] from the server", () => {
    const out = transformWikilinks("[[concepts/attention]]", [
      link("[[concepts/attention]]", "concepts/attention", "concepts/attention"),
    ]);
    expect(out).toBe("[concepts/attention](</wiki/concepts/attention>)");
  });

  it("percent-encodes targets containing spaces", () => {
    const out = transformWikilinks("[[entities/John Smith]]", [
      link("entities/John Smith", "entities/John Smith", "entities/John Smith"),
    ]);
    expect(out).toBe("[entities/John Smith](</wiki/entities/John%20Smith>)");
  });

  it("escapes markdown-significant characters in the alias", () => {
    // OpenKB's wikilink regex ([^\]]+) forbids ] inside the brackets, but [,
    // *, _ and ` can occur and must not break the generated link text.
    const out = transformWikilinks("[[concepts/x|a [b *c*]]", [
      link("concepts/x|a [b *c*", "concepts/x", "a [b *c*"),
    ]);
    expect(out).toBe("[a \\[b \\*c\\*](</wiki/concepts/x>)");
  });

  it("transforms multiple wikilinks on one line independently", () => {
    const out = transformWikilinks("[[concepts/a]] and [[concepts/b]]", [
      link("concepts/a", "concepts/a", "concepts/a"),
      link("concepts/b", null, "concepts/b"),
    ]);
    expect(out).toBe(
      `[concepts/a](</wiki/concepts/a>) and [concepts/b](${UNRESOLVED_HREF})`,
    );
  });

  it("leaves wikilinks inside fenced code blocks untouched", () => {
    const body = [
      "before [[concepts/a]]",
      "```",
      "code [[concepts/a]] stays",
      "```",
      "after [[concepts/a]]",
    ].join("\n");
    const out = transformWikilinks(body, [
      link("concepts/a", "concepts/a", "concepts/a"),
    ]);
    expect(out).toBe(
      [
        "before [concepts/a](</wiki/concepts/a>)",
        "```",
        "code [[concepts/a]] stays",
        "```",
        "after [concepts/a](</wiki/concepts/a>)",
      ].join("\n"),
    );
  });

  it("returns the body unchanged when it contains no wikilinks", () => {
    const body = "# Title\n\nPlain markdown with a [link](https://example.com).";
    expect(transformWikilinks(body, [])).toBe(body);
  });
});
