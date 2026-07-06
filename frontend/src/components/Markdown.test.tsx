import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import Markdown from "./Markdown";

const renderMarkdown = (ui: React.ReactElement) =>
  render(<MemoryRouter>{ui}</MemoryRouter>);

describe("Markdown", () => {
  it("renders resolved wikilinks as internal router links", () => {
    renderMarkdown(
      <Markdown
        wikilinks={[
          {
            raw: "concepts/attention|Attention",
            target: "concepts/attention",
            alias: "Attention",
          },
        ]}
      >
        {"See [[concepts/attention|Attention]] for details."}
      </Markdown>,
    );
    const anchor = screen.getByRole("link", { name: "Attention" });
    expect(anchor).toHaveAttribute("href", "/wiki/concepts/attention");
    expect(anchor).toHaveClass("wikilink");
  });

  it("renders unresolved wikilinks as muted spans, not links", () => {
    renderMarkdown(
      <Markdown
        wikilinks={[{ raw: "concepts/missing", target: null, alias: "concepts/missing" }]}
      >
        {"A [[concepts/missing]] reference."}
      </Markdown>,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("concepts/missing")).toHaveClass("wikilink-unresolved");
  });

  it("rewrites wiki-root-relative image sources to the wiki-file API", () => {
    renderMarkdown(<Markdown>{"![figure](sources/images/doc/p1_img0.png)"}</Markdown>);
    expect(screen.getByRole("img", { name: "figure" })).toHaveAttribute(
      "src",
      "/api/wiki-file/sources/images/doc/p1_img0.png",
    );
  });

  it("leaves absolute image URLs untouched and opens external links in a new tab", () => {
    renderMarkdown(
      <Markdown>{"![logo](https://example.com/logo.png) [site](https://example.com)"}</Markdown>,
    );
    expect(screen.getByRole("img", { name: "logo" })).toHaveAttribute(
      "src",
      "https://example.com/logo.png",
    );
    const anchor = screen.getByRole("link", { name: "site" });
    expect(anchor).toHaveAttribute("href", "https://example.com");
    expect(anchor).toHaveAttribute("target", "_blank");
  });

  it("routes relative file links through the wiki-file API", () => {
    renderMarkdown(<Markdown>{"[source](sources/paper.json)"}</Markdown>);
    expect(screen.getByRole("link", { name: "source" })).toHaveAttribute(
      "href",
      "/api/wiki-file/sources/paper.json",
    );
  });
});
