/**
 * Auto-discovery helper for `failingFrontendTestId`.
 *
 * Queries the dev backend's test-list endpoint for the most recently
 * updated frontend test with status `failed`, scoped to the project
 * declared in fixtures.local.json (`paginationProjectId`). Returns the
 * discovered id on success, or `null` when no Failed test is found, the
 * API call fails, or the required env / fixture preconditions are absent.
 *
 * The `null` path is intentionally non-throwing: callers fall back to the
 * static `fixtures.local.json` value so the suite degrades gracefully on
 * transient network issues.
 *
 * @see test/dev-e2e/global-setup.ts — invokes this at suite start and
 *   writes the result to `process.env.TESTSPRITE_DEV_FAILING_FE_TEST_ID`.
 * @see test/dev-e2e/_shared.ts — `loadFixtures()` reads that env var and
 *   prefers it over the static fixture file value.
 */

/**
 * Minimal shape of an item returned by GET /tests.
 * Only the fields we need for discovery; the full shape is in tests.dev-e2e.test.ts.
 */
export interface TestListItem {
  id: string;
  type: 'frontend' | 'backend';
  status: string;
  updatedAt: string;
}

interface TestListPage {
  items: TestListItem[];
  nextToken: string | null;
}

export interface ResolverOptions {
  /** Base URL for the CLI v1 API (e.g. https://api.testsprite.com/api/cli/v1) */
  baseUrl: string;
  /** API key sent as x-api-key header */
  apiKey: string;
  /** Project to search within */
  projectId: string;
  /**
   * Optional fetch override for unit tests.
   * Defaults to the global `fetch` when not provided.
   */
  fetchImpl?: typeof fetch;
  /**
   * Maximum number of pages to walk (safety guard, default 5).
   * Each page uses pageSize=50, so 5 pages = 250 tests scanned.
   */
  maxPages?: number;
}

export interface ResolverResult {
  /** The resolved failing frontend test id, or null if none found. */
  testId: string | null;
  /** Human-readable description of how the result was obtained. */
  reason: string;
}

/**
 * Walk up to `maxPages` pages of GET /tests?projectId=...&type=frontend&status=failed
 * and return the item with the greatest `updatedAt` timestamp.
 *
 * Returns `{ testId: null, reason: <explanation> }` on any error or
 * when no Failed test exists — never throws.
 */
export async function resolveFailingFrontendTestId(opts: ResolverOptions): Promise<ResolverResult> {
  const { baseUrl, apiKey, projectId, maxPages = 5 } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const candidates: TestListItem[] = [];
  let cursor: string | undefined;
  let pagesFetched = 0;

  try {
    do {
      const url = new URL(`${baseUrl}/tests`);
      url.searchParams.set('projectId', projectId);
      url.searchParams.set('type', 'frontend');
      url.searchParams.set('status', 'failed');
      url.searchParams.set('pageSize', '50');
      if (cursor) url.searchParams.set('cursor', cursor);

      const resp = await fetchImpl(url.toString(), {
        headers: {
          'x-api-key': apiKey,
          'x-request-id': `dev-e2e-resolver-page${pagesFetched}-${Date.now()}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) {
        return {
          testId: null,
          reason: `GET /tests returned HTTP ${resp.status}; falling back to static fixture`,
        };
      }

      const body = (await resp.json()) as TestListPage;

      if (!Array.isArray(body.items)) {
        return {
          testId: null,
          reason: 'GET /tests response missing items array; falling back to static fixture',
        };
      }

      // Only keep frontend+failed items (the query params should filter, but be defensive)
      for (const item of body.items) {
        if (item.type === 'frontend' && item.status === 'failed') {
          candidates.push(item);
        }
      }

      cursor = body.nextToken ?? undefined;
      pagesFetched++;
    } while (cursor && pagesFetched < maxPages);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      testId: null,
      reason: `GET /tests threw: ${message}; falling back to static fixture`,
    };
  }

  if (candidates.length === 0) {
    return {
      testId: null,
      reason:
        'No frontend tests with status=failed found in project; falling back to static fixture',
    };
  }

  // Pick the most recently updated candidate — freshest failure is the
  // most likely to have a valid failure bundle attached.
  candidates.sort((a, b) => {
    const ta = new Date(a.updatedAt).getTime();
    const tb = new Date(b.updatedAt).getTime();
    return tb - ta; // descending: freshest first
  });

  const best = candidates[0];
  if (!best) {
    // Unreachable: the early return above guards candidates.length === 0,
    // but TypeScript requires the narrowing here due to noUncheckedIndexedAccess.
    return { testId: null, reason: 'No candidates after sort (unexpected)' };
  }
  return {
    testId: best.id,
    reason: `Discovered from ${pagesFetched} page(s) of GET /tests; freshest failed test updatedAt=${best.updatedAt}`,
  };
}
