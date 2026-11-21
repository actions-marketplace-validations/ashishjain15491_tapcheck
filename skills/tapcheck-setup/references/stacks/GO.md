# Go

Detected by `go.mod`. Go has no route lister of its own; what works depends on the router (look at the imports).

## Start, ready, reset

```yaml
baseUrl: http://127.0.0.1:8080
app:
  start: go run ./cmd/server          # the main package; check how the port and database are configured (flags or env)
  ready: /healthz                     # or /
  timeout: 180                        # the first `go run` compiles everything
```

Point the app at a separate database through its own flag or environment variable in `app.start`, and give `reset`
the project's own migrate-and-seed command against that database (`make`, `goose`, `migrate`, `atlas`). No such
command: leave `reset` out.

## Routes

**net/http (Go 1.22+ patterns)**, verified. Reads the patterns from the source, so it only sees literal strings:

```yaml
routes: |
  grep -rhoE '\.Handle(Func)?\("((GET|POST|PUT|PATCH|DELETE) )?/[^"]*"' --include='*.go' --exclude='*_test.go' . | sed -E 's/^[^"]*"//; s/"$//; s/\{\$\}$//; s/\{([^}]+)\.\.\.\}/*\1/' | awk 'BEGIN { printf "[" } { n = split($0, a, " "); printf "%s{\"method\":\"%s\",\"path\":\"%s\"}", (NR > 1 ? "," : ""), (n == 2 ? a[1] : "GET"), a[n] } END { print "]" }'
```

A pattern without a method is listed as GET. Routes registered under a prefix (`http.StripPrefix`, a sub-mux) come
out without it.

**chi, gin, echo**: the router can list itself, but only from inside the program. If the project already has a way
to print its routes, use it. Otherwise propose (don't add without asking) a `routes` argument to the server's `main`
that prints the list and exits, then `routes: go run ./cmd/server routes`:

```go
// chi (verified on chi v5)
type route struct {
	Method string `json:"method"`
	Path   string `json:"path"`
}
list := []route{}
chi.Walk(r, func(method, path string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
	list = append(list, route{method, path})
	return nil
})
json.NewEncoder(os.Stdout).Encode(list)
```

gin: the same over `engine.Routes()` (each has `.Method` and `.Path`, parameters as `:id` and `*rest`). echo: over
`e.Routes()` (`.Method`, `.Path`). Both **not verified**. chi's `{id}` and gin's `:id` are both understood. None of
these carry a sign-in flag, so there is no `auth`.

## Translation keys

No standard: leave `i18n` out unless the project has a catalogue of dotted keys and a way to print them.

## Sign-in

Read the sign-in handler and its template for the field names, then `login: { form: … }`. Token-only APIs with a
separate frontend: sign in through the frontend's form.

## Gates to look for

`go vet` fits every project; the others only if the project uses them (CI workflow, `Makefile`, `.golangci.yml`):

```yaml
gates:
  - { name: go vet, run: go vet ./... }
  - { name: golangci-lint, run: golangci-lint run }
  - { name: govulncheck, run: govulncheck ./..., warn: true }
```

## CSRF and changes

No CSRF protection is built in. Set `security.csrf` only when the app uses a middleware for it: `gorilla/csrf`
answers 403, `nosurf` 400.

```yaml
changes:
  "*": ["**/*.go", "go.sum", "templates/**", "static/**", "web/**"]
```

Keep only the folders the project has.
