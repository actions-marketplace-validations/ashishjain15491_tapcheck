import { cookieProblems } from '../src/suites/security.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { check, expand, isLocal } from '../src/config.ts';
import { off, totp } from '../src/auth.ts';
import { UNSAFE } from '../src/suites/usability.ts';
import { expected } from '../src/report.ts';
import { guard, SessionExpired, site, type Hit, type Run } from '../src/browser.ts';
import * as contract from '../src/suites/contract.ts';
import { endpoint, shape } from '../src/suites/contract.ts';
import { leaksIn } from '../src/suites/security.ts';
import { findings, record, write, type Finding } from '../src/report.ts';

test('config: defaults for a bare public site', () => {
    const c = check({ baseUrl: 'http://localhost:8000/' });
    assert.equal(c.baseUrl, 'http://localhost:8000');
    assert.deepEqual(c.sides.map((s) => s.name), ['public']);
    assert.ok('none' in c.sides[0].login);
    assert.equal(c.crawl.max, 60);
    assert.ok(c.crawl.skip.test('/logout'));
    assert.ok(c.loginPaths.test('/users/sign-in'));
    assert.equal(c.viewports.length, 2);
    assert.deepEqual(c.devices, ['desktop', 'tablet', 'mobile']);
});

test('config: devices picks the kinds of device, from the viewports and DEVICES', () => {
    const base = 'http://localhost:8000';
    assert.deepEqual(check({ baseUrl: base, devices: ['desktop'] }).viewports.map((v) => v.name), ['desktop']);
    assert.deepEqual(check({ baseUrl: base, devices: 'desktop, mobile' }).viewports.map((v) => v.name), ['desktop', 'mobile']);
    assert.deepEqual(check({ baseUrl: base, devices: ['tablet'] }).viewports.map((v) => [v.name, v.width]), [['tablet', 768]], 'the defaults have no tablet');
    const own = [{ name: 'wide', width: 1280, height: 800 }, { name: 'pad', width: 820, height: 1180 }, { name: 'phone', width: 390, height: 844, mobile: true }];
    assert.deepEqual(check({ baseUrl: base, devices: ['tablet', 'mobile'], viewports: own }).viewports.map((v) => v.name), ['pad', 'phone']);
    assert.throws(() => check({ baseUrl: base, devices: ['watch'] }), /devices must be all, or one or more of desktop, tablet, mobile/);
    assert.throws(() => check({ baseUrl: base, devices: ['tablet'], viewports: [own[0]] }), /devices none of the viewports is a tablet/);
    process.env.DEVICES = 'mobile';
    try {
        const c = check({ baseUrl: base, devices: ['desktop'] });
        assert.deepEqual([c.devices, c.viewports.map((v) => v.name)], [['mobile'], ['mobile']]);
    } finally {
        delete process.env.DEVICES;
    }
});

test('config: screens per side, login kinds, csrf', () => {
    const c = check({
        baseUrl: 'http://localhost:3000',
        sides: { customer: { login: { form: { url: '/login', fields: { email: 'a@example.com', password: 'x' } } } }, staff: { baseUrl: 'http://admin.localhost:3000', login: 'manual', csrf: { method: 'patch', path: '/admin/users/1', expect: 419 } } },
        screens: { customer: [{ name: 'Home', path: '/home' }], staff: [{ name: 'User', from: '/users', link: '^/users/\\d+$' }] },
        security: { csrf: { path: '/api/probe', expect: 403 } },
    });
    assert.equal(c.sides[1].baseUrl, 'http://admin.localhost:3000');
    assert.deepEqual(c.sides[1].login, { manual: '/login' });
    assert.equal(c.sides[0].screens[0].path, '/home');
    assert.deepEqual(c.security.csrf, { method: 'POST', path: '/api/probe', expect: 403 });
    assert.deepEqual(c.sides[1].csrf, { method: 'PATCH', path: '/admin/users/1', expect: 419 });
    assert.equal(c.sides[0].csrf, undefined);
});

test('config: errors name the field', () => {
    assert.throws(() => check({}), /baseUrl must be a non-empty string/);
    assert.throws(() => check({ baseUrl: 'localhost' }), /baseUrl must be an http\(s\) URL/);
    assert.throws(() => check({ baseUrl: 'http://x', screens: [{ name: 'A' }] }), /screens\[0\] needs a path/);
    assert.throws(() => check({ baseUrl: 'http://x', screens: { admin: [] } }), /screens\.admin names a side/);
    assert.throws(() => check({ baseUrl: 'http://x', sides: { a: { login: { form: { url: '/l' } } } } }), /form\.fields must map/);
    assert.throws(() => check({ baseUrl: 'http://x', sides: { a: { login: { magic: 1 } } } }), /unknown kind "magic"/);
    assert.throws(() => check({ baseUrl: 'http://x', sides: { jev: {} } }), /sides\.jev name can't be a suite or tag name/);
    assert.throws(() => check({ baseUrl: 'http://x', crawl: { skip: '(' } }), /crawl\.skip is not a valid regular expression/);
    assert.throws(() => check({ baseUrl: 'http://x', security: { csrf: { path: '/p' } } }), /csrf\.expect must be/);
    assert.throws(() => check({ baseUrl: 'http://x', sides: { a: { csrf: { path: '/p', expect: 'x' } } } }), /sides\.a\.csrf\.expect must be/);
    assert.throws(() => check({ baseUrl: 'http://x', changes: ['src/**'] }), /changes must map a suite name/);
    assert.throws(() => check({ baseUrl: 'http://x', changes: { e2e: ['src/**'] } }), /changes\.e2e names a suite that doesn't exist/);
    assert.doesNotThrow(() => check({ baseUrl: 'http://x', changes: { 'flow-checkout': ['src/**'], 'a11y-public': ['src/**'] } }));
    assert.equal(check({ baseUrl: 'http://x' }).parallel, 1);
    assert.equal(check({ baseUrl: 'http://x', parallel: 4 }).parallel, 4);
    assert.throws(() => check({ baseUrl: 'http://x', parallel: 0 }), /parallel must be a whole number from 1 to 32/);
    assert.throws(() => check({ baseUrl: 'http://x', parallel: 2.5 }), /parallel must be a whole number/);
    assert.throws(() => check({ baseUrl: 'http://x', changes: { ux: 'src/**' } }), /changes\.ux must be a list of globs/);
    assert.throws(() => check({ baseUrl: 'http://x', changes: { '*': ['src/**', ''] } }), /changes\.\*\[1\] must be a non-empty string/);
    assert.deepEqual(check({ baseUrl: 'http://x', changes: { '*': ['src/**'], a11y: ['**/*.css'] } }).changes, { '*': ['src/**'], a11y: ['**/*.css'] });
    assert.deepEqual(check({ baseUrl: 'http://x' }).changes, {});
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

test('sign-in: done only back on the side\'s own site, off every sign-in path', () => {
    const cfg = check({ baseUrl: 'https://app.example.com' });
    const side = cfg.sides[0];
    assert.ok(off(cfg, side, 'https://app.example.com/dashboard'));
    assert.ok(!off(cfg, side, 'https://app.example.com/login'));
    // An OAuth provider's consent page is off every sign-in path, but not signed in yet.
    assert.ok(!off(cfg, side, 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x'));
    assert.ok(!off(cfg, side, 'https://discord.com/oauth2/authorize'));
});

test('unsafe: settings a click would change on the account are never clicked', () => {
    for (const l of ['Delete', 'Sign out', 'Dark mode', 'Switch to light mode', 'Theme']) assert.ok(UNSAFE.test(l), l);
    for (const l of ['Scanner', 'Heatmap', 'Open chart']) assert.ok(!UNSAFE.test(l), l);
});

test('expect: a matching fail or warn is kept as info with its reason; others are untouched', () => {
    const cfg = check({ baseUrl: 'http://x', context: 'a trading tool', expect: [{ match: '^audit: text is not cut off @ Market map', why: 'tiles shorten tickers' }] });
    assert.equal(cfg.context, 'a trading tool');
    const f = { suite: 'audit', side: 'member', where: 'Market map · desktop', check: 'text is not cut off', status: 'fail' as const, detail: '22: "MPWR"' };
    assert.deepEqual(expected(f, cfg.expect), { ...f, status: 'info', detail: 'expected: tiles shorten tickers (was fail: 22: "MPWR")' });
    for (const other of [{ ...f, where: 'Home · desktop' }, { ...f, status: 'pass' as const }, { ...f, suite: 'a11y' }]) assert.deepEqual(expected(other, cfg.expect), other);
    assert.deepEqual(check({ baseUrl: 'http://x' }).expect, []);
    assert.throws(() => check({ baseUrl: 'http://x', expect: { match: 'x' } }), /expect must be a list of \{match, why\}/);
    assert.throws(() => check({ baseUrl: 'http://x', expect: [{ match: '(', why: 'x' }] }), /expect\[0\]\.match is not a valid regular expression/);
    assert.throws(() => check({ baseUrl: 'http://x', expect: [{ match: 'x' }] }), /expect\[0\]\.why/);
});

test('contract: ids normalised, shapes keyed', () => {
    assert.equal(endpoint('GET', 'http://x/reports/123/stats?x=1'), 'GET /reports/{id}/stats');
    assert.equal(endpoint('GET', 'http://x/a/01m7azs8q2k3v4b5n6m7p8r9/b'), 'GET /a/{id}/b');
    assert.equal(endpoint('POST', 'http://x/u/3f2504e0-4f89-11d3-9a0c-0305e82c3301'), 'POST /u/{id}');
    assert.equal(endpoint('GET', 'http://x/settings/account'), 'GET /settings/account');
    // A call to the app's API on another host is named with that host; one to its own host is not.
    assert.equal(endpoint('GET', 'https://api.shop.com/orders/7', 'https://app.shop.com'), 'GET api.shop.com/orders/{id}');
    assert.equal(endpoint('GET', 'https://app.shop.com/orders/7', 'https://app.shop.com'), 'GET /orders/{id}');
    // A ticker or a code in capitals is an id; a word in the path is not.
    assert.equal(endpoint('GET', 'http://x/api/strikes/SPY'), endpoint('GET', 'http://x/api/strikes/TSLA'));
    assert.equal(endpoint('GET', 'http://x/api/strikes/spy'), 'GET /api/strikes/spy');
});

test('contract: latency by host, shapes from every response, and a baseline that fills', async () => {
    const out = mkdtempSync(`${tmpdir()}/tapcheck-contract-`);
    const found: Omit<Finding, 'side'>[] = [];
    const hit = (url: string, keys?: string[], ms = 50) => ({ url, method: 'GET', type: 'fetch', status: 200, contentType: 'application/json', ms, bytes: 900, page: '/', json: 'ok' as const, keys });
    const run = (hits: Hit[]) => { found.length = 0; return contract.run({ cfg: { out }, side: { name: 'public', baseUrl: 'https://app.shop.com' }, record: (f: Omit<Finding, 'side'>) => { found.push(f); }, crawl: { pages: [], hits, done: true } } as unknown as Run); };
    const at = (where: string) => found.filter((f) => f.where === where && /p95|shape/.test(f.check)).map((f) => [f.check, f.status, f.detail]);
    const saved = () => JSON.parse(readFileSync(`${out}/contract-public.json`, 'utf8'));
    writeFileSync(`${out}/contract-public.json`, '{}'); // a baseline an earlier run left empty

    // 20 calls to the API host at 1.5 s: fine for a remote API. One slow call to the app's own host is too few for a p95.
    // /access answers a list or an object, by its query; /orders has its keys from the whole body.
    await run([...Array.from({ length: 20 }, () => hit('https://api.shop.com/orders', ['id', 'total'], 1500)), hit('https://app.shop.com/me', ['name'], 900),
        hit('https://api.shop.com/access?all=1', ['[array]']), hit('https://api.shop.com/access', ['plan'])]);
    assert.deepEqual(at('XHR/fetch'), [['p95 latency under 800 ms', 'info', 'too few calls for a p95 (1 call, slowest 900 ms)']]);
    assert.deepEqual(at('XHR/fetch to api.shop.com'), [['p95 latency under 2000 ms', 'pass', 'p95 1500 ms over 22 calls to api.shop.com']]);
    assert.deepEqual(at('GET api.shop.com/orders'), [['response shape', 'info', 'new endpoint, added to the baseline: id, total']]);
    assert.deepEqual(saved(), { 'GET api.shop.com/orders': ['id', 'total'], 'GET /me': ['name'], 'GET api.shop.com/access': ['[array]', 'plan'] });

    // The next run compares: a key gone fails, a list-or-object endpoint isn't compared, a slow API warns, and a key that
    // one response has and another lacks counts as there. An endpoint in the baseline keeps its keys.
    await run([...Array.from({ length: 19 }, () => hit('https://api.shop.com/orders', ['id'], 2500)), hit('https://api.shop.com/orders', ['id', 'tax'], 2500),
        hit('https://app.shop.com/me', ['[array]']), hit('https://api.shop.com/access', ['plan'])]);
    assert.deepEqual(at('XHR/fetch to api.shop.com')[0].slice(0, 2), ['p95 latency under 2000 ms', 'warn']);
    assert.deepEqual(at('GET api.shop.com/orders'), [['response shape', 'fail', 'removed: total · added: tax']]);
    assert.deepEqual(at('GET api.shop.com/access'), [['response shape', 'info', 'answers a list to some calls and an object to others: not compared']]);
    assert.deepEqual(at('GET /me').map((f) => f.slice(0, 2)), [['response shape', 'warn']]);
    assert.deepEqual(saved()['GET api.shop.com/orders'], ['id', 'total']);
});

test("site: an app's subdomains are one site; a shared host, an IP and localhost are not", () => {
    assert.equal(site('https://app.shop.com/x'), site('https://api.shop.com/y'));
    assert.equal(site('https://www.shop.co.uk'), 'shop.co.uk');
    assert.equal(site('https://api.abc.io'), site('https://app.abc.io')); // a short name under a two-letter ending is still one site
    assert.equal(site('https://app.cal.ai/x'), 'cal.ai');
    assert.equal(site('https://www.shop.com.au'), 'shop.com.au');
    assert.notEqual(site('https://mine.vercel.app'), site('https://theirs.vercel.app'));
    assert.notEqual(site('http://a.localhost:3000'), site('http://b.localhost:3000'));
    assert.equal(site('http://127.0.0.1:8000'), '127.0.0.1');
    assert.notEqual(site('https://app.shop.com'), site('https://shop.io'));
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
    record({ suite: 'ux', side: 'public', where: 'ux-public', check: 'part ran', status: 'info', detail: 'skipped (JEV=off).' });
    record({ suite: 'usability', side: 'public', where: 'usability-public', check: 'part ran', status: 'info', detail: 'skipped: no tasks for this side' });
    record({ suite: 'usability', side: 'public', where: 'usability-public', check: 'tasks', status: 'info', detail: '0 tasks' });
    record({ suite: 'contract', side: 'public', where: 'response shapes', check: 'baseline', status: 'info', detail: '3 endpoint shape(s) saved' });
    record({ suite: 'audit', side: 'public', where: 'Home', check: 'text fits', status: 'info', detail: 'expected: tiles shorten names (was fail: "Monstera…")' });
    const { bySuite, fails } = write(dir, { base: 'http://localhost', started: Date.now() });
    assert.equal(fails, 1);
    assert.deepEqual(bySuite.find((b) => b.s === 'crawl'), { s: 'crawl', pass: 1, fail: 1, warn: 0, total: 2, skipped: false, empty: false });
    assert.equal(bySuite.find((b) => b.s === 'ux')?.skipped, true);
    // Only info rows: skipped when one says so, nothing checked otherwise; a row an expect rule accepted was checked.
    assert.deepEqual(['usability', 'contract', 'audit'].map((s) => { const b = bySuite.find((x) => x.s === s)!; return [b.skipped, b.empty]; }), [[true, false], [false, true], [false, false]]);
    const md = readFileSync(`${dir}/REPORT.md`, 'utf8');
    assert.match(md, /## Failing\n\n- \*\*crawl\*\* · \/x · page answers: 500/);
    assert.match(md, /## Skipped\n\n(- .*\n)*- \*\*ux\*\* · ux-public · part ran: skipped \(JEV=off\)\./);
    assert.ok(md.includes('- **usability** · usability-public · part ran: skipped: no tasks for this side'), md);
    assert.ok(md.includes('## Expected\n\n- **audit** · Home · text fits: expected: tiles shorten names (was fail: "Monstera…")\n'), md);
    assert.ok(md.includes('| contract | — | — | — nothing checked — |') && md.includes('\n2 info rows in report.html.\n'), md);
    const html = readFileSync(`${dir}/report.html`, 'utf8');
    assert.ok(html.indexOf('tag fail') < html.indexOf('tag pass'));
    assert.match(html, /<b>ux<\/b><span class="n w">skipped<\/span>/);
    assert.match(html, /<b>contract<\/b><span class="n w">nothing checked<\/span>/);
    // Each suite card picks out its rows: the card and the rows carry the suite's name.
    assert.match(html, /<button type="button" class="card" data-s="usability" title="Show only usability"><b>usability<\/b>/);
    assert.match(html, /<tr class="info" data-s="usability">/);
    assert.match(html, /<p class="totals"><span class="f">1 failing<\/span> · <span class="w">1 warning<\/span> · <span class="p">\d+ passing<\/span> · \d+ info, in \d+ parts<\/p>/);
    assert.ok(html.includes('id="q"') && html.includes('split(/\\s+/)'), 'the search box, and its regex survives the template');
});

test('session guard: LOGIN=1 is suggested on a manual side only', () => {
    const run = (login: unknown) => ({ cfg: check({ baseUrl: 'http://127.0.0.1:1' }), side: { name: 'staff', login } }) as unknown as Run;
    const landed = 'http://127.0.0.1:1/login';
    assert.throws(() => guard(run({ manual: '/login' }), '/orders', landed), (e) => e instanceof SessionExpired && /run again with LOGIN=1/.test(e.message));
    assert.throws(() => guard(run({ form: {} }), '/orders', landed), (e) => e instanceof SessionExpired && !/LOGIN=1/.test(e.message));
    guard(run({ form: {} }), '/login', landed); // asked for the sign-in page itself: not an expiry
    guard(run({ none: true }), '/orders', landed); // a side that doesn't sign in
});

test('security: cookie flags, a CSRF token cookie may be read by script', () => {
    const c = { name: 'app_session', httpOnly: false, sameSite: 'None', secure: false };
    assert.deepEqual(cookieProblems(c, true), ['not HttpOnly', 'SameSite=None', 'not Secure']);
    assert.deepEqual(cookieProblems({ ...c, name: 'XSRF-TOKEN', sameSite: 'Lax' }, false), []);
    assert.deepEqual(cookieProblems({ ...c, name: 'csrftoken', sameSite: 'Strict' }, true), ['not Secure']);
});
