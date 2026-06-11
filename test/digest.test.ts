import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  addBoundary,
  suggestBoundary,
} from "../src/core/boundaries.js";
import {
  addLore,
  reportConflict,
  suggestLore,
} from "../src/core/lore.js";
import { runMigrations } from "../src/db/migrations.js";
import {
  buildDigest,
  digestActionableCount,
  renderDigest,
} from "../src/cli/digest.js";

function newInMemoryDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("cli/digest", () => {
  let db: Database;
  beforeEach(() => {
    db = newInMemoryDb();
  });

  it("reports an empty, all-clear digest when nothing needs attention", () => {
    const d = buildDigest(db);
    expect(digestActionableCount(d)).toBe(0);
    expect(renderDigest(d)).toMatch(/nothing needs attention/i);
  });

  it("separates plain drafts from conflict counter-records", () => {
    const active = addLore(db, {
      title: "Use Argon2id",
      summary: "s",
      body: "b",
      source: "https://example.com/adr/1",
    });
    suggestLore(db, { title: "Plain suggestion", summary: "s", body: "b" });
    reportConflict(db, {
      existingId: active.id,
      observation: "Code uses scrypt as of abc123",
    });

    const d = buildDigest(db);
    expect(d.drafts.map((x) => x.title)).toContain("Plain suggestion");
    expect(d.drafts.every((x) => !x.conflictsWith?.length)).toBe(true);
    expect(d.conflicts).toHaveLength(1);
    expect(d.conflicts[0]!.conflictsWith).toContain(active.id);
  });

  it("surfaces stale active records (review date lapsed)", () => {
    addLore(db, {
      title: "Aging rule",
      summary: "s",
      body: "b",
      reviewAfter: "2000-01-01T00:00:00.000Z",
    });
    addLore(db, {
      title: "Fresh rule",
      summary: "s",
      body: "b",
      reviewAfter: "2999-01-01T00:00:00.000Z",
    });
    const d = buildDigest(db);
    expect(d.stale.map((s) => s.title)).toEqual(["Aging rule"]);
  });

  it("includes pending boundary drafts but not ratified edges", () => {
    addBoundary(db, { repo: "a", contract: "X", role: "provides" });
    suggestBoundary(db, { repo: "b", contract: "X", role: "consumes" });
    const d = buildDigest(db);
    expect(d.boundaryDrafts).toHaveLength(1);
    expect(d.boundaryDrafts[0]!.repo).toBe("b");
  });

  it("renders each populated section with its call-to-action", () => {
    suggestLore(db, { title: "A draft", summary: "s", body: "b" });
    addLore(db, {
      title: "Stale one",
      summary: "s",
      body: "b",
      reviewAfter: "2000-01-01T00:00:00.000Z",
    });
    const out = renderDigest(buildDigest(db));
    expect(out).toMatch(/Pending drafts/);
    expect(out).toMatch(/loreguard review/);
    expect(out).toMatch(/Stale active records/);
    expect(out).toMatch(/loreguard verify/);
  });
});
