import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { closeBrowser, type Run } from '../src/browser.ts';
import { check } from '../src/config.ts';
import { looked, scoreStatus, setup } from '../src/jev.ts';
import { ATTENTION_CHECK, DESIGN, HEURISTICS, VISUAL } from '../src/questions.ts';
import type { Finding } from '../src/report.ts';
import * as ux from '../src/suites/ux.ts';

test('questions: what is not cut off, out of line or unloaded, and wording judged for the reader', () => {
    const text = (q: unknown) => JSON.stringify(q);
    // Not cut off: a scrolling rail, an ellipsis, a decorative picture, the bottom edge. A hard cut still is.
    for (const said of ['scrolls inside its panel', 'shortened with \\"…\\"', 'decorative picture', 'bottom edge of the window, of a scrolling panel']) assert.ok(text(VISUAL.clipped).includes(said), said);
    assert.match(text(VISUAL.clipped), /cut off by the side of the screen or by its own box, with no \\"…\\" and nothing to scroll/);
    assert.match(text(VISUAL.misaligned), /cells hold text of different lengths, and cards of unequal height, are in line when their edges or baselines match/);
    assert.match(text(VISUAL.misaligned), /edge or baseline that should match its neighbours is visibly off/);
    assert.match(text(VISUAL.loaded), /empty state that asks the person to pick, search for or add something.*counts as loaded/);
    assert.match(text(VISUAL.loaded), /loading spinner or grey placeholder blocks/);
    // Every level of the wording question is about the screen's users; none marks down a technical term as such.
    const levels = text(HEURISTICS('traders').h2_language);
    assert.ok(!/jargon|technical/.test(levels));
    assert.equal(levels.match(/users/g)?.length, 5);
    assert.match(levels, /terms this screen's users would not know/);
    assert.match(text(ATTENTION_CHECK.has_cta), /information, filters or navigation/);
    // Density the product is for and an empty state are balanced; a repeated card action is one action; a decorative
    // picture and a scrolling panel's fading rows lower neither legibility nor minimalism.
    assert.match(DESIGN.density.criteria.balanced, /table, chart or map packed because that is what the product is for \(as `product` describes it, when given\) is balanced/);
    assert.match(DESIGN.density.criteria.balanced, /empty state that asks the person to add or search for something/);
    assert.match(text(DESIGN.cta), /same action repeated on each card or row of a list is one action/);
    for (const q of [DESIGN.legibility, HEURISTICS('traders').h8_minimalist]) assert.match(text(q), /decorative picture.*rows fading at a scrolling panel's bottom edge/);
});

test('ux: labels of looks at one point are stacked, not drawn over each other', () => {
    const box = { top: 0.5, bottom: 0.6, left: 0.2, right: 0.4 };
    const spots = ux.labelSpots(['first look', 'second look', 'third look'].map((label) => ({ label, box })), 1000, 600);
    assert.deepEqual(spots.map((s) => [s.x, s.y]), [[198, 278], [198, 300], [198, 322]]);
    // A look elsewhere keeps its own corner, and a label at the top or right edge stays in the picture.
    const [, far, edge] = ux.labelSpots([{ label: 'first look', box }, { label: 'second look', box: { ...box, left: 0.6 } }, { label: 'third look', box: { top: 0, bottom: 0.1, left: 0.99, right: 1 } }], 1000, 600);
    assert.deepEqual([far.x, far.y, edge.y, edge.x + edge.w], [598, 278, 0, 1000]);
});

test('ux: plain passes for trust and minimalism, and a missed CTA prediction warns', async () => {
    // Level 2 of a scale is 5.5: a pass for the two checks whose level 2 is a fine screen, a near miss for the rest.
    assert.deepEqual([5.5, 5.4, 4.4, 4.3, 3.3].map((v) => scoreStatus(v, 0.9, 0.3, 5.5, 4.4)), ['pass', 'warn', 'warn', 'fail', 'fail']);
    const tmp = mkdtempSync(`${tmpdir()}/tapcheck-ux-`);
    const page = (body: string) => `<!doctype html><html lang="en"><title>Seeds</title><body><h1>Seeds</h1>${body}</body></html>`;
    const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end(page(req.url === '/long' ? '<p style="height:1500px">Rows</p><button>Order seeds</button>' : '<button>Order seeds</button>')); });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    after(async () => { await closeBrowser(); server.close(); });
    const cfg = check({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, viewports: [{ name: 'desktop', width: 800, height: 600 }],
        screens: [{ name: 'Short', path: '/', purpose: 'order seeds' }, { name: 'Long', path: '/long', purpose: 'read the rows' }] });
    const found: Omit<Finding, 'side'>[] = [];
    const r: Run = { cfg, side: cfg.sides[0], dir: tmp, record: (f) => { found.push(f); }, crawl: { pages: [], hits: [], done: false } };
    // A fake Jev: level 2 for every score, the main CTA boxed away from every look, and a main call to action on each
    // whole screen but none on a first screen asked about on its own.
    let firstScreenAsks = 0;
    setup({ budget: 1, headers: {} }, { systemOne: async ({ state, questions }) => {
        const alone = Object.keys(questions).join() === 'has_cta';
        if (alone) firstScreenAsks++;
        return { answers: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, q.type === 'score' ? { score: 2, confidence: 0.9 }
            : q.type === 'box' ? { box: k === 'main_cta' ? { top: 0.8, bottom: 0.9, left: 0.6, right: 0.9 } : { top: 0.1, bottom: 0.2, left: 0.1, right: 0.3 }, confidence: 0.8 }
            : q.type === 'choice' ? { choice: Object.keys(q.criteria)[0], confidence: 0.9, probabilities: {} } : { noul: k === 'loaded' || (k === 'has_cta' && !alone) ? 0.95 : 0.05 }])), usage: { input_tokens: 100 } };
    } });
    await ux.run(r);

    const at = (where: string, check: string) => { const f = found.find((x) => x.where === where && x.check === check); return f && `${f.status}: ${f.detail ?? ''}`; };
    assert.deepEqual(found.filter((f) => f.check === 'audit ran'), []);
    assert.equal(at('Short · desktop', 'guerrilla: trust'), 'pass: 5.5/10 (confidence 0.90) for "How trustworthy and professional does the screenshot look to a first-time visitor?" · passes from 5.5');
    assert.equal(at('Short · desktop', 'heuristic: h8_minimalist'), 'pass: 5.5/10 (confidence 0.90) for "How free are the screenshots of things that do not help the person with this screen?" · passes from 5.5');
    assert.equal(at('Short · desktop', 'design: hierarchy'), 'warn: 5.5/10 (confidence 0.90) for "How clear is the visual hierarchy in the screenshots?" Nearest level (3 of 5): The page title is clear, but secondary parts compete with the main content.');
    // One slice: the whole-screen answer is the first screen's. The looks miss the CTA's box, which is a warning.
    assert.match(at('Short · desktop', 'attention: main CTA among first three looks')!, /^warn: the eye is predicted to land elsewhere first \(a prediction/);
    // Three slices: the first screen is asked on its own, and its clear "no" is info though the whole screen has a CTA.
    assert.equal(at('Long · desktop', 'attention: main CTA among first three looks'), 'info: no main call to action on the first screen (p=0.05)');
    assert.match(at('Long · desktop', 'design: cta')!, /^warn: 5\.5\/10/);
    assert.equal(firstScreenAsks, 1);
});

test('ux: no main call to action is info, audit owns the desktop look and target size', async () => {
    const tmp = mkdtempSync(`${tmpdir()}/tapcheck-ux-`);
    const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html lang="en"><title>Prices</title><body><h1>Prices</h1><button style="width:16px;height:16px;padding:0" aria-label="more"></button><p>Seeds 2.00</p></body></html>'); });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    after(async () => { await closeBrowser(); server.close(); });
    const cfg = check({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        viewports: [{ name: 'desktop', width: 800, height: 600 }, { name: 'phone', width: 390, height: 800, mobile: true }], screens: [{ name: 'Home', path: '/' }] });
    const found: Omit<Finding, 'side'>[] = [];
    const r: Run = { cfg, side: cfg.sides[0], dir: tmp, record: (f) => { found.push(f); }, crawl: { pages: [], hits: [], done: false } };
    // A fake Jev that is clear the screen has no main call to action, and scores whatever it is asked to.
    const asked: Record<string, string[]> = {};
    setup({ budget: 1, headers: {} }, { systemOne: async ({ state, questions }) => {
        if (state?.viewport) asked[state.viewport.split(',')[0]] = Object.keys(questions);
        return { answers: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, q.type === 'score' ? { score: 0.5, confidence: 0.9 }
            : q.type === 'box' ? { box: { top: 0.1, bottom: 0.2, left: 0.1, right: 0.3 }, confidence: 0.8 }
            : q.type === 'choice' ? { choice: 'balanced', confidence: 0.9, probabilities: { balanced: 0.9 } } : { noul: k === 'loaded' ? 0.95 : 0.05 }])), usage: { input_tokens: 100 } };
    } });
    // The audit suite looked at Home at the desktop viewport earlier in this run.
    looked.add(`${tmp} Home`);
    await ux.run(r);

    const at = (where: string, check: string) => { const f = found.find((x) => x.where === where && x.check === check); return f && `${f.status}: ${f.detail ?? ''}`; };
    assert.deepEqual(found.filter((f) => f.check === 'audit ran'), []);
    for (const where of ['Home · desktop', 'Home · phone']) for (const check of ['design: cta', 'design: cta label']) assert.equal(at(where, check), 'info: no main call to action on this screen (p=0.05)');
    assert.equal(at('Home · desktop', 'attention: main CTA among first three looks'), 'info: no main call to action on this screen (p=0.05)');
    assert.match(at('Home · desktop', 'design: hierarchy')!, /^fail: 2\.1\/10/); // the other scores are still judged
    // Desktop: audit asked the VISUAL questions, so ux doesn't; the phone is ux's alone.
    assert.deepEqual([asked.desktop.includes('clipped'), asked.desktop.includes('hierarchy'), asked.phone.includes('clipped')], [false, true, true]);
    assert.deepEqual([at('Home · desktop', 'visual: loaded'), at('Home · phone', 'visual: loaded')], [undefined, `pass: "Do the screenshots show the screen's main content, fully loaded?" Jev: yes (95% sure)`]);
    assert.deepEqual(found.filter((f) => /target size/.test(f.check)), []);
});

test('visual: a failing defect says what was asked and is boxed on the slice that shows it; a box over the whole slice points at nothing', async () => {
    const tmp = mkdtempSync(`${tmpdir()}/tapcheck-locate-`);
    after(closeBrowser);
    const { launch } = await import('../src/browser.ts');
    const page = await (await launch()).newPage({ viewport: { width: 400, height: 300 } });
    await page.setContent('<body style="margin:0;background:#fff"><p>slice</p></body>');
    const shots = [`${tmp}/a.png`, `${tmp}/b.png`];
    for (const s of shots) await page.screenshot({ path: s });
    await page.close();
    const asked: string[] = [];
    setup({ budget: 1, headers: {} }, { systemOne: async ({ questions, model }) => {
        asked.push(`${model ?? 'default'}:${Object.keys(questions).join()}`);
        // Only the second slice shows it cut off; its box is small. The overlap box (when asked) covers the whole slice.
        return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, model ? { box: k === 'overlap' ? { top: 0, bottom: 1, left: 0, right: 1 } : { top: 0.1, bottom: 0.3, left: 0.2, right: 0.6 } }
            : { noul: k === 'clipped' ? (asked.length === 3 ? 0.9 : 0.1) : 0.9 }])), usage: { input_tokens: 10 } };
    } });
    const found: Omit<Finding, 'side'>[] = [];
    const r = { dir: tmp, record: (f: Omit<Finding, 'side'>) => { found.push(f); } } as unknown as Run;
    await ux.visual(r, 'ux', 'Home · desktop', { clipped: { noul: 0.9 }, overlap: { noul: 0.9 }, loaded: { noul: 0.9 } }, shots);
    const f = (k: string) => found.find((x) => x.check === `visual: ${k}`)!;
    // Each slice: does it show them (yes-or-no), then a box for each it shows.
    assert.deepEqual(asked, ['default:overlap,clipped', 'jev-preview:overlap', 'default:overlap,clipped', 'jev-preview:overlap,clipped']);
    assert.match(f('clipped').detail!, /^"In the screenshots, is any text or control cut off\?" Jev: yes \(90% sure\)\. Yes means: A word, label.* · boxed where Jev places it/);
    assert.deepEqual(f('clipped').evidence, [`${tmp}/shots/ux_home_desktop-where-clipped-2.png`, ...shots]);
    assert.match(f('overlap').detail!, /Jev couldn't point to one place/);
    assert.deepEqual(f('overlap').evidence, shots);
    assert.equal(f('loaded').detail, `"Do the screenshots show the screen's main content, fully loaded?" Jev: yes (90% sure)`);
});
