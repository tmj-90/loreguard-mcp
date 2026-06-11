# Using loreguard with other agents (Cursor, Windsurf, Continue, …)

Loreguard is a plain **stdio MCP server** plus a CLI. Nothing about it is
Claude-specific — any client that speaks the Model Context Protocol can use the
same `loreguard-mcp` binary and the same seven tools (`search_lore`, `get_lore`,
`suggest_lore`, `report_conflict`, `record_absence`, `find_dependents`,
`declare_boundary`). The CLI (`loreguard review`, `approve`, etc.) is the human
trust gate regardless of which agent is on the other side.

Two things to wire up for any client:

1. **Register the MCP server** so the tools are callable.
2. **Add the retrieval rule** so the agent actually *calls* `search_lore` at the
   right moments. `loreguard print-claude-instructions --format <client>` emits
   the rule in the right shape — the rule body is identical everywhere; only the
   file it belongs in differs.

Install first (`npm i -g loreguard-mcp && loreguard init`) so `loreguard-mcp` is
on your `$PATH`. If you installed from source via `npm link`, the same name
works; otherwise substitute the absolute path to `dist/bin/loreguard-mcp.js`.

---

## Claude Code

```bash
claude mcp add loreguard loreguard-mcp
loreguard print-claude-instructions >> CLAUDE.md
```

Or just run `loreguard setup`, which does both plus copies the
`/loreguard-onboard` skill. (See the main README — this is the best-supported
path.)

---

## Cursor

Cursor reads MCP servers from `.cursor/mcp.json` (project) or `~/.cursor/mcp.json`
(global):

```json
{
  "mcpServers": {
    "loreguard": {
      "command": "loreguard-mcp"
    }
  }
}
```

Modern Cursor rules live in `.cursor/rules/*.mdc`. Generate one:

```bash
mkdir -p .cursor/rules
loreguard print-claude-instructions --format cursor > .cursor/rules/loreguard.mdc
```

The `--format cursor` output includes the `.mdc` frontmatter
(`alwaysApply: true`) so Cursor loads the retrieval rule every session — it's a
small always-on rule that tells the agent *when* to reach for lore, not the lore
itself.

---

## Windsurf

Windsurf reads MCP servers from `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "loreguard": {
      "command": "loreguard-mcp"
    }
  }
}
```

Add the retrieval rule to `.windsurfrules` in the repo root:

```bash
loreguard print-claude-instructions --format windsurf >> .windsurfrules
```

---

## Continue (VS Code / JetBrains)

Add the server to `~/.continue/config.json` (or the project `.continue` config):

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      { "transport": { "type": "stdio", "command": "loreguard-mcp" } }
    ]
  }
}
```

Continue's rule mechanism varies by version — paste the generic rule into your
system message or rules file:

```bash
loreguard print-claude-instructions --format generic
```

---

## Any other MCP client

Every MCP-capable client ultimately needs the same thing: run `loreguard-mcp`
over stdio. The minimal server entry is always:

```json
{ "command": "loreguard-mcp", "args": [] }
```

and the retrieval rule (`--format generic`) goes into whatever file that client
loads at session start. If a client can't run a binary on `$PATH`, point it at
the absolute path of `dist/bin/loreguard-mcp.js` with `node`:

```json
{ "command": "node", "args": ["/absolute/path/to/dist/bin/loreguard-mcp.js"] }
```

---

## Environment knobs (all clients)

The same env vars apply wherever the server runs — set them in the client's MCP
server `env` block (or the shell that launches it):

| Var | Effect |
|---|---|
| `LOREGUARD_DB` | Override the SQLite path (default `~/.loreguard/lore.db`). |
| `LOREGUARD_ALLOW_RESTRICTED_MCP=1` | Let MCP see restricted records. Off by default. |
| `LOREGUARD_ALLOW_MCP_ABSENCE=1` | Let agents write absence markers. Off by default. |
| `LOREGUARD_NO_TELEMETRY=1` | Silence local read tracking. |

See [`operations.md`](operations.md#environment-knobs-all-local-only--none-reach-the-network)
for the full list, and the [README](../README.md#trust-model) for the trust
model. Nothing here reaches the network — the server is stdio-only.
