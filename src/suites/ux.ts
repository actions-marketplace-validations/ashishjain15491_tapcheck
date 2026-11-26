/*
 * Deep UI/UX audit, per screen and viewport:
 * - visual QA (loaded, errors, overlap, clipping, alignment; left to the audit suite for a desktop screen it already
 *   asked about in this run) and measured facts (status, sideways scroll, broken images, off-screen controls, a single
 *   h1, JS errors; target size is the audit suite's, which knows the spacing exception);
 * - visual design: CTA clarity and label (not judged on a screen Jev says has no main call to action), negative space (Jev's judgment plus measured text coverage), density, hierarchy,
 *   legibility, spacing rhythm;
 * - heuristic evaluation: the usability heuristics a screenshot can show;
 * - guerrilla five-second test on the first screen: does a passer-by get the screen's job, and pick it among the others;
 * - predicted attention (desktop): the first three places the eye goes and the main CTA as Jev boxes, drawn as a heatmap,
 *   with code checking that the CTA is among the first three looks. These are predictions, not eye-tracking data;
 * - raw translation keys, measured: visible text that is exactly one of the keys the i18n.keys command prints, or an
 *   unfilled :placeholder.
 * Jev judges, code decides: an unsure answer is a warning for a person to look at, never a pass.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Page } from 'playwright';
import type { Screen } from '../config.ts';
import { abs, context, facts, open, resolve, SessionExpired, slices, slug, watch, type Run } from '../browser.ts';
import { ask, bad, BudgetReached, good, img, looked, MIN_SCORE, NO, scoreStatus, status, to10 } from '../jev.ts';
import { ATTENTION, ATTENTION_CHECK, ATTENTION_MODEL, DESIGN, guerrilla, HEURISTICS, purposeKey, VISUAL } from '../questions.ts';

const S = 'ux';
// Negative space by measurement: text covering more than this share of the first screen reads as crowded.
const MAX_TEXT_COVERAGE = 0.32;

// A low score Jev was split on is a question for a person, not a defect: it is marked "needs review" (a warning).
const REVIEW_BELOW = 0.3;
function scored(r: Run, where: string, check: string, a: { score: number; confidence: number }, ev: string[]) {
    const v = to10(a.score);
    const review = v < MIN_SCORE && a.confidence < REVIEW_BELOW;
    r.record({ suite: S, where, check, status: scoreStatus(v, a.confidence, REVIEW_BELOW),
        detail: `${v}/10 (confidence ${a.confidence.toFixed(2)})${review ? ' · needs review: Jev was split' : ''}`, evidence: ev });
}

/**
 * The app's translation keys, from the i18n.keys command (one per line). Only dotted identifiers count as keys.
 * ponytail: catalogues keyed by the English sentence itself can't be told from real text, so they are ignored here.
 */
function translationKeys(r: Run): Set<string> {
    if (!r.cfg.i18n.keys) return new Set();
    const out = execSync(r.cfg.i18n.keys, { encoding: 'utf8', shell: '/bin/sh', maxBuffer: 64 * 1024 * 1024 });
    return new Set(out.split('\n').map((k) => k.trim()).filter((k) => /^[\w-]+(\.[\w-]+)+$/.test(k)));
}

type Box = { top: number; bottom: number; left: number; right: number };
/** Two boxes are the same element when they share more than half of the smaller one. */
function same(a: Box, b: Box) {
    const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)), h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const area = (x: Box) => (x.right - x.left) * (x.bottom - x.top);
    return (w * h) / Math.max(1e-6, Math.min(area(a), area(b))) > 0.5;
}

/** The screenshot with the predicted looks as a heat overlay and numbered boxes, rendered by the browser itself. */
async function heatmap(page: Page, shot: string, looks: { label: string; box: Box; weight: number; colour: string }[], out: string) {
    const { width, height } = page.viewportSize()!;
    const src = `data:image/png;base64,${readFileSync(shot).toString('base64')}`;
    const blobs = looks.map((l) => {
        const cx = ((l.box.left + l.box.right) / 2) * 100, cy = ((l.box.top + l.box.bottom) / 2) * 100;
        const r = Math.max(8, ((l.box.right - l.box.left + l.box.bottom - l.box.top) / 2) * 100);
        return `radial-gradient(circle at ${cx}% ${cy}%, rgba(255,0,0,${0.55 * l.weight}) 0, rgba(255,140,0,${0.3 * l.weight}) ${r * 0.6}%, transparent ${r}%)`;
    }).join(',');
    const frames = looks.map((l, i) => `<div style="position:absolute;left:${l.box.left * 100}%;top:${l.box.top * 100}%;width:${(l.box.right - l.box.left) * 100}%;`
        + `height:${(l.box.bottom - l.box.top) * 100}%;border:2px solid ${l.colour};border-radius:4px"><b style="position:absolute;top:-22px;left:-2px;`
        + `background:${l.colour};color:#fff;font:12px system-ui;padding:2px 6px;border-radius:4px;white-space:nowrap">${i + 1}. ${l.label}</b></div>`).join('');
    const p = await page.context().newPage();
    await p.setViewportSize({ width, height });
    await p.setContent(`<body style="margin:0"><div style="position:relative;width:${width}px;height:${height}px;background:url(${src}) 0 0/100% 100%">`
        + `<div style="position:absolute;inset:0;background:${blobs};mix-blend-mode:multiply"></div>${frames}</div></body>`);
    await p.screenshot({ path: out });
    await p.close();
}

/** One finding per VISUAL question in `a` (the audit suite asks them too, of screens and of opened dialogs and menus). */
export function visual(r: Run, suite: string, where: string, a: Record<string, { noul: number }>, shots: string[]) {
    for (const [k, defect] of [['loaded', false], ['error_shown', true], ['overlap', true], ['clipped', true], ['raw_key', true], ['misaligned', true]] as const) {
        if (!a[k]) continue;
        const v = defect ? bad(a[k].noul) : good(a[k].noul);
        r.record({ suite, where, check: `visual: ${k.replace('_', ' ')}`, status: status(v), detail: `p=${a[k].noul.toFixed(2)}`, evidence: shots });
    }
}

export async function run(r: Run) {
    const screens: Screen[] = r.side.screens.length ? r.side.screens : [{ name: 'Home', path: '/' }];
    const known = translationKeys(r);
    for (const vp of r.cfg.viewports) {
        const ctx = await context(r, vp);
        const page = await ctx.newPage();
        const errors = watch(page);
        try {
            for (const s of screens) {
                const where = `${s.name} · ${vp.name}`;
                try {
                    const path = await resolve(r, page, s);
                    if (!path) { r.record({ suite: S, where, check: 'screen reachable', status: 'warn', detail: 'no link to it found' }); continue; }
                    errors.length = 0;
                    const res = await open(r, page, path);
                    const f = await facts(page);
                    const key = `ux-${slug(s.name)}-${vp.name}`;
                    const shots = await slices(r, page, key, f.height, vp.height);

                    // Measured, not asked.
                    const http = res?.status() ?? 0;
                    r.record({ suite: S, where, check: 'HTTP status', status: http && http < 400 ? 'pass' : 'fail', detail: `${http} ${abs(r, path)}` });
                    r.record({ suite: S, where, check: 'no sideways scroll', status: f.overflowX ? 'fail' : 'pass' });
                    r.record({ suite: S, where, check: 'images load', status: f.brokenImages.length ? 'fail' : 'pass', detail: f.brokenImages.slice(0, 5).join(', ') || undefined });
                    r.record({ suite: S, where, check: 'controls on screen', status: f.offscreen ? 'fail' : 'pass', detail: f.offscreen ? `${f.offscreen} off-screen: ${f.offscreenLabels.join(', ')}` : undefined });
                    r.record({ suite: S, where, check: 'one h1', status: f.h1 === 1 ? 'pass' : 'warn', detail: `${f.h1} h1 element(s)` });
                    r.record({ suite: S, where, check: 'no JS errors', status: errors.length ? 'fail' : 'pass', detail: errors.slice(0, 3).join(' | ') || undefined });
                    r.record({ suite: S, where, check: 'negative space (measured)', status: f.textCoverage > MAX_TEXT_COVERAGE ? 'warn' : 'pass',
                        detail: `text covers ${(f.textCoverage * 100).toFixed(1)}% of the first screen (limit ${MAX_TEXT_COVERAGE * 100}%)`, evidence: [shots[0]] });
                    const texts: string[] = await page.evaluate(() => {
                        const out: string[] = [];
                        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                        for (let n = w.nextNode(); n; n = w.nextNode()) {
                            const t = n.textContent?.trim(); const el = n.parentElement;
                            if (t && el && el.offsetParent !== null && !el.closest('script,style,code,pre,[aria-hidden=true]')) out.push(t);
                        }
                        for (const el of document.querySelectorAll('[placeholder],[aria-label],[title]')) for (const a of ['placeholder', 'aria-label', 'title']) { const v = el.getAttribute(a); if (v) out.push(v.trim()); }
                        return out;
                    });
                    const raw = [...new Set(texts.filter((t) => known.has(t) || /(^|\s):[a-z_]{2,}\b/.test(t)))];
                    r.record({ suite: S, where, check: 'no raw translation keys (measured)', status: raw.length ? 'fail' : 'pass', detail: raw.slice(0, 6).join(', ') || undefined, evidence: raw.length ? [shots[0]] : undefined });

                    // One request for every judgment over the same screenshots. The VISUAL questions are left out when the
                    // audit suite asked them of this screen at this viewport earlier in the run.
                    const audited = vp === r.cfg.viewports.find((v) => !v.mobile) && looked.has(`${r.dir} ${s.name}`);
                    const a = await ask(key, { screen: s.name, viewport: `${vp.name}, ${vp.width} × ${vp.height} px`, screenshots: shots.map(img),
                        note: shots.length > 1 ? 'The screenshots are consecutive slices of one screen, top to bottom.' : undefined },
                    { ...(audited ? {} : VISUAL), ...DESIGN, ...HEURISTICS(r.cfg.audience, r.cfg.context), ...ATTENTION_CHECK }, shots);
                    visual(r, S, where, a, shots);
                    // A screen Jev is clear has no main call to action isn't judged on one: the best it could score is a filter chip.
                    const noCta = a.has_cta.noul < NO ? `no main call to action on this screen (p=${a.has_cta.noul.toFixed(2)})` : '';
                    for (const k of ['cta', 'cta_label', 'negative_space', 'hierarchy', 'legibility', 'spacing'] as const) {
                        if (noCta && k.startsWith('cta')) r.record({ suite: S, where, check: `design: ${k.replace('_', ' ')}`, status: 'info', detail: noCta });
                        else scored(r, where, `design: ${k.replace('_', ' ')}`, a[k], shots);
                    }
                    const probs = Object.entries(a.density.probabilities ?? {}).map(([k, p]) => `${k} ${(p as number).toFixed(2)}`).join(', ');
                    r.record({ suite: S, where, check: 'design: density', status: a.density.choice === 'balanced' ? 'pass' : 'warn', detail: `${a.density.choice} (${probs})`, evidence: [shots[0]] });
                    for (const k of ['h1_status', 'h2_language', 'h4_consistency', 'h6_recognition', 'h8_minimalist'] as const) scored(r, where, `heuristic: ${k}`, a[k], shots);
                    r.record({ suite: S, where, check: 'heuristic: h10_help', status: status(good(a.h10_help.noul)), detail: `p=${a.h10_help.noul.toFixed(2)}`, evidence: shots });

                    // Guerrilla five-second test, on the first screen only. It needs the screen's purpose; picking the job
                    // among the others needs at least one other screen with a purpose.
                    if (s.purpose) {
                        const others = [...new Set(screens.filter((x) => x.name !== s.name && x.purpose && x.purpose !== s.purpose).map((x) => x.purpose!))].slice(0, 6);
                        const { purpose_pick, ...rest } = guerrilla(s.purpose, others);
                        const g = await ask(`${key}-guerrilla`, { screenshot: img(shots[0]) }, others.length ? { ...rest, purpose_pick } : rest, [shots[0]]);
                        r.record({ suite: S, where, check: 'guerrilla: purpose clear in 5s', status: status(good(g.purpose_clear.noul)), detail: `p=${g.purpose_clear.noul.toFixed(2)}`, evidence: [shots[0]] });
                        if (others.length) {
                            const picked = g.purpose_pick.choice === purposeKey(s.purpose);
                            r.record({ suite: S, where, check: 'guerrilla: right job picked', status: picked ? 'pass' : 'fail', detail: picked ? undefined : `read as "${g.purpose_pick.choice}"`, evidence: [shots[0]] });
                        }
                        scored(r, where, 'guerrilla: trust', g.trust, [shots[0]]);
                    } else {
                        r.record({ suite: S, where, check: 'guerrilla five-second test', status: 'info', detail: 'skipped: give the screen a purpose in tapcheck.yml to run it' });
                    }

                    // Predicted attention, desktop only.
                    if (!vp.mobile) {
                        const c = await ask(`${key}-cta-check`, { screenshot: img(shots[0]) }, ATTENTION_CHECK, [shots[0]]);
                        const at = await ask(`${key}-attention`, img(shots[0]), ATTENTION, [shots[0]], ATTENTION_MODEL);
                        const hasCta = good(c.has_cta.noul);
                        const looks = [
                            { label: 'first look', box: at.look_1.box, weight: 1, colour: '#dc2626' },
                            { label: 'second look', box: at.look_2.box, weight: 0.75, colour: '#ea580c' },
                            { label: 'third look', box: at.look_3.box, weight: 0.5, colour: '#ca8a04' },
                            ...(hasCta === 'pass' ? [{ label: 'main CTA', box: at.main_cta.box, weight: 0.4, colour: '#2563eb' }] : []),
                        ];
                        const map = `${r.dir}/shots/${key}-heatmap.png`;
                        await heatmap(page, shots[0], looks, map);
                        const seen = hasCta === 'pass' && looks.slice(0, 3).some((l) => same(l.box, at.main_cta.box));
                        r.record({ suite: S, where, check: 'attention: main CTA among first three looks', status: noCta ? 'info' : hasCta !== 'pass' ? 'warn' : seen ? 'pass' : 'fail',
                            detail: noCta || (hasCta !== 'pass' ? `no clear main CTA on the first screen (p=${c.has_cta.noul.toFixed(2)})` : seen ? undefined : 'the eye is predicted to land elsewhere first'),
                            evidence: [map] });
                    }
                } catch (e) {
                    if (e instanceof BudgetReached || e instanceof SessionExpired) throw e;
                    r.record({ suite: S, where, check: 'audit ran', status: 'fail', detail: (e as Error).message.slice(0, 200) });
                }
            }
        } finally {
            await ctx.close();
        }
    }
}
