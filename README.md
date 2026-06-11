# loreguard

[![ci](https://github.com/tmj-90/loreguard-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/tmj-90/loreguard-mcp/actions/workflows/ci.yml)

> **Team-ratified knowledge for AI coding agents.**
> Memory says *what one session believes*; loreguard says *what the team has
> reviewed and approved*. Local SQLite-backed MCP server + CLI.

Most agent-memory tools store what an individual session learned — which is
also the failure mode: a confident agent recites something it inferred once
and got wrong. **Loreguard is the opposite primitive** — the shared record of
conventions, decisions, deprecated patterns, gotchas, and incident lessons a
team has *ratified*. Agents suggest; humans approve; the team gets one trusted
record per topic instead of N parallel beliefs.

`CLAUDE.md` is always-on context (every prompt pays for it). **`loreguard` is
just-in-time, team-ratified context** — agents call `search_lore` only when a
task warrants it, and get a compact summary of what the team already decided
instead of reasoning from scratch.

### The loop, concretely

```text
You:    "Add password hashing to the signup flow."
Claude: <search_lore("password hashing")>
        → "Argon2id is the default (bcrypt deprecated after 2025-INC-411),
           m=64MB t=3 p=4. [active, high confidence, sourced ADR]"
        Implements Argon2id instead of the bcrypt it would have reached for.
        <suggest_lore("signup uses the shared hashPassword() helper")>  # draft
You:    loreguard review     # approve the keeper, reject the noise — you're the gate
```

Without loreguard, the agent re-derives "which hash?" from scratch and may
reintroduce the very pattern an incident already retired. The win is the
mistake that *didn't* happen; the cost is one human review keystroke.

---

## Quickstart

```bash
npm i -g loreguard-mcp
loreguard quickstart          # init + seed a demo set + a live search hit
```

`quickstart` is the fastest way to see it work. It puts two binaries on your
`$PATH`: `loreguard` (the human CLI) and `loreguard-mcp` (the MCP server your
agents connect to). Node 20+, ESM, ships a prebuilt `better-sqlite3` — no
compiler needed on common platforms.

Then wire it to Claude Code in one idempotent command:

```bash
loreguard setup               # registers the MCP server + adds the retrieval
                              # rule to CLAUDE.md + installs the onboard skill
```

After that, use is **ambient** — just talk to Claude about the repo:

```text
You:    "What's the convention for password hashing here?"
Claude: <calls search_lore("password hashing"); answers from the result>
```

No slash command, no manual tool call. (`loreguard setup --dry-run` previews;
`--claude-md user` targets the global CLAUDE.md.)

**Not on Claude Code?** It's a plain stdio MCP server — Cursor, Windsurf,
Continue, and any MCP client work the same way. See
[`docs/clients.md`](docs/clients.md), and use `loreguard
print-claude-instructions --format cursor|windsurf|generic` for the rule.

→ Full workflow (onboarding a real repo, the review queue, hooks):
[`docs/guide.md`](docs/guide.md).

## The seven MCP tools

The surface is intentionally narrow. Agents can **read, suggest, challenge,
flag gaps, and map boundaries** — but **approval, deprecation, and
supersession are CLI-only.** Agents cannot promote their own suggestions; the
server exposes no approval tool. That's the poisoning-prevention guard.

| Tool | What the agent does |
|---|---|
| `search_lore` | retrieve brief, trust-ranked summaries |
| `get_lore` | fetch the full body of one record |
| `suggest_lore` | propose a new record — lands as a **draft** |
| `report_conflict` | challenge an active record — drafts a counter, never mutates the original |
| `record_absence` | mark a confirmed gap so it isn't re-discovered (off by default over MCP) |
| `find_dependents` | cross-repo blast radius **+ the rules that govern a contract** |
| `declare_boundary` | record a provides/consumes edge — lands as a **draft** |

→ Full parameters, response shapes, and error contracts:
[`docs/tools.md`](docs/tools.md).

## Tell your agent when to use lore

Installing the server only exposes the tools. To make agents use them, add a
short retrieval rule to your agent instructions (`loreguard
print-claude-instructions` emits it; `loreguard setup` appends it for you):

```md
Before non-trivial or context-sensitive code changes, search `lore` for
relevant local memory.

Search when the task touches: auth/security · dates/timezones ·
migrations/schema · payments/billing · API contracts · deployment/infra ·
cross-repo conventions · unfamiliar services.

Prefer records that are `active`, scoped to the current repo/team/tag, not
stale, medium/high confidence, and backed by a source. Treat stale, low-
confidence, source-less, deprecated, or conflicting records as clues, not
authority. Only call `get_lore` when the summary is not enough. At the end,
call `suggest_lore` only for a reusable convention/gotcha/decision worth
keeping — never task state or speculation.
```

## What deserves lore?

Small and high-signal. The review-gated draft flow exists to keep it that way.

**Good:** project-specific conventions · architectural decisions (the *why*) ·
deprecated patterns · migration rules · recurring gotchas · incident lessons ·
security-sensitive coding rules (**excluding secrets**) · cross-repo knowledge
agents keep rediscovering.

**Bad:** secrets / credentials (use a secrets manager) · regulated data ·
transient task state · generic advice the model already knows · unverified
agent guesses · facts obvious from a nearby README · always-on preferences
(those go in `CLAUDE.md`).

When in doubt: *would a future teammate, six months from now, thank me for
finding this?*

## Why not just CLAUDE.md? Or generic memory?

| | What it is | Trust source |
|---|---|---|
| `CLAUDE.md` | Always-on instructions, paid on every prompt | You wrote it |
| Generic agent memory | Cross-session recall of *what one session inferred* | A single session believed it |
| `loreguard` | On-demand retrieval of *what the team reviewed and approved* | A human ratified it via `loreguard review` |

All three can store "Use Argon2id, not bcrypt." The difference is whether a
future agent should trust it without checking, and whether two agents working
in parallel see the same answer. That distinction matters most under
*disagreement*: if memory says X and the code says NOT X, the agent has no
anchor; if loreguard says X, it has a ratified record to flag the conflict
against — and a path (`report_conflict` → human review) to update it.

Rule of thumb: applies every session → `CLAUDE.md`. One user's preference →
agent memory. A *team* should agree on it across repos and sessions →
loreguard. **Sharpest cut: reach for loreguard when *wrong* memory would cause
real project damage** — auth, payments, migrations, cross-repo contracts,
incident lessons. If a bad recollection is merely mildly annoying, it probably
isn't lore.

## Trust model

Every record carries lifecycle + provenance metadata so retrieval is honest:

| Field | Meaning |
|-------|---------|
| `status` | `draft` (agent, awaiting review) · `active` (canonical) · `deprecated` · `superseded` |
| `source` | URL: PR / ADR / incident / ticket. Sourceless records are lower-trust. |
| `confidence` | `low` \| `medium` \| `high`. *Agent-suggested or sourceless records cannot be `high` — enforced at write time.* |
| `reviewAfter` | ISO date; if past, search flags `stale: true`. |
| `restricted` | Excluded from search by default; MCP access env-gated. A retrieval guard, **not** DLP. |
| `lastVerifiedAt` | Bumped by `loreguard verify <id>`. |

These aren't just prose — each guarantee (agents can't approve, drafts hidden,
sourceless can't be `high`, restricted gated, audit excludes bodies, …) is
pinned to an explicit test. See
[`docs/INVARIANTS.md`](docs/INVARIANTS.md).

## What else it does

Loreguard is local-first by design — no server, no network calls, git is the
sharing/trust mechanism. Beyond the core retrieve/suggest/review loop:

- **Cross-repo architecture map** — `loreguard impact <contract>` shows the
  blast radius *and* the rules that govern it; `graph` walks it transitively
  (multi-hop), `discover` bootstraps it from code, and `estate` rolls every
  team's map into one org-wide, PR-diffable view. →
  [`docs/cross-repo.md`](docs/cross-repo.md)
- **Team sync** — commit `.loreguard/` to the repo; the PR review is the trust
  gate. → [`docs/operations.md`](docs/operations.md#team-sync--markdown-round-trip)
- **Maintenance & insight** — `digest` (the review backlog), `stats` (is it
  earning its keep?), `absent` (don't re-discover the same nothing), `prune`
  (local-DB GC), `doctor` (health check). →
  [`docs/operations.md`](docs/operations.md)
- **Where it's headed** — [`ROADMAP.md`](ROADMAP.md).

## Develop from source

```bash
git clone https://github.com/tmj-90/loreguard-mcp.git
cd loreguard-mcp && pnpm install && pnpm build
npm link                      # puts loreguard + loreguard-mcp on your $PATH
loreguard init
```

`pnpm test` runs the suite; `pnpm typecheck` the types. If you'd rather not
`npm link`, reference the absolute path in `claude mcp add` and invoke the CLI
as `node /absolute/path/to/dist/bin/loreguard.js …`.

## Security

The server uses **stdio transport only — no network listener, ever**, and
makes no outbound HTTP calls. The DB is a local file (mode `0600`); the audit
log (`~/.loreguard/audit.jsonl`) records MCP tool calls with request args and
result *ids*, never result bodies.

**Protects against:** accidental over-sharing (drafts + `restricted` hidden by
default, MCP env-gated) · stale/unreviewed memory dominating retrieval
(`stale` flag, lifecycle filtering, agent writes land as drafts) · audit-log
body leakage (sanitised pre-write).

**Does not protect against:** a malicious local user with filesystem access ·
secrets intentionally added to lore (use a secrets manager) · your LLM
provider seeing content the agent retrieved (the standard AI trust boundary).

Data leaves your machine the moment the agent reads a tool result — it goes to
your LLM provider as part of the next prompt. For enterprise, use your
provider's Zero Data Retention plan. Full detail:
[`docs/SECURITY.md`](docs/SECURITY.md) · [`docs/DATA-FLOW.md`](docs/DATA-FLOW.md).

## License

MIT — see [`LICENSE`](LICENSE).
