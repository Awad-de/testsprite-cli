/**
 * Shared V3-routing text surfaces for `auth status` and `doctor`.
 *
 * `v3Enabled` on the `/me` response is the authoritative routing bit. When it
 * is on, some commands behave differently while the V3 gaps stay open — the
 * advisory names them. Copy lives here so both commands stay in sync.
 */

/** One-word routing label for the text card. */
export function routingLabel(v3Enabled: boolean): 'v3' | 'v2' {
  return v3Enabled ? 'v3' : 'v2';
}

/** Consolidated advisory (stderr) emitted when V3 routing is on. */
export const V3_ROUTING_ADVISORY: string[] = [
  '[advisory] V3 routing is on for this account. While these gaps are open:',
  '  - `test cancel` may return 404',
  '  - `test delete` may leave a zombie run',
  '  - `--target-url` is ignored on frontend runs',
];

/** Write the advisory to a stderr sink, one line per call. */
export function emitV3RoutingAdvisory(stderr: (line: string) => void): void {
  for (const line of V3_ROUTING_ADVISORY) stderr(line);
}
