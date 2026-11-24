import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { check } from '../src/config.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const schema = JSON.parse(read('../schema/tapcheck.schema.json'));

/** The part of JSON Schema draft-07 the tapcheck schema uses; an unknown keyword is an error, so the schema can't outgrow it unnoticed. */
function errors(s: any, v: unknown, at = 'tapcheck.yml'): string[] {
    if ('$ref' in s) s = { ...s, ...schema.definitions[s.$ref.replace('#/definitions/', '')], $ref: undefined };
    const out: string[] = [], bad = (msg: string) => { out.push(`${at} ${msg}`); };
    const obj = v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    const is = (t: string) => (t === 'array' ? Array.isArray(v) : t === 'null' ? v === null : t === 'object' ? !!obj : t === 'integer' ? Number.isInteger(v) : typeof v === t);
    for (const [k, x] of Object.entries(s) as [string, any][]) {
        if (x === undefined || ['$schema', '$id', 'title', 'description', 'default', 'definitions'].includes(k)) continue;
        else if (k === 'type') { if (![x].flat().some(is)) bad(`must be ${[x].flat().join(' or ')}`); }
        else if (k === 'enum') { if (!x.includes(v)) bad(`must be one of ${x.join(', ')}`); }
        else if (k === 'pattern') { if (typeof v === 'string' && !new RegExp(x).test(v)) bad(`must match ${x}`); }
        else if (k === 'minimum') { if (typeof v === 'number' && v < x) bad(`must be at least ${x}`); }
        else if (k === 'maximum') { if (typeof v === 'number' && v > x) bad(`must be at most ${x}`); }
        else if (k === 'exclusiveMinimum') { if (typeof v === 'number' && v <= x) bad(`must be above ${x}`); }
        else if (k === 'minItems') { if (Array.isArray(v) && v.length < x) bad(`needs at least ${x} item(s)`); }
        else if (k === 'minProperties') { if (obj && Object.keys(obj).length < x) bad(`needs at least ${x} key(s)`); }
        else if (k === 'required') { if (obj) for (const r of x) if (!(r in obj)) bad(`needs ${r}`); }
        else if (k === 'items') { if (Array.isArray(v)) v.forEach((e, i) => out.push(...errors(x, e, `${at}[${i}]`))); }
        else if (k === 'properties') { if (obj) for (const [p, ps] of Object.entries(x)) if (p in obj) out.push(...errors(ps, obj[p], `${at}.${p}`)); }
        else if (k === 'propertyNames') { if (obj) for (const p of Object.keys(obj)) out.push(...errors(x, p, `${at}: key ${p}`)); }
        else if (k === 'additionalProperties') {
            if (obj) for (const p of Object.keys(obj)) if (!(p in (s.properties ?? {}))) { if (x === false) bad(`has an unknown key ${p}`); else out.push(...errors(x, obj[p], `${at}.${p}`)); }
        }
        else if (k === 'anyOf') { if (!x.some((o: any) => !errors(o, v, at).length)) bad('matches none of anyOf'); }
        else if (k === 'oneOf') { const n = x.filter((o: any) => !errors(o, v, at).length).length; if (n !== 1) bad(`matches ${n} of oneOf, not 1`); }
        else if (k === 'not') { if (!errors(x, v, at).length) bad('matches what it must not'); }
        else throw new Error(`schema.test.ts doesn't know the keyword ${k} (at ${at})`);
    }
    return out;
}

const example = () => parse(read('../examples/static-site/tapcheck.yml'));

test('schema: the example tapcheck.yml and the configs in the docs are valid', () => {
    assert.deepEqual(errors(schema, example()), []);
    // Every key at once, as CONFIG.md shows them.
    const full = {
        baseUrl: 'http://127.0.0.1:8000', audience: 'a shop owner', loginPaths: '/login', out: '.tapcheck', routes: './bin/routes-json', flows: ['tests/tapcheck/*.ts'],
        app: { start: 'npm run dev', stop: 'docker compose down', ready: '/', timeout: 120, reset: './bin/reset', resetWhen: ['database/**'], allowRemoteReset: false },
        sides: { public: {}, guest: null, staff: { login: 'manual' }, admin: { login: { manual: '/admin/sign-in' } }, api: { login: { command: './bin/session' }, csrf: { method: 'PATCH', path: '/api/me', expect: 403 } },
            customer: { baseUrl: 'http://app.localhost:8000', login: { form: { url: '/login', fields: { email: '$TAPCHECK_EMAIL' }, submit: 'button', totp: { field: 'code', secret: '$TAPCHECK_TOTP' } } } } },
        screens: { customer: [{ name: 'Orders', path: '/orders', purpose: 'see past orders' }, { name: 'Order', from: '/orders', link: '^/orders/\\d+$', suffix: '/edit' }] },
        tasks: [{ name: 'Find', from: '/', goal: 'Find it.', done: 'It is open.', notDone: 'It is not.', optimal: 1, text: 'fern' }],
        crawl: { max: 60, skip: '/logout' }, security: { csrf: { method: 'POST', path: '/orders', expect: 419 }, allowedHosts: ['fonts.example.com'], publicWrites: '^/login' },
        viewports: [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844, mobile: true }],
        jev: { budget: 0.5, headers: { 'X-Team': 'web' } }, i18n: { keys: 'cat keys.txt' }, changes: { '*': ['src/**'], contract: ['api/**'], 'flow-checkout': ['app/Cart/**'] }, parallel: 4,
        gates: [{ name: 'lint', run: 'ruff check .' }, { name: 'audit', run: 'npm audit', warn: true, timeout: 120 }],
        stub: { port: 8766, rules: [{ host: 'api.example.com', method: 'POST', path: '/v1/charges', status: 201, json: { id: 'ch_1' }, headers: { 'x-a': 'b' }, delayMs: 200 }, { body: 'ok' }],
            dns: { port: 8767, defaultA: '203.0.113.7', records: [{ name: 'shop.example.com', type: 'MX', values: ['10 mx.example.com'] }, { name: 'shop.example.com', type: 'TXT', values: ['v=spf1 -all'] }] } },
        coverage: { file: 'docs/COVERAGE.md', reasons: [{ match: '^GET /admin/export', why: 'downloads are not followed' }] },
        mail: { mailpit: 'http://127.0.0.1:8025' }, browser: { args: ['--disable-features=LocalNetworkAccessChecks'] }, interact: { max: 40, submit: false }, audit: { max: 10, skip: '/(editor|canvas)(/|$)' },
        design: { colors: ['#1f2937', '#fff'], fonts: ['Inter'], radii: [0, 4, 8], spacing: [4, 8, 16] },
    };
    assert.deepEqual(errors(schema, full), []);
    assert.doesNotThrow(() => check(full)); // and src/config.ts takes the same file
});

test('schema: what src/config.ts refuses, the schema refuses too', () => {
    const wrong: [string, (c: any) => void][] = [
        ['baseUrl', (c) => { c.baseUrl = 'localhost:8000'; }], ['app.timeout', (c) => { c.app.timeout = 0; }], ['crawl.max', (c) => { c.crawl.max = 1.5; }],
        ['sides', (c) => { c.sides = { crawl: {} }; }], ['sides', (c) => { c.sides = { Admin: {} }; }], ['login', (c) => { c.sides = { a: { login: { form: { url: '/login', fields: {} } } } }; }],
        ['login', (c) => { c.sides = { a: { login: { manual: '/in', command: 'x' } } }; }], ['screens', (c) => { c.screens = [{ name: 'Orders', from: '/orders' }]; }],
        ['tasks', (c) => { c.tasks[0].optimal = 0; }], ['gates', (c) => { c.gates = [{ name: 'lint' }]; }], ['changes', (c) => { c.changes = { lint: ['src/**'] }; }],
        ['changes', (c) => { c.changes = { crawl: [] }; }], ['stub.port', (c) => { c.stub.port = 70000; }], ['stub.rules', (c) => { c.stub.rules = [{ json: {}, body: 'x' }]; }],
        ['interact.max', (c) => { c.interact = { max: 0 }; }], ['interact.submit', (c) => { c.interact = { submit: 'yes' }; }], ['audit.max', (c) => { c.audit = { max: -1 }; }],
        ['design.colors', (c) => { c.design = { colors: ['red'] }; }], ['design.radii', (c) => { c.design = { radii: ['4px'] }; }],
        ['app.resetWhen', (c) => { c.app = { resetWhen: ['database/**'] }; }], ['coverage.reasons', (c) => { c.coverage = { reasons: [{ match: 'x' }] }; }],
        ['stub.dns.port', (c) => { c.stub.dns = { port: 0 }; }], ['stub.dns.records', (c) => { c.stub.dns = { records: [{ name: 'a.test', type: 'SRV', values: ['x'] }] }; }],
        ['stub.dns.defaultA', (c) => { c.stub.dns = { defaultA: 'localhost' }; }],
        ['jev.budget', (c) => { c.jev = { budget: 0 }; }], ['viewports', (c) => { c.viewports = []; }], ['security.csrf', (c) => { c.security = { csrf: { path: '/orders' } }; }],
        ['browser.args', (c) => { c.browser = { args: ['headless'] }; }],
    ];
    for (const [name, change] of wrong) {
        const c = example();
        change(c);
        assert.throws(() => check(c), /tapcheck\.yml/, `config.ts accepted a wrong ${name}`);
        assert.notDeepEqual(errors(schema, c), [], `the schema accepted a wrong ${name}`);
    }
    // A misspelt key is ignored by the CLI; the schema is where an editor catches it.
    assert.match(errors(schema, { ...example(), baseURL: 'x' }).join(), /unknown key baseURL/);
});

test('schema: every key and default is the one src/config.ts has', () => {
    const cfg: any = check({ baseUrl: 'http://127.0.0.1:1', stub: { dns: {} }, gates: [{ name: 'a', run: 'b' }] });
    const p = schema.properties;
    // Config has every key plus `root` (the file's folder); screens and tasks end up inside its sides.
    assert.deepEqual(Object.keys(p).sort(), [...Object.keys(cfg).filter((k) => k !== 'root'), 'screens', 'tasks'].sort());
    assert.equal(p.app.properties.ready.default, cfg.app.ready);
    assert.equal(p.app.properties.timeout.default, cfg.app.timeout);
    assert.equal(p.audience.default, cfg.audience);
    assert.equal(p.out.default, cfg.out);
    assert.equal(p.crawl.properties.max.default, cfg.crawl.max);
    assert.equal(p.crawl.properties.skip.default, cfg.crawl.skip.source.replace(/\\\//g, '/'));
    assert.equal(p.loginPaths.default, cfg.loginPaths.source.replace(/\\\//g, '/'));
    assert.equal(p.interact.properties.max.default, cfg.interact.max);
    assert.equal(p.interact.properties.submit.default, cfg.interact.submit);
    assert.equal(p.audit.properties.max.default, cfg.audit.max);
    assert.equal(p.jev.properties.budget.default, cfg.jev.budget);
    assert.equal(p.stub.properties.port.default, cfg.stub.port);
    assert.equal(p.stub.properties.dns.properties.port.default, cfg.stub.dns.port);
    assert.equal(p.coverage.properties.file.default, cfg.coverage.file);
    assert.deepEqual(p.app.properties.resetWhen.default, cfg.app.resetWhen);
    assert.equal(p.gates.items.properties.timeout.default, cfg.gates[0].timeout);
    assert.deepEqual(p.viewports.default, cfg.viewports);
    assert.deepEqual(Object.keys(p.sides.default), cfg.sides.map((s: any) => s.name));
});
