# loreguard roadmap

A living backlog. Anything here is checked against the **guardrails** below —
that's how we keep ambition from turning into the thing loreguard is trying
*not* to be.

## Guardrails (what loreguard is)

1. **Local-first, no daemon.** The tool never runs a server or makes network
   calls. Aggregation is by git, not by a hosted DB.
2. **PR / human is the trust gate.** Agents and scanners *propose* (drafts);
   humans *ratify*. Nothing auto-activates.
3. **Lore is what you can't derive from the code.** The *why*, the
   *what-not-to-do*, the cross-team policy, the incident lesson. Not live
   metrics, not the current call graph — those are derived, and belong in the
   tools that own them. We link to them; we don't ingest them.
4. **Token-frugal by default.** Brief-by-default, full body on demand.
5. **Additive over migrations.** Prefer changes that don't rewrite the schema
   or change defaults.

If a feature needs us to break guardrail 1 or 2, it's probably a different
product tier, not a ticket.

---

## Near-term (in progress / next)

These three fuse the two halves of the product — curated memory and the
architecture map — into single answers.

- [x] **#1 — Link lore ↔ contracts.** `impact <contract>` /
  `find_dependents` now return not just *who's affected* but *the rules that
  apply* to that contract (e.g. the "order-submitted must carry a timezone
  offset" record). No new schema — `relatedLore` matches via tag link + an
  FTS `all` match on the contract's meaningful word tokens (HTTP methods /
  short / numeric tokens dropped). Surfaced in the CLI and as
  `applicableLore` in the MCP response. **(done)**
- [ ] **#2 — Architecture manifest that diffs in PRs.** `graph --json`
  (already exists) → a committed `.loreguard/architecture.json` so a removed
  provider edge or a new dangling consumer shows up as a reviewable diff in a
  pull request. Git-native change detection for the estate.
- [ ] **#3 — Discovery confidence tiers.** Mark high-signal patterns (route
  definitions) vs. fuzzier ones (`.publish` on a generic bus) so
  `boundary review` can fast-path the obvious edges and scrutinise the rest.

---

## Epic A — The estate repo (enterprise-wide knowledge, the right way)

> Vision: an org-wide place that holds every team's approved lore AND the full
> e2e "repo A calls repo B" map. **Built as a git repo + CI, NOT a server**
> (guardrail 1). Git is the auth, the audit log, and the review gate.

- [ ] **A1 — `loreguard estate` aggregation command.** Point it at a checkout
  of every repo (or a parent dir); it runs `sync pull` across all of them and
  produces one combined DB + `export --html`. The CI job for the estate repo.
- [ ] **A2 — Estate-repo scaffolding.** `loreguard estate init` writes a
  ready-to-commit repo: a GitHub Action that checks out member repos, runs
  aggregation, and publishes the map to GitHub Pages. Zero servers.
- [ ] **A3 — Per-team ownership in the aggregated view.** Surface which team /
  repo a record or edge came from, so the estate view is navigable by owner.
- [ ] **A4 — Estate-wide gap report.** `graph --gaps` across the whole estate
  — the dangling consumers that cross team boundaries are the highest-value
  signal (one team depends on a contract no team is shown to own).

## Epic B — Service cards (the per-repo TL;DR)

> A generated summary card per service: what it is, what it provides/consumes,
> its key lore, and durable links out.

- [ ] **B1 — `loreguard service-card [repo]`.** One-screen summary: provides /
  consumes edges, top lore records, stale/gap warnings.
- [ ] **B2 — Durable links from gitconfig.** Derive the GitHub repo URL from
  `remote.origin.url` (we already have `shortRepoNameFromRemote`) and link to
  the README. Optionally a recorded dashboard/runbook URL — a *pointer*, not
  ingested data (guardrail 3).
- [ ] **B3 — Service cards in the HTML export.** A tab/section per repo.

## Epic C — The review UI (approve/deny without breaking static-ness)

> Tension: a committable static file can't write to the DB. Resolve by
> splitting the surfaces.

- [ ] **C1 — Actionable static export (cheap).** On each draft in the HTML,
  render the exact `loreguard approve <id>` / `reject` command (copy-button),
  so the read-only artifact is still actionable. Stays static.
- [ ] **C2 — `loreguard serve` (opt-in, localhost-only).** A tiny local review
  UI that DOES write to the local DB — approve/deny/edit the draft queue from
  the browser. Explicitly localhost-bound, single-user, no network exposure;
  a separate surface from the committable export so the artifact stays pure.
- [ ] **C3 — Estate approve = PR.** In the estate view, "approve" links to
  opening a PR against the owning repo's `.loreguard/`. Git-native ratify.

## Epic D — Pushback parking lot (scoped narrowly or deferred)

- [ ] **D1 — Metrics: pointers only.** Record a dashboard URL per service;
  never ingest metric values (guardrail 3). Re-evaluate only if there's a
  durable-fact framing.
- [ ] **D2 — Hook upgrades (deferred by request).** SessionStart primer +
  Stop-hook session summary from DB ground truth. Parked.

---

_Checklist convention: `[ ]` open, `[~]` in progress, `[x]` done. Keep the
guardrails honest — if a ticket starts fighting them, say so in the ticket._
