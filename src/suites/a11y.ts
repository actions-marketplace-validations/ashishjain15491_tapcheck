/*
 * Accessibility (measured, no Jev): axe-core (WCAG 2.2 A/AA rules) on every screen at every viewport, critical and
 * serious violations fail, moderate ones warn; and a keyboard pass on desktop-sized viewports: Tab moves focus through
 * the page (from the top, and from the start of the main content, so an app's long sidebar isn't all that is tried),
 * and the page declares its language. Whether focus can be seen is the audit suite's "focus ring on every Tab stop".
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from 'playwright';
import { context, marked, open, resolve, SessionExpired, slug, type Run } from '../browser.ts';

export const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const TABS = 12;

/**
 * Puts focus on the page's main content (main or [role=main], made focusable for the moment), so the next Tab lands on
 * its first control instead of the app shell's. False when the page has none. Call it with `undo` after that Tab.
 */
export const toMain = (page: Page, undo = false) => page.evaluate((undo) => {
    const m = document.querySelector<HTMLElement>('main, [role=main]');
    if (undo) { document.querySelector('[data-tapcheck-tab]')?.removeAttribute('tabindex'); document.querySelector('[data-tapcheck-tab]')?.removeAttribute('data-tapcheck-tab'); return !!m; }
    if (!m) return false;
    if (!m.hasAttribute('tabindex')) { m.setAttribute('tabindex', '-1'); m.setAttribute('data-tapcheck-tab', ''); }
    m.focus({ preventScroll: true });
    return true;
}, undo);

export async function run(r: Run) {
    const S = 'a11y';
    const screens = r.side.screens.length ? r.side.screens : [{ name: 'Home', path: '/' }];
    const all: Record<string, unknown> = {};
    for (const vp of r.cfg.viewports) {
        const ctx = await context(r, vp, true, true); // axe is injected, so the page's own CSP is set aside
        const page = await ctx.newPage();
        try {
            for (const s of screens) {
                const where = `${s.name} · ${vp.name}`;
                try {
                    const path = await resolve(r, page, s);
                    if (!path) { r.record({ suite: S, where, check: 'screen reachable', status: 'warn', detail: 'no link to it found' }); continue; }
                    await open(r, page, path);
                    await page.addScriptTag({ content: AXE });
                    const res: any = await page.evaluate(() => (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }));
                    all[`${slug(s.name)}-${vp.name}`] = res.violations.map((x: any) => ({ id: x.id, impact: x.impact, help: x.help, nodes: x.nodes.slice(0, 5).map((n: any) => n.target) }));
                    for (const impact of ['critical', 'serious', 'moderate'] as const) {
                        const v = res.violations.filter((x: any) => x.impact === impact);
                        const status = v.length ? (impact === 'moderate' ? 'warn' : 'fail') : 'pass', detail = v.map((x: any) => `${x.id} ×${x.nodes.length}`).join(', ') || undefined;
                        // MARK=1: axe's own selector for each node, with its rule as the note (a node inside a frame or a shadow root has no single selector).
                        const shot = v.length && r.cfg.marks ? await marked(r, page, `a11y ${where} ${impact}`, { status, title: `axe: no ${impact} violations`, detail: `${where} · ${detail}` },
                            v.flatMap((x: any) => x.nodes.filter((n: any) => n.target.length === 1 && typeof n.target[0] === 'string').map((n: any) => ({ target: n.target[0] as string, note: x.id })))) : undefined;
                        r.record({ suite: S, where, check: `axe: no ${impact} violations`, status, detail, evidence: shot ? [shot] : undefined });
                    }
                    if (vp.mobile) continue;
                    // Keyboard: does Tab move focus? From the top, and from the main content when the page has one.
                    const focusable = await page.$$eval('a[href], button, input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])', (els) => els.length);
                    const runs: string[] = [];
                    let stuck = false;
                    for (const from of ['the top', 'the main content']) {
                        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
                        if (from !== 'the top' && !(await toMain(page))) break;
                        const stops = new Set<string>();
                        for (let i = 0; i < TABS; i++) {
                            await page.keyboard.press('Tab');
                            if (!i) await toMain(page, true);
                            stops.add(await page.evaluate(() => {
                                const el = document.activeElement as HTMLElement | null;
                                return !el || el === document.body ? '(body)' : `${el.tagName.toLowerCase()} "${(el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 30)}"`;
                            }));
                        }
                        // A page with one or two controls can't show more distinct stops than it has.
                        stuck ||= stops.size <= Math.min(2, focusable - 1);
                        runs.push(`${stops.size} distinct stops in ${TABS} presses from ${from}`);
                    }
                    r.record({ suite: S, where, check: 'keyboard: Tab moves focus', status: stuck ? 'fail' : 'pass', detail: `${runs.join(', ')}; ${focusable} focusable` });
                    const lang = await page.evaluate(() => document.documentElement.lang);
                    r.record({ suite: S, where, check: 'page language set', status: lang ? 'pass' : 'fail', detail: lang || 'no lang attribute' });
                } catch (e) {
                    if (e instanceof SessionExpired) throw e;
                    r.record({ suite: S, where, check: 'audit ran', status: 'fail', detail: (e as Error).message.slice(0, 200) });
                }
            }
        } finally {
            await ctx.close();
        }
    }
    writeFileSync(`${r.dir}/axe.json`, JSON.stringify(all, null, 2));
}
