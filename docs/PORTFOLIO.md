# Loreguard — Value Analysis & Improvement Portfolio

> A read of what loreguard actually is, where its value concentrates, and a
> prioritised portfolio of changes that would make it better and more usable
> for real teams. Grounded in the code as it stands on
> `claude/branch-analysis-improvements-sv69ln` (== `main`, commit `2833435`,
> v0.1.1, 473 tests green).

---

## Part 1 — What loreguard is, and the value it has

### The core idea (and why it's a real idea)

Most "agent memory" stores **what one session inferred**. Loreguard stores
**what a team reviewed and approved**. That one-word swap — *ratified* — is the
whole product:

- A confident agent that recites something it guessed once and got wrong is the
  classic failure mode of session memory. Loreguard's answer is a **trust gate**:
  agents can *suggest* (drafts), only humans can *approve*. The MCP surface
  deliberately exposes **no approval tool**. An agent cannot promote its own
  belief into canon. That is the single most important design decision in the
  repo, and the codebase enforces it consistently (drafts hidden from default
  search; confidence clamped; conflict counter-records never mutate the original;
  boundary edges land as drafts).
- It positions itself precisely against two neighbours: `CLAUDE.md` (always-on,
  paid every prompt) and generic memory (one session's belief). Loreguard is
  **just-in-time, team-ratified** context — retrieved only when a task warrants
  it. That framing is coherent and defensible.

This is a genuinely good primitive. The "team-ratified vs session-believed"
distinction is the kind of thing that's obvious in hindsight and most tools get
wrong.

### Where the engineering value is real

This is not a thin wrapper. Concretely strong things in the code:

- **Search is probabilistic, not naive.** FTS5 + BM25 with tuned column weights
  (`title 3 / summary 2 / body 1`), then a *trust-aware re-rank* in TypeScript
  over a 60-row candidate pool: stale / source-less / low-confidence records get
  demoted, high-confidence promoted, with the adjustment clamped to ±0.5 so trust
  reorders near-ties but never rescues a junk lexical match. That's a thoughtful
  retrieval design, not `LIKE '%foo%'`.
- **The trust model is enforced at write time, not just documented.** `high`
  confidence is impossible without a `source`; drafts cap at `medium`; sources
  must be real HTTP(S) URLs; ISO dates are validated up front (the
  `new Date('nonsense')` footgun is explicitly closed). Invariants live in
  `clampConfidence` / `assertHttpUrl`, not in a README paragraph.
- **Transaction discipline + N+1 avoidance.** Lore writes pair the row, FTS
  index, junction rows, and event emission atomically; reads batch-hydrate
  repos/tags via `IN (...)` so a 20-hit search is ~2 queries, not 40.
- **Audit + redaction are honest.** MCP tool calls are logged append-only
  (`audit.jsonl`, 0600) with request args and result *ids* but never result
  *bodies*; the `events` table tracks reads as `lore_id + kind + ts` only — no
  query, no identity. Both stay local; the env knobs to silence them exist and
  are tested.
- **Nice touches that show the author dogfooded it:** verified-absence markers
  (stop re-discovering the same "nothing" every session, self-expiring so a bad
  call ages out), structured field errors instead of opaque MCP `-32602` dumps
  (so an agent self-corrects without a human round-trip), the cross-repo boundary
  map ("change this contract — who breaks?"), and `suggest --from-commit` (grow a
  corpus from work you already did).
- **Quality bar is high for a 0.1:** ~9.5k LOC source, ~6.9k LOC tests, 473
  passing, clean typecheck, CI, ADRs, SECURITY/DATA-FLOW docs, dependabot, a
  published npm package, a landing page. This is a serious, well-tended project.

### An honest skeptic's read — where the value is still *latent*

The ideas and the engineering are good; the **realised** value is gated by three
things that are not yet solved:

1. **Cold-start is the whole ballgame, and it's hard.** Loreguard is worthless
   with an empty DB and only earns its keep with a small, *curated, high-signal*
   corpus. The author knows this — they deliberately deleted the mechanical
   importers (`induct`, `ingest-md`) because they "produced ~80% noise that
   flooded the review queue." Correct call. But it leaves **exactly one**
   cold-start path (`/loreguard-onboard`), and that path requires Claude Code
   specifically. The thing standing between a new user and any value is a chunk of
   manual curation work, and the tool gives them one narrow door to do it.
2. **The payoff is delayed and hard to feel.** The win ("the agent already knew
   the Argon2id ruling, didn't re-derive it") is invisible and counterfactual.
   `loreguard stats` answers "is it earning its keep?" with read counts, but
   read-counts aren't a felt benefit. Nothing tells a user *"lore saved you ~N
   tokens / N minutes of repo-spelunking this week."*
3. **Single-player today, sold as multiplayer.** The pitch is "the *team*
   agrees." The mechanism is `git`-committed `.loreguard/` markdown round-tripped
   through a small custom YAML parser, aggregated by walking sibling repos. That's
   a clever local-first posture, but the *team* story — merge conflicts in
   `.loreguard/`, who-resolves-a-conflict-record, keeping tags from fragmenting
   across people — is the least developed part of the system.

**Bottom line:** loreguard is a well-built answer to a real problem with a sound
trust model and genuinely good retrieval internals. Its value is currently capped
not by engineering quality but by *adoption friction* and *unfelt payoff*. The
portfolio below is ordered to attack exactly that.

---

## Part 2 — Improvement portfolio

Each item: **Problem → Proposal → Why it matters → Effort → Risk.** Effort is
rough (S < 1 day, M a few days, L a week+). Grouped by theme, then a
prioritised shortlist at the end.

### Theme A — Adoption & onboarding (lower the barrier to first value)

This is where the leverage is. Everything else only matters once people get past
an empty DB.

**A1. A 60-second, agent-agnostic quickstart that ends in a real hit.**
- *Problem:* The README's happy path is excellent but long; `demo` uses synthetic
  data; the only *real* cold-start needs Claude Code + a skill copy + a CLAUDE.md
  edit. A new user can't feel the core loop ("ask → agent pulls ratified context")
  in under a minute without that whole rig.
- *Proposal:* `loreguard quickstart` — one interactive command that runs `init`,
  seeds 1–2 records *from the current repo's git remote + README title* (clearly
  marked, easy to delete), wires the MCP server + CLAUDE.md rule if Claude is
  detected, and prints the exact next sentence to say to the agent. Make `doctor`
  end with a single "you are N steps from your first hit: …" status line.
- *Why:* Collapses the time-to-first-value, which is the #1 thing capping adoption.
- *Effort:* M. *Risk:* Low (it's orchestration over commands that already exist).

**A2. Concrete configs for Cursor, Windsurf, Continue, and raw MCP.**
- *Problem:* The README *names* Cursor but ships no concrete config; the whole
  onboarding flow is Claude-Code-shaped (skill, Stop-hook, `setup`). Anyone not on
  Claude Code is left to figure it out.
- *Proposal:* A `docs/clients/` page with copy-paste MCP config for Cursor,
  Windsurf, Continue, VS Code, and generic stdio MCP, plus the editor-specific
  equivalent of the retrieval rule (`.cursorrules`, etc.). Teach
  `loreguard print-claude-instructions` a `--format cursor|windsurf|generic`
  flag so the rule isn't Claude-only.
- *Why:* MCP is multi-client; loreguard's value isn't Claude-specific. This is the
  cheapest way to widen the addressable audience.
- *Effort:* S–M. *Risk:* Low.

**A3. A guided, judgement-preserving importer for existing ADRs/docs.**
- *Problem:* Mechanical doc-chunking was (rightly) removed for being noisy. But
  many teams already have ADRs and `docs/decisions/` that *are* high-signal — and
  forcing all of that through an interactive Claude skill is heavy.
- *Proposal:* `loreguard import-adr <dir>` that proposes **one draft per ADR
  file** (not per bullet), pre-filling title/summary/source from the file's H1 +
  first paragraph + a `source` link, then drops them straight into the existing
  `loreguard review` queue. It doesn't *decide* — the human still triages every
  one — but it removes the retyping. Keep it ADR-shaped (one file = one decision)
  so the signal-to-noise stays high, which is exactly why the old chunker failed.
- *Why:* Bridges the gap between "fully manual skill" and "noisy mechanical dump"
  for the one corpus most teams already have.
- *Effort:* M. *Risk:* Medium — must resist scope-creeping back into a generic
  chunker. Constrain it to one-decision-per-file.

### Theme B — Retrieval quality (make search actually find the right thing)

**B1. Phrase and AND search, not just OR.**
- *Problem:* `toFtsQuery` quotes each token and joins with `OR`. So
  `password hashing` matches anything with *password* **or** *hashing* — great
  recall, poor precision. There's no way to require both terms or match an exact
  phrase. The author chose OR deliberately (a fresh corpus returned 0 hits under
  AND), but that's a cold-corpus artifact, not a steady-state preference.
- *Proposal:* Support `"quoted phrases"` (pass through as an FTS phrase) and a
  `match: 'any' | 'all'` option (default `any`, but auto-escalate to `all` when a
  query has 4+ tokens and `any` returns a flood). Surface the mode in the result so
  the agent/human knows whether recall or precision was applied.
- *Why:* Precision matters most exactly when the corpus is large enough to be
  worth searching — the regime where loreguard is supposed to shine.
- *Effort:* S–M. *Risk:* Low (additive; default behaviour preserved).

**B2. Optional local semantic search for synonym/paraphrase gaps.**
- *Problem:* Pure FTS can't connect "bcrypt" ↔ "Argon2" ↔ "password hashing" by
  meaning. A record titled "Identifiers — UUID spec" may miss "how do we generate
  IDs." The author flags this honestly. For a knowledge base where the *whole
  point* is "find the relevant ruling," lexical-only recall leaks.
- *Proposal:* An **optional** local embedding index (e.g. a small on-device model
  or a pluggable embeddings provider, off by default to preserve the strict
  local/no-network posture), combined with the existing BM25 via reciprocal-rank
  fusion. Gate it behind an explicit opt-in env/flag and document the trade-off
  loudly. Keep FTS as the always-available default.
- *Why:* This is the difference between "found it" and "the agent re-derived
  because search missed." It's the highest-ceiling retrieval improvement.
- *Effort:* L. *Risk:* Medium — must not compromise the local-only/no-egress
  guarantee; opt-in and clearly scoped.

**B3. Tag hygiene to stop silent corpus fragmentation.**
- *Problem:* Tags and repos are free-text. `security` vs `securty` vs `sec`
  silently fragment retrieval — an ANY-of tag filter quietly misses the typo'd
  record, and nothing surfaces the drift. On a multi-person corpus this rots
  search slowly and invisibly.
- *Proposal:* `loreguard tags` (list with counts), `loreguard tags rename <a> <b>`,
  `loreguard tags merge <a...> <into>`, and a `doctor` warning for near-duplicate
  tags (edit-distance 1–2). Same for repos. Optionally suggest existing tags at
  `add`/`review` time.
- *Why:* Cheap insurance against the slow, invisible decay that kills faceted
  retrieval on shared corpora.
- *Effort:* S–M. *Risk:* Low.

### Theme C — Curation & maintenance (keep the corpus healthy over time)

**C1. A lifecycle digest so stale records don't just accrete.**
- *Problem:* `reviewAfter` flags a record `stale` but nothing *escalates*. A
  record set for review in 2025 ages forever, still served, still flagged. The
  hardest failure mode (the author says so) isn't capture — it's the unreviewed
  pile. There's a Stop-hook nudge for *drafts*, but nothing for *aging actives* or
  *quiet records*.
- *Proposal:* `loreguard digest` (and an optional weekly hook) that summarises:
  stale-but-active records, retire candidates (already computed by `stats`),
  unresolved conflict counter-records, and pending drafts — one actionable list.
  "Here are the 6 records that need a human decision this week."
- *Why:* Turns maintenance from a thing you forget into a small recurring nudge.
  Directly serves the author's own stated #1 failure mode.
- *Effort:* M (mostly composing existing queries). *Risk:* Low.

**C2. A real conflict-resolution flow.**
- *Problem:* `report_conflict` creates a counter-record linked via
  `conflictsWith`, and surfaces it in `review`. But resolution is improvised: the
  human's only tools are approve/reject/update/supersede against the counter,
  with no single "these two disagree — reconcile them" view. For the feature
  that's supposed to handle "the code contradicts the ratified record," that's a
  lot of manual stitching.
- *Proposal:* `loreguard conflicts` (list open conflict pairs side-by-side) and
  `loreguard resolve <conflictId>` that shows original + counter together and
  offers: supersede original with counter / reject counter (keep original, with
  reason) / edit-and-merge. Close the loop the conflict opened.
- *Why:* The conflict-reporting machinery already exists end-to-end; only the
  *resolution* ergonomics are missing. High value per unit effort.
- *Effort:* M. *Risk:* Low.

**C3. Make `stats` express *value*, not just *reads*.**
- *Problem:* `stats` proves activity (read counts) but not benefit. "Is loreguard
  earning its keep?" deserves an answer in the units a user cares about.
- *Proposal:* Add an estimated-savings view: per served record, a rough
  token-footprint of the summary vs. the counterfactual (a typical repo-exploration
  or pasted explanation), aggregated over the window — clearly labelled an
  estimate. Plus a tiny "this week: N hits across M records, ~K tokens of
  just-in-time context served" line. Local-only, same `events` table.
- *Why:* Converts an invisible, counterfactual payoff into something a champion can
  point at to justify keeping the tool.
- *Effort:* S–M. *Risk:* Low (it's an estimate — label it as such, don't oversell).

### Theme D — Trust & safety (defend the gate that is the product)

**D1. A secret-scan guard on write.**
- *Problem:* "Don't put secrets in lore" is repeated everywhere in the docs — which
  tells you it's the expected mistake. Right now nothing *checks*. A pasted API key
  in a body sails straight in, and `restricted` is explicitly "not DLP."
- *Proposal:* A lightweight entropy/pattern scan (AWS keys, private-key headers,
  bearer tokens, high-entropy blobs) at `add` / `suggest_lore` / `import` that
  **warns and asks to confirm** (CLI) or returns a structured
  `{ warning: "possible_secret", … }` (MCP, non-blocking, same self-correct shape
  as the existing field errors). Don't hard-block — warn, because false positives
  on a security knowledge base would be infuriating.
- *Why:* Defends the most-warned-about footgun at the one moment you can catch it,
  in the structured-error style the codebase already uses.
- *Effort:* M. *Risk:* Medium (false-positive tuning) — mitigated by warn-not-block.

**D2. Provenance on approval ("who ratified this, when").**
- *Problem:* The trust story is "a human approved it," but the record doesn't carry
  *which* human / *when approved* as first-class fields (the `events` chain has the
  timestamp; the served `LoreSummary` doesn't surface a ratifier). For a *team*
  trust artifact, "approved by Platform on 2026-02-10" is meaningful provenance.
- *Proposal:* Capture an optional approver identity at `approve` time (config or
  `--by`), expose `ratifiedBy` / `ratifiedAt` on the record and in `show`. Keep it
  optional and local — no identity system, just an attribution string.
- *Why:* Strengthens the core differentiator (ratified vs believed) by making the
  ratification legible.
- *Effort:* S. *Risk:* Low.

### Theme E — Team distribution (make the multiplayer story real)

**E1. A first-class merge story for `.loreguard/`.**
- *Problem:* The team mechanism is git-committed markdown via a small custom YAML
  parser, with `import` doing safe-upsert by `updatedAt`. Two people editing the
  same record produce a git-text conflict in YAML frontmatter that neither git nor
  loreguard helps reconcile, and malformed frontmatter degrades *silently*
  (fields become `undefined`). For the headline "the team agrees" use case, that's
  the soft spot.
- *Proposal:* (a) `loreguard sync verify <dir>` that validates every `.md` and
  reports per-file problems *loudly* instead of silently skipping — so a bad import
  is visible in CI. (b) A `loreguard sync status` that shows DB-vs-directory drift
  before import. (c) Document a concrete conflict-resolution recipe (resolve the
  git conflict, then `import --force` the winner). Optionally a 3-way `merge`
  helper later.
- *Why:* Turns the weakest, most-marketed part of the system from "clever in
  theory" into "works on a team of five."
- *Effort:* M (verify/status) + L (true merge). *Risk:* Low for verify/status.

**E2. A local, read-only review UI for non-CLI reviewers.**
- *Problem:* The reviewer is the human gate, but review is a keystroke CLI loop.
  The people best placed to *ratify* knowledge (leads, senior reviewers) are not
  always happy in a terminal. That narrows who can be the gate.
- *Proposal:* `loreguard review --web` → a localhost-only, no-network static UI
  (consistent with the strict local posture) for triaging the draft + conflict +
  stale queues with the same approve/reject/edit actions. Bind to 127.0.0.1, no
  external assets, dies with the process.
- *Why:* Widens the pool of people who can be the trust gate without weakening the
  gate or the local-only guarantee.
- *Effort:* L. *Risk:* Medium — must hold the no-network line absolutely; ship it
  loud about being localhost-only.

---

## Prioritised shortlist

If the goal is **maximum increase in realised value per unit effort**, do these
first, in order:

1. **A1 — `loreguard quickstart` + a sharper `doctor`** *(M)*. Attacks the #1
   value cap (time-to-first-hit) directly.
2. **A2 — concrete multi-client configs + `print-instructions --format`** *(S–M)*.
   Cheapest way to widen the audience beyond Claude Code.
3. **B1 — phrase + AND search** *(S–M)*. Highest precision-per-effort; default
   behaviour preserved.
4. **C1 — `loreguard digest`** *(M)*. Mostly composes existing queries; solves the
   author's own stated #1 failure mode (the unreviewed pile).
5. **C3 — value-expressing `stats`** *(S–M)*. Makes the invisible payoff visible,
   which is what keeps a tool adopted.
6. **B3 + D1 — tag hygiene and the secret-scan guard** *(S–M each)*. Cheap insurance
   on the two things that quietly rot a shared corpus: fragmentation and leaked
   secrets.

**Highest-ceiling, longer bets** (worth a spike once the above land): **B2** local
semantic search (the biggest retrieval ceiling-raiser) and **E1/E2** the real team
distribution + review-UI story (the biggest unlock of the "multiplayer" pitch).

Everything here is additive and preserves the two things that make loreguard
distinctive and trustworthy: **humans are the only approval gate**, and **nothing
leaves the box**. The portfolio raises *realised* value without touching either.
