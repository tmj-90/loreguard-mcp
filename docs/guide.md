# Guide — onboarding a repo and day-to-day use

This is the full workflow detail. For the 60-second version, see the
[README](../README.md).

## Try it on demo data first

`loreguard demo` seeds five illustrative records (tagged `demo`) so you can
explore the workflow without authoring content first:

```bash
loreguard init
loreguard demo               # five demo records, one a draft, one stale
loreguard list               # see what was added
loreguard search timezone    # the dates/timezone gotcha; flagged stale
loreguard search Argon2id    # high-confidence sourced decision
loreguard review             # interactive triage of the draft
loreguard show <id>          # full body of any record
loreguard demo --clean       # removes only records tagged 'demo'
```

`loreguard demo` refuses to seed into a non-empty DB unless you pass
`--force`; `--clean` only deletes demo-tagged rows, so it won't touch real
content. (`loreguard quickstart` does init + demo + a live search in one
step — the fastest first look.)

## Onboard a real repo

The flow for pointing loreguard at a **real** codebase so agents have useful
local memory the next time they touch it:

```bash
cd ~/code/payments-svc

# 1. Cold-start: let the agent read the repo and propose drafts.
#    In Claude Code (with the loreguard MCP server configured):
/loreguard-onboard

# 2. Triage the drafts.
loreguard review                       # [a]pprove / [r]eject / [e]dit / [s]kip / [q]uit

# 3. Teach the agent to actually call search_lore.
loreguard print-claude-instructions >> CLAUDE.md

# 4. (Optional) Commit team lore via PR review.
loreguard sync export .loreguard
git add .loreguard && git commit -m "seed loreguard"

# 5. (Optional) Make sure drafts don't rot.
loreguard hooks install                # opt-in Claude Stop-hook
```

### Step 1 — `/loreguard-onboard` (cold-start)

The bundled **`/loreguard-onboard` Claude skill** is the way to seed a repo.
It reads the repo first (README, ADRs, recent commits, deprecation markers,
in-flight migrations) and surfaces *repo-specific* candidate drafts grounded
in real source citations, then asks targeted follow-ups — rather than
inventing memory or chunking every bullet in your docs.

Why a skill and not a CLI scan: producing *good* lore needs judgement about
what's durable and non-obvious. An agent reading the actual code does that
well; a mechanical importer produces mostly noise (status trackers, TOC
bullets, roadmap items) that floods the review queue and degrades the trust
gate into "approve all." So the one cold-start path is the one that uses
judgement.

Install the skill (or run `loreguard setup`, which copies it for you):

```bash
mkdir -p ~/.claude/skills
cp -r skills/loreguard-onboard ~/.claude/skills/
```

Then, in Claude Code from inside the repo, run `/loreguard-onboard`. Every
record the skill produces lands as a **draft** and goes through
`loreguard review`. See
[`skills/loreguard-onboard/SKILL.md`](../skills/loreguard-onboard/SKILL.md)
for the full procedure.

Aim records at non-obvious, high-consequence knowledge (see
[What deserves lore?](#what-deserves-lore)); "we use TypeScript" goes in
`CLAUDE.md`, not here.

### Step 2 — `loreguard review` (triage drafts)

Drafts are hidden from default search until a human promotes them.
`loreguard review` walks the queue one record at a time with
[a]pprove / [r]eject / [e]dit / [s]kip / [q]uit keystrokes. The same queue
catches both your onboarding drafts and any drafts agents suggest later via
`suggest_lore` — single triage point, no separate "agent inbox."

When you reject a draft, the flow prompts for an optional **reason**. The
reason lands on the `rejected` event payload, so the agent that suggested it
(or future-you reading the audit chain) can see *why* it was dropped instead
of re-suggesting the same shape next session.

For scripted use:

```bash
loreguard approve <id>
loreguard reject <id> --reason "wrong scope — convention is per-repo, not org-wide"
loreguard review --list   # non-interactive overview
```

The full lifecycle:

```bash
loreguard deprecate <id>              # mark deprecated (still findable with a flag)
loreguard supersede <old> --with <new>
loreguard verify <id>                 # bump lastVerifiedAt and clear stale warning
loreguard update <id> ...             # edit fields
loreguard delete <id>                 # hard-delete (events row preserved)
```

This is the poisoning-prevention guard: **agents can suggest knowledge, but
only humans (via the CLI) can approve, reject, deprecate, or supersede.** The
MCP server deliberately exposes no approval tool.

### Step 3 — wire the agent

Installing the MCP server only exposes the tools; agents won't call
`search_lore` until your CLAUDE.md (or Cursor rules / agent skill) tells them
when to. `loreguard print-claude-instructions` prints a copy-pasteable
retrieval rule — append it to whichever file your agent reads at session
start. See the [README](../README.md#tell-your-agent-when-to-use-lore) for
the rule itself, and [`clients.md`](clients.md) for non-Claude editors.

### Step 4 — (optional) team sync via `.loreguard/`

If you want teammates to share the same lore, commit it to the repo with
`loreguard sync export .loreguard`. Teammates run `loreguard sync import
.loreguard`. The PR review *is* the trust gate. Full semantics in
[`operations.md`](operations.md#team-sync--markdown-round-trip).

### Step 5 — (optional) session-end nudge so drafts don't rot

The hardest failure mode in any team-memory tool isn't capture — it's the
queue of unreviewed drafts that quietly accumulates. `loreguard hooks
install` wires a Claude Code **Stop hook** so when Claude is about to end a
session it asks "there are N pending drafts — review now or leave for later?"
once per session.

```bash
loreguard hooks install                # writes .claude/settings.json (project-scope)
loreguard hooks install --dry-run      # preview the merge without writing
```

- Fires on Claude's `Stop` event. Zero pending drafts → silent pass.
- Drafts present and this session hasn't been nudged yet → emits a
  `{ decision: "block", reason: "...review now or leave for later..." }`
  once. Already nudged this session → silent pass. No nag loops.
- The per-session marker is a zero-byte file under
  `~/.loreguard/hooks/session-<id>.nudged`. Set
  `LOREGUARD_REVIEW_NUDGE_EVERY_TIME=1` to nudge every time.

Opt-in and project-scoped — it modifies `.claude/settings.json` in the
current directory, preserving other tools' hooks (additive + idempotent). To
turn it off, remove the corresponding `Stop` block.

## Add a note by hand

```bash
loreguard add        # interactive
```

Or with flags:

```bash
loreguard add \
  --title "We don't use bcrypt anymore" \
  --summary "Argon2id is the new default after the Platform security review." \
  --body "Reasoning: bcrypt's 72-byte truncation bit us in 2025-INC-411. \
Argon2id with m=64MB, t=3, p=4 is the new baseline." \
  --repo payments-svc --repo auth-svc \
  --tag security --tag passwords \
  --team Platform \
  --source https://github.com/org/platform-adrs/pull/14 \
  --confidence high \
  --review-after 2026-03-12
```

Records added by humans default to `status: active` — visible to search.

### Capture from a commit — `loreguard suggest --from-commit`

If you already wrote the rationale in a commit message, don't retype it:

```bash
loreguard suggest --from-commit HEAD
loreguard suggest --from-commit a4f12c0 --repo payments-svc --tag migrations
```

The commit subject becomes the draft title, the first body paragraph the
summary, and the full message the body. A commit permalink is auto-derived
from `remote.origin.url` and stored as the `source` (so the draft clears
`medium` confidence). Like every agent-shaped capture it lands as a
**draft**; promote it in `loreguard review`.

## What deserves lore?

Lore is most useful when it's small and high-signal. The review-gated draft
flow exists to keep it that way.

**Good lore:** project-specific conventions · architectural decisions (the
*why*) · deprecated patterns (what to use instead + the source PR) ·
migration rules · recurring gotchas · incident lessons · security-sensitive
coding rules (**excluding secrets**) · cross-repo knowledge agents keep
rediscovering.

**Bad lore:** secrets / credentials / keys (use a secrets manager) · personal
or regulated data · transient task state · generic programming advice the
model already knows · unverified agent guesses · facts obvious from a nearby
README or the code · always-on preferences (those belong in `CLAUDE.md`).

When in doubt: *would a future teammate, six months from now, thank me for
finding this?* If yes, it's lore.

> **What not to store:** don't put secrets, credentials, personal data, or
> anything your AI client should not receive in a prompt into lore.
> `loreguard` is a retrieval index, not a vault — retrieved records are sent
> to your LLM provider as part of the next prompt. The `restricted` flag
> hides records from default search and blocks `get_lore` over MCP (unless
> `LOREGUARD_ALLOW_RESTRICTED_MCP=1`), but it is **not** DLP.
