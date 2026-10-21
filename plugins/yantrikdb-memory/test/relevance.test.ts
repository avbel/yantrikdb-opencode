import assert from "node:assert/strict";
import { test } from "node:test";

import type { RecallHit } from "../src/client.ts";
import { filterHits, isPromptMerge, semanticSimilarity } from "../src/relevance.ts";

function hit(partial: Partial<RecallHit>): RecallHit {
  return {
    rid: partial.rid ?? "r",
    text: partial.text ?? "a curated fact",
    score: 0.5,
    namespace: partial.namespace,
    memory_type: undefined,
    importance: undefined,
    created_at: undefined,
    why_retrieved: partial.why_retrieved ?? ["semantically similar (0.70)"],
    source: partial.source,
    metadata: partial.metadata,
  };
}

const GATE = { minSimilarity: 0.5, includeCaptured: false, excludedNamespaces: ["hermes:"] };

test("semanticSimilarity reads the semantic lane only", () => {
  assert.equal(semanticSimilarity(["keyword_match", "semantically similar (0.61)"]), 0.61);
  assert.equal(semanticSimilarity(["keyword_match"]), undefined);
  assert.equal(semanticSimilarity(undefined), undefined);
});

test("short or prompt-sized merges are prompt merges, long curated merges are not", () => {
  const merged = { consolidated_from: ["a", "b"] };
  assert.ok(isPromptMerge("fix it | and the tests", merged));
  assert.ok(!isPromptMerge(`${"x".repeat(400)} | ${"y".repeat(400)}`, merged));
  assert.ok(!isPromptMerge("short but not merged", undefined));
});

test("filterHits drops captures, merges, excluded namespaces and weak semantic matches", () => {
  const kept = filterHits(
    [
      hit({ rid: "good" }),
      hit({ rid: "captured", source: "session_auto_capture" }),
      hit({ rid: "kind", metadata: { kind: "session_auto_capture" } }),
      hit({ rid: "merge", text: "do x | do y", metadata: { consolidated_from: ["a"] } }),
      hit({ rid: "hermes", namespace: "hermes:chat" }),
      hit({ rid: "weak", why_retrieved: ["semantically similar (0.41)"] }),
      hit({ rid: "keyword", why_retrieved: ["keyword_match"] }),
    ],
    GATE,
  );
  assert.deepEqual(kept.map((row) => row.rid), ["good"]);
  assert.equal(filterHits([hit({ rid: "keyword", why_retrieved: [] })], { ...GATE, minSimilarity: 0 }).length, 1);
  assert.equal(filterHits([hit({ source: "session_auto_capture" })], { ...GATE, includeCaptured: true }).length, 1);
});
