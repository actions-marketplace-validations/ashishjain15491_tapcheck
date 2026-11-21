import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { closeBrowser, type Run } from '../src/browser.ts';
import { check } from '../src/config.ts';
import type { Finding } from '../src/report.ts';
import * as crawl from '../src/suites/crawl.ts';

test('crawl: the route list seeds the queue and gives route coverage', async () => {
    const tmp = mkdtempSync(`${tmpdir()}/tapcheck-crawl-`);
    const asked: string[] = [];
    const page = (body: string) => `<!doctype html><html lang="en"><title>t</title><body><h1>t</h1>${body}</body></html>`;
    const server = createServer((req, res) => {
        asked.push(req.url!);
        const html = ({ '/': page('<a href="/plants/7">Fern</a>'), '/plants/7': page('fern'), '/about': page('about'), '/admin': null } as Record<string, string | null>)[req.url!];
        res.writeHead(html ? 200 : html === null ? 403 : 404, { 'content-type': 'text/html' }).end(html ?? 'no');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    after(async () => { await closeBrowser(); server.close(); });
    const routes = [{ method: 'GET', path: '/' }, { method: 'GET', path: 'about' }, { method: 'GET', path: '/admin' }, { method: 'GET', path: '/plants/{id}' },
        { method: 'GET', path: '/plants/{id}/care' }, { method: 'GET', path: '/export' }, { method: 'POST', path: '/plants' }];
    const cfg = check({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, routes: `echo '${JSON.stringify(routes)}'`, viewports: [{ name: 'desktop', width: 800, height: 600 }] }, tmp);
    const found: Omit<Finding, 'side'>[] = [];
    const r: Run = { cfg, side: cfg.sides[0], dir: tmp, record: (f) => { found.push(f); }, crawl: { pages: [], hits: [], done: false } };
    await crawl.run(r);

    // /about is only in the route list; /admin refuses this side and is no finding; /export matches crawl.skip and is never asked for.
    assert.deepEqual(r.crawl.pages.map((p) => p.path), ['/', '/about', '/plants/7']);
    assert.ok(asked.includes('/admin') && !asked.includes('/export') && !asked.includes('/plants'));
    assert.deepEqual(found.filter((f) => f.status === 'fail'), []);
    assert.deepEqual(found.find((f) => f.check === 'route coverage'), { suite: 'crawl', where: 'routes', check: 'route coverage', status: 'info',
        detail: `3/5 GET routes reached; unreached in ${tmp}/missed-routes.json` });
    assert.deepEqual(JSON.parse(readFileSync(`${tmp}/missed-routes.json`, 'utf8')), ['/admin', '/plants/{id}/care']);
});
