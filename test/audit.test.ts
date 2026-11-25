import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { closeBrowser, type Run } from '../src/browser.ts';
import { check } from '../src/config.ts';
import { setup } from '../src/jev.ts';
import type { Finding } from '../src/report.ts';
import * as audit from '../src/suites/audit.ts';

const HOME = `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title><style>
body { margin: 0; font: 16px sans-serif; background: #ffffff; color: #111111; }
button { border: 1px solid #111111; background: #eeeeee; color: #111111; border-radius: 4px; padding: 8px; font: inherit; }
.big { height: 60px; border-radius: 7px; }
.clip { width: 80px; overflow: hidden; white-space: nowrap; }
.card { background: #ffffff; width: 200px; }
.sale { color: #ff0000; }
.tiny { display: none; }
#more { position: absolute; left: -50px; top: 200px; }
@media (prefers-color-scheme: dark) { body { background: #111111; color: #eeeeee; } }
@media (max-width: 400px) { .tiny { display: inline-block; width: 16px; height: 16px; padding: 0; } }
</style><body><h1>Plants</h1>
<button>Add plant</button> <button class="big">Buy now</button>
<button aria-haspopup="menu" onclick="document.getElementById('more').hidden = false">More</button>
<div id="more" role="menu" hidden><button role="menuitem">Rename</button></div>
<p class="clip">A very long line of text that cannot fit in eighty pixels</p>
<div class="card">A card that stays white</div>
<p class="sale">Sale</p>
<button class="tiny" aria-label="less"></button><button class="tiny" aria-label="more"></button>
</body></html>`;

test('audit: button sizes, cut-off text, a white background in dark mode, token violations, small targets on a phone, Jev looks', async () => {
    const tmp = mkdtempSync(`${tmpdir()}/tapcheck-audit-`);
    const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end(HOME); });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    after(async () => { await closeBrowser(); server.close(); });
    const cfg = check({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, viewports: [{ name: 'desktop', width: 800, height: 600 }],
        design: { colors: ['#ffffff', '#111111', '#eeeeee'], radii: [4] } }, tmp);
    const found: Omit<Finding, 'side'>[] = [];
    const r: Run = { cfg, side: cfg.sides[0], dir: tmp, record: (f) => { found.push(f); }, crawl: { pages: [], hits: [], done: false } };
    // A fake Jev that sees nothing wrong; nothing reaches the network.
    const asked: string[][] = [];
    delete process.env.JEV;
    setup({ budget: 1, headers: {} }, { systemOne: async ({ questions }) => {
        asked.push(Object.keys(questions));
        return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: k === 'loaded' ? 0.9 : 0.1 }])), usage: { input_tokens: 100 } };
    } });
    await audit.run(r);

    const at = (where: string, check: string) => { const f = found.find((x) => x.where === where && x.check === check); return `${f?.status}: ${f?.detail ?? ''}`; };
    const all = 'all audited screens';
    assert.match(at(all, 'consistency: one size and radius per button'), /^warn: 2 look\(s\).*×2 \(Add plant, More\).*60 px high, radius 7 px.*\(Buy now\)/);
    assert.match(at('Home · desktop', 'text is not cut off'), /^fail: 1: "A very long line/);
    assert.match(at('Home · dark', 'dark mode: no background left white'), /^fail: .*div\.card/);
    assert.match(at('Home · dark', 'dark mode: text contrast (axe)'), /^fail: /);
    assert.match(at(all, 'design tokens: colours'), /^warn: 1 value\(s\) outside design\.colors; most used: #ff0000 text ×1 \(p\.sale on Home\)/);
    assert.match(at(all, 'design tokens: radii'), /^warn: 1 value\(s\) outside design\.radii; most used: 7 px ×1 \(button\.big on Home\)/);
    assert.match(at('Home · phone', 'targets at least 24 px'), /^fail: 2: less 16×16; more 16×16/);
    assert.equal(at('Home · desktop', 'targets at least 24 px'), 'pass: ');
    // The menu the markup announces is opened and measured, and Jev looks at the screen and at the menu.
    assert.match(at('Home › More', 'fits on the screen'), /^fail: 1: it spans -50,200/);
    assert.deepEqual(asked.map((q) => q.includes('loaded')), [true, false]);
    assert.deepEqual([at('Home · desktop', 'visual: loaded'), at('Home › More', 'visual: overlap')], ['pass: p=0.90', 'pass: p=0.10']);
    assert.deepEqual(found.filter((f) => f.status === 'info').map((f) => f.check), []);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(`${tmp}/audit.json`, 'utf8')).screens[0].views), ['desktop', 'menu "More"', 'dark', 'tablet', 'phone']);
});
