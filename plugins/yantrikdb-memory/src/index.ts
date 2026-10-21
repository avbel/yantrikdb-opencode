/**
 * YantrikDB memory for OpenCode (V2).
 *
 * Two halves:
 *
 *   1. The store's own MCP server is registered (`yantrikdb`) so the model gets all of
 *      the engine's tools and its golden-path playbook, and so embedded/local stores work.
 *   2. Deterministic lifecycle hooks wire the store to the session, so memory does not
 *      depend on the model choosing to call a tool:
 *        context     → boot digest (once) + per-prompt recall, injected into the request
 *        compaction  → draft user turns into memory before context is discarded
 *        session.deleted (event) → close the tracked session, optional hygiene pass
 *
 * Everything fails silent: an unreachable store degrades to "no memory", never to a
 * broken session.
 */

import { Plugin } from "@opencode/plugin";
import type { Mcp } from "@opencode/plugin";

import { buildBlob, collectTurnLines, freshLines } from "./capture.ts";
import { YantrikClient } from "./client.ts";
import {
  clientIdFor,
  configureSettings,
  resolveStore,
  resolveTunables,
  stateRootDir,
  type StoreConfig,
  type Tunables,
} from "./config.ts";
import {
  DIGEST_SENTINEL,
  RECALL_SENTINEL,
  collapse,
  extractText,
  renderDigest,
  renderRecent,
  renderRecallBlock,
} from "./format.ts";
import { SAVE_POLICY, saveNote } from "./nudge.ts";
import { redact } from "./redact.ts";
import { filterHits } from "./relevance.ts";
import {
  EMPTY_STATE,
  markOf,
  mergeMarks,
  mergeRids,
  restoreState,
  toJson,
  type SessionState,
} from "./state.ts";

export const PLUGIN_ID = "yantrikdb.opencode-memory";
export const MCP_SERVER_NAME = "yantrikdb";

const DIGEST_SNIPPET_CHARS = 240;
const MAX_GAPS = 5;
const RECENT_QUERY = "recent decisions, preferences and project context";
const STORAGE_PREFIX = "session/";

function stateKey(sessionID: string): string {
  return `${STORAGE_PREFIX}${sessionID}`;
}

/** The message fields the hooks read, without committing to the host's branded types. */
interface HookMessage {
  role?: unknown;
  content?: unknown;
}

/** The subset of the `context`/`compaction` hook event this plugin touches. */
interface RequestEvent {
  sessionID: string;
  system: Array<{ type: "text"; text: string }>;
  messages: readonly HookMessage[];
}

/** The `session.deleted` event shape, read defensively. */
interface SessionDeletedEvent {
  type?: unknown;
  data?: { sessionID?: unknown };
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    configureSettings(ctx.location.directory);
    const tunables: Tunables = resolveTunables();
    /** Resolved once: the environment and settings files do not change at runtime. */
    const store: StoreConfig | null = resolveStore(ctx.location.directory);

    const log = (message: string, ...rest: unknown[]): void => {
      if (!tunables.debug) return;
      const detail = rest.map((value) => (value instanceof Error ? value.message : String(value))).join(" ");
      console.error(`[yantrikdb] ${detail === "" ? message : `${message} ${detail}`}`);
    };

    const safe = async <T>(label: string, fn: () => Promise<T> | T): Promise<T | undefined> => {
      try {
        return await fn();
      } catch (error) {
        log(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    };

    // ── store ──────────────────────────────────────────────────────────────

    let client: YantrikClient | null = null;
    const ensureClient = (): YantrikClient | null => {
      if (client) return client;
      if (!store) return null;
      client = new YantrikClient({
        nodes: store.nodes,
        token: store.token,
        timeoutMs: tunables.httpTimeoutMs,
        unreachableTtlMs: tunables.unreachableTtlMs,
        log,
        stateDir: stateRootDir(),
      });
      log(`store: ${store.nodes.join(",")} (token ${store.token === "" ? "empty" : "set"})`);
      return client;
    };

    /** Disposables collected during setup; all are torn down on unload. */
    const registrations: Array<{ dispose: () => Promise<void> }> = [];

    /** Register the store's MCP server unless the user already declared one. */
    const mcpRegistration = await safe("mcp", () =>
      ctx.mcp.transform((editor) => {
        if (editor.get(MCP_SERVER_NAME)) {
          log("mcp: yantrikdb already declared, leaving it");
          return;
        }
        const config: Mcp.ServerConfig = { type: "local", command: ["yantrikdb-mcp"] };
        editor.set(
          MCP_SERVER_NAME,
          store
            ? {
                ...config,
                environment: { YANTRIKDB_SERVER_URL: store.nodes.join(","), YANTRIKDB_TOKEN: store.token },
              }
            : config,
        );
      }),
    );
    if (mcpRegistration) registrations.push(mcpRegistration);

    // ── per-session state ──────────────────────────────────────────────────

    const states = new Map<string, SessionState>();
    /** In-flight loads, so concurrent hooks for one session share a single state object. */
    const stateLoads = new Map<string, Promise<SessionState>>();
    /** Rendered boot digest per session: fetched once, re-injected on every user turn. */
    const digestCache = new Map<string, string>();
    /** Sessions with a tracked-session open in flight, to avoid a double `sessionStart`. */
    const tracking = new Set<string>();

    const ensureState = (sessionID: string): Promise<SessionState> => {
      const cached = states.get(sessionID);
      if (cached) return Promise.resolve(cached);
      const inflight = stateLoads.get(sessionID);
      if (inflight) return inflight;
      const promise = (async () => {
        const raw = await safe("storage.get", () => ctx.storage.get(stateKey(sessionID)));
        const restored = restoreState(raw) ?? { ...EMPTY_STATE, namespace: tunables.namespace };
        states.set(sessionID, restored);
        stateLoads.delete(sessionID);
        return restored;
      })();
      stateLoads.set(sessionID, promise);
      return promise;
    };

    const persistState = async (sessionID: string, state: SessionState): Promise<void> => {
      states.set(sessionID, state);
      await safe("storage.set", () => ctx.storage.set(stateKey(sessionID), toJson(state)));
    };

    const ensureTrackedSession = async (state: SessionState, sessionID: string): Promise<void> => {
      if (!tunables.trackSession || state.sessionId !== undefined) return;
      if (tracking.has(sessionID)) return;
      tracking.add(sessionID);
      try {
        const active = ensureClient();
        if (!active) return;
        // A session conflict — a previous session that never closed — is the realistic
        // failure, so retry once with a session-unique client id.
        const id =
          (await active.sessionStart({ namespace: state.namespace, clientId: clientIdFor(sessionID) })) ??
          (await active.sessionStart({
            namespace: state.namespace,
            clientId: `${clientIdFor(sessionID)}-${Date.now().toString(36)}`,
          }));
        if (id !== null) {
          state.sessionId = id;
          log(`session: ${id}`);
        }
      } finally {
        tracking.delete(sessionID);
      }
    };

    const gate = {
      minSimilarity: tunables.minSimilarity,
      includeCaptured: tunables.recallCaptured,
      excludedNamespaces: tunables.excludedNamespaces,
    };

    /** Digest, then the broad-recall fallback when the store has nothing to brief on. */
    const buildDigestBlock = async (active: YantrikClient, namespace: string): Promise<string> => {
      const gaps = tunables.gaps ? await active.gaps({ minCount: 2, limit: MAX_GAPS }) : [];
      const digest = await active.digest({ namespace, includeGaps: tunables.gaps });
      let block = renderDigest(digest, gaps, namespace, {
        snippetChars: DIGEST_SNIPPET_CHARS,
        decisions: tunables.digestDecisions,
        maintenance: tunables.digestMaintenance,
        excludedNamespaces: tunables.excludedNamespaces,
      });
      if (block === "" && tunables.fallback) {
        const hits = (await active.recall({ query: RECENT_QUERY, topK: tunables.candidates, namespace })) ?? [];
        block = renderRecent(filterHits(hits, { ...gate, minSimilarity: 0 }).slice(0, tunables.recent), namespace);
      }
      if (tunables.saveNudge) block = block === "" ? `${DIGEST_SENTINEL}\n\n${SAVE_POLICY}` : `${block}\n\n${SAVE_POLICY}`;
      return block;
    };

    // ── hooks ──────────────────────────────────────────────────────────────

    /**
     * The `context` hook runs before every model call, including tool-loop continuations.
     * Memory is injected only when the last message is a fresh user turn, and only when a
     * block is not already present in `system` — the request is rebuilt per call, so a
     * sentinel check keeps the injection correct under either host semantics.
     */
    const handleContext = async (event: RequestEvent): Promise<void> => {
      const last = event.messages[event.messages.length - 1];
      if (!last || last.role !== "user") return;

      const active = ensureClient();
      if (!active) return;

      const state = await ensureState(event.sessionID);
      await ensureTrackedSession(state, event.sessionID);

      const inSystem = (sentinel: string): boolean =>
        event.system.some((part) => typeof part.text === "string" && part.text.includes(sentinel));

      const blocks: string[] = [];

      if (tunables.digest && !inSystem(DIGEST_SENTINEL)) {
        // Fetch once per session, re-inject the cached block on every turn: OpenCode
        // rebuilds `system` per model call, so a one-shot injection would vanish after
        // the first turn, while refetching every turn would burn the prompt path.
        let block = digestCache.get(event.sessionID);
        if (block === undefined) {
          block = await buildDigestBlock(active, state.namespace);
          digestCache.set(event.sessionID, block);
          state.digestSent = block !== "";
          log(`digest: ${block.length} chars`);
        }
        if (block !== "") blocks.push(block);
      }

      const query = collapse(extractText(last.content)).slice(0, tunables.recallQueryChars);
      const recallable = tunables.recall && query.length >= tunables.minPromptChars && !query.startsWith("/");
      if (recallable && !inSystem(RECALL_SENTINEL)) {
        const hits =
          (await active.recall({
            query,
            topK: tunables.candidates,
            namespace: state.namespace,
            timeoutMs: tunables.recallTimeoutMs,
          })) ?? [];
        const known = new Set(state.injectedRids);
        const kept = filterHits(hits, gate)
          .filter((hit) => hit.score >= tunables.minScore && !known.has(hit.rid))
          .sort((left, right) => right.score - left.score)
          .slice(0, tunables.topK);
        const block = renderRecallBlock(kept, state.namespace, tunables.recallBlockChars);
        if (block !== "") {
          blocks.push(block);
          state.injectedRids = mergeRids(
            state.injectedRids,
            kept.map((hit) => hit.rid),
          );
          log(`recall: ${kept.length} hits injected (rids ${kept.map((hit) => hit.rid).join(", ")})`);
        }
      }

      await persistState(event.sessionID, state);

      // Per call, not cached: it describes the turn that just ended.
      const note = tunables.saveNudge ? saveNote(event.messages, tunables.saveNudgeTools) : "";
      if (note !== "") blocks.push(note);
      if (blocks.length === 0) return;
      event.system.push({ type: "text", text: blocks.join("\n\n") });
    };

    /**
     * Pre-compaction capture: the one scheduled moment where context loss is certain.
     * Drafts atomized user turns via the engine; redacted first, line-watermarked so a
     * retried compaction never re-drafts.
     */
    const handleCompaction = async (event: RequestEvent): Promise<void> => {
      if (!tunables.capture) return;
      const active = ensureClient();
      if (!active) return;

      const state = await ensureState(event.sessionID);
      await ensureTrackedSession(state, event.sessionID);

      const lines = freshLines(collectTurnLines(event.messages, tunables.captureRoles), state.captured);
      if (lines.length === 0) return;
      // Marks are derived before the request is issued so a failed draft can retry the
      // same lines, and only committed once the server accepted them.
      const marks = lines.map(markOf);
      const blob = buildBlob(
        lines.map((line) => redact(line, tunables.redact)),
        tunables.captureChars,
      );
      if (blob.length < tunables.captureMinChars) {
        log(`capture skipped: ${blob.length} new chars`);
        return;
      }

      const result = await active.draft({
        summary: blob,
        namespace: state.namespace,
        domain: tunables.captureDomain,
        timeoutMs: tunables.captureTimeoutMs,
      });
      if (result === null) {
        log("capture: draft failed");
        return;
      }
      // At-least-once: if the draft succeeds but persistState fails (or two compactions
      // overlap), the same lines are re-drafted and the server sees duplicates. The
      // watermark makes the common path idempotent; this residual window is deliberate.
      state.captured = mergeMarks(state.captured, marks);
      await persistState(event.sessionID, state);
      log(`capture: drafted ${String(result["count"] ?? "?")}, marked ${marks.length} lines`);
    };

    registrations.push(
      await ctx.session.hook("context", (event) =>
        safe("context", () => handleContext(event as unknown as RequestEvent)),
      ),
      await ctx.session.hook("compaction", (event) =>
        safe("compaction", () => handleCompaction(event as unknown as RequestEvent)),
      ),
    );

    // ── session end via the event stream ───────────────────────────────────

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
          const event = raw as SessionDeletedEvent;
          if (event.type !== "session.deleted") continue;
          const sessionID = event.data?.sessionID;
          if (typeof sessionID !== "string") continue;
          // Fire-and-forget per event: sessionEnd/think can be slow, and awaiting inline
          // would queue every later event behind them. Cleanup runs regardless of failure.
          void safe("session.deleted", async () => {
            try {
              const state = states.get(sessionID) ?? restoreState(await ctx.storage.get(stateKey(sessionID)));
              if (state) {
                const active = ensureClient();
                if (active && state.sessionId !== undefined) {
                  log(`sessionEnd: ${(await active.sessionEnd(state.sessionId)) ? "ok" : "failed"}`);
                }
                if (active && tunables.maintenance) {
                  log(
                    `think: ${(await active.think(state.namespace, tunables.maintenanceTimeoutMs)) ? "ok" : "skipped"}`,
                  );
                }
              }
            } finally {
              states.delete(sessionID);
              stateLoads.delete(sessionID);
              digestCache.delete(sessionID);
              await safe("storage.remove", () => ctx.storage.remove(stateKey(sessionID)));
            }
          });
        }
      } catch (error) {
        log(`event stream ended: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();

    return async () => {
      controller.abort();
      for (const registration of registrations) {
        await safe("dispose", () => registration.dispose());
      }
    };
  },
});
