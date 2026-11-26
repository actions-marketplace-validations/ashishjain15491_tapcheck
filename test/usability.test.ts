import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { closeBrowser, type Run } from '../src/browser.ts';
import { check } from '../src/config.ts';
import { setup, type Client } from '../src/jev.ts';
import type { Finding } from '../src/report.ts';
import * as usability from '../src/suites/usability.ts';

// An icon rail that widens into a flyout while the pointer is on it, over the content beside it. "Trap" covers itself
// as the pointer arrives, so a click on it can't land.
const HOME = `<!doctype html><html lang="en"><title>t</title><style>
body { margin: 0 } nav { position: fixed; left: 0; top: 0; bottom: 0; width: 48px; background: #ddd; overflow: hidden } nav.open { width: 400px }
main { margin: 100px 0 0 60px } #cover { position: fixed; left: 500px; top: 300px; width: 200px; height: 80px; background: #ccc; z-index: 1 }
</style><body>
<nav onmouseenter="this.className = 'open'" onmouseleave="this.className = ''"><button style="margin-top:100px" onclick="list.innerHTML = '<a href=/alerts>Past alerts</a>'">Menu</button></nav>
<main id="list"></main>
<button style="position:fixed;left:520px;top:320px">Under a banner</button><div id="cover">banner</div>
<button style="position:fixed;left:500px;top:200px" onmouseenter="cover.style.top = '180px'">Trap</button>
</body></html>`;

const seen: any[] = [];
/** Picks the control the goal names next ("menu, past_alerts": Menu, then Past alerts), and arrives once all were clicked. */
const fake: Client = {
    async systemOne(req) {
        seen.push(req);
        const want = String(req.state.goal ?? '').split(', '), done = req.state.already_clicked?.length ?? 0;
        return { usage: { input_tokens: 1 }, answers: Object.fromEntries(Object.entries(req.questions).map(([k, q]) => {
            if (q.type !== 'choice') return [k, { noul: k === 'can_progress' || (k === 'arrived' && done >= want.length) ? 0.95 : 0.05 }];
            const choice = Object.keys(q.criteria).find((c) => c.startsWith(want[done])) ?? Object.keys(q.criteria)[0];
            return [k, { choice, confidence: 0.9, probabilities: { [choice]: 0.9 } }];
        })) };
    },
};

test('usability: a flyout left open by the pointer covers nothing on the next step, covered controls are not offered, and a failed click names its control', async () => {
    const tmp = mkdtempSync(`${tmpdir()}/tapcheck-usability-`);
    const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end(req.url === '/' ? HOME : '<!doctype html><title>Alerts</title><h1>Past alerts</h1>'); });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    after(async () => { await closeBrowser(); server.close(); });
    const task = (name: string, goal: string) => ({ name, from: '/', goal, done: 'It is open.', notDone: 'Anything else.', optimal: 2 });
    const cfg = check({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, viewports: [{ name: 'desktop', width: 800, height: 600 }],
        tasks: [task('Alerts', 'menu, past_alerts'), task('Trap', 'trap')] }, tmp);
    const found: Omit<Finding, 'side'>[] = [];
    process.env.TYPESAFE_API_KEY = 'tsk-not-a-real-key-0123456789';
    try {
        setup({ budget: 1, headers: {} }, fake);
        await usability.run({ cfg, side: cfg.sides[0], dir: tmp, record: (f) => { found.push(f); }, crawl: { pages: [], hits: [], done: false } } as Run);
    } finally { delete process.env.TYPESAFE_API_KEY; }
    const at = (where: string, check: string) => { const f = found.find((x) => x.where.startsWith(where) && x.check === check); return [f?.status, f?.detail]; };

    // "Menu" is in the rail; the pointer left it afterwards, so "Past alerts" beside it could be clicked.
    assert.deepEqual(at('Alerts:', 'task completed'), ['pass', '2 click(s): Menu → Past alerts']);
    assert.deepEqual(at('Alerts:', 'no dead clicks'), ['pass', undefined]);
    assert.ok(!seen.some((q) => q.state.controls?.some((c: string) => /Under a banner/.test(c))), 'a control under something else is never offered');
    assert.match(at('Trap:', 'task completed')[1]!, /^click failed on "Trap": /);
    assert.doesNotMatch(at('Trap:', 'task completed')[1]!, /Call log/);
});
