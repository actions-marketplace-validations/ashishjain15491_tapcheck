# Contributing to tapcheck

## Setup

```bash
git clone https://github.com/ashishjain15491/tapcheck && cd tapcheck
npm ci
npx playwright install chromium
```

Node.js 23.6 or newer for development: the source runs as TypeScript directly (`node src/cli.ts`, `bin/tapcheck`), so
there is no build step while you work. The published package is compiled (`npm run build` writes `dist/`) and runs on
Node.js 22.18 or newer.

## Before every push

```bash
npm run typecheck          # tsc over src/ and test/, no output
npm test                   # node --test; some tests start Chromium and local servers, none reaches the network
scripts/check-public.sh    # must exit 0
```

`scripts/check-public.sh` checks three things: no private names (from a `.public-denylist` file you keep locally, one
term per line; it is git-ignored and never committed), every `.md` filename in capitals, and no secrets (gitleaks,
when installed; CI runs it on every pull request either way).

To try a change end to end: `cd examples/static-site && JEV=off node ../../src/cli.ts`. To check what would be
published: `npm pack --dry-run`.

## Rules

- **Every `.md` filename is in CAPITALS**: `README.md`, `SKILL.md`, `LARAVEL.md`.
- **No private names and no secrets**, anywhere: code, tests, docs, examples, commit messages. No real company,
  customer, person, domain or product names from your own work.
- **Fictional examples only**: `example.com` hosts, made-up shops and people, keys that are plainly fake.
- **No new runtime dependencies** without discussing it first. The source keeps to syntax Node.js can strip (no
  enums, no parameter properties); `npm run typecheck` enforces it.
- The built-in suites only read. A change that makes a suite submit, delete or send anything won't be merged. The
  one switch is `interact.submit`, off by default and refused for an app that isn't local; `interact` otherwise
  never clicks a control with an UNSAFE label or the submit button of a form that POSTs.
- Jev judges and code decides: thresholds and verdicts live in code (`src/jev.ts`), and an unsure answer is a
  warning, never a pass.
- Tests never call TypeSafe: pass a fake client to `setup()` as `test/jev.test.ts` does. Never read, print or commit
  a `.env`.
- A new `tapcheck.yml` key goes in four places: `src/config.ts`, `schema/tapcheck.schema.json`,
  `skills/tapcheck-setup/references/CONFIG.md`, and a test (`test/schema.test.ts` fails when the first two disagree).
- Keep the version equal in `package.json`, `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`, and the
  Playwright version equal in `package.json` and the `Dockerfile`'s `FROM` line.

## Layout

| Path | What |
|---|---|
| `src/cli.ts` | the run: config, parts, app and stub lifecycle, report |
| `src/suites/` | one file per suite |
| `src/flow.ts` | the flow API (the package's export) |
| `schema/` | the JSON Schema of `tapcheck.yml` |
| `skills/` | the plugin's four skills and their references |
| `bin/tapcheck` | the launcher the skills use from a checkout |
| `action.yml`, `Dockerfile` | the GitHub Action and the image |
| `examples/static-site/` | a working example, used by the tests |

## Releasing

npm publishing runs from GitHub: `.github/workflows/publish.yml` publishes when a release is published, through npm
trusted publishing (no npm token in the repository; the package's trusted publisher on npmjs.com names this repository,
`publish.yml` and the `npm` environment). Its `build` job checks, tests and packs without the right to publish; its
`publish` job only uploads that tarball, and waits for the `npm` environment's reviewer to approve.

1. Set the new version in `package.json` (`npm version <x.y.z> --no-git-tag-version` also updates the lockfile),
   `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`, and give it a dated section in `CHANGELOG.md`.
2. Commit and push to `main`, and wait for CI.
3. `gh release create v<x.y.z> --title "tapcheck <x.y.z>" --notes-file <that changelog section>`. The tag is also the
   Action's version (`ashishjain15491/tapcheck@v<x.y.z>`). The workflow checks the tag matches `package.json`, runs
   the type check and the tests, and, once the publish is approved on the run's page, publishes
   `@ashishjain15491/tapcheck`.
