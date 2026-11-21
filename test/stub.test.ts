import assert from 'node:assert/strict';
import { Resolver } from 'node:dns/promises';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { load, type StubRule } from '../src/config.ts';
import { match, start, target } from '../src/stub.ts';

const tmp = mkdtempSync(`${tmpdir()}/tapcheck-stub-`);
const rule = (r: Partial<StubRule>): StubRule => ({ status: 200, headers: {}, delayMs: 0, ...r });

test('stub: which outside host a request was meant for', () => {
    assert.deepEqual(target({ host: '127.0.0.1:8766', 'x-forwarded-host': 'API.Example.com:443, proxy' }, '/v1/x', 8766), { host: 'api.example.com', path: '/v1/x' });
    assert.deepEqual(target({ host: 'hooks.example.org' }, '/in', 8766), { host: 'hooks.example.org', path: '/in' });
    assert.deepEqual(target({ host: 'localhost:9999' }, '/in', 8766), { host: 'localhost', path: '/in' }); // another port isn't the stub's own
    assert.deepEqual(target({ host: '127.0.0.1:8766' }, '/api.example.com/v1/x', 8766), { host: 'api.example.com', path: '/v1/x' });
    assert.deepEqual(target({ host: 'localhost:8766' }, '/api.example.com', 8766), { host: 'api.example.com', path: '/' });
    assert.deepEqual(target({ host: '127.0.0.1:8766' }, '/_tapcheck/requests', 8766), { host: '', path: '/_tapcheck/requests' });
    assert.deepEqual(target({ host: '127.0.0.1:8766' }, '/v1.2/items', 8766), { host: '', path: '/v1.2/items' });
});

test('stub: the first matching rule wins', () => {
    const rules = [rule({ host: 'api.example.com', method: 'POST', path: '/v1/charges', status: 201 }), rule({ host: 'example.com', path: '/v1/*', status: 202 }),
        rule({ path: '^/hooks/\\d+$', status: 203 }), rule({ host: 'example.com', status: 204 })];
    const status = (host: string, method: string, path: string) => match(rules, host, method, path)?.status;
    assert.equal(status('api.example.com', 'POST', '/v1/charges'), 201);
    assert.equal(status('api.example.com', 'GET', '/v1/charges'), 202); // parent domain, glob
    assert.equal(status('api.example.com', 'GET', '/v1/charges/7'), 204); // * stops at a slash
    assert.equal(status('other.test', 'GET', '/hooks/12'), 203); // a path starting with ^ is a regular expression
    assert.equal(status('other.test', 'GET', '/hooks/x'), undefined);
    assert.equal(status('notexample.com', 'GET', '/v1/x'), undefined);
});

test('stub: rules, the fail switches, queued replies and the request log, over HTTP', async () => {
    writeFileSync(`${tmp}/plant.json`, '{"from":"file"}');
    const stub = await start({ port: 0, rules: [rule({ host: 'api.example.com', path: '/v1/plants/*', json: { name: 'fern' }, headers: { 'x-stub': 'yes' } }),
        rule({ host: 'api.example.com', path: '/v1/file', file: 'plant.json' }), rule({ host: 'api.example.com', path: '/v1/text', status: 418, body: 'teapot' })] }, tmp, tmp);
    after(() => stub.stop());
    const call = async (path: string, init: RequestInit = {}) => {
        const res = await fetch(stub.url + path, init);
        const text = await res.text();
        return { status: res.status, type: res.headers.get('content-type'), body: text && /json/.test(res.headers.get('content-type') ?? '') ? JSON.parse(text) : text, res };
    };
    const post = (path: string, body: unknown) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const api = '/api.example.com';

    // Rules, and 200 {} for everything else.
    const plant = await call(`${api}/v1/plants/7?size=s`, { headers: { authorization: 'Bearer not-a-real-token' } });
    assert.deepEqual([plant.status, plant.body, plant.res.headers.get('x-stub')], [200, { name: 'fern' }, 'yes']);
    assert.deepEqual((await call(`${api}/v1/file`)).body, { from: 'file' });
    assert.deepEqual([(await call(`${api}/v1/text`)).status, (await call(`${api}/v1/text`)).body], [418, 'teapot']);
    assert.deepEqual([(await call('/webhook')).status, (await call('/webhook', { headers: { 'x-forwarded-host': 'hooks.example.org' } })).body], [200, {}]);

    // "tapcheck-fail" in the URL or the body.
    assert.equal((await call(`${api}/v1/plants/tapcheck-fail`)).status, 500);
    assert.equal((await post(`${api}/v1/orders`, { note: 'please tapcheck-fail this' })).status, 500);

    // POST /_tapcheck/fail: `times` requests, then back to the rules; times 0 lasts until cleared.
    await post('/_tapcheck/fail', { host: 'api.example.com', path: '/plants', status: 503, body: { error: 'down' }, times: 2 });
    assert.equal((await call(`${api}/v1/text`)).status, 418, 'another path is untouched');
    assert.deepEqual([(await call(`${api}/v1/plants/1`)).status, (await call(`${api}/v1/plants/1`)).body, (await call(`${api}/v1/plants/1`)).status], [503, { error: 'down' }, 200]);
    await post('/_tapcheck/fail', { host: 'example.com' }); // default: once, 500
    assert.deepEqual([(await call(`${api}/v1/plants/1`)).status, (await call(`${api}/v1/plants/1`)).status], [500, 200]);
    await post('/_tapcheck/fail', { host: 'api.example.com', times: 0 });
    for (let i = 0; i < 3; i++) assert.equal((await call(`${api}/v1/plants/1`)).status, 500);
    await call('/_tapcheck/fail', { method: 'DELETE' });
    assert.equal((await call(`${api}/v1/plants/1`)).status, 200);

    // POST /_tapcheck/reply: one-off answers, in the order queued.
    await post('/_tapcheck/reply', { host: 'api.example.com', path: '/plants', status: 201, json: { name: 'first' } });
    await post('/_tapcheck/reply', { host: 'api.example.com', body: 'second' });
    assert.deepEqual([(await call(`${api}/v1/text`)).body, (await call(`${api}/v1/plants/1`)).body, (await call(`${api}/v1/plants/1`)).body], ['second', { name: 'first' }, { name: 'fern' }]);

    // The log: filters, no control requests, sign-in headers left out, and the same lines on disk.
    const t = Date.now() + 1;
    await new Promise((done) => setTimeout(done, 5));
    await post(`${api}/v1/orders?ref=9`, { plant: 7 });
    const seen = async (q: string) => (await call(`/_tapcheck/requests?${q}`)).body as any[];
    const all = await seen('');
    assert.ok(all.length > 15 && !all.some((s) => s.path.startsWith('/_tapcheck')));
    assert.deepEqual([all[0].host, all[0].path, all[0].query, all[0].status, all[0].headers.authorization], ['api.example.com', '/v1/plants/7', { size: 's' }, 200, undefined]);
    assert.deepEqual((await seen('host=hooks.example.org')).map((s) => s.path), ['/webhook']);
    assert.equal((await seen('host=example.com&path=/v1/text')).length, 4);
    const last = await seen(`since=${t}`);
    assert.deepEqual(last.map((s) => [s.method, s.host, s.path, s.query, s.body, s.status]), [['POST', 'api.example.com', '/v1/orders', { ref: '9' }, { plant: 7 }, 200]]);
    const lines = readFileSync(`${tmp}/stub-requests.jsonl`, 'utf8').trim().split('\n');
    assert.equal(lines.length, all.length);
    assert.ok(!lines[0].includes('not-a-real-token'));
    await call('/_tapcheck/requests', { method: 'DELETE' });
    assert.deepEqual(await seen(''), []);
    assert.equal((await call('/_tapcheck/nope')).status, 404);
});

test('stub: the port in use is an error naming stub.port', async () => {
    const one = await start({ port: 0, rules: [] }, tmp);
    after(() => one.stop());
    await assert.rejects(start({ port: Number(new URL(one.url).port), rules: [] }, tmp), /The stub can't listen on 127\.0\.0\.1:\d+ \(stub\.port\)/);
});

test('example: the static site\'s stub rule answers', async () => {
    const cfg = load(new URL('../examples/static-site/tapcheck.yml', import.meta.url).pathname);
    assert.equal(process.env.TAPCHECK_STUB_URL, `http://127.0.0.1:${cfg.stub!.port}`);
    const stub = await start({ ...cfg.stub!, port: 0 }, tmp, cfg.root);
    after(() => stub.stop());
    assert.deepEqual(await (await fetch(`${stub.url}/api.example.com/v1/plants/7`)).json(), { name: 'Boston fern', light: 'shade' });
    assert.deepEqual(await (await fetch(`${stub.url}/api.example.com/v2/other`)).json(), {});
});

test('stub: DNS over UDP answers the configured records, overrides from the control API, and the fail name', async () => {
    const long = `v=spf1 ${'include:spf.example.net '.repeat(12)}-all`; // past 255 bytes: sent as two strings
    const stub = await start({ port: 0, rules: [], dns: { port: 0, defaultA: '203.0.113.7', records: [
        { name: 'shop.example.com', type: 'A', values: ['192.0.2.10', '192.0.2.11'] }, { name: 'shop.example.com', type: 'AAAA', values: ['2001:db8::1'] },
        { name: 'shop.example.com', type: 'MX', values: ['20 mx.example.com', 'backup.example.com'] }, { name: 'shop.example.com', type: 'TXT', values: ['site-verification=abc', long] },
        { name: 'www.example.com', type: 'CNAME', values: ['shop.example.com'] }, { name: 'example.com', type: 'NS', values: ['ns1.example.net'] }] } }, tmp);
    after(() => stub.stop());
    const dns = new Resolver({ timeout: 2000, tries: 1 });
    dns.setServers([stub.dns!]);
    assert.deepEqual(await dns.resolve4('Shop.Example.com'), ['192.0.2.10', '192.0.2.11']);
    assert.deepEqual(await dns.resolve6('shop.example.com'), ['2001:db8::1']);
    assert.deepEqual((await dns.resolveMx('shop.example.com')).map((m) => [m.priority, m.exchange]), [[20, 'mx.example.com'], [10, 'backup.example.com']]);
    assert.deepEqual((await dns.resolveTxt('shop.example.com')).map((parts) => parts.join('')), ['site-verification=abc', long]);
    assert.deepEqual(await dns.resolveCname('www.example.com'), ['shop.example.com']);
    assert.deepEqual(await dns.resolveNs('example.com'), ['ns1.example.net']);
    assert.deepEqual(await dns.resolve4('anything.example.org'), ['203.0.113.7']); // defaultA
    await assert.rejects(dns.resolveMx('anything.example.org'), { code: 'ENODATA' });
    await assert.rejects(dns.resolve4('tapcheck-fail.example.org'), { code: 'ENOTFOUND' });

    const set = (body: unknown, method = 'POST') => fetch(`${stub.url}/_tapcheck/dns`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined }).then((res) => res.status);
    assert.equal(await set({ name: 'shop.example.com', type: 'a', values: ['198.51.100.1'] }), 200);
    assert.equal(await set({ name: 'new.example.com', type: 'TXT', values: ['hello'] }), 200);
    assert.deepEqual(await dns.resolve4('shop.example.com'), ['198.51.100.1']);
    assert.deepEqual(await dns.resolveTxt('new.example.com'), [['hello']]);
    assert.equal(await set({ name: 'shop.example.com', type: 'A', values: null }), 200); // back to the config
    assert.deepEqual(await dns.resolve4('shop.example.com'), ['192.0.2.10', '192.0.2.11']);
    assert.equal(await set({ name: 'shop.example.com', type: 'A', values: ['not an address'] }), 400);
    assert.equal(await set({ name: 'shop.example.com', type: 'SRV', values: ['x'] }), 400);
    assert.equal(await set(null, 'DELETE'), 200);
    await assert.rejects(dns.resolveTxt('new.example.com'), { code: 'ENODATA' });

    // Each question is in the request log, like a request.
    const seen = await (await fetch(`${stub.url}/_tapcheck/requests?host=tapcheck-fail.example.org`)).json();
    assert.deepEqual(seen.map((s: any) => [s.method, s.host, s.path, s.status]), [['DNS', 'tapcheck-fail.example.org', 'A', 3]]);

    // Without stub.dns there is no DNS to override, and tapcheck.yml hands the address on as TAPCHECK_DNS.
    const plain = await start({ port: 0, rules: [] }, tmp);
    after(() => plain.stop());
    assert.equal(plain.dns, undefined);
    assert.equal((await fetch(`${plain.url}/_tapcheck/dns`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"a.test","type":"A","values":["192.0.2.1"]}' })).status, 400);
    writeFileSync(`${tmp}/dns.yml`, 'baseUrl: http://127.0.0.1:1\nstub: { dns: { port: 8399 } }\napp: { start: "DNS=$TAPCHECK_DNS ./serve" }\n');
    assert.equal(load(`${tmp}/dns.yml`).app.start, 'DNS=127.0.0.1:8399 ./serve');
});
