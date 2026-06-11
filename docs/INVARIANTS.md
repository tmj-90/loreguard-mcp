# Trust invariants — and the tests that enforce them

Loreguard's value rests on a handful of guarantees that hold *in code*, not
just in prose. Each one below is enforced by an explicit, named test, so a
regression breaks CI rather than silently weakening the trust model. Run them
with `pnpm test`.

| Invariant | Why it matters | Enforcing test |
|---|---|---|
| **Agents cannot approve their own memory.** The MCP server exposes exactly seven tools — none of which approves, deprecates, or supersedes. | This is the poisoning-prevention guard: an agent can suggest, but only a human (via the CLI) ratifies. | `test/mcp-server.test.ts` → *"exposes exactly the seven loreguard tools"* |
| **Agent suggestions cannot claim `high` confidence.** Drafts clamp to `medium` even when the caller asks for `high`. | Stops a confident-sounding agent from minting high-trust records. | `test/lore.test.ts` → *"agent suggestions cannot claim high confidence; clamps to medium"*; `test/mcp-server.test.ts` → *"clamps a draft's confidence below high even when asked"* |
| **No `high` confidence without a `source`.** A sourceless high claim is clamped to `medium`, at write *and* on update. | `high` should mean "backed by a PR/ADR/incident you can check." | `test/lore.test.ts` → *"a high-confidence claim without a source is clamped to medium"*, *"re-clamps confidence on update (sourceless → high downgraded)"* |
| **Drafts are hidden from default search** until a human approves. | Unreviewed agent material never masquerades as canonical. | `test/lore.test.ts` → *"excludes drafts by default"*; `test/mcp-server.test.ts` → *"creates a draft hidden from default search until approved"* |
| **Restricted records are excluded** from search/get unless `LOREGUARD_ALLOW_RESTRICTED_MCP=1`; a gated-off `get_lore` returns an id-only refusal (no title/body). | Default-safe retrieval; opt-in to sensitive records. | `test/lore.test.ts` → *"excludes restricted by default"*; `test/mcp-server.test.ts` → *"excludes restricted records unless the env gate is set"*, *"redacts a restricted record when the gate is off (id only, no body)"* |
| **Agents cannot challenge restricted records.** `report_conflict` is refused on a restricted target even with the gate on. | Agents may read restricted records but never draft counter-claims against them. | `test/mcp-server.test.ts` → *"refuses to challenge a restricted record (even with the gate on)"* |
| **Credential-shaped bodies are refused** on the write path; nothing is stored, and there's no agent-facing override. | Keeps live secrets out of records that get pasted into context and committed via sync. | `test/mcp-server.test.ts` → *"credential-shaped body → secret_detected, record NOT stored"*; `test/secrets.test.ts` |
| **The audit log never contains record bodies.** Sanitised pre-write; an error row carries the message but no body. | The audit records *that* something happened, not its contents. | `test/audit.test.ts` → *"does not contain the body…"*, *"never writes a key called 'body'…"*, *"an `error` audit row carries the message but never a body"* |
| **Boundary edges land as drafts**, invisible to the map until ratified. | Same trust gate as lore — agents can't silently fill the architecture map with guesses. | `test/mcp-server.test.ts` → *"declare_boundary lands a draft, invisible to find_dependents until approved"* |
| **Stale records are demoted, not hidden.** A lapsed `reviewAfter` flags `stale: true` and ranks below a fresh near-tie. | Old records stay findable but lose authority. | `test/lore.test.ts` → *"demotes a stale record below a fresh near-tie"*, *"treats a lapsed review_after as stale (demote)"* |
| **The shareable HTML export excludes restricted records** even with `--include-restricted`. | The committable/publishable artifact can't leak restricted content. | `test/cli.test.ts` → *"export --html excludes restricted records…"* |
| **Display-only queries don't pollute read-tracking.** `relatedLore` (applicable-lore beside an impact map) records no `read` events. | Keeps the `stats`/retirement signals honest. | `test/lore.test.ts` → *"does NOT record read events (display query must not inflate stats)"* |

If you're evaluating loreguard, these are the lines worth reading first — the
trust model is only as good as the tests that hold it in place.
