# Cross-repo architecture map

The hardest question when you change a contract in one service is *who else
does this break?* Loreguard answers it with a **boundary map**: a team-
ratified record of which repos `provides` (own / produce) and which
`consumes` (depend on) each contract — an event, HTTP endpoint, queue, DB
table, or RPC method.

```bash
# Declare edges (human, lands active):
loreguard boundary add orders-svc    "OrderSubmitted" provides --kind event \
  --detail "v2 adds customerTier"
loreguard boundary add reporting-svc "order-submitted" consumes --kind event
loreguard boundary add billing-svc   "order_submitted" consumes

# The headline query — before you change a contract, see the blast radius:
loreguard impact OrderSubmitted
#   Providers (own / produce it): 1
#     orders-svc     provides  order-submitted (event)
#   Consumers (depend on it — blast radius): 2
#     billing-svc    consumes  order-submitted
#     reporting-svc  consumes  order-submitted
```

Contract names are **normalised** so the cross-repo join actually connects:
`OrderSubmitted`, `order-submitted`, and `order_submitted` all resolve to one
contract. Path- and dotted-style names (`POST /v1/orders`, `orders.submitted`)
are preserved.

**Cross-repo by aggregation, not by a server.** Each repo exports its edges
to `.loreguard/boundaries.jsonl` (alongside the lore `.md` files) on
`loreguard sync export`; `loreguard sync pull <parent>` walks every repo under
a directory and merges their maps into your local DB — so one machine working
across N repos sees the whole graph. No daemon, no network.

**Same trust gate as lore.** Agents `declare_boundary` over MCP and the edge
lands as a **draft**; a human ratifies it:

```bash
loreguard boundary review          # triage draft edges: [a]pprove [r]eject [s]kip
loreguard boundary list            # active edges (--include-drafts / --include-deprecated)
loreguard boundary approve <id>
loreguard boundary deprecate <id>  # retire an edge without losing the history
```

An agent should call `find_dependents` **before** editing a cross-repo
contract and `declare_boundary` when it discovers a producer/consumer
relationship that isn't on the map yet. An empty `impact` result is not proof
a change is safe — only that the map doesn't cover it yet.

## Who's affected *and* what must I respect?

Both `loreguard impact <contract>` and the `find_dependents` MCP tool return
an **applicable-lore** list alongside the providers/consumers — the team
rules that govern that contract, matched by tag link and a precise word-token
search (so `order-submitted` surfaces the "must carry a timezone offset"
record but not every record that merely mentions "orders"):

```
Applicable lore (rules for this contract): 1
  rhzcnx29  order-submitted must include a timezone offset
    naive timestamps on order events caused INC-411
```

This is where the two halves of loreguard fuse: the blast radius
(architecture) and the policy (curated memory) come back in one answer.

## Repo-level, multi-hop view — `loreguard graph`

`impact` answers one hop (direct providers/consumers of one contract).
`graph` lifts the edges into a repo dependency graph and walks it
transitively:

```bash
loreguard graph                 # the whole map: who depends on / is used by whom
loreguard graph orders-svc      # one repo's full blast radius
#   Downstream (affected if you change orders-svc): 3
#     · billing-svc    (orders-svc → billing-svc)
#     · reporting-svc  (orders-svc → reporting-svc)
#     ·· finance-svc   (orders-svc → reporting-svc → finance-svc)   ← 2 hops
#   Upstream (orders-svc depends on): 0
```

`finance-svc` shows up even though it never touches `order-submitted` — it
consumes `reporting-svc`'s rollups, which depend on it. That transitive reach
is the "what actually breaks" answer a one-hop check can't give.

## Bootstrap the map — `loreguard discover`

Hand-declaring every edge is the tax that keeps the map empty, so `discover`
statically scans a repo's source for high-signal contract patterns — HTTP
routes (provides), pub/sub topics (publish = provides, subscribe = consumes),
queue consumers — and proposes edges with `file:line` evidence:

```bash
loreguard discover                  # dry-run: list candidates, write nothing
loreguard discover --write          # add them as DRAFTS for review
loreguard boundary review           # ratify / reject, same gate as always
```

It **proposes, it doesn't decide**: candidates land as drafts and go through
the normal review gate — never auto-activated. Coverage is a deliberately
curated, low-false-positive subset (JS/TS, Python, JVM, common libraries),
not an exhaustive parser; treat the output as a checklist to verify against
the code, and hand-declare anything your stack hides.

Candidates are **confidence-tiered**: unambiguous framework constructs (route
definitions, `@KafkaListener`) are `high-signal` and sort first; generic
method names (`.publish`, `.subscribe`) are flagged `review` so you scrutinise
the fuzzier ones rather than rubber-stamping everything.

Discovery also shows the **join moment** — when a candidate connects to an
edge already in the map (from this repo or, after `sync pull`, another), it's
flagged inline:

```
finance-svc consumes daily-rollup   ↔ provided by reporting-svc
```

so a pile of per-repo edges visibly wires itself into one graph.

## Find the holes — `loreguard graph --gaps`

The map's most useful warning is asymmetry:

```bash
loreguard graph --gaps
#   Dangling consumers (depended on, but no provider in the map):
#     stripe-charge-api  ← app-svc          # a missing owner, or an external dep
#   Orphan providers (owned, but nothing in the map consumes them):
#     internal-metric    → orders-svc        # dead, or consumers not yet onboarded
```

A **dangling consumer** is the signal to chase: someone depends on a contract
nobody in the map is shown to own — either a `provides` edge you haven't
captured yet (run `discover` / `sync pull` on the owning repo) or a genuinely
external dependency worth labelling.

## Commit the map as a manifest — `loreguard graph --manifest`

Emits a deterministic, **timestamp-free** JSON snapshot
(`{ schemaVersion, repos, deps, gaps }`) to commit as
`.loreguard/architecture.json`. Because it only changes when the architecture
changes, a PR diff — or CI running `loreguard graph --manifest --out
.loreguard/architecture.json && git diff --exit-code` — turns a removed
provider edge or a newly-dangling consumer into a reviewable signal.

## The org-wide estate — `loreguard estate`

The enterprise rollup is **a git repo + CI, not a server.** `loreguard estate
<parent> --out-dir site/` aggregates every team's committed `.loreguard/`
under `<parent>` into one map, writes `site/index.html` (the browsable org-
wide graph + records) and `site/architecture.json` (the PR-diffable
manifest), and reports the **estate-wide dangling consumers** — a team
depending on a contract no team owns is the single most valuable cross-team
signal.

```bash
loreguard estate init --out-dir my-estate-repo   # scaffold the CI repo
# → a GitHub Action (checkout member repos → aggregate → publish to Pages),
#   a repos list, and a README. Fill the list, add a read token, enable Pages.
```

Git is the auth, the audit log, and the review gate; nothing runs a server or
touches the network. In CI, point `LOREGUARD_DB` at a repo-local file so each
run rebuilds the estate reproducibly from a fresh checkout. See
[`../ROADMAP.md`](../ROADMAP.md) for the full estate epic.

## A browsable, committable view — `loreguard export --html`

`loreguard export --html --out docs/lore.html` writes a **single self-
contained HTML file**: the architecture graph as an inline SVG plus every
record as a client-side-filterable card with its trust badges. No server, no
network, no external scripts — it renders offline and from `file://`, so you
can commit it as living documentation or publish it via GitHub Pages.
Restricted records are excluded; it's safe to share. (This is the deliberate
alternative to a web UI — a generated artifact, not a daemon.)
