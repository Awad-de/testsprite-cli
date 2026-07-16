import { EventEmitter } from 'node:events';
import { writeSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { InterruptError } from './errors.js';
import {
  SIGINT_EXIT_CODE,
  ShutdownController,
  TERMINATION_EXIT_CODES,
  formatInterruptMessage,
  installBrokenPipeGuard,
  installSignalHandlers,
} from './interrupt.js';

// installSignalHandlers' default stderr writes via fs.writeSync (synchronous, so
// the hint survives a piped stderr before exit); mock it to assert on that path.
vi.mock('node:fs', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, writeSync: vi.fn() };
});

describe('formatInterruptMessage', () => {
  it('defaults to SIGINT and explains the run continues server-side', () => {
    const message = formatInterruptMessage();
    expect(message).toContain('Interrupted (SIGINT)');
    expect(message).toContain('test wait');
    expect(message).toContain('test list');
  });

  it('names the specific signal when given one', () => {
    expect(formatInterruptMessage('SIGTERM')).toContain('Interrupted (SIGTERM)');
    expect(formatInterruptMessage('SIGHUP')).toContain('Interrupted (SIGHUP)');
  });
});

/** Fresh handler map + controller per case: the disarmed path exits on the
 *  FIRST signal, so sequential signals on one install take the second-signal
 *  hard-exit branch (by design — DEV-331 SIG-5). */
function install(shutdown = new ShutdownController()) {
  const handlers = new Map<string, () => void>();
  const stderr: string[] = [];
  const exit = vi.fn();
  installSignalHandlers({
    on: (signal, handler) => handlers.set(signal, handler),
    stderr: line => stderr.push(line),
    exit,
    shutdown,
  });
  return { handlers, stderr, exit, shutdown };
}

describe('installSignalHandlers', () => {
  it('registers SIGINT, SIGTERM and SIGHUP with the conventional 128+signum exit codes', () => {
    for (const [signal, code] of [
      ['SIGINT', 130],
      ['SIGTERM', 143],
      ['SIGHUP', 129],
    ] as const) {
      const { handlers, stderr, exit } = install();
      expect([...handlers.keys()].sort()).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM']);
      handlers.get(signal)!();
      expect(exit).toHaveBeenLastCalledWith(code);
      // Disarmed handler emits a leading blank line then the explanation.
      expect(stderr[0]).toBe('');
      expect(stderr.join('\n')).toContain(`Interrupted (${signal})`);
    }
    expect(SIGINT_EXIT_CODE).toBe(130);
    expect(TERMINATION_EXIT_CODES.SIGTERM).toBe(143);
    expect(TERMINATION_EXIT_CODES.SIGHUP).toBe(129);
  });

  it('writes the hint synchronously via writeSync before exit (survives a piped stderr)', () => {
    vi.mocked(writeSync).mockClear();
    const handlers = new Map<string, () => void>();
    const exit = vi.fn();
    // No stderr dep: exercise the synchronous default path.
    installSignalHandlers({
      on: (signal, handler) => handlers.set(signal, handler),
      exit,
      shutdown: new ShutdownController(),
    });
    handlers.get('SIGINT')!();
    expect(exit).toHaveBeenCalledWith(130);
    const written = vi
      .mocked(writeSync)
      .mock.calls.map(call => String(call[1]))
      .join('');
    expect(written).toContain('Interrupted (SIGINT)');
  });

  it('armed scope: first signal aborts with InterruptError and does NOT exit or print', () => {
    const { handlers, stderr, exit, shutdown } = install();
    const disarm = shutdown.arm();
    handlers.get('SIGINT')!();

    expect(exit).not.toHaveBeenCalled();
    expect(stderr).toEqual([]);
    expect(shutdown.signal.aborted).toBe(true);
    expect(shutdown.received).toBe('SIGINT');
    const reason = shutdown.signal.reason as InterruptError;
    expect(reason).toBeInstanceOf(InterruptError);
    expect(reason.signal).toBe('SIGINT');
    expect(reason.exitCode).toBe(130);
    disarm();
  });

  it('second signal during armed cleanup hard-exits with the second signal code (SIG-5)', () => {
    const { handlers, exit, shutdown } = install();
    shutdown.arm();
    handlers.get('SIGINT')!();
    expect(exit).not.toHaveBeenCalled();
    handlers.get('SIGTERM')!();
    expect(exit).toHaveBeenCalledWith(143);
  });

  it('disposed scope reverts to the disarmed immediate-exit behavior', () => {
    const { handlers, stderr, exit, shutdown } = install();
    const disarm = shutdown.arm();
    disarm();
    disarm(); // idempotent — double dispose must not underflow the counter
    handlers.get('SIGTERM')!();
    expect(exit).toHaveBeenCalledWith(143);
    expect(stderr.join('\n')).toContain('Interrupted (SIGTERM)');
  });

  it('nested arms (fan-out members) stay armed until the last disposer runs', () => {
    const shutdown = new ShutdownController();
    const a = shutdown.arm();
    const b = shutdown.arm();
    a();
    expect(shutdown.isArmed).toBe(true);
    b();
    expect(shutdown.isArmed).toBe(false);
  });
});

describe('installBrokenPipeGuard', () => {
  function makeEpipe(): NodeJS.ErrnoException {
    return Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  }

  it('exits 0 on stdout EPIPE (clean SIGPIPE-equivalent for `| head`)', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exit = vi.fn();
    installBrokenPipeGuard({ stdout, stderr, exit });

    stdout.emit('error', makeEpipe());
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('re-throws a non-EPIPE stdout error instead of silently swallowing it', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exit = vi.fn();
    installBrokenPipeGuard({ stdout, stderr, exit });

    expect(() =>
      stdout.emit('error', Object.assign(new Error('boom'), { code: 'ENOSPC' })),
    ).toThrow('boom');
    expect(exit).not.toHaveBeenCalled();
  });

  it('swallows stderr EPIPE without exiting or throwing', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exit = vi.fn();
    installBrokenPipeGuard({ stdout, stderr, exit });

    expect(() => stderr.emit('error', makeEpipe())).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
  });
});
