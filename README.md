# tapcheck

End-to-end and UI audit harness for any web app, whatever its language or stack. It drives the running app in a real
browser, measures what code can measure, and asks Jev to judge what needs a human eye. One file, `tapcheck.yml`,
describes the app; one run writes one report.

Status: **0.1.0, pre-release.** It works from a checkout and as a plugin today. The npm package, the Docker image and
the action tag are published with the first release; the commands below are the ones that will work then.

## What it checks

Every suite runs once per side (each kind of person who sees a different app: `public`, `customer`, `admin`).

| Suite | Judged by | What it reports |
|---|---|---|
| `crawl` | code | pages that answer 4xx/5xx or load slowly, console errors, broken images and links, unlabelled form fields, route coverage |
| `contract` | code | API calls answering 4xx/5xx, HTML or unparsable JSON sent to a script, slow calls, a response that lost a key since the saved baseline |
| `security` | code | missing security headers, weak session-cookie flags, pages open when signed out, CSRF not refused, secrets in served HTML or scripts, third-party requests |
| `a11y` | code | axe-core WCAG 2.2 A/AA violations per screen and viewport, keyboard focus that doesn't move or can't be seen, a missing page language |
| `code` | code | your own linters, type checks and audits (`gates:`), and writing routes that need no sign-in |
| `flow-<name>` | code | your own journeys (`flows:`), one finding per step |
| `ux` | Jev | visual QA (overlap, clipping, errors on screen), design (main action, hierarchy, legibility, spacing), usability heuristics, a five-second test, predicted attention |
| `usability` | Jev | a simulated first-time user tries each task by clicking: reached or not, extra clicks, hesitation, dead clicks |

Jev answers with probabilities and code decides: a clear answer passes or fails, an unsure one is a warning for a
person to look at, never a pass. Without a Jev key the two Jev suites are skipped and everything else runs.

## Four ways to run it

All four run the same CLI from the folder that holds `tapcheck.yml`, and take the same options as environment
variables (`ONLY=a11y`, `SKIP=jev`, `CHANGED=1`, `JEV=off`, `LIST=1`; the full list is in
[CONFIG.md](skills/tapcheck-setup/references/CONFIG.md#environment-variables-for-a-run)).

### 1. As a plugin for Claude Code and Codex

```
/plugin install tapcheck --marketplace ashishjain15491/tapcheck     # Claude Code
codex plugin marketplace add ashishjain15491/tapcheck && codex plugin add tapcheck@tapcheck     # Codex
```

Three skills do the work: **tapcheck-setup** detects your stack, writes `tapcheck.yml` and gets a first run through
("Set up tapcheck for this app"); **tapcheck-run** picks the parts, runs them and reports ("Run tapcheck on what I
changed"); **tapcheck-fix** fixes failing findings in your code and reruns each part until it passes, without
loosening any check ("Fix the tapcheck failures"). They call `bin/tapcheck` in the plugin's own folder (Node.js 23.6
or newer; the first run installs its dependencies and Chromium). Any other agent can follow the same files: see
[AGENTS.md](AGENTS.md).

### 2. From npm

```bash
npm install --save-dev tapcheck     # Node.js 22.18 or newer
npx playwright install chromium     # once; the browser tapcheck drives
npx tapcheck                        # in the folder with tapcheck.yml
```

### 3. With Docker

```bash
git clone https://github.com/ashishjain15491/tapcheck && docker build -t tapcheck tapcheck
docker run --rm --ipc=host -v "$PWD:/work" -w /work tapcheck
```

The image holds Node.js, Chromium, git, Python 3 and tapcheck: not your app's runtime. Three setups:

- **The app runs on the same machine, Linux:** add `--network host` and keep `baseUrl: http://127.0.0.1:<port>`.
- **The app runs on the same machine, macOS or Windows:** `--network host` doesn't reach the host there. Use
  `baseUrl: http://host.docker.internal:<port>` and no `--network` flag.
- **The app starts inside the container:** only when `app.start` needs nothing but Node.js or Python 3 (a static
  site, as in `examples/static-site`).

In the first two, leave `app.start` out (or start the app before the container: tapcheck skips `app.start` when the
app already answers). A `stub:` listens inside the container, so an app on the host reaches it only with
`--network host`. Options go in with `-e`: `docker run --rm -e ONLY=a11y -e TYPESAFE_API_KEY …`.

### 4. As a GitHub Action

```yaml
jobs:
  tapcheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # …install what app.start needs (your language, dependencies, a test database)…
      - uses: ashishjain15491/tapcheck@v0.1.0
        with:
          skip: flow            # optional; also: config, only, changed, jev-budget, working-directory, node-version
        env:
          TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}   # optional; without it the Jev suites are skipped
```

The action installs tapcheck and Chromium, runs it, adds `REPORT.md` to the job summary, uploads the run folder as
the artifact `tapcheck-report`, and fails the step when a check fails. It doesn't comment on the pull request: that
needs write permissions, and the summary and artifact need none. `changed: true` needs `.tapcheck/state.json` from
an earlier run (restore it with `actions/cache`) and a checkout with history. Inputs are described in
[action.yml](action.yml).

## A minimal tapcheck.yml

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/ashishjain15491/tapcheck/main/schema/tapcheck.schema.json
baseUrl: http://127.0.0.1:8000
app:
  start: npm start                  # skipped when the app already answers; stopped after the run
audience: a shop owner who is not technical
screens:
  - { name: Home, path: /, purpose: see what the shop sells }
tasks:
  - name: Find the opening hours
    from: /
    goal: Find when the shop is open on Saturday.
    done: A page showing the opening hours is open.
    notDone: It shows the home page, another page, or an error.
    optimal: 1
```

Only `baseUrl` is required. The first line gives editors with the YAML language server completion and checking from
[the JSON Schema](schema/tapcheck.schema.json) (installed from npm, it is also at
`./node_modules/tapcheck/schema/tapcheck.schema.json`). The CLI ignores a key it doesn't know; the schema is where a
misspelt one shows up.

- Every key: [CONFIG.md](skills/tapcheck-setup/references/CONFIG.md).
- Recipes per stack (start command, sign-in, route lister, gates):
  [Laravel](skills/tapcheck-setup/references/stacks/LARAVEL.md),
  [Django](skills/tapcheck-setup/references/stacks/DJANGO.md),
  [Rails](skills/tapcheck-setup/references/stacks/RAILS.md),
  [Express and Next.js](skills/tapcheck-setup/references/stacks/EXPRESS-NEXT.md),
  [Go](skills/tapcheck-setup/references/stacks/GO.md),
  [static sites](skills/tapcheck-setup/references/stacks/STATIC.md).
- A working example with gates, routes, a stub and a flow: [examples/static-site](examples/static-site).

Secrets never go in the file: write `$NAME` and export the variable; a missing one stops the load.

## Output

Each run writes `<out>/run-<time>/` (`out` is `.tapcheck` by default; git-ignore it): `report.html` to open,
`REPORT.md` to paste into a pull request, `findings.json` for tools and agents, and the evidence (screenshots,
`crawl.json`, `network.json`, `axe.json`, `clickstream.json`, `payloads.json`). Exit code 0: no failing check; 1: at
least one; 2: the run couldn't start (a config mistake, the app not answering, Chromium missing).

## Beyond the built-in suites

```yaml
# Gates: commands from your own toolchain. Exit 0 passes; the last lines of output are the evidence.
gates:
  - { name: lint, run: ruff check . }
  - { name: dependency advisories, run: npm audit --audit-level=high, warn: true, timeout: 120 }

# Routes: any command printing JSON [{method, path, auth?}]. Parameters in any common style:
# {id} {id?} <int:pk> <pk> :id (.:format) *splat
routes: ./bin/routes-json

# Stub: a stand-in for the outside services the app calls. First matching rule answers; anything else gets 200 {}.
stub:
  port: 8310
  rules:
    - { host: api.example.com, method: POST, path: /v1/charges, status: 201, json: { id: ch_1, paid: true } }

# Flows: your own journeys, one part each.
flows: tests/tapcheck/*.ts
mail: { mailpit: http://127.0.0.1:8025 }   # for t.mail in flows
```

- **Gates** run as the part `code`, which has no side: `ONLY=code tapcheck` starts neither the app nor a browser.
- **Routes** feed the crawl (parameterless GET routes are visited; "route coverage" says how many were reached) and
  let `code` list writing routes with `auth: false` as a warning.
- **Stub**: tapcheck starts it before `app.start` and sets `TAPCHECK_STUB_URL`. Point each provider's base URL at
  `${TAPCHECK_STUB_URL}/<its host>`, for example
  `app.start: PAYMENTS_BASE_URL=${TAPCHECK_STUB_URL}/api.example.com npm start`, and the app never reaches the real
  service. Flows read what the stub saw and switch failures on through `t.stub`.
- **Flows** are files with `export default { name, side?, run: async (t) => {…} }`; `import type { Flow } from
  'tapcheck'` types them. Each `t.step(name, fn)` is a finding; a failed step keeps a screenshot and the flow carries
  on. The helpers (`t.goto`, `t.page`, `t.expect`, `t.stub`, `t.routeOutside`, `t.mail`) are described in
  [src/flow.ts](src/flow.ts).

## Jev: the key, the budget, and what is sent

`ux` and `usability` ask Jev, a paid model from TypeSafe. Put `TYPESAFE_API_KEY` in the environment, or in a `.env`
file next to `tapcheck.yml` (git-ignored). `JEV=off`, or no key, skips both suites.

- **Budget:** a run stops asking once it has spent `jev.budget` US dollars (default 1); `JEV_BUDGET=0.25` sets it
  for one run. The parts left over are marked skipped, and the spend is printed at the end.
- **What goes to TypeSafe:** screenshots of the screens and task steps you configured, and with them the text of the
  questions: the screen's name and `purpose`, your `audience`, each task's `goal`, `done` and `notDone`, and the
  labels of the controls visible on the page. Nothing else: no page source, cookies, sessions, request bodies or
  environment variables. `payloads.json` in the run folder holds every request as sent (images as file paths).
- Screenshots show whatever the signed-in test user sees, so run against test data, not real customers' data.

## Safety

- The built-in suites only read: they never submit a form or follow a delete, send or sign-out link. The usability
  suite clicks only what Jev clearly judges changes nothing, and never a submit button.
- **Flows may change data.** They are your code and click what you tell them to: run them against a copy you can
  reset, or leave them out with `SKIP=flow`.
- `RESET=1` runs `app.reset` first, and refuses unless `baseUrl` is `localhost`, `127.0.0.1`, `*.localhost` or
  `*.test` (`app.allowRemoteReset: true` lifts that, for a remote throwaway copy only).
- Signed-in sessions are saved under `out`; keep that folder out of git and out of artifacts you share.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md). MIT licensed.
