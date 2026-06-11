import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { addBoundary, suggestBoundary } from "../src/core/boundaries.js";
import {
  buildRepoGraph,
  downstreamRepos,
  upstreamRepos,
} from "../src/core/graph.js";
import { runMigrations } from "../src/db/migrations.js";

function newDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

/**
 * A small realistic topology:
 *   orders-svc    provides order-submitted
 *   reporting-svc consumes order-submitted, provides daily-rollup
 *   finance-svc   consumes daily-rollup
 *   billing-svc   consumes order-submitted
 * So: finance → reporting → orders, and billing → orders.
 */
function seedTopology(db: Database): void {
  addBoundary(db, { repo: "orders-svc", contract: "order-submitted", role: "provides" });
  addBoundary(db, { repo: "reporting-svc", contract: "order-submitted", role: "consumes" });
  addBoundary(db, { repo: "reporting-svc", contract: "daily-rollup", role: "provides" });
  addBoundary(db, { repo: "finance-svc", contract: "daily-rollup", role: "consumes" });
  addBoundary(db, { repo: "billing-svc", contract: "order-submitted", role: "consumes" });
}

describe("core/graph", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
  });

  it("buildRepoGraph derives consumer→provider edges with attributed contracts", () => {
    seedTopology(db);
    const g = buildRepoGraph(db);
    expect(g.repos).toEqual([
      "billing-svc",
      "finance-svc",
      "orders-svc",
      "reporting-svc",
    ]);
    const find = (from: string, to: string) =>
      g.deps.find((d) => d.from === from && d.to === to);
    expect(find("reporting-svc", "orders-svc")?.contracts).toEqual(["order-submitted"]);
    expect(find("billing-svc", "orders-svc")?.contracts).toEqual(["order-submitted"]);
    expect(find("finance-svc", "reporting-svc")?.contracts).toEqual(["daily-rollup"]);
    // orders-svc depends on nothing.
    expect(g.deps.some((d) => d.from === "orders-svc")).toBe(false);
  });

  it("downstreamRepos finds the multi-hop blast radius with shortest paths", () => {
    seedTopology(db);
    const down = downstreamRepos(db, "orders-svc");
    const byRepo = new Map(down.map((d) => [d.repo, d]));
    // Direct consumers of what orders-svc provides:
    expect(byRepo.get("reporting-svc")?.hops).toBe(1);
    expect(byRepo.get("billing-svc")?.hops).toBe(1);
    // finance-svc is reached transitively via reporting-svc:
    expect(byRepo.get("finance-svc")?.hops).toBe(2);
    expect(byRepo.get("finance-svc")?.path).toEqual([
      "orders-svc",
      "reporting-svc",
      "finance-svc",
    ]);
  });

  it("upstreamRepos walks the other direction", () => {
    seedTopology(db);
    const up = upstreamRepos(db, "finance-svc");
    const byRepo = new Map(up.map((u) => [u.repo, u]));
    expect(byRepo.get("reporting-svc")?.hops).toBe(1);
    expect(byRepo.get("orders-svc")?.hops).toBe(2);
    // finance-svc is downstream of everything; nothing is downstream of it.
    expect(downstreamRepos(db, "finance-svc")).toEqual([]);
  });

  it("is cycle-safe (A↔B mutual dependency terminates)", () => {
    addBoundary(db, { repo: "a-svc", contract: "x", role: "provides" });
    addBoundary(db, { repo: "b-svc", contract: "x", role: "consumes" });
    addBoundary(db, { repo: "b-svc", contract: "y", role: "provides" });
    addBoundary(db, { repo: "a-svc", contract: "y", role: "consumes" });
    expect(downstreamRepos(db, "a-svc").map((d) => d.repo)).toEqual(["b-svc"]);
    expect(upstreamRepos(db, "a-svc").map((u) => u.repo)).toEqual(["b-svc"]);
  });

  it("excludes draft edges unless includeDrafts", () => {
    addBoundary(db, { repo: "orders-svc", contract: "z", role: "provides" });
    suggestBoundary(db, { repo: "guess-svc", contract: "z", role: "consumes" });
    expect(downstreamRepos(db, "orders-svc")).toEqual([]);
    expect(
      downstreamRepos(db, "orders-svc", { includeDrafts: true }).map((d) => d.repo),
    ).toEqual(["guess-svc"]);
  });
});
