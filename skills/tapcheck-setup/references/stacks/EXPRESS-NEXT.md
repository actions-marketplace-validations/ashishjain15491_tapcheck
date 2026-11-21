# Express and Next.js

Detected by `package.json` with `express` or `next` in its dependencies. Use the project's package manager (`npm`,
`pnpm`, `yarn`, `bun`) wherever `npm` appears below.

## Start, ready, reset

```yaml
baseUrl: http://127.0.0.1:3010
app:
  start: npm run build && PORT=3010 npm start      # Next.js: the production build is what users get, and it is faster to audit
  ready: /
  timeout: 300
```

- Express: `start: PORT=3010 NODE_ENV=test node server.js` (the `start` script's command; check which variable sets
  the port).
- A development server (`next dev`, `nodemon`) works too, but its overlay and slow first compiles show up as findings.
- Database: point the app at a separate one in `app.start` (`DATABASE_URL=… npm start`) and reset that one, e.g.
  Prisma `reset: DATABASE_URL=… npx prisma migrate reset --force` (it reseeds), Knex
  `npx knex migrate:rollback --all && npx knex migrate:latest && npx knex seed:run`. If that URL holds
  a password, write it as a `$VAR` the user exports, never in the file.

## Routes: Next.js

Next's routes are its folders. Save this as `tests/tapcheck/routes.mjs` (verified on the `app/` and `pages/` layouts)
and set `routes: node tests/tapcheck/routes.mjs`:

```js
// Prints a Next.js app's routes (app/ and pages/ folders) as tapcheck's JSON. Run from the project root.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
const out = [];
const url = (root, dir, name = '') => '/' + [...relative(root, dir).split(sep), name].filter((s) => s && s !== 'index' && !/^\(.*\)$/.test(s) && !s.startsWith('@'))
    .map((s) => s.replace(/^\[\[?\.\.\.(.+?)\]?\]$/, '*$1').replace(/^\[(.+)\]$/, ':$1')).join('/');
const walk = (root, dir, pages) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, e.name), m = e.name.match(/^(.+)\.(jsx?|tsx?|mdx?)$/);
        if (e.isDirectory()) { if (!e.name.startsWith('_')) walk(root, file, pages); continue; }
        if (!m) continue;
        if (pages) { // pages/: every file is a page; pages/api/* answer any method
            if (!m[1].startsWith('_')) out.push({ method: 'GET', path: url(root, dir, m[1]) });
        } else if (m[1] === 'page') out.push({ method: 'GET', path: url(root, dir) });
        else if (m[1] === 'route') for (const v of readFileSync(file, 'utf8').matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) out.push({ method: v[1], path: url(root, dir) });
    }
};
for (const [dir, pages] of [['app', false], ['src/app', false], ['pages', true], ['src/pages', true]]) if (existsSync(dir)) walk(dir, dir, pages);
console.log(JSON.stringify(out));
```

Server actions and anything `middleware` rewrites aren't listed. There is no `auth` flag.

## Routes: Express

Express keeps routes on the app object, so the script must load the module that creates the app. Save this as
`tests/tapcheck/routes.cjs` (verified on Express 4 and 5) and set `routes: node tests/tapcheck/routes.cjs ./app.js`,
naming the file that exports the app (`module.exports = app`, `{ app }`, or a default export):

```js
// Prints the Express app's routes as tapcheck's JSON. Usage: node routes.cjs ./app.js
const { resolve } = require('node:path');
const express = require('express');
// Express doesn't keep a mounted router's path, so note it as each router is mounted.
for (const target of [express.application, express.Router.prototype?.use ? express.Router.prototype : express.Router]) {
    const use = target.use;
    target.use = function (...args) {
        if (typeof args[0] === 'string') for (const h of args.slice(1).flat()) if (h && h.stack) h.mountedAt = args[0];
        return use.apply(this, args);
    };
}
const loaded = require(resolve(process.argv[2]));
const app = loaded.app ?? loaded.default ?? loaded;
const out = [];
const walk = (stack, prefix) => {
    for (const layer of stack) {
        if (layer.route) for (const method of Object.keys(layer.route.methods)) out.push({ method: method.toUpperCase(), path: (prefix + layer.route.path).replace(/\/+/g, '/') });
        else if (layer.handle?.stack) walk(layer.handle.stack, prefix + (layer.handle.mountedAt ?? ''));
    }
};
walk((app._router ?? app.router).stack, '');
console.log(JSON.stringify(out));
process.exit(0); // the app may have started listening
```

If the app is only created inside the file that also connects to the database and listens, and that can't be loaded
without side effects, leave `routes` out rather than restructuring the app during setup. An ESM or TypeScript app
needs the same script as `.mjs` with `import`; that variant is not verified. There is no `auth` flag.

## Translation keys

No standard. With i18next-style JSON catalogues (`locales/en/*.json`, nested keys) write a `node -e` command that
prints the flattened dotted keys; leave `i18n` out when keys are whole sentences.

## Sign-in

Read the sign-in page for the field names. NextAuth/Auth.js with a credentials provider: `url: /api/auth/signin` or
the app's own page; the default `loginPaths` matches `/login` and `/signin` but not `/api/auth/signin`, so set
`loginPaths: "/(login|sign-?in|api/auth/signin)(/|$)"`. Sign-in through another company's page (OAuth) can't be
filled as a form: use `login: { command: … }` with a script that creates a session in the app's own store and prints
the cookie as a storageState, or `manual`.

## Gates to look for

From `package.json` scripts, only those that exist:

```yaml
gates:
  - { name: lint, run: npm run lint }
  - { name: types, run: npx tsc --noEmit }
  - { name: npm audit, run: npm audit --audit-level=high, warn: true }
```

## CSRF and changes

Neither framework has CSRF protection built in. Set `security.csrf` only if the app adds one (a `csrf` middleware
usually answers 403); otherwise leave it out and tell the user that cookie-based sign-in without it relies on
`SameSite` cookies, which the security suite checks.

```yaml
changes:
  "*": ["src/**", "app/**", "pages/**", "components/**", "public/**", "package-lock.json"]
  code: ["**/*.{js,jsx,ts,tsx}", "package.json"]
```

Keep only the folders the project has.
