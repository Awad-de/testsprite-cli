/**
 * MSW handlers for the `/api/cli/v1` mock backend.
 *
 * Two layers:
 *
 *  1. {@link defaultHandlers} — all M2 endpoints serve the documented
 *     happy-path responses from the CLI OpenAPI spec. Use this when a
 *     test wants the server to "just work" so the test can focus on
 *     CLI behavior.
 *
 *  2. {@link errorHandlers} — per-code overrides that return canonical
 *     error envelopes from the CLI error spec §2. Use these via
 *     `server.use(errorHandlers.authInvalid)` to assert that the CLI
 *     exits and prints correctly for each error class.
 *
 * Both layers require an `x-api-key` header on every non-/me request;
 * the absence of a key short-circuits to `AUTH_REQUIRED` so the auth
 * loop is testable end-to-end without per-test boilerplate.
 *
 * The mock base URL is `https://api.testsprite.com/api/cli/v1`
 * (dev environment, per the OpenAPI server list). Tests that need a
 * different base URL should pass it through {@link buildHandlers}.
 */

import { http, HttpResponse } from 'msw';
import {
  failureContextFixture,
  failureContextNoAnalysisFixture,
  FIXTURE_PROJECT_ID,
  FIXTURE_PROJECT_ID_BACKEND,
  FIXTURE_TEST_ID_FAILED,
  FIXTURE_TEST_ID_LARGE_CODE,
  FIXTURE_TEST_ID_NO_ANALYSIS,
  FIXTURE_TEST_ID_PASSED,
  FIXTURE_TEST_ID_RUNNING,
  latestResultFailedFixture,
  latestResultPassedFixture,
  latestResultRunningFixture,
  meFixture,
  projectFixtures,
  testCodeFixture,
  testCodeLargeFixture,
  testFixtures,
  testStepsFixture,
} from './fixtures.js';

export const DEFAULT_BASE_URL = 'https://api.testsprite.com/api/cli/v1';

/**
 * Canonical error code namespace, shared with the CLI error spec §2 and
 * the OpenAPI `ErrorCode` enum. Keep this list in lock-step with both —
 * adding a code here without updating the docs (or vice-versa) is a
 * contract bug, and the smoke test cross-checks the lists at runtime.
 */
export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_INVALID'
  | 'AUTH_FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UNSUPPORTED'
  | 'INTERNAL'
  | 'UNAVAILABLE';

interface ErrorEnvelopeOptions {
  code: ErrorCode;
  message: string;
  nextAction: string;
  status: number;
  requestId?: string;
  details?: Record<string, unknown>;
  retryAfterSec?: number;
}

/**
 * Build a spec-conformant (§1) error envelope. Centralizing this here
 * means the CLI can assert against the shape, not handcraft it in every
 * test.
 */
export function errorEnvelope(opts: ErrorEnvelopeOptions): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-request-id': opts.requestId ?? `req_2026_05_05_${opts.code.toLowerCase()}`,
  };
  if (opts.retryAfterSec !== undefined) {
    headers['retry-after'] = String(opts.retryAfterSec);
  }
  const body = {
    error: {
      code: opts.code,
      message: opts.message,
      nextAction: opts.nextAction,
      requestId: headers['x-request-id'],
      details: opts.details ?? {},
    },
  };
  return new HttpResponse(JSON.stringify(body), {
    status: opts.status,
    headers,
  });
}

/**
 * Auth check shared by every endpoint other than `/me`'s
 * authentication-required envelope demonstration. Returns either
 * `null` (continue) or an early-return Response.
 */
function requireApiKey(request: Request): Response | null {
  const key = request.headers.get('x-api-key');
  if (!key) {
    return errorEnvelope({
      code: 'AUTH_REQUIRED',
      message: 'Authentication is required.',
      nextAction: 'Run `testsprite auth configure`, or set TESTSPRITE_API_KEY in the environment.',
      status: 401,
    });
  }
  return null;
}

/**
 * Construct the default-happy handler array. Pass a custom base URL
 * for tests that want to point the CLI at a different host (e.g.,
 * `--endpoint-url` validation).
 */
export function buildHandlers(baseUrl: string = DEFAULT_BASE_URL) {
  return [
    // /me — auth canary. No project filter; any key works.
    http.get(`${baseUrl}/me`, ({ request }) => {
      const earlyReturn = requireApiKey(request);
      if (earlyReturn) return earlyReturn;
      return HttpResponse.json(meFixture, {
        headers: { 'x-request-id': 'req_2026_05_05_me_ok' },
      });
    }),

    // /projects — list with pagination support.
    http.get(`${baseUrl}/projects`, ({ request }) => {
      const earlyReturn = requireApiKey(request);
      if (earlyReturn) return earlyReturn;
      const url = new URL(request.url);
      const pageSize = clampPageSize(url.searchParams.get('pageSize'));
      const cursor = url.searchParams.get('cursor');
      const startIdx = cursor ? Number(decodeCursor(cursor)) : 0;
      const slice = projectFixtures.slice(startIdx, startIdx + pageSize);
      const next =
        startIdx + pageSize < projectFixtures.length
          ? encodeCursor(String(startIdx + pageSize))
          : null;
      return HttpResponse.json(
        { items: slice, nextToken: next },
        { headers: { 'x-request-id': 'req_2026_05_05_projects_ok' } },
      );
    }),

    // /projects/:id
    http.get(`${baseUrl}/projects/:projectId`, ({ params, request }) => {
      const earlyReturn = requireApiKey(request);
      if (earlyReturn) return earlyReturn;
      const project = projectFixtures.find(p => p.id === params.projectId);
      if (!project) return notFoundEnvelope('project', String(params.projectId));
      return HttpResponse.json(project, {
        headers: { 'x-request-id': 'req_2026_05_05_project_ok' },
      });
    }),

    // /tests — list with required projectId and optional filters.
    http.get(`${baseUrl}/tests`, ({ request }) => {
      const earlyReturn = requireApiKey(request);
      if (earlyReturn) return earlyReturn;
      const url = new URL(request.url);
      const projectId = url.searchParams.get('projectId');
      if (!projectId) {
        return errorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'Invalid request.',
          nextAction:
            'Field `projectId` is invalid: required. See `testsprite test list --help` for accepted values.',
          status: 400,
          details: { field: 'projectId', reason: 'required' },
        });
      }
      if (projectId !== FIXTURE_PROJECT_ID && projectId !== FIXTURE_PROJECT_ID_BACKEND) {
        return notFoundEnvelope('project', projectId);
      }
      let items = testFixtures.filter(t => t.projectId === projectId);
      const type = url.searchParams.get('type');
      if (type) items = items.filter(t => t.type === type);
      const createdFrom = url.searchParams.get('createdFrom');
      if (createdFrom) items = items.filter(t => t.createdFrom === createdFrom);
      return HttpResponse.json(
        { items, nextToken: null },
        { headers: { 'x-request-id': 'req_2026_05_05_tests_ok' } },
      );
    }),

    // /tests/:id
    http.get(`${baseUrl}/tests/:testId`, ({ params, request }) => {
      const earlyReturn = requireApiKey(request);
      if (earlyReturn) return earlyReturn;
      const t = testFixtures.find(t => t.id === params.testId);
      if (!t) return notFoundEnvelope('test', String(params.testId));
      return HttpResponse.json(t, {
        headers: { 'x-request-id': 'req_2026_05_05_test_ok' },
      });
    }),

    // /tests/:id/code — inline body when small, presigned URL when >= 100 KB.
    http.get(`${baseUrl}/tests/:testId/code`, ({ params, request }) => {
      const earlyReturn = requireApiKey(request);
      if (earlyReturn) return earlyReturn;
      if (params.testId === FIXTURE_TEST_ID_FAILED) {
        return HttpResponse.json(testCodeFixture, {
          headers: { 'x-request-id': 'req_2026_05_05_code_ok' },
        });
      }
      if (params.testId === FIXTURE_TEST_ID_LARGE_CODE) {
        return HttpResponse.json(testCodeLargeFixture, {
          headers: { 'x-request-id': 'req_2026_05_05_code_presigned' },
        });
      }
      return notFoundEnvelope('test', String(params.testId));
    }),

    // /tests/:id/steps
    http.get(`${baseUrl}/tests/:testId/steps`, ({ params, request }) => {
      const earlyReturn = requireApiKey(request);
      if (earlyReturn) return earlyReturn;
      if (params.testId !== FIXTURE_TEST_ID_FAILED) {
        return notFoundEnvelope('test', String(params.testId));
      }
      return HttpResponse.json(
        { items: testStepsFixture, nextToken: null },
        { headers: { 'x-request-id': 'req_2026_05_05_steps_ok' } },
      );
    }),

    // /tests/:id/result
    http.get(`${baseUrl}/tests/:testId/result`, ({ params, request }) => {
      const earlyReturn = requireApiKey(request);
      if (earlyReturn) return earlyReturn;
      if (params.testId === FIXTURE_TEST_ID_FAILED) {
        return HttpResponse.json(latestResultFailedFixture, {
          headers: { 'x-request-id': 'req_2026_05_05_result_failed' },
        });
      }
      if (params.testId === FIXTURE_TEST_ID_PASSED) {
        return HttpResponse.json(latestResultPassedFixture, {
          headers: { 'x-request-id': 'req_2026_05_05_result_passed' },
        });
      }
      if (params.testId === FIXTURE_TEST_ID_RUNNING) {
        return HttpResponse.json(latestResultRunningFixture, {
          headers: { 'x-request-id': 'req_2026_05_05_result_running' },
        });
      }
      return notFoundEnvelope('test', String(params.testId));
    }),

    // /tests/:id/failure — agent-facing bundle.
    http.get(`${baseUrl}/tests/:testId/failure`, ({ params, request }) => {
      const earlyReturn = requireApiKey(request);
      if (earlyReturn) return earlyReturn;
      if (params.testId === FIXTURE_TEST_ID_FAILED) {
        return HttpResponse.json(failureContextFixture, {
          headers: { 'x-request-id': 'req_2026_05_05_failure_ok' },
        });
      }
      if (params.testId === FIXTURE_TEST_ID_NO_ANALYSIS) {
        return HttpResponse.json(failureContextNoAnalysisFixture, {
          headers: { 'x-request-id': 'req_2026_05_05_failure_no_analysis' },
        });
      }
      if (params.testId === FIXTURE_TEST_ID_PASSED) {
        // Test exists, but it is currently passing — the CLI error spec §8.2.
        return errorEnvelope({
          code: 'NOT_FOUND',
          message: 'Test has no failing run.',
          nextAction:
            'Test has no failing run. Use `testsprite test result <test-id>` to inspect the latest result.',
          status: 404,
          requestId: 'req_2026_05_05_failure_no_failing_run',
          details: {
            resource: 'test',
            id: String(params.testId),
            reason: 'no_failing_run',
          },
        });
      }
      return notFoundEnvelope('test', String(params.testId));
    }),
  ];
}

/** Default-happy handlers, bound to the dev base URL. */
export const defaultHandlers = buildHandlers();

/** Per-code error overrides keyed by URL pattern. */
export const errorHandlers = {
  /** Force every `/me` request to return `AUTH_INVALID`. */
  authInvalid: (baseUrl: string = DEFAULT_BASE_URL) =>
    http.get(`${baseUrl}/me`, () =>
      errorEnvelope({
        code: 'AUTH_INVALID',
        message: 'API key is invalid or revoked.',
        nextAction:
          'API key is invalid or revoked. Generate a new one at https://www.testsprite.com/settings/api-keys.',
        status: 401,
        details: { reason: 'revoked' },
      }),
    ),

  /** Force every `/projects/:id` request to return `AUTH_FORBIDDEN`. */
  authForbidden: (baseUrl: string = DEFAULT_BASE_URL) =>
    http.get(`${baseUrl}/projects/:projectId`, () =>
      errorEnvelope({
        code: 'AUTH_FORBIDDEN',
        message: 'API key does not grant the required scope.',
        nextAction:
          'This API key does not have the required scope. Ask your account owner to extend it.',
        status: 403,
        details: { requiredScope: 'read:projects', reason: 'scope' },
      }),
    ),

  /** Force every `/projects` list request to return `RATE_LIMITED`. */
  rateLimited: (baseUrl: string = DEFAULT_BASE_URL) =>
    http.get(`${baseUrl}/projects`, () =>
      errorEnvelope({
        code: 'RATE_LIMITED',
        message: 'Rate limit exceeded.',
        nextAction:
          'Wait `Retry-After` seconds and retry. Reduce concurrency, or contact support to raise the per-key limit.',
        status: 429,
        retryAfterSec: 2,
        details: { scope: 'key', retryAfterSec: 2 },
      }),
    ),

  /** Force every `/tests/:id/result` request to return `CONFLICT`. */
  conflict: (baseUrl: string = DEFAULT_BASE_URL) =>
    http.get(`${baseUrl}/tests/:testId/result`, () =>
      errorEnvelope({
        code: 'CONFLICT',
        message: 'Snapshot in flight; retry shortly.',
        nextAction:
          'Snapshot in flight; retry in a few seconds. The CLI re-fetches against a single `snapshotId` so partial reads are safe.',
        status: 409,
        details: { reason: 'snapshot_in_flight' },
      }),
    ),

  /** Force every `/me` request to return `INTERNAL`. */
  internal: (baseUrl: string = DEFAULT_BASE_URL) =>
    http.get(`${baseUrl}/me`, () =>
      errorEnvelope({
        code: 'INTERNAL',
        message: 'Internal server error.',
        nextAction:
          'Server error. Retry once; if it persists, report the `requestId` to support@testsprite.com.',
        status: 500,
      }),
    ),

  /** Force every `/me` request to return `UNAVAILABLE`. */
  unavailable: (baseUrl: string = DEFAULT_BASE_URL) =>
    http.get(`${baseUrl}/me`, () =>
      errorEnvelope({
        code: 'UNAVAILABLE',
        message: 'Service temporarily unavailable.',
        nextAction:
          'Service is temporarily unavailable. The CLI retries with exponential backoff; if this persists, report it.',
        status: 503,
        details: { dependency: 'ddb' },
      }),
    ),

  /** Force the `failure` endpoint for a known-good id to return `UNSUPPORTED`. */
  unsupported: (baseUrl: string = DEFAULT_BASE_URL) =>
    http.get(`${baseUrl}/tests/:testId/failure`, () =>
      errorEnvelope({
        code: 'UNSUPPORTED',
        message: 'Operation not supported on this backend version.',
        nextAction:
          'This feature is not available on the current backend version. Upgrade the backend or use the documented fallback.',
        status: 501,
        details: { feature: 'failure_bundle' },
      }),
    ),

  /**
   * Force every `/projects/:id` request to return `NOT_FOUND` regardless
   * of the id. Useful for testing the CLI's "check the id with `list`"
   * remediation path even on ids that the default handlers know about.
   */
  notFound: (baseUrl: string = DEFAULT_BASE_URL) =>
    http.get(`${baseUrl}/projects/:projectId`, ({ params }) =>
      errorEnvelope({
        code: 'NOT_FOUND',
        message: 'Resource not found.',
        nextAction:
          'Check the id with the corresponding `list` command, e.g. `testsprite test list --project <id>`.',
        status: 404,
        details: { resource: 'project', id: String(params.projectId) },
      }),
    ),

  /**
   * Force `/tests` to return `VALIDATION_ERROR` regardless of the query
   * string, so tests can assert `nextAction` and exit-code-5 mapping
   * without crafting a specifically-malformed request.
   */
  validationError: (baseUrl: string = DEFAULT_BASE_URL) =>
    http.get(`${baseUrl}/tests`, () =>
      errorEnvelope({
        code: 'VALIDATION_ERROR',
        message: 'Invalid request.',
        nextAction:
          'Field `pageSize` is invalid: must be between 1 and 100. See `testsprite test list --help` for accepted values.',
        status: 400,
        details: { field: 'pageSize', reason: 'must be between 1 and 100' },
      }),
    ),
} as const;

/**
 * Unmapped test ids (e.g. {@link FIXTURE_TEST_ID_NOT_FOUND from './fixtures.js'})
 * fall through every routed handler above and return `NOT_FOUND` via the
 * matching path's own logic. The fixture export is kept for tests that
 * need to reference an explicit "missing" id without inventing a string.
 */
function clampPageSize(raw: string | null): number {
  if (!raw) return 25;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 25;
  return Math.min(parsed, 100);
}

function decodeCursor(raw: string): string {
  return Buffer.from(raw, 'base64').toString('utf8');
}

function encodeCursor(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64');
}

function notFoundEnvelope(resource: string, id: string): Response {
  return errorEnvelope({
    code: 'NOT_FOUND',
    message: 'Resource not found.',
    nextAction:
      'Check the id with the corresponding `list` command, e.g. `testsprite test list --project <id>`.',
    status: 404,
    details: { resource, id },
  });
}
