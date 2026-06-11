/**
 * `loreguard estate init` — Epic A2 scaffolding.
 *
 * Writes a ready-to-commit "estate repo": a GitHub Actions workflow that
 * checks out the member repos, aggregates their committed `.loreguard/`
 * exports with `loreguard estate`, and publishes the org-wide map to GitHub
 * Pages — plus the repo list it reads and a README. No server: the estate is
 * a git repo + CI, and git is the auth / audit / review gate.
 *
 * Pure (returns file descriptors) so the CLI just writes them and tests can
 * assert the contents without touching disk.
 */

export interface ScaffoldFile {
  /** Path relative to the estate-repo root. */
  readonly path: string;
  readonly content: string;
}

const WORKFLOW = `# Aggregates every member repo's committed .loreguard/ into one estate map
# and publishes it to GitHub Pages. No server — this is the whole "enterprise
# knowledge base": a git repo + CI, with git as the auth and review gate.
#
# Before this works you must:
#   1. Fill in loreguard-estate.repos.txt (one owner/repo per line).
#   2. Create a repo secret ESTATE_READ_TOKEN with read access to those repos
#      (a fine-grained PAT or GitHub App token). Public repos need no token.
#   3. Enable Pages for this repo (Settings → Pages → Source: GitHub Actions).
name: loreguard-estate

on:
  workflow_dispatch: {}
  schedule:
    - cron: "0 6 * * 1" # weekly, Monday 06:00 UTC
  push:
    branches: [main]

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: loreguard-estate
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm install -g loreguard-mcp
      - name: Check out member repos
        env:
          GH_TOKEN: \${{ secrets.ESTATE_READ_TOKEN }}
        run: |
          mkdir -p repos
          while IFS= read -r repo || [ -n "$repo" ]; do
            case "$repo" in ""|\\#*) continue ;; esac
            echo "Cloning $repo"
            git clone --depth 1 \\
              "https://x-access-token:\${GH_TOKEN}@github.com/\${repo}.git" \\
              "repos/\$(basename "$repo")" || echo "WARN: could not clone $repo"
          done < loreguard-estate.repos.txt
      - name: Aggregate the estate
        run: LOREGUARD_DB=./estate.db loreguard estate ./repos --out-dir ./site
      - uses: actions/upload-pages-artifact@v3
        with:
          path: ./site

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deploy.outputs.page_url }}
    steps:
      - id: deploy
        uses: actions/deploy-pages@v4
`;

const REPOS_TXT = `# loreguard estate — member repos (one "owner/repo" per line).
# Lines starting with # are ignored. Each repo should run
# \`loreguard sync export .loreguard/\` and commit the result so this estate
# can aggregate its lore + architecture edges.
#
# acme/orders-svc
# acme/billing-svc
# acme/reporting-svc
`;

const README = `# loreguard estate

The org-wide rollup of every team's **ratified** lore and the cross-repo
architecture map — built as a git repo + CI, not a server.

## How it works

1. Each member repo records lore and \`provides\`/\`consumes\` boundary edges,
   ratifies them with \`loreguard boundary review\`, and commits the export
   (\`loreguard sync export .loreguard/\`).
2. This repo's CI (\`.github/workflows/loreguard-estate.yml\`) checks out every
   repo listed in \`loreguard-estate.repos.txt\`, runs
   \`loreguard estate ./repos --out-dir ./site\`, and publishes \`site/\` to
   GitHub Pages.
3. The published page shows the estate-wide dependency graph, the records,
   and the **dangling consumers** — contracts one team depends on that no
   team is shown to own (the highest-value cross-team risk signal).
4. \`site/architecture.json\` is a deterministic, timestamp-free manifest, so
   a PR that changes the estate's shape shows up as a reviewable diff.

## Setup

1. Edit \`loreguard-estate.repos.txt\` — one \`owner/repo\` per line.
2. Add a repo secret \`ESTATE_READ_TOKEN\` with read access to those repos
   (skip for public repos).
3. Enable Pages: Settings → Pages → Source: GitHub Actions.
4. Run the workflow (Actions → loreguard-estate → Run workflow).

Nothing here runs a server or phones home — the estate is just this repo.
`;

/** The files `loreguard estate init` writes into the estate repo root. */
export function estateScaffoldFiles(): ScaffoldFile[] {
  return [
    { path: ".github/workflows/loreguard-estate.yml", content: WORKFLOW },
    { path: "loreguard-estate.repos.txt", content: REPOS_TXT },
    { path: "README.md", content: README },
  ];
}
