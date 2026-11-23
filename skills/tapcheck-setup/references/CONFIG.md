# tapcheck.yml, every key

Only `baseUrl` is required. Paths in `gates`, `routes`, `flows` and `stub` files are relative to the config file's
folder; `app.*`, `login.command` and `i18n.keys` run from the folder tapcheck is started in, so start it where
`tapcheck.yml` is. `$NAME` and `${NAME}` (capitals) in any string are filled in from the environment; a missing one
stops the load. Unknown keys are ignored without a message, so check spelling against this page.

The same keys as JSON Schema are in `schema/tapcheck.schema.json` in the tapcheck folder. Put this as the file's first
line and an editor with the YAML language server completes the keys and marks a misspelt one:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/ashishjain15491/tapcheck/main/schema/tapcheck.schema.json
```

(With tapcheck installed from npm in the project, `$schema=./node_modules/tapcheck/schema/tapcheck.schema.json` works
offline.)

```yaml
baseUrl: http://127.0.0.1:8000      # http(s) URL of the running app

app:
  start: npm run dev                # run through /bin/sh unless the app already answers at `ready`; its whole process group is stopped after the run
  stop: docker compose down         # optional extra command after the run
  ready: /                          # default /. Any answer with a status under 500 counts as up
  timeout: 120                      # seconds to wait for `ready` (default 120)
  reset: ./bin/reset-test-db        # runs first when RESET=1; refused unless baseUrl is localhost, 127.0.0.1, *.localhost or *.test
  resetWhen: ["database/**"]        # optional globs (paths from the git root): `reset` also runs by itself, see below
  allowRemoteReset: false           # true lifts that refusal; only for a remote throwaway copy

audience: a first-time visitor      # default; who the app is for (used in Jev's questions)

sides:                              # default: { public: {} }. Names: lowercase letters, digits, dashes;
  public: {}                        #   not crawl, contract, security, a11y, interact, audit, ux, usability, code, flow, jev, measured
  customer:
    baseUrl: http://app.localhost:8000   # optional, when this side lives at another address
    login: …                        # one of the kinds below; leaving it out means none
    csrf: { method: PATCH, path: /admin/users/0, expect: 419 }   # optional: this side's CSRF probe, in place of security.csrf

screens: […]                        # a list for every side, or { <side>: [...] }
tasks: […]                          # same

loginPaths: "/(login|sign-?in|two-factor|2fa)(/|$)"   # default. Being sent to a matching path means "not signed in"

crawl:
  max: 60                           # most pages per side (default 60)
  skip: "<regex>"                   # links never followed. Setting it REPLACES the default, which is:
  # /(logout|log-out|sign-?out|delete|destroy|remove|export|download|impersonat|unsubscribe)|\.(csv|pdf|zip|png|jpe?g|gif|svg|webp|ico|xlsx?)$

interact:
  max: 40                           # most crawled screens clicked through per side (default 40)
  submit: false                     # true also submits dialog forms with invalid, then valid input: it CHANGES DATA. See below

audit:
  max: 0                            # crawled pages audited on top of the screens (default 0: the screens only)
  skip: "/(editor|canvas)(/|$)"     # paths the audit leaves out (no default)

design:                             # optional design tokens; the audit warns about computed styles outside them. See below
  colors: ["#1f2937", "#ffffff"]
  fonts: [Inter]
  radii: [0, 4, 8]
  spacing: [4, 8, 16, 24]

security:
  csrf: { method: POST, path: /orders, expect: 419 }   # sent without a token on each side that signs in (every side if none does); must be refused with exactly `expect`
  allowedHosts: [fonts.example.com] # third-party hosts the pages may call; any other is a failing finding
  publicWrites: "^/(login|webhooks/)"  # POST/PUT/PATCH/DELETE routes that need no sign-in on purpose (see routes)

viewports:                          # default: these two. a11y and ux run on each; interact and audit use the first that isn't mobile
  - { name: desktop, width: 1440, height: 900 }
  - { name: mobile, width: 390, height: 844, mobile: true }

out: .tapcheck                      # where runs, sessions and state go (default .tapcheck); git-ignore it

jev:
  budget: 1                         # most USD one run may spend on Jev (default 1; checked before each request, so a run
                                    # can go over by one request); JEV_BUDGET overrides it. Reaching it exits 1.
  headers: {}                       # extra headers sent with every Jev request

i18n:
  keys: <command>                   # prints one translation key per line; ux then flags pages showing a raw key. Only dotted keys (orders.title) count

changes: { "*": ["src/**"], contract: ["api/**"] }   # see below
gates: […]                          # see below
routes: <command>                   # see below
stub: { port: 8766, rules: […], dns: {…} }   # see below
coverage: { file: COVERAGE.md, reasons: […] }   # for COVERAGE=1; see below
flows: tests/tapcheck/*.ts          # a glob or a list of globs; see below
mail: { mailpit: http://127.0.0.1:8025 }   # Mailpit's web address, for t.mail in flows
browser: { args: ["--disable-features=LocalNetworkAccessChecks"] }   # extra switches for the run's Chromium; see below
```

## login

```yaml
login: none                         # the default
login: manual                       # a visible browser opens /login; a person signs in once (2FA included). Kept until it expires or LOGIN=1
login: { manual: /admin/sign-in }   # the same, on another page
login:
  form:
    url: /login
    fields: { email: $TAPCHECK_EMAIL, password: $TAPCHECK_PASSWORD }   # key: a CSS selector, else a name attribute, else the label's text
    submit: "button.sign-in"        # optional; default: the first submit button
    totp: { field: code, secret: $TAPCHECK_TOTP_SECRET }   # optional; a base32 secret, used if the app asks for a code
login: { command: ./bin/tapcheck-session admin }   # any program printing a Playwright storageState JSON: {"cookies": [...], "origins": []}
```

`form` and `command` sign in on every run; `manual` can't run unattended (CI). Sign-in counts as done when the
browser leaves every path matching `loginPaths`.

## screens

```yaml
- { name: Orders, path: /orders, purpose: see past orders and where each one is }
- { name: Order, from: /orders, link: "^/orders/\\d+$", suffix: /edit, purpose: change one order }
```

`path`, or `from` + `link`: the first link on the `from` page whose path matches the regular expression `link`, with
`suffix` added. Use the second form for pages whose address holds an id. a11y, audit and ux check exactly these
screens; the crawl starts from them. With no screens, all four use `/`. `purpose` is optional but the five-second test needs it.

## tasks

```yaml
- name: Find an order's delivery date
  from: /orders                     # where the person starts
  goal: Find when the most recent order will be delivered.
  done: One order's page is open and shows a delivery date.
  notDone: It shows the list of orders, another page, or an error.
  optimal: 1                        # fewest clicks that get there (a whole number, 1 or more)
  text: fern                        # optional: what the person would type into a search field on the way
```

All but `text` are required. See QUESTIONS.md for the wording.

## interact, audit and design

```yaml
interact: { max: 40, submit: false }
audit: { max: 20, skip: "/(editor|canvas)(/|$)" }
design:
  colors: ["#1f2937", "#2563eb", "#ffffff"]   # hex, in quotes (an unquoted # starts a YAML comment)
  fonts: [Inter, system-ui]
  radii: [0, 4, 8, 9999]            # px
  spacing: [4, 8, 12, 16, 24, 32]   # px
```

`interact` clicks every safe control on the screens its side's crawl reached (`max` of them) and tries each dialog
and table it finds. It never clicks a control whose label is a destructive or outbound word (delete, remove, send,
publish, pay, cancel, sign out…), a link matching `crawl.skip` or leaving the app's host, a control with no label, or
the submit button of a form that POSTs. A dialog's form is given invalid input and submitted only when that can't
save anything: the browser's own validation refuses it, or the form doesn't POST. `submit: true` lifts that last
limit and then also submits valid input (`tapcheck 0`, `tapcheck-0@example.com`), so it **changes data**: set it only
for a throwaway database you reset with `app.reset`. Like `RESET=1`, it is ignored unless the app is local or
`app.allowRemoteReset` is true. A button that saves through script alone can't be told apart and is clicked either
way, so point `interact` at test data.

`audit` checks the configured screens on a desktop (light, then `prefers-color-scheme: dark`), a 768 px tablet and a
375 px phone. `max` adds that many pages from the crawl (the crawl has to be in the same run: `ONLY=crawl,audit`);
`skip` is a regular expression of paths to leave out, for pages that are a canvas or an editor. It opens only the
menus and dialogs the markup announces (`aria-haspopup`, `aria-expanded="false"`, `popovertarget`).

`design` lists the design tokens. Each list is optional and only the lists given are checked: text, background and
border colours against `colors` (hex only), the first font family of each text against `fonts`, corner radii against
`radii` and paddings, vertical margins and gaps against `spacing`. A value outside its list is a warning in `audit`
that names the most used offenders; all of them are in `audit.json`.

## gates and routes (the `code` part)

```yaml
gates:
  - { name: lint, run: ruff check . }
  - { name: dependency advisories, run: npm audit --audit-level=high, warn: true, timeout: 120 }
routes: ./bin/routes-json
```

A gate passes on exit 0; `warn: true` turns a failure into a warning; `timeout` is in seconds (default 600).
`routes` is any command printing JSON `[{"method": "GET", "path": "/orders/{id}", "auth": true}]`. `method` may be
`"GET|HEAD"` or a list; `auth` is optional. Path parameters in any of these styles: `{id}` `{id?}` `<int:pk>` `<pk>`
`:id` `(.:format)` `*splat`. Routes written as regular expressions aren't understood: leave them out. With routes, the
crawl also visits the GET routes without parameters (after the links it found, up to `crawl.max`) and reports route coverage, and `code` lists writing routes
with `auth: false` that don't match `security.publicWrites` as a warning.

## changes (for CHANGED=1)

Maps a suite name (`crawl`, `contract`, `security`, `a11y`, `interact`, `audit`, `ux`, `usability`, `code`, `flow`) or `"*"` (added to
every suite) to globs on paths from the git root. A part reruns when a matching file changed since it last passed; a
suite with no globs reruns on any change; a change to `tapcheck.yml` reruns everything. `*` and `**` don't match
names starting with a dot.

## stub

```yaml
stub:
  port: 8766                        # default 8766
  rules:                            # first match answers; anything unmatched gets 200 {}
    - { host: api.example.com, method: POST, path: /v1/charges, status: 201, json: { id: ch_1, paid: true } }
    - { host: example.com, path: "^/v1/users/\\d+$", file: tests/fixtures/user.json, delayMs: 200 }
```

A rule: `host?` (also matches subdomains), `method?`, `path?` (a glob, or a regular expression when it starts with
`^`), `status` (default 200), one of `json`, `body` or `file`, `headers?`, `delayMs?`. tapcheck starts the stub before
the app and sets `TAPCHECK_STUB_URL` (`http://127.0.0.1:<port>`), which `app.start` and the gates inherit and
`tapcheck.yml` itself may use. Point each provider's base URL at `$TAPCHECK_STUB_URL/<its host>`:

```yaml
app:
  start: PAYMENTS_BASE_URL=$TAPCHECK_STUB_URL/api.example.com npm start
```

Only add a stub when the app reads those base URLs from the environment or its config. If a base URL is hard-coded,
say so to the user instead of changing the app during setup.

### stub.dns

For an app that looks up DNS itself (it verifies a customer's domain, checks MX or TXT records), the stub can answer
DNS over UDP too:

```yaml
stub:
  dns:
    port: 8767                      # default 8767
    defaultA: 203.0.113.7           # optional: the answer to an A question no record covers
    records:
      - { name: shop.example.com, type: A, values: [192.0.2.10] }
      - { name: shop.example.com, type: MX, values: ["10 mx.example.com"] }   # "<priority> <host>", or the host alone (priority 10)
      - { name: shop.example.com, type: TXT, values: ["v=spf1 include:mail.example.com -all"] }
```

`type` is one of `A`, `AAAA`, `MX`, `TXT`, `CNAME`, `NS`. tapcheck sets `TAPCHECK_DNS` (`127.0.0.1:<port>`) the way
it sets `TAPCHECK_STUB_URL`; the app has to be able to take its resolver's address from the environment or its
config. A name containing `tapcheck-fail` doesn't exist (NXDOMAIN), so plain test data can trigger a failed lookup. A
flow changes an answer mid-run with `t.stub.dns(name, type, values)` (`null` puts the configured answer back), or
`POST /_tapcheck/dns {name, type, values}` on the stub. Every question is in the stub's request log with method `DNS`.

## app.resetWhen (reset by itself)

```yaml
app:
  reset: ./bin/reset-test-db
  resetWhen: ["database/**", "db/seeds/**"]
```

With `resetWhen`, tapcheck runs `app.reset` before a run when a file matching one of the globs changed since the last
reset (committed or not, compared through git like `CHANGED=1`), and on the first run. Name the files that decide the
test data: migrations, seeders, fixtures. The same refusal as `RESET=1` applies when the app isn't local. Outside a git
repository `resetWhen` is ignored, with one line saying so. `RESET=1` still forces a reset.

## coverage (for COVERAGE=1)

Every run writes `hits.json` per side: each request the app answered, the dialogs and table controls `interact`
exercised, and for a flow the step that did it. `COVERAGE=1 tapcheck` runs nothing; it merges the `hits.json` of
every run folder under `out` into one Markdown file, so parts run one at a time add up. With a `routes` command, each
route is listed with the parts that reached it, or **GAP**; without one, the file lists what was reached.

```yaml
coverage:
  file: COVERAGE.md                 # default; from the config file's folder. Keep the name in capitals
  reasons:                          # gaps that are there on purpose: listed with the reason, not as GAP
    - { match: "^GET /admin/export", why: downloads are not followed }
    - { match: "^(POST|DELETE) /billing/", why: needs the payment provider's sandbox }
```

`match` is a regular expression (case-insensitive) on the route as `METHOD /path`. A route counts as reached when the
app answered a request for it with anything but 401, 403, 404 or 405.

## flows

Journeys only this app has, written as TypeScript or JavaScript files (ES modules: in a project whose `package.json`
says `"type": "commonjs"`, name them `.mts` or `.mjs`); each is its own part, `flow-<name>`. Unlike the
suites, a flow may submit forms and change data, so it belongs with `app.reset` and `RESET=1`. A flow that takes longer
than its `timeout` (seconds in the flow's export, default 3600) fails and the run goes on. The file format and
the `t` helpers (`t.goto`, `t.page`, `t.step`, `t.expect`, `t.note`, `t.jev`, `t.stub`, `t.routeOutside`, `t.mail`) are described at the
top of `src/flow.ts` in the tapcheck folder (`<skill base directory>/../../src/flow.ts`), with a working example in
`examples/static-site/tests/tapcheck/` there. `await t.jev('cart with two items')` has Jev look at the current page
(the visual questions, or your own), and `await t.mail.judge(mail)` at an email from `t.mail.waitFor`: each answer is
a finding of the flow, and with `JEV=off` or no key both record that they were skipped and return `null`. A step
that returns `{ warn: '…' }` is a warning rather than a pass; `t.mail.count()` and `t.mail.all()` take the same
`{ to, subject }` filter as `waitFor`, and every message carries its `headers`. `t.page()` is the flow's page at the
first viewport; `t.page({ viewport: 'mobile' })` is one at the viewport of that name, and the page handed out last is
the one `t.goto()` and `t.jev()` act on.

## browser.args

Extra command-line switches for the run's Chromium. The usual reason: the app runs on localhost and shows its own
files inside a sandboxed frame (an email or page preview). Such a frame has no origin, so Chrome's local network
access check refuses its requests to localhost ("Permission was denied for this request to access the `loopback`
address space"), which never happens on a public host. `--disable-features=LocalNetworkAccessChecks` turns that
check off for the run. The sign-in browser of a `form` login doesn't get these switches.

## Environment variables for a run

| Variable | Effect |
|---|---|
| `ONLY=crawl,a11y` | only these parts: part names or tags, comma-separated; `flow-*` style prefixes work |
| `SKIP=jev` | take parts out again (contract, security and interact still bring their side's crawl) |
| `LIST=1` | print the parts and their tags, mark what would run, and exit |
| `CHANGED=1` | of the chosen parts, only those whose files changed since each last passed (needs git) |
| `JEV=off` | skip `ux`, `usability` and `audit`'s Jev looks; they are also skipped when there is no `TYPESAFE_API_KEY` |
| `JEV_BUDGET=0.5` | most USD to spend on Jev this run (overrides `jev.budget`) |
| `RESET=1` | run `app.reset` first |
| `HEADED=1` | a visible browser instead of a headless one |
| `SLOWMO=150` | wait that many milliseconds between browser actions |
| `START_DELAY=10` | count down that many seconds before the first action (time to start a screen recording) |
| `RECORD=1` | a video and a Playwright trace of every browser context, under `<side>/videos/` and `<side>/traces/`, linked from the report |
| `COVERAGE=1` | no run: merge every run's `hits.json` into `COVERAGE.md` (see coverage) |
| `LOGIN=1` | sign in again by hand on `manual` sides |
| `CONTRACT_UPDATE=1` | accept the current JSON response shapes as the contract baseline |
| `TAPCHECK_CONFIG=path` | another config file instead of `./tapcheck.yml` |

Tags: each suite's name, each side's name, `jev` (ux, usability), `measured` (everything else), `code`, `flow`.
