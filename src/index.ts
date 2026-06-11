#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { createAgentCommand } from './commands/agent.js';
import { createAuthCommand } from './commands/auth.js';
import { createInitCommand } from './commands/init.js';
import { createProjectCommand } from './commands/project.js';
import { createTestCommand } from './commands/test.js';
import { createUsageCommand } from './commands/usage.js';
import { ApiError, CLIError, RequestTimeoutError } from './lib/errors.js';
import { Output, isOutputMode } from './lib/output.js';
import { rephraseUnknownOption } from './lib/render-error.js';
import { VERSION } from './version.js';

const program = new Command();

// exitOverride() causes Commander to throw CommanderError instead of calling
// process.exit() directly, giving our catch block a chance to remap error
// exit codes (e.g. missing-argument → exit 5 per taxonomy).
program.exitOverride();

program
  .name('testsprite')
  .description('Official TestSprite command-line interface')
  .version(VERSION)
  .option('--output <mode>', 'Output format (json|text)', 'text')
  .option('--profile <name>', 'Configuration profile to use')
  .option('--endpoint-url <url>', 'Override the API endpoint host')
  .option(
    '--verbose',
    'Emit human-readable HTTP retry / backoff / polling-mode transitions to stderr. Less noisy than --debug; useful for diagnosing hangs without the full trace.',
  )
  .option('--debug', 'Print HTTP method/path, request id, latency, retry decisions to stderr')
  .option(
    '--dry-run',
    'Skip the network, credentials, and filesystem; emit a canned sample matching the OpenAPI contract. Useful for learning the CLI surface without an API key.',
  )
  .option(
    '--request-timeout <seconds>',
    'Client-side per-request timeout in seconds (default: 120). Aborts any single fetch that does not complete within this deadline. ' +
      'Override via TESTSPRITE_REQUEST_TIMEOUT_MS env var (milliseconds). ' +
      'Range: 1–600. Does not affect the --timeout polling ceiling for `test run/wait`.',
  );

program.addCommand(createAgentCommand({}));
program.addCommand(createAuthCommand());
program.addCommand(createInitCommand({}));
program.addCommand(createProjectCommand({}));
program.addCommand(createTestCommand());
program.addCommand(createUsageCommand());

// Propagate exitOverride to every subcommand in the tree.
// Commander's addCommand() does NOT inherit exitOverride from the parent,
// so commands built externally (createTestCommand, createProjectCommand, …)
// and attached via addCommand() still have _exitCallback = null and call
// process.exit directly. Recursively set exitOverride so CommanderError
// bubbles up to our catch block for every leaf subcommand.
function applyExitOverrideDeep(cmd: Command): void {
  cmd.exitOverride();
  for (const child of cmd.commands) {
    applyExitOverrideDeep(child);
  }
}
applyExitOverrideDeep(program);

program.configureOutput({
  outputError(str, write) {
    const rephrased = rephraseUnknownOption(str);
    write(rephrased !== null ? `${rephrased}\n` : str);
  },
});

try {
  await program.parseAsync(process.argv);
} catch (err) {
  const rawMode = program.opts<{ output?: string }>().output;
  const mode = isOutputMode(rawMode) ? rawMode : 'text';
  if (err instanceof ApiError) {
    if (mode === 'json') {
      const envelope = {
        error: {
          code: err.code,
          message: err.message,
          nextAction: err.nextAction,
          requestId: err.requestId,
          details: err.details,
        },
      };
      process.stderr.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      process.stderr.write(`Error: ${err.message}\n`);
      if (err.nextAction) process.stderr.write(`${err.nextAction}\n`);
      if (err.requestId && err.requestId !== 'local')
        process.stderr.write(`requestId: ${err.requestId}\n`);
      // C1: surface requiredScopes / grantedScopes on AUTH_FORBIDDEN
      if (err.code === 'AUTH_FORBIDDEN') {
        const required = err.getDetail('requiredScopes');
        const granted = err.getDetail('grantedScopes');
        if (Array.isArray(required) && required.length > 0) {
          process.stderr.write(`  required: ${(required as string[]).join(', ')}\n`);
        }
        if (Array.isArray(granted)) {
          process.stderr.write(`  granted:  ${(granted as string[]).join(', ')}\n`);
        }
      }
    }
    process.exit(err.exitCode);
  }
  const output = new Output(mode);
  if (err instanceof RequestTimeoutError) {
    // Structured rendering for per-request timeouts: JSON mode emits a
    // machine-readable envelope; text mode emits the message with a hint.
    if (mode === 'json') {
      const envelope = {
        error: {
          code: 'REQUEST_TIMEOUT',
          message: err.message,
          nextAction:
            'Increase --request-timeout <seconds> or set TESTSPRITE_REQUEST_TIMEOUT_MS. ' +
            'Check that the backend is reachable and not overloaded.',
          requestId: err.requestId,
          details: { timeoutMs: err.timeoutMs },
        },
      };
      process.stderr.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      process.stderr.write(`Error: ${err.message}\n`);
    }
    process.exit(err.exitCode);
  }
  if (err instanceof CommanderError) {
    // Commander already wrote the error message (via configureOutput) or the
    // help/version text to stdout. Map exit codes per the CLI taxonomy:
    //   help / version  → 0  (user asked for it — no error)
    //   parse errors    → 5  (VALIDATION_ERROR family: missing arg, invalid
    //                         option, unknown command, etc.)
    //
    // Two distinct help codes exist in Commander 12:
    //   'commander.helpDisplayed' — thrown by `-h/--help` flag handler
    //   'commander.help'          — thrown by the built-in `help [command]`
    //                               subcommand (used by `test help`, `project
    //                               help`, `help test`, etc.)
    // Both are user-initiated "show me help" requests and must exit 0 per the
    // AWS-CLI convention. Failing to map 'commander.help' caused these paths
    // to fall through to the generic `process.exit(5)` branch (dogfood P1-4).
    if (
      err.code === 'commander.helpDisplayed' ||
      err.code === 'commander.help' ||
      err.code === 'commander.version'
    ) {
      process.exit(0);
    }
    process.exit(5);
  }
  if (err instanceof CLIError) {
    output.error(err.message);
    process.exit(err.exitCode);
  }
  output.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
