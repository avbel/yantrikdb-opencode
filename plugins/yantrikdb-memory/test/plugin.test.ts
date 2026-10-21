import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import plugin from "../src/index.ts";

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

/** Controllable async iterable for the plugin's event subscription. */
function makeEventQueue(): AsyncIterable<unknown> & { push: (value: unknown) => void; close: () => void } {
  const items: unknown[] = [];
  const waiters: Array<(result: IteratorResult<unknown>) => void> = [];
  let closed = false;
  const iterator = {
    next(): Promise<IteratorResult<unknown>> {
      if (items.length > 0) return Promise.resolve({ value: items.shift(), done: false });
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => waiters.push(resolve));
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
  return {
    push(value: unknown) {
      const waiter = waiters.shift();
      if (waiter) waiter({ value, done: false });
      else items.push(value);
    },
    close() {
      closed = true;
      while (waiters.length > 0) waiters.shift()?.({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
}

function stubFetch(routes: Array<{ method?: string; match: string; json?: unknown; text?: string }>): Call[] {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : String((input as Request).url);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url, body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined });
    const route = routes.find((candidate) => url.includes(candidate.match) && (!candidate.method || candidate.method === method));
    if (!route) return new Response("not found", { status: 404 });
    return new Response(route.text ?? JSON.stringify(route.json ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for condition");
}

interface Harness {
  ctx: unknown;
  hooks: Map<string, (event: unknown) => unknown>;
  mcp: Array<{ name: string; config: Record<string, unknown> }>;
  events: ReturnType<typeof makeEventQueue>;
}

function makeHarness(directory: string): Harness {
  const hooks = new Map<string, (event: unknown) => unknown>();
  const mcp: Array<{ name: string; config: Record<string, unknown> }> = [];
  const storage = new Map<string, unknown>();
  const events = makeEventQueue();
  const ctx = {
    location: { directory, workspaceID: undefined, project: { id: "proj", directory, canonical: directory } },
    options: {},
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value);
      },
      remove: async (key: string) => {
        storage.delete(key);
      },
      scan: async () => ({ entries: [] }),
    },
    mcp: {
      list: async () => [],
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          list: () => [],
          get: () => undefined,
          set: (name: string, config: Record<string, unknown>) => {
            mcp.push({ name, config });
          },
          update: () => {},
          remove: () => {},
        });
        return { dispose: async () => {} };
      },
      reload: async () => {},
    },
    session: {
      hook: async (name: string, callback: (event: unknown) => unknown) => {
        hooks.set(name, callback);
        return { dispose: async () => {} };
      },
    },
    event: { subscribe: () => events },
  };
  return { ctx, hooks, mcp, events };
}

const savedEnv = new Map<string, string | undefined>();
const WATCHED = ["YANTRIKDB_SERVER_URL", "YANTRIKDB_TOKEN", "XDG_CONFIG_HOME", "YANTRIKDB_OPENCODE_CAPTURE_MIN_CHARS", "YANTRIKDB_OPENCODE_CAPTURE"];

beforeEach(() => {
  for (const key of WATCHED) savedEnv.set(key, process.env[key]);
  for (const key of WATCHED) delete process.env[key];
  process.env["XDG_CONFIG_HOME"] = mkdtempSync(path.join(tmpdir(), "ydb-open-xdg-"));
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

test("setup registers the MCP server with resolved coordinates", async () => {
  process.env["YANTRIKDB_SERVER_URL"] = "http://store.test";
  process.env["YANTRIKDB_TOKEN"] = "ydb_token";
  const calls = stubFetch([{ method: "GET", match: "/v1/health", json: { cluster: { accepts_writes: true } } }]);
  const harness = makeHarness(mkdtempSync(path.join(tmpdir(), "ydb-open-")));
  await plugin.setup(harness.ctx as never);

  assert.deepEqual(harness.mcp, [
    {
      name: "yantrikdb",
      config: {
        type: "local",
        command: ["yantrikdb-mcp"],
        environment: { YANTRIKDB_SERVER_URL: "http://store.test", YANTRIKDB_TOKEN: "ydb_token" },
      },
    },
  ]);
  assert.equal(calls.length, 0, "setup must not touch the network");
});

test("context injects the digest and floor-filtered recall, deduping on repeat", async () => {
  process.env["YANTRIKDB_SERVER_URL"] = "http://store.test";
  const calls = stubFetch([
    { method: "GET", match: "/v1/health", json: { cluster: { accepts_writes: true } } },
    { method: "GET", match: "/v1/session/digest", json: { narrative_head: "Previously we migrated to Postgres." } },
    { method: "GET", match: "/v1/insights/gaps", json: { gaps: [{ query: "which region deploys" }] } },
    {
      method: "POST",
      match: "/v1/recall",
      json: {
        results: [
          { rid: "r1", text: "We chose Postgres.", score: 0.9, why_retrieved: ["semantically similar (0.71)"] },
          { rid: "r2", text: "Low score hit", score: 0.02, why_retrieved: ["semantically similar (0.70)"] },
          { rid: "r3", text: "Keyword-only hit", score: 0.8, why_retrieved: ["keyword_match"] },
          { rid: "r4", text: "Captured prompt", score: 0.8, source: "session_auto_capture", why_retrieved: ["semantically similar (0.9)"] },
        ],
      },
    },
    { method: "POST", match: "/v1/sessions", text: JSON.stringify("sess-1") },
  ]);
  const harness = makeHarness(mkdtempSync(path.join(tmpdir(), "ydb-open-")));
  await plugin.setup(harness.ctx as never);

  const context = harness.hooks.get("context");
  assert.ok(context);

  const system: Array<{ type: "text"; text: string }> = [];
  await context({
    sessionID: "ses_a",
    system,
    messages: [{ role: "user", content: [{ type: "text", text: "What did we decide about the database migration?" }] }],
  });
  const text = system.map((part) => part.text).join("\n");
  assert.match(text, /## YantrikDB memory/);
  assert.match(text, /Previously we migrated to Postgres\./);
  assert.match(text, /We chose Postgres\./);
  assert.match(text, /<yantrikdb-memory namespace="default">/);
  assert.ok(!text.includes("Low score hit"), "hits below the score floor must be dropped");
  assert.ok(!text.includes("Keyword-only hit"), "hits without a semantic match must be dropped");
  assert.ok(!text.includes("Captured prompt"), "auto-captured prompts must be dropped");
  assert.match(text, /Saving: when the user settles a decision/);
  assert.ok(
    calls.some((call) => call.method === "POST" && call.url.includes("/v1/sessions")),
    "a tracked session must be opened",
  );

  // A second fresh request re-injects the digest (the request is rebuilt per call) but
  // not the already-seen recall hit.
  const system2: Array<{ type: "text"; text: string }> = [];
  await context({
    sessionID: "ses_a",
    system: system2,
    messages: [{ role: "user", content: [{ type: "text", text: "What did we decide about the database migration?" }] }],
  });
  const text2 = system2.map((part) => part.text).join("\n");
  assert.match(text2, /## YantrikDB memory/);
  assert.ok(!text2.includes("<yantrikdb-memory"), "an already-injected rid must not repeat");

  // The digest is fetched once per session and re-injected from cache, not refetched
  // on every turn.
  const digestCalls = calls.filter((call) => call.url.includes("/v1/session/digest"));
  assert.equal(digestCalls.length, 1, "the boot digest must be fetched once per session");
});

test("context adds a save check after a working turn that saved nothing", async () => {
  process.env["YANTRIKDB_SERVER_URL"] = "http://store.test";
  stubFetch([{ method: "GET", match: "/v1/health", json: { cluster: { accepts_writes: true } } }]);
  const harness = makeHarness(mkdtempSync(path.join(tmpdir(), "ydb-open-")));
  await plugin.setup(harness.ctx as never);
  const work = Array.from({ length: 6 }, (_, index) => ({
    role: "assistant",
    content: [{ type: "tool-call", id: `c${index}`, name: "execute", input: { code: "await tools.bash({cmd: 'pnpm test'})" } }],
  }));
  const run = async (saved: boolean) => {
    const system: Array<{ type: "text"; text: string }> = [];
    const save = { role: "assistant", content: [{ type: "tool-call", id: "s", name: "execute", input: { code: "await tools.yantrikdb.remember({text: 'x'})" } }] };
    await harness.hooks.get("context")?.({
      sessionID: "ses_n",
      system,
      messages: [
        { role: "user", content: [{ type: "text", text: "Port the share links." }] },
        ...work,
        ...(saved ? [save] : []),
        { role: "user", content: [{ type: "text", text: "commit it" }] },
      ],
    });
    return system.map((part) => part.text).join("\n");
  };
  assert.match(await run(false), /previous turn ran 6 tool calls and saved nothing/);
  assert.ok(!(await run(true)).includes("save check"), "a turn that saved earns no note");
});

test("context ignores tool-loop continuations", async () => {
  process.env["YANTRIKDB_SERVER_URL"] = "http://store.test";
  stubFetch([{ method: "GET", match: "/v1/health", json: { cluster: { accepts_writes: true } } }]);
  const harness = makeHarness(mkdtempSync(path.join(tmpdir(), "ydb-open-")));
  await plugin.setup(harness.ctx as never);

  const system: Array<{ type: "text"; text: string }> = [];
  await harness.hooks.get("context")?.({
    sessionID: "ses_a",
    system,
    messages: [
      { role: "user", content: [{ type: "text", text: "Do the thing." }] },
      { role: "assistant", content: [{ type: "text", text: "Working on it." }] },
      { role: "tool", content: [{ type: "text", text: "tool output" }] },
    ],
  });
  assert.equal(system.length, 0);
});

test("compaction drafts user turns once, watermarked across retries", async () => {
  process.env["YANTRIKDB_SERVER_URL"] = "http://store.test";
  process.env["YANTRIKDB_OPENCODE_CAPTURE_MIN_CHARS"] = "1";
  process.env["YANTRIKDB_OPENCODE_CAPTURE"] = "1";
  const calls = stubFetch([
    { method: "GET", match: "/v1/health", json: { cluster: { accepts_writes: true } } },
    { method: "POST", match: "/v1/sessions", text: JSON.stringify("sess-1") },
    { method: "POST", match: "/v1/session/end", json: { count: 2 } },
  ]);
  const harness = makeHarness(mkdtempSync(path.join(tmpdir(), "ydb-open-")));
  await plugin.setup(harness.ctx as never);

  const event = {
    sessionID: "ses_a",
    system: [],
    messages: [{ role: "user", content: [{ type: "text", text: "Remember that we use Postgres and deploy to us-west1." }] }],
  };
  await harness.hooks.get("compaction")?.(event);
  await waitFor(() => calls.some((call) => call.url.includes("/v1/session/end")));
  const draft = calls.find((call) => call.url.includes("/v1/session/end"));
  assert.match(String((draft?.body as { summary?: string }).summary), /Postgres/);

  await harness.hooks.get("compaction")?.(event);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const drafts = calls.filter((call) => call.url.includes("/v1/session/end"));
  assert.equal(drafts.length, 1, "the watermark must prevent a second draft");
});

test("session.deleted closes the tracked session and clears state", async () => {
  process.env["YANTRIKDB_SERVER_URL"] = "http://store.test";
  const calls = stubFetch([
    { method: "GET", match: "/v1/health", json: { cluster: { accepts_writes: true } } },
    { method: "POST", match: "/v1/sessions", text: JSON.stringify("sess-1") },
    { method: "DELETE", match: "/v1/sessions/sess-1", json: {} },
  ]);
  const harness = makeHarness(mkdtempSync(path.join(tmpdir(), "ydb-open-")));
  await plugin.setup(harness.ctx as never);

  const system: Array<{ type: "text"; text: string }> = [];
  await harness.hooks.get("context")?.({
    sessionID: "ses_a",
    system,
    messages: [{ role: "user", content: [{ type: "text", text: "hello there, a real prompt" }] }],
  });

  harness.events.push({ type: "session.deleted", data: { sessionID: "ses_a" } });
  await waitFor(() => calls.some((call) => call.method === "DELETE" && call.url.includes("/v1/sessions/sess-1")));

  // State is cleared, so a later context call starts a fresh tracked session.
  const before = calls.filter((call) => call.method === "POST" && call.url.includes("/v1/sessions")).length;
  assert.equal(before, 1);
});
