import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverEdges, scanText } from "../src/core/discover.js";

describe("core/discover — scanText (pure)", () => {
  it("detects HTTP routes as provides/endpoint with method + path", () => {
    const sigs = scanText('app.get("/orders/:id", h);\nrouter.post(`/orders`, c);');
    const provides = sigs.filter((s) => s.role === "provides" && s.kind === "endpoint");
    expect(provides.map((s) => s.contract)).toContain("GET /orders/:id");
    expect(provides.map((s) => s.contract)).toContain("POST /orders");
  });

  it("detects decorator and Spring-mapping routes", () => {
    expect(
      scanText('@Get("/health")').map((s) => s.contract),
    ).toContain("GET /health");
    expect(
      scanText('@PostMapping("/v1/pay")').map((s) => s.contract),
    ).toContain("POST /v1/pay");
  });

  it("detects publish as provides and subscribe/consume as consumes", () => {
    const pub = scanText('bus.publish("order-submitted", x)');
    expect(pub[0]).toMatchObject({ role: "provides", kind: "event", contract: "order-submitted" });
    const sub = scanText('client.subscribe("daily-rollup")');
    expect(sub[0]).toMatchObject({ role: "consumes", kind: "event", contract: "daily-rollup" });
    const q = scanText('channel.consume("email-jobs")');
    expect(q[0]).toMatchObject({ role: "consumes", kind: "queue", contract: "email-jobs" });
  });

  it("detects a Kafka producer topic in .send({ topic })", () => {
    const sigs = scanText('producer.send({ topic: "payments-completed", messages: m })');
    expect(sigs[0]).toMatchObject({ role: "provides", contract: "payments-completed" });
  });

  it("does NOT match RxJS-style subscribe (function arg, no string)", () => {
    expect(scanText("obs$.subscribe(x => console.log(x))")).toEqual([]);
  });

  it("reports accurate line numbers", () => {
    const sigs = scanText('// header\n\napp.get("/x", h)');
    expect(sigs[0]!.line).toBe(3);
  });

  it("tags route defs / @KafkaListener as high-signal, generic pub/sub as medium", () => {
    expect(scanText('app.get("/x", h)')[0]!.confidence).toBe("high");
    expect(scanText('@KafkaListener(topics = "t")')[0]!.confidence).toBe("high");
    expect(scanText('bus.publish("e", x)')[0]!.confidence).toBe("medium");
    expect(scanText('c.subscribe("e")')[0]!.confidence).toBe("medium");
  });
});

describe("core/discover — discoverEdges (filesystem)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loreguard-disco-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("aggregates across files, dedupes, counts occurrences, and keeps evidence", () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), 'app.get("/orders", h)');
    writeFileSync(join(dir, "src", "b.ts"), 'router.get("/orders", h2)'); // same contract
    writeFileSync(join(dir, "src", "c.py"), 'q.subscribe("rollup")');
    const edges = discoverEdges(dir);
    const orders = edges.find((e) => e.contract === "GET /orders");
    expect(orders?.occurrences).toBe(2);
    expect(orders?.evidence.length).toBe(2);
    expect(edges.some((e) => e.role === "consumes" && e.contract === "rollup")).toBe(true);
  });

  it("ranks high-confidence edges first and carries the confidence through", () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), 'bus.publish("evt", x)\napp.get("/x", h)');
    const edges = discoverEdges(dir);
    expect(edges[0]!.confidence).toBe("high"); // the route sorts first
    expect(edges.find((e) => e.contract === "evt")?.confidence).toBe("medium");
  });

  it("skips node_modules and non-source files", () => {
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), 'app.get("/leak", h)');
    writeFileSync(join(dir, "README.md"), 'app.get("/doc", h)'); // .md not scanned
    expect(discoverEdges(dir)).toEqual([]);
  });
});
