# Static site example

A two-page fictional shop served by Python's built-in web server, with no sign-in. tapcheck starts the server, crawls
both pages, checks the JSON the home page fetches, the security headers and accessibility, then stops the server.

```bash
cd examples/static-site && node ../../src/cli.ts
```

Every suite on every side is a part, named `<suite>-<side>`; this site has one side, `public`. Two more parts come
from `tapcheck.yml`: `code` (the `gates:` commands; it starts neither the site nor a browser) and `flow-contact` (the
flow in `tests/tapcheck/contact.ts`). Pick parts by name or tag:

```bash
LIST=1 node ../../src/cli.ts                         # the parts, their tags, and which would run
ONLY=crawl,a11y node ../../src/cli.ts                # just these
ONLY=measured SKIP=security node ../../src/cli.ts    # everything code measures, without the security part
CHANGED=1 node ../../src/cli.ts                      # only the parts whose files changed since each last passed
ONLY=code node ../../src/cli.ts                      # just the gates: no server, no browser
ONLY=flow node ../../src/cli.ts                      # just the flows
```

`routes: cat routes.json` gives the crawl the site's route list, so it also reports how many GET routes it reached. The
`stub:` rule answers for a made-up plant API on port 8766; the site itself calls nothing outside, so the flow asks the
stub directly to show what an app would get. The suites only read; a flow is your own code and may submit forms and
change data.

`CHANGED=1` needs git. By default any changed file reruns a part; a `changes:` key in `tapcheck.yml` narrows that per
suite, with globs on paths from the git root, for example `changes: { contract: ["site/data/**"], "*": ["package.json"] }` (`"*"` adds to every suite).

With a `TYPESAFE_API_KEY` in the environment (or in a `.env` file in this folder), the `ux` and `usability` suites also
run: Jev judges both pages and tries the one task in `tapcheck.yml`. Without a key, or with `JEV=off`, they are skipped.

Python's server sends no security headers, so the security suite reports them missing. That's expected here and
shows what a finding looks like.
