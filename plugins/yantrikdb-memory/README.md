# YantrikDB Memory for OpenCode

Makes [YantrikDB](https://yantrikdb.com/) the agent's long-term memory in OpenCode
V2. The plugin is a TypeScript module that registers the store's own MCP server and
wires YantrikDB to OpenCode's session lifecycle, so memory works whether or not the
model chooses to call a memory tool.

| Lifecycle | What it does |
|---|---|
| `context` (fresh user turn) | Injects the boot digest (where things stood, live decisions) with a short save policy, gated per-prompt recall, and a save check when the previous turn ran tools without saving. Framed as background context. |
| `compaction` | Opt-in (`CAPTURE=true`): before context is discarded, drafts the user turns it contains into memory (redacted, line-watermarked). |
| `session.deleted` (event) | Closes the tracked YantrikDB session and, when enabled, runs one `think()` hygiene pass. |
| `mcp.transform` | Registers the `yantrikdb` MCP server so the model also gets all of the engine's tools and its golden-path playbook. |

OpenCode loads the plugin, not a shell hook. There is no separate build step: the
harness executes the TypeScript source directly.

## Requirements

- OpenCode V2 (`@opencode/plugin` 2.x). This plugin is V2-only and ships no V1
  `server()` shim.
- `yantrikdb-mcp` on `PATH` for the MCP surface. Install it with
  `pipx install yantrikdb-mcp` or `pip install yantrikdb-mcp`.
- For the deterministic hooks (digest/recall/capture outside the model's control), an
  HTTP YantrikDB store: `YANTRIKDB_SERVER_URL` (comma-separated cluster nodes) and
  `YANTRIKDB_TOKEN`. The plugin talks to it directly over `fetch`. An embedded/local
  store (`~/.yantrikdb/memory.db`) still works through the MCP server, but the hooks
  have no local channel to it and stay silent.

## Install

OpenCode has no marketplace format; a plugin is an npm-compatible package or a local
directory. Install straight from this repository with the `::path:` selector:

```sh
opencode plugin add 'github:avbel/yantrikdb-opencode#main::path:plugins/yantrikdb-memory'
```

Or from a local checkout:

```sh
opencode plugin add ./plugins/yantrikdb-memory
```

Or add it by hand to `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./plugins/yantrikdb-memory"]
}
```

Once published to npm:

```sh
opencode plugin add @yantrikdb/opencode
```

The key is `plugins`: OpenCode V2 silently ignores the V1 `plugin` key, which left this
plugin unloaded with no error in the log. A configured directory must also have a root `server` or
`index` entry (here `index.ts`); without one OpenCode skips it just as silently.

Start a new session so the plugin and its MCP server are loaded. The MCP server is
registered automatically unless `opencode.json(c)` already declares a server named
`yantrikdb`.

## Where the store coordinates come from

`YANTRIKDB_SERVER_URL` (comma-separated nodes) and `YANTRIKDB_TOKEN` are read from the
first source that yields a non-empty URL:

1. `process.env`
2. Settings files (below): `<configDir>/yantrikdb.json`, then `<cwd>/.opencode/yantrikdb.json`,
   then `<cwd>/.yantrikdb.json` — `configDir` is `$XDG_CONFIG_HOME/opencode`, else
   `~/.config/opencode`
3. `<cwd>/opencode.jsonc`, `<cwd>/opencode.json`, `<cwd>/.opencode/opencode.jsonc`,
   `<cwd>/.opencode/opencode.json` → `mcp.servers.yantrikdb.environment`
4. `<cwd>/.mcp.json` → `mcpServers.yantrikdb.env`
5. `<configDir>/opencode.jsonc`, `<configDir>/opencode.json` → same shapes
6. `~/.codex/config.toml` → `[mcp_servers.yantrikdb.env]` (only that table)
7. `~/.claude.json` → `projects[<cwd>].mcpServers.yantrikdb.env`, then top-level
   `mcpServers.yantrikdb.env`

`${NAME}` and OpenCode's `{env:NAME}` inside a value are expanded from the environment.
A malformed file is skipped, not fatal — an empty result means "no memory", never a
broken session. Sources 3–7 are declarations other tools on the machine already carry;
the store is usually declared somewhere, and reading it keeps the MCP server and the
hooks pointed at the same place.

## Settings files

Durable configuration can live in JSON rather than the environment:

```json
{
  "server": { "url": "http://host:7438", "token": "ydb_…" },
  "settings": { "NAMESPACE": "default", "TOP_K": 5, "DEBUG": true }
}
```

`settings` keys are the bare tunable suffixes from the table below, so the file and the
environment name the same thing. Documents merge key by key, later files winning, and
are read once per process — changes take effect on the next session.

| File | Scope |
|---|---|
| `<configDir>/yantrikdb.json` | machine-wide |
| `<cwd>/.opencode/yantrikdb.json` | project |
| `<cwd>/.yantrikdb.json` | project, portable across tools |

A token in a project file is a token in a repository; use mode `600` and add the path
to `.gitignore`.

## Configuration

Every tunable reads `YANTRIKDB_OPENCODE_<NAME>`, then `YANTRIKDB_HOOKS_<NAME>` (so one
env block configures both this plugin and the Claude Code hooks), then the settings
file, then the default. An empty value counts as unset and falls through.

| Suffix | Default | Meaning |
|---|---|---|
| `NAMESPACE` | `default` | Memory namespace for reads and writes. |
| `RECALL` | `true` | Per-prompt recall injection. |
| `TOP_K` | `3` | Max hits injected per prompt. |
| `CANDIDATES` | `10` | Hits fetched before the relevance gate. |
| `MIN_SCORE` | `0.10` | Absolute score floor for an injected hit. |
| `MIN_SIMILARITY` | `0.50` | Semantic-lane cosine (from `why_retrieved`) an injected hit needs; keyword/graph-only hits are dropped. `0` disables it. About `0.60` suits the bundled 64-dim embedder. |
| `EXCLUDE_NAMESPACES` | — | Comma-separated namespace prefixes never injected, e.g. `hermes:`. |
| `RECALL_CAPTURED` | follows `CAPTURE` | Inject auto-captured prompts and consolidation merges made of them. |
| `MIN_PROMPT_CHARS` | `24` | Shorter prompts are skipped. |
| `RECALL_QUERY_CHARS` | `400` | Query truncation. |
| `RECALL_BLOCK_CHARS` | `4000` | Cap on injected block text. |
| `RECALL_TIMEOUT_MS` | `2500` | Per-recall HTTP timeout (the prompt path). |
| `DIGEST` | `true` | Boot digest injection. |
| `DIGEST_DECISIONS` | `5` | Live decisions shown in the digest. |
| `DIGEST_MAINTENANCE` | `false` | Also show open conflicts and pending triggers. |
| `GAPS` | follows `DIGEST_MAINTENANCE` | Include known-unknowns in the digest. |
| `RECENT` | `6` | Rows in the empty-digest fallback. |
| `FALLBACK` | `true` | Broad recall when the digest is empty. |
| `TRACK_SESSION` | `true` | Open/close a tracked YantrikDB session. |
| `CAPTURE` | `false` | Draft memories from the transcript at compaction. Drafts stayed near-verbatim prompts and dominated the store, so the model saves through MCP `remember` instead. |
| `SAVE_NUDGE` | `true` | Save policy in the digest and a save check after turns that ran `SAVE_NUDGE_TOOLS` tool calls without a `remember`. |
| `SAVE_NUDGE_TOOLS` | `6` | Tool calls a turn needs before an unsaved turn earns a save check. |
| `CAPTURE_ROLES` | `user` | `user`, or `all` to include assistant turns. |
| `CAPTURE_CHARS` | `6000` | Cap on drafted text. |
| `CAPTURE_MIN_CHARS` | `200` | Below this, skip the round trip. |
| `CAPTURE_DOMAIN` | `work` | `domain` sent with drafts. |
| `CAPTURE_TIMEOUT_MS` | `4000` | Per-draft HTTP timeout. |
| `MAINTENANCE` | `false` | `POST /v1/think` at session end (see below). |
| `MAINTENANCE_TIMEOUT_MS` | `30000` | Timeout for the session-end `think` cycle, which is slow by nature. |
| `REDACT` | `true` | Secret redaction before writes. |
| `HTTP_TIMEOUT_MS` | `5000` | Default request timeout. |
| `UNREACHABLE_TTL_MS` | `60000` | How long a failed probe keeps the store marked down. |
| `DEBUG` | `false` | Verbose logging to stderr. |

### Injection semantics

OpenCode's request hooks run for every model call, including tool-loop continuations,
and the request is assembled fresh each time. This plugin injects only when the last
message is a fresh user turn, and it checks the assembled `system` parts for its own
sentinel (`## YantrikDB memory` / `<yantrikdb-memory`) before adding a block. That keeps
the injection correct whether the host rebuilds the request per call or carries it
forward.

### Why maintenance is off by default

The server-side hygiene cycle (`POST /v1/think`) is slow by nature — ~20 s against a
store of a few hundred memories. Enable `MAINTENANCE` only where `think` answers
quickly, or run the cycle from cron against the endpoint directly.

## Failure isolation

The plugin never breaks a session:

- no store coordinates → the hooks no-op, and the MCP server still provides the tools;
- store unreachable → nothing is injected, and the failure is remembered in
  `<configDir>/cache/yantrikdb-opencode/unreachable.json` so prompts inside the TTL
  window make no network call at all;
- any hook throw is logged (with `DEBUG=1`) and contained;
- the event subscription is aborted and hook registrations are disposed on unload.

Capture drafts **user turns only** by default: assistant turns are model claims, and
drafting them is how a store poisons itself. Secrets are redacted before any write, and
each transcript line is watermarked so it is drafted at most once.

## MCP

The store's own MCP server is registered automatically. Its tools sit alongside the
deterministic hooks; the hooks do not replace explicit `remember`, `recall`, `correct`,
`forget`, `think`, graph, conflict, task, or session calls, they only cover the points
where memory should not depend on the model's choice.

The plugin ships no store token. It registers the MCP server with the coordinates it
resolved (or no environment at all, for a local embedded store), and leaves an existing
`yantrikdb` declaration untouched.

## Debugging

```sh
YANTRIKDB_OPENCODE_DEBUG=1 opencode
```

With debugging on, the plugin logs store resolution, leader choice, digest size,
injected rids, capture counts, and session close to stderr. Filter the OpenCode log:

```sh
tail -f ~/.local/share/opencode/log/opencode.log | grep '\[yantrikdb\]'
```

## Development

```sh
cd plugins/yantrikdb-memory
npm install
npm run typecheck     # TypeScript 7, strict + exactOptionalPropertyTypes
npm test              # node:test, no runtime dependencies
```

No runtime dependencies beyond `@opencode/plugin`: the store client uses `fetch` and
`node:*` builtins only, and the lifecycle modules import nothing from the host so they
are unit-testable on their own.

## License

MIT — see [LICENSE](LICENSE).
