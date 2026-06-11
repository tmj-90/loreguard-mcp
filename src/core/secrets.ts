/**
 * Write-path secret guard. Loreguard records are pasted into agent context
 * on every search hit and committed to `.loreguard/` for `sync`, so a key
 * that lands in a record body leaks widely and quietly. This catches the
 * common "pasted a snippet that still had the token in it" accident before
 * it's stored.
 *
 * **Design constraint specific to this tool:** loreguard's whole job is
 * storing security *conventions* — "use Argon2id", "rotate creds every 90
 * days", "never log the auth header". Keyword detection ("password", "api
 * key", "secret") would fire on almost every legitimate record. So we match
 * ONLY well-known credential *formats* (provider-prefixed tokens, PEM key
 * blocks, JWTs) — structures that don't occur in prose about security. That
 * keeps false positives near zero, which is the only way a write-blocking
 * guard is tolerable here.
 */

export interface SecretFinding {
  /** Human label for the kind of credential matched. */
  readonly type: string;
  /** The match, masked to its shape — never the raw secret. */
  readonly redacted: string;
}

interface Rule {
  readonly type: string;
  readonly re: RegExp;
}

// Each pattern targets a credential whose *format* is unambiguous. Ordered
// most-specific first; `scanForSecrets` dedupes overlapping hits by span.
const RULES: ReadonlyArray<Rule> = [
  { type: "Private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { type: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g },
  { type: "GitHub fine-grained PAT", re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { type: "Slack token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { type: "Google API key", re: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
  { type: "Stripe live key", re: /\b[sr]k_live_[0-9A-Za-z]{24,}\b/g },
  { type: "OpenAI-style key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/g },
  { type: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
];

/**
 * Mask a matched secret so it can be shown in a warning without re-leaking
 * it: keep a short recognisable head, replace the rest with `…`. A PEM
 * header is already non-sensitive, so it's returned verbatim.
 */
function mask(match: string): string {
  if (match.startsWith("-----BEGIN")) return match;
  if (match.length <= 8) return match.slice(0, 2) + "…";
  return match.slice(0, 6) + "…" + `(${match.length} chars)`;
}

/**
 * Scan free text for credential-shaped strings. Returns one finding per
 * distinct match span, deduped (a token matched by two rules reports once,
 * under the first/most-specific rule). Empty array = clean.
 */
export function scanForSecrets(text: string): SecretFinding[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: SecretFinding[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      const value = m[0];
      if (seen.has(value)) continue;
      seen.add(value);
      out.push({ type: rule.type, redacted: mask(value) });
    }
  }
  return out;
}

/**
 * Scan the user-supplied fields of a record (title / summary / body) as a
 * single unit. Convenience for the write paths so they don't each have to
 * concatenate. Source/tags/repos are structured / URL-validated elsewhere
 * and not scanned.
 */
export function scanLoreFields(fields: {
  title?: string;
  summary?: string;
  body?: string;
}): SecretFinding[] {
  return scanForSecrets(
    [fields.title, fields.summary, fields.body].filter(Boolean).join("\n"),
  );
}
