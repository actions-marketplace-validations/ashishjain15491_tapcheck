import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { closeBrowser, type Run } from '../src/browser.ts';
import { check } from '../src/config.ts';
import type { Finding } from '../src/report.ts';
import * as security from '../src/suites/security.ts';

after(closeBrowser);

test('security: a session kept outside cookies is a note, a session cookie without its flags still fails', async () => {
    const tmp = mkdtempSync(`${tmpdir()}/tapcheck-security-`);
    const cfg = check({ baseUrl: 'http://127.0.0.1:9', sides: { member: { login: 'manual' } }, viewports: [{ name: 'desktop', width: 800, height: 600 }] }, tmp);
    const flags = async (cookies: object[]) => {
        writeFileSync(`${tmp}/auth.json`, JSON.stringify({ cookies, origins: [] }));
        const found: Omit<Finding, 'side'>[] = [];
        // No crawled pages: nothing is requested, only the saved session is read.
        await security.run({ cfg, side: cfg.sides[0], dir: tmp, auth: `${tmp}/auth.json`, record: (f) => { found.push(f); }, crawl: { pages: [], hits: [], done: true } } as Run);
        return found.filter((f) => f.check === 'session cookie flags').map((f) => [f.where, f.status, f.detail]);
    };
    const cookie = { name: 'theme', value: 'dark', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' };
    assert.deepEqual((await flags([cookie])).map((f) => [f[0], f[1]]), [['cookies', 'info']]);
    assert.match((await flags([cookie]))[0][2]!, /^no session cookie to check/);
    assert.deepEqual(await flags([{ ...cookie, name: 'app_session' }]), [['cookie app_session', 'fail', 'not HttpOnly']]);
});

test('security: signed out, a page that shows the signedIn selector fails, public API data is a note, and new-tab links are read from the rendered page', async () => {
    const tmp = mkdtempSync(`${tmpdir()}/tapcheck-security-`);
    const html = (body: string) => `<!doctype html><html lang="en"><title>t</title><body>${body}</body></html>`;
    // An app that signs in in place: the server sends every page to everyone, and what the page shows is up to its script.
    const PAGES: Record<string, string> = {
        '/ok': html('<script>document.body.innerHTML = document.cookie.includes("sid=") ? \'<nav id="account">Ada</nav>\' : \'<form><input aria-label="Email"></form>\'</script>'),
        '/leaky': html('<script>document.body.innerHTML = \'<nav id="account">Ada</nav>\'</script>'),
        '/links': html('<script>document.body.innerHTML = \'<a href="/ok" target="_blank">One</a> <a href="/ok" target="_blank" rel="noopener">Two</a>\'</script>'),
    };
    const server = createServer((req, res) => {
        if (req.url === '/api/prices') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"fern": 4}');
        if (req.url === '/api/orders') return res.writeHead(401, { 'content-type': 'application/json' }).end('{"error": "sign in"}');
        res.writeHead(200, { 'content-type': 'text/html' }).end(PAGES[req.url!] ?? '');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    after(() => { server.close(); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(`${tmp}/auth.json`, JSON.stringify({ cookies: [{ name: 'sid', value: '1', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] }));
    const run = async (sides: object, paths: string[]) => {
        const cfg = check({ baseUrl: base, sides, viewports: [{ name: 'desktop', width: 800, height: 600 }], screens: paths.map((path) => ({ name: path, path })) }, tmp);
        const found: Omit<Finding, 'side'>[] = [];
        const hit = (path: string) => ({ url: base + path, method: 'GET', type: 'fetch', status: 200, contentType: 'application/json', ms: 0, bytes: 0, page: '/ok' });
        await security.run({ cfg, side: cfg.sides[0], dir: tmp, auth: `${tmp}/auth.json`, record: (f) => { found.push(f); },
            crawl: { pages: paths.map((p) => ({ path: p, status: 200, finalPath: p, ms: 0, errors: [], links: [] })), hits: [hit('/api/prices'), hit('/api/orders')], done: true } } as Run);
        return (check: string) => { const f = found.find((x) => x.check === check); return `${f?.status}: ${f?.detail ?? ''}`; };
    };

    const member = await run({ member: { login: 'manual', signedIn: '#account' } }, ['/ok', '/leaky']);
    assert.equal(member('pages need sign-in'), 'fail: shows #account signed out: /leaky');
    assert.equal(member('API data needs sign-in'), 'info: 1 of 2 GET call(s) answer with JSON signed out (fine when meant for everyone): /api/prices');
    assert.equal(member('new-tab links use rel=noopener'), 'pass: 0 new-tab links on 2 rendered page(s)');

    const open = await run({ public: { login: 'none' } }, ['/links']);
    assert.equal(open('new-tab links use rel=noopener'), 'warn: /links (1)');
});
