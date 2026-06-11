/**
 * `loreguard digest` — the "what needs a human decision?" roll-up.
 *
 * The hardest failure mode in any team-memory tool isn't capture; it's the
 * queue of unreviewed / aging records that quietly accumulates and never
 * gets triaged (the README says as much). `stats` answers "is it earning
 * its keep?"; `digest` answers the complementary maintenance question by
 * composing the lists that already exist — pending drafts, open conflict
 * counter-records, stale-but-active records, retire candidates, and pending
 * boundary edges — into one actionable report. No new schema, no telemetry.
 */
import type { Database } from "better-sqlite3";

import { listBoundaryDrafts } from "../core/boundaries.js";
import { listDrafts, listStaleActive } from "../core/lore.js";
import type { Boundary, LoreSummary } from "../db/types.js";
import { retireCandidates, type RetireCandidate } from "./stats.js";

export interface Digest {
  /** Plain agent-suggested drafts awaiting review (NOT conflict counters). */
  readonly drafts: LoreSummary[];
  /** Draft counter-records from `report_conflict` — an open disagreement. */
  readonly conflicts: LoreSummary[];
  /** Active records whose review date has lapsed. */
  readonly stale: Array<{ id: string; title: string; reviewAfter: string }>;
  /** Active records with no reads in the quiet window. */
  readonly retire: RetireCandidate[];
  /** Pending boundary edges awaiting ratification. */
  readonly boundaryDrafts: Boundary[];
  /** The quiet-window (days) used for retire candidates, for the header. */
  readonly quietForDays: number;
}

export function buildDigest(
  db: Database,
  opts: { quietForDays?: number } = {},
): Digest {
  const quietForDays = opts.quietForDays ?? 180;
  const allDrafts = listDrafts(db);
  // A conflict counter-record is a draft with a non-empty conflictsWith
  // link; everything else is an ordinary suggestion. Split so the human
  // sees "open disagreements" distinctly from "new suggestions".
  const conflicts = allDrafts.filter(
    (d) => d.conflictsWith && d.conflictsWith.length > 0,
  );
  const drafts = allDrafts.filter(
    (d) => !(d.conflictsWith && d.conflictsWith.length > 0),
  );
  return {
    drafts,
    conflicts,
    stale: listStaleActive(db),
    retire: retireCandidates(db, { quietForDays }),
    boundaryDrafts: listBoundaryDrafts(db),
    quietForDays,
  };
}

/** Total count of items the digest considers actionable. */
export function digestActionableCount(d: Digest): number {
  return (
    d.drafts.length +
    d.conflicts.length +
    d.stale.length +
    d.retire.length +
    d.boundaryDrafts.length
  );
}

export function renderDigest(d: Digest): string {
  if (digestActionableCount(d) === 0) {
    return "loreguard digest: nothing needs attention — queues empty, nothing stale.";
  }
  const lines: string[] = ["loreguard digest — items needing a human decision", ""];
  const MAX = 8;

  const section = (
    title: string,
    count: number,
    render: () => string[],
    cta: string,
  ): void => {
    if (count === 0) return;
    lines.push(`${title}: ${count}`);
    lines.push(...render());
    if (count > MAX) lines.push(`  … and ${count - MAX} more`);
    lines.push(`  → ${cta}`);
    lines.push("");
  };

  section(
    "Open conflicts (code contradicts a ratified record)",
    d.conflicts.length,
    () => d.conflicts.slice(0, MAX).map((c) => `  ${c.id}  ${c.title}`),
    "loreguard review  (resolve via supersede / update / reject)",
  );
  section(
    "Pending drafts (agent suggestions awaiting review)",
    d.drafts.length,
    () => d.drafts.slice(0, MAX).map((c) => `  ${c.id}  ${c.title}`),
    "loreguard review",
  );
  section(
    "Stale active records (review date lapsed)",
    d.stale.length,
    () =>
      d.stale
        .slice(0, MAX)
        .map((s) => `  ${s.id}  ${s.title}  [review was due ${s.reviewAfter.slice(0, 10)}]`),
    "loreguard verify <id>  (re-affirm) or loreguard deprecate <id>",
  );
  section(
    `Retirement candidates (active, no reads in ${d.quietForDays} days)`,
    d.retire.length,
    () =>
      d.retire.slice(0, MAX).map((r) => {
        const src = r.hasSource ? "sourced" : "no source";
        return `  ${r.id}  ${r.title}  [${r.confidence}, ${src}]`;
      }),
    "loreguard stats --retire  to review, then deprecate the dead weight",
  );
  section(
    "Pending boundary edges (cross-repo map awaiting ratification)",
    d.boundaryDrafts.length,
    () =>
      d.boundaryDrafts
        .slice(0, MAX)
        .map((b) => `  ${b.id}  ${b.repo} ${b.role} ${b.contract}`),
    "loreguard boundary review",
  );

  // Trim the trailing blank line for a tidy tail.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}
