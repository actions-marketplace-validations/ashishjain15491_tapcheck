import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { check } from '../src/config.ts';
import { coverage, hits } from '../src/coverage.ts';
import { parse } from '../src/routes.ts';

test('coverage: the hits of every run folder merged against the routes, with reasons, dialogs and tables', () => {
    const out = mkdtempSync(`${tmpdir()}/tapcheck-coverage-`);
    const put = (dir: string, list: unknown[]) => { mkdirSync(`${out}/${dir}`, { recursive: true }); writeFileSync(`${out}/${dir}/hits.json`, JSON.stringify(list)); };
    put('run-2026-01-01T10-00-00/public', [{ part: 'crawl-public', what: 'GET /' }, { part: 'interact-public', step: '/plants', what: 'dialog Add a plant' },
        { part: 'interact-public', step: '/plants', what: 'table Name Light: sort' }]);
    put('run-2026-01-02T10-00-00/staff', [{ part: 'flow-order', step: 'place an order', what: 'POST /orders' }, { part: 'flow-order', step: 'see it', what: 'GET /orders/7' }, { part: 'crawl-staff', what: 'GET /' }]);
    mkdirSync(`${out}/run-2026-01-03T10-00-00/public`, { recursive: true }); // a code-only or stopped run: no hits.json
    writeFileSync(`${out}/state.json`, '{}');

    const { all, runs } = hits(out);
    assert.deepEqual([all.length, runs, all[0].part], [6, 2, 'flow-order']); // newest run first
    const routes = parse(JSON.stringify([{ method: 'GET|HEAD', path: '/' }, { method: 'GET', path: 'orders/{id}' }, { method: 'POST', path: '/orders' }, { method: 'DELETE', path: '/orders/{id}' }, { method: 'GET', path: '/admin/export' }]));
    const { reasons } = check({ baseUrl: 'http://x', coverage: { reasons: [{ match: '^GET /admin/export$', why: 'downloads are not followed' }] } }).coverage;
    const c = coverage(all, runs, routes, reasons);
    for (const row of ['| `GET /` | crawl-staff, crawl-public |', '| `GET /orders/{id}` | flow-order: see it |', '| `POST /orders` | flow-order: place an order |', '| `DELETE /orders/{id}` | **GAP** |',
        '| `GET /admin/export` | GAP: downloads are not followed |', '| Add a plant | interact-public: /plants |', '| Name Light: sort | interact-public: /plants |',
        '**5 routes: 3 reached, 1 left out on purpose, 1 GAP.** Runs merged: 2.']) assert.ok(c.md.includes(row), `${row}\n${c.md}`);
    assert.deepEqual([c.covered, c.excused, c.gaps], [3, 1, ['DELETE /orders/{id}']]);

    // Without a routes command: what was reached, and no gaps to speak of.
    const bare = coverage(all, runs, [], []);
    assert.ok(bare.md.includes('## Reached') && bare.md.includes('| POST /orders | flow-order: place an order |') && !bare.md.includes('GAP'), bare.md);
    assert.ok(bare.md.includes('## Dialogs'));
    // A backslash or pipe in a name stays inside its cell.
    const odd = coverage([{ part: 'interact-public', what: 'dialog C:\\temp | x' }], 1, [], []);
    assert.ok(odd.md.includes('| C:\\\\temp \\| x |'), odd.md);
    assert.deepEqual(hits(`${out}/nowhere`), { all: [], runs: 0 });
});

test('config: coverage, app.resetWhen and stub.dns name the field', () => {
    const c = check({ baseUrl: 'http://x', app: { reset: './reset', resetWhen: ['database/**'] }, stub: { dns: { records: [{ name: 'Shop.Example.com.', type: 'mx', values: ['20 mx.example.com'] }], defaultA: '203.0.113.7' } } });
    assert.deepEqual([c.coverage, c.app.resetWhen], [{ file: 'COVERAGE.md', reasons: [] }, ['database/**']]);
    assert.deepEqual(c.stub!.dns, { port: 8767, records: [{ name: 'shop.example.com', type: 'MX', values: ['20 mx.example.com'] }], defaultA: '203.0.113.7' });
    const bad = (extra: object, re: RegExp) => assert.throws(() => check({ baseUrl: 'http://x', ...extra }), re);
    bad({ coverage: { reasons: [{ match: '(', why: 'x' }] } }, /coverage\.reasons\[0\]\.match is not a valid regular expression/);
    bad({ coverage: { reasons: [{ match: 'x' }] } }, /coverage\.reasons\[0\]\.why must be a non-empty string/);
    bad({ coverage: { file: '' } }, /coverage\.file must be a non-empty string/);
    bad({ app: { resetWhen: ['database/**'] } }, /app\.resetWhen needs app\.reset/);
    bad({ app: { reset: 'x', resetWhen: 'database/**' } }, /app\.resetWhen must be a list of globs/);
    bad({ stub: { dns: { port: 0 } } }, /stub\.dns\.port must be a port number/);
    bad({ stub: { dns: { records: [{ name: 'a.test', type: 'SRV', values: ['x'] }] } } }, /stub\.dns\.records\[0\]\.type must be one of A, AAAA, MX, TXT, CNAME, NS/);
    bad({ stub: { dns: { records: [{ name: 'a.test', type: 'A', values: ['localhost'] }] } } }, /stub\.dns\.records\[0\]\.values\[0\] must be an IPv4 address/);
    bad({ stub: { dns: { records: [{ name: 'a.test', type: 'TXT', values: [] }] } } }, /stub\.dns\.records\[0\]\.values must be a list with at least one value/);
    bad({ stub: { dns: { defaultA: '::1' } } }, /stub\.dns\.defaultA must be an IPv4 address/);
});
