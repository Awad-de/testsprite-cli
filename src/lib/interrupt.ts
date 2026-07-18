/**
 * Process lifecycle hardening: graceful termination signals and broken-pipe.
 *
 * Termination signals: without a handler, Node terminates the process abruptly
 * with no output, so a user (Ctrl+C), a CI runner or `docker stop` (SIGTERM), or
 * a closed terminal/SSH session (SIGHUP) that interrupts a long
 * `test run --wait` is left unsure whether the run was cancelled or is still
 * executing server-side (it is: the CLI only polls; the run lives on the
 * backend). The handler prints a one-line explanation plus how to resume, then
 * exits with the conventional `128 + signal` code.
 *
 * Broken pipe: when output is piped to a reader that closes early
 * (`testsprite ... | head`), the kernel raises `EPIPE` on the next stdout write.
 * Node turns an `'error'` with no listener into an uncaughtException and dumps a
 * raw `write EPIPE` stack (exit 1). The guard swallows it and exits 0, the
 * conventional SIGPIPE-equivalent result for "the reader went away".
 *
 * `process` and the streams are injectable so the wiring is unit-testable
 * without spawning a subprocess or sending a real signal.
 */

import { setMaxListeners } from 'node:events';
import { writeSync } from 'node:fs';
import { InterruptError, TERMINATION_EXIT_CODES, type TerminationSignal } from './errors.js';

export { TERMINATION_EXIT_CODES, type TerminationSignal } from './errors.js';

/** Back-compat alias: SIGINT's conventional exit code. */
export const SIGINT_EXIT_CODE = TERMINATION_EXIT_CODES.SIGINT;

/**
 * Structural view of {@link ShutdownController} threaded through the DI
 * surfaces (`TestDeps`, `PollOptions`) — commands and the polling loop need
 * only these members, and tests can supply a lightweight fake.
 */
export interface ShutdownHandle {
  /** Aborts (reason: `InterruptError`) when a termination signal arrives while armed. */
  readonly signal: AbortSignal;
  /** Enter a graceful-detach scope. Returns the disposer that leaves it. */
  arm(): () => void;
}

/**
 * Process-lifetime coordinator between the signal handler and the `--wait`
 * polling paths (DEV-331 piece 1).
 *
 * Two modes, chosen by whether a graceful-detach scope is armed when the
 * signal arrives:
 *
 * - **Armed** (inside `pollRunUntilTerminal`): the handler only aborts
 *   `signal` with an `InterruptError` — no I/O, no exit. The in-flight fetch
 *   and every backoff sleep bail immediately; the `--wait` catch blocks own
 *   the cleanup (finalize the ticker, print the honest partial envelope +
 *   re-attach hint, rethrow to `index.ts` → exit 130/143/129).
 * - **Disarmed** (no wait in progress — prompts, one-shot commands, local
 *   FS work): the handler prints the generic explanation and exits
 *   immediately, preserving the pre-DEV-331 behavior. An abort nobody
 *   observes must never leave the process hanging at e.g. a readline prompt.
 *
 * A second signal while the armed cleanup is in flight is the documented
 * escape hatch: immediate hard exit.
 */
export class ShutdownController {
  private readonly controller = new AbortController();
  private armedCount = 0;
  private receivedSignal: TerminationSignal | null = null;

  constructor() {
    // Every fetch and every poll iteration composes this signal via
    // AbortSignal.any — a 50-run batch fan-out legitimately holds >10
    // concurrent listeners, so silence Node's MaxListeners warning.
    setMaxListeners(0, this.controller.signal);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** The first termination signal received, or null if none yet. */
  get received(): TerminationSignal | null {
    return this.receivedSignal;
  }

  get isArmed(): boolean {
    return this.armedCount > 0;
  }

  /**
   * Enter a graceful-detach scope (re-entrant: fan-out members overlap).
   * Returns an idempotent disposer.
   */
  arm(): () => void {
    this.armedCount += 1;
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.armedCount -= 1;
    };
  }

  /** Record the signal and abort with an `InterruptError` carrying it. */
  interrupt(signal: TerminationSignal): void {
    this.receivedSignal = signal;
    this.controller.abort(new InterruptError(signal));
  }
}

/**
 * The process-wide instance: `index.ts` hands it to `installSignalHandlers`,
 * and it is the default `shutdown` for `TestDeps` / `PollOptions` /
 * `ClientFactoryDeps`, so production wiring is automatic. Tests inject their
 * own `ShutdownController` (or a `ShutdownHandle` fake) instead.
 */
export const globalShutdown = new ShutdownController();

export function formatInterruptMessage(signal: TerminationSignal = 'SIGINT'): string {
  return (
    `Interrupted (${signal}). Any run already started keeps executing on the server; ` +
    'check it with `testsprite test list` or `testsprite test wait <runId>`.'
  );
}

export interface InterruptDeps {
  /** Signal registrar. Defaults to `process.on`. */
  on?: (signal: TerminationSignal, handler: () => void) => void;
  /** Line-oriented stderr writer (appends a newline). */
  stderr?: (line: string) => void;
  /** Process exit. Defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Shutdown coordinator. Defaults to {@link globalShutdown}. */
  shutdown?: ShutdownController;
}

/**
 * Register handlers for SIGINT, SIGTERM and SIGHUP. Idempotent enough for a
 * single top-level call in `index.ts`; not designed to be installed twice.
 *
 * First signal, armed scope: abort-only — the `--wait` catch paths own the
 * honest-detach UX and the exit (DEV-331 D1: Ctrl-C = detach, never cancel).
 * First signal, disarmed: print the generic explanation + exit `128+signum`.
 * Second signal (any mode): immediate hard exit — the escape hatch when the
 * graceful cleanup itself wedges.
 */
export function installSignalHandlers(deps: InterruptDeps = {}): void {
  const on =
    deps.on ??
    ((signal: TerminationSignal, handler: () => void) => {
      process.on(signal, handler);
    });
  const stderr =
    deps.stderr ??
    ((line: string) => {
      // A signal handler calls process.exit() right after writing, which can
      // truncate an async process.stderr.write() when stderr is a pipe. Write
      // synchronously so the interrupt hint is flushed before the process exits.
      try {
        writeSync(process.stderr.fd, `${line}\n`);
      } catch {
        // Best-effort: if stderr is already gone (EPIPE), still exit cleanly.
      }
    });
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const shutdown = deps.shutdown ?? globalShutdown;

  for (const signal of Object.keys(TERMINATION_EXIT_CODES) as TerminationSignal[]) {
    on(signal, () => {
      if (shutdown.received !== null) {
        // Second signal while graceful cleanup is in flight: hard exit now.
        exit(TERMINATION_EXIT_CODES[signal]);
        return;
      }
      if (shutdown.isArmed) {
        // Graceful detach: abort only (sync, signal-safe — no I/O here so a
        // pending stdout `drain` wait can settle); the armed catch paths
        // finalize the ticker, print the partial + re-attach hint, and exit
        // via index.ts with this signal's code.
        shutdown.interrupt(signal);
        return;
      }
      // Disarmed (no --wait in progress): legacy immediate exit. Record the
      // signal first so a second one takes the hard-exit branch even when
      // `exit` is injected and does not terminate (unit tests).
      shutdown.interrupt(signal);
      // Blank line first so the message starts on its own row rather than
      // trailing the progress ticker's in-place line.
      stderr('');
      stderr(formatInterruptMessage(signal));
      exit(TERMINATION_EXIT_CODES[signal]);
    });
  }
}

export interface BrokenPipeDeps {
  /** stdout stream. Defaults to `process.stdout`. */
  stdout?: NodeJS.EventEmitter;
  /** stderr stream. Defaults to `process.stderr`. */
  stderr?: NodeJS.EventEmitter;
  /** Process exit. Defaults to `process.exit`. */
  exit?: (code: number) => void;
}

/**
 * Guard against `EPIPE` on stdout/stderr so piping to a reader that closes
 * early (`testsprite ... | head`) exits cleanly instead of crashing with an
 * unhandled `write EPIPE` stack. Only `EPIPE` is swallowed; any other stream
 * error is left to surface normally.
 */
export function installBrokenPipeGuard(deps: BrokenPipeDeps = {}): void {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  stdout.on('error', (error: NodeJS.ErrnoException) => {
    // Reader went away (`| head`, `| less` then q): exit cleanly like SIGPIPE
    // rather than dumping an unhandled `write EPIPE` stack. Any other stdout
    // error is a genuine, actionable failure, so re-throw it (Node's default).
    if (error.code === 'EPIPE') {
      exit(0);
      return;
    }
    throw error;
  });
  stderr.on('error', (error: NodeJS.ErrnoException) => {
    // stderr closed: nothing can be reported over it, so swallow EPIPE. Any
    // other error re-throws so a genuine failure is not silently hidden.
    if (error.code === 'EPIPE') return;
    throw error;
  });
}
