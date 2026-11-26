import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { closeBrowser, context, open, SessionExpired, type Run } from '../src/browser.ts';
import { check } from '../src/config.ts';

test('session: signedIn catches a sign-in form shown in place, and each context saves the session it ends with', async () => {
    const tmp = mkdtempSync(`${tmpdir()}/tapcheck-session-`);
    // Signed in, the app shows its account menu and hands out a new token on every request (as rotating refresh tokens
    // do); signed out it shows its sign-in form at the same address, with no redirect.
    let n = 0;
    const server = createServer((req, res) => {
        const ok = /sid=ok/.test(req.headers.cookie ?? '');
        res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': ok ? `sid=ok${++n}; Path=/` : 'seen=1; Path=/' })
            .end(`<!doctype html><html lang="en"><title>t</title><body>${ok ? '<nav id="account">Me</nav>' : '<form><input type="password" aria-label="Password"></form>'}</body></html>`);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    after(async () => { await closeBrowser(); server.close(); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cfg = check({ baseUrl: base, sides: { member: { login: 'manual', signedIn: '#account' } }, viewports: [{ name: 'desktop', width: 800, height: 600 }] }, tmp);
    const file = `${tmp}/auth-member.json`;
    const state = (sid: string) => writeFileSync(file, JSON.stringify({ cookies: [{ name: 'sid', value: sid, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] }));
    const r: Run = { cfg, side: cfg.sides[0], dir: tmp, auth: file, record: () => {}, crawl: { pages: [], hits: [], done: false } };

    state('ok0');
    let ctx = await context(r, cfg.viewports[0]);
    await open(r, await ctx.newPage(), '/#orders');
    await ctx.close();
    assert.match(readFileSync(file, 'utf8'), /"value": "ok[1-9]/); // the token it was handed, for the next context

    // Local storage: a token the page renews is saved, a filter the run changed is not, and one the user chose at sign-in stays.
    const origin = { origin: base, localStorage: [{ name: 'sb-app-auth-token', value: 't0' }, { name: 'filters', value: 'etfs=on' }] };
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), origins: [origin] }));
    ctx = await context(r, cfg.viewports[0]);
    const page = await ctx.newPage();
    await open(r, page, '/#orders');
    await page.evaluate(() => { localStorage.setItem('sb-app-auth-token', 't1'); localStorage.setItem('filters', 'etfs=off'); localStorage.setItem('tab', 'saved'); });
    await ctx.close();
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).origins, [{ origin: base, localStorage: [{ name: 'sb-app-auth-token', value: 't1' }, { name: 'filters', value: 'etfs=on' }] }]);

    state('gone');
    ctx = await context(r, cfg.viewports[0]);
    await assert.rejects(open(r, await ctx.newPage(), '/#orders'), (e: Error) => e instanceof SessionExpired && /#account/.test(e.message) && /LOGIN=1/.test(e.message));
    await ctx.close();
    assert.doesNotMatch(readFileSync(file, 'utf8'), /seen/); // an ended session isn't saved over the last copy

    // A context without the session (a signed-out check) is neither checked nor saved.
    ctx = await context(r, cfg.viewports[0], false);
    await open(r, await ctx.newPage(), '/');
    await ctx.close();
    assert.doesNotMatch(readFileSync(file, 'utf8'), /seen/);
});
