/**
 * Best-effort secret redaction for text that is about to become long-term memory.
 *
 * A pasted token would otherwise be stored verbatim and recalled into future sessions.
 * A conservative pass over well-known credential shapes — not a DLP engine. Ported
 * rule-for-rule from the Claude Code plugin's `hooks/lib/redact.py`; rule order is
 * load-bearing (structured multi-line shapes first, generic shapes last).
 */

const TOKEN = "[redacted token]";

interface Rule {
  pattern: RegExp;
  replacement: string;
}

const RULES: readonly Rule[] = [
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[redacted private key]",
  },
  { pattern: /(:\/\/[^/\s:@]+:)[^@\s/]+@/g, replacement: `$1[redacted]@` },
  { pattern: /\b(bearer)\s+[A-Za-z0-9._~+/=-]{20,}/gi, replacement: `$1 ${TOKEN}` },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: "[redacted jwt]" },
  { pattern: /\bydb_[0-9a-f]{32,}\b/g, replacement: TOKEN },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replacement: TOKEN },
  { pattern: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g, replacement: TOKEN },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[redacted aws key]" },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replacement: TOKEN },
  {
    pattern: /\b(api[_-]?key|secret|token|password|passwd|pwd)\b\s*[:=]\s*['"]?([^\s'",;]{8,})/gi,
    replacement: "$1=[redacted]",
  },
  { pattern: /\b[A-Fa-f0-9]{48,}\b/g, replacement: "[redacted hex]" },
];

/** `text` with credential-shaped substrings replaced; unchanged when disabled. */
export function redact(text: string, enabled: boolean): string {
  if (!enabled || text === "") return text;
  let out = text;
  for (const rule of RULES) out = out.replace(rule.pattern, rule.replacement);
  return out;
}
