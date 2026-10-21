import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { YantrikClient } from "../src/client.ts";

interface Route {
  method?: string;
  match: string;
  status?: number;
  json?: unknown;
  text?: string;
}

let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
});

function stubFetch(routes: Route[]): Array<{ method: string; url: string; body?: unknown }> {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : String((input as Request).url);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url, body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined });
    const route = routes.find((candidate) => url.includes(candidate.match) && (!candidate.method || candidate.method === method));
    if (!route) return new Response("not found", { status: 404 });
    return new Response(route.text ?? JSON.stringify(route.json ?? {}), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
  return calls;
}

function makeClient(): YantrikClient {
  return new YantrikClient({
    nodes: ["http://store.test"],
    token: "ydb_t",
    timeoutMs: 1000,
    unreachableTtlMs: 60_000,
    log: () => {},
    stateDir: mkdtempSync(path.join(tmpdir(), "ydb-client-")),
  });
}

const HEALTH = { method: "GET", match: "/v1/health", json: { cluster: { accepts_writes: true } } };

test("recall probes the leader and parses hits", async () => {
  const calls = stubFetch([HEALTH, { method: "POST", match: "/v1/recall", json: { results: [{ rid: "r1", text: "a fact", score: 0.8 }, { text: "no rid" }] } }]);
  const hits = await makeClient().recall({ query: "q", topK: 3, namespace: "default" });
  assert.equal(hits?.length, 1);
  assert.deepEqual(hits?.[0], {
    rid: "r1",
    text: "a fact",
    score: 0.8,
    namespace: undefined,
    memory_type: undefined,
    importance: undefined,
    created_at: undefined,
    why_retrieved: undefined,
    source: undefined,
    metadata: undefined,
  });
  const recall = calls.find((call) => call.url.includes("/v1/recall"));
  assert.deepEqual(recall?.body, { query: "q", top_k: 3 }, "the default namespace searches every namespace");
  assert.equal((calls[0] as { method: string }).method, "GET");
  assert.match((calls[0] as { url: string }).url, /\/v1\/health$/);
});

test("recall returns null when the store is unreachable", async () => {
  stubFetch([]);
  assert.equal(await makeClient().recall({ query: "q", topK: 1 }), null);
});

test("digest sends the boolean query and omits the default namespace", async () => {
  const calls = stubFetch([HEALTH, { method: "GET", match: "/v1/session/digest", json: { narrative_head: "hi" } }]);
  const digest = await makeClient().digest({ namespace: "default", includeGaps: true });
  assert.deepEqual(digest, { narrative_head: "hi" });
  const call = calls.find((entry) => entry.url.includes("/v1/session/digest"));
  assert.match(call?.url ?? "", /include_gaps=true/);
  assert.ok(!(call?.url ?? "").includes("namespace="));
});

test("sessionStart accepts bare and object ids", async () => {
  stubFetch([HEALTH, { method: "POST", match: "/v1/sessions", text: JSON.stringify("ses-bare") }]);
  assert.equal(await makeClient().sessionStart({ namespace: "default", clientId: "opencode-1" }), "ses-bare");
});

test("draft posts the summary", async () => {
  const calls = stubFetch([HEALTH, { method: "POST", match: "/v1/session/end", json: { count: 3 } }]);
  const result = await makeClient().draft({ summary: "blob", namespace: "team", domain: "work" });
  assert.deepEqual(result, { count: 3 });
  const call = calls.find((entry) => entry.url.includes("/v1/session/end"));
  assert.deepEqual(call?.body, { summary: "blob", namespace: "team", domain: "work" });
});

test("a failed probe marks the store down and suppresses later calls", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "ydb-client-"));
  const options = {
    nodes: ["http://dead.test"],
    token: "",
    timeoutMs: 200,
    unreachableTtlMs: 60_000,
    log: () => {},
    stateDir,
  };
  const calls = stubFetch([]);
  const first = new YantrikClient(options);
  assert.equal(await first.health(), false);
  const afterFirst = calls.length;

  // A second client pointed at the same nodes must not touch the network while the
  // unreachable marker is fresh.
  const second = new YantrikClient(options);
  assert.equal(await second.health(), false);
  assert.equal(calls.length, afterFirst);
});

test("the unreachable gate expires and re-probes after the TTL", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "ydb-client-"));
  const calls = stubFetch([]);
  const client = new YantrikClient({
    nodes: ["http://dead.test"],
    token: "",
    timeoutMs: 200,
    unreachableTtlMs: 1,
    log: () => {},
    stateDir,
  });
  assert.equal(await client.health(), false);
  const afterFirst = calls.length;
  await new Promise((resolve) => setTimeout(resolve, 10));
  // A long-lived server must recover from a transient blip once the TTL elapses.
  assert.equal(await client.health(), false);
  assert.ok(calls.length > afterFirst, "an expired gate must allow a re-probe");
});
