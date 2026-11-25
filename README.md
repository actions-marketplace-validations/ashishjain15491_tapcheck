<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/ashishjain15491/tapcheck/main/assets/tapcheck-primary-dark.svg">
    <img alt="tapcheck" src="https://raw.githubusercontent.com/ashishjain15491/tapcheck/main/assets/tapcheck-primary.svg" width="360">
  </picture>
</p>

<p align="center">
<a href="https://www.npmjs.com/package/@ashishjain15491/tapcheck"><img alt="npm" src="https://img.shields.io/npm/v/@ashishjain15491/tapcheck"></a>
<a href="https://github.com/ashishjain15491/tapcheck/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/ashishjain15491/tapcheck/actions/workflows/ci.yml/badge.svg"></a>
<a href="https://github.com/ashishjain15491/tapcheck/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/github/license/ashishjain15491/tapcheck"></a>
</p>

End-to-end and UI audit for any web app, whatever its language or stack. tapcheck drives the running app in a real
browser, measures what code can measure, and asks Jev to judge what needs a human eye. One file, `tapcheck.yml`,
describes the app; one run writes one report.

## Quick start

```bash
npm install --save-dev tapcheck@npm:@ashishjain15491/tapcheck   # Node.js 22.18 or newer
npx playwright install chromium                                 # once
npx tapcheck                                                    # in the folder with tapcheck.yml
```

Or without installing: `npx @ashishjain15491/tapcheck@0.1.0`. A minimal `tapcheck.yml`:

```yaml
baseUrl: http://127.0.0.1:8000
app:
  start: npm start          # skipped when the app already answers; stopped after the run
screens:
  - { name: Home, path: /, purpose: see what the shop sells }
```

Only `baseUrl` is required. Every key is in [CONFIG.md](skills/tapcheck-setup/references/CONFIG.md), with
[recipes per stack](skills/tapcheck-setup/references/stacks) and a [working example](examples/static-site).

## What it checks

| Suite | Judged by | What it reports |
|---|---|---|
| `crawl` | code | 4xx/5xx and slow pages, console errors, broken images and links, unlabelled fields |
| `contract` | code | failing or slow API calls, unparsable JSON, responses that changed shape |
| `security` | code | missing headers, weak cookie flags, pages open when signed out, CSRF, leaked secrets |
| `a11y` | code | axe-core WCAG 2.2 A/AA violations, keyboard focus, page language |
| `interact` | code | clicks every safe control: errors, controls that do nothing, broken dialogs and tables |
| `audit` | code and Jev | the UI on desktop, dark mode, tablet and phone; inconsistent components and design tokens |
| `code` | code | your own linters and checks (`gates:`) |
| `flow-<name>` | code | your own journeys (`flows:`), one finding per step |
| `ux` | Jev | visual QA, design, usability heuristics, a five-second test |
| `usability` | Jev | a simulated first-time user tries each task |

Each suite runs once per side (`public`, `customer`, `admin`: each kind of person who sees a different app). Jev answers
with probabilities and code decides: a clear answer passes or fails, an unsure one is a warning. Without a Jev key the
Jev parts are skipped and everything else runs.

Runs take options as environment variables, for example `ONLY=a11y`, `SKIP=jev`, `CHANGED=origin/main` (only what a
branch changed), `PARALLEL=4` (flows at once) or `LIST=1`. The full list is in
[CONFIG.md](skills/tapcheck-setup/references/CONFIG.md#environment-variables-for-a-run).

## Other ways to run it

**Claude Code and Codex plugin.** Three skills set tapcheck up for your app, run it and fix what it finds
([AGENTS.md](AGENTS.md) has the same steps for any agent):

```
/plugin marketplace add ashishjain15491/tapcheck     # Claude Code
/plugin install tapcheck@tapcheck
codex plugin marketplace add ashishjain15491/tapcheck && codex plugin add tapcheck@tapcheck     # Codex
```

**GitHub Action.** It adds the report to the job summary, uploads the run folder and fails the step when a check
fails. `changed: base` checks only what the pull request changed (with `fetch-depth: 0`). Inputs are in
[action.yml](action.yml).

```yaml
- uses: actions/checkout@v4
- uses: ashishjain15491/tapcheck@v0.1.0
  env:
    TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}   # optional
```

**Docker.** The image has Node.js, Chromium and tapcheck, not your app's runtime, so start the app outside it and
point `baseUrl` at `host.docker.internal` (macOS, Windows) or add `--network host` (Linux).

```bash
git clone https://github.com/ashishjain15491/tapcheck && docker build -t tapcheck tapcheck
docker run --rm --ipc=host -v "$PWD:/work" -w /work tapcheck
```

## Output

<img alt="A tapcheck report: one card per suite, then each finding with its evidence" src="https://raw.githubusercontent.com/ashishjain15491/tapcheck/main/assets/report.png">

Each run writes `.tapcheck/run-<time>/` (git-ignore it): `report.html`, `REPORT.md` for a pull request,
`findings.json` for tools and agents, and the screenshots and evidence. The exit code is 0 when no check fails, 1 when
one does, and 2 when the run couldn't start.

## Jev and your data

The `ux` and `usability` suites and `audit`'s looks ask Jev, a paid model from TypeSafe. Set `TYPESAFE_API_KEY` in the
environment or a `.env` next to `tapcheck.yml`; `JEV=off` turns it off. A run stops asking at `jev.budget` US dollars
(default 1).

Jev is sent screenshots of the configured screens, tasks, menus and dialogs, with the screen names, purposes, tasks and
visible control labels. No page source, cookies, sessions or environment variables. `payloads.json` in the run folder
holds every request as sent. Run against test data, since screenshots show whatever the test user sees.

## Safety

- The built-in suites only read, except `interact`, which clicks controls but never one labelled delete, send, pay,
  sign out and the like, nor a form's submit. Run it against test data.
- Flows are your own code and may change data; leave them out with `SKIP=flow`.
- `RESET=1` (`app.reset`) and `interact.submit: true` only run when the app is local.
- Signed-in sessions are saved under `.tapcheck`; keep it out of git and shared artifacts.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [changelog](CHANGELOG.md). MIT licensed.
