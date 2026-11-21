# Laravel

Detected by `composer.json` and `artisan`. Routes and i18n commands verified on Laravel 12.

## Start, ready, reset

Use a separate environment so the run never touches the developer's own database: copy `.env.example` to
`.env.testing` if there is none, set `DB_CONNECTION=sqlite` and `DB_DATABASE` to an absolute path such as
`<project>/database/tapcheck.sqlite` there (create the empty file), then:

```yaml
baseUrl: http://127.0.0.1:8010
app:
  start: APP_ENV=testing php artisan serve --host=127.0.0.1 --port=8010
  ready: /up                 # Laravel 11+; on older apps use /login or /
  reset: APP_ENV=testing php artisan migrate:fresh --seed --force
```

- Run the reset command once by hand before the first run, so the tables and seeded users exist.
- Build the frontend first when the app uses Vite (`npm ci && npm run build`); without the manifest every page is a 500.
- If the app needs queues, mail or a cache server, set `QUEUE_CONNECTION=sync`, `MAIL_MAILER=log` (or Mailpit, see
  below) and `CACHE_STORE=file` in `.env.testing` rather than starting more services.
- No `.env.testing` wanted: drop `APP_ENV=testing` and leave `reset` out, so tapcheck can never wipe the dev database.

## Routes

```yaml
routes: |
  php -d display_errors=stderr artisan route:list --json | php -r 'echo json_encode(array_map(fn($r) => ["method" => $r["method"], "path" => $r["uri"], "auth" => (bool) preg_match("/(^|\s)auth\b|Authenticate\b/", implode(" ", (array) $r["middleware"]))], json_decode(stream_get_contents(STDIN), true)));'
```

`auth` is true for routes behind the `auth` middleware (any guard). Routes protected only inside a controller or by a
custom middleware show as `auth: false`; name the intended public ones in `security.publicWrites`, e.g.
`"^/(login|register|forgot-password|reset-password|webhooks/)"`.

## Translation keys

```yaml
i18n:
  keys: |
    php -d display_errors=stderr -r 'require "vendor/autoload.php"; foreach (glob("lang/en/*.php") as $f) foreach (array_keys(Illuminate\Support\Arr::dot(require $f)) as $k) echo basename($f, ".php"), ".", $k, "\n";'
```

Use `resources/lang/en` on apps that keep it there. JSON catalogues (`lang/en.json`) are keyed by the sentence itself
and can't be checked; leave `i18n` out if the app has only those.

## Sign-in

Seeded users are in `database/seeders/`. With the starter kits (Breeze, Jetstream, Fortify) the form is:

```yaml
login:
  form:
    url: /login
    fields: { email: $TAPCHECK_EMAIL, password: $TAPCHECK_PASSWORD }
```

Two-factor (Fortify): add `totp: { field: code, secret: $TAPCHECK_TOTP_SECRET }`. Sign-in through a third party
(Socialite, SSO): use `login: { command: … }` with an artisan command that signs a user in and prints the session
cookie as a storageState, or `manual`.

## Gates to look for

Only those the project already has (`composer.json` scripts and `require-dev`, the CI workflow):

```yaml
gates:
  - { name: pint, run: vendor/bin/pint --test }
  - { name: phpstan, run: vendor/bin/phpstan analyse --no-progress --memory-limit=1G }
  - { name: composer audit, run: composer audit, warn: true }
  - { name: npm audit, run: npm audit --audit-level=high, warn: true }
```

## CSRF, crawl, changes

```yaml
security:
  csrf: { method: POST, path: <a web POST route>, expect: 419 }
changes:
  "*": ["app/**", "routes/**", "resources/**", "config/**", "database/**", "public/**", "composer.lock", "package-lock.json"]
  code: ["**/*.php", "composer.json"]
```

For the CSRF path pick a POST route in `routes/web.php` that validates its input, so an empty body changes nothing
even if the protection is missing; not sign-out, not a delete. Routes in `routes/api.php` have no CSRF check.

## Outside services and mail

Stub: `artisan serve` hands the app only a few environment variables (`APP_ENV` among them), so don't set base URLs
in `app.start`. For providers whose base URL comes from `config/services.php` and an env variable, write the stub's
address into `.env.testing` instead (`PAYMENTS_BASE_URL=http://127.0.0.1:8310/api.example.com`, with `stub.port: 8310`).
Mail for flows: run Mailpit, set `MAIL_MAILER=smtp`, `MAIL_HOST=127.0.0.1`,
`MAIL_PORT=1025` in `.env.testing`, and `mail: { mailpit: http://127.0.0.1:8025 }`.
