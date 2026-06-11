/**
 * Shared error rendering helpers for `src/index.ts`.
 *
 * Extracted so the output-interceptor rephrasing logic (P10) is
 * unit-testable without spawning a full CLI process.
 */

/**
 * Global flags that belong before the subcommand, not after it.
 *
 * `boolean` flags (--dry-run, --debug, --verbose) take no value; emit
 * example without a placeholder. `value` flags (--output, --profile,
 * --endpoint-url) take a single argument; emit example with `<value>`.
 */
const GLOBAL_FLAG_ARITY: Record<string, 'boolean' | 'value'> = {
  'dry-run': 'boolean',
  output: 'value',
  profile: 'value',
  'endpoint-url': 'value',
  debug: 'boolean',
  verbose: 'boolean',
};

/**
 * Rephrase Commander's "unknown option '--foo'" error when `--foo` is
 * a known global flag that was placed after the subcommand.
 *
 * Returns the rephrased string when the pattern matches, or `null` when
 * it is an ordinary unknown flag that should fall through to the original
 * Commander output.
 */
export function rephraseUnknownOption(raw: string): string | null {
  // Commander emits: "error: unknown option '--foo'"
  const match = /unknown option\s+'--([^']+)'/.exec(raw);
  if (!match) return null;
  const name = match[1]!;
  const arity = GLOBAL_FLAG_ARITY[name];
  if (arity === undefined) return null;
  const example =
    arity === 'value'
      ? `testsprite --${name} <value> <subcommand> ...`
      : `testsprite --${name} <subcommand> ...`;
  return (
    `error: '--${name}' is a global flag; place it before the subcommand.\n` + `Example: ${example}`
  );
}
