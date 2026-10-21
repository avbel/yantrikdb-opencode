/**
 * YantrikDB HTTP client.
 *
 * One class over `fetch`, no runtime dependencies. Every public method resolves instead
 * of rejecting: a memory backend that is down must never surface as an agent error, so a
 * failed call logs at debug and returns `null`/`false` and the caller stays silent.
 *
 * Wire shapes are taken from `yantrikdb_mcp/http_backend.py`:
 *   GET    /v1/health              -> leader discovery (`cluster.accepts_writes`)
 *   GET    /v1/session/digest      -> boot briefing
 *   GET    /v1/insights/gaps       -> known-unknowns
 *   POST   /v1/recall              -> { results: [...] }
 *   POST   /v1/sessions            -> { session_id | id }
 *   DELETE /v1/sessions/{id}       -> session tracking end
 *   POST   /v1/session/end         -> atomize a summary string into draft memories
 *   POST   /v1/think               -> server-side hygiene cycle
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Leader probe timeouts. Both bound a multi-node list: per-node timeouts alone would add
 * up, so a dead or blackholed node is abandoned on our terms.
 */
const PROBE_TIMEOUT_MS = 1200;
const PROBE_BUDGET_MS = 1500;

/**
 * Fields are `| undefined` rather than optional so a hit stays a single object literal
 * under `exactOptionalPropertyTypes` (the server omits fields freely).
 */
export interface RecallHit {
  rid: string;
  text: string;
  score: number;
  namespace: string | undefined;
  memory_type: string | undefined;
  importance: number | undefined;
  created_at: number | undefined;
  why_retrieved: string[] | undefined;
  source: string | undefined;
  metadata: Record<string, unknown> | undefined;
}

export interface YantrikClientOptions {
  nodes: string[];
  token: string;
  timeoutMs: number;
  unreachableTtlMs: number;
  log: (message: string, ...rest: unknown[]) => void;
  /** Where the "unreachable until" marker lives; one file per client. */
  stateDir: string;
}

interface SendOptions {
  body?: unknown;
  query?: Record<string, string>;
  timeoutMs?: number;
}

interface SendResult {
  ok: boolean;
  /** `undefined` when no server answered (offline, gated, or an unparseable body). */
  status: number | undefined;
  body: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The server sends metadata as an object or as its JSON text. */
function metadataOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function toHit(value: unknown): RecallHit | undefined {
  const row = asRecord(value);
  if (!row) return undefined;
  const rid = asString(row["rid"]);
  if (rid === undefined || rid === "") return undefined;
  const why = row["why_retrieved"];
  return {
    rid,
    text: asString(row["text"]) ?? "",
    score: asNumber(row["score"]) ?? 0,
    namespace: asString(row["namespace"]),
    memory_type: asString(row["memory_type"]),
    importance: asNumber(row["importance"]),
    created_at: asNumber(row["created_at"]),
    why_retrieved: Array.isArray(why) ? why.filter((item): item is string => typeof item === "string") : undefined,
    source: asString(row["source"]),
    metadata: metadataOf(row["metadata"]),
  };
}

export class YantrikClient {
  private readonly nodes: string[];
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly unreachableTtlMs: number;
  private readonly log: (message: string, ...rest: unknown[]) => void;
  private readonly markerFile: string;
  private readonly nodeKey: string;
  private leader: string | null = null;
  /** Wall-clock ms until which probing is suppressed after an unreachable store. */
  private gatedUntil = 0;

  constructor(options: YantrikClientOptions) {
    this.nodes = options.nodes;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs;
    this.unreachableTtlMs = options.unreachableTtlMs;
    this.log = options.log;
    this.nodeKey = options.nodes.join(",");
    // One marker per store, so two plugin instances pointed at different clusters in the
    // same long-lived server process do not clobber each other's unreachable state.
    const digest = createHash("sha1").update(this.nodeKey).digest("hex").slice(0, 12);
    this.markerFile = path.join(options.stateDir, `unreachable-${digest}.json`);
  }

  /** Resolves the leader (or falls back to the first node). Never rejects. */
  async health(): Promise<boolean> {
    return (await this.resolveLeader()) !== null;
  }

  async digest(options: { namespace: string; includeGaps: boolean }): Promise<Record<string, unknown> | null> {
    const query: Record<string, string> = {
      // The server deserializes this as a bool: "1"/"0" is a 400.
      include_gaps: options.includeGaps ? "true" : "false",
      // Headroom for the superseded / excluded rows dropped while rendering.
      max_decisions: "10",
      max_gaps: "5",
      max_conflicts: "5",
      max_triggers: "5",
      snippet_chars: "240",
    };
    if (options.namespace !== "default") query["namespace"] = options.namespace;
    return asRecord(await this.json("GET", "/v1/session/digest", { query })) ?? null;
  }

  async gaps(options: { minCount: number; limit: number }): Promise<Array<Record<string, unknown>>> {
    const body = asRecord(
      await this.json("GET", "/v1/insights/gaps", {
        query: { min_count: String(options.minCount), limit: String(options.limit) },
      }),
    );
    const raw = body?.["gaps"];
    const out: Array<Record<string, unknown>> = [];
    for (const row of Array.isArray(raw) ? raw : []) {
      const record = asRecord(row);
      if (record) out.push(record);
    }
    return out;
  }

  /** `null` = the store did not answer; `[]` = it answered with no hits. */
  async recall(options: {
    query: string;
    topK: number;
    namespace?: string;
    /** Per-call override for the prompt path, which has a tighter budget. */
    timeoutMs?: number;
  }): Promise<RecallHit[] | null> {
    const payload: Record<string, unknown> = { query: options.query, top_k: options.topK };
    // "default" means every namespace, as in the digest: a namespace filter hid all
    // memories written by agents that name their project namespace.
    if (options.namespace !== undefined && options.namespace !== "default") payload["namespace"] = options.namespace;
    const request: SendOptions = { body: payload };
    if (options.timeoutMs !== undefined) request.timeoutMs = options.timeoutMs;
    const body = asRecord(await this.json("POST", "/v1/recall", request));
    if (!body) return null;
    const raw = body["results"];
    const out: RecallHit[] = [];
    for (const row of Array.isArray(raw) ? raw : []) {
      const hit = toHit(row);
      if (hit) out.push(hit);
    }
    return out;
  }

  async sessionStart(options: { namespace: string; clientId: string }): Promise<string | null> {
    const body = await this.json("POST", "/v1/sessions", {
      body: { namespace: options.namespace, client_id: options.clientId },
    });
    // Embedded-engine shape answers with the bare id.
    const bare = asString(body);
    if (bare !== undefined && bare !== "") return bare;
    const record = asRecord(body);
    if (!record) return null;
    for (const key of ["session_id", "id", "sessionId"]) {
      const value = asString(record[key]);
      if (value !== undefined && value !== "") return value;
    }
    return null;
  }

  async sessionEnd(sessionId: string): Promise<boolean> {
    const result = await this.send("DELETE", `/v1/sessions/${encodeURIComponent(sessionId)}`);
    return result.ok || result.status === 404;
  }

  async draft(options: {
    summary: string;
    namespace: string;
    domain: string;
    timeoutMs?: number;
  }): Promise<Record<string, unknown> | null> {
    const request: SendOptions = {
      body: { summary: options.summary, namespace: options.namespace, domain: options.domain },
    };
    if (options.timeoutMs !== undefined) request.timeoutMs = options.timeoutMs;
    return asRecord(await this.json("POST", "/v1/session/end", request)) ?? null;
  }

  /**
   * Server-side hygiene cycle. Slow by nature — the reference store took ~20s against a
   * few hundred memories — so the caller bounds it rather than the client.
   */
  async think(namespace?: string, timeoutMs?: number): Promise<boolean> {
    const payload: Record<string, unknown> = {};
    if (namespace !== undefined) payload["namespace"] = namespace;
    const request: SendOptions = { body: payload };
    if (timeoutMs !== undefined) request.timeoutMs = timeoutMs;
    return (await this.send("POST", "/v1/think", request)).ok;
  }

  /**
   * Body of a successful call, or `undefined` for any failure. Call sites unwrap the same
   * way, so the discrimination stays here instead of at every endpoint.
   */
  private async json(method: string, pathname: string, options: SendOptions = {}): Promise<unknown | undefined> {
    const result = await this.send(method, pathname, options);
    return result.ok ? result.body : undefined;
  }

  private async send(method: string, pathname: string, options: SendOptions = {}): Promise<SendResult> {
    const timeout = options.timeoutMs ?? this.timeoutMs;
    let leaderRetries = 0;
    let connectionRetries = 0;
    for (;;) {
      const base = await this.resolveLeader();
      if (base === null) return { ok: false, status: undefined, body: undefined };
      const url = new URL(base + pathname);
      for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
      const headers: Record<string, string> = { Accept: "application/json" };
      if (this.token !== "") headers["Authorization"] = `Bearer ${this.token}`;
      const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeout) };
      if (options.body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(options.body);
      }
      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`request failed: ${method} ${pathname}`, message);
        this.leader = null;
        // Retrying a request that ran out of *our* clock doubles the time spent inside a
        // handler the host is already timing. Only a transport failure gets a second
        // attempt; a timeout is reported as-is.
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        if (!timedOut && connectionRetries++ < 1) continue;
        return { ok: false, status: undefined, body: undefined };
      }
      // The body is a one-shot stream: a connection reset mid-read rejects here, which
      // must not escape the no-reject contract. Drop the leader and report failure.
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        this.log(`body read failed: ${method} ${pathname}`, error instanceof Error ? error.message : String(error));
        this.leader = null;
        return { ok: false, status: undefined, body: undefined };
      }
      // 503 means "this node is not the leader"; re-probe rather than trust the cache.
      if (response.status === 503 && leaderRetries++ < 2) {
        this.leader = null;
        continue;
      }
      if (!response.ok) {
        this.log(`http ${response.status}: ${method} ${pathname}`, text.slice(0, 200));
        return { ok: false, status: response.status, body: undefined };
      }
      if (text.trim() === "") return { ok: true, status: response.status, body: {} };
      try {
        return { ok: true, status: response.status, body: JSON.parse(text) as unknown };
      } catch (error) {
        this.log(`bad json: ${method} ${pathname}`, error instanceof Error ? error.message : String(error));
        return { ok: false, status: undefined, body: undefined };
      }
    }
  }

  /**
   * Leader URL, probing `/v1/health` once per client. A node advertising
   * `cluster.accepts_writes` wins; otherwise the first reachable node is used, which is
   * the correct behaviour for a single-node deployment that reports no cluster block.
   */
  private async resolveLeader(): Promise<string | null> {
    if (this.leader !== null) return this.leader;
    const now = Date.now();
    // Time-based gate, not a permanent latch: the OpenCode server is long-lived, so a
    // transient store blip must recover once `unreachableTtlMs` elapses rather than
    // disabling memory until the host restarts.
    if (now < this.gatedUntil) return null;
    if (this.markerActive()) {
      this.gatedUntil = now + this.unreachableTtlMs;
      this.log("unreachable marker: skipping network for", this.nodeKey);
      return null;
    }
    let firstReachable: string | undefined;
    const startedAt = Date.now();
    for (const node of this.nodes) {
      if (Date.now() - startedAt > PROBE_BUDGET_MS) break;
      const body = await this.probe(node);
      if (body === undefined) continue;
      if (firstReachable === undefined) firstReachable = node;
      if (asRecord(body["cluster"])?.["accepts_writes"] === true) {
        this.leader = node;
        this.log("leader:", node);
        return node;
      }
    }
    if (firstReachable !== undefined) {
      this.leader = firstReachable;
      this.log("leader (fallback):", firstReachable);
      return firstReachable;
    }
    this.log("cluster unreachable:", this.nodeKey);
    this.writeMarker();
    this.gatedUntil = Date.now() + this.unreachableTtlMs;
    return null;
  }

  private async probe(node: string): Promise<Record<string, unknown> | undefined> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.token !== "") headers["Authorization"] = `Bearer ${this.token}`;
    try {
      const response = await fetch(`${node}/v1/health`, {
        headers,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!response.ok) return undefined;
      return asRecord(JSON.parse(await response.text()) as unknown);
    } catch (error) {
      this.log(`health probe failed: ${node}`, error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  /** True while a previous failed probe still suppresses network calls. */
  private markerActive(): boolean {
    try {
      const record = asRecord(JSON.parse(readFileSync(this.markerFile, "utf8")) as unknown);
      if (!record) return false;
      if (record["url"] !== this.nodeKey) return false;
      const until = asNumber(record["until"]);
      return until !== undefined && until > Date.now();
    } catch {
      return false;
    }
  }

  private writeMarker(): void {
    try {
      mkdirSync(path.dirname(this.markerFile), { recursive: true });
      writeFileSync(this.markerFile, JSON.stringify({ url: this.nodeKey, until: Date.now() + this.unreachableTtlMs }));
    } catch (error) {
      this.log("marker write failed", error instanceof Error ? error.message : String(error));
    }
  }
}
