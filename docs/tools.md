# MCP tool reference

The `loreguard-mcp` server exposes seven tools. The surface is intentionally
narrow: agents can **read, suggest, challenge, flag known gaps, and map
cross-repo boundaries** — but **approval, deprecation, and supersession are
CLI-only.** Agents cannot promote their own suggestions.

| Tool | Agent can | Notes |
|---|---|---|
| `search_lore` | read | brief summaries, trust-ranked |
| `get_lore` | read | full body of one record |
| `suggest_lore` | propose | creates a **draft** |
| `report_conflict` | challenge | drafts a counter-record; never mutates the original |
| `record_absence` | flag a gap | off by default over MCP |
| `find_dependents` | read | cross-repo blast radius + applicable lore |
| `declare_boundary` | propose | edge lands as a **draft** |

## `search_lore({ query, repo?, tag?, prefix?, match?, updatedAfter?, includeDrafts?, includeDeprecated?, includeSuperseded?, includeRestricted?, limit? })`

Returns brief summaries. `tag` accepts a string or `string[]` (ANY-of);
`prefix: true` matches 3+ char tokens as prefixes; `match: "all"` requires
every query word (default `"any"` ORs them), and `"quoted phrases"` match
adjacency.

Hits are ranked by relevance **adjusted for trust** (sourced / higher-
confidence / non-stale records win near-ties). When more records match than
were returned, the response carries `truncated: { shown, total, hint }` so
the agent narrows rather than assuming the top page is the whole story. When
the query has **zero hits** and a matching active **absence marker** exists,
the response includes `absence_marker: { reason, recordedAt, expiresAt }` so
the next agent sees "we checked, known gap" rather than re-discovering
nothing.

MCP results omit the CLI-only conflict hints — surfacing that heuristic to an
LLM tends to cost more tokens than it earns. `loreguard search` still shows
them for human triage.

## `get_lore({ id })`

Full body of one record. Restricted ids return a minimal refusal unless
`LOREGUARD_ALLOW_RESTRICTED_MCP=1`.

## `suggest_lore({ title, summary, body, repos?, tags?, source?, confidence?, team? })`

Agent creates a draft; response includes `{ id, status, message,
possibleDuplicates, restrictedDuplicateCount }` (up to 3 similar non-
restricted records with a `reason` signal summary, plus a redacted count for
matching restricted records — hints only, never blocks).

Over-cap inputs (`title > 200`, `summary > 800`) return a **structured
error** `{ error, provided, max, suggested_cut, hint }` instead of an opaque
zod failure — the agent pastes `suggested_cut` back as a corrected retry.
Body length is uncapped (fetched on demand via `get_lore`). A credential-
shaped body is refused with `{ error: "secret_detected", ... }` — there is no
agent-facing override.

## `report_conflict({ existingId, observation, source?, repos?, tags? })`

The agent has found code (or other evidence) contradicting an existing
**active** record. Creates a DRAFT counter-record tagged `conflict-report`,
linked back via `conflictsWith: [existingId]`, surfaced in the normal review
queue. The original record is **never mutated**; the reviewer resolves via
`supersede` / `update` / `reject` against the counter. **Restricted records
are unconditionally refused** — agents can read them (when gated on) but never
draft counters against them. See
[`docs/adr/ADR-003-conflict-records-shape.md`](adr/ADR-003-conflict-records-shape.md).

## `record_absence({ query, reason, repo?, expiresInDays? })`

The agent searched, found nothing, AND confirmed the gap is real and durable.
Records a **self-expiring** marker (default 14 days; max 365) so the next
`search_lore` on the same normalised query surfaces the marker instead of
returning empty again. **MCP access is off by default**
(`LOREGUARD_ALLOW_MCP_ABSENCE=1` to enable); the CLI `loreguard absent record`
always works, so the default flow is "agent surfaces the gap → human records
the marker." When enabled, don't auto-call on every zero-hit search — only
when the absence is itself the finding.

## `find_dependents({ contract })`

The cross-repo impact check. Returns who `provides` and who `consumes` a
contract (event, endpoint, queue, table, RPC) — the `consumers` list is the
blast radius — **plus `applicableLore`**, the team rules that govern the
contract. Call it **before** editing a cross-repo contract. Contract names
are normalised (camelCase / kebab / snake converge). An empty result is not
proof of safety — only that the map is incomplete. See
[`cross-repo.md`](cross-repo.md).

## `declare_boundary({ repo, contract, role, kind?, detail?, source? })`

Agent records that a repo `provides` or `consumes` a contract. Lands as a
**DRAFT** (invisible to the default map until a human runs `loreguard
boundary approve <id>`) — same trust gate as `suggest_lore`. Re-declaring the
same `(repo, contract, role)` updates in place.
