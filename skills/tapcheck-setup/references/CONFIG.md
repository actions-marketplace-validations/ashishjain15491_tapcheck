# tapcheck.yml, every key

Only `baseUrl` is required. Paths in `gates`, `routes`, `flows` and `stub` files are relative to the config file's
folder; `app.*`, `login.command` and `i18n.keys` run from the folder tapcheck is started in, so start it where
`tapcheck.yml` is. `$NAME` and `${NAME}` (capitals) in any string are filled in from the environment; a missing one
stops the load. Unknown keys are ignored without a message, so check spelling against this page.

```yaml
baseUrl: http://127.0.0.1:8000      # http(s) URL of the running app

app:
  start: npm run dev                # run through /bin/sh unless the app already answers at `ready`; its whole process group is stopped after the run
  stop: docker compose down         # optional extra command after the run
  ready: /                          # default /. Any answer with a status under 500 counts as up
  timeout: 120                      # seconds to wait for `ready` (default 120)
  reset: ./bin/reset-test-db        # runs first when RESET=1; refused unless baseUrl is localhost, 127.0.0.1, *.localhost or *.test
  allowRemoteReset: false           # true lifts that refusal; only for a remote throwaway copy

audience: a first-time visitor      # default; who the app is for (used in Jev's questions)

sides:                              # default: { public: {} }. Names: lowercase letters, digits, dashes;
  public: {}                        #   not crawl, contract, security, a11y, ux, usability, code, flow, jev, measured
  customer:
    baseUrl: http://app.localhost:8000   # optional, when this side lives at another address
    login: …                        # one of the kinds below; leaving it out means none

screens: […]                        # a list for every side, or { <side>: [...] }
tasks: […]                          # same

loginPaths: "/(login|sign-?in|two-factor|2fa)(/|$)"   # default. Being sent to a matching path means "not signed in"

crawl:
  max: 60                           # most pages per side (default 60)
  skip: "<regex>"                   # links never followed. Setting it REPLACES the default, which is:
  # /(logout|log-out|sign-?out|delete|destroy|remove|export|download|impersonat|unsubscribe)|\.(csv|pdf|zip|png|jpe?g|gif|svg|webp|ico|xlsx?)$

security:
  csrf: { method: POST, path: /orders, expect: 419 }   # sent signed in, without a token; must be refused with exactly `expect`
  allowedHosts: [fonts.example.com] # third-party hosts the pages may call; any other is a failing finding
  publicWrites: "^/(login|webhooks/)"  # POST/PUT/PATCH/DELETE routes that need no sign-in on purpose (see routes)

viewports:                          # default: these two. a11y and ux run on each
  - { name: desktop, width: 1440, height: 900 }
  - { name: mobile, width: 390, height: 844, mobile: true }

out: .tapcheck                      # where runs, sessions and state go (default .tapcheck); git-ignore it

jev:
  budget: 1                         # most USD one run may spend on Jev (default 1); JEV_BUDGET overrides it
  headers: {}                       # extra headers sent with every Jev request

i18n:
  keys: <command>                   # prints one translation key per line; ux then flags pages showing a raw key. Only dotted keys (orders.title) count

changes: { "*": ["src/**"], contract: ["api/**"] }   # see below
gates: […]                          # see below
routes: <command>                   # see below
stub: { port: 8310, rules: […] }    # see below
flows: tests/tapcheck/*.ts          # a glob or a list of globs; see below
mail: { mailpit: http://127.0.0.1:8025 }   # Mailpit's web address, for t.mail in flows
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
`suffix` added. Use the second form for pages whose address holds an id. a11y and ux audit exactly these screens; the
crawl starts from them. With no screens, all three use `/`. `purpose` is optional but the five-second test needs it.

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
crawl also visits every GET route without parameters and reports route coverage, and `code` lists writing routes
with `auth: false` that don't match `security.publicWrites` as a warning.

## changes (for CHANGED=1)

Maps a suite name (`crawl`, `contract`, `security`, `a11y`, `ux`, `usability`, `code`, `flow`) or `"*"` (added to
every suite) to globs on paths from the git root. A part reruns when a matching file changed since it last passed; a
suite with no globs reruns on any change; a change to `tapcheck.yml` reruns everything. `*` and `**` don't match
names starting with a dot.

## stub

```yaml
stub:
  port: 8310                        # default 8310
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

## flows

Journeys only this app has, written as TypeScript or JavaScript files; each is its own part, `flow-<name>`. Unlike the
suites, a flow may submit forms and change data, so it belongs with `app.reset` and `RESET=1`. The file format and
the `t` helpers (`t.goto`, `t.page`, `t.step`, `t.expect`, `t.stub`, `t.routeOutside`, `t.mail`) are described at the
top of `src/flow.ts` in the tapcheck folder (`<skill base directory>/../../src/flow.ts`), with a working example in
`examples/static-site/tests/tapcheck/` there.

## Environment variables for a run

| Variable | Effect |
|---|---|
| `ONLY=crawl,a11y` | only these parts: part names or tags, comma-separated; `flow-*` style prefixes work |
| `SKIP=jev` | take parts out again (contract and security still bring their side's crawl) |
| `LIST=1` | print the parts and their tags, mark what would run, and exit |
| `CHANGED=1` | of the chosen parts, only those whose files changed since each last passed (needs git) |
| `JEV=off` | skip `ux` and `usability`; they are also skipped when there is no `TYPESAFE_API_KEY` |
| `JEV_BUDGET=0.5` | most USD to spend on Jev this run (overrides `jev.budget`) |
| `RESET=1` | run `app.reset` first |
| `LOGIN=1` | sign in again by hand on `manual` sides |
| `CONTRACT_UPDATE=1` | accept the current JSON response shapes as the contract baseline |
| `TAPCHECK_CONFIG=path` | another config file instead of `./tapcheck.yml` |

Tags: each suite's name, each side's name, `jev` (ux, usability), `measured` (everything else), `code`, `flow`.
