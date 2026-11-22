# Changelog

## 0.1.0 (pre-release)

The first version. Not yet published to npm.

- **Core harness.** One `tapcheck.yml` describes the app: how to start, stop and reset it, its sides and how each
  signs in (`none`, `manual`, `form` with optional TOTP, `command`), screens, tasks and viewports. `$NAME` values come
  from the environment. One run writes `report.html`, `REPORT.md`, `findings.json` and the evidence. Parts that were
  skipped or couldn't run (no Jev key, budget reached, sign-in failed, session expired) get a "part ran" finding each,
  so the report says which and why.
- **Measured suites.** `crawl` (page status, load time, console errors, broken images and links, unlabelled fields),
  `contract` (API status, JSON that parses, latency, response shape against a saved baseline), `security` (headers,
  cookie flags, pages that need sign-in, CSRF, served secrets, third-party requests) and `a11y` (axe-core WCAG 2.2
  A/AA, keyboard focus, page language).
- **Interaction and UI audit suites (unreleased additions).** `interact` clicks every safe control on the crawled
  screens and reports page errors, 5xx answers, native dialogs and controls that do nothing; checks each dialog it
  opens (accessible name, focus, Escape, an error state for invalid input) and each table's sorting, search, paging
  and row menu; and writes `interact.json`. `audit` is the full UI audit per screen: desktop light and dark, tablet
  and phone, opened menus and dialogs, component and label-case consistency across screens, optional design-token
  adherence, and Jev's look when Jev is on; it writes `audit.json`. New keys: `interact: {max, submit}`,
  `audit: {max, skip}`, `design: {colors, fonts, radii, spacing}`. `interact.submit: true` changes data and is for a
  throwaway database only.
- **Run-level additions (unreleased).** `HEADED=1`, `SLOWMO=<ms>` and `START_DELAY=<s>` for watching a run;
  `RECORD=1` for a video and a Playwright trace of every browser context, linked from the report. Flows get
  `t.jev(label, questions?)` (Jev's look at the current page) and `t.mail.judge(mail, questions?)` (at an email), both
  skipped cleanly with `JEV=off`. Every run writes `hits.json` per side, and `COVERAGE=1` merges all runs into
  `COVERAGE.md`: each route with the part that reached it or GAP (`coverage: {file, reasons}`). `app.resetWhen` runs
  `app.reset` by itself when matching files changed since the last reset. `stub.dns` answers DNS over UDP
  (`TAPCHECK_DNS`), with overrides through the control API and `t.stub.dns()`.
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
- **Fixes from the first real project (unreleased).** The crawl follows the links it finds before the route list, and
  only pages it actually crawled count toward `crawl.max` (a long route list used to crowd the links out). The
  signed-out check follows redirects, so `/` → `/admin` → `/login` counts as refused. A CSRF token cookie
  (`XSRF-TOKEN`, `csrftoken`) may be readable by script. The CSRF probe goes to the sides that sign in (every side
  when none does), and a side can have its own `csrf`. Flows get `t.note(name, detail, 'warn' | 'info')`.
