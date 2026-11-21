# Django

Detected by `manage.py`. Routes command verified on Django 6.1.

## Start, ready, reset

`testserver` creates a separate test database, loads fixtures into it and serves it, so the developer's database is
never touched:

```yaml
baseUrl: http://127.0.0.1:8010
app:
  start: python manage.py testserver --noinput --addrport 127.0.0.1:8010 tapcheck_users.json
  ready: /
  timeout: 180
```

- The fixture (here `tapcheck_users.json`, in an app's `fixtures/` folder) holds the test users and enough data for
  the list pages to show something. Make one from a dev database with
  `python manage.py dumpdata auth.user <app>.<Model> --indent 2`, with throwaway passwords.
- The test database is rebuilt on every start, so no `reset` is needed. Only if the project must run against its dev
  database with `runserver`: `reset: python manage.py flush --noinput && python manage.py loaddata <fixture>`, and only
  when that database is local and disposable.
- Use the project's own interpreter: `.venv/bin/python`, `poetry run python`, `uv run python`.
- `ALLOWED_HOSTS` must include `127.0.0.1` when `DEBUG` is off.

## Routes

Django routes carry no method and no sign-in flag, so every route is listed as GET. Save nothing: the command is
inline (`-v 0` keeps Django 5.2+ from printing its import notice into the JSON).

```yaml
routes: |
  python manage.py shell -v 0 -c '
  import json
  from django.urls import get_resolver, URLPattern
  from django.urls.resolvers import RoutePattern
  def walk(patterns, prefix="/"):
      for p in patterns:
          if not isinstance(p.pattern, RoutePattern): continue
          path = prefix + str(p.pattern)
          if isinstance(p, URLPattern): yield {"method": "GET", "path": path}
          else: yield from walk(p.url_patterns, path)
  print(json.dumps(list(walk(get_resolver().url_patterns))))'
```

`re_path()` routes and everything under `i18n_patterns()` are left out (regular expressions aren't understood). Since
no route says whether it needs sign-in, the `code` part's public-writes check has nothing to report.

## Translation keys

Django's gettext catalogues are keyed by the sentence itself: leave `i18n` out.

## Sign-in

```yaml
login:
  form:
    url: /accounts/login/           # LOGIN_URL in settings; the admin's own form is /admin/login/
    fields: { username: $TAPCHECK_USERNAME, password: $TAPCHECK_PASSWORD }
```

django-allauth: the page is `/accounts/login/` and the first field is named `login`. The default `loginPaths`
already matches `/accounts/login/` and `/admin/login/`.

## Gates to look for

Only those in `pyproject.toml`, `setup.cfg`, `requirements-dev.txt` or the CI workflow:

```yaml
gates:
  - { name: django check, run: python manage.py check }
  - { name: missing migrations, run: python manage.py makemigrations --check --dry-run }
  - { name: ruff, run: ruff check . }
  - { name: mypy, run: mypy . }
  - { name: pip-audit, run: pip-audit, warn: true }
```

`manage.py check` and the migrations check need nothing installed and fit every Django project.

## CSRF and changes

```yaml
security:
  csrf: { method: POST, path: <a form's POST path>, expect: 403 }
changes:
  "*": ["**/*.py", "**/templates/**", "**/static/**", "requirements*.txt", "pyproject.toml"]
```

For the CSRF path pick a view that validates a form, so an empty body changes nothing even if the protection is
missing. Views marked `csrf_exempt` and DRF views using token authentication answer differently; don't use those.
