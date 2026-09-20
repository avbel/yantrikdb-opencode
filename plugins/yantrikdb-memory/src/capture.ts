/**
 * Transcript capture: which message lines are worth drafting into memory, and which of
 * those have already been sent.
 *
 * Line-level watermarks (not turn-level) make capture idempotent across a session and a
 * plugin reload: a line's mark is a hash of its text, so re-reading the same transcript
 * never re-drafts it.
 */

import type { CaptureRole } from "./config.ts";
import { collapse, extractText } from "./format.ts";
import { markOf } from "./state.ts";

/** Only the message fields this module reads. Structurally matches OpenCode's `Message`. */
export interface MessageLike {
  role?: unknown;
  content?: unknown;
}

/** Client-side scaffolding that lands in the user role but is not user speech. */
const META_PREFIXES = ["<system-reminder", "<command-name", "<local-command-stdout", "<task-notification"];

function isClientBookkeeping(text: string): boolean {
  if (text.startsWith("/")) return true;
  return META_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/** User turns (or user + assistant) from the transcript, collapsed and deduplicated in order. */
export function collectTurnLines(messages: readonly MessageLike[], roles: CaptureRole): string[] {
  const out: string[] = [];
  for (const message of messages) {
    const role = message.role;
    if (role !== "user" && !(roles === "all" && role === "assistant")) continue;
    const text = collapse(extractText(message.content));
    if (text === "") continue;
    if (role === "user" && isClientBookkeeping(text)) continue;
    if (out.length > 0 && out[out.length - 1] === text) continue;
    out.push(text);
  }
  return out;
}

export function freshLines(lines: string[], done: string[]): string[] {
  const known = new Set(done);
  return lines.filter((line) => !known.has(markOf(line)));
}

/** Newest-preserving tail: joins with `\n` and keeps the last `maxChars` characters. */
export function buildBlob(lines: string[], maxChars: number): string {
  if (lines.length === 0) return "";
  let size = lines.reduce((total, line) => total + line.length, 0) + Math.max(0, lines.length - 1);
  if (size <= maxChars) return lines.join("\n");
  let start = 0;
  while (start < lines.length - 1 && size > maxChars) {
    size -= (lines[start]?.length ?? 0) + 1;
    start++;
  }
  const candidate = lines.slice(start).join("\n");
  if (candidate.length <= maxChars) return candidate;
  // A single over-long line: keep its tail and drop the partial head line.
  const tail = candidate.slice(candidate.length - maxChars);
  const newline = tail.indexOf("\n");
  return newline >= 0 ? tail.slice(newline + 1) : tail;
}
