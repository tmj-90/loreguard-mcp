import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Database } from "better-sqlite3";
import { z } from "zod";

import { audit } from "../core/audit.js";
import { findActiveAbsence, recordAbsence } from "../core/absence.js";
import { findDependents, suggestBoundary } from "../core/boundaries.js";
import {
  findPossibleDuplicates,
  getLore,
  reportConflict,
  ReportConflictError,
  searchLore,
  searchLoreCount,
  suggestLore,
} from "../core/lore.js";
import { defaultDbPath, openDb } from "../db/index.js";
import { DatabaseTooNewError } from "../db/migrations.js";
import {
  ABSENCE_DISABLED_REFUSAL,
  buildSearchResponseBody,
  CONFLICT_AGAINST_RESTRICTED_REFUSAL,
  redactRestricted,
  shouldGateAbsenceWrite,
  shouldGateRestrictedGet,
  shouldRefuseConflictAgainstRestricted,
  stripPossibleConflicts,
} from "./redact.js";
import {
  auditMessageForFieldError,
  checkLength,
  checkOptionalEnum,
  checkOptionalHttpUrl,
  type FieldError,
  LENGTH_CAPS,
  requireNonEmptyString,
  tooLongToFieldError,
} from "./validation.js";
import type { Boundary } from "../db/types.js";
import { VERSION } from "../version.js";

/**
 * Compact boundary projection for MCP responses — repo / role / contract
 * plus the optional classifier, detail, and source. Omits internal
 * timestamps and status (the map is active-only over MCP) to keep the
 * agent's context lean.
 */
function boundaryForMcp(b: Boundary): Record<string, unknown> {
  return {
    repo: b.repo,
    role: b.role,
    contract: b.contract,
    ...(b.kind ? { kind: b.kind } : {}),
    ...(b.detail ? { detail: b.detail } : {}),
    ...(b.source ? { source: b.source } : {}),
  };
}

/**
 * R1 — MCP server. Stdio transport only (no network listener). Three
 * tools exposed to the client:
 *
 *   - search_lore  — brief-by-default; default-filtered to active records,
 *                    excludes drafts/deprecated/superseded/restricted unless
 *                    explicitly opted in via flags. The token-saving entry.
 *   - get_lore     — full body of one record by id. Use this AFTER a
 *                    search hit to spend tokens on detail only when needed.
 *   - suggest_lore — agent-authored knowledge lands as a DRAFT
 *                    (status='draft'). Hidden from default search until
 *                    a human runs `loreguard approve <id>`. Agents cannot
 *                    promote their own records.
 *
 * Every tool call is recorded to `~/.loreguard/audit.jsonl` with the request
 * args, result count, and result ids — never the full result bodies.
 */
export async function runMcpServer(): Promise<void> {
  // Open the DB before wiring tools. If it fails (locked by another process,
  // corrupt file, unwritable dir) the agent's client would otherwise see a
  // raw SqliteError stack and a bare "server failed to start". Emit an
  // actionable diagnostic to stderr — which MCP clients surface on launch
  // failure — and exit cleanly instead.
  let db: Database;
  try {
    db = openDb();
  } catch (err) {
    if (err instanceof DatabaseTooNewError) {
      process.stderr.write(`loreguard-mcp: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    const dbPath = defaultDbPath();
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `loreguard-mcp: could not open the lore database at ${dbPath}\n` +
        `  reason: ${reason}\n` +
        `  • If another process holds a write lock, close it and relaunch.\n` +
        `  • If the file is corrupt, restore a backup or re-run \`loreguard init\`.\n` +
        `  • Check the directory is writable and you have free disk space.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const server = buildMcpServer(db);

  // Connect on stdio. The MCP client (Claude Code, Cursor, etc.) is the
  // parent process; we read JSON-RPC framed messages on stdin, reply on
  // stdout. Logs go to stderr.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Block forever — connect() returns once the transport is bound; the
  // server runs as long as stdin stays open. Closing stdin (client
  // disconnect) exits the process.
}

/**
 * Wire all loreguard MCP tools onto a fresh `McpServer` backed by the
 * given database. Split out of `runMcpServer` so tests can drive the
 * real server (and its real handlers, redaction gates, and audit calls)
 * over an in-memory transport against a temp DB — no stdio subprocess,
 * no production `~/.loreguard` paths. `runMcpServer` is the thin shell:
 * open the default DB, build, connect stdio.
 */
export function buildMcpServer(db: Database): McpServer {
  const server = new McpServer({
    name: "loreguard",
    version: VERSION,
  });

  // ---- search_lore -----------------------------------------------------
  server.registerTool(
    "search_lore",
    {
      title: "Search team lore",
      description:
        "**Call this BEFORE any non-trivial change.** Loreguard is the " +
        "team's memory of conventions, decisions, gotchas, deprecated " +
        "patterns, and incident lessons. If there's any chance the team " +
        "has an opinion on what you're about to do, search first. The " +
        "only changes that don't warrant a search are pure typos / " +
        "formatting / mechanical renames where the team can't have an " +
        "opinion. Cost asymmetry favours over-calling: an empty search " +
        "costs one cheap query; a skipped search lets you repeat a " +
        "mistake the team already learned from.\n\n" +
        "**Search broadly, not just by current repo.** If your task " +
        "touches code that interacts with another service / repo — shared " +
        "infra, cross-repo APIs, common conventions — search WITHOUT a " +
        "`repo` filter at least once. Lore records can be tagged for " +
        "multiple repos (e.g. an org-wide rule), and a too-narrow filter " +
        "will hide them. If a repo-scoped query returns zero hits, " +
        "consider retrying without the filter before concluding the team " +
        "has no position.\n\n" +
        "Returns BRIEF summaries (no body). Call get_lore({ id }) only " +
        "when a summary mentions a specific number / threshold / " +
        "exception you can't act on without the detail. Default: returns " +
        "only 'active' records; excludes drafts and deprecated/superseded. " +
        "Results include `stale: true` when the record's review date has " +
        "passed; treat stale hits as starting points, not authority.\n\n" +
        "Phrase queries as 'topic + scope' — e.g. \"password hashing\", " +
        "\"date timezone payments-svc\", \"webhook retry policy\", " +
        "\"migration style guide\". On a zero-hit response, the server " +
        "may include an `absence_marker` (an acknowledged team-known gap) " +
        "or a `next` field coaching your next move. When more matches " +
        "exist than were returned, a `truncated: { shown, total, hint }` " +
        "block tells you the set is partial — narrow or raise `limit` " +
        "before treating the shown hits as the team's complete position. " +
        "Results are ordered by relevance ADJUSTED for trust (active, " +
        "sourced, higher-confidence, non-stale records rank higher), so " +
        "the top hits are the ones most worth acting on.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Free-text query (matches title, summary, and body via FTS5). " +
              "Omit to list recent active records.",
          ),
        repo: z
          .string()
          .optional()
          .describe(
            "Narrow to records tagged for this repo (use the repo's name as " +
              "you'd write it in a Git URL, e.g. 'payments-svc').",
          ),
        tag: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(
            "Narrow to records carrying this tag, or any of these tags " +
              "if a list is given (ANY-of). Tags are lowercased / hyphenated " +
              "automatically — pass them however you like.",
          ),
        prefix: z
          .boolean()
          .optional()
          .describe(
            "If true, query tokens of 3+ chars match as PREFIXES " +
              "('timez' → 'timezone'). Off by default; turn on when you're " +
              "guessing at a term or want broader recall.",
          ),
        updatedAfter: z
          .string()
          .optional()
          .describe(
            "ISO timestamp. Returns only records whose `updated_at` is " +
              "on/after this. Use sparingly — most useful queries don't " +
              "filter by time. Format: '2026-01-15' or full ISO datetime.",
          ),
        includeDrafts: z
          .boolean()
          .optional()
          .describe(
            "If true, also return agent-suggested drafts awaiting human approval. " +
              "Default false — drafts haven't been reviewed and may be wrong.",
          ),
        includeDeprecated: z
          .boolean()
          .optional()
          .describe("If true, also return records the team has marked deprecated."),
        includeSuperseded: z
          .boolean()
          .optional()
          .describe(
            "If true, also return records that have been superseded by a " +
              "newer record. Default false — the superseding record is " +
              "usually what you want.",
          ),
        includeRestricted: z
          .boolean()
          .optional()
          .describe(
            "If true, also return records the team has marked restricted. " +
              "Default false — most agent tasks should leave this off.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results. Default 10, hard cap 50."),
      },
    },
    async (args) => {
      try {
        const searchOpts = {
          query: args.query,
          repo: args.repo,
          tag: args.tag,
          prefix: args.prefix,
          updatedAfter: args.updatedAfter,
          includeDrafts: args.includeDrafts,
          includeDeprecated: args.includeDeprecated,
          includeSuperseded: args.includeSuperseded,
          // R4 — env-gated. The agent can ASK for restricted records, but
          // the server ignores the flag unless LOREGUARD_ALLOW_RESTRICTED_MCP=1
          // is set at startup. Belt-and-braces beyond the schema default.
          includeRestricted:
            process.env["LOREGUARD_ALLOW_RESTRICTED_MCP"] === "1"
              ? args.includeRestricted
              : false,
          limit: args.limit,
        };
        const hits = searchLore(db, searchOpts);
        // Unlimited count under the SAME filters, so the response can tell
        // the agent when results were capped ("showing 10 of 23") and it
        // narrows rather than concluding the team has nothing more. Only
        // worth the extra query when we actually hit the cap.
        const totalMatches =
          hits.length >= (args.limit ?? 10)
            ? searchLoreCount(db, searchOpts)
            : hits.length;
        audit({
          tool: "search_lore",
          request: args as Record<string, unknown>,
          resultCount: hits.length,
          resultIds: hits.map((h) => h.id),
        });
        // possibleConflicts is a CLI-only heuristic for human triage —
        // see stripPossibleConflicts for the rationale.
        const mcpHits = stripPossibleConflicts(hits);
        // Verified-absence: when there are no hits AND the agent
        // explicitly searched (not a blank "list recent" call), surface
        // any active marker so the next agent knows "we checked, known
        // gap" rather than re-discovering the same nothing. Absent the
        // query we have nothing to match a marker against.
        let absenceMarker: ReturnType<typeof findActiveAbsence> = null;
        if (mcpHits.length === 0 && args.query) {
          absenceMarker = findActiveAbsence(db, {
            query: args.query,
            repo: args.repo,
          });
        }
        // Response shape is built by a pure helper so the three
        // branches (hits / empty+marker / empty+no-marker+coach) can
        // be unit-tested without spinning up stdio. See redact.ts for
        // the contract.
        const responseBody = buildSearchResponseBody({
          hits: mcpHits,
          query: args.query,
          absenceMarker,
          totalMatches,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(responseBody, null, 2),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "search_lore",
          request: args as Record<string, unknown>,
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `search_lore failed: ${msg}` }],
        };
      }
    },
  );

  // ---- get_lore --------------------------------------------------------
  server.registerTool(
    "get_lore",
    {
      title: "Fetch one lore record (full body)",
      description:
        "**Call this when a search_lore summary isn't enough to act on** — " +
        "typically when the summary references a specific value / threshold " +
        "/ exception, says 'see body for...', or you need the rationale " +
        "behind the rule to apply it correctly. Don't call get_lore on " +
        "every search hit; the summary is designed to stand alone for the " +
        "common case. Pulling the full body for an obvious rule wastes " +
        "tokens.\n\n" +
        "Returns null when no record matches the id.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe(
            "The 8-char lore id, e.g. '7vk3qm9b'. Get this from search_lore.",
          ),
      },
    },
    async (args) => {
      try {
        const lore = getLore(db, args.id);
        // R4 — restricted gate. `search_lore` already env-gates restricted
        // retrieval; without a matching gate here, an agent with an id from
        // a stale audit / CLI output / prior context can bypass the search
        // filter and fetch the body. Same env knob as search, minimal
        // refusal shape (no title) so the response itself can't leak.
        if (shouldGateRestrictedGet(lore, process.env)) {
          audit({
            tool: "get_lore",
            request: args as Record<string, unknown>,
            resultCount: 1,
            resultIds: [lore!.id],
            blocked: "restricted",
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(redactRestricted(lore!.id), null, 2),
              },
            ],
          };
        }
        audit({
          tool: "get_lore",
          request: args as Record<string, unknown>,
          resultCount: lore ? 1 : 0,
          resultIds: lore ? [lore.id] : [],
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(lore, null, 2),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "get_lore",
          request: args as Record<string, unknown>,
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `get_lore failed: ${msg}` }],
        };
      }
    },
  );

  // ---- suggest_lore ----------------------------------------------------
  server.registerTool(
    "suggest_lore",
    {
      title: "Suggest a new lore record (draft)",
      description:
        "**Call this at the END of a task IF you discovered a durable, " +
        "project-specific finding that future agents would have benefited " +
        "from knowing at the start.** Concrete triggers: (1) a convention " +
        "that isn't obvious from code (naming, timezone handling, auth, " +
        "permissions, data modelling); (2) a gotcha that wasted time in " +
        "this session and is likely to bite again; (3) a deprecated " +
        "pattern you spotted and steered away from; (4) a migration " +
        "constraint or in-flight transition; (5) an incident lesson; " +
        "(6) a cross-repo rule you inferred from multiple touch points.\n\n" +
        "Do NOT call for: TypeScript/language syntax, generic programming " +
        "advice, transient task state, file paths you happened to read, " +
        "or anything you're not at least 80% confident the next agent " +
        "should know. Rough rule: would a future teammate, six months " +
        "from now, thank you for capturing this? If unsure, skip — the " +
        "cost of a missing record is one re-search; the cost of a noisy " +
        "record is reviewer fatigue.\n\n" +
        "Lands as a DRAFT (invisible to default search until a human " +
        "approves via `loreguard review`). The response includes any " +
        "near-duplicate records you should be aware of in `possibleDuplicates` " +
        "— if a hit looks like the same rule, your suggestion is probably " +
        "redundant; consider not calling at all, or call with a sharper " +
        "title that complements rather than duplicates.\n\n" +
        "Required: `title` (≤ " +
        LENGTH_CAPS.title +
        " chars), `summary` (≤ " +
        LENGTH_CAPS.summary +
        " chars), `body` (no length limit). `source` must be an http(s) " +
        "URL if given. On any bad input you get a structured " +
        "`{ error, field, hint }` naming exactly what to fix — fix that " +
        "field and resend; don't guess.",
      inputSchema: {
        // ALL fields are intentionally lenient (optional, no .min/.max/.url/
        // .enum). The MCP SDK validates this schema BEFORE our handler runs
        // and, on any failure, returns an opaque `-32602` with a raw zod
        // dump (e.g. `path:["body"], received: undefined`) — which sent
        // agents on long, wrong retry loops "fixing the body" when the real
        // problem was a missing field or a bad URL elsewhere. By accepting
        // anything here and validating in the handler, EVERY bad input
        // becomes a structured `{error, field, hint, ...}` the agent can
        // self-correct against. The caps are still named in the
        // descriptions so well-behaved agents get them right upfront.
        title: z
          .string()
          .optional()
          .describe(
            `Short title — what is the rule / fact? REQUIRED. Hard cap ${LENGTH_CAPS.title} chars.`,
          ),
        summary: z
          .string()
          .optional()
          .describe(
            `One-paragraph summary (REQUIRED; ≤ ${LENGTH_CAPS.summary} chars). This is what most ` +
              "search results show — should stand alone without the body; " +
              "assume readers won't drill in. Aim for the *why* and the " +
              "*what*, not just the *what*; a longer cap exists so search " +
              "hits can be self-contained without a follow-up get_lore call.",
          ),
        body: z
          .string()
          .optional()
          .describe(
            "Full detail / reasoning / evidence (REQUIRED). Markdown is " +
              "fine. No length limit (body is fetched on demand via " +
              "get_lore, not returned in search hits). Include enough " +
              "context to verify the claim.",
          ),
        repos: z
          .array(z.string())
          .optional()
          .describe(
            "Repos this rule applies to. Helps future agents narrow searches.",
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            "Lowercase tags. Common tags include: security, dates, db, auth, " +
              "deploy, conventions, gotchas, incident-lessons.",
          ),
        source: z
          .string()
          .optional()
          .describe(
            "URL: PR / ADR / incident / Slack permalink that justifies this " +
              "record (must be http(s) if provided). Records WITHOUT a " +
              "source are treated as lower-trust.",
          ),
        confidence: z
          .string()
          .optional()
          .describe(
            "How sure are you? One of low | medium | high. Default 'medium'. " +
              "Use 'low' for inferred conventions; 'high' only with a source link.",
          ),
        team: z.string().optional().describe("Owning team, if known."),
      },
    },
    async (args) => {
      // All validation happens HERE, not in the schema (see inputSchema
      // comment). Every failure returns a structured `{error, field, hint}`
      // the agent can self-correct against — never a raw SDK -32602 dump.
      //
      // Sanitised audit shape DELIBERATELY omits the body (trust-model
      // boundary from SECURITY.md — the audit records that a suggestion
      // happened, not its contents). Lengths are computed defensively
      // since the fields are now optional at the schema layer.
      const sanitised: Record<string, unknown> = {
        title: args.title,
        summaryChars: typeof args.summary === "string" ? args.summary.length : 0,
        bodyChars: typeof args.body === "string" ? args.body.length : 0,
        repos: args.repos,
        tags: args.tags,
        source: args.source,
        confidence: args.confidence,
        team: args.team,
      };
      // Helper: log + return a structured field error (NOT isError — the
      // response is well-formed; the agent just retries with a fix).
      const fieldErrorResponse = (err: FieldError) => {
        audit({
          tool: "suggest_lore",
          request: sanitised,
          error: auditMessageForFieldError(err),
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(err, null, 2) }],
        };
      };
      // 1. Required non-empty fields, in field order so the agent fixes
      //    the first problem and re-sends.
      const requiredErr =
        requireNonEmptyString("title", args.title) ??
        requireNonEmptyString("summary", args.summary) ??
        requireNonEmptyString("body", args.body);
      if (requiredErr) return fieldErrorResponse(requiredErr);
      // 2. Optional-field shape: source must be http(s); confidence enum.
      const optionalErr =
        checkOptionalHttpUrl("source", args.source) ??
        checkOptionalEnum("confidence", args.confidence, ["low", "medium", "high"]);
      if (optionalErr) return fieldErrorResponse(optionalErr);
      // 3. Length caps (title, then summary). Past the required-check,
      //    these are definitely strings.
      const title = args.title as string;
      const summary = args.summary as string;
      const body = args.body as string;
      const titleLen = checkLength("title", title);
      if (titleLen) return fieldErrorResponse(tooLongToFieldError("title", titleLen));
      const summaryLen = checkLength("summary", summary);
      if (summaryLen) {
        return fieldErrorResponse(tooLongToFieldError("summary", summaryLen));
      }
      try {
        const lore = suggestLore(db, {
          title,
          summary,
          body,
          repos: args.repos,
          tags: args.tags,
          source: args.source,
          confidence: args.confidence as "low" | "medium" | "high" | undefined,
          team: args.team,
          author: "agent",
        });
        // Hint-only duplicate check. Never blocks — the human reviewer
        // decides. Surfaced in the response so the calling agent can warn
        // the user inline ("I drafted this but here are 2 similar
        // existing records"), and counted in the audit so a human reading
        // ~/.loreguard/audit.jsonl can see how often agents suggest near-dupes.
        //
        // Restricted handling: titles of restricted records are not
        // surfaced unless LOREGUARD_ALLOW_RESTRICTED_MCP=1 (same env knob that
        // governs search and get). Restricted matches are still counted
        // so the response can say "and N more we're not showing you".
        const allowRestricted =
          process.env["LOREGUARD_ALLOW_RESTRICTED_MCP"] === "1";
        const { duplicates: possibleDuplicates, restrictedDuplicateCount } =
          findPossibleDuplicates(
            db,
            {
              id: lore.id,
              title,
              repos: args.repos,
              tags: args.tags,
            },
            { allowRestricted },
          );
        sanitised["possibleDuplicateCount"] = possibleDuplicates.length;
        sanitised["restrictedDuplicateCount"] = restrictedDuplicateCount;
        audit({
          tool: "suggest_lore",
          request: sanitised,
          resultCount: 1,
          resultIds: [lore.id],
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: lore.id,
                  status: lore.status,
                  message:
                    "Draft created. A human will review with `loreguard review` and " +
                    "promote with `loreguard approve " + lore.id + "`.",
                  possibleDuplicates,
                  restrictedDuplicateCount,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "suggest_lore",
          request: sanitised,
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `suggest_lore failed: ${msg}` }],
        };
      }
    },
  );

  // ---- report_conflict -------------------------------------------------
  server.registerTool(
    "report_conflict",
    {
      title: "Report a conflict against a canonical lore record",
      description:
        "**Call this when a search_lore hit contradicts what the code (or " +
        "another authoritative source) actually does right now.** Concrete " +
        "triggers: lore says 'use requireSession()' but the codebase only " +
        "uses the legacy middleware; lore says 'all timestamps UTC' but you " +
        "found a callsite storing local time; lore says 'feature flags " +
        "preferred' but you found long-lived feature branches being merged. " +
        "If you spot this and stay silent, the lore stays wrong and the " +
        "next agent inherits it.\n\n" +
        "Creates a DRAFT counter-record linked back to the original via " +
        "`conflictsWith` — it lands in `loreguard review` for the human " +
        "to triage. The original record is NEVER mutated; the link is " +
        "one-way. Resolution is the reviewer's call (approve the counter-" +
        "claim → `loreguard supersede` or `loreguard update` to fix the " +
        "original; reject → the original stands).\n\n" +
        "Distinct from the runtime `possibleConflicts` heuristic on search " +
        "results — that's shared-scope overlap detection. This is explicit, " +
        "persisted, evidence-backed disagreement.",
      inputSchema: {
        // Lenient schema; validated in the handler so failures return a
        // structured {error, field, hint} instead of a raw SDK -32602.
        existingId: z
          .string()
          .optional()
          .describe(
            "The 8-char id of the existing ACTIVE record being challenged " +
              "(REQUIRED). Get this from a prior `search_lore` / `get_lore`.",
          ),
        observation: z
          .string()
          .optional()
          .describe(
            "What did you observe that contradicts the existing record? " +
              "(REQUIRED.) Stand-alone explanation — the reviewer reads " +
              "this without additional context. ≤ 800 chars.",
          ),
        source: z
          .string()
          .optional()
          .describe(
            "URL pointing at the contradicting evidence (commit, PR, code " +
              "permalink); must be http(s) if given. Counter-claims with a " +
              "source are higher-trust.",
          ),
        repos: z
          .array(z.string())
          .optional()
          .describe(
            "Repos this counter-claim is scoped to. Inherits from the " +
              "challenged record if omitted (handled by the reviewer).",
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            "Extra tags. 'conflict-report' is always added automatically.",
          ),
      },
    },
    async (args) => {
      // Audit shape mirrors suggest_lore: never record the observation
      // body, just its length, so the audit log can be grepped for
      // "agent X repeatedly challenges record Y" without leaking content.
      const sanitised: Record<string, unknown> = {
        existingId: args.existingId,
        observationChars:
          typeof args.observation === "string" ? args.observation.length : 0,
        source: args.source,
        repos: args.repos,
        tags: args.tags,
      };
      const fieldErrorResponse = (err: FieldError) => {
        audit({
          tool: "report_conflict",
          request: sanitised,
          error: auditMessageForFieldError(err),
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(err, null, 2) }],
        };
      };
      const requiredErr =
        requireNonEmptyString("existingId", args.existingId) ??
        requireNonEmptyString("observation", args.observation);
      if (requiredErr) return fieldErrorResponse(requiredErr);
      const sourceErr = checkOptionalHttpUrl("source", args.source);
      if (sourceErr) return fieldErrorResponse(sourceErr);
      const existingId = args.existingId as string;
      const observation = args.observation as string;
      const obsLen = checkLength("observation", observation);
      if (obsLen) {
        return fieldErrorResponse(tooLongToFieldError("observation", obsLen));
      }
      try {
        // Restricted records are NEVER challengeable via MCP — the
        // core reportConflict refuses them regardless of the env
        // gate. We pre-check here purely to (a) emit a cleaner
        // `blocked: "restricted"` audit row and (b) give the agent a
        // useful hint instead of the generic catch-block message.
        // No env check: even with LOREGUARD_ALLOW_RESTRICTED_MCP=1
        // the core would still throw. Telling the agent to set the
        // env var would be a lie.
        const existing = getLore(db, existingId);
        if (shouldRefuseConflictAgainstRestricted(existing)) {
          audit({
            tool: "report_conflict",
            request: sanitised,
            blocked: "restricted",
          });
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  CONFLICT_AGAINST_RESTRICTED_REFUSAL,
                  null,
                  2,
                ),
              },
            ],
          };
        }
        const draft = reportConflict(db, {
          existingId,
          observation,
          source: args.source,
          repos: args.repos,
          tags: args.tags,
        });
        audit({
          tool: "report_conflict",
          request: sanitised,
          resultCount: 1,
          resultIds: [draft.id],
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: draft.id,
                  status: draft.status,
                  conflictsWith: draft.conflictsWith ?? [],
                  message:
                    "Counter-draft created. A human will review with `loreguard review` and " +
                    "either approve / reject / edit / supersede the original.",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const reason =
          err instanceof ReportConflictError ? err.reason : "internal_error";
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "report_conflict",
          request: sanitised,
          error: `${reason}: ${msg}`,
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `report_conflict failed (${reason}): ${msg}`,
            },
          ],
        };
      }
    },
  );

  // ---- record_absence -------------------------------------------------
  server.registerTool(
    "record_absence",
    {
      title: "Record a verified-absence marker (no lore on this topic)",
      description:
        "**Call this only when ALL THREE are true:** (1) you searched, " +
        "(2) you got zero hits, AND (3) you've confirmed the gap is real " +
        "and durable — i.e. the team genuinely has no policy on this " +
        "topic, you're not just one re-phrasing away from a hit, and " +
        "you'd expect the gap to still be there in a month. The strict " +
        "trigger is intentional: default to NOT calling unless the " +
        "absence is itself a finding worth recording.\n\n" +
        "Cheap to be wrong (markers self-expire — default 14 days, max " +
        "365); cheap to omit (next agent just re-searches). Future " +
        "search_lore calls on the same normalised query (lowercase, " +
        "sorted tokens) surface the marker as `absence_marker: { reason, " +
        "expiresAt }` alongside an empty results array, so the next agent " +
        "knows it's an acknowledged gap rather than re-discovering nothing.\n\n" +
        "Anti-patterns: do NOT call on every zero-hit search; do NOT call " +
        "as a substitute for suggest_lore (markers say 'no policy', not " +
        "'here's a policy'); do NOT chain into a suggest_lore that just " +
        "re-states the absence.",
      inputSchema: {
        // Lenient schema; validated in the handler so failures return a
        // structured {error, field, hint} instead of a raw SDK -32602.
        query: z
          .string()
          .optional()
          .describe(
            "The query you ran that returned zero hits (REQUIRED). " +
              "Normalised at write time (lowercase, sorted tokens) so " +
              "re-phrasings match. ≤ 500 chars.",
          ),
        reason: z
          .string()
          .optional()
          .describe(
            "One-sentence explanation of WHY this is a known gap (REQUIRED; " +
              "≤ 500 chars). E.g. 'team has no policy yet; ad hoc per incident'.",
          ),
        repo: z
          .string()
          .optional()
          .describe(
            "Optional repo scope. Repo-scoped markers shadow global ones " +
              "when search_lore is called with the same repo.",
          ),
        expiresInDays: z
          .number()
          .optional()
          .describe(
            "Days until the marker auto-expires (1–365, default 14). Stale " +
              "'we checked' claims age out fast so a bad call from one agent " +
              "can't poison retrieval for long.",
          ),
      },
    },
    async (args) => {
      const sanitised: Record<string, unknown> = {
        queryChars: typeof args.query === "string" ? args.query.length : 0,
        reasonChars: typeof args.reason === "string" ? args.reason.length : 0,
        repo: args.repo,
        expiresInDays: args.expiresInDays,
      };
      // Env gate first — a deliberate refusal, distinct from bad input.
      if (shouldGateAbsenceWrite(process.env)) {
        audit({
          tool: "record_absence",
          request: sanitised,
          blocked: "mcp_disabled",
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(ABSENCE_DISABLED_REFUSAL, null, 2),
            },
          ],
        };
      }
      const fieldErrorResponse = (err: FieldError) => {
        audit({
          tool: "record_absence",
          request: sanitised,
          error: auditMessageForFieldError(err),
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(err, null, 2) }],
        };
      };
      const requiredErr =
        requireNonEmptyString("query", args.query) ??
        requireNonEmptyString("reason", args.reason);
      if (requiredErr) return fieldErrorResponse(requiredErr);
      const query = args.query as string;
      const reason = args.reason as string;
      const queryLen = checkLength("query", query);
      if (queryLen) return fieldErrorResponse(tooLongToFieldError("query", queryLen));
      const reasonLen = checkLength("reason", reason);
      if (reasonLen) {
        return fieldErrorResponse(tooLongToFieldError("reason", reasonLen));
      }
      // expiresInDays: optional; if present must be an integer in [1, 365].
      let expiresInDays: number | undefined;
      if (args.expiresInDays !== undefined) {
        const n = args.expiresInDays;
        if (!Number.isInteger(n) || n < 1 || n > 365) {
          return fieldErrorResponse({
            error: "expiresInDays_invalid",
            field: "expiresInDays",
            hint: "`expiresInDays` must be an integer between 1 and 365 (or omit it for the 14-day default).",
          });
        }
        expiresInDays = n;
      }
      try {
        const result = recordAbsence(db, {
          query,
          reason,
          repo: args.repo,
          expiresInDays,
          recordedBy: "agent",
        });
        audit({
          tool: "record_absence",
          request: sanitised,
          resultCount: 1,
          resultIds: [result.id],
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: result.id,
                  expiresAt: result.expiresAt,
                  message:
                    "Absence marker recorded. Future search_lore calls " +
                    "matching this normalised query will surface this marker " +
                    `until ${result.expiresAt}.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "record_absence",
          request: sanitised,
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `record_absence failed: ${msg}` }],
        };
      }
    },
  );


  // ---- find_dependents -------------------------------------------------
  server.registerTool(
    "find_dependents",
    {
      title: "Find who provides / consumes a contract (impact check)",
      description:
        "**Call this BEFORE changing any cross-repo contract** — an event " +
        "you publish, an HTTP endpoint you serve, a queue, a shared DB " +
        "table, an RPC method. Loreguard keeps a team-ratified map of " +
        "which repos `provides` (own / produce) and which `consumes` " +
        "(depend on) each contract, aggregated across every repo's " +
        "committed lore. This tool returns both sides for one contract, " +
        "so the `consumers` list is your blast radius: change the shape " +
        "and those are the repos that break.\n\n" +
        "Use it to answer 'if I change `order-submitted`, what does it " +
        "affect?'. An empty result doesn't prove safety — the map is only " +
        "as complete as what teams have declared — but a non-empty " +
        "`consumers` list is a concrete warning to coordinate the change. " +
        "If you discover a producer/consumer relationship that ISN'T in " +
        "the map, call `declare_boundary` to add it (lands as a draft).",
      inputSchema: {
        contract: z
          .string()
          .optional()
          .describe(
            "The contract name (REQUIRED): an event ('order-submitted'), " +
              "endpoint ('POST /v1/orders'), queue, table, or RPC. Matched " +
              "after normalisation (lowercased / hyphenated), so casing and " +
              "spacing don't matter.",
          ),
      },
    },
    async (args) => {
      const contractErr = requireNonEmptyString("contract", args.contract);
      if (contractErr) {
        audit({
          tool: "find_dependents",
          request: args as Record<string, unknown>,
          error: auditMessageForFieldError(contractErr),
        });
        return {
          content: [
            { type: "text", text: JSON.stringify(contractErr, null, 2) },
          ],
        };
      }
      try {
        const result = findDependents(db, args.contract as string);
        audit({
          tool: "find_dependents",
          request: args as Record<string, unknown>,
          resultCount: result.providers.length + result.consumers.length,
          resultIds: [...result.providers, ...result.consumers].map((b) => b.id),
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  contract: result.contract,
                  providers: result.providers.map(boundaryForMcp),
                  consumers: result.consumers.map(boundaryForMcp),
                  next:
                    result.providers.length === 0 &&
                    result.consumers.length === 0
                      ? "No declared providers or consumers for this contract. " +
                        "The map may be incomplete — this is NOT proof the " +
                        "change is safe. If you know of a producer/consumer, " +
                        "call declare_boundary to record it."
                      : "These are the declared cross-repo dependents. Treat " +
                        "`consumers` as the blast radius of a shape change and " +
                        "coordinate accordingly.",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "find_dependents",
          request: args as Record<string, unknown>,
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `find_dependents failed: ${msg}` }],
        };
      }
    },
  );

  // ---- declare_boundary ------------------------------------------------
  server.registerTool(
    "declare_boundary",
    {
      title: "Declare a cross-repo boundary edge (draft)",
      description:
        "**Call this when you discover that a repo produces or depends on " +
        "a cross-repo contract** and that relationship isn't already in " +
        "the map (check with `find_dependents` first). Concrete triggers: " +
        "you find code publishing an event another service handles; a " +
        "service calling another's endpoint; a job reading a table another " +
        "team owns.\n\n" +
        "`role: 'provides'` = this repo OWNS / produces the contract " +
        "(the event publisher, the endpoint's server). `role: 'consumes'` " +
        "= this repo DEPENDS on it (subscriber, caller, reader).\n\n" +
        "Lands as a DRAFT — invisible to the default map until a human " +
        "ratifies it with `loreguard boundary approve <id>`. You cannot " +
        "promote your own edges; same trust gate as suggest_lore. Don't " +
        "declare speculative or transient links — only durable " +
        "integration points a future agent should see.",
      inputSchema: {
        // Lenient schema; validated in the handler so failures return a
        // structured {error, field, hint} instead of a raw SDK -32602.
        repo: z
          .string()
          .optional()
          .describe(
            "The repo this edge belongs to (REQUIRED) — the producer's or " +
              "consumer's name as in a Git URL, e.g. 'orders-svc'.",
          ),
        contract: z
          .string()
          .optional()
          .describe(
            "The contract name (REQUIRED; event / endpoint / queue / table " +
              "/ rpc). Normalised (lowercased / hyphenated) so it joins " +
              "across repos.",
          ),
        role: z
          .string()
          .optional()
          .describe(
            "REQUIRED. 'provides' if this repo owns/produces the contract; " +
              "'consumes' if it depends on it.",
          ),
        kind: z
          .string()
          .optional()
          .describe(
            "Optional classifier: event | endpoint | queue | table | rpc | other.",
          ),
        detail: z
          .string()
          .optional()
          .describe(
            "Optional note: which field/version/path, migration caveats, " +
              "the evidence you saw. ≤ 800 chars.",
          ),
        source: z
          .string()
          .optional()
          .describe(
            "URL to the code / PR / doc that evidences this edge (http(s) " +
              "if given).",
          ),
      },
    },
    async (args) => {
      const sanitised: Record<string, unknown> = {
        repo: args.repo,
        contract: args.contract,
        role: args.role,
        kind: args.kind,
        detailChars: typeof args.detail === "string" ? args.detail.length : undefined,
        source: args.source,
      };
      const fieldErrorResponse = (err: FieldError) => {
        audit({
          tool: "declare_boundary",
          request: sanitised,
          error: auditMessageForFieldError(err),
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(err, null, 2) }],
        };
      };
      const requiredErr =
        requireNonEmptyString("repo", args.repo) ??
        requireNonEmptyString("contract", args.contract) ??
        requireNonEmptyString("role", args.role);
      if (requiredErr) return fieldErrorResponse(requiredErr);
      const roleErr = checkOptionalEnum("role", args.role, ["provides", "consumes"]);
      if (roleErr) return fieldErrorResponse(roleErr);
      const kindErr = checkOptionalEnum("kind", args.kind, [
        "event",
        "endpoint",
        "queue",
        "table",
        "rpc",
        "other",
      ]);
      if (kindErr) return fieldErrorResponse(kindErr);
      const sourceErr = checkOptionalHttpUrl("source", args.source);
      if (sourceErr) return fieldErrorResponse(sourceErr);
      const detailLen =
        typeof args.detail === "string" ? checkLength("observation", args.detail) : null;
      if (detailLen) {
        return fieldErrorResponse({
          ...tooLongToFieldError("detail", detailLen),
          hint: "Retry with a shorter `detail` (≤ 800 chars), or omit it.",
        });
      }
      try {
        const edge = suggestBoundary(db, {
          repo: args.repo as string,
          contract: args.contract as string,
          role: args.role as "provides" | "consumes",
          kind: args.kind,
          detail: args.detail,
          source: args.source,
          author: "agent",
        });
        audit({
          tool: "declare_boundary",
          request: sanitised,
          resultCount: 1,
          resultIds: [edge.id],
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: edge.id,
                  status: edge.status,
                  repo: edge.repo,
                  contract: edge.contract,
                  role: edge.role,
                  message:
                    "Boundary edge drafted. A human will review with " +
                    "`loreguard boundary review` and ratify with " +
                    `\`loreguard boundary approve ${edge.id}\`.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "declare_boundary",
          request: sanitised,
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `declare_boundary failed: ${msg}` }],
        };
      }
    },
  );

  return server;
}
