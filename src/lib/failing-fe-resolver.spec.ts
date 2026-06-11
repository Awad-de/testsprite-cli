/**
 * Unit tests for the failing-FE-test auto-resolver.
 *
 * All network calls are replaced with a `fetchImpl` injection so no real
 * dev backend is needed. Runs via `npm test` (vitest.config.ts) — excluded
 * from the live-dev suite (vitest.dev-e2e.config.ts).
 */

import { describe, expect, test } from 'vitest';
import { resolveFailingFrontendTestId } from './failing-fe-resolver.js';
import type { TestListItem } from './failing-fe-resolver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_OPTS = {
  baseUrl: 'https://api.example.com:8443/api/cli/v1',
  apiKey: 'sk-test-key',
  projectId: 'proj_abc123',
};

function makeFetchReturning(
  pages: Array<{ items: TestListItem[]; nextToken: string | null }>,
): typeof fetch {
  let call = 0;
  return async (_url: string | URL | Request, _init?: RequestInit) => {
    const page = pages[call] ?? { items: [], nextToken: null };
    call++;
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function makeItem(
  id: string,
  updatedAt: string,
  type: 'frontend' | 'backend' = 'frontend',
  status = 'failed',
): TestListItem {
  return { id, type, status, updatedAt };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveFailingFrontendTestId', () => {
  test('returns null when API responds with non-ok status', async () => {
    const fetchImpl = async () => new Response('{"error":"unauthorized"}', { status: 401 });
    const result = await resolveFailingFrontendTestId({
      ...BASE_OPTS,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.testId).toBeNull();
    expect(result.reason).toContain('HTTP 401');
  });

  test('returns null when items array is missing from response', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ notItems: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    const result = await resolveFailingFrontendTestId({
      ...BASE_OPTS,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.testId).toBeNull();
    expect(result.reason).toContain('items array');
  });

  test('returns null when no failed frontend tests exist', async () => {
    const fetchImpl = makeFetchReturning([{ items: [], nextToken: null }]);
    const result = await resolveFailingFrontendTestId({
      ...BASE_OPTS,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.testId).toBeNull();
    expect(result.reason).toContain('No frontend tests');
  });

  test('returns the single failed frontend test when there is exactly one', async () => {
    const item = makeItem('test_abc', '2026-05-15T10:00:00Z');
    const fetchImpl = makeFetchReturning([{ items: [item], nextToken: null }]);
    const result = await resolveFailingFrontendTestId({
      ...BASE_OPTS,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.testId).toBe('test_abc');
  });

  test('picks the most recently updated item across multiple candidates', async () => {
    const older = makeItem('test_old', '2026-05-01T00:00:00Z');
    const newer = makeItem('test_new', '2026-05-15T22:00:00Z');
    const middle = makeItem('test_mid', '2026-05-10T12:00:00Z');
    const fetchImpl = makeFetchReturning([{ items: [older, newer, middle], nextToken: null }]);
    const result = await resolveFailingFrontendTestId({
      ...BASE_OPTS,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.testId).toBe('test_new');
  });

  test('filters out backend-type items even when they have status=failed', async () => {
    const beTtest = makeItem('test_be', '2026-05-20T00:00:00Z', 'backend', 'failed');
    const feTest = makeItem('test_fe', '2026-05-01T00:00:00Z', 'frontend', 'failed');
    const fetchImpl = makeFetchReturning([{ items: [beTtest, feTest], nextToken: null }]);
    const result = await resolveFailingFrontendTestId({
      ...BASE_OPTS,
      fetchImpl: fetchImpl as typeof fetch,
    });
    // Must pick the frontend test, not the newer backend one
    expect(result.testId).toBe('test_fe');
  });

  test('filters out non-failed items even when they are frontend type', async () => {
    const passed = makeItem('test_passed', '2026-05-20T00:00:00Z', 'frontend', 'passed');
    const failed = makeItem('test_failed', '2026-05-01T00:00:00Z', 'frontend', 'failed');
    const fetchImpl = makeFetchReturning([{ items: [passed, failed], nextToken: null }]);
    const result = await resolveFailingFrontendTestId({
      ...BASE_OPTS,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.testId).toBe('test_failed');
  });

  test('follows pagination across multiple pages and picks freshest overall', async () => {
    const page1Item = makeItem('test_p1', '2026-05-10T00:00:00Z');
    const page2Item = makeItem('test_p2', '2026-05-20T00:00:00Z');
    const fetchImpl = makeFetchReturning([
      { items: [page1Item], nextToken: 'cursor_abc' },
      { items: [page2Item], nextToken: null },
    ]);
    const result = await resolveFailingFrontendTestId({
      ...BASE_OPTS,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.testId).toBe('test_p2');
  });

  test('stops pagination at maxPages and still returns best candidate so far', async () => {
    const item = makeItem('test_p1', '2026-05-10T00:00:00Z');
    // Provide 3 pages but cap at maxPages=1
    const fetchImpl = makeFetchReturning([
      { items: [item], nextToken: 'cursor_1' },
      { items: [makeItem('test_p2', '2026-05-20T00:00:00Z')], nextToken: 'cursor_2' },
      { items: [makeItem('test_p3', '2026-05-25T00:00:00Z')], nextToken: null },
    ]);
    const result = await resolveFailingFrontendTestId({
      ...BASE_OPTS,
      fetchImpl: fetchImpl as typeof fetch,
      maxPages: 1,
    });
    // Only page 1 was fetched
    expect(result.testId).toBe('test_p1');
  });

  test('returns null with a reason when fetch throws a network error', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await resolveFailingFrontendTestId({
      ...BASE_OPTS,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.testId).toBeNull();
    expect(result.reason).toContain('ECONNREFUSED');
  });

  test('includes updatedAt in the reason string for auditing', async () => {
    const item = makeItem('test_abc', '2026-05-27T09:00:00Z');
    const fetchImpl = makeFetchReturning([{ items: [item], nextToken: null }]);
    const result = await resolveFailingFrontendTestId({
      ...BASE_OPTS,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.testId).toBe('test_abc');
    expect(result.reason).toContain('2026-05-27T09:00:00Z');
  });
});
