import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { closeBrowser, type Run } from '../src/browser.ts';
import { check } from '../src/config.ts';
import type { Finding } from '../src/report.ts';
import * as interact from '../src/suites/interact.ts';

const HOME = `<!doctype html><html lang="en"><title>t</title><body><h1>t</h1>
<button>Nothing</button>
<button onclick="throw new Error('boom')">Throws</button>
<button onclick="confirm('Sure?')">Ask</button>
<button onclick="fetch('/hit/delete')">Delete plant</button>
<form method="post" action="/hit/post"><input name="a" value="1" aria-label="A"><button>Save</button></form>
<button onclick="document.getElementById('panel').hidden = false">Open panel</button>
<div id="panel" role="dialog" hidden><form novalidate onsubmit="event.preventDefault()"><input name="n" required aria-label="Name"><button>Add</button></form></div>
<button onclick="document.getElementById('notes').showModal()">Open notes</button>
<dialog id="notes" aria-label="Care notes"><form method="dialog"><input type="email" required aria-label="Email"><button>Sign up</button></form></dialog>
<table><thead><tr><th><button onclick="const b = document.querySelector('tbody'); b.append(b.rows[0])">Plant</button></th></tr></thead><tbody><tr><td>Fern</td></tr><tr><td>Jade</td></tr></tbody></table>
</body></html>`;

// A dialog whose form POSTs and is checked by the page's own script, not by the browser.
const FORM = `<!doctype html><html lang="en"><title>t</title><body><h1>t</h1>
<button onclick="document.getElementById('new').showModal()">New plant</button>
<dialog id="new" aria-label="New plant"><form method="post" action="/hit/post" novalidate
    onsubmit="if (!this.email.value.includes('@')) { event.preventDefault(); document.getElementById('err').hidden = false; }">
<input name="email" type="email" aria-label="Email"><p id="err" role="alert" hidden>Enter an email address.</p><button>Save</button></form></dialog>
</body></html>`;

const tmp = mkdtempSync(`${tmpdir()}/tapcheck-interact-`);
const asked: string[] = [];
const server = createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/html' }).end(req.url === '/' ? HOME : req.url === '/form' ? FORM : 'ok');
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
after(async () => { await closeBrowser(); server.close(); });

/** Runs the suite on one page; returns a lookup of [status, detail] by place and check. */
async function sweep(path: string, extra: object = {}) {
    asked.length = 0;
    const cfg = check({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, viewports: [{ name: 'desktop', width: 800, height: 600 }], ...extra }, tmp);
    const found: Omit<Finding, 'side'>[] = [];
    const r: Run = { cfg, side: cfg.sides[0], dir: tmp, record: (f) => { found.push(f); },
        crawl: { pages: [{ path, status: 200, finalPath: path, ms: 0, errors: [], links: [] }], hits: [], done: true } };
    await interact.run(r);
    return (where: string, check: string) => { const f = found.find((x) => x.where === where && x.check === check); return [f?.status, f?.detail ?? '']; };
}

test('interact: dead controls, errors, native dialogs, dialog checks and tables; nothing unsafe is clicked', async () => {
    const at = await sweep('/');
    assert.match(at('/', 'every control does something').join(), /^warn,.*"Nothing"/);
    assert.match(at('/', 'clicks raise no page or console errors').join(), /^fail,"Throws": boom/);
    assert.match(at('/', 'no native alert, confirm or prompt').join(), /^fail,"Ask": confirm\("Sure\?"\)/);
    assert.equal(at('/', 'clicks set off no 5xx')[0], 'pass');

    // The unnamed panel: no name, Escape does nothing, and its form takes an empty required field without a word.
    const panel = '/ › opened by "Open panel"';
    assert.deepEqual([at(panel, 'dialog has an accessible name')[0], at(panel, 'focus moves into the dialog')[0], at(panel, 'dialog closes with Escape')[0]], ['fail', 'warn', 'fail']);
    assert.match(at(panel, 'invalid input shows an error').join(), /^fail,none shown/);
    // The native dialog does all of it right.
    for (const c of ['dialog has an accessible name', 'focus moves into the dialog', 'dialog closes with Escape']) assert.equal(at('/ › Care notes', c)[0], 'pass', c);
    assert.match(at('/ › Care notes', 'invalid input shows an error').join(), /^pass,browser validation/);
    assert.equal(at('/ › table (Plant)', 'sorting changes the rows')[0], 'pass');

    // "Delete plant" matches the UNSAFE words and "Save" submits a form that POSTs: neither was clicked.
    assert.deepEqual(asked.filter((a) => a !== 'GET /'), []);
    const log = JSON.parse(readFileSync(`${tmp}/interact.json`, 'utf8'));
    assert.deepEqual(log.screens[0].clicked, ['Nothing', 'Throws', 'Ask', 'Open panel', 'Open notes', 'Plant']);
    assert.deepEqual(log.dialogs.map((d: any) => [d.name, d.named, d.form]), [['opened by "Open panel"', false, true], ['Care notes', true, true]]);
    assert.deepEqual(log.tables, [{ page: '/', headers: 'Plant', sort: 'changed' }]);
});

test('interact.submit: a form that POSTs is sent only when it is on', async () => {
    const off = await sweep('/form');
    assert.match(off('/form › New plant', 'invalid input shows an error').join(), /^info,not submitted: the form posts/);
    assert.deepEqual(asked, ['GET /form']);

    const on = await sweep('/form', { interact: { submit: true } });
    assert.match(on('/form › New plant', 'invalid input shows an error').join(), /^pass,message: Enter an email address\./);
    assert.deepEqual(on('/form › New plant', 'valid input is accepted'), ['pass', 'submitted']);
    assert.equal(asked.filter((a) => a === 'POST /hit/post').length, 1, 'the valid input was posted once, the invalid input never');
});
