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
`bin/tapcheck` (the skill was copied on its own) use the npm package instead:
`npx @ashishjain15491/tapcheck@<version>`, with the `version` in the plugin's `.claude-plugin/plugin.json`, after
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
- tapcheck's own suites don't submit forms, but `interact` clicks buttons, and one that saves by script alone does
  save: run only against a throwaway database. Don't add `flows:` or `interact.submit: true` during setup unless the
  user asks: both change data.
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
  needs no `sides` at all: it gets one side called `public`. A side can live on its own host (an admin host, a host
  for pages the app serves to its customers' visitors): look for host settings and host-bound route groups, give each
  a `*.localhost` name in the test settings, and its side its own `baseUrl`.
- **Sign-in** per side, the first that works: `form` with a seeded test user; else `command` (a script in the
  project's own language that prints a Playwright storageState JSON, `{"cookies": [...], "origins": []}`); else
  `manual` (a browser window opens and the user signs in once; the session is kept in `.tapcheck/`). Don't switch a
  security setting off (forced two-step, captcha) to make `form` work: add `totp`, or use `command`.
  If the app shows its sign-in form at the same address when the session ends (a single-page app, hash routes) rather
  than redirecting, give the side a `signedIn` selector that every signed-in screen has and the sign-in form doesn't
  (the account menu, the main navigation); check it on each screen at each viewport. If the app takes its theme from an
  account setting rather than the browser, `audit` sees only the account's theme: say so, and suggest a second test
  user set to dark if dark mode matters.
- **Screens**: the 3 to 8 pages that matter most on each side, each with a `purpose` that says what that page shows
  (open it and check: a wrong purpose makes Jev fail a page that is fine). Two names for one page are one screen.
- **Tasks**: 1 to 3 things a first-time user comes to do, reachable by clicking alone.
- **Audience**: who the app is for, in a few words.
- **Context**, for a specialist product (a trading terminal, a clinical system, a developer console): what kind of
  product it is and what its users expect, so Jev doesn't judge it as a consumer app. Leave it out for a general app.
  Add `expect` rules only after a first run, for findings the user agrees are right for the product, each narrow and
  with its reason; never for accessibility, security or a broken page (CONFIG.md, "context and expect").

`references/QUESTIONS.md` says how to word purposes, tasks and the audience; read it before writing them. Ask the
user only what the code can't tell you (who the audience is, which test user to use).

### 3. Find what the app needs around it

The recipe starts a bare app. A real one also talks to outside services, runs background work and needs files at
boot; without them its pages and flows fail, and the report blames the app. Work through this before writing the
file:

1. **An existing test setup.** Look for one the project already uses to start a throwaway copy: a `tests/e2e/` or
   `e2e/` folder, `scripts/*e2e*` or `*test*` scripts, a test service in `docker-compose*.yml`, the end-to-end job in
   the CI workflow, a Playwright or Cypress `webServer` setting, a `Makefile` target. Use it for `app.start` and
   `app.reset` instead of the recipe, once you have read it and checked it never touches the developer's own
   database. Note its leftovers too (generated route lists, fixture files): tapcheck doesn't need them.
2. **Every setting the app reads.** Read `.env.example` (never `.env`) and the code that reads settings:

   | Stack | Where settings are read |
   |---|---|
   | Laravel | `env('…')` calls in `config/*.php`, and `environment(` checks in seeders and providers |
   | Django | `os.environ` and `env(…)` in the settings module |
   | Rails | `ENV[…]` and `ENV.fetch` in `config/`, and `config/credentials` |
   | Node | `process.env.…` in the server code and `next.config.*` |
   | Go | `os.Getenv` and `flag.` definitions |

   On Laravel, `grep -rhoE "env\(\s*['\"][A-Za-z0-9_]+" config | sort -u` lists them.

   Put each one that matters into one of these, and write down what you chose:

   | The setting is | In the test copy |
   |---|---|
   | an on/off switch or a driver choice (payments, captcha, social sign-in, `log`/`null`/`fake` drivers) | off, or the fake driver; on with a dummy key and stub rules when a screen you audit shows it in production and the app can be pointed at the stub |
   | a developer or first-run feature a non-production environment turns on (component gallery, debug bar, API explorer, product tour) | off |
   | the base URL of an outside API | the stub: `$TAPCHECK_STUB_URL/<its host>` in `app.start`, or the literal `http://127.0.0.1:<stub.port>/<its host>` in a settings file; a `stub.rules` entry for each call whose answer the app reads (anything else gets 200 `{}`) |
   | a DNS resolver or nameserver | `stub.dns` and `$TAPCHECK_DNS`, with a `records` entry for each name the seed expects to verify |
   | a destination stored in the database (SMTP or IMAP servers, webhook URLs) | check the seed uses `.test` hosts; to test sending, point those rows at Mailpit or the stub at the end of `app.reset` |
   | mail transport | Mailpit, plus `mail.mailpit` when flows read mail; else the log driver |
   | a key with no switch and no base URL | a dummy value, and tell the user the feature can't be tested |
   | a path to a key file the app loads at boot | a throwaway file the start command generates (`openssl genrsa …`), never a real one |

   Write these into the stack's test settings (`.env.testing`, a test settings module, `config/environments/test.rb`)
   or into one script the project keeps that `app.start` runs; not into `tapcheck.yml`. A real paid or sending service
   must never be reachable from the test copy, and no real key goes into it.
3. **Background work.** Queued jobs, a scheduler, websockets. Run them inline when the framework can
   (`QUEUE_CONNECTION=sync`), unless the screens or flows depend on work happening later (sending, imports, retries)
   or a screen you list shows the queue or the workers: then start the worker in `app.start` next to the server.
   `app.start` is skipped when the app already answers, so use a port nothing else uses. Everything it starts, in the
   background too, is stopped after the run; group the build so the server waits for it:
   `build && { worker & scheduler & server; }`. A service in Docker (Mailpit, a database, Redis) is not stopped with
   it: give it a name and port only tapcheck uses, start it in `app.start`
   (`docker start name 2>/dev/null || docker run -d --name name …`), and in `app.stop`, which runs after a run that
   started the app, `docker stop` one that holds data and `docker rm -f` the rest.
4. **Build steps and seed data.** Frontend assets, a one-off setup script, the seed the screens and tasks need.
   Build in `app.start`, and rebuild when a source file is newer than the last build (`tapcheck-fix` edits CSS and
   JS between runs); a build counts against `app.timeout`, so raise it. Seed in `app.reset`. It runs only with
   `RESET=1` or `app.resetWhen`, and after `app.start` has answered, so `ready` must answer on an empty database.
   Guard it on the database the app itself would use, not on a settings file, since a variable exported in the shell
   wins. A YAML value can't start with `[`, so write it as a block:

   ```yaml
   reset: |
     db_name=$(<a command that prints the database the app connects to>)
     test "$db_name" = myapp_test || { echo "not the test database: $db_name"; exit 1; }
     <migrate and seed>
   ```
5. **What can't be faked.** A base URL in the code rather than the settings, or a provider the app calls through a
   library that ignores base URLs. Don't change the app; tell the user, and add the affected routes to
   `coverage.reasons` so the `COVERAGE=1` map shows them as left out on purpose.

### 4. Write `tapcheck.yml`

Start from this and delete what doesn't apply. Only `baseUrl` is required. The first line lets the user's editor
check the file against tapcheck's JSON Schema; keep it.

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/ashishjain15491/tapcheck/main/schema/tapcheck.schema.json
baseUrl: http://127.0.0.1:8000
app:
  start: <from the recipe>          # skipped when the app already answers; stopped after the run
  ready: /                          # a path that answers once the app is up (any status under 500)
  reset: <from the recipe>          # optional; runs with RESET=1 (or by itself with app.resetWhen), and only against a local address
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
changes:                            # for CHANGED: which files each suite, or one part (flow-<name>), depends on (globs from the git root)
  "*": ["src/**", "templates/**"]
security:
  csrf: { method: POST, path: /orders, expect: 403 }   # from the recipe, if the framework has CSRF protection
```

Every other key (`app.stop`, `app.timeout`, `app.resetWhen`, `login` kinds in full, `screens` by link, `stub`,
`flows`, `mail`, `i18n`, `crawl`, `security`, `coverage`, `viewports`, `jev`, `loginPaths`, `out`) is in
`references/CONFIG.md`. Open it when you need one of them.

- **Gates**: take them from what the project already runs (CI workflow, `package.json` scripts, `Makefile`,
  `composer.json` scripts). Don't add tools the project doesn't use. Slow or noisy ones get `warn: true`.
- **Routes**: run the recipe's command by hand first and check that it prints a JSON list; then put it in the file.
  A multi-line command goes in a YAML block (`routes: |`).
- **Changes**: only when the project is a git repository; `CHANGED=1` needs one. Otherwise leave `changes` out.
  With flows, give each flow the folders of the feature it tests (`flow-checkout: ["app/Cart/**"]`), so a pull
  request reruns only its own flows with `CHANGED=origin/main`; `flow` covers the flows without globs of their own.
- **Stub, mail, start and reset**: from step 3. `stub`, `stub.dns` and `mail` are in CONFIG.md.

### 5. Run it

```bash
LIST=1 TAPCHECK        # loads the config and prints the parts; a config mistake stops here with the field's name
RESET=1 JEV=off TAPCHECK   # everything code can measure; no key needed, costs nothing. RESET=1 seeds the first time
```

On a large app check the config on a small pass first (`ONLY=code,crawl JEV=off TAPCHECK`): a full run can take an
hour, mostly `interact`, so run it in the background if your commands have a time limit.

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
- "… has no <selector> on it: the session has expired": on a `manual` side run again with `LOGIN=1`; if the session
  is good, that screen lacks the `signedIn` selector, so pick one every signed-in screen has.
- A run that ends with a `Report: …/report.html` line completed, whatever its exit code (1 means it has failing
  findings). That is success for setup. Read `findings.json` in that folder for the summary; each entry has
  `suite`, `side`, `where`, `check`, `status` (`fail`, `warn`, `info`, `pass`), `detail` and `evidence` paths.

Once the measured run goes through, and only if the user has a key in place, run the Jev suites once:
`ONLY=jev JEV_BUDGET=0.5 TAPCHECK`.

### 6. Hand over

Tell the user, briefly:

- what you wrote (sides, screens, tasks, gates) and anything you guessed that they should correct;
- which environment variables to export, and where `TYPESAFE_API_KEY` goes;
- each outside service and what the test copy does with it (switched off, stubbed, a dummy key), and what couldn't
  be faked;
- the count of failing and warning findings per suite, the three or four that matter most, and the path of
  `report.html` (printed on the run's last line); after a partial rerun (`ONLY=…`), which run each count is from;
- that `tapcheck-run` runs it again and `tapcheck-fix` works through the failures.

Don't change the app's code in this skill, and don't loosen the config to make findings go away.
