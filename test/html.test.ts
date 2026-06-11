import { describe, expect, it } from "vitest";

import { renderHtml } from "../src/cli/html.js";
import type { RepoGraph } from "../src/core/graph.js";
import type { Lore } from "../src/db/types.js";

function lore(partial: Partial<Lore>): Lore {
  return {
    id: "abcd1234",
    title: "T",
    summary: "S",
    body: "B",
    status: "active",
    confidence: "medium",
    restricted: false,
    repos: [],
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

const emptyGraph: RepoGraph = { repos: [], deps: [] };

describe("cli/html — renderHtml", () => {
  it("produces a self-contained page: no external scripts, styles, or fonts", () => {
    const html = renderHtml({
      lore: [lore({ title: "Argon2id default" })],
      graph: emptyGraph,
      generatedAt: "2026-06-11T00:00:00.000Z",
    });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    // No external resource loads of any kind.
    expect(/<script[^>]*\ssrc=/.test(html)).toBe(false);
    expect(/<link[^>]*href=/.test(html)).toBe(false);
    expect(/@import|url\(http/.test(html)).toBe(false);
    // Styles + behaviour are inlined.
    expect(html).toContain("<style>");
    expect(html).toContain("<script>");
  });

  it("escapes user content to prevent breaking out of the markup", () => {
    const html = renderHtml({
      lore: [lore({ title: "<script>alert(1)</script>", summary: "a & b \"c\"" })],
      graph: emptyGraph,
      generatedAt: "2026-06-11T00:00:00.000Z",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("a &amp; b");
  });

  it("renders an SVG graph with a node per repo and a path per edge", () => {
    const graph: RepoGraph = {
      repos: ["finance-svc", "orders-svc", "reporting-svc"],
      deps: [
        { from: "reporting-svc", to: "orders-svc", contracts: ["order-submitted"] },
        { from: "finance-svc", to: "reporting-svc", contracts: ["daily-rollup"] },
      ],
    };
    const html = renderHtml({ lore: [], graph, generatedAt: "x" });
    expect(html).toContain("<svg");
    expect((html.match(/class="node"/g) ?? []).length).toBe(3);
    expect((html.match(/class="edge"/g) ?? []).length).toBe(2);
    // Edge tooltip names the contract that creates the dependency.
    expect(html).toContain("depends on orders-svc via order-submitted");
  });

  it("shows the empty-graph guidance when there are no edges", () => {
    const html = renderHtml({ lore: [], graph: emptyGraph, generatedAt: "x" });
    expect(html).toMatch(/No architecture edges yet/);
  });

  it("flags dangling consumers in a warning panel when given them", () => {
    const html = renderHtml({
      lore: [],
      graph: emptyGraph,
      danglingConsumers: [
        { contract: "third-party-api", providers: [], consumers: ["app-svc"] },
      ],
      generatedAt: "x",
    });
    expect(html).toMatch(/dangling consumer/i);
    expect(html).toContain("third-party-api");
    expect(html).toContain("app-svc");
  });

  it("omits the dangling panel when there are none", () => {
    const html = renderHtml({ lore: [], graph: emptyGraph, generatedAt: "x" });
    expect(html).not.toMatch(/dangling consumer/i);
  });

  it("marks a draft and a stale record with badges and a draft toggle", () => {
    const html = renderHtml({
      lore: [
        lore({ status: "draft", title: "Pending" }),
        lore({ id: "stale0001", title: "Old", reviewAfter: "2000-01-01T00:00:00.000Z" }),
      ],
      graph: emptyGraph,
      generatedAt: "x",
    });
    expect(html).toContain('data-status="draft"');
    expect(html).toContain("badge stale");
    expect(html).toMatch(/show 1 draft/);
  });
});
