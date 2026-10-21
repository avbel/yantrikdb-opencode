import assert from "node:assert/strict";
import { test } from "node:test";

import { collapse, extractText, renderDigest, renderRecallBlock, renderRecent, trimTo } from "../src/format.ts";
import type { RecallHit } from "../src/client.ts";

function hit(partial: Partial<RecallHit> & { rid: string }): RecallHit {
  return {
    rid: partial.rid,
    text: partial.text ?? "",
    score: partial.score ?? 0.5,
    namespace: partial.namespace ?? "default",
    memory_type: partial.memory_type ?? "semantic",
    importance: partial.importance ?? undefined,
    created_at: partial.created_at ?? undefined,
    why_retrieved: partial.why_retrieved ?? undefined,
    source: partial.source ?? undefined,
    metadata: partial.metadata ?? undefined,
  };
}

const OPTIONS = { snippetChars: 240, decisions: 5, maintenance: false, excludedNamespaces: [] };

test("collapse squeezes whitespace", () => {
  assert.equal(collapse("  a \n  b\tc "), "a b c");
});

test("trimTo adds an ellipsis only when clipping", () => {
  assert.equal(trimTo("hello", 10), "hello");
  assert.equal(trimTo("hello world", 6), "hello…");
});

test("extractText reads strings and text blocks", () => {
  assert.equal(extractText("plain"), "plain");
  assert.equal(extractText([{ type: "text", text: "a" }, { type: "media" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(extractText(42), "");
});

test("renderDigest is empty for an empty store", () => {
  assert.equal(renderDigest(null, [], "default", OPTIONS), "");
  assert.equal(renderDigest({}, [], "default", OPTIONS), "");
});

test("renderDigest lists live decisions and hides maintenance noise by default", () => {
  const digest = {
    narrative_head: { snippet: "Worked on the migration." },
    top_decisions: [
      { snippet: "Use Postgres 16.", superseded_by: null },
      { snippet: "Use Postgres 15.", superseded_by: "r9" },
      { snippet: "Hermes chat line.", namespace: "hermes:chat" },
    ],
    open_conflicts: [{ conflict_type: "value", memory_a: "a", memory_b: "b" }],
    pending_triggers: [{ trigger_type: "relationship_insight", reason: "Entity 'API' is a hub" }],
  };
  const out = renderDigest(digest, [{ query: "deploy target" }], "default", { ...OPTIONS, excludedNamespaces: ["hermes:"] });
  assert.match(out, /Worked on the migration\./);
  assert.match(out, /Use Postgres 16\./);
  assert.ok(!out.includes("Postgres 15"), "superseded decisions are dropped");
  assert.ok(!out.includes("Hermes"), "excluded namespaces are dropped");
  assert.ok(!/hub|conflict|deploy target/.test(out), "maintenance sections are opt-in");
});

test("renderDigest renders present sections with a namespace header", () => {
  const digest = {
    narrative_head: "Worked on the migration.",
    open_conflicts: [{ conflict_type: "value", memory_a: "Python 3.11", memory_b: "Python 3.12" }],
    open_conflict_count: 1,
    pending_triggers: [{ trigger_type: "stale", reason: "review the plan" }],
  };
  const out = renderDigest(digest, [{ query: "what is the deploy target" }], "team", { ...OPTIONS, maintenance: true });
  assert.match(out, /^## YantrikDB memory \(namespace: team\)/);
  assert.match(out, /Where things stood|Narrative head/);
  assert.match(out, /Python 3.11 vs Python 3.12/);
  assert.match(out, /review the plan/);
  assert.match(out, /what is the deploy target/);
});

test("renderRecently is empty with no hits and lists items otherwise", () => {
  assert.equal(renderRecent([], "default"), "");
  const out = renderRecent([hit({ rid: "r1", text: "a fact", score: 0.8 })], "default");
  assert.match(out, /a fact/);
  assert.match(out, /score 0.80/);
});

test("renderRecallBlock is wrapped and sentinel-tagged", () => {
  const out = renderRecallBlock([hit({ rid: "r1", text: "a fact" })], "default", 4000);
  assert.match(out, /^<yantrikdb-memory namespace="default">/);
  assert.match(out, /<\/yantrikdb-memory>$/);
  assert.match(out, /a fact/);
  assert.equal(renderRecallBlock([], "default", 4000), "");
});

test("renderRecallBlock respects its character cap and keeps the closing tag", () => {
  const hits = Array.from({ length: 50 }, (_, index) => hit({ rid: `r${index}`, text: "x".repeat(200) }));
  const out = renderRecallBlock(hits, "default", 300);
  assert.ok(out.length <= 300);
  assert.match(out, /^<yantrikdb-memory namespace="default">/);
  assert.match(out, /<\/yantrikdb-memory>$/, "the closing tag must survive trimming");
});
