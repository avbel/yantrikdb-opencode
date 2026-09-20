import assert from "node:assert/strict";
import { test } from "node:test";

import { buildBlob, collectTurnLines, freshLines } from "../src/capture.ts";
import { markOf } from "../src/state.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

test("collects user turns by default and skips assistant turns", () => {
  const messages = [user("First decision."), assistant("Sure."), user("Second decision.")];
  assert.deepEqual(collectTurnLines(messages, "user"), ["First decision.", "Second decision."]);
});

test("includes assistant turns when roles is all", () => {
  const messages = [user("Question?"), assistant("Answer.")];
  assert.deepEqual(collectTurnLines(messages, "all"), ["Question?", "Answer."]);
});

test("skips slash commands and client bookkeeping", () => {
  const messages = [
    user("/review --staged"),
    user("<system-reminder>internal</system-reminder>"),
    user("A real request from the user."),
  ];
  assert.deepEqual(collectTurnLines(messages, "user"), ["A real request from the user."]);
});

test("collapses whitespace and drops empty turns", () => {
  const messages = [user("line one\n\n  line two"), user("   "), { role: "user" }];
  assert.deepEqual(collectTurnLines(messages, "user"), ["line one line two"]);
});

test("drops consecutive duplicate lines", () => {
  const messages = [user("same text"), user("same text")];
  assert.deepEqual(collectTurnLines(messages, "user"), ["same text"]);
});

test("freshLines removes already-captured lines", () => {
  const lines = ["alpha", "beta", "gamma"];
  const done = [markOf("beta")];
  assert.deepEqual(freshLines(lines, done), ["alpha", "gamma"]);
});

test("buildBlob returns everything when under the cap", () => {
  assert.equal(buildBlob(["a", "b"], 100), "a\nb");
});

test("buildBlob keeps the newest tail when over the cap", () => {
  const blob = buildBlob(["first line", "second line", "third line"], 20);
  assert.ok(blob.endsWith("third line"));
  assert.ok(!blob.includes("first line"));
});

test("buildBlob clips a single over-long line to its tail", () => {
  const blob = buildBlob([`prefix-${"x".repeat(100)}`], 10);
  assert.equal(blob, "x".repeat(10));
});
