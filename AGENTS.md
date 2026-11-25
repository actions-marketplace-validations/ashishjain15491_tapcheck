# tapcheck

tapcheck is an end-to-end and UI audit harness for any web app, whatever its language or stack. It drives the running
app in a real browser, measures what code can measure (crawl, API contract, security headers, accessibility,
interaction, a UI audit, the project's own gates and flows), and asks Jev to judge what needs a human eye (visual QA,
design, usability). One file, `tapcheck.yml`, describes the app; one run writes one report.

This repository is also a plugin for Claude Code and Codex. The workflows are plain Markdown, so any agent can follow
them without plugin support:

- `skills/tapcheck-setup/SKILL.md`: detect the project's stack, write `tapcheck.yml`, get a first run through.
- `skills/tapcheck-run/SKILL.md`: pick the parts to run, run them, report the findings.
- `skills/tapcheck-fix/SKILL.md`: fix failing findings in the app's code and rerun until they pass.

Run the CLI with `bin/tapcheck` from the folder that holds the project's `tapcheck.yml` (Node.js 23.6 or newer; the
first run installs its dependencies). Without a checkout, `npx tapcheck@<version>` is the same CLI from npm (Node.js 22.18 or newer, after `npx playwright install chromium`). Every `tapcheck.yml` key is in
`skills/tapcheck-setup/references/CONFIG.md` and, as JSON Schema, in `schema/tapcheck.schema.json`; the code that
checks them is `src/config.ts`; the run options are at the top of `src/cli.ts`.

Working on tapcheck itself: `npm run typecheck` and `npm test` must pass, `scripts/check-public.sh` must exit 0 before
a push, and every `.md` filename is in capitals. `CONTRIBUTING.md` has the rest.
