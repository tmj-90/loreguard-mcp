# Operations — sync, stats, maintenance, storage

## Where data lives

A single SQLite file at `~/.loreguard/lore.db` (mode `0600`). That's the
entire storage layer. **For v0.1, SQLite is the canonical source of truth.**
Markdown files under `.loreguard/` are a *sync artifact*: PR-reviewable,
committable, and round-trippable, but the live record lives in SQLite. Drop
one machine's DB and rebuild it by importing your team's `.loreguard/`.

### Environment knobs (all local-only — none reach the network)

| Var | Effect |
|---|---|
| `LOREGUARD_DB` | Override the SQLite path (default `~/.loreguard/lore.db`). |
| `LOREGUARD_AUDIT_LOG` | Override the audit log path (default `~/.loreguard/audit.jsonl`). |
| `LOREGUARD_AUDIT_OFF=1` | Silence both the MCP audit log AND `read` event tracking. The test suite sets this. |
| `LOREGUARD_NO_TELEMETRY=1` | Silence `read` event tracking only (audit log still records MCP tool calls). |
| `LOREGUARD_ALLOW_RESTRICTED_MCP=1` | Let MCP `search_lore` / `get_lore` see restricted records. Off by default. `report_conflict` is unconditionally refused on restricted records regardless. |
| `LOREGUARD_ALLOW_MCP_ABSENCE=1` | Let MCP agents write absence markers via `record_absence`. Off by default in v0.1. |

## Team sync — Markdown round-trip

`loreguard sync export <dir>` writes one `.md` file per record into `<dir>`
(typically `.loreguard/` in the repo). `loreguard sync import <dir>` is the
inverse — new and updated `.md` files are merged back in by id, but a
strictly newer local record is never silently clobbered. Combined with normal
git workflow, the PR review *is* the trust gate.

```bash
loreguard sync export .loreguard               # active + non-restricted by default
loreguard sync export .loreguard --include-deprecated --include-superseded
loreguard sync export .loreguard --clean       # remove stale <id>.md files first
loreguard sync import .loreguard               # safe-import: skips local records that are newer
loreguard sync import .loreguard --force        # overwrite local records even when newer
loreguard sync import .loreguard --dry-run      # preview what would change
loreguard sync import .loreguard --include-restricted
loreguard sync pull <parent>                    # walk every repo under <parent> and merge their maps
```

Each `.md` is YAML-frontmatter + Markdown body. Frontmatter is deterministic
(fixed field order) so re-exporting a clean DB produces byte-identical files —
diffs stay tight.

Defaults are conservative:

- **Restricted records are excluded** from export by default. Pass
  `--include-restricted` if your repo is private and you want the history.
- **Drafts are excluded** from export by default. `loreguard review` is the
  gate, not `git push`.
- **Imports respect the file's declared `status`.** The PR is the review gate.
- Malformed files (no frontmatter, or missing `id` / `title` / `summary` /
  `status`) are skipped with a reason — import never crashes.

What `sync` deliberately does **not** do:

- **`export` is not a mirror** — it overwrites `<id>.md` for exported records
  but doesn't remove orphan `.md` files. Pass `--clean` for a deterministic
  mirror.
- **`import` is safe-upsert** — creates/updates by id, never overwrites a
  locally-newer record (`--force` to override), never deletes local records
  absent from the dir (use `loreguard delete <id>`).
- **The frontmatter parser is intentionally small** — flat scalars, ISO
  dates, booleans, string arrays only. Treat the generated format as
  canonical.

`loreguard export --json` is for one-file JSON backup; `loreguard sync` is for
the version-controlled team flow.

## Verified-absence markers

A recurring waste in agent workflows is **re-discovering the same nothing
across sessions**: agent searches for "payments-svc retry policy", gets zero
hits, reasons from scratch; next session a different agent repeats it. There's
no record that "we checked here, the team has no policy — don't re-search for
14 days."

```bash
loreguard absent record "payments-svc retry policy" --reason "team has no policy yet; ad hoc per incident"
loreguard absent record "auth/sso" --reason "covered by platform's IdP" --repo payments-svc
loreguard absent list                       # active markers
loreguard absent list --include-expired     # everything including aged-out
```

> **MCP-side `record_absence` is off by default** because it writes
> retrieval-affecting state without human review. The CLI `loreguard absent
> record` is the v0.1 default path — agents surface the gap, humans record the
> marker. Set `LOREGUARD_ALLOW_MCP_ABSENCE=1` to let agents write directly.

**Markers self-expire** (default 14 days, max 365) so stale "we checked"
claims age out rather than becoming permanent dead-ends. Query normalisation
is order-independent and case-insensitive: `"retry policy payments-svc"` and
`"payments-svc Retry POLICY"` share a marker, but `"backoff strategy"` is a
separate (deliberately unsynonymised) gap.

## Stats — local read tracking

`loreguard stats` answers "is loreguard earning its keep?" without sending
anything off-box. Aggregate-only against the existing `events` table:

```bash
loreguard stats                       # value headline + top-cited + retire candidates + activity
loreguard stats --top 20              # broader top-cited list
loreguard stats --retire              # retirement-candidate list only
loreguard stats --since-days 30       # window override for top + activity
loreguard stats --quiet-for-days 90   # window for retire-candidate detection
loreguard stats --json                # machine-readable output
```

- **Value headline** — retrievals + distinct records cited + an estimate of
  reviewed summary text *served* into agent context over the window.
- **Top-cited records** — sorted by `read` event count in the last N days (a
  `read` is emitted by `searchLore` per hit and `getLore` per fetch).
- **Retirement candidates** — active records with zero reads in the past N
  days (default 180), cheapest-to-retire first (no-source before sourced,
  ascending confidence, oldest `updated_at`).
- **Recent activity** — event-kind histogram for the window.

**Local-only by construction.** Read tracking writes to your SQLite `events`
table on the same machine — *no data leaves the box*. Turn it off with
`LOREGUARD_NO_TELEMETRY=1` (dedicated off-switch) or `LOREGUARD_AUDIT_OFF=1`
(silences both MCP audit and read events). `loreguard doctor` shows whether
tracking is on.

> Read events record `lore_id` + `kind: 'read'` + `ts` only — not the query,
> not the agent, not who you are. The audit log (`~/.loreguard/audit.jsonl`)
> is separate and may include query text. Both stay local.

## Digest — the maintenance backlog

`loreguard digest` rolls up everything needing a human decision — open
conflicts, pending drafts, stale-but-active records, retirement candidates,
and pending boundary edges — into one list with a call-to-action each.

```bash
loreguard digest                       # the "what needs attention?" roll-up
loreguard digest --json
```

## Prune — keep the local DB tidy

Read tracking is cheap per-event but unbounded over time. `loreguard prune` is
the local-DB GC:

```bash
loreguard prune                              # delete read events > 90 days + expired markers
loreguard prune --read-events-older-than 30  # tighter window
loreguard prune --vacuum                     # also reclaim disk after deletes
loreguard prune --dry-run                    # report counts, write nothing
```

Only `kind = 'read'` events are deleted — the lifecycle chain
(`created / approved / rejected / deprecated / superseded / updated /
imported`) is never touched, so the audit history stays intact.

## Inspect / back up your lore — `loreguard export`

```bash
loreguard export                              # stdout, active + non-restricted
loreguard export --out lore-backup.json       # file (mode 0600)
loreguard export --include-drafts --include-deprecated --include-superseded --include-restricted --out full.json
loreguard export --html --out docs/lore.html  # self-contained browsable page (see cross-repo.md)
```

Envelope: `{ schemaVersion: 1, exportedAt, records: [Lore, ...] }`. Stable
ordering by `updatedAt desc` with an `id asc` tiebreak — two exports of the
same DB diff cleanly.
