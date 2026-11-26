/*
 * Accessibility (measured, no Jev): axe-core (WCAG 2.2 A/AA rules) on every screen at every viewport, critical and
 * serious violations fail, moderate ones warn; and a keyboard pass on desktop-sized viewports: Tab moves focus through
 * the page, the focused control shows a visible focus style, and the page declares its language.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { context, marked, open, resolve, SessionExpired, slug, type Run } from '../browser.ts';

export const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const TABS = 12;

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
                    // Keyboard: does Tab move focus, and can a person see where it is?
                    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
                    const stops: { label: string; visible: boolean }[] = [];
                    for (let i = 0; i < TABS; i++) {
                        await page.keyboard.press('Tab');
                        stops.push(await page.evaluate(() => {
                            const el = document.activeElement as HTMLElement | null;
                            if (!el || el === document.body) return { label: '(body)', visible: false };
                            const st = getComputedStyle(el);
                            const ring = (st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) > 0) || (!!st.boxShadow && st.boxShadow !== 'none');
                            return { label: `${el.tagName.toLowerCase()} "${(el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 30)}"`, visible: ring };
                        }));
                    }
                    const moved = new Set(stops.map((x) => x.label)).size;
                    const focusable = await page.$$eval('a[href], button, input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])', (els) => els.length);
                    // A page with one or two controls can't show more distinct stops than it has.
                    r.record({ suite: S, where, check: 'keyboard: Tab moves focus', status: moved > Math.min(2, focusable - 1) ? 'pass' : 'fail', detail: `${moved} distinct stops in ${TABS} presses, ${focusable} focusable` });
                    const unseen = stops.filter((x) => x.label !== '(body)' && !x.visible);
                    r.record({ suite: S, where, check: 'keyboard: focus is visible', status: unseen.length ? 'fail' : 'pass', detail: unseen.slice(0, 4).map((x) => x.label).join(', ') || undefined });
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
