import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, test } from 'node:test';
import { closeBrowser, routedMethod, type Run } from '../src/browser.ts';
import { check } from '../src/config.ts';
import { loadFlows, runFlow } from '../src/flow.ts';
import * as jev from '../src/jev.ts';
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
        if (req.method === 'DELETE') { res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'); return; } // as Mailpit does
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(u.pathname.endsWith('/search') ? { messages: asked.length > 1 ? [MAIL] : [], messages_count: 3 }
            : u.pathname.endsWith('/headers') ? { 'List-Unsubscribe': ['<mailto:off@shop.test>'] } : MAIL));
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
            t.expect(mail.id === 'm1' && mail.headers['List-Unsubscribe'][0] === '<mailto:off@shop.test>', 'id and headers: ' + JSON.stringify([mail.id, mail.headers]));
            t.expect((await t.mail.count({ to: 'ada@example.com' })) === 3, 'count');
            const all = await t.mail.all({ subject: 'Confirm', limit: 1 });
            t.expect(all.length === 1 && all[0].id === 'm1', 'all: ' + all.length);
            const err = await t.mail.all({ limit: 0 }).catch((e) => e.message);
            t.expect(/limit must be a whole number from 1 to 500/.test(err), String(err));
            await t.mail.clear();
        });
        await t.step('it works, with a caveat', async () => ({ warn: 'no way to undo it on screen' }));
        await t.step('signed out is its own page', async () => { t.expect((await t.page({ auth: false })) !== page, 'the same page came back'); });
        await t.step('a named viewport is its own page, and the current one', async () => {
            const phone = await t.page({ viewport: 'phone' });
            t.expect(phone !== page && phone.viewportSize().width === 390 && (await t.page({ viewport: 'phone' })) === phone, 'not one kept page at 390 px');
            t.expect((await t.goto('/ask')) === phone && (await t.page()) === page, 'goto() did not drive the page handed out last');
            const err = await t.page({ viewport: 'tv' }).catch((e) => e.message);
            t.expect(err === 't.page: no viewport is called "tv" (viewports: desktop, phone).', String(err));
        });
        t.note('slow answer', 'took 3 s');
        t.note('refunds', 'skipped: billing is off', 'info');
    },
} satisfies Flow;
`);
    writeFileSync(`${tmp}/crash.flow.js`, "export default { name: 'Crash', side: 'staff', run: async (t) => { await t.step('before', async () => {}); t.stub; } };\n");
    const cfg = check({ baseUrl: base, sides: { customer: {}, staff: {} }, viewports: [{ name: 'desktop', width: 800, height: 600 }, { name: 'phone', width: 390, height: 844, mobile: true }], flows: ['*.flow.ts', '*.flow.*'], mail: { mailpit: base } }, tmp);
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
        ['flow-ask-a-question', 'Ask a question', 'it works, with a caveat', 'warn'],
        ['flow-ask-a-question', 'Ask a question', 'signed out is its own page', 'pass'],
        ['flow-ask-a-question', 'Ask a question', 'a named viewport is its own page, and the current one', 'pass'],
        ['flow-ask-a-question', 'Ask a question', 'slow answer', 'warn'],
        ['flow-ask-a-question', 'Ask a question', 'refunds', 'info'],
    ], JSON.stringify(found, null, 1));
    assert.equal(found[0].detail, 'typed roses');
    assert.equal(found[1].detail, 'no "Saved" message after Save · console: save failed: no handler');
    assert.deepEqual(found[1].evidence, [`${tmp}/shots/flow-ask-a-question-001-saving_shows_a_confirmation.png`]); // numbered: long names can't overwrite each other
    assert.ok(existsSync(found[1].evidence![0]));
    assert.equal(found.find((f) => f.status === 'warn')!.detail, 'no way to undo it on screen');
    const q = 'query=to%3A%22ada%40example.com%22%20subject%3A%22Confirm%22';
    assert.deepEqual(asked, [`GET /api/v1/search?limit=1&${q}`, `GET /api/v1/search?limit=1&${q}`, 'GET /api/v1/message/m1', 'GET /api/v1/message/m1/headers', // it waited for the mail to arrive
        'GET /api/v1/search?limit=1&query=to%3A%22ada%40example.com%22', 'GET /api/v1/search?limit=1&query=subject%3A%22Confirm%22', 'GET /api/v1/message/m1', 'GET /api/v1/message/m1/headers',
        'DELETE /api/v1/messages']);

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

test('flows: one that never settles fails at its timeout, a bad timeout is refused', async () => {
    const dir = mkdtempSync(`${tmpdir()}/tapcheck-flow-timeout-`);
    writeFileSync(`${dir}/hang.flow.js`, "export default { name: 'Hang', timeout: 0.2, run: () => new Promise(() => {}) };\n");
    const cfg = check({ baseUrl: 'http://127.0.0.1:1', flows: ['hang.flow.js'] }, dir);
    const [flow] = await loadFlows(cfg);
    const r = { cfg, side: cfg.sides[0], dir, record: () => {}, crawl: { pages: [], hits: [], done: false } } as unknown as Run;
    await assert.rejects(runFlow(flow, r), /didn't finish within 0.2 s/);

    // Past its timeout a flow's findings are dropped, t.signal is aborted, and its cleanups run.
    const seen: string[] = [];
    const g = globalThis as { cleaned?: boolean; aborted?: boolean };
    writeFileSync(`${dir}/late.flow.js`, `export default { name: 'Late', timeout: 0.2, run: async (t) => {
        t.cleanup(async () => { await new Promise((done) => setTimeout(done, 400)); await t.step('put back', async () => {}); globalThis.cleaned = true; }); // t.* still works in a cleanup, the abandoned run()'s doesn't meanwhile
        t.note('before', 'in time', 'info');
        await new Promise((done) => setTimeout(done, 400));
        globalThis.aborted = t.signal.aborted;
        globalThis.mailErr = await t.mail.count().then(() => 'answered', (e) => String(e));
        try { t.reach('GET', '/late'); } catch {}
        t.note('after', 'too late', 'fail');
        await t.step('late step', async () => {});
    } };\n`);
    const lateCfg = check({ baseUrl: 'http://127.0.0.1:1', flows: ['late.flow.js'], mail: { mailpit: 'http://127.0.0.1:1' } }, dir);
    const [late] = await loadFlows(lateCfg);
    const rl = { ...r, cfg: lateCfg, record: (f: Finding) => seen.push(f.check) } as unknown as Run;
    await assert.rejects(runFlow(late, rl), /didn't finish within 0.2 s/);
    assert.equal(g.cleaned, true, 'the cleanup ran at the timeout');
    assert.equal(g.aborted, true);
    assert.match(String((g as { mailErr?: string }).mailErr), /didn't finish within 0.2 s/); // stopped by the timeout, never sent
    assert.equal((rl as { reached?: unknown[] }).reached, undefined);
    assert.deepEqual(seen, ['before', 'put back']); // nothing the abandoned run() did after the timeout
    writeFileSync(`${dir}/bad.flow.js`, "export default { name: 'Bad', timeout: 'soon', run: async () => {} };\n");
    await assert.rejects(loadFlows(check({ baseUrl: 'http://127.0.0.1:1', flows: ['bad.flow.js'] }, dir)), /timeout must be a number of seconds/);
});

test('flows: t.ask asks Jev about text, t.reach counts a request, a Jev outage is a warning, t.note can fail', async () => {
    const dir = mkdtempSync(`${tmpdir()}/tapcheck-flow-ask-`);
    writeFileSync(`${dir}/ask.flow.js`, `import { noul } from '${resolve('src/flow.ts')}';
export default { name: 'Ask', run: async (t) => {
    await t.ask('the diff', { diff: 'adds a guard' }, { risky: noul('Is \`diff\` risky?') });
    t.reach('post', '/api/things?x=1');
    t.reach('DELETE', '/api/things', 404); // refused or not found: not counted
    t.reach('GET', 'https://api.stripe.com/v1/charges'); // not the app's host: not counted
    await t.ask('down', { x: 1 }, { ok: noul('Is it fine?') });
    t.note('own check', 'went wrong', 'fail');
    t.expect(t.dir === '${dir}', 'dir');
} };\n`);
    const cfg = check({ baseUrl: 'http://127.0.0.1:1', flows: ['ask.flow.js'] }, dir);
    const [flow] = await loadFlows(cfg);
    const found: Finding[] = [];
    const r = { cfg, side: cfg.sides[0], dir, record: (f: Finding) => found.push(f), crawl: { pages: [], hits: [], done: false }, part: flow.part } as unknown as Run;
    let n = 0;
    jev.setup(cfg.jev, { systemOne: async (req) => {
        if ('ok' in req.questions) throw new Error('503 from Jev');
        n++;
        return { answers: { risky: { noul: 0.9 } }, usage: { input_tokens: 10 } };
    } });
    const off = process.env.JEV; delete process.env.JEV;
    try { await runFlow(flow, r); } finally { if (off !== undefined) process.env.JEV = off; }
    assert.equal(n, 1);
    assert.deepEqual(found.map((f) => [f.where, f.check, f.status]), [
        ['Ask › the diff', 'jev: risky', 'pass'],
        ['Ask › down', "Jev's look", 'warn'],
        ['Ask', 'own check', 'fail'],
    ]);
    assert.match(found[1].detail!, /503 from Jev/);
    assert.deepEqual(r.reached, [{ part: flow.part, what: 'POST /api/things' }]);
});

test('flows: t.use makes a page current again, a timeout closes the pages before the cleanups', async () => {
    const server = createServer((req, res) => req.url === '/private' ? res.writeHead(302, { location: '/login' }).end()
        : res.writeHead(200, { 'content-type': 'text/html' }).end(`<title>${req.url}</title><h1>${req.url}</h1>
            <form method="post" action="/things/7"><input type="hidden" name="_method" value="DELETE"><button>Delete</button></form>`));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    after(async () => { await closeBrowser(); server.close(); });
    const dir = mkdtempSync(`${tmpdir()}/tapcheck-flow-use-`);
    writeFileSync(`${dir}/use.flow.js`, `export default { name: 'Use', side: 'public', timeout: 8, run: async (t) => {
        const first = await t.goto('/first');
        const second = await t.page({ fresh: true }); // a second visitor: now the current page
        t.expect((await t.goto('/second')) === second, 'goto went to the first page');
        t.expect(t.use(first) === first && (await t.goto('/again')) === first, 'use() did not make the first page current');
        await Promise.all([first.waitForResponse(/things/), first.getByRole('button', { name: 'Delete' }).click()]); // reached as DELETE /things/7
        const out = await t.page({ auth: false });
        const [tab] = await Promise.all([out.context().waitForEvent('page'), out.evaluate(() => window.open('/ask'))]);
        t.use(tab); await t.goto('/private'); // signed out: a tab sent to sign in isn't an ended session
        t.use(first);
        await t.step('fails on the first page', async () => { throw new Error('no'); });
        t.cleanup(async () => { const p = await t.page(); globalThis.useSeen = { closed: first.isClosed() && second.isClosed(), fresh: !p.isClosed() && p !== first }; });
        await new Promise((done) => setTimeout(done, 10000));
    } };\n`);
    const cfg = check({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, flows: ['use.flow.js'],
        sides: { public: { login: { form: { url: '/login', fields: { '#e': 'a' } } } } } }, dir);
    const [flow] = await loadFlows(cfg);
    const found: Finding[] = [];
    const r = { cfg, side: cfg.sides[0], dir, record: (f: Finding) => found.push(f), crawl: { pages: [], hits: [], done: false }, part: flow.part } as unknown as Run;
    await assert.rejects(runFlow(flow, r), /didn't finish within 8 s/);
    assert.deepEqual(found.map((f) => [f.check, f.status]), [['fails on the first page', 'fail']], JSON.stringify(found));
    assert.ok(r.reached?.some((x) => x.what === 'DELETE /things/7'), JSON.stringify(r.reached));
    assert.ok(found[0].evidence?.[0] && existsSync(found[0].evidence[0]), 'the failed step has a screenshot');
    assert.deepEqual((globalThis as { useSeen?: unknown }).useSeen, { closed: true, fresh: true });
});

test('flows: a form POST that says _method is reached as that method', () => {
    const q = (method: string, body: string | null, headers: Record<string, string> = {}, url = 'http://a.test/x') => ({ method: () => method, url: () => url, postData: () => body, headers: () => headers });
    assert.equal(routedMethod(q('POST', '_token=x&_method=PATCH&name=a')), 'PATCH');
    assert.equal(routedMethod(q('POST', '--b\r\nContent-Disposition: form-data; name="_method"\r\n\r\ndelete\r\n--b--')), 'DELETE');
    assert.equal(routedMethod(q('POST', '{"_method":"PUT","a":1}')), 'PUT');
    assert.equal(routedMethod(q('POST', null, { 'x-http-method-override': 'PUT' })), 'PUT');
    assert.equal(routedMethod(q('POST', '_method=GET')), 'POST'); // only PUT, PATCH and DELETE are spoofed
    assert.equal(routedMethod(q('POST', 'note=_method=PATCH')), 'POST'); // a value that only mentions it
    assert.equal(routedMethod(q('GET', '_method=DELETE')), 'GET');
    assert.equal(routedMethod(q('POST', '', {}, 'http://a.test/x?_method=PATCH')), 'PATCH');
});
