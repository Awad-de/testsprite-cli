#!/usr/bin/env node
// Post-build hook: make dist/index.js executable.
//
// Replaces the previous `chmod +x dist/index.js` shell command, which
// fails on Windows (`'chmod' is not recognized`). On Windows Node only
// honors the writable/read-only bit so 0o755 is effectively a no-op for
// execute permissions, but the call is harmless. On POSIX it sets the
// executable bit as before.
//
// Skill assets (skills/*.md) live at the repo/package ROOT and ship verbatim
// via package.json `files`. agent-targets.ts resolves them with `../../skills`,
// which points at the package root from BOTH `src/lib` (vitest) and `dist/lib`
// (built) — so no asset copy into dist/ is needed (the old src/assets →
// dist/assets mirror is gone).
import { chmodSync } from 'node:fs';
chmodSync(new URL('../dist/index.js', import.meta.url), 0o755);
