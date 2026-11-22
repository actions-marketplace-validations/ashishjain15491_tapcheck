import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { closeBrowser, context, launchOptions, recordings, startDelay, type Run } from '../src/browser.ts';
import { check } from '../src/config.ts';
import { T } from '../src/flow.ts';
import { setup, type Client } from '../src/jev.ts';
import { write, type Finding } from '../src/report.ts';

const tmp = mkdtempSync(`${tmpdir()}/tapcheck-record-`);
const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html lang="en"><title>Shop</title><h1>Shop</h1><a href="/b">More</a>'); });
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
after(async () => { await closeBrowser(); server.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const cfg = check({ baseUrl: base, viewports: [{ name: 'desktop', width: 800, height: 600 }], mail: { mailpit: base } }, tmp);
const found: Omit<Finding, 'side'>[] = [];
const r: Run = { cfg, side: cfg.sides[0], dir: tmp, record: (f) => { found.push(f); }, crawl: { pages: [], hits: [], done: false }, part: 'flow-look' };

// A fake Jev: every yes-or-no question gets P[key], or 0.9. Nothing reaches the network.
const P: Record<string, number> = { error_shown: 0.1, overlap: 0.5, clipped: 0.9, raw_key: 0.1, misaligned: 0.1, unfilled_placeholder: 0.9 };
const asked: { state: any; questions: Record<string, unknown> }[] = [];
const fake: Client = { systemOne: async (req) => { asked.push(req); return { answers: Object.fromEntries(Object.keys(req.questions).map((k) => [k, { noul: P[k] ?? 0.9 }])), usage: { input_tokens: 100 } }; } };

test('HEADED, SLOWMO and START_DELAY decide how the browser starts', () => {
    assert.deepEqual(launchOptions({}), { headless: true, slowMo: 0 });
    assert.deepEqual(launchOptions({ HEADED: '1', SLOWMO: '150' }), { headless: false, slowMo: 150 });
    assert.deepEqual(launchOptions({}, ['--disable-features=LocalNetworkAccessChecks']), { headless: true, slowMo: 0, args: ['--disable-features=LocalNetworkAccessChecks'] }); // browser.args
    assert.deepEqual([startDelay({}), startDelay({ START_DELAY: '10' })], [0, 10]);
    assert.throws(() => launchOptions({ SLOWMO: 'slow' }), /SLOWMO must be a number, 0 or more \(got "slow"\)/);
    assert.throws(() => startDelay({ START_DELAY: '-1' }), /START_DELAY must be a number/);
});

test('RECORD=1: a context writes a video and a trace, the report links them, and what it reached is kept', async () => {
    process.env.RECORD = '1';
    const ctx = await context(r, cfg.viewports[0]).finally(() => { delete process.env.RECORD; });
    const page = await ctx.newPage();
    await page.goto(`${base}/a`);
    await ctx.close();
    assert.equal(recordings.length, 1);
    const { videos, trace } = recordings[0];
    assert.deepEqual([videos, trace], [[`${tmp}/videos/001-flow-look-desktop.webm`], `${tmp}/traces/001-flow-look-desktop.zip`]);
    assert.ok(statSync(videos[0]).size > 0 && statSync(trace!).size > 0);
    assert.deepEqual(r.reached, [{ part: 'flow-look', what: 'GET /a' }]);

    write(tmp, { base, started: Date.now(), recordings });
    const html = readFileSync(`${tmp}/report.html`, 'utf8');
    assert.match(html, /<a href="videos\/001-flow-look-desktop\.webm">video<\/a>/);
    assert.ok(html.includes(`<a href="traces/001-flow-look-desktop.zip">trace</a> <code>npx playwright show-trace ${trace}</code>`));
    assert.ok(readFileSync(`${tmp}/REPORT.md`, 'utf8').includes(`npx playwright show-trace ${trace}`));

    const plain = await context(r, cfg.viewports[0]); // without RECORD nothing is recorded
    await plain.close();
    assert.equal(recordings.length, 1);
});

test('t.jev and t.mail.judge: verdicts become findings of the flow; skipped with JEV=off', async () => {
    setup(cfg.jev, fake);
    const t = new T(r, { name: 'Look', side: 'public', part: 'flow-look', timeout: 60, run: async () => {} });
    found.length = 0;
    let a: Record<string, any> | null = null;
    await t.step('open the shop', async () => { await t.goto('/b'); a = await t.jev('home'); });
    assert.equal(a!.clipped.noul, 0.9);
    assert.deepEqual(found.map((f) => [f.where, f.check, f.status]), [
        ['Look › home', 'jev: loaded', 'pass'], ['Look › home', 'jev: error shown', 'pass'], ['Look › home', 'jev: overlap', 'warn'], // unsure is a warning
        ['Look › home', 'jev: clipped', 'fail'], ['Look › home', 'jev: raw key', 'pass'], ['Look › home', 'jev: misaligned', 'pass'],
        ['Look', 'open the shop', 'pass'],
    ]);
    assert.deepEqual(found[0].evidence, [`${tmp}/shots/flow-look-jev-home-1.png`]);
    assert.ok(existsSync(found[0].evidence![0]));
    assert.ok(r.reached!.some((h) => h.step === 'open the shop' && h.what === 'GET /b'), JSON.stringify(r.reached));

    // An email: its HTML drawn at two widths, the neutral email questions asked of both pictures.
    found.length = 0;
    await t.mail.judge({ subject: 'Welcome', html: '<h1>Hello {{first_name}}</h1><p><a href="http://shop.test/confirm">Confirm</a></p><script>document.body.innerHTML = "scripts ran"</script>' });
    const mail = asked.at(-1)!;
    assert.deepEqual(Object.keys(mail.questions), ['rendered', 'unfilled_placeholder', 'actions_visible', 'mobile_readable']);
    assert.deepEqual(Object.keys(mail.state), ['email_subject', 'screenshot', 'screenshot_mobile']);
    assert.deepEqual(found.map((f) => [f.where, f.check, f.status]), [['Look › email "Welcome"', 'jev: rendered', 'pass'], ['Look › email "Welcome"', 'jev: unfilled placeholder', 'fail'],
        ['Look › email "Welcome"', 'jev: actions visible', 'pass'], ['Look › email "Welcome"', 'jev: mobile readable', 'pass']]);
    assert.deepEqual(found[0].evidence, [`${tmp}/shots/flow-look-email-welcome.png`, `${tmp}/shots/flow-look-email-welcome-mobile.png`]);
    assert.ok(found[0].evidence!.every((f) => existsSync(f)));

    // A page that reloads itself while Jev looks at it is looked at again once it is back.
    await (await t.page()).evaluate(() => { setTimeout(() => location.reload(), 150); });
    assert.equal((await t.jev('reloading'))!.clipped.noul, 0.9);

    // JEV=off: nothing asked, one info finding each, null returned, and the flow carries on.
    process.env.JEV = 'off';
    found.length = 0;
    const calls = asked.length;
    try {
        assert.equal(await t.jev('home again'), null);
        assert.equal(await t.mail.judge({ subject: 'Welcome', html: '<p>Hi</p>' }), null);
    } finally { delete process.env.JEV; }
    assert.equal(asked.length, calls);
    assert.deepEqual(found.map((f) => [f.where, f.check, f.status, f.detail]), [['Look › home again', "Jev's look", 'info', 'skipped (JEV=off)'], ['Look › email "Welcome"', "Jev's look", 'info', 'skipped (JEV=off)']]);

    // The run's budget holds here too: once it is spent, a look is skipped, not failed.
    setup({ budget: 0.000001, headers: {} }, fake);
    await t.jev('first');
    found.length = 0;
    assert.equal(await t.jev('second'), null);
    assert.match(found[0].detail!, /^skipped \(Jev budget of \$0\.000001 reached/);
    await t.close();
});
