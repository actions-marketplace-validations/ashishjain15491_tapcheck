import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { closeBrowser, type Run } from '../src/browser.ts';
import { check } from '../src/config.ts';
import { loadFlows, runFlow } from '../src/flow.ts';
import type { Finding } from '../src/report.ts';
import { start } from '../src/stub.ts';

const tmp = mkdtempSync(`${tmpdir()}/tapcheck-flow-`);

// A page with a form and a broken button, and just enough of Mailpit's API for t.mail.
const PAGE = `<!doctype html><html lang="en"><title>Ask</title><body><h1>Ask us</h1>
    <label for="q">Your question</label><input id="q" name="q">
    <button onclick="console.error('save failed: no handler')">Save</button>
    <button id="rates" onclick="fetch('https://rates.example.com/v1/latest').then((r) => r.json()).then((j) => { document.title = 'rate ' + j.eur; })">Rates</button></body></html>`;
const MAIL = { ID: 'm1', Subject: 'Confirm your address', From: { Address: 'shop@example.com' }, To: [{ Address: 'ada@example.com' }], Text: 'Confirm',
    HTML: '<a href="http://shop.test/confirm?a=1&amp;b=2">Confirm</a> <a href="http://shop.test/confirm?a=1&amp;b=2">again</a>' };

test('flows: loaded from globs, run end to end with passing and failing steps, the stub and mail', async () => {
    const asked: string[] = [];
    const server = createServer((req, res) => {
        const u = new URL(req.url!, 'http://x');
        if (!u.pathname.startsWith('/api/v1/')) { res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE); return; }
        asked.push(`${req.method} ${u.pathname}${u.search}`);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(u.pathname.endsWith('/search') ? { messages: asked.length > 1 ? [MAIL] : [] } : MAIL));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const stub = await start({ port: 0, rules: [{ host: 'rates.example.com', path: '/v1/*', status: 200, json: { eur: 0.9 }, headers: { 'access-control-allow-origin': '*' }, delayMs: 0 }] }, tmp);
    after(async () => { await closeBrowser(); server.close(); await stub.stop(); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    writeFileSync(`${tmp}/ask.flow.ts`, `import type { Flow } from 'tapcheck';
export default {
    name: 'Ask a question',
    run: async (t) => {
        const page = await t.goto('/ask');
        await t.step('the question field takes text', async () => {
            await page.getByLabel('Your question').fill('roses');
            t.expect(await page.getByLabel('Your question').inputValue() === 'roses', 'the field is empty');
            return 'typed roses';
        });
        await t.step('saving shows a confirmation', async () => {
            await page.getByRole('button', { name: 'Save' }).click();
            t.expect(await page.getByText('Saved').count(), 'no "Saved" message after Save');
        });
        await t.step('outside requests go to the stub', async () => {
            await t.routeOutside(page.context());
            await t.stub.fail({ host: 'rates.example.com', times: 1 });
            t.expect((await fetch(process.env.FLOW_TEST_STUB + '/rates.example.com/v1/latest')).status === 500, 'the fail switch did nothing');
            await page.locator('#rates').click();
            await page.waitForFunction(() => document.title === 'rate 0.9');
            const seen = await t.stub.requests({ host: 'rates.example.com' });
            t.expect(seen.length === 2 && seen[1].path === '/v1/latest', 'the stub saw ' + JSON.stringify(seen.map((s) => s.path)));
            await t.stub.clear();
            t.expect((await t.stub.requests()).length === 0, 'clear() left requests');
        });
        await t.step('the confirmation email arrives', async () => {
            const mail = await t.mail.waitFor({ to: 'ada@example.com', subject: 'Confirm' });
            t.expect(mail.subject === 'Confirm your address' && mail.from === 'shop@example.com' && mail.to[0] === 'ada@example.com' && mail.text === 'Confirm', JSON.stringify(mail));
            t.expect(mail.links.length === 1 && mail.links[0] === 'http://shop.test/confirm?a=1&b=2', 'links: ' + mail.links);
            await t.mail.clear();
        });
        await t.step('signed out is its own page', async () => { t.expect((await t.page({ auth: false })) !== page, 'the same page came back'); });
    },
} satisfies Flow;
`);
    writeFileSync(`${tmp}/crash.flow.js`, "export default { name: 'Crash', side: 'staff', run: async (t) => { await t.step('before', async () => {}); t.stub; } };\n");
    const cfg = check({ baseUrl: base, sides: { customer: {}, staff: {} }, viewports: [{ name: 'desktop', width: 800, height: 600 }], flows: ['*.flow.ts', '*.flow.*'], mail: { mailpit: base } }, tmp);
    const flows = await loadFlows(cfg);
    assert.deepEqual(flows.map((f) => [f.part, f.side]), [['flow-ask-a-question', 'customer'], ['flow-crash', 'staff']]);

    const found: Omit<Finding, 'side'>[] = [];
    const r: Run = { cfg, side: cfg.sides[0], dir: tmp, record: (f) => { found.push(f); }, crawl: { pages: [], hits: [], done: false } };
    process.env.FLOW_TEST_STUB = stub.url;
    await runFlow(flows[0], r, stub.url);
    assert.deepEqual(found.map((f) => [f.suite, f.where, f.check, f.status]), [
        ['flow-ask-a-question', 'Ask a question', 'the question field takes text', 'pass'],
        ['flow-ask-a-question', 'Ask a question', 'saving shows a confirmation', 'fail'],
        ['flow-ask-a-question', 'Ask a question', 'outside requests go to the stub', 'pass'], // it carried on after the failed step
        ['flow-ask-a-question', 'Ask a question', 'the confirmation email arrives', 'pass'],
        ['flow-ask-a-question', 'Ask a question', 'signed out is its own page', 'pass'],
    ], JSON.stringify(found, null, 1));
    assert.equal(found[0].detail, 'typed roses');
    assert.equal(found[1].detail, 'no "Saved" message after Save · console: save failed: no handler');
    assert.deepEqual(found[1].evidence, [`${tmp}/shots/flow-ask-a-question-saving_shows_a_confirmation.png`]);
    assert.ok(existsSync(found[1].evidence![0]));
    assert.deepEqual(asked, ['GET /api/v1/search?query=to%3A%22ada%40example.com%22%20subject%3A%22Confirm%22', 'GET /api/v1/search?query=to%3A%22ada%40example.com%22%20subject%3A%22Confirm%22',
        'GET /api/v1/message/m1', 'DELETE /api/v1/messages']); // it waited for the mail to arrive

    // Outside a step, what a flow throws is the caller's; t.stub and t.mail say which config they need.
    await assert.rejects(runFlow(flows[1], r), /This flow uses t\.stub, but tapcheck\.yml has no stub\./);
    assert.equal(found.at(-1)!.check, 'before');

    // Loading: what a flow file must export, a known side, no two flows with one name, a glob that matches something.
    const bad = async (file: string, text: string, re: RegExp) => {
        writeFileSync(`${tmp}/${file}`, text);
        await assert.rejects(loadFlows(check({ baseUrl: base, flows: file }, tmp)), re);
    };
    await bad('bad1.mjs', 'export default { name: "x" };', /bad1\.mjs: a flow file needs `export default \{ name, side\?, run/);
    await bad('bad2.mjs', 'export default { name: "x", side: "admin", run: async () => {} };', /bad2\.mjs: side "admin" isn't in sides \(public\)/);
    await assert.rejects(loadFlows(check({ baseUrl: base, flows: ['ask.flow.ts', 'same.mjs'] }, tmp)), /flows: "same\.mjs" matches no file/);
    writeFileSync(`${tmp}/same.mjs`, 'export default { name: "ask A question", run: async () => {} };');
    await assert.rejects(loadFlows(check({ baseUrl: base, flows: ['ask.flow.ts', 'same.mjs'] }, tmp)), /same\.mjs: another flow is already called "ask A question" \(part flow-ask-a-question\)/);
});
