/**
 * Local e2e tests for `testsprite init`.
 *
 * Uses the real built binary (`dist/index.js`) against a temp directory.
 * No network or real credentials required — tests use --dry-run or
 * paths that exit before making network calls (--no-agent + expected error).
 *
 * Run via: `npm run test:e2e` (builds first).
 * Do NOT run via `npm test` — vitest.config.ts excludes `test/e2e/**`.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TARGETS } from '../../src/lib/agent-targets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const BIN_PATH = join(REPO_ROOT, 'dist', 'index.js');

// ---------------------------------------------------------------------------
// Guard: fail loud if the binary isn't present
// ---------------------------------------------------------------------------
beforeAll(() => {
  if (!existsSync(BIN_PATH)) {
    throw new Error(`dist/index.js not found — run \`npm run test:e2e\` which builds first.`);
  }
});

// ---------------------------------------------------------------------------
// Per-test tmp dir management
// ---------------------------------------------------------------------------

let currentTmpDir: string | null = null;

function freshTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ts-init-e2e-'));
  currentTmpDir = d;
  return d;
}

afterEach(() => {
  if (currentTmpDir !== null) {
    rmSync(currentTmpDir, { recursive: true, force: true });
    currentTmpDir = null;
  }
});

// ---------------------------------------------------------------------------
// CLI runner helper
// ---------------------------------------------------------------------------

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env?: Record<string, string>): CliResult {
  const result = spawnSync('node', [BIN_PATH, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      ...env,
    },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// ---------------------------------------------------------------------------
// 1. --help surface
// ---------------------------------------------------------------------------

describe('init --help', () => {
  it('exits 0 and shows the init command flags', () => {
    const result = runCli(['init', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--api-key');
    expect(result.stdout).toContain('--from-env');
    expect(result.stdout).toContain('--agent');
    expect(result.stdout).toContain('--no-agent');
    expect(result.stdout).toContain('--force');
    expect(result.stdout).toContain('--dir');
    expect(result.stdout).toContain('--yes');
  });

  it('--help lists all valid agent targets', () => {
    const result = runCli(['init', '--help']);
    for (const t of Object.keys(TARGETS)) {
      expect(result.stdout, `target "${t}" should be in --help`).toContain(t);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. --dry-run + --no-agent: zero writes, no network (no creds needed)
// ---------------------------------------------------------------------------

describe('init --dry-run --no-agent', () => {
  it('exits 0, emits dry-run banner, creates no files', () => {
    const tmpDir = freshTmpDir();
    const credsTmpDir = freshTmpDir();

    const result = runCli(
      ['--dry-run', 'init', '--api-key', 'sk-dry-no-agent', '--no-agent', '--dir', tmpDir],
      {
        // Point credentials to a temp dir so we don't touch real creds
        HOME: credsTmpDir,
      },
    );

    expect(result.status).toBe(0);

    // Dry-run banner on stderr
    expect(result.stderr).toContain('[dry-run]');
    expect(result.stderr).toContain('no writes or network calls');

    // No skill files on disk
    for (const spec of Object.values(TARGETS)) {
      const absPath = join(tmpDir, spec.path);
      expect(existsSync(absPath), `unexpected file: ${absPath}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. --dry-run with default claude agent: shows would-write for claude skill
// ---------------------------------------------------------------------------

describe('init --dry-run (with agent)', () => {
  it('exits 0, shows would-write preview for claude skill, no file created', () => {
    const tmpDir = freshTmpDir();
    const credsTmpDir = freshTmpDir();

    const result = runCli(
      ['--dry-run', 'init', '--api-key', 'sk-dry-with-agent', '--agent', 'claude', '--dir', tmpDir],
      {
        HOME: credsTmpDir,
      },
    );

    expect(result.status).toBe(0);

    // Should mention the claude skill path in stderr (from runInstall dry-run)
    expect(result.stderr).toContain('[dry-run]');
    expect(result.stderr).toContain(TARGETS.claude.path);

    // No file written
    const skillPath = join(tmpDir, TARGETS.claude.path);
    expect(existsSync(skillPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Non-interactive + no key source → exit 5
// ---------------------------------------------------------------------------

describe('init — non-interactive, no key', () => {
  it('exits 5 when no --api-key, no --from-env, and no TTY', () => {
    const tmpDir = freshTmpDir();
    const credsTmpDir = freshTmpDir();

    // spawnSync with no PTY = no TTY — CLI should hit the non-interactive guard
    const result = runCli(['init', '--yes', '--no-agent', '--dir', tmpDir], {
      HOME: credsTmpDir,
    });

    expect(result.status).toBe(5);
    expect(result.stderr).toContain('--api-key');
  });
});

// ---------------------------------------------------------------------------
// 5. init appears in top-level --help
// ---------------------------------------------------------------------------

describe('top-level --help', () => {
  it('includes init command in the command list', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('init');
  });
});

// ---------------------------------------------------------------------------
// 6. Matrix-coverage guard — documents the TARGETS set
// ---------------------------------------------------------------------------

describe('matrix coverage guard', () => {
  it('TARGETS matches the documented set (update this list when adding a target)', () => {
    expect(Object.keys(TARGETS)).toEqual(['claude', 'antigravity', 'cursor', 'cline', 'codex']);
  });
});

// ---------------------------------------------------------------------------
// 7. [P2 regression] rawArgConflict wiring — conflict warn fires through parseAsync
//    (exercises the real createInitCommand + program.parseAsync path so the
//    root-command rawArgs walk is actually verified, not just runInit injection)
// ---------------------------------------------------------------------------

describe('[P2] init --agent <t> --no-agent conflict warn fires through real binary', () => {
  it('--dry-run --agent cursor --no-agent emits [warn] about conflict on stderr', () => {
    const tmpDir = freshTmpDir();
    const credsTmpDir = freshTmpDir();

    // Both --agent cursor AND --no-agent present → rawArgConflict should detect them
    // via the root.rawArgs walk and emit [warn] on stderr.
    // Use --dry-run so no network or TTY is needed.
    const result = runCli(
      [
        '--dry-run',
        'init',
        '--api-key',
        'sk-conflict-e2e',
        '--agent',
        'cursor',
        '--no-agent',
        '--dir',
        tmpDir,
      ],
      { HOME: credsTmpDir },
    );

    // Must exit 0 (--no-agent wins; dry-run + no-agent = clean preview)
    expect(result.status).toBe(0);
    // The [warn] about both flags must appear on stderr
    expect(result.stderr).toContain('[warn]');
    expect(result.stderr).toMatch(/--no-agent.*--agent|--agent.*--no-agent/i);
  });

  it('--dry-run --no-agent --agent cursor (reversed order) also emits [warn]', () => {
    const tmpDir = freshTmpDir();
    const credsTmpDir = freshTmpDir();

    // Order reversed: --no-agent first, --agent cursor last → --agent wins.
    const result = runCli(
      [
        '--dry-run',
        'init',
        '--api-key',
        'sk-conflict-rev-e2e',
        '--no-agent',
        '--agent',
        'cursor',
        '--dir',
        tmpDir,
      ],
      { HOME: credsTmpDir },
    );

    // Exit 0 (--agent cursor wins; dry-run shows would-write for cursor)
    expect(result.status).toBe(0);
    // [warn] about conflict must appear
    expect(result.stderr).toContain('[warn]');
    expect(result.stderr).toMatch(/--no-agent.*--agent|--agent.*--no-agent/i);
  });
});
