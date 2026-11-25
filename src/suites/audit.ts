/*
 * Full UI audit, per screen (the configured screens, plus up to audit.max crawled pages; paths matching audit.skip are
 * left out). Measured by code; Jev only adds its look.
 * - desktop, light: text cut off or shortened with no way to read it, controls that overlap, targets under 24 px, leaked
 *   placeholders, heading levels, images without alt text, the focus ring on each Tab stop; every menu and dialog the
 *   screen's markup says it opens (aria-haspopup, aria-expanded, popovertarget) is opened and measured the same way,
 *   plus whether it fits on the screen;
 * - desktop, dark (prefers-color-scheme: dark): axe's colour-contrast rule, which also catches text that became
 *   invisible, and backgrounds that stayed white. A page that doesn't react to the colour scheme is one info finding;
 * - tablet (768 px) and phone (375 px): sideways scroll, cut-off text, overlap, small targets;
 * - across the screens: buttons and fields of one kind that come in several sizes, radii or colours, labels in Title
 *   Case next to labels in sentence case, and, with `design:` in tapcheck.yml, computed colours, fonts, radii and
 *   spacing that are not among the tokens (warnings, the most used offenders first);
 * - Jev's look, when Jev is on: the VISUAL questions (src/questions.ts) about the desktop screen and about each opened
 *   menu and dialog, within the run's budget. With JEV=off or no key that is one info finding and the rest still runs.
 * It only opens menus and dialogs and closes them with Escape: never a control whose label is one of the usability
 * suite's UNSAFE words, never a submit button. audit.json holds everything found.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import type { Config } from '../config.ts';
import { context, open, resolve, SessionExpired, slices, slug, type Run, type Viewport } from '../browser.ts';
import { ask, BudgetReached, img, whyOff } from '../jev.ts';
import { VISUAL } from '../questions.ts';
import { AXE } from './a11y.ts';
import { UNSAFE } from './usability.ts';
import { visual } from './ux.ts';

const S = 'audit';
const NARROW: Viewport[] = [{ name: 'tablet', width: 768, height: 1024, mobile: false }, { name: 'phone', width: 375, height: 812, mobile: true }];
const WARN = new Set(['shortened text can be read in full', 'heading levels in order']); // the other measured checks fail
const TABS = 20, MAX_POPUPS = 4;
const POPUP = '[role=menu], [role=listbox], dialog[open], [role=dialog], [role=alertdialog], [popover]:popover-open';
// ponytail: primary, secondary and danger is the most a button kind gets before its colours count as inconsistent; fields get one.
const PAINTS: Record<string, number> = { button: 3, 'icon button': 3, 'text button': 2 };

type Item = { kind: string; shape: string; paint: string; label: string };

/**
 * Runs in the page. Measures everything under `root` (a selector; the whole page without one). `extras` adds the
 * desktop-only checks and collects the controls, labels and (with `design`) the styles outside the tokens.
 */
function measure({ root: rootSel, extras, design }: { root?: string; extras: boolean; design?: Config['design'] }) {
    const root = (rootSel && document.querySelector(rootSel)) || document.body;
    const vw = innerWidth, vh = innerHeight;
    const visible = (el: Element) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && Number(s.opacity) > 0 && !el.closest('[aria-hidden=true], [hidden]'); };
    const txt = (el: Element) => ((el as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const name = (el: Element) => (el.getAttribute('aria-label') || txt(el) || el.getAttribute('title') || (el as HTMLInputElement).placeholder || el.tagName.toLowerCase()).slice(0, 40);
    const desc = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : ''}`;
    const ownText = (el: Element) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());
    const px = (v: string) => Math.round(parseFloat(v) || 0);
    const all = [...root.querySelectorAll('*')].filter(visible);
    const cut = new Set<string>(), short = new Set<string>(), overlap = new Set<string>(), small = new Set<string>();
    const problems: Record<string, string[]> = {};

    if (!rootSel) {
        const wide = document.documentElement.scrollWidth > vw + 1 && all.filter((e) => e.getBoundingClientRect().right > vw + 1).sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
        problems['no sideways scroll'] = document.documentElement.scrollWidth > vw + 1 ? [`the page is ${document.documentElement.scrollWidth} px wide in a ${vw} px window${wide ? `; widest: ${desc(wide)}` : ''}`] : [];
    } else {
        const b = root.getBoundingClientRect();
        const out = b.left < -1 || b.top < -1 || b.right > vw + 1 || (getComputedStyle(root).position === 'fixed' && b.bottom > vh + 1);
        problems['fits on the screen'] = out ? [`it spans ${Math.round(b.left)},${Math.round(b.top)} to ${Math.round(b.right)},${Math.round(b.bottom)} in a ${vw} × ${vh} window`] : [];
    }

    // Text wider than its box, in an element that holds text itself (not a carousel or another clipping container).
    for (const el of all) {
        if (el.children.length > 2 || el.matches('input, select, textarea') || !txt(el)) continue;
        const s = getComputedStyle(el);
        if (el.scrollWidth <= el.clientWidth + 1 || !/hidden|clip/.test(s.overflowX)) continue;
        if (!ownText(el) && ![...el.children].every((c) => getComputedStyle(c).display.startsWith('inline'))) continue;
        if (s.textOverflow !== 'ellipsis') cut.add(`"${txt(el)}" (${desc(el)})`);
        else if (!el.getAttribute('title') && !el.getAttribute('aria-label') && !el.closest('[title], [aria-describedby]')) short.add(`"${txt(el)}" (${desc(el)})`);
    }

    // Controls, each clipped to what its scrolling ancestors leave visible.
    const seen = (el: Element) => {
        const r = el.getBoundingClientRect();
        let [l, t, rt, b] = [r.left, r.top, r.right, r.bottom];
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            const cs = getComputedStyle(p);
            if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
            const c = p.getBoundingClientRect();
            l = Math.max(l, c.left); t = Math.max(t, c.top); rt = Math.min(rt, c.right); b = Math.min(b, c.bottom);
        }
        return { left: l, top: t, right: rt, bottom: b, width: Math.max(0, rt - l), height: Math.max(0, b - t) };
    };
    const controls = all.filter((e) => e.matches('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=switch]')).slice(0, 300)
        .map((el) => ({ el, box: seen(el) })).filter((c) => c.box.width > 1 && c.box.height > 1);
    for (const [i, a] of controls.entries()) for (const b of controls.slice(i + 1)) {
        if (a.el.contains(b.el) || b.el.contains(a.el) || (a.el.closest('label') && a.el.closest('label') === b.el.closest('label'))) continue;
        const w = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left), h = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
        if (w > 4 && h > 4 && w * h > 0.25 * Math.min(a.box.width * a.box.height, b.box.width * b.box.height)) overlap.add(`${name(a.el)} ↔ ${name(b.el)}`);
    }
    // WCAG 2.2 target size (2.5.8): under 24 px fails unless a 24 px area centred on it touches no other target. Links in a sentence are exempt.
    for (const { el } of controls) {
        const r = el.getBoundingClientRect();
        if (Math.min(r.width, r.height) >= 24 || (el.matches('input[type=checkbox], input[type=radio]') && el.closest('label'))) continue;
        if (el.matches('a') && el.closest('p, li, td, dd') && getComputedStyle(el).display === 'inline') continue;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2, hw = Math.max(12, r.width / 2), hh = Math.max(12, r.height / 2);
        const crowded = controls.some((o) => { const t = o.el.getBoundingClientRect(); return o.el !== el && !o.el.contains(el) && !el.contains(o.el) && t.left < cx + hw && t.right > cx - hw && t.top < cy + hh && t.bottom > cy - hh; });
        if (crowded) small.add(`${name(el)} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    Object.assign(problems, { 'text is not cut off': [...cut], 'shortened text can be read in full': [...short], 'controls do not overlap': [...overlap], 'targets at least 24 px': [...small] });

    const items: Item[] = [], labels: string[] = [], off: [string, string, string][] = [];
    if (!extras) return { problems, items, labels, off };

    // Placeholders that reached the screen: a value that printed as undefined, NaN or [object Object], or an unfilled template.
    const leaked = new Set<string>();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n.textContent!.trim(), el = n.parentElement;
        if (!t || !el || el.closest('script, style, code, pre, textarea, [aria-hidden=true]') || !el.getClientRects().length) continue;
        if (/^(undefined|null)$|\bNaN\b|\[object Object\]|\{\{[^}]*\}\}|\$\{[^}]*\}/.test(t)) leaked.add(t.slice(0, 60));
    }
    const heads = [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter(visible);
    problems['no leaked placeholders'] = [...leaked];
    problems['heading levels in order'] = heads.slice(1).flatMap((h, i) => (+h.tagName[1] > +heads[i].tagName[1] + 1 ? [`${heads[i].tagName.toLowerCase()} → ${h.tagName.toLowerCase()} "${txt(h)}"`] : []));
    problems['images have alt text'] = [...root.querySelectorAll('img')].filter((i) => visible(i) && !i.hasAttribute('alt') && !i.getAttribute('aria-label')).map((i) => i.src.slice(-60));

    // Controls by kind, with the look that should be the same wherever the kind is used.
    for (const el of all) {
        const tag = el.tagName.toLowerCase(), f = el as HTMLInputElement;
        const button = el.matches('button, input[type=submit], input[type=button], input[type=reset], [role=button]') && !el.matches('[role=tab], [role=menuitem], [role=switch], :disabled, [aria-disabled=true]');
        const field = tag === 'select' || tag === 'textarea' || (tag === 'input' && ['text', 'email', 'url', 'tel', 'number', 'password', 'search', 'date'].includes(f.type));
        if (!button && !field) continue;
        const s = getComputedStyle(el), r = el.getBoundingClientRect();
        const label = field ? (f.labels?.[0] ? txt(f.labels[0]) : name(el)) : txt(el) || (tag === 'input' ? f.value : '');
        const bare = s.backgroundColor === 'rgba(0, 0, 0, 0)' && !parseFloat(s.borderTopWidth);
        const kind = field ? (tag === 'input' ? 'text input' : tag) : !label ? 'icon button' : bare ? 'text button' : 'button';
        items.push({ kind, label, shape: `${kind === 'textarea' ? '' : `${Math.round(r.height)} px high, `}radius ${px(s.borderTopLeftRadius)} px, ${px(s.fontSize)} px text`,
            paint: `${s.color} on ${s.backgroundColor}, ${parseFloat(s.borderTopWidth) ? `border ${s.borderTopColor}` : 'no border'}` });
        if (button && label) labels.push(label);
    }
    for (const h of [...heads, ...root.querySelectorAll('[role=tab]')]) if (visible(h) && txt(h)) labels.push(txt(h));

    if (design) {
        // Any CSS colour as sRGB bytes, by painting it; null when it is fully transparent.
        const cv = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
        const memo = new Map<string, number[] | null>();
        const rgb = (c: string) => {
            if (!memo.has(c)) { cv.clearRect(0, 0, 1, 1); cv.fillStyle = c; cv.fillRect(0, 0, 1, 1); const d = cv.getImageData(0, 0, 1, 1).data; memo.set(c, d[3] ? [d[0], d[1], d[2]] : null); }
            return memo.get(c)!;
        };
        const tokens = (design.colors ?? []).map((c) => rgb(c)!);
        const colour = (c: string, use: string, el: Element) => {
            const v = rgb(c);
            if (v && !tokens.some((t) => Math.abs(t[0] - v[0]) + Math.abs(t[1] - v[1]) + Math.abs(t[2] - v[2]) <= 6)) off.push(['colors', `#${v.map((x) => x.toString(16).padStart(2, '0')).join('')} ${use}`, desc(el)]);
        };
        const fonts = design.fonts?.map((x) => x.toLowerCase());
        const among = (list: number[], v: number) => list.some((t) => Math.abs(t - v) < 0.5);
        for (const el of all) {
            if (el.closest('svg, img, canvas, video, iframe')) continue;
            const s = getComputedStyle(el), own = ownText(el);
            if (design.colors) { if (own) colour(s.color, 'text', el); colour(s.backgroundColor, 'background', el); if (parseFloat(s.borderTopWidth)) colour(s.borderTopColor, 'border', el); }
            const family = s.fontFamily.split(',')[0].replace(/["']/g, '').trim();
            if (fonts && own && !fonts.includes(family.toLowerCase())) off.push(['fonts', family, desc(el)]);
            const radius = parseFloat(s.borderTopLeftRadius) || 0;
            if (design.radii && radius > 0 && !s.borderTopLeftRadius.includes('%') && !among(design.radii, radius)) off.push(['radii', `${px(s.borderTopLeftRadius)} px`, desc(el)]);
            if (design.spacing) for (const p of ['paddingTop', 'paddingLeft', 'marginTop', 'marginBottom', 'rowGap', 'columnGap'] as const) { const v = parseFloat(s[p]) || 0; if (v > 0 && !among(design.spacing, v)) off.push(['spacing', `${px(s[p])} px`, desc(el)]); }
        }
    }
    return { problems, items, labels, off };
}

/** Tab through the page; returns the stops whose look doesn't change between focused and not. */
async function noFocusRing(page: Page): Promise<string[]> {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const stops = new Map<string, { ring: boolean; name: string }>(); // by place: two links may share a label
    for (let i = 0; i < TABS; i++) {
        await page.keyboard.press('Tab');
        const f = await page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null;
            if (!el || el === document.body) return null;
            const chain = [el, el.parentElement, el.parentElement?.parentElement].filter((e): e is HTMLElement => !!e);
            const look = (e: HTMLElement) => { const s = getComputedStyle(e); return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderTopColor, s.borderBottomColor, s.backgroundColor, s.textDecorationLine].join('|'); };
            // A ring that eases in or out still shows right after blur: compare with transitions off.
            const saved = chain.map((e) => e.style.transition);
            chain.forEach((e) => { e.style.transition = 'none'; });
            const on = chain.map(look); el.blur(); const off = chain.map(look); el.focus({ preventScroll: true });
            chain.forEach((e, k) => { e.style.transition = saved[k]; });
            const b = el.getBoundingClientRect();
            return { ring: on.some((k, j) => k !== off[j]), at: `${Math.round(b.left + scrollX)},${Math.round(b.top + scrollY)}`,
                name: `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.innerText || (el as HTMLInputElement).placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 30)}"` };
        });
        if (!f || stops.has(f.at)) break; // left the page, or came round again
        stops.set(f.at, f);
    }
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); scrollTo(0, 0); });
    return [...new Set([...stops.values()].filter((f) => !f.ring).map((f) => f.name))];
}

/** Marks the controls whose markup says they open a menu or dialog, and returns their labels (in order; '' is one to leave alone). */
const openers = (page: Page) => page.evaluate((unsafe) => {
    const no = new RegExp(unsafe, 'i');
    return [...document.querySelectorAll('[aria-haspopup]:not([aria-haspopup=false]), [aria-expanded=false], [popovertarget]')].slice(0, 8).map((el, i) => {
        const b = el as HTMLButtonElement;
        const label = (b.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        const submit = el.matches('button[type=submit], input[type=submit]') || (el.matches('button:not([type])') && !!b.form);
        const leaves = el instanceof HTMLAnchorElement && !!el.getAttribute('href') && !el.getAttribute('href')!.startsWith('#'); // a link that goes somewhere
        if (!label || no.test(label) || submit || leaves || b.disabled || el.getClientRects().length === 0) return '';
        el.setAttribute('data-tapcheck-opener', String(i));
        return label;
    });
}, UNSAFE.source);

export async function run(r: Run) {
    mkdirSync(`${r.dir}/shots`, { recursive: true });
    const desktop = r.cfg.viewports.find((v) => !v.mobile) ?? { name: 'desktop', width: 1440, height: 900, mobile: false };
    const skip = r.cfg.audit.skip;
    const out = { screens: [] as { name: string; path: string; views: Record<string, Record<string, string[]>> }[], components: {} as Record<string, unknown>, labelCase: {} as Record<string, string[]>, tokens: {} as Record<string, unknown> };
    const looks = new Map<string, Map<string, { n: number; labels: Set<string>; paints: Set<string> }>>(); // kind → shape → where it is used
    const labels = new Set<string>();
    const outside = new Map<string, Map<string, { n: number; at: string }>>(); // token list → value → uses

    let jevOff = whyOff();
    if (jevOff) r.record({ suite: S, where: 'Jev', check: "Jev's look at each screen, menu and dialog", status: 'info', detail: `skipped (${jevOff}); the measured checks ran` });
    /** Jev's look at `shots`. Reaching the budget ends the looks, not the audit. */
    const look = async (where: string, key: string, state: Record<string, unknown>, questions: Record<string, unknown>, shots: string[]) => {
        if (jevOff) return;
        try {
            visual(r, S, where, await ask(key, { ...state, screenshots: shots.map(img) }, questions, shots), shots);
        } catch (e) {
            if (!(e instanceof BudgetReached)) throw e;
            jevOff = 'Jev budget reached';
            r.record({ suite: S, where: 'Jev', check: "Jev's look at each screen, menu and dialog", status: 'info', detail: `stopped at ${where}: ${e.message}` });
        }
    };
    /** One finding per measured check; the problems also go to audit.json. */
    const emit = async (page: Page, screen: (typeof out.screens)[number], view: string, where: string, problems: Record<string, string[]>, shots?: string[]) => {
        const bad = Object.values(problems).some((l) => l.length);
        const shot = `${r.dir}/shots/audit-${slug(where)}.png`;
        if (bad && !shots) await page.screenshot({ path: shot });
        for (const [check, list] of Object.entries(problems)) {
            r.record({ suite: S, where, check, status: !list.length ? 'pass' : WARN.has(check) ? 'warn' : 'fail', detail: list.length ? `${list.length}: ${list.slice(0, 5).join('; ')}` : undefined,
                evidence: list.length ? shots ?? [shot] : undefined });
        }
        screen.views[view] = Object.fromEntries(Object.entries(problems).filter(([, l]) => l.length));
    };

    async function onDesktop(page: Page, t: (typeof out.screens)[number]) {
        const where = `${t.name} · desktop`, key = `audit-${slug(t.name)}`;
        await open(r, page, t.path);
        const colours = () => page.evaluate(() => [document.documentElement, ...document.querySelectorAll('body, body *')].slice(0, 400).map((el) => { const s = getComputedStyle(el); return s.backgroundColor + s.color; }).join());
        const light = await colours();
        const m = await page.evaluate(measure, { extras: true, design: r.cfg.design });
        for (const it of m.items) {
            const shapes = looks.get(it.kind) ?? looks.set(it.kind, new Map()).get(it.kind)!;
            const use = shapes.get(it.shape) ?? shapes.set(it.shape, { n: 0, labels: new Set(), paints: new Set() }).get(it.shape)!;
            use.n++; use.paints.add(it.paint);
            if (it.label && use.labels.size < 4) use.labels.add(it.label);
        }
        m.labels.forEach((l) => labels.add(l));
        for (const [list, value, at] of m.off) {
            const values = outside.get(list) ?? outside.set(list, new Map()).get(list)!;
            const use = values.get(value) ?? values.set(value, { n: 0, at: `${at} on ${t.name}` }).get(value)!;
            use.n++;
        }
        const shots = jevOff ? undefined : await slices(r, page, key, await page.evaluate(() => document.documentElement.scrollHeight), desktop.height);
        await emit(page, t, 'desktop', where, { ...m.problems, 'focus ring on every Tab stop': await noFocusRing(page) }, shots);
        if (shots) {
            await look(where, key, { screen: t.name, viewport: `desktop, ${desktop.width} × ${desktop.height} px`, note: shots.length > 1 ? 'The screenshots are consecutive slices of one screen, top to bottom.' : undefined }, VISUAL, shots);
        }

        // Menus and dialogs: opened one at a time, measured, closed with Escape.
        let opened = 0;
        for (const [i, label] of (await openers(page)).entries()) {
            if (!label || opened >= MAX_POPUPS) continue;
            const home = page.url().split('#')[0];
            await page.locator(`[data-tapcheck-opener="${i}"]`).click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(300);
            const found = page.url().split('#')[0] === home && await page.evaluate((POPUP) => {
                const p = [...document.querySelectorAll(POPUP)].filter((el) => el.getClientRects().length > 0).at(-1);
                p?.setAttribute('data-tapcheck-popup', '');
                return p ? p.getAttribute('role') ?? p.tagName.toLowerCase() : '';
            }, POPUP);
            if (found) {
                opened++;
                const at = `${t.name} › ${label}`, shot = `${r.dir}/shots/${key}-popup-${opened}.png`;
                await page.screenshot({ path: shot });
                const p = await page.evaluate(measure, { root: '[data-tapcheck-popup]', extras: false });
                await emit(page, t, `${found} "${label}"`, at, p.problems, [shot]);
                const { loaded: _, ...questions } = VISUAL; // a menu isn't a screen that loads
                await look(at, `${key}-popup-${opened}`, { screen: `${t.name}, after "${label}" was clicked`, viewport: `desktop, ${desktop.width} × ${desktop.height} px` }, questions, [shot]);
            }
            await page.keyboard.press('Escape').catch(() => {});
            await page.waitForTimeout(150);
            // Still open, or the click went somewhere else: start again from the screen.
            if (page.url().split('#')[0] !== home || await page.evaluate((POPUP) => [...document.querySelectorAll(POPUP)].some((el) => el.getClientRects().length > 0), POPUP)) { await open(r, page, t.path); await openers(page); }
        }

        // Dark: the page is loaded again so a theme chosen by script at load time is seen too.
        await page.emulateMedia({ colorScheme: 'dark' });
        try {
            await open(r, page, t.path);
            if ((await colours()) === light) {
                r.record({ suite: S, where: `${t.name} · dark`, check: 'dark mode', status: 'info', detail: "skipped: the page looks the same with prefers-color-scheme: dark, so it has no dark mode to check" });
                return;
            }
            await page.addScriptTag({ content: AXE });
            const axe: any = await page.evaluate(() => (window as any).axe.run(document, { runOnly: { type: 'rule', values: ['color-contrast'] }, resultTypes: ['violations'] }));
            const contrast = axe.violations.flatMap((v: any) => v.nodes.map((n: any) => n.target.join(' ')));
            // ponytail: reads rgb() colours only; a background written in another colour space (oklch, color()) is not seen.
            const white = await page.evaluate(() => {
                const hits: Element[] = [];
                for (const el of document.querySelectorAll('body, body *')) {
                    const b = el.getBoundingClientRect(), s = getComputedStyle(el), c = s.backgroundColor.match(/[\d.]+/g);
                    if (b.width < 40 || b.height < 16 || s.visibility === 'hidden' || !s.backgroundColor.startsWith('rgb') || !c || (c[3] !== undefined && +c[3] <= 0.5) || +c[0] <= 235 || +c[1] <= 235 || +c[2] <= 235) continue;
                    if (!el.closest('img, svg, canvas, video, iframe') && !hits.some((h) => h.contains(el))) hits.push(el);
                }
                return hits.slice(0, 5).map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : ''} (${getComputedStyle(el).backgroundColor})`);
            });
            await emit(page, t, 'dark', `${t.name} · dark`, { 'dark mode: text contrast (axe)': contrast, 'dark mode: no background left white': white });
        } finally {
            await page.emulateMedia({ colorScheme: 'light' });
        }
    }

    for (const vp of [desktop, ...NARROW]) {
        const first = vp === desktop;
        const ctx = await context(r, vp, true, first); // axe is injected on desktop, so the page's own CSP is set aside there
        const page = await ctx.newPage();
        try {
            if (first) {
                // The screens to audit, then crawled pages up to audit.max; found once, used at every size.
                const left: string[] = [];
                const add = (name: string, path: string) => { if (skip?.test(path)) left.push(path); else if (!out.screens.some((x) => x.path === path)) out.screens.push({ name, path, views: {} }); };
                for (const s of r.side.screens.length ? r.side.screens : [{ name: 'Home', path: '/' }]) {
                    const path = await resolve(r, page, s).catch((e) => { if (e instanceof SessionExpired) throw e; return null; });
                    if (path) add(s.name, path); else r.record({ suite: S, where: s.name, check: 'screen reachable', status: 'warn', detail: 'no link to it found' });
                }
                const configured = out.screens.length;
                for (const p of r.cfg.audit.max ? r.crawl.pages : []) if (p.status >= 200 && p.status < 400 && out.screens.length < configured + r.cfg.audit.max) add(p.path, p.path);
                if (r.cfg.audit.max && !r.crawl.done) r.record({ suite: S, where: 'audit.max', check: 'crawled pages audited', status: 'info', detail: "none: the crawl didn't run in this run, so only the screens were audited (choose crawl too: ONLY=crawl,audit)" });
                if (left.length) r.record({ suite: S, where: 'audit.skip', check: 'pages left out', status: 'info', detail: [...new Set(left)].slice(0, 8).join(', ') });
            }
            for (const t of out.screens) {
                const where = `${t.name} · ${vp.name}`;
                try {
                    if (first) { await onDesktop(page, t); continue; }
                    await open(r, page, t.path);
                    await emit(page, t, vp.name, where, (await page.evaluate(measure, { extras: false })).problems);
                } catch (e) {
                    if (e instanceof SessionExpired) throw e;
                    r.record({ suite: S, where, check: 'audit ran', status: 'fail', detail: (e as Error).message.slice(0, 200) });
                }
            }
        } finally {
            await ctx.close();
        }
    }

    // Across the screens: one look per kind of control.
    const across = 'all audited screens';
    for (const [kind, shapes] of looks) {
        const by = [...shapes].sort((a, b) => b[1].n - a[1].n);
        const paints = new Set(by.flatMap(([, u]) => [...u.paints]));
        r.record({ suite: S, where: across, check: `consistency: one size and radius per ${kind}`, status: by.length > 1 ? 'warn' : 'pass',
            detail: `${by.length} look(s): ${by.slice(0, 4).map(([shape, u]) => `${shape} ×${u.n}${u.labels.size ? ` (${[...u.labels].join(', ')})` : ''}`).join('; ')}` });
        r.record({ suite: S, where: across, check: `consistency: ${kind} colours`, status: paints.size > (PAINTS[kind] ?? 1) ? 'warn' : 'pass', detail: `${paints.size} colour scheme(s): ${[...paints].slice(0, 4).join('; ')}` });
        out.components[kind] = by.map(([shape, u]) => ({ shape, uses: u.n, labels: [...u.labels], colours: [...u.paints] }));
    }
    // Label case: Title Case needs two capitalised words after the first, sentence case none; names and one-word labels count as neither.
    const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
    const rest = (l: string) => l.split(/\s+/).slice(1).filter((w) => /^[A-Za-z]/.test(w) && !SMALL.has(w.toLowerCase()));
    const caps = (l: string) => rest(l).filter((w) => /^[A-Z][a-z]/.test(w)).length;
    const title = [...labels].filter((l) => rest(l).length >= 2 && caps(l) >= 2 && caps(l) / rest(l).length > 0.6), sentence = [...labels].filter((l) => rest(l).length >= 1 && caps(l) === 0);
    const odd = title.length && sentence.length ? (title.length <= sentence.length ? title : sentence) : [];
    r.record({ suite: S, where: across, check: 'labels use one case', status: odd.length ? 'warn' : 'pass',
        detail: odd.length ? `${title.length} in Title Case, ${sentence.length} in sentence case; the fewer: ${odd.slice(0, 6).map((l) => `"${l}"`).join(', ')}` : undefined });
    out.labelCase = { title, sentence };
    for (const [list, word] of [['colors', 'colours'], ['fonts', 'fonts'], ['radii', 'radii'], ['spacing', 'spacing']] as const) {
        if (!r.cfg.design?.[list]) continue;
        const worst = [...(outside.get(list) ?? [])].sort((a, b) => b[1].n - a[1].n);
        r.record({ suite: S, where: across, check: `design tokens: ${word}`, status: worst.length ? 'warn' : 'pass',
            detail: worst.length ? `${worst.length} value(s) outside design.${list}; most used: ${worst.slice(0, 6).map(([v, u]) => `${v} ×${u.n} (${u.at})`).join('; ')}` : undefined });
        out.tokens[list] = worst.map(([value, u]) => ({ value, uses: u.n, first: u.at }));
    }
    writeFileSync(`${r.dir}/audit.json`, JSON.stringify(out, null, 2));
}
