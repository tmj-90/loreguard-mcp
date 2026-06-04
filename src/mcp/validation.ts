/**
 * MCP input-length guards for fields that have a hard cap but used to
 * fail through zod's `.max()` validator. The zod path surfaced
 * "body is undefined" upstream when summary parse failed — the actual
 * cause was masked and agents gave up silently. These helpers replace
 * that with an actionable JSON response the agent can correct against
 * without a human round-trip:
 *
 *     { error: "summary_too_long", provided: 812, max: 800,
 *       suggested_cut: "<800-char truncation ending in '…'>",
 *       hint: "Retry with a shorter summary; body has no length limit." }
 *
 * Body length is deliberately uncapped — body is not returned in search
 * hits, only via `get_lore` on demand, so cost is opt-in. The cap on
 * title and summary protects the search-result payload size every
 * agent call pays for.
 */

export const LENGTH_CAPS = {
  title: 200,
  summary: 800,
  /** report_conflict.observation — mirrors the summary cap. */
  observation: 800,
  /** record_absence.query / reason — short free-text. */
  query: 500,
  reason: 500,
} as const;

export type LengthCappedField = keyof typeof LENGTH_CAPS;

export interface TooLongError {
  readonly error: `${LengthCappedField}_too_long`;
  readonly provided: number;
  readonly max: number;
  /**
   * A draft truncation the agent can use as-is or as a starting point.
   * Exactly `max` chars in length: `max - 1` chars sliced from the
   * input, then a single-character ellipsis (`…`, U+2026). The agent
   * doesn't have to re-tokenise; it can just paste this back.
   */
  readonly suggested_cut: string;
  readonly hint: string;
}

/**
 * Check whether `value` fits within the cap for `field`. Returns `null`
 * (caller proceeds) when it fits; returns a `TooLongError` shape
 * otherwise — caller returns this verbatim to the agent and logs the
 * audit row.
 *
 * Boundary: `value.length === max` PASSES (returns null). Only
 * `value.length > max` triggers the error. Length is JS string length
 * (UTF-16 code units), consistent with the previous zod schema.
 */
export function checkLength(
  field: LengthCappedField,
  value: string,
): TooLongError | null {
  const max = LENGTH_CAPS[field];
  if (value.length <= max) return null;
  const suggested_cut = value.slice(0, max - 1) + "…";
  return {
    error: `${field}_too_long`,
    provided: value.length,
    max,
    suggested_cut,
    hint:
      field === "summary"
        ? "Retry with a shorter summary; body has no length limit."
        : "Retry with a shorter title; the summary cap is 800 chars and body has no length limit.",
  };
}

/**
 * Format the one-line string the audit log records when a too-long
 * input is rejected. Greppable shape: `"<field>_too_long: <n> > <max>"`.
 */
export function auditMessageForTooLong(err: TooLongError): string {
  return `${err.error}: ${err.provided} > ${err.max}`;
}

/**
 * Structured validation failure returned to the agent for ANY bad input
 * — missing required field, empty/whitespace string, over-cap length,
 * malformed URL, bad enum. Same philosophy as `TooLongError`: the
 * response is well-formed (NOT `isError`), names the offending field,
 * and tells the agent exactly how to fix it so it can self-correct
 * without a human round-trip.
 *
 * Why this exists: the MCP SDK validates the tool's zod `inputSchema`
 * BEFORE our handler runs, and on failure returns an opaque
 * `-32602 Input validation error` with a raw zod dump (e.g.
 * `path: ["body"], received: undefined`). Agents burned many retries
 * trying to "fix the body" when the real issue was a missing field or a
 * bad URL elsewhere. By keeping the schema lenient (every field optional)
 * and validating in the handler, every failure becomes one of these.
 */
export interface FieldError {
  readonly error: string;
  /** The field the agent must fix. */
  readonly field: string;
  readonly hint: string;
  /** Present for length failures so the agent can paste a corrected value. */
  readonly suggested_cut?: string;
  readonly provided?: number;
  readonly max?: number;
}

/** A required free-text field is missing, null, or whitespace-only. */
export function requireNonEmptyString(
  field: string,
  value: unknown,
): FieldError | null {
  if (typeof value === "string" && value.trim().length > 0) return null;
  return {
    error: `${field}_required`,
    field,
    hint: `\`${field}\` is required and must be a non-empty string. You sent ${describeValue(value)}.`,
  };
}

/**
 * An optional field, when present, must be an http(s) URL. Mirrors the
 * core `assertHttpUrl` contract but returns a structured error instead of
 * throwing. Absent / empty is fine (optional).
 */
export function checkOptionalHttpUrl(
  field: string,
  value: unknown,
): FieldError | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    return {
      error: `${field}_invalid_url`,
      field,
      hint: `\`${field}\` must be an http(s) URL string if provided.`,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return {
      error: `${field}_invalid_url`,
      field,
      hint: `\`${field}\` is not a valid URL. Provide a full http(s) permalink (PR / ADR / commit / incident), or omit it.`,
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      error: `${field}_invalid_url`,
      field,
      hint: `\`${field}\` must be http(s) (got ${parsed.protocol}). Provide a web URL or omit it.`,
    };
  }
  return null;
}

/**
 * An optional enum field, when present, must be one of `allowed`.
 */
export function checkOptionalEnum(
  field: string,
  value: unknown,
  allowed: ReadonlyArray<string>,
): FieldError | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && allowed.includes(value)) return null;
  return {
    error: `${field}_invalid`,
    field,
    hint: `\`${field}\` must be one of: ${allowed.join(", ")} (or omit it). You sent ${describeValue(value)}.`,
  };
}

/** Convert a `TooLongError` into the unified `FieldError` shape. */
export function tooLongToFieldError(field: string, err: TooLongError): FieldError {
  return {
    error: err.error,
    field,
    provided: err.provided,
    max: err.max,
    suggested_cut: err.suggested_cut,
    hint: err.hint,
  };
}

/** Greppable audit string for a structured field error. */
export function auditMessageForFieldError(err: FieldError): string {
  return err.provided !== undefined && err.max !== undefined
    ? `${err.error}: ${err.provided} > ${err.max}`
    : err.error;
}

function describeValue(value: unknown): string {
  if (value === undefined) return "nothing (field omitted)";
  if (value === null) return "null";
  if (typeof value === "string") {
    return value.length === 0 ? "an empty string" : `a ${typeof value}`;
  }
  return `a ${typeof value}`;
}
