/**
 * Architecture graph — the repo-level "brain" derived from boundary edges.
 *
 * `boundaries` records contract-level facts: repo R `provides` or `consumes`
 * contract C. This module lifts those into the question teams actually ask:
 * **which repos depend on which, and what's the full blast radius if I
 * change one?**
 *
 * Dependency direction: if `consumes(R1, C)` and `provides(R2, C)`, then R1
 * DEPENDS ON R2 — R1 is downstream, R2 is upstream. Aggregated across every
 * shared contract, the edges form a directed graph. `downstreamRepos` walks
 * it transitively (multi-hop) so "change order-submitted in orders-svc" can
 * surface not just reporting-svc (direct consumer) but finance-svc that
 * consumes reporting-svc's rollups in turn.
 *
 * Active edges only by default — same trust posture as the rest of the map;
 * unreviewed drafts aren't authoritative architecture.
 */
import type { Database } from "better-sqlite3";

import { listBoundaries } from "./boundaries.js";

/** A directed "depends on" edge between two repos, with the contracts that justify it. */
export interface RepoDep {
  /** The consumer — the repo that depends on `to`. */
  readonly from: string;
  /** The provider — the repo `from` depends on. */
  readonly to: string;
  /** Contract names that create this dependency (sorted, deduped). */
  readonly contracts: string[];
}

export interface RepoGraph {
  /** Every repo that appears in at least one edge, sorted. */
  readonly repos: string[];
  /** Directed dependency edges (consumer → provider), sorted by from,to. */
  readonly deps: RepoDep[];
}

interface GraphOpts {
  readonly includeDrafts?: boolean;
}

/**
 * Build the repo dependency graph from the boundary map. For each contract,
 * every (consumer, provider) pair becomes a `from → to` dependency, with the
 * contract attributed to it. Self-edges (a repo that both provides and
 * consumes the same contract) are dropped — a repo doesn't depend on itself.
 */
export function buildRepoGraph(db: Database, opts: GraphOpts = {}): RepoGraph {
  const edges = listBoundaries(db, { includeDrafts: opts.includeDrafts });
  // contract → { providers:Set, consumers:Set }
  const byContract = new Map<
    string,
    { providers: Set<string>; consumers: Set<string> }
  >();
  const repos = new Set<string>();
  for (const e of edges) {
    repos.add(e.repo);
    let entry = byContract.get(e.contract);
    if (!entry) {
      entry = { providers: new Set(), consumers: new Set() };
      byContract.set(e.contract, entry);
    }
    if (e.role === "provides") entry.providers.add(e.repo);
    else entry.consumers.add(e.repo);
  }
  // (from,to) → contracts
  const depMap = new Map<string, Set<string>>();
  for (const [contract, { providers, consumers }] of byContract) {
    for (const consumer of consumers) {
      for (const provider of providers) {
        if (consumer === provider) continue;
        const key = `${consumer}\x00${provider}`;
        let set = depMap.get(key);
        if (!set) {
          set = new Set();
          depMap.set(key, set);
        }
        set.add(contract);
      }
    }
  }
  const deps: RepoDep[] = Array.from(depMap.entries())
    .map(([key, contracts]) => {
      const [from, to] = key.split("\x00") as [string, string];
      return { from, to, contracts: Array.from(contracts).sort() };
    })
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return { repos: Array.from(repos).sort(), deps };
}

/** A repo reached by transitive traversal, with the shortest path to it. */
export interface ReachableRepo {
  readonly repo: string;
  /** Hops from the start repo. 1 = direct neighbour. */
  readonly hops: number;
  /** Shortest path of repos from the start (inclusive) to this repo. */
  readonly path: string[];
}

/**
 * Generic BFS over an adjacency map. Returns every reachable node (excluding
 * the start) with its shortest hop-count and path. Cycle-safe via a visited
 * set; ordered by hops then repo name for stable output.
 */
function traverse(
  start: string,
  adjacency: Map<string, Set<string>>,
): ReachableRepo[] {
  const out: ReachableRepo[] = [];
  const visited = new Set<string>([start]);
  let frontier: Array<{ repo: string; path: string[] }> = [
    { repo: start, path: [start] },
  ];
  let hops = 0;
  while (frontier.length > 0) {
    hops++;
    const next: Array<{ repo: string; path: string[] }> = [];
    for (const node of frontier) {
      for (const neighbour of adjacency.get(node.repo) ?? []) {
        if (visited.has(neighbour)) continue;
        visited.add(neighbour);
        const path = [...node.path, neighbour];
        out.push({ repo: neighbour, hops, path });
        next.push({ repo: neighbour, path });
      }
    }
    frontier = next;
  }
  return out.sort((a, b) => a.hops - b.hops || a.repo.localeCompare(b.repo));
}

/**
 * Repos transitively DOWNSTREAM of `repo` — everyone who depends on it,
 * directly or via a chain. This is the blast radius: change something `repo`
 * provides and these are the repos that can break. Walks dependency edges in
 * reverse (provider → consumer).
 */
export function downstreamRepos(
  db: Database,
  repo: string,
  opts: GraphOpts = {},
): ReachableRepo[] {
  const { deps } = buildRepoGraph(db, opts);
  // reverse adjacency: provider → its consumers
  const adj = new Map<string, Set<string>>();
  for (const d of deps) {
    let set = adj.get(d.to);
    if (!set) {
      set = new Set();
      adj.set(d.to, set);
    }
    set.add(d.from);
  }
  return traverse(repo, adj);
}

/**
 * Repos `repo` transitively DEPENDS ON — everything upstream of it. Walks
 * dependency edges forward (consumer → provider).
 */
export function upstreamRepos(
  db: Database,
  repo: string,
  opts: GraphOpts = {},
): ReachableRepo[] {
  const { deps } = buildRepoGraph(db, opts);
  const adj = new Map<string, Set<string>>();
  for (const d of deps) {
    let set = adj.get(d.from);
    if (!set) {
      set = new Set();
      adj.set(d.from, set);
    }
    set.add(d.to);
  }
  return traverse(repo, adj);
}
