/**
 * Lifecycle wrapper around MSW's Node `setupServer`. Each test file
 * that wants HTTP isolation imports {@link mockBackend} and lets it
 * own the start/stop/reset hooks via {@link installLifecycle}.
 *
 * Every dependency on MSW lives in this file so the rest of the
 * codebase imports a thin facade and can be migrated off MSW later
 * without ripple.
 */

import type { RequestHandler } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { defaultHandlers } from './handlers.js';

export interface MockBackend {
  /**
   * Start the server before any test runs, reset between tests, and
   * stop after the suite. Call this exactly once per file in module
   * scope (outside `describe`).
   */
  installLifecycle(): void;

  /**
   * Stack one-off handlers on top of the defaults for the current
   * test. Reset on `afterEach` by `installLifecycle`.
   */
  use(...handlers: RequestHandler[]): void;

  /** Replace all current handlers (advanced; rarely needed). */
  resetHandlers(...handlers: RequestHandler[]): void;
}

export function createMockBackend(handlers: RequestHandler[] = defaultHandlers): MockBackend {
  const server = setupServer(...handlers);

  return {
    installLifecycle() {
      beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
      afterEach(() => server.resetHandlers());
      afterAll(() => server.close());
    },
    use(...override) {
      server.use(...override);
    },
    resetHandlers(...override) {
      server.resetHandlers(...override);
    },
  };
}

/** Default singleton bound to the default-happy handlers. */
export const mockBackend = createMockBackend();
