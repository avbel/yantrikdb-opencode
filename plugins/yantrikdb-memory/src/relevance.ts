/**
 * Relevance gate applied to recalled memories before anything is injected.
 *
 * Measured on a real store (2026-10): 65 % of active records descended from
 * auto-captured user prompts, and consolidation relabels those merges as
 * source=user, so the source field alone cannot catch them. Merges of curated
 * facts were never shorter than 825 chars, merges of prompts had a median of 194.
 * Blended scores barely separate relevant from irrelevant hits, so the gate uses
 * the semantic-lane cosine the engine reports in `why_retrieved`: on MiniLM-384 a
 * 0.50 floor kept 13/18 known answers and silenced 12/12 irrelevant prompts.
 */

import type { RecallHit } from "./client.ts";

export const AUTO_CAPTURE = "session_auto_capture";

const SIMILARITY = /semantically similar \(([0-9]*\.?[0-9]+)\)/;
const MERGE_MIN_CHARS = 600;
const MERGE_MIN_SEGMENT = 160;

export interface GateOptions {
  minSimilarity: number;
  includeCaptured: boolean;
  excludedNamespaces: readonly string[];
}

/** Cosine of the semantic lane, or undefined when only keyword/graph lanes matched. */
export function semanticSimilarity(why: readonly string[] | undefined): number | undefined {
  for (const reason of why ?? []) {
    const match = SIMILARITY.exec(reason);
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return undefined;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function isPromptMerge(text: string, metadata: Record<string, unknown> | undefined): boolean {
  const from = metadata?.["consolidated_from"];
  if (from === undefined || from === null || (Array.isArray(from) && from.length === 0)) return false;
  const segments = text.split(" | ").filter((segment) => segment.trim() !== "");
  return text.length < MERGE_MIN_CHARS || median((segments.length > 0 ? segments : [text]).map((s) => s.length)) < MERGE_MIN_SEGMENT;
}

/** Why a memory must not be injected, or undefined when it may be. */
export function noiseReason(
  row: Pick<RecallHit, "text" | "namespace" | "source" | "metadata">,
  options: Pick<GateOptions, "includeCaptured" | "excludedNamespaces">,
): string | undefined {
  const namespace = row.namespace ?? "";
  if (options.excludedNamespaces.some((prefix) => namespace.startsWith(prefix))) return "namespace";
  if (options.includeCaptured) return undefined;
  if (row.source === AUTO_CAPTURE || row.metadata?.["kind"] === AUTO_CAPTURE) return "auto-capture";
  if (isPromptMerge(row.text, row.metadata)) return "prompt-merge";
  return undefined;
}

export function filterHits(hits: readonly RecallHit[], options: GateOptions): RecallHit[] {
  return hits.filter((hit) => {
    if (noiseReason(hit, options) !== undefined) return false;
    if (options.minSimilarity <= 0) return true;
    const similarity = semanticSimilarity(hit.why_retrieved);
    return similarity !== undefined && similarity >= options.minSimilarity;
  });
}
