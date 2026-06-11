/**
 * Boundary auto-discovery — best-effort static scan that PROPOSES edges.
 *
 * Hand-declaring every provides/consumes edge is the tax that keeps the
 * architecture map empty. This scans a repo's source for high-signal
 * contract patterns (HTTP routes, pub/sub topics, queue consumers) and turns
 * them into candidate edges.
 *
 * **It proposes, it does not decide.** Discovered edges are written as
 * DRAFTS (via `suggestBoundary`) and go through the same `boundary review`
 * gate as anything an agent suggests — never auto-activated. The CLI is
 * dry-run by default. This is deliberate: a mechanical scanner that silently
 * filled the map with guesses would reintroduce exactly the noise the
 * project removed when it dropped the old auto-ingest paths. Discovery does
 * the tedious grep; a human (or the onboard agent) still ratifies.
 *
 * Coverage is intentionally a curated, low-false-positive subset (JS/TS,
 * Python, Java/Kotlin, a few common libraries), not an exhaustive parser.
 * The honest framing is "a starter for review", and the rule list is easy
 * to extend.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

import type { BoundaryRole } from "../db/types.js";

/**
 * Heavy / generated directories the scan never descends into. Mirrors the
 * spirit of the sync-pull skip list but kept local so `core` doesn't depend
 * on `cli` (the layering only goes the other way).
 */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules", "dist", "build", "target", "vendor", ".next", ".cache",
  ".turbo", "out", ".pnpm-store", "coverage", "__pycache__",
]);

export type ContractKind = "endpoint" | "event" | "queue";

export interface RawSignal {
  readonly role: BoundaryRole;
  readonly kind: ContractKind;
  /** Contract string as detected (un-normalised). */
  readonly contract: string;
  /** 1-based line number within the scanned text. */
  readonly line: number;
}

interface Rule {
  readonly role: BoundaryRole;
  readonly kind: ContractKind;
  readonly re: RegExp;
  /** Build the contract string from the regex match groups. */
  readonly build: (m: RegExpMatchArray) => string | null;
}

const RULES: ReadonlyArray<Rule> = [
  // ── HTTP routes (this repo PROVIDES the endpoint) ──────────────────
  // Express / Fastify / Koa-router / FastAPI: app.get("/x"), router.post(`/y`)
  {
    role: "provides",
    kind: "endpoint",
    re: /\b(?:app|router|fastify|server|api|route|bp|blueprint)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
    build: (m) => `${m[1]!.toUpperCase()} ${m[2]!}`,
  },
  // Decorator routes: NestJS @Get("/x"), and Spring @GetMapping("/x")
  {
    role: "provides",
    kind: "endpoint",
    re: /@(Get|Post|Put|Patch|Delete)(?:Mapping)?\s*\(\s*(?:value\s*=\s*)?['"]([^'"]*)['"]/g,
    build: (m) => `${m[1]!.toUpperCase()} ${m[2]! || "/"}`,
  },
  // Flask / Blueprint: @app.route("/x", methods=["POST"])
  {
    role: "provides",
    kind: "endpoint",
    re: /@(?:app|bp|blueprint|router)\.route\s*\(\s*['"]([^'"]+)['"]/g,
    build: (m) => m[1]!,
  },
  // ── Pub/sub events ─────────────────────────────────────────────────
  // .publish("topic") — Redis, Kafka wrappers, generic buses (this repo PROVIDES)
  {
    role: "provides",
    kind: "event",
    re: /\.publish\s*\(\s*['"`]([^'"`]+)['"`]/g,
    build: (m) => m[1]!,
  },
  // Kafka producer: .send({ topic: "order-submitted", ... }) (PROVIDES)
  {
    role: "provides",
    kind: "event",
    re: /\.send\s*\(\s*\{[^}]*\btopic\s*:\s*['"]([^'"]+)['"]/g,
    build: (m) => m[1]!,
  },
  // .subscribe("topic") — note: RxJS subscribe takes a function, not a
  // string, so requiring a quoted first arg excludes it (CONSUMES).
  {
    role: "consumes",
    kind: "event",
    re: /\.subscribe\s*\(\s*['"`]([^'"`]+)['"`]/g,
    build: (m) => m[1]!,
  },
  // Spring @KafkaListener(topics = "order-submitted") (CONSUMES)
  {
    role: "consumes",
    kind: "event",
    re: /@KafkaListener\s*\([^)]*topics?\s*=\s*\{?\s*['"]([^'"]+)['"]/g,
    build: (m) => m[1]!,
  },
  // ── Queues ─────────────────────────────────────────────────────────
  // amqplib / generic: channel.consume("queue-name") (CONSUMES)
  {
    role: "consumes",
    kind: "queue",
    re: /\.consume\s*\(\s*['"`]([^'"`]+)['"`]/g,
    build: (m) => m[1]!,
  },
];

/**
 * Scan a single file's text for contract signals. Pure and line-aware so it
 * can be unit-tested without touching the filesystem. Runs every rule over
 * the whole text (rules are global-flagged) and resolves line numbers from
 * match offsets.
 */
export function scanText(text: string): RawSignal[] {
  // Precompute line-start offsets for O(log n) line lookup.
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const out: RawSignal[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      const contract = rule.build(m);
      if (!contract || !contract.trim()) continue;
      out.push({
        role: rule.role,
        kind: rule.kind,
        contract: contract.trim(),
        line: lineAt(m.index),
      });
    }
  }
  return out;
}

export interface DiscoveredEdge {
  readonly role: BoundaryRole;
  readonly kind: ContractKind;
  /** Contract as detected (the dedupe key normalises separately). */
  readonly contract: string;
  /** How many times the signal was seen across the repo. */
  readonly occurrences: number;
  /** Up to a few `relativePath:line` evidence locations. */
  readonly evidence: string[];
}

const SCAN_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx",
  ".py", ".java", ".kt", ".kts", ".go", ".rb", ".cs", ".php", ".scala", ".rs",
]);

/** Files larger than this are skipped (likely generated / bundled). */
const MAX_FILE_BYTES = 1_000_000;
const MAX_EVIDENCE = 3;

/**
 * Walk a directory tree, scan eligible source files, and aggregate the raw
 * signals into deduped candidate edges. Dedupe key is
 * `role + normalised-ish contract + kind` (case-insensitive, trimmed) so the
 * same endpoint seen in three files becomes one edge with occurrences=3.
 * Skips the same heavy directories `sync pull` skips, plus dotfiles dirs.
 */
export function discoverEdges(rootDir: string): DiscoveredEdge[] {
  const agg = new Map<
    string,
    {
      role: BoundaryRole;
      kind: ContractKind;
      contract: string;
      occurrences: number;
      evidence: string[];
    }
  >();

  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".")) continue; // .git, .loreguard, etc.
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SCAN_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      let text: string;
      try {
        if (statSync(full).size > MAX_FILE_BYTES) continue;
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const rel = relative(rootDir, full) || entry.name;
      for (const sig of scanText(text)) {
        const key = `${sig.role}\x00${sig.kind}\x00${sig.contract.toLowerCase()}`;
        let e = agg.get(key);
        if (!e) {
          e = {
            role: sig.role,
            kind: sig.kind,
            contract: sig.contract,
            occurrences: 0,
            evidence: [],
          };
          agg.set(key, e);
        }
        e.occurrences++;
        if (e.evidence.length < MAX_EVIDENCE) {
          e.evidence.push(`${rel}:${sig.line}`);
        }
      }
    }
  };
  walk(rootDir);

  return Array.from(agg.values()).sort(
    (a, b) =>
      a.role.localeCompare(b.role) ||
      a.kind.localeCompare(b.kind) ||
      a.contract.localeCompare(b.contract),
  );
}
