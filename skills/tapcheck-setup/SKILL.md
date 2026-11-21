---
name: tapcheck-setup
description: >
  Set tapcheck up for a web project in any language: detect the stack, write tapcheck.yml (how to start the app, who
  signs in, which screens and tasks matter, the project's own linters as gates), and get a first run through. Use when
  the user says "set up tapcheck", "add tapcheck", "e2e test this app", "audit the UI", "add end-to-end tests", "check
  this site for accessibility and broken pages", or when a tapcheck run fails with "No tapcheck.yml here".
---

# Set tapcheck up for this project

tapcheck drives the running app in a real browser and writes one report. Everything it needs to know about the
project is in one file, `tapcheck.yml`, at the project root. Your job: write that file, run it, and fix the file
until the run goes through. Findings about the app are the result, not something to fix here (that is the
`tapcheck-fix` skill).

## The CLI

`TAPCHECK` below stands for `<this skill's base directory>/../../bin/tapcheck` (an absolute path; the first run
installs its dependencies and a browser, which takes a minute). It needs Node.js 23.6 or newer. Options are
environment variables in front of it: `LIST=1 TAPCHECK`.

Prefer that launcher: it is the version these instructions were written for. Only when the plugin folder has no
`bin/tapcheck` (the skill was copied on its own) use the npm package instead, once it is published:
`npx tapcheck@<version>`, with the `version` in the plugin's `.claude-plugin/plugin.json`, after
`npx playwright install chromium` (Node.js 22.18 or newer).

Always run it from the folder that holds `tapcheck.yml`: output (`.tapcheck/`), `.env` and `app.start` all resolve
from the current folder.

## Rules

- Never write a password, token or key into `tapcheck.yml`. Write `$NAME` (or `${NAME}`) and tell the user which
  variables to export in their shell; tapcheck fills them in from the environment and stops if one is missing.
  It does not read them from `.env`.
- Never ask for `TYPESAFE_API_KEY` in chat, and never read `.env`. Tell the user to put `TYPESAFE_API_KEY=…` in
  `.env` next to `tapcheck.yml`, or export it. Without it the two Jev suites (`ux`, `usability`) are skipped and
  everything else still runs.
- Add `.tapcheck/` to the project's `.gitignore` (it holds screenshots and signed-in sessions), and make sure `.env`
  is ignored too. No `.gitignore` yet: create one with those two lines.
- `app.reset` only for a local, throwaway database. Never point it at shared, staging or production data.
- tapcheck's own suites only read. Don't add `flows:` during setup unless the user asks: flows may change data.
- `$WORD` in capitals anywhere in the file is replaced from the environment when the file loads. In shell commands
  you write there, use lowercase shell variables, or the load fails with "environment variable … is not set".
- A key tapcheck doesn't know is ignored without a message. Use only the keys in this skill and its references.

## Steps

### 1. Detect the stack and open its recipe

| Files at the project root | Recipe |
|---|---|
| `composer.json` and `artisan` | `references/stacks/LARAVEL.md` |
| `manage.py` | `references/stacks/DJANGO.md` |
| `Gemfile` and `config/routes.rb` | `references/stacks/RAILS.md` |
| `package.json` with `next` or `express` in its dependencies | `references/stacks/EXPRESS-NEXT.md` |
| `go.mod` | `references/stacks/GO.md` |
| only HTML files, or a static site generator's output folder | `references/stacks/STATIC.md` |

Something else: use the nearest recipe as a pattern. tapcheck needs only a start command, a URL, and optionally a
command that prints the routes. Two stacks (an API plus a separate frontend): start both in `app.start`
(`cmd1 & cmd2`), and give the frontend's address as `baseUrl`.

### 2. Learn the app

Read the routes file, the navigation template and the seed data. You need:

- **Sides**: each kind of person who sees a different app (`public`, `customer`, `admin`). A site with no sign-in
  needs no `sides` at all: it gets one side called `public`.
- **Sign-in** per side, the first that works: `form` with a seeded test user; else `command` (a script in the
  project's own language that prints a Playwright storageState JSON, `{"cookies": [...], "origins": []}`); else
  `manual` (a browser window opens and the user signs in once; the session is kept in `.tapcheck/`).
- **Screens**: the 3 to 8 pages that matter most on each side, each with a `purpose`.
- **Tasks**: 1 to 3 things a first-time user comes to do, reachable by clicking alone.
- **Audience**: who the app is for, in a few words.

`references/QUESTIONS.md` says how to word purposes, tasks and the audience; read it before writing them. Ask the
user only what the code can't tell you (who the audience is, which test user to use).

### 3. Write `tapcheck.yml`

Start from this and delete what doesn't apply. Only `baseUrl` is required. The first line lets the user's editor
check the file against tapcheck's JSON Schema; keep it.

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/ashishjain15491/tapcheck/main/schema/tapcheck.schema.json
baseUrl: http://127.0.0.1:8000
app:
  start: <from the recipe>          # skipped when the app already answers; stopped after the run
  ready: /                          # a path that answers once the app is up (any status under 500)
  reset: <from the recipe>          # optional; only runs with RESET=1, and only against a local address
audience: a shop owner who is not technical
sides:
  public: {}                        # no sign-in
  customer:
    login:
      form:
        url: /login
        fields: { email: $TAPCHECK_CUSTOMER_EMAIL, password: $TAPCHECK_CUSTOMER_PASSWORD }
screens:                            # a list (every side), or a map of side → list as here
  public:
    - { name: Home, path: /, purpose: see what the shop sells }
  customer:
    - { name: Orders, path: /orders, purpose: see past orders and where each one is }
    - { name: Order, from: /orders, link: "^/orders/\\d+$", purpose: check one order's items and delivery }
tasks:
  customer:
    - name: Find an order's delivery date
      from: /orders
      goal: Find when the most recent order will be delivered.
      done: One order's page is open and shows a delivery date.
      notDone: It shows the list of orders, another page, or an error.
      optimal: 1
routes: <from the recipe>           # a command printing JSON [{method, path, auth?}]
gates:                              # the project's existing linters and audits; exit 0 passes
  - { name: lint, run: <the project's lint command> }
  - { name: dependency advisories, run: <audit command>, warn: true }
changes:                            # for CHANGED=1: which files each suite depends on (globs from the git root)
  "*": ["src/**", "templates/**"]
security:
  csrf: { method: POST, path: /orders, expect: 403 }   # from the recipe, if the framework has CSRF protection
```

Every other key (`login` kinds in full, `screens` by link, `stub`, `flows`, `mail`, `i18n`, `crawl`, `security`,
`viewports`, `jev`, `loginPaths`, `out`) is in `references/CONFIG.md`. Open it when you need one of them.

- **Gates**: take them from what the project already runs (CI workflow, `package.json` scripts, `Makefile`,
  `composer.json` scripts). Don't add tools the project doesn't use. Slow or noisy ones get `warn: true`.
- **Routes**: run the recipe's command by hand first and check that it prints a JSON list; then put it in the file.
  A multi-line command goes in a YAML block (`routes: |`).
- **Changes**: only when the project is a git repository; `CHANGED=1` needs one. Otherwise leave `changes` out.
- **Stub**: only when the app calls outside services (payments, mail, AI) *and* each one's base URL can be set from
  the environment. Then tapcheck serves canned answers and the app never reaches the real service. See CONFIG.md.

### 4. Run it

```bash
LIST=1 TAPCHECK        # loads the config and prints the parts; a config mistake stops here with the field's name
JEV=off TAPCHECK       # everything code can measure; no key needed, costs nothing
```

A part is one suite on one side, named `<suite>-<side>` (`crawl-public`); `code` is the gates and the routes check,
and is there only when the file has `gates` or `routes`. The app's own log lines appear in between tapcheck's.

- An error starting with `tapcheck.yml:` names the field and what it should be. Fix the file and rerun.
- "The app isn't answering" or "didn't answer … within 120 s": run `app.start` by hand to see why; raise
  `app.timeout` (seconds) only if the app is truly slow to start.
- A failing `signed in` finding: open the screenshot it names (`.tapcheck/login-<side>-failed.png`), then fix the
  form's `url`, `fields` or `submit`. A field key is a CSS selector, a `name` attribute, or the label's text.
- A `screen reachable` warning, "no link to it found": the screen's `link` pattern matched no link on its `from`
  page. Fix the pattern (it is tested against each link's path), or seed data so the list isn't empty.
- "Sent to sign in at …: the session has expired": on a `manual` side run again with `LOGIN=1`; otherwise the page
  redirects to sign-in for this user, so take it out of that side's screens.
- A run that ends with a `Report: …/report.html` line completed, whatever its exit code (1 means it has failing
  findings). That is success for setup. Read `findings.json` in that folder for the summary; each entry has
  `suite`, `side`, `where`, `check`, `status` (`fail`, `warn`, `info`, `pass`), `detail` and `evidence` paths.

Once the measured run goes through, and only if the user has a key in place, run the Jev suites once:
`ONLY=jev JEV_BUDGET=0.5 TAPCHECK`.

### 5. Hand over

Tell the user, briefly:

- what you wrote (sides, screens, tasks, gates) and anything you guessed that they should correct;
- which environment variables to export, and where `TYPESAFE_API_KEY` goes;
- the count of failing and warning findings per suite, the three or four that matter most, and the path of
  `report.html` (printed on the run's last line);
- that `tapcheck-run` runs it again and `tapcheck-fix` works through the failures.

Don't change the app's code in this skill, and don't loosen the config to make findings go away.
