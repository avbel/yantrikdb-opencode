/**
 * Per-session plugin state: which recall hits were already injected and which transcript
 * lines were already drafted into memory.
 *
 * The OpenCode plugin API has no per-branch custom session entries, so this lives in the
 * plugin's durable key/value storage (`ctx.storage`), keyed by session id. Watermarks are
 * content hashes, so re-reading the same transcript never re-drafts a line even if the
 * plugin reloads mid-session.
 */

import { createHash } from "node:crypto";

export interface SessionState {
  /** Tracked YantrikDB session id; `undefined` when tracking is off or failed. */
  sessionId: string | undefined;
  namespace: string;
  digestSent: boolean;
  /** rids already injected on this session, newest last. */
  injectedRids: string[];
  /** Watermark marks of lines already drafted into memory, oldest last. */
  captured: string[];
}

export const EMPTY_STATE: SessionState = {
  sessionId: undefined,
  namespace: "default",
  digestSent: false,
  injectedRids: [],
  captured: [],
};

const RID_CAP = 400;
const MARK_CAP = 600;

function merge(seen: string[], fresh: string[], cap: number): string[] {
  const merged = [...seen];
  const known = new Set(seen);
  for (const value of fresh) {
    if (known.has(value)) continue;
    known.add(value);
    merged.push(value);
  }
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

export function mergeRids(seen: string[], fresh: string[]): string[] {
  return merge(seen, fresh, RID_CAP);
}

export function mergeMarks(seen: string[], fresh: string[]): string[] {
  return merge(seen, fresh, MARK_CAP);
}

/** Capture watermark for one transcript line. Stable across sessions and processes. */
export function markOf(line: string): string {
  return createHash("sha1").update(line).digest("hex").slice(0, 16);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Rebuild state from a stored JSON value; missing fields fall back. */
export function restoreState(value: unknown): SessionState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const namespace = record["namespace"];
  return {
    sessionId: typeof record["sessionId"] === "string" ? record["sessionId"] : undefined,
    namespace: typeof namespace === "string" && namespace !== "" ? namespace : EMPTY_STATE.namespace,
    digestSent: record["digestSent"] === true,
    injectedRids: stringArray(record["injectedRids"]),
    captured: stringArray(record["captured"]),
  };
}

/** Recursive JSON value, structurally compatible with the host's storage type. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Plain JSON shape for storage; omits `undefined`, which `ctx.storage` cannot hold. */
export function toJson(state: SessionState): JsonValue {
  const out: { [key: string]: JsonValue } = {
    namespace: state.namespace,
    digestSent: state.digestSent,
    injectedRids: state.injectedRids,
    captured: state.captured,
  };
  if (state.sessionId !== undefined) out["sessionId"] = state.sessionId;
  return out;
}
