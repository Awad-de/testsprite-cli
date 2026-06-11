#!/usr/bin/env node
// Post-build hook: make dist/index.js executable and copy asset tree.
//
// Replaces the previous `chmod +x dist/index.js` shell command, which
// fails on Windows (`'chmod' is not recognized`). On Windows Node only
// honors the writable/read-only bit so 0o755 is effectively a no-op for
// execute permissions, but the call is harmless. On POSIX it sets the
// executable bit as before.
//
// Asset copy: tsc only emits .ts → .js; .md assets (e.g. the agent skill
// body) are not copied by the compiler. This step mirrors src/assets/ into
// dist/assets/ so the built binary resolves them at the same relative path.
import { chmodSync, cpSync, rmSync } from 'node:fs';
chmodSync(new URL('../dist/index.js', import.meta.url), 0o755);
rmSync(new URL('../dist/assets', import.meta.url), { recursive: true, force: true });
cpSync(new URL('../src/assets', import.meta.url), new URL('../dist/assets', import.meta.url), {
  recursive: true,
});
