# yantrikdb-opencode

An [OpenCode](https://opencode.ai/) V2 plugin that makes
[YantrikDB](https://github.com/yantrikos/yantrikdb) the agent's global long-term memory.

Memory arrives as a boot digest on the first user turn, as a recalled
`<yantrikdb-memory>` block before each prompt, and through the engine's own MCP tools.
User turns are drafted back into the store at compaction and session end, with credential
shapes redacted before any write.

This is the OpenCode counterpart to [yantrikdb-claude](../yantrikdb-claude),
[yantrikdb-chatgpt](../yantrikdb-chatgpt), and [yantrikdb-pi](../yantrikdb-pi). It is
**V2-only**: it targets the `@opencode/plugin` 2.x API and ships no V1 `server()` shim.

## Layout

```
plugins/yantrikdb-memory/
  package.json            @yantrikdb/opencode — exports "." → ./src/index.ts
  src/                    the plugin (TypeScript, executed from source)
    index.ts              plugin setup: MCP registration + session hooks + event cleanup
    client.ts             fetch-based YantrikDB HTTP client
    config.ts             store coordinates and tunables
    capture.ts            transcript → draft-memory lines
    format.ts             digest / recall rendering
    redact.ts             credential redaction
    state.ts              per-session watermarks (recall rids, captured lines)
  test/                   node:test suite (no runtime dependencies)
  README.md               install, configuration, failure isolation, debugging
```

## Quick start

```sh
opencode plugin add 'github:avbel/yantrikdb-opencode#main::path:plugins/yantrikdb-memory'
```

or from a local checkout:

```sh
opencode plugin add ./plugins/yantrikdb-opencode/plugins/yantrikdb-memory
```

Point the plugin at an HTTP YantrikDB cluster so the deterministic hooks can reach it:

```sh
export YANTRIKDB_SERVER_URL="http://node1:7438,http://node2:7438"
export YANTRIKDB_TOKEN="ydb_…"
opencode
```

See [plugins/yantrikdb-memory/README.md](plugins/yantrikdb-memory/README.md) for the full
configuration, the store-coordinate resolution order, and the failure-isolation
guarantees.

## Testing

```sh
cd plugins/yantrikdb-memory
npm install
npm run typecheck     # TypeScript 7, strict
npm test              # node:test
```

## License

MIT — see [LICENSE](LICENSE).
