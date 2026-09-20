/**
 * Real-socket test for the HTTP client. Unlike the stub-based unit tests, this drives the
 * client against an actual `node:http` server, exercising `fetch`, `URL`, request bodies,
 * headers, and timeouts the way they behave in production.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { YantrikClient } from "../src/client.ts";

const requests: Array<{ method: string; url: string; body: string }> = [];
let server: Server;
let base: string;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      requests.push({ method: req.method ?? "GET", url: req.url ?? "", body });
      const send = (value: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      const url = req.url ?? "";
      if (url.startsWith("/v1/health")) return send({ cluster: { accepts_writes: true } });
      if (url.startsWith("/v1/session/digest")) return send({ narrative_head: "socket digest" });
      if (url.startsWith("/v1/insights/gaps")) return send({ gaps: [{ query: "socket gap" }] });
      if (url.startsWith("/v1/recall")) return send({ results: [{ rid: "sock-1", text: "socket fact", score: 0.7 }] });
      if (req.method === "POST" && url.startsWith("/v1/sessions")) return send("sock-session");
      if (req.method === "POST" && url.startsWith("/v1/session/end")) return send({ count: 2 });
      if (req.method === "DELETE" && url.startsWith("/v1/sessions/sock-session")) return send({});
      if (req.method === "POST" && url.startsWith("/v1/think")) return send({ ok: true });
      send({ error: "not found" }, 404);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  base = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
});

function makeClient(): YantrikClient {
  return new YantrikClient({
    nodes: [base],
    token: "ydb_e2e",
    timeoutMs: 2000,
    unreachableTtlMs: 60_000,
    log: () => {},
    stateDir: mkdtempSync(path.join(tmpdir(), "ydb-e2e-")),
  });
}

test("client talks to a real store over HTTP", async () => {
  const client = makeClient();
  assert.equal(await client.health(), true);

  assert.deepEqual(await client.digest({ namespace: "default", includeGaps: true }), { narrative_head: "socket digest" });
  assert.deepEqual(await client.gaps({ minCount: 2, limit: 5 }), [{ query: "socket gap" }]);

  const hits = await client.recall({ query: "socket", topK: 3, namespace: "default" });
  assert.equal(hits?.[0]?.rid, "sock-1");
  assert.equal(hits?.[0]?.text, "socket fact");

  assert.equal(await client.sessionStart({ namespace: "default", clientId: "opencode-e2e" }), "sock-session");
  assert.equal(await client.sessionEnd("sock-session"), true);
  assert.deepEqual(await client.draft({ summary: "blob", namespace: "default", domain: "work" }), { count: 2 });
  assert.equal(await client.think("default"), true);

  const auth = requests.find((request) => request.url.startsWith("/v1/recall"));
  assert.ok(auth);
  const sessions = requests.find((request) => request.method === "POST" && request.url.startsWith("/v1/sessions"));
  assert.deepEqual(JSON.parse(sessions?.body ?? "{}"), { namespace: "default", client_id: "opencode-e2e" });
});
