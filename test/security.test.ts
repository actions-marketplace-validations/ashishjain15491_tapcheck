import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { closeBrowser, type Run } from '../src/browser.ts';
import { check } from '../src/config.ts';
import type { Finding } from '../src/report.ts';
import * as security from '../src/suites/security.ts';

after(closeBrowser);

test('security: a session kept outside cookies is a note, a session cookie without its flags still fails', async () => {
    const tmp = mkdtempSync(`${tmpdir()}/tapcheck-security-`);
    const cfg = check({ baseUrl: 'http://127.0.0.1:9', sides: { member: { login: 'manual' } }, viewports: [{ name: 'desktop', width: 800, height: 600 }] }, tmp);
    const flags = async (cookies: object[]) => {
        writeFileSync(`${tmp}/auth.json`, JSON.stringify({ cookies, origins: [] }));
        const found: Omit<Finding, 'side'>[] = [];
        // No crawled pages: nothing is requested, only the saved session is read.
        await security.run({ cfg, side: cfg.sides[0], dir: tmp, auth: `${tmp}/auth.json`, record: (f) => { found.push(f); }, crawl: { pages: [], hits: [], done: true } } as Run);
        return found.filter((f) => f.check === 'session cookie flags').map((f) => [f.where, f.status, f.detail]);
    };
    const cookie = { name: 'theme', value: 'dark', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' };
    assert.deepEqual((await flags([cookie])).map((f) => [f[0], f[1]]), [['cookies', 'info']]);
    assert.match((await flags([cookie]))[0][2]!, /^no session cookie to check/);
    assert.deepEqual(await flags([{ ...cookie, name: 'app_session' }]), [['cookie app_session', 'fail', 'not HttpOnly']]);
});
