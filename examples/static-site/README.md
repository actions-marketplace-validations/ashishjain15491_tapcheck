# Static site example

A two-page fictional shop served by Python's built-in web server, with no sign-in. tapcheck starts the server, crawls
both pages, checks the JSON the home page fetches, the security headers and accessibility, then stops the server.

```bash
cd examples/static-site && node ../../src/cli.ts
```

Python's server sends no security headers, so the security suite reports them missing. That's expected here and
shows what a finding looks like.
