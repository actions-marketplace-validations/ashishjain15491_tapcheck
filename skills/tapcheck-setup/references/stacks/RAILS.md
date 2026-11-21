# Rails

Detected by `Gemfile` and `config/routes.rb`. **Not verified**: the commands below were written from the Rails API
without a Rails app to run them against. Run each one by hand first and check its output.

## Start, ready, reset

Rails' `test` environment has its own database, so the run never touches the development one:

```yaml
baseUrl: http://127.0.0.1:3010
app:
  start: RAILS_ENV=test bin/rails server -b 127.0.0.1 -p 3010 -P tmp/pids/tapcheck.pid
  ready: /up                 # Rails 7.1+; on older apps use /
  reset: RAILS_ENV=test bin/rails db:reset
```

- `db:reset` loads the schema and runs `db/seeds.rb`; the seeds must create the test users. If the project uses
  fixtures instead: `RAILS_ENV=test bin/rails db:schema:load db:fixtures:load`.
- Run the reset once by hand before the first run. Precompile assets if the app needs it
  (`RAILS_ENV=test bin/rails assets:precompile`).
- `config/environments/test.rb` usually sets `config.action_controller.allow_forgery_protection = false`. Then the
  CSRF probe below will fail; that is a true finding about the test environment, not about production. Either leave
  `security.csrf` out, or run against `development` with a throwaway database.

## Routes

```yaml
routes: |
  bin/rails runner 'puts Rails.application.routes.routes.reject(&:internal).map { |r| { method: (r.verb.empty? ? "GET" : r.verb), path: r.path.spec.to_s } }.to_json'
```

Paths come out as `/orders/:id(.:format)`, which tapcheck understands. Rails routes carry no sign-in flag (that is a
`before_action`), so there is no `auth` and the public-writes check has nothing to report.

## Translation keys

```yaml
i18n:
  keys: |
    bin/rails runner 'I18n.backend.eager_load!; flat = ->(h, pre) { h.flat_map { |k, v| v.is_a?(Hash) ? flat.(v, "#{pre}#{k}.") : ["#{pre}#{k}"] } }; puts flat.(I18n.backend.translations[I18n.default_locale] || {}, "")'
```

## Sign-in

Devise: the page is `/users/sign_in` and the fields are `user[email]` and `user[password]` (name attributes):

```yaml
loginPaths: "/(login|sign[-_]?in|two-factor|2fa)(/|$)"   # the default doesn't match Devise's sign_in
sides:
  member:
    login:
      form:
        url: /users/sign_in
        fields: { "user[email]": $TAPCHECK_EMAIL, "user[password]": $TAPCHECK_PASSWORD }
```

Rails 8's built-in authentication: `/session/new`, fields `email_address` and `password`; set
`loginPaths: "/session/new$"`.

## Gates to look for

Only those in the `Gemfile` or `bin/`:

```yaml
gates:
  - { name: rubocop, run: bin/rubocop }
  - { name: brakeman, run: bin/brakeman --no-pager -q }
  - { name: bundler-audit, run: bundle exec bundler-audit check --update, warn: true }
```

## CSRF and changes

```yaml
security:
  csrf: { method: POST, path: <a create route>, expect: 422 }
changes:
  "*": ["app/**", "config/**", "db/**", "lib/**", "public/**", "Gemfile.lock"]
  code: ["**/*.rb", "Gemfile"]
```

Pick a create route whose model validates its fields, so an empty body changes nothing even if the protection is off.
