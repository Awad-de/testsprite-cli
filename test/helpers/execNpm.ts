import { execFileSync } from 'node:child_process';

/**
 * Cross-platform `npm` invocation for test `beforeAll` build steps.
 * On Windows, `npm` is a `.cmd` shim rather than a directly executable
 * binary — `execFileSync('npm', ...)` fails with `ENOENT` there unless
 * `shell: true` lets the OS resolve the shim through PATHEXT.
 */
export function execNpm(
  args: string[],
  options: { cwd: string; stdio?: 'pipe' | 'inherit' | 'ignore' },
): Buffer | string {
  return execFileSync('npm', args, {
    ...options,
    shell: process.platform === 'win32',
  });
}
