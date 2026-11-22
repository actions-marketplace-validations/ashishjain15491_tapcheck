import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { settle } from '../src/browser.ts';

// A page's own timers never fire when it is sandboxed without allow-scripts (an email preview, say) or when its main
// thread never yields; page.evaluate has no timeout, so settle() must not wait on them.
test('settle: returns on pages whose own timers never fire', async () => {
    const server = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html', ...(req.url === '/preview' ? { 'content-security-policy': "sandbox allow-popups; default-src 'none'" } : {}) });
        res.end(req.url === '/preview' ? '<h1>Your email</h1>' : '<p>busy</p><script>setTimeout(() => { for (;;) {} }, 50)</script>');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const browser = await chromium.launch();
    try {
        for (const path of ['/preview', '/busy']) {
            const page = await browser.newPage();
            await page.goto(base + path);
            await page.waitForTimeout(200);
            const t0 = Date.now();
            await settle(page);
            const ms = Date.now() - t0;
            assert.ok(ms < 9000, `${path}: settle took ${ms} ms`);
        }
    } finally {
        await browser.close();
        server.close();
    }
});
