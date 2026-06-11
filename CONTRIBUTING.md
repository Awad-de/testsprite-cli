# Contributing to testsprite-cli

Thanks for contributing! Drive-by fixes and small PRs are welcome — you don't need permission to start.

## Questions & support

This project is young — if anything is confusing or broken, please tell us. We're responsive on all of these:

- 💬 [Discord](https://discord.gg/W4JDrZfdB) — fastest way to reach us
- 🐛 [GitHub issues](https://github.com/TestSprite/testsprite-cli/issues) — bugs and feature requests
- 📧 [contact@testsprite.com](mailto:contact@testsprite.com) — email works too

## Prerequisites

- Node 20 or newer (development happens on Node 22).

## Build from source

```bash
npm install
npm run build          # tsc → dist/
npm link               # optional: makes `testsprite` resolve to your local checkout
```

The compiled binary lands at `dist/index.js`. During development you can run it
directly with `node dist/index.js <command>`.

## Testing

```bash
npm test               # Vitest unit suite (mock-based; no network or credentials)
npm run test:coverage  # Vitest with v8 coverage (>= 80% gate)
```

Unit tests are mock-based and run with no external dependencies — this is the
suite contributors run locally and in CI. A separate live end-to-end suite
(`npm run test:dev`) runs against an internal TestSprite backend and requires
maintainer credentials; it is not needed to contribute.

## Lint, format, and type-check

```bash
npm run lint           # ESLint
npm run lint:fix       # ESLint with --fix
npm run format         # Prettier (write)
npm run format:check   # Prettier (check only)
npm run typecheck      # tsc --noEmit
```

## CI gates (required for merge)

- ESLint + Prettier clean
- TypeScript type-check clean
- All unit tests passing
- Coverage ≥ 80% on lines / statements / functions / branches
- Build + smoke test of the CLI binary

## Branches, pull requests, and releases

- `main` is the only long-lived branch in this repo — it tracks the latest
  released code.
- To contribute: **fork the repo, create a branch in your fork, and open a
  pull request against `main`.** You don't need any access to this repo to
  do that.
- Branch names use a type prefix: `feat/…`, `fix/…`, `docs/…`, `refactor/…`, `test/…`, `chore/…`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org) — e.g. `feat(cli): …`, `fix(http): …`.
- This repo mirrors TestSprite's internal integration branch. After your PR
  is merged, maintainers fold the change into the internal source of truth,
  and it ships with the next release sync — so the file you touched may be
  updated again by a later sync commit.
- Releases are cut by pushing a semver git tag (`vX.Y.Z`), which publishes the
  package and creates a GitHub Release.

## Project layout

- `src/commands/` — one module per command group (`auth`, `project`, `test`, `agent`).
- `src/lib/` — shared building blocks: `http` (client + retry/backoff), `poll`
  (run polling), `output` (JSON/text rendering), `config` / `credentials`
  (profile + API-key handling), `errors` (typed envelopes + exit-code mapping),
  `target-url` (URL pre-flight guard), and `dry-run/` (offline sample responses).
- `src/index.ts` — CLI entry point; maps API errors to exit codes.
- `test/` — Vitest unit and snapshot suites; `test/mock-backend/` provides the
  MSW-based fake API used by the unit suite.

See [`DOCUMENTATION.md`](./DOCUMENTATION.md) for the full command reference.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](./LICENSE).
