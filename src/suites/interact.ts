/*
 * Interaction sweep (measured, no Jev). On each screen the crawl reached (at most interact.max), on the first
 * desktop-sized viewport:
 * - clicks every safe visible control (buttons, tabs, disclosures, in-app links) and checks that nothing breaks: no page
 *   or console error, no 5xx from the app, no native alert/confirm/prompt, and that the click did something (the DOM or
 *   the address changed, a request went out, something opened); a control that does nothing is a warning;
 * - every dialog a click opens (dialog[open], role=dialog, role=alertdialog): it has an accessible name, focus moves into
 *   it, Escape closes it, and one that deletes is an alertdialog. A form inside is given invalid input (required fields
 *   emptied, a malformed address in email fields, text past maxlength) and must show an error state: aria-invalid, a
 *   visible message, or the browser's own validation message;
 * - every table (table, role=grid): a sortable header, a search or filter box near it, the pager's next control and the
 *   first row's menu must each change the rows (or open) without an error; one that changes nothing is a warning.
 * interact.json records the controls, dialogs (by accessible name) and table controls that were exercised; the dialogs
 * and table controls also go into the side's hits.json, for the coverage map.
 *
 * Safety: never clicked are controls whose label matches the usability suite's UNSAFE words (delete, send, pay, sign
 * out…), links matching crawl.skip or leaving the app's host, unlabelled controls, and the submit button of a form that
 * POSTs. Native confirms are dismissed. A dialog form is submitted with invalid input only when that can't save: the
 * browser's validation refuses it, or the form doesn't POST. With interact.submit: true (and a local app, as for
 * app.reset) such forms are submitted anyway, and valid input after it: that changes data, so a throwaway database only.
 * ponytail: a button that saves on click through script alone can't be told from one that opens a menu; it is clicked.
 */
import { writeFileSync } from 'node:fs';
import type { Locator, Page } from 'playwright';
import { isLocal } from '../config.ts';
import { context, host, open, reach, SessionExpired, watch, type Run } from '../browser.ts';
import type { Finding } from '../report.ts';
import { UNSAFE } from './usability.ts';

const S = 'interact';
const MAX_CLICKS = 30; // per screen
const WAIT = 350; // ms for a click to show what it does
const DIALOG = 'dialog[open], [role=dialog], [role=alertdialog]';
const DESTRUCTIVE = /\b(delete|remove|destroy|discard|erase|revoke)/i;
const FIELDS = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=submit]):not([type=button]):not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled])';

type Control = { i: number; label: string; href: string };
type Status = Finding['status'];

/** Marks each safe, visible control with data-tapcheck and returns them. Of a table's rows only the first one's controls count. */
const tag = (page: Page, own: string, skip: RegExp): Promise<Control[]> => page.evaluate(({ own, unsafe, skip, DIALOG }) => {
    const no = new RegExp(unsafe, 'i'), skipped = new RegExp(skip, 'i');
    const out: { i: number; label: string; href: string }[] = [];
    [...document.querySelectorAll('a[href], button, input[type=button], input[type=submit], [role=button], [role=tab], summary')].forEach((el, i) => {
        el.removeAttribute('data-tapcheck');
        const r = el.getBoundingClientRect(), b = el as HTMLButtonElement;
        const label = (b.innerText || b.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        // A form's submit button (an untyped button of a form submits too) is left alone when the form POSTs.
        const submit = el.matches('button[type=submit], input[type=submit]') || (el.matches('button:not([type])') && !!b.form);
        const row = el.closest('tbody tr');
        if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden' || !label || no.test(label) || b.disabled || el.getAttribute('aria-disabled') === 'true'
            || el.closest(`[aria-hidden=true], ${DIALOG}`) || (submit && (b.form?.method === 'post' || b.formMethod === 'post')) || row?.previousElementSibling) return;
        const a = el instanceof HTMLAnchorElement ? el : null;
        if (a && (a.host !== own || skipped.test(a.pathname) || a.hasAttribute('download'))) return;
        el.setAttribute('data-tapcheck', String(i));
        out.push({ i, label, href: a ? a.pathname + a.search + a.hash : '' });
    });
    return out;
}, { own, unsafe: UNSAFE.source, skip: skip.source, DIALOG });

/** The dialog showing now, marked so it can be found again; null when there is none. */
async function shown(page: Page): Promise<Locator | null> {
    const any = await page.evaluate((DIALOG) => {
        document.querySelectorAll('[data-tapcheck-dialog]').forEach((el) => el.removeAttribute('data-tapcheck-dialog'));
        const d = [...document.querySelectorAll(DIALOG)].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden'; }).at(-1);
        d?.setAttribute('data-tapcheck-dialog', '');
        return !!d;
    }, DIALOG).catch(() => false);
    return any ? page.locator('[data-tapcheck-dialog]') : null;
}

/** The dialog's error state: the browser's validation refusing a field, an invalid field, or a message the app shows. '' when none. */
const errorState = (d: Locator) => d.evaluate((el) => {
    const bad = [...el.querySelectorAll<HTMLInputElement>('input, textarea, select')].find((f) => f.willValidate && !f.form?.noValidate && !f.validity.valid);
    if (bad) return `browser validation: ${bad.validationMessage}`;
    const msg = [...el.querySelectorAll<HTMLElement>('[aria-invalid=true], [role=alert], [class*=error i], [class*=invalid i]')]
        .find((e) => e.getClientRects().length > 0 && (e.getAttribute('aria-invalid') === 'true' || e.innerText.trim()));
    return !msg ? '' : msg.getAttribute('aria-invalid') === 'true' ? 'aria-invalid on a field' : `message: ${msg.innerText.replace(/\s+/g, ' ').trim().slice(0, 80)}`;
}).catch(() => '');

/**
 * Invalid input, then (with `submit`) valid input, in the form of the dialog that is open now. Returns the findings to
 * record as [check, status, detail]. The dialog may be closed, or the page moved, when it returns.
 */
async function probe(d: Locator, submit: boolean, wait: () => Promise<void>): Promise<[string, Status, string][]> {
    const CHECK = 'invalid input shows an error';
    const form = d.locator('form').first();
    const fields = await form.locator(FIELDS).filter({ visible: true }).all();
    const kind = (f: Locator) => f.evaluate((el) => { const e = el as HTMLInputElement; return { type: e.type, required: e.required || e.getAttribute('aria-required') === 'true', max: e.maxLength }; });
    let made = 0;
    for (const f of fields) {
        const k = await kind(f);
        if (k.required) await f.fill(''); else if (k.type === 'email') await f.fill('not-an-email'); else if (k.max > 0) await f.fill('x'.repeat(k.max + 10)); else continue;
        made++;
    }
    if (!made) return [[CHECK, 'info', 'not tried: the form has no required, email or maxlength field to make invalid']];
    const button = form.locator('button[type=submit], input[type=submit], button:not([type])').filter({ visible: true }).last();
    const label = (await button.count()) ? (await button.evaluate((b) => (b as HTMLButtonElement).innerText || (b as HTMLButtonElement).value)).replace(/\s+/g, ' ').trim() : '';
    const send = async () => { await (label ? button.click({ timeout: 3000 }) : form.evaluate((f) => (f as HTMLFormElement).requestSubmit())).catch(() => {}); await wait(); };
    // Refused by the browser itself, nothing can be sent, so any form may be tried. Otherwise only one that can't save.
    const state = await form.evaluate((f) => ({ posts: (f as HTMLFormElement).method === 'post', blocked: !(f as HTMLFormElement).noValidate && !(f as HTMLFormElement).checkValidity() }));
    if (!state.blocked && UNSAFE.test(label)) return [[CHECK, 'info', `not submitted: its button is "${label}"`]];
    if (!state.blocked && state.posts && !submit) return [[CHECK, 'info', 'not submitted: the form posts and only the app can refuse it (interact.submit: true tries it, on a throwaway database)']];
    await send();
    const open = await d.isVisible().catch(() => false);
    const err = open ? await errorState(d) : '';
    if (!err) return [[CHECK, 'fail', open ? 'none shown: no aria-invalid, no visible message, no browser validation message' : 'the invalid input was accepted: the dialog closed']];
    const out: [string, Status, string][] = [[CHECK, 'pass', err]];
    if (!submit || UNSAFE.test(label)) return out;
    // ponytail: text-like fields only; selects, checkboxes and pickers keep their values, so a form needing them is refused.
    for (const [n, f] of fields.entries()) {
        const k = await kind(f);
        const v = ({ email: `tapcheck-${n}@example.com`, url: 'https://example.com/tapcheck', number: '1', range: '1', date: '2030-01-01', time: '09:00', tel: '5550100' } as Record<string, string>)[k.type] ?? `tapcheck ${n}`;
        if (!['password', 'search'].includes(k.type)) await f.fill(k.max > 0 ? v.slice(0, k.max) : v).catch(() => {});
    }
    await send();
    const left = (await d.isVisible().catch(() => false)) ? await errorState(d) : '';
    out.push(['valid input is accepted', left ? 'warn' : 'pass', left || 'submitted']);
    return out;
}

/** Marks the page's tables (the first three) and, near each, its sort header, search box, next-page control and first row menu. */
const tagTables = (page: Page) => page.evaluate((unsafe) => {
    const no = new RegExp(unsafe, 'i');
    const seen = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden'; };
    const text = (el: Element) => ((el as HTMLElement).innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const ok = (el: Element) => seen(el) && !no.test(text(el)) && !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true';
    for (const a of ['table', 'sort', 'search', 'next', 'menu']) document.querySelectorAll(`[data-tapcheck-${a}]`).forEach((el) => el.removeAttribute(`data-tapcheck-${a}`));
    return [...document.querySelectorAll('table, [role=grid]')].filter(seen).slice(0, 3).map((t, k) => {
        t.setAttribute('data-tapcheck-table', String(k));
        const mark = (what: string, el?: Element | null) => { el?.setAttribute(`data-tapcheck-${what}`, String(k)); return !!el; };
        // "Near": the closest of the table's four nearest ancestors that holds one.
        const near = (find: (root: Element) => Element | undefined) => { for (let p = t.parentElement, n = 0; p && n < 4; p = p.parentElement, n++) { const hit = find(p); if (hit) return hit; } };
        const pick = (sel: string) => [...t.querySelectorAll(sel)].find(ok);
        const sort = pick('th button, th a, [role=columnheader] button, [role=columnheader] a') ?? pick('th[aria-sort], [role=columnheader][aria-sort]'); // the control in a header, else the header itself
        const search = near((p) => [...p.querySelectorAll('input[type=search], [role=searchbox], input[placeholder*=search i], input[placeholder*=filter i], input[aria-label*=search i], input[aria-label*=filter i]')].find(seen));
        const next = near((p) => [...p.querySelectorAll('a, button')].find((el) => ok(el) && !t.contains(el) && ((el as HTMLAnchorElement).rel === 'next' || /^(next\b|[›»>]$)/i.test(text(el)))));
        const menu = [...(t.querySelector('tbody tr, [role=rowgroup] [role=row]')?.querySelectorAll('[aria-haspopup]:not([aria-haspopup=false]), summary') ?? [])].find(ok);
        return { headers: [...t.querySelectorAll('th, [role=columnheader]')].map(text).filter(Boolean).join(', ').slice(0, 80) || 'no headers',
            sort: mark('sort', sort), search: mark('search', search), next: mark('next', next), menu: mark('menu', menu) };
    });
}, UNSAFE.source);

export async function run(r: Run) {
    const own = host(r.side.baseUrl);
    const reached = [...new Set(r.crawl.pages.filter((p) => p.status >= 200 && p.status < 400).map((p) => p.path))];
    const paths = reached.slice(0, r.cfg.interact.max);
    // Valid input changes data: like app.reset, it runs against a local app only unless app.allowRemoteReset says the remote one is a throwaway.
    const submit = r.cfg.interact.submit && (isLocal(r.side.baseUrl) || r.cfg.app.allowRemoteReset);
    if (r.cfg.interact.submit && !submit) {
        r.record({ suite: S, where: r.side.baseUrl, check: 'interact.submit', status: 'info', detail: "left off: the app isn't local (app.allowRemoteReset: true lifts that, for a remote throwaway copy only)" });
    }
    const log = { screens: [] as { path: string; clicked: string[]; dead: string[] }[], dialogs: [] as Record<string, unknown>[], tables: [] as Record<string, unknown>[] };
    const dialogs = new Set<string>(), tables = new Set<string>(), followed = new Set<string>(); // each dialog, table and link once per run
    const ctx = await context(r, r.cfg.viewports.find((v) => !v.mobile) ?? r.cfg.viewports[0]);
    const page = await ctx.newPage();

    // What a click set off, collected until drain() files it under the control's label.
    const seen = { errors: watch(page), bad: [] as string[], natives: [] as string[], requests: 0, popups: 0 };
    page.on('request', () => { seen.requests++; });
    page.on('response', (res) => { if (res.status() >= 500 && host(res.url()) === own) seen.bad.push(`${res.status()} ${res.request().method()} ${new URL(res.url()).pathname}`); });
    page.on('popup', (p) => { seen.popups++; p.close().catch(() => {}); });
    page.on('dialog', (d) => { // leaving a page may ask; alert, confirm and prompt are findings, and are never agreed to
        if (d.type() === 'beforeunload') { d.accept().catch(() => {}); return; }
        seen.natives.push(`${d.type()}("${d.message().slice(0, 60)}")`);
        d.dismiss().catch(() => {});
    });
    const wait = async () => { await page.waitForTimeout(WAIT); if (seen.requests) await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}); };
    const still = (u: string) => u.split('#')[0];

    try {
        for (const path of paths) {
            const broke: string[] = [], failed: string[] = [], native: string[] = [], dead: string[] = [], clicked: string[] = [];
            const clear = () => { seen.errors.length = seen.bad.length = seen.natives.length = seen.requests = seen.popups = 0; };
            const drain = (label: string) => {
                if (seen.errors.length) broke.push(`"${label}": ${seen.errors[0].slice(0, 120)}`);
                if (seen.bad.length) failed.push(`"${label}" → ${seen.bad[0]}`);
                if (seen.natives.length) native.push(`"${label}": ${seen.natives[0]}`);
                clear();
            };
            try {
                await open(r, page, path);
                const home = page.url();
                let fresh = await tag(page, own, r.cfg.crawl.skip);
                const reopen = async () => { if (still(page.url()) !== still(home) || await shown(page)) await open(r, page, path); fresh = await tag(page, own, r.cfg.crawl.skip); };

                for (const c of fresh.filter((x) => !x.href || !followed.has(x.href)).slice(0, MAX_CLICKS)) {
                    const el = page.locator(`[data-tapcheck="${c.i}"]`);
                    if (fresh.find((x) => x.i === c.i)?.label !== c.label || !(await el.isVisible().catch(() => false))) continue; // the page changed under it
                    if (c.href) followed.add(c.href);
                    clear();
                    await page.evaluate(() => {
                        const w = window as any;
                        w.__tapcheckObserver ??= new MutationObserver((m) => { w.__tapcheck += m.length; });
                        w.__tapcheckObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
                        w.__tapcheck = 0;
                    });
                    if (await el.click({ timeout: 3000 }).then(() => false, () => true)) continue; // covered or gone: not clicked
                    await wait();
                    clicked.push(c.label);
                    // Did anything happen? A new document has no counter, which is a change too.
                    const mutations = await page.evaluate(() => (window as any).__tapcheck as number | undefined).catch(() => undefined);
                    const moved = page.url().replace(/#$/, '') !== home.replace(/#$/, '');
                    if (mutations === 0 && !moved && !seen.requests && !seen.natives.length && !seen.popups) dead.push(c.label);

                    const d = still(page.url()) === still(home) ? await shown(page) : null;
                    if (d) {
                        const info = await d.evaluate((el) => {
                            const flat = (s?: string | null) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
                            const by = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? '').join(' ');
                            return { name: flat(el.getAttribute('aria-label') || by || el.getAttribute('title')), heading: flat(el.querySelector<HTMLElement>('h1, h2, h3, [role=heading]')?.innerText),
                                role: el.getAttribute('role') ?? el.tagName.toLowerCase(), focus: el.contains(document.activeElement), form: !!el.querySelector('form') };
                        });
                        const key = info.name || info.heading || `opened by "${c.label}"`;
                        if (!dialogs.has(key)) {
                            dialogs.add(key);
                            const where = `${path} › ${key}`;
                            const rec = (check: string, status: Status, detail?: string) => r.record({ suite: S, where, check, status, detail });
                            rec('dialog has an accessible name', info.name ? 'pass' : 'fail', info.name ? undefined : `opened by "${c.label}": it needs aria-label or aria-labelledby`);
                            rec('focus moves into the dialog', info.focus ? 'pass' : 'warn', info.focus ? undefined : 'focus stayed on the page behind it');
                            if (DESTRUCTIVE.test(key)) rec('destructive dialog is an alertdialog', info.role === 'alertdialog' ? 'pass' : 'warn', `role: ${info.role}`);
                            await page.keyboard.press('Escape');
                            await page.waitForTimeout(200);
                            const closes = !(await d.isVisible().catch(() => false));
                            rec('dialog closes with Escape', closes ? 'pass' : 'fail');
                            const entry: Record<string, unknown> = { name: key, named: !!info.name, role: info.role, page: path, opener: c.label, form: info.form };
                            if (info.form) {
                                if (closes) { await el.click({ timeout: 3000 }).catch(() => {}); await wait(); }
                                const again = await shown(page);
                                for (const [check, status, detail] of again ? await probe(again, submit, wait) : []) { rec(check, status, detail); entry[check] = `${status}: ${detail}`; }
                            }
                            log.dialogs.push(entry);
                            reach(r, `dialog ${key}`, path);
                        }
                    }
                    drain(c.label);
                    await page.keyboard.press('Escape').catch(() => {}); // close what the click opened
                    if (mutations === undefined || still(page.url()) !== still(home) || await shown(page)) await reopen();
                }

                // Tables: each one once per run (a list looks the same on every page it is on).
                for (const [k, t] of (await tagTables(page)).entries()) {
                    if (tables.has(t.headers)) continue;
                    tables.add(t.headers);
                    const where = `${path} › table (${t.headers.slice(0, 40)})`;
                    const table = page.locator(`[data-tapcheck-table="${k}"]`);
                    const rows = () => table.evaluate((el) => [...el.querySelectorAll('tbody tr, [role=row]')].map((x) => (x as HTMLElement).innerText).join('\n')
                        + [...el.querySelectorAll('[aria-sort]')].map((h) => h.getAttribute('aria-sort')).join()).catch(() => '');
                    const entry: Record<string, unknown> = { page: path, headers: t.headers };
                    const attempt = async (what: string, check: string, has: boolean, act: (l: Locator) => Promise<unknown>, changed?: () => Promise<boolean>) => {
                        if (!has) return;
                        const before = await rows(), url = page.url();
                        clear();
                        await act(page.locator(`[data-tapcheck-${what}="${k}"]`)).catch(() => {});
                        await wait();
                        const did = page.url() !== url || (changed ? await changed() : (await rows()) !== before);
                        r.record({ suite: S, where, check, status: did ? 'pass' : 'warn', detail: did ? undefined : 'nothing changed' });
                        entry[what] = did ? 'changed' : 'unchanged';
                        reach(r, `table ${t.headers.slice(0, 40)}: ${what}`, path);
                        drain(`table ${what}`);
                        await page.keyboard.press('Escape').catch(() => {});
                        await open(r, page, path); // back to the table as it was
                        await tagTables(page);
                    };
                    await attempt('sort', 'sorting changes the rows', t.sort, (l) => l.click({ timeout: 3000 }));
                    // A term no row has. Enter is pressed unless that would submit a form that POSTs.
                    await attempt('search', 'search changes the rows', t.search, async (l) => { await l.fill('zzqx-tapcheck'); if (await l.evaluate((el) => (el as HTMLInputElement).form?.method !== 'post')) await l.press('Enter'); });
                    await attempt('next', 'paging changes the rows', t.next, (l) => l.click({ timeout: 3000 }));
                    await attempt('menu', 'row menu opens', t.menu, (l) => l.click({ timeout: 3000 }),
                        () => page.evaluate((DIALOG) => [...document.querySelectorAll(`[role=menu], [role=listbox], details[open], ${DIALOG}`)].some((el) => el.getClientRects().length > 0), DIALOG));
                    log.tables.push(entry);
                }

                r.record({ suite: S, where: path, check: 'clicks raise no page or console errors', status: broke.length ? 'fail' : 'pass', detail: broke.slice(0, 4).join(' | ') || `${clicked.length} control(s) clicked` });
                r.record({ suite: S, where: path, check: 'clicks set off no 5xx', status: failed.length ? 'fail' : 'pass', detail: failed.slice(0, 4).join('; ') || undefined });
                r.record({ suite: S, where: path, check: 'no native alert, confirm or prompt', status: native.length ? 'fail' : 'pass', detail: native.slice(0, 4).join('; ') || undefined });
                r.record({ suite: S, where: path, check: 'every control does something', status: dead.length ? 'warn' : 'pass', detail: dead.length ? `nothing changed after: ${dead.slice(0, 6).map((l) => `"${l}"`).join(', ')}` : undefined });
            } catch (e) {
                if (e instanceof SessionExpired) throw e;
                r.record({ suite: S, where: path, check: 'sweep ran', status: 'fail', detail: (e as Error).message.slice(0, 200) });
            }
            log.screens.push({ path, clicked, dead });
        }
    } finally {
        writeFileSync(`${r.dir}/interact.json`, JSON.stringify(log, null, 2));
        await ctx.close();
    }
    r.record({ suite: S, where: 'all crawled pages', check: 'interaction coverage', status: 'info', evidence: [`${r.dir}/interact.json`],
        detail: `${paths.length} of ${reached.length} screen(s), ${log.screens.reduce((n, s) => n + s.clicked.length, 0)} control(s) clicked, ${log.dialogs.length} dialog(s), ${log.tables.length} table(s)` });
}
