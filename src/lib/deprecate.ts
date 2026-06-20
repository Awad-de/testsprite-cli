/**
 * Shared helper for the hidden, deprecated command aliases introduced by the
 * setup consolidation (`init`/`auth configure`/`auth whoami`/`auth logout`).
 *
 * The aliases are hidden from `--help` (so a coding agent never sees the old
 * names) but still work (so existing scripts and any agent trained on the old
 * commands keep running). When invoked, they print this one-line notice to
 * stderr — stdout stays clean so JSON pipelines are unaffected.
 */
export function emitDeprecationNotice(
  oldCmd: string,
  newCmd: string,
  stderr: (line: string) => void = (line: string) => process.stderr.write(`${line}\n`),
): void {
  stderr(`[deprecated] \`testsprite ${oldCmd}\` is deprecated — use \`testsprite ${newCmd}\`.`);
}
