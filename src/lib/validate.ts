/**
 * Thin internal validation helpers shared across JSON-body validation
 * paths (assertPlanShape, assertPlanStepsShape, and future agent-facing
 * JSON input). Implemented with valibot (tree-shakeable, ~1.5 KB gzipped)
 * for structural detection; error envelope construction delegates to the
 * existing `localValidationError` helper so wording and exit codes stay
 * consistent with the rest of the CLI.
 *
 * Design notes:
 *   - `kind` defaults to `'field'` on every helper because these are all
 *     JSON body paths, not CLI flags. Pass `kind: 'flag'` when validating
 *     a real `--flag` value (e.g. in runList / runCreate input guards).
 *   - These helpers are assertion-style (`asserts value is T`) so
 *     TypeScript narrows the type at the call site without a cast.
 *   - Valibot is used purely as the structural detector (safeParse). Custom
 *     message strings are composed here so error envelope text matches the
 *     legacy inline checks byte-for-byte — never valibot's built-in messages.
 *   - Implements dogfood L625 option 2: valibot adoption on the plan-input
 *     path. Future schemas can use raw `v.object({...})` directly when
 *     more complex shape validation is needed.
 *
 * Precedence rules (documented here to prevent ambiguity):
 *   - `allowEmpty: true` overrides `minLength` — if `allowEmpty` is set,
 *     a zero-length string is always accepted regardless of `minLength`.
 *   - `allowEmpty: true` and `minLength > 0` are mutually exclusive in
 *     intent; the type system permits both but `allowEmpty` wins.
 */
import * as v from 'valibot';
import { localValidationError } from './errors.js';

/** Shared option bag for helpers that accept both flag and field paths. */
interface KindOpts {
  /** Controls how `nextAction` is phrased in the error envelope. */
  kind?: 'flag' | 'field';
}

/**
 * Assert that `value` is a string, throwing a typed VALIDATION_ERROR
 * envelope on failure.
 *
 * @param field       Field name (used in the error envelope `details.field`
 *                    and the `nextAction` line).
 * @param value       The raw value to check.
 * @param opts.kind   `'field'` (default) or `'flag'`.
 * @param opts.minLength  When set, rejects strings shorter than this length
 *                        (default: 1, i.e. non-empty unless allowEmpty).
 * @param opts.maxLength  When set, rejects strings longer than this length.
 * @param opts.allowEmpty When `true`, a zero-length string is accepted.
 *                        Overrides `minLength` — if both are set, the string
 *                        is accepted as long as it is a string (length ≥ 0).
 *                        Defaults to `false`. Whitespace-only strings (e.g.
 *                        `"   "`) are treated as empty when `allowEmpty` is
 *                        false — they are rejected the same as `""` so junk
 *                        records cannot reach the backend (dogfood P1 fix).
 */
export function requireString(
  field: string,
  value: unknown,
  opts: KindOpts & { minLength?: number; maxLength?: number; allowEmpty?: boolean } = {},
): asserts value is string {
  const { kind = 'field', allowEmpty = false, minLength, maxLength } = opts;

  // Structural check: must be a string.
  const typeResult = v.safeParse(v.string(), value);
  if (!typeResult.success) {
    throw localValidationError(
      field,
      'is required and must be a non-empty string',
      undefined,
      kind,
    );
  }

  // Whitespace-only rejection: a string composed solely of spaces/tabs/
  // newlines is treated as empty unless `allowEmpty` is set. This catches
  // cases like `--name "   "` that pass the type check but produce junk
  // records in the backend (dogfood P1 fix #1).
  if (!allowEmpty && typeof value === 'string' && value.trim().length === 0 && value.length > 0) {
    throw localValidationError(
      field,
      'is required and must be a non-empty string',
      undefined,
      kind,
    );
  }

  // Length lower bound. `allowEmpty` overrides `minLength` per the
  // documented precedence above.
  const effectiveMin = allowEmpty ? 0 : (minLength ?? 1);
  if (effectiveMin > 0) {
    const minResult = v.safeParse(v.pipe(v.string(), v.minLength(effectiveMin)), value);
    if (!minResult.success) {
      throw localValidationError(
        field,
        'is required and must be a non-empty string',
        undefined,
        kind,
      );
    }
  }

  // Length upper bound.
  if (maxLength !== undefined) {
    const maxResult = v.safeParse(v.pipe(v.string(), v.maxLength(maxLength)), value);
    if (!maxResult.success) {
      throw localValidationError(field, `must be at most ${maxLength} characters`, undefined, kind);
    }
  }
}

/**
 * Assert that `value` is one of the accepted enum members, throwing a
 * typed VALIDATION_ERROR envelope on failure.
 *
 * The error message format is:
 *   `must be one of: "v1", "v2", ...`
 *
 * with each accepted value quoted, comma-separated. This is the canonical
 * format for agent-facing JSON paths (dogfood L625 option 2).
 *
 * @param field     Field name used in the error envelope.
 * @param value     The raw value to check.
 * @param accepted  Tuple/array of the accepted string literals.
 * @param opts.kind `'field'` (default) or `'flag'`.
 */
export function requireEnum<T extends string>(
  field: string,
  value: unknown,
  accepted: readonly T[],
  opts: KindOpts = {},
): asserts value is T {
  const { kind = 'field' } = opts;

  // Use valibot picklist for structural detection. Custom message is
  // composed here so the envelope text is explicit and stable.
  const result = v.safeParse(v.picklist(accepted as [T, ...T[]]), value);
  if (!result.success) {
    const acceptedList = accepted.map(a => `"${a}"`).join(', ');
    throw localValidationError(field, `must be one of: ${acceptedList}`, [...accepted], kind);
  }
}

/**
 * Validate a caller-supplied `--idempotency-key` value before it is sent as
 * an HTTP header. The HTTP spec (RFC 7230) requires header values to be ASCII
 * printable characters (0x21–0x7E plus SP/HTAB). A value that contains
 * non-ASCII bytes causes Node's `fetch` to throw a `TypeError: ByteString`
 * exception at the transport layer, which surfaces as an opaque exit 10
 * UNAVAILABLE — completely unhelpful for the operator (dogfood P1 fix #2).
 *
 * Client-side rules enforced here:
 *   - 1–256 characters (inclusive)
 *   - All characters must be in the ASCII printable range (0x20–0x7E)
 *
 * On rejection throws a `VALIDATION_ERROR` (exit 5) with a clear message.
 * On `undefined` (auto-generated key path) this is a no-op.
 *
 * @param key  The raw flag value, or `undefined` when the key is auto-minted.
 */
export function assertIdempotencyKey(key: string | undefined): void {
  if (key === undefined) return;
  // ASCII-printable check: every codepoint must be in U+0020–U+007E (space through tilde).
  // Non-ASCII chars (codepoint > 127) trigger a TypeError in Node's fetch ByteString header.
  if (key.length === 0 || !/^[ -~]+$/.test(key)) {
    throw localValidationError(
      'idempotencyKey',
      'must be 1–256 printable ASCII characters (no non-ASCII, control chars, or empty string)',
      undefined,
      'flag',
    );
  }
  if (key.length > 256) {
    throw localValidationError(
      'idempotencyKey',
      'must be at most 256 characters',
      undefined,
      'flag',
    );
  }
}

/**
 * Assert that `arr` is an Array and that its length is within the given
 * bounds, throwing a typed VALIDATION_ERROR envelope on failure.
 *
 * @param field        Field name used in the error envelope.
 * @param arr          The raw value to check.
 * @param opts.min     Minimum length (inclusive). Defaults to 0.
 * @param opts.max     Maximum length (inclusive). Omit for no upper cap.
 * @param opts.kind    `'field'` (default) or `'flag'`.
 * @param opts.itemNoun Singular noun used in min/max messages (e.g. `'step'`).
 *                     Defaults to `'item'`. The helper pluralises to `<noun>s`
 *                     for the max message.
 */
export function requireArrayLength(
  field: string,
  arr: unknown,
  opts: KindOpts & { min?: number; max?: number; itemNoun?: string },
): asserts arr is unknown[] {
  const { kind = 'field', min = 0, max, itemNoun = 'item' } = opts;

  // Structural check: must be an array.
  const typeResult = v.safeParse(v.array(v.unknown()), arr);
  if (!typeResult.success) {
    throw localValidationError(field, 'is required and must be an array', undefined, kind);
  }

  const arrVal = arr as unknown[];

  // Lower bound.
  if (arrVal.length < min) {
    const minLabel = min === 1 ? `one ${itemNoun}` : `${min} ${itemNoun}s`;
    throw localValidationError(field, `must contain at least ${minLabel}`, undefined, kind);
  }

  // Upper bound.
  if (max !== undefined && arrVal.length > max) {
    throw localValidationError(
      field,
      `must contain at most ${max} ${itemNoun}s (got ${arrVal.length})`,
      undefined,
      kind,
    );
  }
}
