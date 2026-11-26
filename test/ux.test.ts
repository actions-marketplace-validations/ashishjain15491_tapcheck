import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { closeBrowser, type Run } from '../src/browser.ts';
import { check } from '../src/config.ts';
import { looked, setup } from '../src/jev.ts';
import { ATTENTION_CHECK, HEURISTICS, VISUAL } from '../src/questions.ts';
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
    assert.deepEqual([at('Home · desktop', 'visual: loaded'), at('Home · phone', 'visual: loaded')], [undefined, 'pass: p=0.95']);
    assert.deepEqual(found.filter((f) => /target size/.test(f.check)), []);
});
