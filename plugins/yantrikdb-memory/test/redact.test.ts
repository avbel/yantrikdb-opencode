import assert from "node:assert/strict";
import { test } from "node:test";

import { redact } from "../src/redact.ts";

test("redacts bearer tokens", () => {
  assert.equal(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345", true), "Authorization: Bearer [redacted token]");
});

test("redacts JWTs, ydb tokens, and provider keys", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  assert.equal(redact(jwt, true), "[redacted jwt]");
  assert.equal(redact(`token ydb_${"a".repeat(40)}`, true), "token [redacted token]");
  assert.equal(redact("sk-proj-abcdefghijklmnop1234", true), "[redacted token]");
  assert.equal(redact("ghp_abcdefghijklmnopqrstuvwxyz0123456789", true), "[redacted token]");
  assert.equal(redact("AKIAIOSFODNN7EXAMPLE", true), "[redacted aws key]");
});

test("redacts credentials embedded in URLs", () => {
  assert.equal(redact("postgres://user:s3cr3tpass@host/db", true), "postgres://user:[redacted]@host/db");
});

test("redacts generic secret assignments and long hex", () => {
  // The optional opening quote is consumed by the match, so the closing quote survives
  // (ported behaviour from the Claude Code plugin; harmless, the secret is gone).
  assert.equal(redact("api_key = 'abcdef12345678'", true), "api_key=[redacted]'");
  assert.equal(redact("password: hunter2hunter2", true), "password=[redacted]");
  assert.equal(redact(`sha ${"a".repeat(48)}`, true), "sha [redacted hex]");
});

test("redacts private key blocks", () => {
  const block = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----";
  assert.equal(redact(block, true), "[redacted private key]");
});

test("leaves ordinary text untouched", () => {
  const text = "We decided to use PostgreSQL for the new service.";
  assert.equal(redact(text, true), text);
});

test("disabled redaction is a pass-through", () => {
  const text = `Bearer ${"x".repeat(30)}`;
  assert.equal(redact(text, false), text);
});
