# Static site

Plain HTML files, or the output folder of a site generator (`dist/`, `build/`, `public/`, `_site/`). Verified with
tapcheck's own `examples/static-site`.

## Start, ready

Find the folder that holds `index.html`; that is the web root, `<root>` below. If the site is generated, build it
first (put the build in `app.start` before the server: `npm run build && python3 -m http.server …`).

```yaml
baseUrl: http://127.0.0.1:8765
app:
  start: python3 -m http.server 8765 --bind 127.0.0.1 --directory <root>
  ready: /
```

No Python: `npx --yes serve -l 8765 <root>`. If the project has its own preview command (`npm run preview`,
`hugo server`, `bundle exec jekyll serve`), prefer it and use its port. Pick a port nothing else is using: if
something already answers on it, tapcheck audits that instead of starting the site.

There is no database, so no `reset`, and no sign-in, so no `sides` and no `security.csrf`.

## Routes

Every HTML file is a route:

```yaml
routes: |
  find <root> -name '*.html' | sed -E 's|^<root>||; s|/index\.html$|/|' | awk 'BEGIN { printf "[" } { printf "%s{\"method\":\"GET\",\"path\":\"%s\"}", (NR > 1 ? "," : ""), $0 } END { print "]" }'
```

Write the real folder in both places `<root>` appears. If the server serves pages without `.html` (most generators'
preview servers do), add `s|\.html$||;` to the `sed` expressions.

## Screens and tasks

One screen per page type (home, a listing, a detail page, contact), each with a `purpose`. For tasks, think of what
a visitor comes to find: a price, opening hours, how to get in touch. A task is done when the page holding the
answer (or the form) is open; tapcheck never submits the form.

## Gates to look for

Only what the project has: an HTML or link checker in `package.json` scripts, a generator's build
(`{ name: build, run: npm run build }`). A site of hand-written files with no tooling needs no gates.

## What to expect

- Simple file servers send no security headers, so the security suite reports them missing. That is true of the
  local server; tell the user to check what their real host sends rather than treating it as a bug in the site.
- Fonts, analytics and embeds from other hosts fail "no third-party requests". List the hosts the user confirms are
  intended in `security.allowedHosts`; don't add them on your own.

## Changes

```yaml
changes:
  "*": ["<root>/**"]
```

For a generated site use the source folders instead (`src/**`, `content/**`, `layouts/**`).
