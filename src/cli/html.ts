/**
 * Static HTML export — `loreguard export --html`.
 *
 * Loreguard is local-first and network-free by principle, so the answer to
 * "can we have a UI?" is NOT a server: it's a single self-contained HTML
 * file you commit to the repo (or publish via GitHub Pages). It carries the
 * ratified lore as a client-side-filterable list AND the architecture graph
 * (from boundary edges) as an inline SVG — no external scripts, no fonts, no
 * network, so it renders identically offline and can't phone home.
 *
 * `renderHtml` is a pure function (data in, string out) for testability; the
 * CLI does the DB reads and file write.
 */
import type { Lore } from "../db/types.js";
import type { RepoGraph } from "../core/graph.js";

export interface HtmlModel {
  readonly lore: ReadonlyArray<Lore>;
  readonly graph: RepoGraph;
  /** ISO timestamp the export was generated. */
  readonly generatedAt: string;
}

/** Escape text for safe interpolation into HTML element content / attributes. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isStale(reviewAfter: string | undefined): boolean {
  if (!reviewAfter) return false;
  const t = Date.parse(reviewAfter);
  return !Number.isNaN(t) && t < Date.now();
}

// ── Architecture graph → inline SVG ───────────────────────────────────

/**
 * Assign each repo a layer = longest dependency chain beneath it. Pure
 * providers (depend on nothing) sit at layer 0 on the left; consumers fan
 * out to the right. Cycle-safe: a node currently on the recursion stack
 * contributes 0 so a dependency cycle can't loop forever.
 */
function layerByDepth(graph: RepoGraph): Map<string, number> {
  const dependsOn = new Map<string, string[]>();
  for (const r of graph.repos) dependsOn.set(r, []);
  for (const d of graph.deps) dependsOn.get(d.from)!.push(d.to);
  const layer = new Map<string, number>();
  const onStack = new Set<string>();
  const visit = (repo: string): number => {
    const cached = layer.get(repo);
    if (cached !== undefined) return cached;
    if (onStack.has(repo)) return 0; // cycle — break it
    onStack.add(repo);
    let max = 0;
    for (const dep of dependsOn.get(repo) ?? []) {
      max = Math.max(max, visit(dep) + 1);
    }
    onStack.delete(repo);
    layer.set(repo, max);
    return max;
  };
  for (const r of graph.repos) visit(r);
  return layer;
}

const NODE_W = 150;
const NODE_H = 34;
const COL_GAP = 90;
const ROW_GAP = 22;
const PAD = 24;

function renderGraphSvg(graph: RepoGraph): string {
  if (graph.repos.length === 0) {
    return `<p class="empty">No architecture edges yet. Declare them with <code>loreguard boundary add &lt;repo&gt; &lt;contract&gt; provides|consumes</code>.</p>`;
  }
  const layer = layerByDepth(graph);
  // Group repos by layer, stable order within a layer.
  const byLayer = new Map<number, string[]>();
  for (const r of graph.repos) {
    const l = layer.get(r)!;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(r);
  }
  const maxLayer = Math.max(...layer.values());
  const maxRows = Math.max(...Array.from(byLayer.values(), (a) => a.length));
  const pos = new Map<string, { x: number; y: number }>();
  for (const [l, repos] of byLayer) {
    repos.forEach((repo, i) => {
      pos.set(repo, {
        x: PAD + l * (NODE_W + COL_GAP),
        y: PAD + i * (NODE_H + ROW_GAP),
      });
    });
  }
  const width = PAD * 2 + (maxLayer + 1) * NODE_W + maxLayer * COL_GAP;
  const height = PAD * 2 + maxRows * NODE_H + (maxRows - 1) * ROW_GAP;

  // Edges: from consumer (higher layer, right) to provider (lower layer,
  // left). Draw consumer-left-edge → provider-right-edge, arrow at provider.
  const edgeSvg = graph.deps
    .map((d) => {
      const a = pos.get(d.from);
      const b = pos.get(d.to);
      if (!a || !b) return "";
      const x1 = a.x;
      const y1 = a.y + NODE_H / 2;
      const x2 = b.x + NODE_W;
      const y2 = b.y + NODE_H / 2;
      const mx = (x1 + x2) / 2;
      const title = `${esc(d.from)} depends on ${esc(d.to)} via ${esc(d.contracts.join(", "))}`;
      return `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" class="edge" marker-end="url(#arrow)"><title>${title}</title></path>`;
    })
    .join("");

  const nodeSvg = graph.repos
    .map((r) => {
      const p = pos.get(r)!;
      const label = r.length > 20 ? r.slice(0, 19) + "…" : r;
      return (
        `<g class="node" transform="translate(${p.x},${p.y})">` +
        `<rect width="${NODE_W}" height="${NODE_H}" rx="6"></rect>` +
        `<text x="${NODE_W / 2}" y="${NODE_H / 2 + 4}" text-anchor="middle">${esc(label)}<title>${esc(r)}</title></text>` +
        `</g>`
      );
    })
    .join("");

  return (
    `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Repo dependency graph">` +
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
    `<path d="M0,0 L10,5 L0,10 z" class="arrowhead"></path></marker></defs>` +
    edgeSvg +
    nodeSvg +
    `</svg>`
  );
}

// ── Lore records → cards ──────────────────────────────────────────────

function renderLoreCard(l: Lore): string {
  const stale = isStale(l.reviewAfter);
  const badges = [
    `<span class="badge status-${esc(l.status)}">${esc(l.status)}</span>`,
    `<span class="badge conf-${esc(l.confidence)}">${esc(l.confidence)}</span>`,
    stale ? `<span class="badge stale">stale</span>` : "",
    l.source ? "" : `<span class="badge nosrc">no source</span>`,
  ].join("");
  const tags = l.tags
    .map((t) => `<span class="tag">${esc(t)}</span>`)
    .join("");
  const repos = l.repos.length
    ? `<div class="meta">repos: ${l.repos.map((r) => esc(r)).join(", ")}</div>`
    : "";
  const src = l.source
    ? `<a class="src" href="${esc(l.source)}" rel="noreferrer noopener">source ↗</a>`
    : "";
  // Searchable haystack as a data attribute the client filter reads.
  const haystack = esc(
    [l.title, l.summary, l.body, l.tags.join(" "), l.repos.join(" ")]
      .join(" ")
      .toLowerCase(),
  );
  return (
    `<article class="card" data-status="${esc(l.status)}" data-haystack="${haystack}">` +
    `<header><h3>${esc(l.title)}</h3><div class="badges">${badges}</div></header>` +
    `<p class="summary">${esc(l.summary)}</p>` +
    (l.body && l.body !== l.summary
      ? `<details><summary>body</summary><pre>${esc(l.body)}</pre></details>`
      : "") +
    `<div class="tags">${tags}</div>` +
    repos +
    src +
    `</article>`
  );
}

const STYLE = `
:root{--bg:#0f1115;--panel:#171a21;--line:#2a2f3a;--fg:#e6e9ef;--mut:#9aa3b2;--accent:#5aa9e6}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header.top{padding:20px 24px;border-bottom:1px solid var(--line)}
header.top h1{margin:0 0 4px;font-size:20px}header.top .sub{color:var(--mut)}
main{padding:24px;max-width:1100px;margin:0 auto}
h2{border-bottom:1px solid var(--line);padding-bottom:6px;margin-top:36px}
.toolbar{margin:12px 0}.toolbar input{width:100%;max-width:420px;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--fg)}
.toolbar label{margin-left:14px;color:var(--mut)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px;margin-top:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}
.card.hidden{display:none}
.card header{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}
.card h3{margin:0;font-size:15px}
.summary{color:#cdd3df;margin:8px 0}
.badges{display:flex;gap:4px;flex-wrap:wrap}
.badge{font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid var(--line);color:var(--mut);white-space:nowrap}
.badge.status-active{color:#7fd18b;border-color:#2f5a37}.badge.status-draft{color:#e0c060;border-color:#5a4f23}
.badge.status-deprecated,.badge.status-superseded{color:#c98b8b;border-color:#5a2f2f}
.badge.stale{color:#e08a4f;border-color:#5a3a23}.badge.nosrc{color:#b08bd1}
.badge.conf-high{color:#7fd18b}.badge.conf-low{color:#c98b8b}
.tags{margin-top:8px;display:flex;gap:5px;flex-wrap:wrap}
.tag{font-size:11px;background:#1f242e;border:1px solid var(--line);border-radius:6px;padding:1px 6px;color:var(--mut)}
.meta{color:var(--mut);font-size:12px;margin-top:6px}
.src{display:inline-block;margin-top:8px;color:var(--accent);text-decoration:none;font-size:12px}
details{margin-top:8px}details pre{white-space:pre-wrap;background:#11141a;border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto}
.graph-wrap{overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px;margin-top:12px}
.node rect{fill:#1f242e;stroke:var(--accent)}.node text{fill:var(--fg);font-size:12px}
.edge{fill:none;stroke:var(--mut);stroke-width:1.5}.arrowhead{fill:var(--mut)}
.legend{color:var(--mut);font-size:12px;margin-top:8px}
.empty{color:var(--mut)}
footer{color:var(--mut);text-align:center;padding:24px;font-size:12px}
`;

const SCRIPT = `
(function(){
  var q=document.getElementById('q'),drafts=document.getElementById('showDrafts');
  function apply(){
    var term=(q.value||'').trim().toLowerCase();
    var inclDrafts=drafts && drafts.checked;
    document.querySelectorAll('.card').forEach(function(c){
      var okStatus = inclDrafts || c.getAttribute('data-status')==='active';
      var okTerm = !term || c.getAttribute('data-haystack').indexOf(term)>=0;
      c.classList.toggle('hidden', !(okStatus && okTerm));
    });
  }
  if(q) q.addEventListener('input',apply);
  if(drafts) drafts.addEventListener('change',apply);
  apply();
})();
`;

/**
 * Render the whole self-contained page. No external resources — all CSS and
 * JS is inlined, so the file works offline and from `file://`.
 */
export function renderHtml(model: HtmlModel): string {
  const activeCount = model.lore.filter((l) => l.status === "active").length;
  const draftCount = model.lore.filter((l) => l.status === "draft").length;
  const cards = model.lore.map(renderLoreCard).join("\n");
  const draftToggle = draftCount
    ? `<label><input type="checkbox" id="showDrafts"> show ${draftCount} draft(s)</label>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>loreguard — team memory</title>
<style>${STYLE}</style></head>
<body>
<header class="top">
  <h1>loreguard — team memory</h1>
  <div class="sub">${activeCount} active record(s) · ${model.graph.repos.length} repo(s) · ${model.graph.deps.length} dependency edge(s) · generated ${esc(model.generatedAt)}</div>
</header>
<main>
  <h2>Architecture</h2>
  <div class="legend">Arrows point from a consumer to the upstream repo it depends on. Hover an edge for the contracts that create it.</div>
  <div class="graph-wrap">${renderGraphSvg(model.graph)}</div>

  <h2>Records</h2>
  <div class="toolbar">
    <input id="q" type="search" placeholder="Filter records (title, summary, body, tags, repos)…">
    ${draftToggle}
  </div>
  <div class="cards">
${cards || '<p class="empty">No records yet.</p>'}
  </div>
</main>
<footer>Generated by loreguard · self-contained, offline, no tracking</footer>
<script>${SCRIPT}</script>
</body></html>
`;
}
