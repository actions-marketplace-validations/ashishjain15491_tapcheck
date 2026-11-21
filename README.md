# tapcheck

End-to-end and UI audit harness for any web app, whatever its language or stack. It drives the running app in a real
browser, measures what code can measure (crawl, API contract, security headers, accessibility), and asks Jev to judge
what needs a human eye (visual QA, design, usability). Works on its own, or as a Claude Code / Codex plugin whose
skills set it up for your project.

Status: under construction, not usable yet.

## Beyond the built-in suites

Four optional keys in `tapcheck.yml` bring in what only your project knows. Paths and commands are relative to the
config file's folder. `examples/static-site` uses all four.

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
    - { host: example.com, path: "^/v1/users/\\d+$", file: tests/fixtures/user.json, delayMs: 200 }

# Flows: your own journeys, one part each.
flows: tests/tapcheck/*.ts
mail: { mailpit: http://127.0.0.1:8025 }   # for t.mail in flows
```

- **Gates** run as the part `code`, which has no side: `ONLY=code tapcheck` starts neither the app nor a browser.
  When the routes carry `auth`, `code` also lists POST/PUT/PATCH/DELETE routes with `auth: false` as a warning, unless
  they match `security.publicWrites` (a regular expression, e.g. `^/(login|webhooks/)`).
- **Routes** also feed the crawl: parameterless GET routes are visited, and "route coverage" reports how many GET
  routes were reached; the rest are in `<side>/missed-routes.json`.
- **Stub**: tapcheck starts it before `app.start` and sets `TAPCHECK_STUB_URL` (usable in `tapcheck.yml` too). Point
  each provider's base URL at `${TAPCHECK_STUB_URL}/<its host>`, e.g. `http://127.0.0.1:8310/api.example.com`; an
  `X-Forwarded-Host` header or the request's own `Host` header name the host as well. Any request with `tapcheck-fail`
  in its URL or body gets a 500. Flows read what it saw and switch failures on through `t.stub`; the control API is
  described at the top of `src/stub.ts`.
- **Flows** are files with `export default { name, side?, run: async (t) => {…} }` (`import type { Flow } from
  'tapcheck'` for the types). `t.goto(path)`, `t.page()`, `t.step(name, fn)`, `t.expect(cond, msg)`, `t.stub`,
  `t.routeOutside(ctx)` and `t.mail` are described in `src/flow.ts`. Each step is a finding; a failed step keeps a
  screenshot and the flow carries on.

The built-in suites only read: they never submit a form or follow a delete, send or sign-out. **Flows may change
data**: they are your code and click what you tell them to, so run them against a copy you can reset (`RESET=1`), or
leave them out with `SKIP=flow`.

MIT licensed.
