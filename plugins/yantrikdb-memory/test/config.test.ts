import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  clientIdFor,
  configureSettings,
  expandEnv,
  readTomlEnv,
  resolveStore,
  resolveTunables,
  stripJsonc,
} from "../src/config.ts";

const STORE_ENV = [
  "YANTRIKDB_SERVER_URL",
  "YANTRIKDB_TOKEN",
  "XDG_CONFIG_HOME",
  "HOME",
  "YANTRIKDB_OPENCODE_TOP_K",
  "YANTRIKDB_HOOKS_TOP_K",
];

function withCleanEnv(fn: () => void): void {
  const saved = new Map(STORE_ENV.map((key) => [key, process.env[key]]));
  for (const key of STORE_ENV) delete process.env[key];
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

test("expandEnv handles both dialects", () => {
  process.env["YANTRIKDB_TEST_TOKEN"] = "secret";
  try {
    assert.equal(expandEnv("${YANTRIKDB_TEST_TOKEN}"), "secret");
    assert.equal(expandEnv("{env:YANTRIKDB_TEST_TOKEN}"), "secret");
    assert.equal(expandEnv("pre-${YANTRIKDB_TEST_TOKEN}-post"), "pre-secret-post");
    assert.equal(expandEnv("plain"), "plain");
  } finally {
    delete process.env["YANTRIKDB_TEST_TOKEN"];
  }
});

test("stripJsonc removes comments and trailing commas", () => {
  const text = `{
    // line comment
    "a": 1, /* block */
    "b": [1, 2,],
  }`;
  assert.deepEqual(JSON.parse(stripJsonc(text)), { a: 1, b: [1, 2] });
});

test("stripJsonc leaves comment markers inside strings alone", () => {
  const text = `{ "url": "http://host//path", "note": "a /* b */ c" }`;
  assert.deepEqual(JSON.parse(stripJsonc(text)), { url: "http://host//path", note: "a /* b */ c" });
});

test("readTomlEnv extracts only the requested table", () => {
  const toml = [
    "[other]",
    'key = "ignored"',
    "[mcp_servers.yantrikdb.env]",
    'YANTRIKDB_SERVER_URL = "http://host:7438"',
    'YANTRIKDB_TOKEN = "ydb_x" # trailing comment',
    "[mcp_servers.yantrikdb]",
    'command = "nope"',
  ].join("\n");
  assert.deepEqual(readTomlEnv(toml, "yantrikdb"), {
    YANTRIKDB_SERVER_URL: "http://host:7438",
    YANTRIKDB_TOKEN: "ydb_x",
  });
  assert.equal(readTomlEnv(toml, "missing"), null);
});

test("clientIdFor is stable and prefixed", () => {
  assert.equal(clientIdFor("ses_abc123"), "opencode-ses_abc123");
  assert.equal(clientIdFor(""), "opencode-session");
  assert.equal(clientIdFor("a/b c"), "opencode-a-b-c");
});

test("resolveTunables uses defaults", () => {
  withCleanEnv(() => {
    configureSettings(tempDir("ydb-cwd-"));
    const tunables = resolveTunables();
    assert.equal(tunables.namespace, "default");
    assert.equal(tunables.topK, 5);
    assert.equal(tunables.captureRoles, "user");
    assert.equal(tunables.maintenance, false);
  });
});

test("tunable precedence: OPENCODE over HOOKS over default", () => {
  withCleanEnv(() => {
    configureSettings(tempDir("ydb-cwd-"));
    process.env["YANTRIKDB_HOOKS_TOP_K"] = "7";
    assert.equal(resolveTunables().topK, 7);
    process.env["YANTRIKDB_OPENCODE_TOP_K"] = "9";
    assert.equal(resolveTunables().topK, 9);
    delete process.env["YANTRIKDB_OPENCODE_TOP_K"];
    delete process.env["YANTRIKDB_HOOKS_TOP_K"];
    assert.equal(resolveTunables().topK, 5);
  });
});

test("resolveStore prefers the process environment", () => {
  withCleanEnv(() => {
    process.env["YANTRIKDB_SERVER_URL"] = "http://a:1, http://b:2/";
    process.env["YANTRIKDB_TOKEN"] = "ydb_t";
    const store = resolveStore(tempDir("ydb-cwd-"));
    assert.deepEqual(store, { nodes: ["http://a:1", "http://b:2"], token: "ydb_t" });
  });
});

test("resolveStore reads the machine settings file", () => {
  withCleanEnv(() => {
    const xdg = tempDir("ydb-xdg-");
    const config = path.join(xdg, "opencode");
    mkdirSync(config, { recursive: true });
    writeFileSync(
      path.join(config, "yantrikdb.json"),
      JSON.stringify({ server: { url: "http://cfg:7438", token: "ydb_cfg" } }),
    );
    process.env["XDG_CONFIG_HOME"] = xdg;
    configureSettings(tempDir("ydb-cwd-"));
    assert.deepEqual(resolveStore(tempDir("ydb-cwd-")), { nodes: ["http://cfg:7438"], token: "ydb_cfg" });
  });
});

test("resolveStore reads opencode.jsonc mcp.servers environment", () => {
  withCleanEnv(() => {
    const cwd = tempDir("ydb-proj-");
    writeFileSync(
      path.join(cwd, "opencode.jsonc"),
      `{
        // project config
        "mcp": {
          "servers": {
            "yantrikdb": {
              "type": "local",
              "command": ["yantrikdb-mcp"],
              "environment": { "YANTRIKDB_SERVER_URL": "http://proj:7438", "YANTRIKDB_TOKEN": "ydb_p" },
            },
          },
        },
      }`,
    );
    configureSettings(cwd);
    assert.deepEqual(resolveStore(cwd), { nodes: ["http://proj:7438"], token: "ydb_p" });
  });
});

test("resolveStore returns null when nothing declares a store", () => {
  withCleanEnv(() => {
    // Point HOME at a scratch directory so the cross-tool fallbacks (~/.codex/config.toml,
    // ~/.claude.json) miss on any machine.
    process.env["HOME"] = tempDir("ydb-home-");
    process.env["XDG_CONFIG_HOME"] = tempDir("ydb-xdg-");
    const cwd = tempDir("ydb-cwd-");
    configureSettings(cwd);
    assert.equal(resolveStore(cwd), null);
  });
});
