import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import { VERSION } from './version.js';

// Read the package.json version at test time so this test catches drift
// between the hand-edited (or generate-version-stamped) VERSION constant
// and the canonical package.json version field.
const require = createRequire(import.meta.url);
const pkg: { version: string } = require('../package.json') as { version: string };

describe('VERSION', () => {
  it('is exported', () => {
    expect(VERSION).toBeTruthy();
  });

  it('matches semver shape', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('matches package.json version (drift guard)', () => {
    // If this fails, run `npm run generate:version` (or `npm run build`) to
    // regenerate src/version.ts from package.json.
    expect(VERSION).toBe(pkg.version);
  });
});
