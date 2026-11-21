import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { check } from '../src/config.ts';
import type { Finding } from '../src/report.ts';
import { coverage, hasParams, matcher, parse, routes } from '../src/routes.ts';
import * as code from '../src/suites/code.ts';

const tmp = mkdtempSync(`${tmpdir()}/tapcheck-code-`);

test('config: gates, routes, stub, flows and mail', () => {
    const c = check({ baseUrl: 'http://x', gates: [{ name: 'lint', run: 'true' }, { name: 'audit', run: 'false', warn: true, timeout: 5 }], routes: 'cat routes.json',
        security: { publicWrites: '^/webhooks/' }, stub: { rules: [{ host: 'API.example.com', method: 'post', path: '/v1/*', json: { ok: true } }] }, flows: 'flows/*.ts', mail: { mailpit: 'http://127.0.0.1:8025/' } }, tmp);
    assert.deepEqual(c.gates, [{ name: 'lint', run: 'true', timeout: 600, warn: false }, { name: 'audit', run: 'false', timeout: 5, warn: true }]);
    assert.deepEqual([c.root, c.routes, c.flows, c.mail.mailpit, c.stub!.port], [tmp, 'cat routes.json', ['flows/*.ts'], 'http://127.0.0.1:8025', 8766]);
    assert.deepEqual(c.stub!.rules[0], { host: 'api.example.com', method: 'POST', path: '/v1/*', status: 200, json: { ok: true }, body: undefined, file: undefined, headers: {}, delayMs: 0 });
    assert.ok(c.security.publicWrites!.test('/webhooks/pay'));
    const d = check({ baseUrl: 'http://x' });
    assert.deepEqual([d.gates, d.routes, d.stub, d.flows, d.mail], [[], undefined, undefined, [], { mailpit: undefined }]);

    const bad = (raw: object, re: RegExp) => assert.throws(() => check({ baseUrl: 'http://x', ...raw }, tmp), re);
    bad({ gates: { lint: 'true' } }, /gates must be a list/);
    bad({ gates: [{ name: 'lint' }] }, /gates\[0\]\.run must be a non-empty string/);
    bad({ gates: [{ name: 'lint', run: 'true', timeout: 0 }] }, /gates\[0\]\.timeout must be a positive number/);
    bad({ routes: ['a'] }, /routes must be a non-empty string/);
    bad({ security: { publicWrites: '(' } }, /security\.publicWrites is not a valid regular expression/);
    bad({ stub: { port: 99999 } }, /stub\.port must be a port number/);
    bad({ stub: { rules: [{ status: 42 }] } }, /stub\.rules\[0\]\.status must be an HTTP status/);
    bad({ stub: { rules: [{ json: {}, body: 'x' }] } }, /stub\.rules\[0\] takes one of json, body or file/);
    bad({ stub: { rules: [{ path: '^(' }] } }, /stub\.rules\[0\]\.path is not a valid regular expression/);
    bad({ stub: { rules: [{ file: 'nope.json' }] } }, /stub\.rules\[0\]\.file is not a file next to tapcheck\.yml: nope\.json/);
    bad({ flows: ['a.ts', ''] }, /flows\[1\] must be a non-empty string/);
    bad({ mail: { mailpit: 'localhost:8025' } }, /mail\.mailpit must be an http\(s\) URL/);
    bad({ sides: { code: {} } }, /sides\.code name can't be a suite or tag name/);
    assert.deepEqual(check({ baseUrl: 'http://x', changes: { code: ['src/**'], flow: ['tests/**'] } }).changes, { code: ['src/**'], flow: ['tests/**'] });
});

test('gates: pass, fail with the tail of the output, warn, timeout; code.json keeps the output', async () => {
    const cfg = check({ baseUrl: 'http://x', gates: [
        { name: 'passes', run: 'echo fine' },
        { name: 'fails', run: 'for i in 1 2 3 4 5 6 7 8; do echo "line $i"; done; echo "to stderr" >&2; exit 3' },
        { name: 'warns', run: 'echo advisory; exit 1', warn: true },
        { name: 'hangs', run: 'echo started; sleep 30; echo never', timeout: 0.3 },
        { name: 'here', run: 'test -f marker.txt' },
    ] }, tmp);
    writeFileSync(`${tmp}/marker.txt`, ''); // gates run from the config file's folder
    const found: Omit<Finding, 'side'>[] = [];
    const t0 = Date.now();
    await code.run(cfg, tmp, (f) => { found.push(f); });
    assert.ok(Date.now() - t0 < 10_000, 'the hanging gate was stopped');
    assert.deepEqual(found.map((f) => [f.check, f.status]), [['passes', 'pass'], ['fails', 'fail'], ['warns', 'warn'], ['hangs', 'fail'], ['here', 'pass']]);
    assert.equal(found[0].detail, undefined);
    assert.equal(found[1].detail, 'exit 3: line 4 ⏎ line 5 ⏎ line 6 ⏎ line 7 ⏎ line 8 ⏎ to stderr');
    assert.equal(found[2].detail, 'exit 1: advisory');
    assert.equal(found[3].detail, 'stopped after 0.3 s: started');
    const log = JSON.parse(readFileSync(`${tmp}/code.json`, 'utf8'));
    assert.deepEqual([log.passes, log.fails.code, log.fails.out.split('\n')[0]], [{ code: 0, out: 'fine\n' }, 3, 'line 1']);
});

test('routes: every parameter style becomes a matcher', () => {
    const hits = (path: string, yes: string[], no: string[]) => {
        for (const u of yes) assert.ok(matcher(path).test(u), `${path} should match ${u}`);
        for (const u of no) assert.ok(!matcher(path).test(u), `${path} should not match ${u}`);
    };
    hits('/users/{id}', ['/users/7', '/users/7/'], ['/users', '/users/7/edit']);
    hits('users/{user}/posts/{post?}', ['/users/7/posts', '/users/7/posts/9'], ['/users/7', '/users/7/posts/9/x']);
    hits('items/<int:pk>/', ['/items/3', '/items/3/'], ['/items/', '/items/3/4']);
    hits('/items/<pk>/edit', ['/items/abc/edit'], ['/items/edit']);
    hits('/files/<path:rest>', ['/files/a/b/c.txt'], ['/files']);
    hits('/orders/:id', ['/orders/12'], ['/orders', '/orders/12/items']);
    hits('/orders/:id?', ['/orders', '/orders/12'], ['/orders/12/items']);
    hits('/posts/:id(.:format)', ['/posts/1', '/posts/1.json'], ['/posts', '/posts/1/json']);
    hits('/assets/*splat', ['/assets/css/site.css'], ['/assets']);
    hits('/docs/*', ['/docs/a/b'], ['/doc']);
    hits('/v1.2/health', ['/v1.2/health'], ['/v1x2/health']);
    hits('/', ['/'], ['/x']);
    assert.deepEqual(['/a/b', '/a/{id}', '/a/<pk>', '/a/:id', '/a(.:format)', '/a/*x'].map(hasParams), [false, true, true, true, true, true]);
});

test('routes: the command output, coverage, and the sign-in check', async () => {
    assert.deepEqual(parse('[{"method":"GET|HEAD","path":"users/{id}","auth":true},{"method":["post","OPTIONS"],"path":"/users"}]'),
        [{ method: 'GET', path: '/users/{id}', auth: true }, { method: 'POST', path: '/users' }]);
    assert.throws(() => parse('Warning: deprecated\n[]'), /routes: the command did not print JSON/);
    assert.throws(() => parse('{"routes":[]}'), /must print a JSON list/);
    assert.throws(() => parse('[{"path":"/x"}]'), /entry 0 needs a method and a path/);

    const list = [{ method: 'GET', path: '/' }, { method: 'GET', path: '/users/{id}' }, { method: 'GET', path: '/reports/:id/pdf' }, { method: 'POST', path: '/users' }];
    assert.deepEqual(coverage(list, ['/', '/users/42', '/users/43', '/about']), { total: 3, missed: ['/reports/:id/pdf'] });

    // The command runs once per run, from the config file's folder; writing routes without sign-in are a warning unless public on purpose.
    writeFileSync(`${tmp}/routes.json`, JSON.stringify([{ method: 'GET', path: '/', auth: false }, { method: 'POST', path: '/login', auth: false },
        { method: 'POST', path: '/webhooks/pay', auth: false }, { method: 'DELETE', path: '/users/{id}', auth: false }, { method: 'PUT', path: '/users/{id}', auth: true }]));
    const cfg = check({ baseUrl: 'http://x', routes: `echo ran >> ${tmp}/ran.txt; cat routes.json`, security: { publicWrites: '^/(login|webhooks/)' } }, tmp);
    const found: Omit<Finding, 'side'>[] = [];
    await code.run(cfg, tmp, (f) => { found.push(f); });
    assert.deepEqual(found, [{ suite: 'code', where: 'routes', check: 'state-changing routes need sign-in', status: 'warn', detail: 'DELETE /users/{id}' }]);
    assert.equal(routes(cfg).length, 5);
    assert.equal(readFileSync(`${tmp}/ran.txt`, 'utf8'), 'ran\n');
});
