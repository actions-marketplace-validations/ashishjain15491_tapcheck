# Changelog

## 0.1.0 (pre-release)

The first version. Not yet published to npm.

- **Core harness.** One `tapcheck.yml` describes the app: how to start, stop and reset it, its sides and how each
  signs in (`none`, `manual`, `form` with optional TOTP, `command`), screens, tasks and viewports. `$NAME` values come
  from the environment. One run writes `report.html`, `REPORT.md`, `findings.json` and the evidence.
- **Measured suites.** `crawl` (page status, load time, console errors, broken images and links, unlabelled fields),
  `contract` (API status, JSON that parses, latency, response shape against a saved baseline), `security` (headers,
  cookie flags, pages that need sign-in, CSRF, served secrets, third-party requests) and `a11y` (axe-core WCAG 2.2
  A/AA, keyboard focus, page language).
- **Jev suites.** `ux` (visual QA, design, heuristics, a five-second test, predicted attention) and `usability` (a
  simulated first-time user attempting each task, with a clickstream), with a per-run budget, a memo, and a log of
  every request. Unsure answers are warnings.
- **Parts.** Every suite on every side is a part; `ONLY` and `SKIP` pick them by name or tag, `LIST=1` prints them,
  `CHANGED=1` runs only the parts whose files changed since each last passed.
- **Your own checks.** `gates` (the project's linters and audits, as the part `code`), `routes` (route coverage and
  writing routes without sign-in), `stub` (a stand-in for outside services, with a control API) and `flows` (custom
  journeys with `t.step`, `t.stub`, `t.mail`).
- **Plugin.** A Claude Code and Codex plugin with three skills: `tapcheck-setup`, `tapcheck-run`, `tapcheck-fix`,
  and recipes for Laravel, Django, Rails, Express and Next.js, Go and static sites.
- **Shipping.** A compiled npm package (`dist/`, Node.js 22.18 or newer) with types for flows; a JSON Schema for
  `tapcheck.yml`; a Docker image on the official Playwright image; a GitHub Action that runs tapcheck, writes the
  job summary and uploads the run folder; CI with a type check. A missing Chromium is now one line naming the
  command that installs it, and `CHANGED=1` works where git has no author configured (containers, CI runners).
