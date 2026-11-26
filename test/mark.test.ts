import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import type { Page } from 'playwright';
import { banners, closeBrowser, context, marked, open, type Run } from '../src/browser.ts';
import { check } from '../src/config.ts';
import { loadFlows, runFlow } from '../src/flow.ts';
import { build, select } from '../src/parts.ts';
import { findings, record, write, type Finding } from '../src/report.ts';
import * as a11y from '../src/suites/a11y.ts';
import * as audit from '../src/suites/audit.ts';
import * as crawl from '../src/suites/crawl.ts';
import * as interact from '../src/suites/interact.ts';

// A shop's cart: ten lines and their total below the first screen, and one of each thing a measured suite can point at.
const CART = `<!doctype html><html lang="en"><title>Cart</title><style>body { margin: 0; font: 16px sans-serif } .clip { width: 80px; overflow: hidden; white-space: nowrap }</style><body>
<h1>Your cart</h1>
<input name="coupon">
<img src="/missing.png" alt="A fern" width="40" height="40"> <img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" width="40" height="40">
<button>Nothing</button>
<p class="clip">A very long line of text that cannot fit in eighty pixels</p>
<div style="height: 700px"></div>
${Array.from({ length: 10 }, (_, i) => `<p class="line">Line ${i + 1}: 3.00</p>`).join('')}
<p>Total <b id="total">30.00</b></p>
</body></html>`;

process.env.JEV = 'off'; // nothing here asks Jev: marks need none
const tmp = mkdtempSync(`${tmpdir()}/tapcheck-mark-`);
const server = createServer((req, res) => {
    if (req.url === '/missing.png') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' }).end(CART);
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
after(async () => { await closeBrowser(); server.close(); });

const MARKED = /\/shots\/marked-\d{3}-[a-z0-9_]+\.png$/;
function run(extra: object = {}, more: Partial<Run> = {}) {
    const cfg = check({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, viewports: [{ name: 'desktop', width: 800, height: 600 }], ...extra }, tmp);
    const found: Omit<Finding, 'side'>[] = [];
    const r: Run = { cfg, side: cfg.sides[0], dir: tmp, record: (f) => { found.push(f); }, crawl: { pages: [], hits: [], done: false }, ...more };
    const at = (where: string, check: string) => found.find((f) => f.where === where && f.check === check)!;
    return { cfg, r, found, at };
}

/** The overlay as it is when the screenshot is taken (every piece's text, colour and place), and the banner put above it. */
function spy(page: Page) {
    const seen: { scrollY: number; vw: number; vh: number; banner: { text: string; bg: string; height: number }; parts: { text: string; bg: string; border: string; x: number; y: number; right: number; bottom: number }[] }[] = [];
    const proto = Object.getPrototypeOf(page), shoot = proto.screenshot;
    proto.screenshot = async function (this: Page, o: object) {
        const banner = await this.evaluate(() => { const b = document.getElementById('tapcheck-banner'); return b && { text: b.innerText, bg: b.style.backgroundColor, height: b.getBoundingClientRect().height }; });
        if (banner) { if (seen.length) seen[seen.length - 1].banner = banner; }
        else seen.push(await this.evaluate(() => ({ scrollY, vw: innerWidth, vh: innerHeight, banner: { text: '', bg: '', height: 0 }, parts: [...document.querySelectorAll<HTMLElement>('#tapcheck-marks > div')].map((d) => {
            const b = d.getBoundingClientRect();
            return { text: d.innerText, bg: d.style.backgroundColor, border: d.style.borderColor, x: b.left, y: b.top, right: b.right, bottom: b.bottom };
        }) })));
        return shoot.call(this, o);
    };
    after(() => { proto.screenshot = shoot; });
    return seen;
}

/** A PNG's width and height. */
const size = (file: string) => { const b = readFileSync(file); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

test('marked: a banner, a box, a marker and a note per target, at most eight, drawn and taken out again', async () => {
    const { cfg, r } = run();
    const ctx = await context(r, cfg.viewports[0]);
    const page = await ctx.newPage();
    await open(r, page, '/');
    const seen = spy(page);
    const file = await marked(r, page, 'cart total', { status: 'fail', title: 'the cart total equals the sum of the lines', detail: 'expected 30.00, shown 33.00' },
        [{ target: '.line', note: 'a line' }, { target: page.locator('#total'), note: 'the total', kind: 'setting' }, { target: { x: 10, y: 300, width: 50, height: 20 }, kind: 'question' }]);
    assert.match(file!, MARKED);
    assert.ok(existsSync(file!));

    const [shot] = seen, RED = 'rgb(220, 38, 38)', BLUE = 'rgb(37, 99, 235)', AMBER = 'rgb(180, 83, 9)';
    assert.ok(shot.scrollY > 0, 'the first target is below the first screen: it is scrolled into view');
    const boxes = shot.parts.filter((p) => !p.text), notes = shot.parts.filter((p) => /^\d+ \D/.test(p.text)), dots = shot.parts.filter((p) => /^\d+$/.test(p.text));
    // Twelve targets (ten lines, the total, the plain box): eight are drawn, the banner counts the rest. It goes above the
    // screenshot, so it covers none of the page.
    assert.equal(shot.banner.text, 'FAIL: the cart total equals the sum of the lines (+4 more)\nexpected 30.00, shown 33.00');
    assert.equal(shot.banner.bg, RED);
    assert.deepEqual(size(file!), [shot.vw, shot.vh + Math.round(shot.banner.height)]);
    // No marker or note covers another, though the ten lines are close together.
    const labels = [...dots, ...notes];
    for (const a of labels) for (const b of labels) assert.ok(a === b || a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y, `${a.text} and ${b.text} overlap`);
    assert.deepEqual([boxes.length, dots.length, notes.length], [8, 8, 8]);
    assert.deepEqual(dots.map((d) => d.text), ['1', '2', '3', '4', '5', '6', '7', '8']);
    assert.deepEqual(notes.map((n) => n.text), Array.from({ length: 8 }, (_, i) => `${i + 1} a line`));
    assert.ok(boxes.every((b) => b.border === RED), 'a mark without a kind takes the status\'s colour');
    for (const p of shot.parts) assert.ok(p.x >= 0 && p.y >= 0 && p.right <= shot.vw && p.bottom <= shot.vh, `inside the window: ${JSON.stringify(p)}`);

    // Nothing is left on the page, and it is where it was.
    assert.deepEqual(await page.evaluate(() => [document.querySelectorAll('#tapcheck-marks, [data-tapcheck-m0], [data-tapcheck-m1]').length, scrollY]), [0, 0]);

    // A mark's own kind colours it; a selector that matches nothing is no box.
    await marked(r, page, 'kinds', { status: 'pass', title: 'kinds' }, [{ target: 'h1', note: 'the heading', kind: 'setting' }, { target: { x: 10, y: 300, width: 50, height: 20 }, note: 'ask', kind: 'question' }, { target: '.gone' }]);
    assert.equal(seen[1].banner.text, 'PASS: kinds');

    // Small targets close together, as the icons in a table's rows: no marker or note covers another, or another target.
    const tight = [0, 1, 2].flatMap((row) => [0, 1].map((col) => ({ x: 200 + col * 20, y: 200 + row * 30, width: 14, height: 14 })));
    await marked(r, page, 'tight', { status: 'fail', title: 'targets at least 24 px' }, tight.map((b) => ({ target: b, note: `${b.width}×${b.height} px` })));
    const drawn = seen[2].parts.filter((p) => p.text);
    assert.equal(drawn.length, 12);
    for (const a of drawn) {
        for (const b of drawn) assert.ok(a === b || a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y, `${a.text} and ${b.text} overlap`);
        if (/ /.test(a.text)) for (const t of tight) assert.ok(a.right <= t.x || t.x + t.width <= a.x || a.bottom <= t.y || t.y + t.height <= a.y, `note ${a.text} covers a target`);
    }
    assert.deepEqual(seen[1].parts.filter((p) => !p.text).map((p) => p.border), [BLUE, AMBER]);
    await ctx.close();
});

test('marks in the measured suites: a failing or warning check that knows its elements opens its evidence with them boxed', async () => {
    const on = run({ marks: true });
    await crawl.run(on.r);
    await interact.run(on.r);
    await a11y.run(on.r);
    await audit.run(on.r);
    const first = (where: string, check: string) => { const f = on.at(where, check); assert.ok(f, `${check} @ ${where}`); return `${f.status} ${MARKED.test(f.evidence?.[0] ?? '') && existsSync(f.evidence![0]) ? 'marked' : 'plain'}`; };
    assert.equal(first('/', 'form fields labelled'), 'fail marked');
    assert.equal(first('/', 'images load'), 'fail marked');
    assert.equal(first('/', 'every control does something'), 'warn marked');
    assert.equal(first('/', 'clicks set off no 5xx'), 'pass plain');
    assert.equal(first('Home · desktop', 'axe: no critical violations'), 'fail marked'); // the field without a label
    assert.equal(first('Home · desktop', 'text is not cut off'), 'fail marked');
    assert.equal(first('Home · desktop', 'images have alt text'), 'fail marked');
    assert.equal(first('Home · desktop', 'controls do not overlap'), 'pass plain');
    // The plain screenshot stays, after the marked one; a failing check that can't say where has only that.
    assert.match(on.at('Home · desktop', 'text is not cut off').evidence![1], /shots\/audit-home_desktop\.png$/);
    assert.equal(on.at('Home · desktop', 'text is not cut off').evidence!.length, 2);
    assert.ok(on.found.every((f) => f.status === 'fail' || f.status === 'warn' || !f.evidence?.some((e) => MARKED.test(e))), 'only fails and warnings are marked');

    // Off (the default): the same findings, and no marked screenshot anywhere.
    const off = run();
    assert.equal(off.cfg.marks, false);
    await crawl.run(off.r);
    const plain = (l: Omit<Finding, 'side'>[]) => l.filter((f) => !/^loads under|crawl coverage/.test(f.check)).map((f) => [f.suite, f.where, f.check, f.status, f.check === 'page answers' ? '' : f.detail]);
    assert.deepEqual(plain(off.found), plain(on.found.filter((f) => f.suite === 'crawl')));
    assert.deepEqual(off.found.flatMap((f) => f.evidence ?? []).filter((e) => MARKED.test(e)), []);
});

test('MARK=1 and MARK=0 override marks; marks must be true or false', () => {
    const cfg = (raw: object) => check({ baseUrl: 'http://127.0.0.1:1', ...raw }).marks;
    try {
        process.env.MARK = '1';
        assert.equal(cfg({}), true);
        process.env.MARK = '0';
        assert.equal(cfg({ marks: true }), false);
    } finally { delete process.env.MARK; }
    assert.equal(cfg({ marks: true }), true);
    assert.throws(() => cfg({ marks: 'yes' }), /tapcheck\.yml: marks must be true or false/);
});

test('t.mark, t.untested and verify flows: marked evidence, the verify tag, and the report opens with Release verification', async () => {
    const flow = (file: string, body: string) => writeFileSync(`${tmp}/${file}`, `export default ${body};\n`);
    flow('cart.verify.mjs', `{ name: 'Cart total', item: 'The cart total always equals the sum of the lines', run: async (t) => {
        const page = await t.goto('/');
        await t.mark('the total equals the sum of the lines', 'pass', [{ target: '#total', note: 'total 30.00' }, { target: page.locator('.line').first(), note: 'a line', kind: 'setting' }], 'expected 30.00, shown 30.00');
        await t.mark('is the total meant to leave out tax?', 'warn', [{ target: '#total', note: 'no tax line' }]);
    } }`);
    flow('history.verify.mjs', `{ name: 'Order history', item: 'The order history paginates 20 per page', run: async (t) => {
        await t.goto('/');
        await t.step('the history opens', async () => {});
        await t.mark('20 orders on a page', 'fail', [{ target: '.line', note: 'an order' }], 'expected 20 rows, found 10 | all on one page');
    } }`);
    flow('refund.verify.mjs', `{ name: 'Refund email', item: 'Refund emails say the amount', run: async (t) => { t.untested('needs a paid order, and this environment has none'); } }`);
    flow('plain.flow.mjs', `{ name: 'Plain', run: async (t) => {
        await t.goto('/');
        await t.mark('the heading is there', 'pass', [{ target: 'h1' }]);
        await t.mark('the coupon field has no label', 'fail', [{ target: '[name=coupon]', note: 'no label' }]);
        await t.step('the cart has a checkout button', async () => { t.expect(false, 'no checkout button'); });
    } }`);
    await assert.rejects(loadFlows(check({ baseUrl: 'http://127.0.0.1:1', flows: 'bad.mjs' }, (writeFileSync(`${tmp}/bad.mjs`, 'export default { name: "x", item: "", run: async () => {} };'), tmp))), /bad\.mjs: item must be the release item/);

    const { cfg, r } = run({ marks: true, flows: ['*.verify.mjs', 'plain.flow.mjs'] });
    const flows = await loadFlows(cfg);
    assert.deepEqual(flows.map((f) => [f.part, f.item]), [['flow-cart-total', 'The cart total always equals the sum of the lines'], ['flow-order-history', 'The order history paginates 20 per page'],
        ['flow-refund-email', 'Refund emails say the amount'], ['flow-plain', undefined]]);
    // ONLY=verify is the flows with an item.
    const parts = build(['public'], { flows });
    assert.deepEqual(select(parts, ['verify'], []).map((p) => p.name), ['flow-cart-total', 'flow-order-history', 'flow-refund-email']);
    assert.deepEqual(parts.find((p) => p.name === 'flow-plain')!.tags, ['flow', 'public', 'measured']);
    assert.throws(() => check({ baseUrl: 'http://127.0.0.1:1', sides: { verify: {} } }), /sides\.verify name can't be a suite or tag name/);

    findings.length = 0;
    r.record = (f) => record({ ...f, side: 'public' });
    for (const f of flows) await runFlow(f, r);
    const at = (check: string) => findings.find((f) => f.check === check)!;
    const drawn = (check: string) => MARKED.test(at(check).evidence?.[0] ?? '') && existsSync(at(check).evidence![0]);
    assert.deepEqual(findings.map((f) => [f.suite, f.check, f.status, f.item?.slice(0, 10)]), [
        ['flow-cart-total', 'the total equals the sum of the lines', 'pass', 'The cart t'], ['flow-cart-total', 'is the total meant to leave out tax?', 'warn', 'The cart t'],
        ['flow-order-history', 'the history opens', 'pass', 'The order '], ['flow-order-history', '20 orders on a page', 'fail', 'The order '],
        ['flow-refund-email', 'not tested', 'info', 'Refund ema'],
        ['flow-plain', 'the heading is there', 'pass', undefined], ['flow-plain', 'the coupon field has no label', 'fail', undefined], ['flow-plain', 'the cart has a checkout button', 'fail', undefined]]);
    // A verify flow's pass is drawn; a pass of another flow only on a run that ONLY or CHANGED scoped; a failure always.
    assert.deepEqual(['the total equals the sum of the lines', 'is the total meant to leave out tax?', '20 orders on a page', 'the heading is there', 'the coupon field has no label'].map(drawn), [true, true, true, false, true]);
    assert.equal(at('the heading is there').evidence, undefined);
    findings.length = 5;
    await runFlow(flows[3], { ...r, scoped: true });
    assert.equal(drawn('the heading is there'), true);
    // A failed step has a plain screenshot: with marks on it gets the banner, no box, put first.
    const step = at('the cart has a checkout button');
    assert.equal(step.evidence!.length, 1);
    await banners(r, findings);
    assert.match(step.evidence![0], MARKED);
    assert.match(step.evidence![1], /shots\/flow-plain-001-/);
    assert.equal(at('20 orders on a page').evidence!.length, 1, 'a finding with a marked screenshot gets no second one');

    // Without marks on, t.mark is a finding with a status and nothing else: no screenshot, no Jev.
    const off = run({ flows: 'plain.flow.mjs' }, { scoped: true });
    await runFlow((await loadFlows(off.cfg))[0], off.r);
    assert.deepEqual(off.found.slice(0, 2).map((f) => [f.check, f.status, f.evidence]), [['the heading is there', 'pass', undefined], ['the coupon field has no label', 'fail', undefined]]);

    // The reports open with the release: the count, the failed item with its steps and screenshot, the passed table, the questions, what wasn't tested.
    write(tmp, { base: cfg.baseUrl, started: Date.now() });
    const md = readFileSync(`${tmp}/REPORT.md`, 'utf8'), html = readFileSync(`${tmp}/report.html`, 'utf8'), rel = (e: string) => e.slice(tmp.length + 1);
    assert.ok(md.indexOf('## Release verification\n\n1 passed · 1 failed · 1 question · 1 not tested\n') < md.indexOf('| Suite | Failing |'));
    assert.ok(md.includes(`### Failed\n\n**The order history paginates 20 per page**\n\n1. pass · the history opens\n2. fail · 20 orders on a page: expected 20 rows, found 10 | all on one page\n\n![evidence](${rel(at('20 orders on a page').evidence![0])})\n`), md);
    assert.ok(md.includes(`### Passed\n\n| Release item | What was checked | Evidence |\n|---|---|---|\n| The cart total always equals the sum of the lines | the total equals the sum of the lines: expected 30.00, shown 30.00 | ${rel(at('the total equals the sum of the lines').evidence![0])} |\n`), md);
    assert.ok(md.includes(`### Questions for the team\n\n- **The cart total always equals the sum of the lines** · is the total meant to leave out tax? (${rel(at('is the total meant to leave out tax?').evidence![0])})\n`), md);
    assert.ok(md.includes('### Not tested\n\n| Release item | Why not |\n|---|---|\n| Refund emails say the amount | needs a paid order, and this environment has none |\n'), md);
    const order = ['<h2>Release verification</h2><p class="meta">1 passed · 1 failed · 1 question · 1 not tested</p>', '<h3>Failed</h3><h4>The order history paginates 20 per page</h4>', '<h3>Passed</h3>',
        '<h3>Questions for the team</h3>', '<h3>Not tested</h3>', '<h2>Every check</h2>', '<div class="cards">'].map((x) => html.indexOf(x));
    assert.ok(order.every((n, i) => n > 0 && (i === 0 || n > order[i - 1])), `the sections, in order: ${order}`);
    assert.equal(JSON.parse(readFileSync(`${tmp}/findings.json`, 'utf8'))[0].item, 'The cart total always equals the sum of the lines'); // a flat list still, with the item on a verify flow's findings

    // A run with no verify flow has no such section.
    findings.length = 0;
    record({ suite: 'crawl', side: 'public', where: '/', check: 'page answers', status: 'pass' });
    write(tmp, { base: cfg.baseUrl, started: Date.now() });
    assert.ok(!readFileSync(`${tmp}/REPORT.md`, 'utf8').includes('Release verification') && !readFileSync(`${tmp}/report.html`, 'utf8').includes('Release verification'));
});
