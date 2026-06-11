/**
 * Shared `HttpClient` factory used by every M2 command. Two reasons for
 * the extraction:
 *
 *  1. Three command files (`auth`, `project`, `test`) had byte-equivalent
 *    `makeClient` helpers — drift between them would silently change
 *    behavior depending on which command you called.
 *  2. P6's `--dry-run` branch needs to bypass `loadConfig` (so it works
 *    with no `~/.testsprite/credentials`) and substitute a canned-fetch
 *    impl. Doing that once here is safer than three near-copies.
 *
 * The factory is intentionally narrow: it only takes the HTTP-relevant
 * deps. Per-command deps (auth's `prompt`, test's `rawStdout`) stay
 * with the command.
 */
import { loadConfig } from './config.js';
import { defaultCredentialsPath } from './credentials.js';
import { ApiError } from './errors.js';
import { facadeBaseUrl } from './facade.js';
import type { DebugEvent, FetchImpl } from './http.js';
import {
  HttpClient,
  REQUEST_TIMEOUT_DEFAULT_MS,
  REQUEST_TIMEOUT_MAX_MS,
  REQUEST_TIMEOUT_MIN_MS,
} from './http.js';
import type { OutputMode } from './output.js';
import { createDryRunFetch } from './dry-run/fetch.js';

export interface CommonOptions {
  profile: string;
  output: OutputMode;
  endpointUrl?: string;
  debug: boolean;
  /**
   * When true: emit human-readable transition messages (HTTP retry, rate-limit,
   * polling-mode switch) to stderr without the full debug JSON firehose.
   * Sits between the default (silent retries) and `--debug` (full trace).
   */
  verbose?: boolean;
  /**
   * When true: skip credential read, skip the network, return canned
   * samples per `src/lib/dry-run/samples.ts`. The CLI binary still
   * runs all argument validation, output formatting, and exit-code
   * mapping, so dry-run output is byte-identical to a real success
   * response (modulo the data values being canned).
   *
   * Optional so legacy call sites (P1–P5 tests) don't need to pass
   * `false` everywhere — undefined is treated as `false`.
   */
  dryRun?: boolean;
  /**
   * Per-request wall-clock timeout in milliseconds. Applied to every
   * outgoing fetch call. Defaults to {@link REQUEST_TIMEOUT_DEFAULT_MS}
   * (120 000 ms). Set via `--request-timeout <s>` flag (seconds) or
   * `TESTSPRITE_REQUEST_TIMEOUT_MS` env var (milliseconds).
   *
   * Precedence: `--request-timeout` flag > `TESTSPRITE_REQUEST_TIMEOUT_MS`
   * env var > default (120s).
   *
   * Clamped to [{@link REQUEST_TIMEOUT_MIN_MS}, {@link REQUEST_TIMEOUT_MAX_MS}].
   */
  requestTimeoutMs?: number;
}

export interface ClientFactoryDeps {
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  fetchImpl?: FetchImpl;
  stderr?: (line: string) => void;
}

/**
 * The fake API key used in dry-run. Never sent — the dry-run fetch
 * impl ignores headers and returns a canned sample. Documented in the
 * runbook so secret-scanners don't flag it as a leak.
 */
export const DRY_RUN_API_KEY = 'sk-user-DRY-RUN';

const DRY_RUN_DEFAULT_ENDPOINT = 'https://api.testsprite.com';

/** Stable banner text. Snapshot tests assert on this string. */
export const DRY_RUN_BANNER = '[dry-run] sample response — not from the server';

/**
 * Emit the dry-run banner to stderr. Idempotent per process — the
 * banner prints only on the first call so scripts that run several
 * commands sequentially under one shell don't drown in repeats. The
 * gate is reset by {@link resetDryRunBannerForTesting} for unit tests.
 */
let bannerEmitted = false;

export function emitDryRunBanner(stderr: (line: string) => void): void {
  if (bannerEmitted) return;
  bannerEmitted = true;
  stderr(DRY_RUN_BANNER);
}

export function resetDryRunBannerForTesting(): void {
  bannerEmitted = false;
}

/**
 * Resolve per-request timeout in milliseconds.
 *
 * Precedence: `--request-timeout` flag (already converted to ms by the caller)
 * > `TESTSPRITE_REQUEST_TIMEOUT_MS` env var > default (120s).
 *
 * The flag is supplied in seconds (consistent with `--timeout`); the caller
 * multiplies by 1000 before storing in `opts.requestTimeoutMs`. The env var
 * is in milliseconds to give scripts sub-second granularity and match the
 * typical convention for `*_MS` env vars.
 *
 * Values are clamped to [REQUEST_TIMEOUT_MIN_MS, REQUEST_TIMEOUT_MAX_MS];
 * values below the minimum are raised to 1s, values above the maximum are
 * lowered to 10m — both silently (no exit 5), since this is a tuning knob,
 * not a safety-critical gate.
 */
export function resolveRequestTimeoutMs(
  opts: Pick<CommonOptions, 'requestTimeoutMs'>,
  env: NodeJS.ProcessEnv,
): number {
  // Flag (already in ms) takes precedence.
  if (opts.requestTimeoutMs !== undefined) {
    return clampRequestTimeout(opts.requestTimeoutMs);
  }
  // Env var (milliseconds).
  const envRaw = env.TESTSPRITE_REQUEST_TIMEOUT_MS;
  if (envRaw !== undefined) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return clampRequestTimeout(parsed);
    }
  }
  return REQUEST_TIMEOUT_DEFAULT_MS;
}

function clampRequestTimeout(ms: number): number {
  return Math.min(Math.max(Math.round(ms), REQUEST_TIMEOUT_MIN_MS), REQUEST_TIMEOUT_MAX_MS);
}

export function makeHttpClient(opts: CommonOptions, deps: ClientFactoryDeps = {}): HttpClient {
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const env = deps.env ?? process.env;
  const requestTimeoutMs = resolveRequestTimeoutMs(opts, env);

  if (opts.dryRun) {
    emitDryRunBanner(stderr);
    return new HttpClient({
      baseUrl: facadeBaseUrl(opts.endpointUrl ?? DRY_RUN_DEFAULT_ENDPOINT),
      apiKey: DRY_RUN_API_KEY,
      fetchImpl: deps.fetchImpl ?? createDryRunFetch(),
      onDebug: opts.debug ? (event: DebugEvent) => stderr(formatDryRunDebug(event)) : undefined,
      onTransition: opts.verbose ? (msg: string) => stderr(`[verbose] ${msg}`) : undefined,
      requestTimeoutMs,
    });
  }

  const credentialsPath = deps.credentialsPath ?? defaultCredentialsPath();
  const config = loadConfig({
    profile: opts.profile,
    endpointUrl: opts.endpointUrl,
    env,
    credentialsPath,
  });
  if (!config.apiKey) throw ApiError.authRequired();
  return new HttpClient({
    baseUrl: facadeBaseUrl(config.apiUrl),
    apiKey: config.apiKey,
    fetchImpl: deps.fetchImpl,
    onDebug: opts.debug ? (event: DebugEvent) => stderr(formatDebug(event)) : undefined,
    onTransition: opts.verbose ? (msg: string) => stderr(`[verbose] ${msg}`) : undefined,
    requestTimeoutMs,
  });
}

function formatDebug(event: DebugEvent): string {
  return `[debug ${new Date().toISOString()}] ${JSON.stringify(event)}`;
}

function formatDryRunDebug(event: DebugEvent): string {
  return `[debug ${new Date().toISOString()}] ${JSON.stringify({ ...event, mode: 'dry-run' })}`;
}
