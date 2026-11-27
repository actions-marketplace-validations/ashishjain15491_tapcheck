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

## What it checks

| Suite | Judged by | What it reports |
|---|---|---|
| `crawl` | code | 4xx/5xx and slow pages, console errors, broken images and links, unlabelled fields |
| `contract` | code | failing or slow API calls (to the app's host and its subdomains, `api.<domain>` too), unparsable JSON, responses that changed shape |
| `security` | code | missing headers, weak cookie flags, pages open when signed out (with `signedIn`, pages that still show it), CSRF, leaked secrets, new-tab links without `noopener` |
| `a11y` | code | axe-core WCAG 2.2 A/AA violations, keyboard focus, page language |
| `interact` | code | clicks every safe control: errors, controls that do nothing, broken dialogs and tables |
| `audit` | code and Jev | the UI on desktop, dark mode, tablet and phone, and each menu and dialog it opens; inconsistent components and design tokens |
| `code` | code | your own linters and checks (`gates:`) |
| `flow-<name>` | code | your own journeys (`flows:`), one finding per step |
| `ux` | Jev | visual QA, design, usability heuristics, a five-second test |
| `usability` | Jev | a simulated first-time user tries each task |

Each suite runs once per side (`public`, `customer`, `admin`: each kind of person who sees a different app). Jev answers
with probabilities and code decides: a clear answer passes or fails, an unsure one is a warning, and so is a score just
under the pass mark (5.5 to 7 out of 10; trust and minimalism pass from 5.5). Without a Jev key the Jev parts are
skipped and everything else runs.

`MARK=1` puts a marked screenshot first in each failing or warning finding: a banner saying the check, and a numbered
box and a note on each element at fault. To check a release or a pull request item by item, the `tapcheck-verify` skill
writes a flow per item, and the report opens with "Release verification": what passed, failed or wasn't tested.

## Install

Pick one. Each runs the same CLI.

**Claude Code or Codex plugin.** Four skills set tapcheck up for your app, run it, fix what it finds and verify a
release or a pull request item by item. In Claude
Code:

```
/plugin marketplace add ashishjain15491/tapcheck
/plugin install tapcheck@tapcheck
```

In Codex:

```bash
codex plugin marketplace add ashishjain15491/tapcheck
codex plugin add tapcheck@tapcheck
```

Any other agent can follow the same steps from [AGENTS.md](AGENTS.md). The plugin needs Node.js 23.6 or newer; its
first run installs its own dependencies and Chromium.

**npm.** Node.js 22.18 or newer:

```bash
npm install --save-dev tapcheck@npm:@ashishjain15491/tapcheck
npx playwright install chromium     # once
```

Or run it without installing: `npx @ashishjain15491/tapcheck@0.1.3`.

**GitHub Action** and **Docker**: see [Run it](#3-run-it) below.

## Set up

### 1. Write tapcheck.yml

**With the plugin**, ask your agent to *"Set up tapcheck for this app"*. The `tapcheck-setup` skill detects the
stack, writes `tapcheck.yml` (how to start the app, who signs in, the screens and tasks that matter, your linters as
gates), adds `.tapcheck/` and `.env` to `.gitignore`, and gets a first run through. It tells you which variables to
set; it never asks for a password or key in chat.

**By hand**, put `tapcheck.yml` in the project root. Only `baseUrl` is required:

```yaml
baseUrl: http://127.0.0.1:8000
app:
  start: npm start                  # skipped when the app already answers; stopped after the run
audience: a shop owner who is not technical
screens:                            # what Jev looks at; the crawl finds the rest
  - { name: Home, path: /, purpose: see what the shop sells }
tasks:                              # what the simulated first-time user tries
  - name: Find the opening hours
    from: /
    goal: Find when the shop is open on Saturday.
    done: A page showing the opening hours is open.
    notDone: It shows the home page, another page, or an error.
    optimal: 1                      # the fewest clicks that reach it
```

Then add `.tapcheck/` (reports, screenshots, signed-in sessions) and `.env` to `.gitignore`. Every key is in
[CONFIG.md](skills/tapcheck-setup/references/CONFIG.md), with
[recipes per stack](skills/tapcheck-setup/references/stacks) (Laravel, Django, Rails, Express and Next.js, Go, static
sites) and a [working example](examples/static-site).

**Signed-in pages.** Give each kind of user a side with a `login`, and keep credentials out of the file: write
`$NAME` and set the variable when you run. A missing one stops the run.

```yaml
sides:
  public: {}
  customer:
    login:
      form: { url: /login, fields: { email: $TAPCHECK_EMAIL, password: $TAPCHECK_PASSWORD } }
```

`login: manual` opens a browser for you to sign in once (Google, Discord and the like), and the session is kept in
`.tapcheck/`. A single-page app that shows its sign-in form in place when the session ends also needs `signedIn`, a
selector every signed-in page has, so an ended session stops the side instead of auditing the sign-in form.

### 2. Add the Jev key (optional)

`ux`, `usability` and `audit`'s look at each screen ask Jev, a paid model from [TypeSafe](https://docs.typesafe.ai).
Without a key those are skipped and everything else runs. With one:

| Where you run | Put the key |
|---|---|
| your machine, the plugin or npm | `TYPESAFE_API_KEY=…` in `.env` next to `tapcheck.yml` (git-ignored), or `export TYPESAFE_API_KEY=…` |
| GitHub Actions | a repository secret `TYPESAFE_API_KEY`, passed as `env:` on the step (below) |
| Docker | `-e TYPESAFE_API_KEY` on `docker run`, with the variable set in your shell |

A run stops asking once it has spent `jev.budget` US dollars (default 1; `JEV_BUDGET=0.25` for one run), and
`JEV=off` turns Jev off. Only the key is read from `.env`; sign-in variables come from the environment.

### 3. Run it

**Plugin:** ask *"Run tapcheck on what I changed"*, *"Fix the tapcheck failures"* to have it fix your code and
rerun until each check passes, or *"Verify this release"* with the release note or pull request.

**npm:** from the folder with `tapcheck.yml`:

```bash
npx tapcheck                         # everything
ONLY=a11y,security npx tapcheck      # some parts
CHANGED=origin/main npx tapcheck     # only what this branch changed
```

**GitHub Action:** the job has to install what `app.start` needs first. It adds the report to the job summary,
uploads the run folder and fails the step when a check fails; inputs are in [action.yml](action.yml).

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }            # for changed: base
# …install your app's language, dependencies and a test database…
- uses: ashishjain15491/tapcheck@v0.1.3
  with:
    changed: base                     # optional: only what the pull request changed
  env:
    TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}   # optional
    TAPCHECK_EMAIL: ${{ secrets.TAPCHECK_EMAIL }}       # whatever your tapcheck.yml asks for
    TAPCHECK_PASSWORD: ${{ secrets.TAPCHECK_PASSWORD }}
```

**Docker:** the image has Node.js, Chromium and tapcheck but not your app's runtime, so start the app outside it and
point `baseUrl` at `host.docker.internal` (macOS, Windows) or add `--network host` (Linux):

```bash
git clone https://github.com/ashishjain15491/tapcheck && docker build -t tapcheck tapcheck
docker run --rm --ipc=host -e TYPESAFE_API_KEY -v "$PWD:/work" -w /work tapcheck
```

Options are environment variables (`ONLY`, `SKIP`, `CHANGED`, `PARALLEL=4` for flows at once, `MARK=1` for marked
screenshots, `ONLY=verify` for the release flows, `LOGIN=1` to sign in again, `LIST=1` to list the parts); the full list is in [CONFIG.md](skills/tapcheck-setup/references/CONFIG.md#environment-variables-for-a-run).

## Output

<img alt="A tapcheck report: one card per suite, then each finding with its evidence" src="https://raw.githubusercontent.com/ashishjain15491/tapcheck/main/assets/report.png">

Each run writes `.tapcheck/run-<time>/` (git-ignore it): `report.html`, `REPORT.md` for a pull request (failures,
warnings, skipped parts and the `expect:` matches), `findings.json` for tools and agents, and the screenshots and
evidence. The exit code is 0 when no check fails, 1 when
one does, and 2 when the run couldn't start.

## Jev and your data

Jev is sent screenshots of the configured screens, tasks, menus and dialogs, with the screen names, purposes, tasks and
visible control labels. No page source, cookies, sessions or environment variables. `payloads.json` in the run folder
holds every request as sent. Run against test data, since screenshots show whatever the test user sees.

## Safety

- The built-in suites only read, except `interact`, which clicks controls but never one labelled delete, send, pay,
  sign out and the like, a theme switch, nor a form's submit. Run it against test data: a filter or toggle it clicks
  stays changed if the app saves it on the server. The saved session keeps only the sign-in, so what it clicks in the
  browser isn't carried into later parts.
- Flows are your own code and may change data; leave them out with `SKIP=flow`.
- `RESET=1` (`app.reset`) and `interact.submit: true` only run when the app is local.
- Signed-in sessions are saved under `.tapcheck`; keep it out of git and shared artifacts.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [changelog](CHANGELOG.md). MIT licensed.
