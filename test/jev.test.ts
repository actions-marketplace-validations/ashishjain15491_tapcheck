import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { closeBrowser, type Run } from '../src/browser.ts';
import { check } from '../src/config.ts';
import { ask, bad, BudgetReached, good, savePayloads, scoreStatus, setup, status, to10, usage, type Client } from '../src/jev.ts';
import type { Finding } from '../src/report.ts';
import * as usability from '../src/suites/usability.ts';
import * as ux from '../src/suites/ux.ts';

// No test here reaches the network: every setup() is given a fake client.
const tmp = mkdtempSync(`${tmpdir()}/tapcheck-jev-`);
const counting = (tokens = 100) => {
    const c = { calls: 0, systemOne: async () => { c.calls++; return { answers: { ok: { noul: 0.9 } }, usage: { input_tokens: tokens } }; } };
    return c;
};

test('verdicts: thresholds, and unsure is a warning, never a pass', () => {
    assert.deepEqual([0.71, 0.7, 0.5, 0.3, 0.29].map(good), ['pass', 'unsure', 'unsure', 'unsure', 'FAIL']);
    assert.deepEqual([0.71, 0.7, 0.5, 0.3, 0.29].map(bad), ['FAIL', 'unsure', 'unsure', 'unsure', 'pass']);
    assert.deepEqual((['pass', 'FAIL', 'unsure'] as const).map(status), ['pass', 'fail', 'warn']);
});

test('to10: a score position 0–4 maps to 1–10', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 2.67].map(to10), [1, 3.3, 5.5, 7.8, 10, 7]);
});

test('memo: the same request is answered once', async () => {
    const shot = `${tmp}/memo.png`;
    writeFileSync(shot, 'one');
    const c = counting();
    setup({ budget: 1, headers: {} }, c);
    const q = { ok: { type: 'noul', instructions: 'Is it fine?' } };
    assert.deepEqual(await ask('a', { n: 1 }, q, [shot]), await ask('b', { n: 1 }, q, [shot]));
    assert.equal(c.calls, 1);
    assert.deepEqual([usage().calls, usage().cached, usage().tokens], [1, 1, 100]);
    writeFileSync(shot, 'two'); // the same state over a different image is a new request
    await ask('c', { n: 1 }, q, [shot]);
    assert.equal(c.calls, 2);
});

test('budget: no request is sent once it is spent', async () => {
    const c = counting(30_000_000); // about $1.26 a call
    setup({ budget: 1, headers: {} }, c);
    await ask('a', { n: 1 }, {}, []);
    await assert.rejects(ask('b', { n: 2 }, {}, []), (e) => e instanceof BudgetReached && /\$1 reached/.test(e.message));
    assert.equal(c.calls, 1);
    assert.equal(usage().usd, 1.26);
});

test('config: tasks, audience and jev', () => {
    const task = { name: 'Find help', from: '/', goal: 'Find the help page.', done: 'Help is open.', notDone: 'Anything else.', optimal: 2 };
    const c = check({ baseUrl: 'http://x', sides: { a: {}, b: {} }, tasks: { b: [task] }, jev: { budget: 0.25, headers: { 'X-Test': 'yes' } }, i18n: { keys: 'cat keys.txt' } });
    assert.deepEqual([c.sides[0].tasks, c.sides[1].tasks], [[], [{ ...task, text: undefined }]]);
    assert.deepEqual(c.jev, { budget: 0.25, headers: { 'X-Test': 'yes' } });
    assert.equal(c.i18n.keys, 'cat keys.txt');
    const d = check({ baseUrl: 'http://x', tasks: [task] });
    assert.deepEqual([d.audience, d.jev, d.sides[0].tasks.length], ['a first-time visitor', { budget: 1, headers: {} }, 1]);
    process.env.JEV_BUDGET = '0.1';
    try {
        assert.equal(check({ baseUrl: 'http://x', jev: { budget: 5 } }).jev.budget, 0.1);
        process.env.JEV_BUDGET = 'lots';
        assert.throws(() => check({ baseUrl: 'http://x' }), /JEV_BUDGET \(environment\) must be a number/);
    } finally { delete process.env.JEV_BUDGET; }

    assert.throws(() => check({ baseUrl: 'http://x', tasks: [{ ...task, done: '' }] }), /tasks\[0\]\.done must be a non-empty string/);
    assert.throws(() => check({ baseUrl: 'http://x', tasks: [{ ...task, optimal: 0 }] }), /tasks\[0\]\.optimal must be the fewest clicks/);
    assert.throws(() => check({ baseUrl: 'http://x', tasks: { staff: [task] } }), /tasks\.staff names a side/);
    assert.throws(() => check({ baseUrl: 'http://x', tasks: 'all' }), /tasks must be a list/);
    assert.throws(() => check({ baseUrl: 'http://x', jev: { budget: -1 } }), /jev\.budget must be a number of US dollars above 0/);
    assert.throws(() => check({ baseUrl: 'http://x', jev: { headers: { 'X-A': 1 } } }), /jev\.headers\.X-A must be a non-empty string/);
    assert.throws(() => check({ baseUrl: 'http://x', audience: '' }), /audience must be a non-empty string/);
    assert.throws(() => check({ baseUrl: 'http://x', i18n: { keys: 3 } }), /i18n\.keys must be a non-empty string/);
});

// ───────────────────────────── a whole ux and usability run on a tiny page, with canned answers ─────────────────────────────
const PAGES: Record<string, string> = {
    '/': `<!doctype html><html lang="en"><title>Shop</title><body><h1>Shop</h1><p>settings.profile.title</p><p><a href="/ask">Ask a question</a></p>
        <button onclick="document.title='gone'">Delete account</button>
        <form method="post" action="/sent"><input name="q" aria-label="Your question"><button>Post it</button></form></body></html>`,
    '/ask': '<!doctype html><html lang="en"><title>Ask</title><body><h1>Ask us</h1><p>Write your question here.</p></body></html>',
};
const YES_IS_GOOD = ['loaded', 'h10_help', 'purpose_clear', 'has_cta', 'can_progress'];
const seen: any[] = [];
/** Answers by question kind: everything looks fine, `overlap` is unsure, and the task is reached once something was clicked. */
const fake: Client = {
    async systemOne(req) {
        seen.push(req);
        const answers = Object.fromEntries(Object.entries(req.questions).map(([k, q]) => {
            if (q.type === 'score') return [k, { score: 3.6, confidence: 0.9 }];
            if (q.type === 'box') return [k, { box: { top: 0.1, bottom: 0.2, left: 0.1, right: 0.3 }, confidence: 0.8 }];
            if (q.type === 'choice') {
                const keys = Object.keys(q.criteria);
                const choice = keys.find((c) => c === 'balanced' || c.startsWith('ask_')) ?? keys[0];
                return [k, { choice, confidence: 0.9, probabilities: { [choice]: 0.9 } }];
            }
            const p = k === 'overlap' ? 0.5 : k === 'arrived' ? (req.state.already_clicked.length ? 0.95 : 0.05) : YES_IS_GOOD.includes(k) ? 0.95 : 0.05;
            return [k, { noul: p }];
        }));
        return { answers, usage: { input_tokens: 1000 } };
    },
};

test('ux and usability: a tiny page, judged by a fake Jev', async () => {
    const posted: string[] = [];
    const server = createServer((req, res) => {
        if (req.method !== 'GET') posted.push(`${req.method} ${req.url}`);
        const html = PAGES[req.url ?? ''];
        res.writeHead(html ? 200 : 404, { 'content-type': 'text/html' }).end(html ?? 'not found');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    after(async () => { await closeBrowser(); server.close(); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(`${tmp}/keys.txt`, 'settings.profile.title\nShop\n');
    const cfg = check({
        baseUrl: base, audience: 'a keen gardener', i18n: { keys: `cat ${tmp}/keys.txt` },
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        screens: [{ name: 'Home', path: '/', purpose: 'see what the shop sells' }, { name: 'Ask', path: '/ask', purpose: 'ask the shop a question' }],
        tasks: [{ name: 'Ask', from: '/', goal: 'Ask the shop a question.', done: 'A page for asking a question is open.', notDone: 'Anything else.', optimal: 1, text: 'roses' }],
    });
    const found: Omit<Finding, 'side'>[] = [];
    const r: Run = { cfg, side: cfg.sides[0], dir: tmp, record: (f) => { found.push(f); }, crawl: { pages: [], hits: [], done: false } };
    process.env.TYPESAFE_API_KEY = 'tsk-not-a-real-key-0123456789';
    try {
        setup({ budget: 1, headers: {} }, fake);
        await ux.run(r);
        await usability.run(r);
        savePayloads(tmp);
    } finally { delete process.env.TYPESAFE_API_KEY; }
    const at = (where: string, check: string) => found.find((f) => f.where.startsWith(where) && f.check === check);
    const st = (where: string, check: string) => at(where, check)?.status;

    // ux: measured facts, Jev's judgments turned into verdicts, the audience in the wording, a heatmap as evidence.
    assert.deepEqual(found.filter((f) => f.check === 'audit ran' || f.check === 'task ran'), []);
    assert.equal(st('Home', 'HTTP status'), 'pass');
    assert.equal(st('Home', 'visual: loaded'), 'pass');
    assert.equal(st('Home', 'visual: overlap'), 'warn'); // p=0.5 is unsure
    assert.match(at('Home', 'design: cta')!.detail!, /^9\.1\/10/);
    // A score of 7 passes, a near miss warns, a low score fails unless Jev was split on it.
    assert.deepEqual([[7, 0.9], [6.9, 0.9], [5.5, 0.9], [5.4, 0.9], [3, 0.2]].map(([v, c]) => scoreStatus(v, c)), ['pass', 'warn', 'warn', 'fail', 'warn']);
    assert.equal(st('Home', 'guerrilla: right job picked'), 'fail'); // the fake reads every screen as the "ask" one
    assert.equal(st('Ask', 'guerrilla: right job picked'), 'pass');
    assert.equal(st('Home', 'attention: main CTA among first three looks'), 'pass');
    assert.ok(existsSync(`${tmp}/shots/ux-home-desktop-heatmap.png`));
    assert.equal(st('Home', 'no raw translation keys (measured)'), 'fail'); // the dotted key, not the plain word "Shop"
    assert.equal(at('Home', 'no raw translation keys (measured)')!.detail, 'settings.profile.title');
    assert.equal(st('Ask', 'no raw translation keys (measured)'), 'pass');
    assert.match(seen[0].questions.h2_language.instructions, /everyday words a keen gardener would use/);

    // usability: one click reaches the goal; nothing that submits or deletes was ever offered or sent.
    assert.equal(st('Ask:', 'task completed'), 'pass');
    assert.match(at('Ask:', 'task completed')!.detail!, /1 click\(s\): Ask a question/);
    assert.equal(st('Ask:', 'path efficiency'), 'pass');
    assert.equal(st('Ask:', 'no dead clicks'), 'pass');
    const offered = seen.filter((q) => q.questions.pick).flatMap((q) => Object.values(q.questions.pick.criteria));
    assert.deepEqual(offered, ['The link labelled "Ask a question", on the left side.']);
    assert.deepEqual(posted, []);
    assert.equal(JSON.parse(readFileSync(`${tmp}/clickstream.json`, 'utf8'))[0].reached, true);
    assert.ok(existsSync(`${tmp}/shots/clickstream-ask.png`));

    // payloads: every request, images as files, and neither the key nor image bytes.
    const log = readFileSync(`${tmp}/payloads.json`, 'utf8');
    assert.equal(JSON.parse(log).length, usage().calls + usage().cached);
    assert.ok(log.includes(`${tmp}/shots/ux-home-desktop-1.png`));
    assert.ok(!log.includes('tsk-not-a-real-key') && !log.includes('iVBOR'));
});

test('jev: context goes to Jev with every question, and the language question counts the field\'s terms', async () => {
    const sent: any[] = [];
    setup({ budget: 1, headers: {}, context: 'a dense trading tool' }, { systemOne: async (req) => { sent.push(req.state); return { answers: {}, usage: { input_tokens: 1 } }; } });
    await ask('one', { screen: 'Home' }, { ok: { type: 'bool' } }, []);
    assert.deepEqual(sent[0], { product: 'a dense trading tool', screen: 'Home' });
    const { image } = await import('@typesafe-ai/sdk');
    const picture = image(Buffer.from('x'));
    await ask('picture', picture, { ok: { type: 'bool' } }, []);
    assert.equal(sent[1], picture); // a state that is the image itself goes as it is
    const { HEURISTICS } = await import('../src/questions.ts');
    assert.ok(!JSON.stringify(HEURISTICS('traders').h2_language).includes('`product`'));
    assert.ok(JSON.stringify(HEURISTICS('traders', 'a dense trading tool').h2_language).includes('`product` names count as their own words'));
    setup({ budget: 1, headers: {} }, { systemOne: async (req) => { sent.push(req.state); return { answers: {}, usage: { input_tokens: 1 } }; } });
    await ask('two', { screen: 'Home' }, { ok: { type: 'bool' } }, []);
    assert.deepEqual(sent[2], { screen: 'Home' }); // no context: the state as it was
});
