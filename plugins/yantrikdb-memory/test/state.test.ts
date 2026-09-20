import assert from "node:assert/strict";
import { test } from "node:test";

import { EMPTY_STATE, markOf, mergeMarks, mergeRids, restoreState, toJson } from "../src/state.ts";

test("markOf is a stable 16-char hex digest", () => {
  const a = markOf("some transcript line");
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, markOf("some transcript line"));
  assert.notEqual(a, markOf("different line"));
});

test("mergeRids dedupes preserving order", () => {
  assert.deepEqual(mergeRids(["a", "b"], ["b", "c"]), ["a", "b", "c"]);
});

test("mergeRids trims the oldest past the cap", () => {
  const seen = Array.from({ length: 400 }, (_, index) => `r${index}`);
  const merged = mergeRids(seen, ["fresh"]);
  assert.equal(merged.length, 400);
  assert.equal(merged[merged.length - 1], "fresh");
  assert.ok(!merged.includes("r0"));
});

test("mergeMarks dedupes preserving order", () => {
  assert.deepEqual(mergeMarks(["x"], ["y", "x"]), ["x", "y"]);
});

test("restoreState reads a stored object and fills missing fields", () => {
  const state = restoreState({ namespace: "team", injectedRids: ["r1"], captured: ["m1"], digestSent: true });
  assert.deepEqual(state, { sessionId: undefined, namespace: "team", digestSent: true, injectedRids: ["r1"], captured: ["m1"] });
});

test("restoreState returns undefined for non-objects", () => {
  assert.equal(restoreState(undefined), undefined);
  assert.equal(restoreState(null), undefined);
  assert.equal(restoreState([1, 2]), undefined);
  assert.equal(restoreState("nope"), undefined);
});

test("restoreState drops non-string array entries", () => {
  const state = restoreState({ injectedRids: ["a", 2, null, "b"] });
  assert.deepEqual(state?.injectedRids, ["a", "b"]);
});

test("toJson omits an undefined sessionId and round-trips", () => {
  const json = toJson({ ...EMPTY_STATE, namespace: "team", sessionId: undefined });
  assert.ok(!("sessionId" in json));
  const restored = restoreState(json);
  assert.equal(restored?.namespace, "team");
  assert.equal(restored?.sessionId, undefined);
});

test("toJson keeps a defined sessionId", () => {
  const json = toJson({ ...EMPTY_STATE, sessionId: "ses-1" });
  assert.equal((json as Record<string, unknown>)["sessionId"], "ses-1");
});
