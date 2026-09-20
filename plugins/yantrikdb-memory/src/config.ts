/**
 * Store coordinates and tunables.
 *
 * Coordinates come from the first source that yields a non-empty `YANTRIKDB_SERVER_URL`:
 * process env, the plugin's own settings file, then the MCP-shaped declarations the
 * harness and other agents on the machine already carry (OpenCode's `opencode.json(c)`,
 * `.mcp.json`, `~/.codex/config.toml`, `~/.claude.json`). The store is usually declared
 * somewhere already; the point of reading those sources is to share it.
 *
 * Tunables read `YANTRIKDB_OPENCODE_<NAME>` in the environment, then
 * `YANTRIKDB_HOOKS_<NAME>` (so one env block configures both this plugin and the Claude
 * Code hooks), then the settings file, then a default. An empty value counts as unset.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export interface StoreConfig {
  nodes: string[];
  token: string;
}

export type CaptureRole = "user" | "all";

export interface Tunables {
  namespace: string;
  recall: boolean;
  topK: number;
  minScore: number;
  minPromptChars: number;
  recallQueryChars: number;
  recallBlockChars: number;
  recallTimeoutMs: number;
  digest: boolean;
  gaps: boolean;
  recent: number;
  fallback: boolean;
  trackSession: boolean;
  capture: boolean;
  captureRoles: CaptureRole;
  captureChars: number;
  captureMinChars: number;
  captureDomain: string;
  captureTimeoutMs: number;
  maintenance: boolean;
  maintenanceTimeoutMs: number;
  redact: boolean;
  httpTimeoutMs: number;
  unreachableTtlMs: number;
  debug: boolean;
}

const MCP_SERVER = "yantrikdb";

/** The OpenCode config directory: `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`. */
export function configDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg.trim() !== "") return path.join(xdg, "opencode");
  return path.join(homedir(), ".config", "opencode");
}

/**
 * Settings documents, in ascending precedence:
 *
 * 1. `<configDir>/yantrikdb.json` — machine-wide.
 * 2. `<cwd>/.opencode/yantrikdb.json` — project.
 * 3. `<cwd>/.yantrikdb.json` — project, portable across tools.
 *
 * ```json
 * { "server": { "url": "http://host:7438", "token": "ydb_…" },
 *   "settings": { "NAMESPACE": "default", "TOP_K": 5, "DEBUG": true } }
 * ```
 *
 * `settings` keys are the bare tunable suffixes. Documents merge key by key, later files
 * winning, and are read once per process.
 */
export interface SettingsDocument {
  server: { url: string; token: string };
  settings: Record<string, string | number | boolean>;
}

/** Project directory whose settings files count as configuration. */
let searchRoot: string | undefined;

/**
 * Point the settings-file search at a project. Module-level state, safe only because
 * `setup` calls `configureSettings → resolveTunables → resolveStore` synchronously with
 * no `await` between them; a second plugin instance in the same process would otherwise
 * reset this under the first.
 */
export function configureSettings(cwd: string): void {
  if (searchRoot === cwd) return;
  searchRoot = cwd;
  cachedSettings = undefined;
}

export function settingsFilePaths(): string[] {
  const files = [path.join(configDir(), "yantrikdb.json")];
  if (searchRoot !== undefined && searchRoot !== "") {
    files.push(path.join(searchRoot, ".opencode", "yantrikdb.json"), path.join(searchRoot, ".yantrikdb.json"));
  }
  return files;
}

let cachedSettings: SettingsDocument | null | undefined;

function settingsDocument(): SettingsDocument | null {
  if (cachedSettings !== undefined) return cachedSettings;
  let document: SettingsDocument | null = null;
  for (const file of settingsFilePaths()) {
    const raw = readTextFile(file);
    if (raw === undefined) continue;
    try {
      const record = asRecord(JSON.parse(raw) as unknown);
      if (!record) continue;
      const merged: SettingsDocument = document ?? { server: { url: "", token: "" }, settings: {} };
      const server = asRecord(record["server"]);
      if (server) {
        const url = server["url"];
        const token = server["token"];
        if (typeof url === "string" && url !== "") merged.server.url = url;
        if (typeof token === "string" && token !== "") merged.server.token = token;
      }
      for (const [key, value] of Object.entries(asRecord(record["settings"]) ?? {})) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          merged.settings[key] = value;
        }
      }
      document = merged;
    } catch {
      // A malformed file is skipped, not fatal.
    }
  }
  cachedSettings = document;
  return document;
}

// ── env plumbing ────────────────────────────────────────────────────────────

/** `${NAME}` and OpenCode's `{env:NAME}` expansion, matching both config dialects. */
export function expandEnv(value: string): string {
  if (!value.includes("${") && !value.includes("{env:")) return value;
  return value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "")
    .replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "");
}

/**
 * `YANTRIKDB_OPENCODE_<suffix>` in the environment, then `YANTRIKDB_HOOKS_<suffix>`, then
 * the settings file's `settings` map. An empty value counts as unset at every level.
 */
function envRaw(suffix: string): string | undefined {
  for (const prefix of ["YANTRIKDB_OPENCODE_", "YANTRIKDB_HOOKS_"]) {
    const raw = process.env[`${prefix}${suffix}`];
    if (raw !== undefined && raw.trim() !== "") return raw;
  }
  const fromFile = settingsDocument()?.settings[suffix];
  if (typeof fromFile === "boolean" || typeof fromFile === "number") return String(fromFile);
  return typeof fromFile === "string" && fromFile.trim() !== "" ? fromFile : undefined;
}

/** `Number`, not `parseInt`: a unit-suffixed value ("5000ms") falls back instead of silently truncating. */
function envNumber(suffix: string, fallback: number): number {
  const raw = envRaw(suffix);
  if (raw === undefined) return fallback;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : fallback;
}

function envFlag(suffix: string, fallback: boolean): boolean {
  const raw = envRaw(suffix);
  if (raw === undefined) return fallback;
  return !/^(?:0|false|no|off)$/i.test(raw.trim());
}

export function resolveTunables(): Tunables {
  const roles = envRaw("CAPTURE_ROLES")?.trim().toLowerCase();
  return {
    namespace: envRaw("NAMESPACE")?.trim() || "default",
    recall: envFlag("RECALL", true),
    topK: envNumber("TOP_K", 5),
    minScore: envNumber("MIN_SCORE", 0.1),
    minPromptChars: envNumber("MIN_PROMPT_CHARS", 24),
    recallQueryChars: envNumber("RECALL_QUERY_CHARS", 400),
    recallBlockChars: envNumber("RECALL_BLOCK_CHARS", 4000),
    // The store's first recall after a cold start measured over a second; this sits above
    // the cold path while staying within a reasonable per-prompt budget.
    recallTimeoutMs: envNumber("RECALL_TIMEOUT_MS", 2500),
    digest: envFlag("DIGEST", true),
    gaps: envFlag("GAPS", true),
    recent: envNumber("RECENT", 6),
    fallback: envFlag("FALLBACK", true),
    trackSession: envFlag("TRACK_SESSION", true),
    capture: envFlag("CAPTURE", true),
    captureRoles: roles === "all" ? "all" : "user",
    captureChars: envNumber("CAPTURE_CHARS", 6000),
    captureMinChars: envNumber("CAPTURE_MIN_CHARS", 200),
    captureDomain: envRaw("CAPTURE_DOMAIN")?.trim() || "work",
    // Bounded like the recall path: a capture that exceeds it is abandoned cleanly and
    // retried on the next compaction instead of dangling.
    captureTimeoutMs: envNumber("CAPTURE_TIMEOUT_MS", 4000),
    // The server-side hygiene cycle is slow by nature (~20s against a few hundred
    // memories), so shutdown maintenance is off by default: opt in only where
    // `POST /v1/think` answers quickly, or run it from cron.
    maintenance: envFlag("MAINTENANCE", false),
    // Generous by design: the caller bounds `think`, and the default request timeout
    // (5s) is far below the observed cycle time, so maintenance would always abort.
    maintenanceTimeoutMs: envNumber("MAINTENANCE_TIMEOUT_MS", 30_000),
    redact: envFlag("REDACT", true),
    httpTimeoutMs: envNumber("HTTP_TIMEOUT_MS", 5000),
    unreachableTtlMs: envNumber("UNREACHABLE_TTL_MS", 60_000),
    debug: envFlag("DEBUG", false),
  };
}

// ── coordinate sources ──────────────────────────────────────────────────────

/** Type guard; the narrowing is the contract, so this stays a function. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readTextFile(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Strip JSONC line/block comments and trailing commas outside strings. */
export function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let index = 0; index < text.length; index++) {
    const ch = text[index] ?? "";
    const next = text[index + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        index++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        index++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      index++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      index++;
      continue;
    }
    // Trailing commas are only invalid outside strings, so strip one before a closer
    // here (where string state is known) rather than with a global regex that would
    // also corrupt a string literal containing ", }".
    if (ch === "}" || ch === "]") {
      out = out.replace(/,(\s*)$/, "$1");
    }
    out += ch;
  }
  return out;
}

/** Parsed JSON/JSONC document, or `undefined` when missing, unreadable, or malformed. */
export function readJsonDocument(file: string): unknown | undefined {
  const text = readTextFile(file);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(stripJsonc(text));
  } catch {
    return undefined;
  }
}

/** The YANTRIKDB_* env entries from an MCP server declaration, across both config dialects. */
function envFromDocument(document: unknown, server: string): Record<string, string> | undefined {
  const root = asRecord(document);
  const serverEntry =
    asRecord(asRecord(root?.["mcp"])?.["servers"])?.[server] ??
    asRecord(root?.["mcpServers"])?.[server] ??
    asRecord(root?.["mcp"])?.[server];
  const entry = asRecord(serverEntry);
  if (!entry) return undefined;
  const env = asRecord(entry["environment"]) ?? asRecord(entry["env"]);
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** Cut an unquoted `#` comment. Quote-aware, so a `#` inside a value survives. */
function stripComment(line: string): string {
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inDouble) {
      if (ch === "\\") i++;
      else if (ch === '"') inDouble = false;
    } else if (inSingle) {
      if (ch === "'") inSingle = false;
    } else if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

/**
 * Read only the `[mcp_servers.<server>.env]` table: `KEY = "value"` lines until the next
 * table header. Returns `null` when the header is absent. Not a general TOML parser — it
 * covers the one table that carries store coordinates.
 */
export function readTomlEnv(contents: string, server: string): Record<string, string> | null {
  const header = `[mcp_servers.${server}.env]`;
  const out: Record<string, string> = {};
  let inside = false;
  let found = false;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (line === "") continue;
    if (line.startsWith("[")) {
      if (inside) break;
      if (line === header) {
        inside = true;
        found = true;
      }
      continue;
    }
    if (!inside) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (key === "") continue;
    out[key] = unquote(line.slice(eq + 1).trim());
  }
  return found ? out : null;
}

function storeFromEnv(env: Record<string, string> | undefined): StoreConfig | null {
  if (!env) return null;
  const nodes = expandEnv(env["YANTRIKDB_SERVER_URL"] ?? "")
    .split(",")
    .map((node) => node.trim().replace(/\/+$/, ""))
    .filter((node) => node !== "");
  if (nodes.length === 0) return null;
  return { nodes, token: expandEnv(env["YANTRIKDB_TOKEN"] ?? "") };
}

function storeFromSettingsFile(): StoreConfig | null {
  const document = settingsDocument();
  if (!document) return null;
  return storeFromEnv({ YANTRIKDB_SERVER_URL: document.server.url, YANTRIKDB_TOKEN: document.server.token });
}

function storeFromJsonFile(file: string): StoreConfig | null {
  return storeFromEnv(envFromDocument(readJsonDocument(file), MCP_SERVER));
}

function storeFromTomlFile(file: string): StoreConfig | null {
  const text = readTextFile(file);
  if (text === undefined) return null;
  return storeFromEnv(readTomlEnv(text, MCP_SERVER) ?? undefined);
}

/** `~/.claude.json`: the current project's server entry first, then the top-level one. */
function storeFromClaudeJson(file: string, cwd: string): StoreConfig | null {
  const document = readJsonDocument(file);
  if (document === undefined) return null;
  const project = asRecord(asRecord(document)?.["projects"])?.[cwd];
  return storeFromEnv(envFromDocument(project, MCP_SERVER)) ?? storeFromEnv(envFromDocument(document, MCP_SERVER));
}

/**
 * First source that yields a non-empty `YANTRIKDB_SERVER_URL` wins: process env, the
 * plugin's own settings file, the project's OpenCode and MCP configs, the global OpenCode
 * config, then the coordinates other agents on the machine already carry.
 *
 * `cwd` is the location the plugin was loaded for; project-scoped sources read from it.
 */
export function resolveStore(cwd: string): StoreConfig | null {
  const home = homedir();
  const config = configDir();
  const sources: Array<() => StoreConfig | null> = [
    () =>
      storeFromEnv({
        YANTRIKDB_SERVER_URL: process.env["YANTRIKDB_SERVER_URL"] ?? "",
        YANTRIKDB_TOKEN: process.env["YANTRIKDB_TOKEN"] ?? "",
      }),
    () => storeFromSettingsFile(),
    () => storeFromJsonFile(path.join(cwd, "opencode.jsonc")),
    () => storeFromJsonFile(path.join(cwd, "opencode.json")),
    () => storeFromJsonFile(path.join(cwd, ".opencode", "opencode.jsonc")),
    () => storeFromJsonFile(path.join(cwd, ".opencode", "opencode.json")),
    () => storeFromJsonFile(path.join(cwd, ".mcp.json")),
    () => storeFromJsonFile(path.join(config, "opencode.jsonc")),
    () => storeFromJsonFile(path.join(config, "opencode.json")),
    () => storeFromTomlFile(path.join(home, ".codex", "config.toml")),
    () => storeFromClaudeJson(path.join(home, ".claude.json"), cwd),
  ];
  for (const source of sources) {
    const store = source();
    if (store) return store;
  }
  return null;
}

/**
 * Writable scratch directory for the unreachable marker.
 *
 * The OpenCode server runs with normal filesystem access, but a locked-down or
 * containerised config dir can still fail; the first candidate that can be created wins
 * and the system temp directory is the last resort. This runs once per process.
 */
export function stateRootDir(): string {
  const candidates = [path.join(configDir(), "cache", "yantrikdb-opencode"), path.join(tmpdir(), "yantrikdb-opencode")];
  for (const candidate of candidates) {
    try {
      mkdirSync(candidate, { recursive: true });
      return candidate;
    } catch {
      // try the next one
    }
  }
  return candidates[candidates.length - 1] ?? tmpdir();
}

/** Stable per-session client id: the server keys a live session on (namespace, client_id). */
export function clientIdFor(sessionId: string): string {
  const slug = sessionId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return `opencode-${slug === "" ? "session" : slug}`;
}
