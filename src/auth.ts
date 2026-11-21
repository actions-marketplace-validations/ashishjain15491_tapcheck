/*
 * Signing in, per side, saved as a Playwright storageState under the out folder (git-ignored) that every suite reuses:
 *   none     no session (a public site)
 *   manual   a visible browser on the sign-in page; a person signs in (and passes 2FA); kept until LOGIN=1 or it expires
 *   form     fills the named fields, submits, and fills a TOTP code if the app asks for one; every run
 *   command  any program that prints a storageState JSON (for apps whose sign-in is easier to script in their own stack)
 */
import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import type { Config, Side } from './config.ts';

/** RFC 6238 time-based one-time code (SHA-1, 30 s, 6 digits) from a base32 secret. */
export function totp(secret: string, at = Date.now()): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const c of secret.replace(/=+$/, '').toUpperCase().replace(/\s/g, '')) {
        const i = alphabet.indexOf(c);
        if (i < 0) throw new Error('The TOTP secret is not base32.');
        bits += i.toString(2).padStart(5, '0');
    }
    const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
    const h = createHmac('sha1', key).update(counter).digest();
    const o = h[h.length - 1] & 0xf;
    return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** A field by CSS selector, else by name attribute, else by its label text. */
async function field(page: Page, key: string) {
    if (/^[#.[]|[\s=>]/.test(key)) return page.locator(key).first();
    const byName = page.locator(`[name="${key.replace(/"/g, '\\"')}"]`);
    return (await byName.count()) ? byName.first() : page.getByLabel(key, { exact: false }).first();
}

const off = (cfg: Config, u: string) => !cfg.loginPaths.test(new URL(u).pathname);

/** The side's saved session file, signing in first when needed; undefined for a side that doesn't sign in. */
export async function signIn(cfg: Config, side: Side): Promise<string | undefined> {
    const l = side.login;
    if ('none' in l) return undefined;
    mkdirSync(cfg.out, { recursive: true });
    const file = `${cfg.out}/auth-${side.name}.json`;
    const at = (p: string) => (/^https?:\/\//.test(p) ? p : side.baseUrl + p);

    if ('command' in l) {
        const out = execSync(l.command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: '/bin/sh' });
        let state;
        try { state = JSON.parse(out); } catch { throw new Error(`sides.${side.name}.login.command did not print JSON (a Playwright storageState).`); }
        if (!Array.isArray(state?.cookies)) throw new Error(`sides.${side.name}.login.command printed JSON without a cookies list.`);
        writeFileSync(file, JSON.stringify(state));
        return file;
    }

    if ('manual' in l) {
        if (existsSync(file) && process.env.LOGIN !== '1') return file;
        const browser = await chromium.launch({ headless: false });
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
        const page = await ctx.newPage();
        await page.goto(at(l.manual));
        console.log(`Sign in as ${side.name} in the browser window. Waiting up to 10 minutes…`);
        await page.waitForURL((u) => off(cfg, u.href), { timeout: 600_000 });
        await page.waitForLoadState('networkidle').catch(() => {});
        await ctx.storageState({ path: file });
        await browser.close();
        return file;
    }

    const f = l.form;
    const browser = await chromium.launch();
    try {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(at(f.url), { waitUntil: 'domcontentloaded' });
        for (const [k, v] of Object.entries(f.fields)) await (await field(page, k)).fill(v);
        const submit = () => page.locator(f.submit ?? 'button[type=submit], input[type=submit]').first().click();
        await submit();
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
        if (f.totp && !off(cfg, page.url())) {
            await (await field(page, f.totp.field)).fill(totp(f.totp.secret));
            await submit();
        }
        await page.waitForURL((u) => off(cfg, u.href), { timeout: 30_000 }).catch(() => {});
        if (!off(cfg, page.url())) {
            const shot = `${cfg.out}/login-${side.name}-failed.png`;
            await page.screenshot({ path: shot }).catch(() => {});
            throw new Error(`Signing in as ${side.name} left the browser on ${page.url()} (see ${shot}). Check sides.${side.name}.login.form.`);
        }
        await ctx.storageState({ path: file });
        return file;
    } finally {
        await browser.close();
    }
}
