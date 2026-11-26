# Changelog

## Unreleased

- **Hash-routed apps.** A screen at `/#scanner` or `/#/orders` is its own page: it is loaded afresh (so it has an
  HTTP status, not 0), the crawl keeps it apart from `/` and follows `#/route` links, and `interact` and `audit` treat
  a new hash as another screen.
- **Sign-in through Google, Discord and the like.** `login: manual` waits until the browser is back on the app's own
  site, so a provider's consent page no longer counts as signed in.
- **interact** never clicks a dark mode, light mode or theme control, which would change the account's settings.
- **context and expect.** `context:` says what kind of product it is (a dense trading tool, a clinical system) and goes
  to Jev with every question, so screens are judged against what its users expect. `expect:` lists findings that are
  right for the product, as `{ match, why }` on `<suite>: <check> @ <where>`: a matching fail or warn is recorded as
  info with the reason, so it stays in the report without failing the run.
- **Marked screenshots.** `MARK=1` (or `marks: true`) puts a marked screenshot first in a failing or warning finding's
  evidence: the screen as it was measured, a banner saying the check, and a box, a number and a note on each element.
  `audit`, `a11y`, `crawl` and `interact` mark the elements they found; what Jev judged, and a failed flow step, get
  the banner alone. Off by default, and nothing changes without it.
- **t.mark.** `t.mark(check, status, marks, detail?)` records a finding a flow decided, with a marked screenshot of
  the current page: red for a bug, green for a pass, blue for a setting, amber for a question. It needs no Jev.
- **Verify a release or a pull request.** The new `tapcheck-verify` skill splits a release note, a pull request or a
  range of commits into items and writes a flow for each. A flow says which item it checks with `item:`, or
  `t.untested(why)` when it can't be checked now; `ONLY=verify` runs just those flows, and the report opens with
  "Release verification": the count, the failed items with their steps and screenshots, the passed table, the
  questions and what wasn't tested. `verify` is a tag now, so no side can be called that.

## 0.1.2 (2026-11-25)

- **GitHub Marketplace.** The Action is named "tapcheck audit", since the Marketplace needs a name no GitHub account
  uses. It is still used as `ashishjain15491/tapcheck@<tag>`.
- **Escaping fixes** (from CodeQL). A backslash in a coverage row no longer breaks its `COVERAGE.md` table cell, and a
  `login.form` field name with a backslash in it finds its field.

## 0.1.1 (2026-11-25)

No change to what tapcheck checks or how it runs.

- **README and logo.** A shorter README in the usual layout, with the tapcheck logo (light and dark), a report
  screenshot and badges, and setup steps for each way to run it: writing `tapcheck.yml`, the Jev key, sign-in
  variables, then the plugin, npm, the Action and Docker. The logo kit and the social preview are in `assets/`; the
  Codex plugin and the Action use the brand colour.
- **GitHub Marketplace.** The Action's description fits the Marketplace's 125 characters.
- **Action.** It runs on the current `actions/setup-node` and `actions/upload-artifact` (v7).
- **Releases from GitHub.** `.github/workflows/publish.yml` publishes to npm when a release is published, through npm
  trusted publishing with provenance; the release steps are in `CONTRIBUTING.md`.
- **Repository.** Dependabot updates, a security policy, issue forms, a pull request template and a code of conduct.

## 0.1.0 (2026-11-25)

The first release: on npm as `@ashishjain15491/tapcheck` (the CLI is still `tapcheck`), and as the GitHub Action
`ashishjain15491/tapcheck@v0.1.0`.

- **Core harness.** One `tapcheck.yml` describes the app: how to start, stop and reset it, its sides and how each
  signs in (`none`, `manual`, `form` with optional TOTP, `command`), screens, tasks and viewports. `$NAME` values come
  from the environment. One run writes `report.html`, `REPORT.md`, `findings.json` and the evidence. Parts that were
  skipped or couldn't run (no Jev key, budget reached, sign-in failed, session expired) get a "part ran" finding each,
  so the report says which and why.
- **Measured suites.** `crawl` (page status, load time, console errors, broken images and links, unlabelled fields),
  `contract` (API status, JSON that parses, latency, response shape against a saved baseline), `security` (headers,
  cookie flags, pages that need sign-in, CSRF, served secrets, third-party requests) and `a11y` (axe-core WCAG 2.2
  A/AA, keyboard focus, page language).
- **Interaction and UI audit suites.** `interact` clicks every safe control on the crawled
  screens and reports page errors, 5xx answers, native dialogs and controls that do nothing; checks each dialog it
  opens (accessible name, focus, Escape, an error state for invalid input) and each table's sorting, search, paging
  and row menu; and writes `interact.json`. `audit` is the full UI audit per screen: desktop light and dark, tablet
  and phone, opened menus and dialogs, component and label-case consistency across screens, optional design-token
  adherence, and Jev's look when Jev is on; it writes `audit.json`. New keys: `interact: {max, submit}`,
  `audit: {max, skip}`, `design: {colors, fonts, radii, spacing}`. `interact.submit: true` changes data and is for a
  throwaway database only.
- **Run-level additions.** `HEADED=1`, `SLOWMO=<ms>` and `START_DELAY=<s>` for watching a run;
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
  `CHANGED=1` runs only the parts whose files changed since each last passed. `CHANGED=<git ref>` (the Action's
  `changed: base`) is QA for a pull request: the parts whose files changed since the branch point with that ref, with
  no state needed. `changes:` also keys on a part name, so each flow can depend on its own files. `parallel: <n>`
  (or `PARALLEL=<n>`) runs that many of a side's flows at once; a flow with `serial: true` runs alone.
- **Your own checks.** `gates` (the project's linters and audits, as the part `code`), `routes` (route coverage and
  writing routes without sign-in), `stub` (a stand-in for outside services, with a control API) and `flows` (custom
  journeys with `t.step`, `t.stub`, `t.mail`).
- **Plugin.** A Claude Code and Codex plugin with three skills: `tapcheck-setup`, `tapcheck-run`, `tapcheck-fix`,
  and recipes for Laravel, Django, Rails, Express and Next.js, Go and static sites.
- **Shipping.** A compiled npm package (`dist/`, Node.js 22.18 or newer) with types for flows; a JSON Schema for
  `tapcheck.yml`; a Docker image on the official Playwright image; a GitHub Action that runs tapcheck, writes the
  job summary and uploads the run folder; CI with a type check. A missing Chromium is now one line naming the
  command that installs it, and `CHANGED=1` works where git has no author configured (containers, CI runners).
- **Fixes from the first real project.** The crawl follows the links it finds before the route list, and
  only pages it actually crawled count toward `crawl.max` (a long route list used to crowd the links out). The
  signed-out check follows redirects, so `/` → `/admin` → `/login` counts as refused. A CSRF token cookie
  (`XSRF-TOKEN`, `csrftoken`) may be readable by script. The CSRF probe goes to the sides that sign in (every side
  when none does), and a side can have its own `csrf`. Flows get `t.note(name, detail, 'warn' | 'info')` and a
  `timeout` (default 3600 s), so a flow that hangs fails instead of stalling the run. A step that returns
  `{ warn: '…' }` is recorded as a warning, and `t.mail` has `count()` and `all()`, with each message's `id` and
  `headers` (for checks such as List-Unsubscribe on every email of a send).
  `t.jev()` waits for the page to settle and looks again when the page reloads under it. The crawl takes a link to a
  file (a PDF download) for what it is, not a page that answered 0, and a signed-out side skips the routes the list
  marks `auth`. Stopping the app stops what `app.start` left running in the background too, and `app.stop` runs only
  when tapcheck started the app. The setup skill has a step for what the app needs around it: outside services,
  background work, build and seed. A page load that fails (a timeout on a busy app, an aborted
  navigation) is tried once more before it counts. Flows: a flow past its timeout records nothing more, `t.signal` is
  aborted and `t.cleanup(fn)` callbacks run; each step prints a line as it ends; `t.ask` (Jev about text, on the
  budget), `t.reach`, `t.page({ fresh: true })`, `t.dir` and a failing `t.note`; `t.goto` notices an ended session;
  `VISUAL` and `EMAIL` are exported; a Jev request is capped at 120 s and retried once, and an outage is a warning;
  with a dialog open `t.jev` looks at the screen only; failure screenshots are numbered so long names can't overwrite
  each other. The visual "error shown" question no longer counts a notice about the data as an error.
  Past its timeout a flow's pages are closed before its cleanups run, and only the cleanups' own `t.*` calls still
  work (the abandoned run() stops at its next one); `t.use(page)` makes a page current again; `t.reach` takes the
  answer's status and skips refused ones; Mailpit and stub calls give up after 30 s or at the timeout;
  `t.mail.all({ limit })`; a form POST with `_method` is reached as that method.
  `browser.args` passes extra switches to the run's Chromium (an app on localhost whose sandboxed preview frames load
  its own files needs `--disable-features=LocalNetworkAccessChecks`). A side whose sign-in fails says so in the
  terminal, not only in the report.
  Waiting for a page to settle is capped outside the page, so a page whose own timers never fire (one
  sandboxed by its CSP without `allow-scripts`, such as an email preview) can't hang the run.
  `t.page({ viewport: 'mobile' })` hands a flow a page at any of the config's viewports (the first one by default), so
  a flow can check a journey at a phone's width and have Jev look at it.
