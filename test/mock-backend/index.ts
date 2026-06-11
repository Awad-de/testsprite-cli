/**
 * Public surface for the `/api/cli/v1` mock backend. Tests should
 * import only from here so the underlying file structure can change
 * without breaking dozens of import paths.
 */

export {
  buildHandlers,
  defaultHandlers,
  errorEnvelope,
  errorHandlers,
  DEFAULT_BASE_URL,
  type ErrorCode,
} from './handlers.js';
export { createMockBackend, mockBackend, type MockBackend } from './server.js';
export * from './fixtures.js';
