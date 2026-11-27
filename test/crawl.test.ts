import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { closeBrowser, context, open, type Run } from '../src/browser.ts';
import { check } from '../src/config.ts';
import type { Finding } from '../src/report.ts';
import * as crawl from '../src/suites/crawl.ts';

test('crawl: the route list seeds the queue and gives route coverage', async () => {
    const tmp = mkdtempSync(`${tmpdir()}/tapcheck-crawl-`);
    const asked: string[] = [];
    const page = (body: string) => `<!doctype html><html lang="en"><title>t</title><body><h1>t</h1>${body}</body></html>`;
    const server = createServer((req, res) => {
        asked.push(req.url!);
        if (req.url === '/invoices/7/file') return res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="invoice.pdf"' }).end('%PDF-1.4');
        const html = ({ '/': page('<a href="/plants/7">Fern</a> <a href="/invoices/7/file">Invoice</a>'), '/plants/7': page('fern'), '/about': page('about'), '/admin': null, '/account': page('mine') } as Record<string, string | null>)[req.url!];
        res.writeHead(html ? 200 : html === null ? 403 : 404, { 'content-type': 'text/html' }).end(html ?? 'no');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    after(async () => { await closeBrowser(); server.close(); });
    const routes = [{ method: 'GET', path: '/' }, { method: 'GET', path: 'about' }, { method: 'GET', path: '/admin' }, { method: 'GET', path: '/plants/{id}' },
        { method: 'GET', path: '/plants/{id}/care' }, { method: 'GET', path: '/export' }, { method: 'POST', path: '/plants' }, { method: 'GET', path: '/account', auth: true }];
    const cfg = check({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, routes: `echo '${JSON.stringify(routes)}'`, viewports: [{ name: 'desktop', width: 800, height: 600 }] }, tmp);
    const found: Omit<Finding, 'side'>[] = [];
    const r: Run = { cfg, side: cfg.sides[0], dir: tmp, record: (f) => { found.push(f); }, crawl: { pages: [], hits: [], done: false } };
    await crawl.run(r);

    // Links first, then routes: /about is only in the route list; /admin refuses this side and is no finding (nor does it use up
    // crawl.max); /export matches crawl.skip and is never asked for; /account needs sign-in and this side has none, so it isn't
    // asked for either. /invoices/7/file is a download: no page and no finding, but its link is checked.
    assert.deepEqual(r.crawl.pages.map((p) => p.path), ['/', '/plants/7', '/about']);
    assert.ok(asked.includes('/admin') && !asked.includes('/export') && !asked.includes('/plants') && !asked.includes('/account'));
    assert.ok(asked.includes('/invoices/7/file'));
    assert.deepEqual(found.filter((f) => f.status === 'fail'), []);
    assert.deepEqual(found.find((f) => f.check === 'route coverage'), { suite: 'crawl', where: 'routes', check: 'route coverage', status: 'info',
        detail: `3/6 GET routes reached; unreached in ${tmp}/missed-routes.json` });
    assert.deepEqual(JSON.parse(readFileSync(`${tmp}/missed-routes.json`, 'utf8')), ['/admin', '/plants/{id}/care', '/account']);
});

test('open: a page load that fails once is tried again', async () => {
    const tmp = mkdtempSync(`${tmpdir()}/tapcheck-open-`);
    let tries = 0;
    const server = createServer((req, res) => {
        if (req.url === '/flaky' && ++tries === 1) return req.socket.destroy(); // the first answer never comes
        res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>t</title><h1>ok</h1>');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
        const cfg = check({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, viewports: [{ name: 'desktop', width: 800, height: 600 }] }, tmp);
        const r: Run = { cfg, side: cfg.sides[0], dir: tmp, record: () => {}, crawl: { pages: [], hits: [], done: false } };
        const ctx = await context(r, cfg.viewports[0]);
        const res = await open(r, await ctx.newPage(), '/flaky');
        assert.equal(res?.status(), 200);
        assert.equal(tries, 2);
        await ctx.close();
    } finally { await closeBrowser(); server.close(); }
});

test('crawl: a hash-routed app gets a page per route, with its status', async () => {
    const tmp = mkdtempSync(`${tmpdir()}/tapcheck-hash-`);
    // One document; the fragment picks the screen, and its buttons change it, as in an app that routes in the hash.
    // A #/route link is followed; a #section link is a place on the page.
    const html = `<!doctype html><html lang="en"><title>t</title><body><h1 id="t"></h1><a href="#/help">Help</a> <a href="#top">Top</a>
        <script>const show = () => { document.getElementById('t').textContent = location.hash || 'home'; }; addEventListener('hashchange', show); show();</script></body></html>`;
    const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end(html); });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
        const cfg = check({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, viewports: [{ name: 'desktop', width: 800, height: 600 }],
            screens: [{ name: 'Home', path: '/' }, { name: 'Scanner', path: '/#scanner' }, { name: 'Map', path: '/#map' }] }, tmp);
        const found: Omit<Finding, 'side'>[] = [];
        const r: Run = { cfg, side: cfg.sides[0], dir: tmp, record: (f) => { found.push(f); }, crawl: { pages: [], hits: [], done: false } };
        await crawl.run(r);
        assert.deepEqual(r.crawl.pages.map((p) => [p.path, p.status, p.finalPath]), [['/', 200, '/'], ['/#scanner', 200, '/#scanner'], ['/#map', 200, '/#map'], ['/#/help', 200, '/#/help']]);
        assert.deepEqual(found.filter((f) => f.check === 'page answers' && f.status !== 'pass'), []);
        // Each hash screen is reached under its own name, and screens with their own heading are distinct.
        assert.deepEqual(r.reached!.map((x) => x.what), ['GET /', 'GET /#scanner', 'GET /#map', 'GET /#/help']);
        assert.deepEqual(found.filter((f) => f.check === 'screens are distinct'), []);
    } finally { await closeBrowser(); server.close(); }
});

test('crawl: the load time leaves out the wait for a quiet network, and a screen configured twice is said', async () => {
    const tmp = mkdtempSync(`${tmpdir()}/tapcheck-load-`);
    // A shop whose home keeps a request open for 1.5 s, as a live feed does. /old redirects to it, /same shows the same
    // screen at another address, /other has the same controls under its own heading.
    const html = (h1: string) => `<!doctype html><html lang="en"><title>Shop</title><body><h1>${h1}</h1><button>Buy</button><script>if (location.pathname === '/') fetch('/poll');</script></body></html>`;
    const server = createServer((req, res) => {
        if (req.url === '/poll') return void setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end('{}'), 1500);
        if (req.url === '/old') return res.writeHead(302, { location: '/' }).end();
        res.writeHead(200, { 'content-type': 'text/html' }).end(html(req.url === '/other' ? 'Other' : 'Shop'));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
        const cfg = check({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, viewports: [{ name: 'desktop', width: 800, height: 600 }],
            screens: [{ name: 'Home', path: '/' }, { name: 'Old', path: '/old' }, { name: 'Same', path: '/same' }, { name: 'Other', path: '/other' }] }, tmp);
        const found: Omit<Finding, 'side'>[] = [];
        const r: Run = { cfg, side: cfg.sides[0], dir: tmp, record: (f) => { found.push(f); }, crawl: { pages: [], hits: [], done: false } };
        await crawl.run(r);
        assert.ok(r.crawl.pages[0].ms < 1000, `the load, not the 1.5 s request after it: ${r.crawl.pages[0].ms} ms`);
        assert.ok(r.crawl.hits.some((h) => h.url.endsWith('/poll') && h.ms >= 1400 && h.keys?.length === 0), 'the crawl still waited for the request');
        assert.deepEqual(found.filter((f) => /^loads under/.test(f.check)).map((f) => f.status), ['pass', 'pass', 'pass', 'pass']);
        assert.deepEqual(found.filter((f) => f.check === 'screens are distinct').map((f) => [f.where, f.status, f.detail!.split(':')[0]]),
            [['/old', 'warn', '"Old" renders the same as "Home" (/)'], ['/same', 'warn', '"Same" renders the same as "Home" (/)']]);
    } finally { await closeBrowser(); server.close(); }
});
