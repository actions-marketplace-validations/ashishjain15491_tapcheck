import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { closeBrowser, type Run } from '../src/browser.ts';
import { check } from '../src/config.ts';
import type { Finding } from '../src/report.ts';
import * as a11y from '../src/suites/a11y.ts';

// An app shell: a rail of 25 links, then the main content, where one control keeps the focus it is given.
const HOME = `<!doctype html><html lang="en"><title>t</title><body><h1>t</h1>
<nav>${Array.from({ length: 25 }, (_, i) => `<a href="#p${i}">Page ${i}</a>`).join(' ')}</nav>
<main><button onkeydown="event.preventDefault()">Trap</button> <button>After</button></main></body></html>`;

test('a11y: Tab is tried from the main content too, and the focus ring is left to audit', async () => {
    const tmp = mkdtempSync(`${tmpdir()}/tapcheck-a11y-`);
    const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end(HOME); });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    after(async () => { await closeBrowser(); server.close(); });
    const cfg = check({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, viewports: [{ name: 'desktop', width: 800, height: 600 }] }, tmp);
    const found: Omit<Finding, 'side'>[] = [];
    await a11y.run({ cfg, side: cfg.sides[0], dir: tmp, record: (f) => { found.push(f); }, crawl: { pages: [], hits: [], done: false } } as Run);
    const tab = found.find((f) => f.check === 'keyboard: Tab moves focus');
    assert.deepEqual([tab?.status, tab?.detail], ['fail', '12 distinct stops in 12 presses from the top, 1 distinct stops in 12 presses from the main content; 27 focusable']);
    assert.equal(found.some((f) => f.check === 'keyboard: focus is visible'), false);
});
