import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { check, expand, isLocal } from '../src/config.ts';
import { totp } from '../src/auth.ts';
import { endpoint, shape } from '../src/suites/contract.ts';
import { leaksIn } from '../src/suites/security.ts';
import { findings, record, write } from '../src/report.ts';

test('config: defaults for a bare public site', () => {
    const c = check({ baseUrl: 'http://localhost:8000/' });
    assert.equal(c.baseUrl, 'http://localhost:8000');
    assert.deepEqual(c.sides.map((s) => s.name), ['public']);
    assert.ok('none' in c.sides[0].login);
    assert.equal(c.crawl.max, 60);
    assert.ok(c.crawl.skip.test('/logout'));
    assert.ok(c.loginPaths.test('/users/sign-in'));
    assert.equal(c.viewports.length, 2);
});

test('config: screens per side, login kinds, csrf', () => {
    const c = check({
        baseUrl: 'http://localhost:3000',
        sides: { customer: { login: { form: { url: '/login', fields: { email: 'a@example.com', password: 'x' } } } }, staff: { baseUrl: 'http://admin.localhost:3000', login: 'manual' } },
        screens: { customer: [{ name: 'Home', path: '/home' }], staff: [{ name: 'User', from: '/users', link: '^/users/\\d+$' }] },
        security: { csrf: { path: '/api/probe', expect: 403 } },
    });
    assert.equal(c.sides[1].baseUrl, 'http://admin.localhost:3000');
    assert.deepEqual(c.sides[1].login, { manual: '/login' });
    assert.equal(c.sides[0].screens[0].path, '/home');
    assert.deepEqual(c.security.csrf, { method: 'POST', path: '/api/probe', expect: 403 });
});

test('config: errors name the field', () => {
    assert.throws(() => check({}), /baseUrl must be a non-empty string/);
    assert.throws(() => check({ baseUrl: 'localhost' }), /baseUrl must be an http\(s\) URL/);
    assert.throws(() => check({ baseUrl: 'http://x', screens: [{ name: 'A' }] }), /screens\[0\] needs a path/);
    assert.throws(() => check({ baseUrl: 'http://x', screens: { admin: [] } }), /screens\.admin names a side/);
    assert.throws(() => check({ baseUrl: 'http://x', sides: { a: { login: { form: { url: '/l' } } } } }), /form\.fields must map/);
    assert.throws(() => check({ baseUrl: 'http://x', sides: { a: { login: { magic: 1 } } } }), /unknown kind "magic"/);
    assert.throws(() => check({ baseUrl: 'http://x', crawl: { skip: '(' } }), /crawl\.skip is not a valid regular expression/);
    assert.throws(() => check({ baseUrl: 'http://x', security: { csrf: { path: '/p' } } }), /csrf\.expect must be/);
});

test('config: $VARS come from the environment, missing ones fail', () => {
    process.env.TAPCHECK_TEST_PW = 's3cret';
    assert.deepEqual(expand({ a: ['$TAPCHECK_TEST_PW', 'x${TAPCHECK_TEST_PW}y'] }), { a: ['s3cret', 'xs3crety'] });
    assert.throws(() => expand({ p: '$TAPCHECK_NOT_SET_ANYWHERE' }), /p: environment variable TAPCHECK_NOT_SET_ANYWHERE is not set/);
});

test('reset guard: only local hosts', () => {
    for (const u of ['http://localhost:8000', 'http://127.0.0.1', 'http://app.localhost', 'http://shop.test']) assert.ok(isLocal(u), u);
    for (const u of ['https://example.com', 'http://staging.example.com', 'http://localhost.example.com']) assert.ok(!isLocal(u), u);
});

test('totp: RFC 6238 SHA-1 vector', () => {
    // Secret "12345678901234567890" in base32; at T=59 s the 8-digit code is 94287082, so the 6-digit one is 287082.
    assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000), '287082');
});

test('contract: ids normalised, shapes keyed', () => {
    assert.equal(endpoint('GET', 'http://x/reports/123/stats?x=1'), 'GET /reports/{id}/stats');
    assert.equal(endpoint('GET', 'http://x/a/01m7azs8q2k3v4b5n6m7p8r9/b'), 'GET /a/{id}/b');
    assert.equal(endpoint('POST', 'http://x/u/3f2504e0-4f89-11d3-9a0c-0305e82c3301'), 'POST /u/{id}');
    assert.equal(endpoint('GET', 'http://x/settings/account'), 'GET /settings/account');
    assert.deepEqual(shape('{"b":1,"a":2}'), ['a', 'b']);
    assert.deepEqual(shape('[1]'), ['[array]']);
    assert.equal(shape('nope'), null);
});

test('security: secret patterns', () => {
    assert.deepEqual(leaksIn('key = "AKIAABCDEFGHIJKLMNOP"'), ['AWS access key']);
    assert.deepEqual(leaksIn('-----BEGIN RSA PRIVATE KEY-----'), ['private key']);
    assert.deepEqual(leaksIn('nothing to see, sk-short'), []);
});

test('report: failures first, counts per suite, REPORT.md', () => {
    const dir = mkdtempSync(`${tmpdir()}/tapcheck-test-`);
    findings.length = 0;
    record({ suite: 'crawl', side: 'public', where: '/', check: 'page answers', status: 'pass' });
    record({ suite: 'crawl', side: 'public', where: '/x', check: 'page answers', status: 'fail', detail: '500' });
    record({ suite: 'a11y', side: 'public', where: 'Home', check: 'axe', status: 'warn' });
    const { bySuite, fails } = write(dir, { base: 'http://localhost', started: Date.now() });
    assert.equal(fails, 1);
    assert.deepEqual(bySuite.find((b) => b.s === 'crawl'), { s: 'crawl', pass: 1, fail: 1, warn: 0, total: 2 });
    const md = readFileSync(`${dir}/REPORT.md`, 'utf8');
    assert.match(md, /## Failing\n\n- \*\*crawl\*\* · \/x · page answers: 500/);
    const html = readFileSync(`${dir}/report.html`, 'utf8');
    assert.ok(html.indexOf('tag fail') < html.indexOf('tag pass'));
});
