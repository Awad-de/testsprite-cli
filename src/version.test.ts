import { describe, it, expect } from 'vitest';
import { VERSION } from './version.js';

describe('VERSION', () => {
  it('is exported', () => {
    expect(VERSION).toBeTruthy();
  });

  it('matches semver shape', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
