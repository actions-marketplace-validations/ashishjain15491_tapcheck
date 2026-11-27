/*
 * Usability testing with a simulated first-time user, plus clickstream analysis. For each task in tapcheck.yml Jev picks
 * the next control from what is on screen (by label and place), as a person who has never seen the app would; code clicks
 * it and records the clickstream: target, coordinates, time on step, URL change and dead clicks (nothing changed). Code
 * then scores the task: reached or not, clicks against the shortest path, hesitations, dead clicks and errors. A
 * clickstream map draws the clicks over each step's screen. Runs on the first desktop-sized viewport.
 *
 * Safety: tapcheck only navigates. Submit buttons, links matching crawl.skip and anything labelled delete, send, publish,
 * pay or sign out are never offered as a choice; text is typed only into fields outside a POST form; and Jev is asked
 * about the one control about to be clicked, which is left alone unless that answer is a clear "this changes nothing".
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Page, Response } from 'playwright';
import { mainViewport, type Task } from '../config.ts';
import { context, open, SessionExpired, settle, slug, type Run } from '../browser.ts';
import { ask, bad, BudgetReached, good, img, NO } from '../jev.ts';
import { MAX_STEPS, SCROLL, TASK_Q } from '../questions.ts';

const S = 'usability';
export const UNSAFE = /\b(delete|remove|destroy|log ?out|sign out|send|publish|unpublish|pay|upgrade|downgrade|cancel|archive|disconnect|revoke|unsubscribe|reset|discard|take down|impersonat|dark mode|light mode|theme)/i;

type Req = { method: string; url: string; status: number };
type Click = { step: number; label: string; place: string; x: number; y: number; from: string; to: string; ms: number; dead: boolean; hesitation: number; shot: string; requests: Req[] };

// ponytail: fixed bands, enough to tell two same-labelled controls apart; read the page's landmarks if this misnames them.
const place = (c: { x: number; y: number }) => (c.y < 72 ? 'at the top of the screen' : c.x < 260 ? 'on the left side' : 'in the main area');

/**
 * Visible, safe controls in the first screen, keyed by label and place so two "Create" buttons stay two options.
 * A text field is offered as "type the task's text into it" (and not at all when the task has nothing to type: focusing
 * a field alone goes nowhere). `tried` holds controls already used on this screen with no effect, so they are not
 * offered again.
 */
async function options(r: Run, page: Page, vh: number, text: string | undefined, tried: Set<string>) {
    const visible = [];
    for (const h of await page.$$('a[href], button, [role=button], input:not([type=hidden]), select, textarea, summary')) if (await h.isVisible()) visible.push(h);
    type C = { tag: string; label: string; icon: boolean; x: number; y: number; w: number; h: number; submit: boolean; hidden: boolean; covered: boolean; field: boolean; reads: boolean; path: string; typing?: boolean };
    const controls: C[] = await Promise.all(visible.map((h) => h.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const shown = ((el as HTMLElement).innerText || '').trim();
        const label = (shown || el.getAttribute('aria-label') || el.getAttribute('title') || (el as HTMLInputElement).placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        const form = (el as HTMLInputElement).form; // also set for a control tied to a form by its form= attribute
        // A form's submit button (an untyped button of a form submits too) would save something, so it is never offered.
        const submit = el.matches('button[type=submit], input[type=submit], input[type=image]') || (el.matches('button:not([type])') && !!form);
        const field = el.matches('textarea, input:not([type]), input[type=text], input[type=search], input[type=email]');
        // Something else is on top at its centre (an open flyout, a sticky bar): a click there would never land.
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { tag: el.tagName.toLowerCase(), label, icon: !shown && !el.matches('input, select, textarea'), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), submit, hidden: !!el.closest('[aria-hidden=true]'), covered: !!top && !el.contains(top), field, reads: !form || form.method === 'get',
            path: el instanceof HTMLAnchorElement ? el.pathname : '' };
    })));
    const opts: Record<string, string> = {};
    const at: Record<string, { i: number; c: C }> = {};
    for (const [i, c] of controls.entries()) {
        if (!c.label || c.hidden || c.covered || c.submit || c.y < 0 || c.y > vh || UNSAFE.test(c.label) || (c.path && r.cfg.crawl.skip.test(c.path))) continue;
        // Enter in a field submits its form, so text is typed only outside a form or in one that reads (GET, as a search does).
        if (c.field && (!text || !c.reads)) continue;
        const k = slug(`${c.field ? 'type into ' : ''}${c.label} ${place(c)}`);
        if (opts[k] || tried.has(`${page.url()}|${k}`)) continue;
        opts[k] = c.field
            ? `Type "${text}" into the field labelled "${c.label}", ${place(c)}, and press Enter.`
            // A control with no words on it is described as what a first-time user sees; its hidden name is what hovering shows.
            : `The ${c.tag === 'a' ? 'link' : c.tag === 'summary' ? 'expandable section' : c.tag} ${c.icon ? `that is an icon with no visible text (tooltip "${c.label}")` : `labelled "${c.label}"`}, ${place(c)}.`;
        at[k] = { i, c: { ...c, typing: c.field } };
    }
    return { opts, at, visible };
}

/** The clicks drawn over each step's screen: a numbered dot per click, red when nothing happened. */
async function clickMap(page: Page, all: Click[], out: string) {
    const clicks = all.filter((c) => c.place); // scrolls have no spot to mark
    if (!clicks.length) return;
    const { width, height } = page.viewportSize()!;
    const p = await page.context().newPage();
    await p.setViewportSize({ width, height });
    const panes = clicks.map((c) => `<div style="position:relative;width:${width}px;height:${height}px;background:url(data:image/png;base64,${readFileSync(c.shot).toString('base64')}) 0 0/100% 100%">`
        + `<div style="position:absolute;left:${c.x - 14}px;top:${c.y - 14}px;width:28px;height:28px;border-radius:50%;background:${c.dead ? '#dc2626' : '#2563eb'};`
        + `color:#fff;font:bold 14px system-ui;display:grid;place-items:center;box-shadow:0 0 0 6px ${c.dead ? '#dc262655' : '#2563eb55'}">${c.step}</div>`
        + `<div style="position:absolute;left:8px;top:8px;background:#111c;color:#fff;font:13px system-ui;padding:4px 8px;border-radius:4px">${c.step}. ${c.label} · ${c.ms} ms${c.dead ? ' · dead click' : ''}</div></div>`).join('');
    await p.setContent(`<body style="margin:0">${panes}</body>`);
    await p.screenshot({ path: out, fullPage: true });
    await p.close();
}

async function attempt(r: Run, page: Page, t: Task, vh: number) {
    await open(r, page, t.from);
    const clicks: Click[] = [];
    const tried = new Set<string>(); // url|option that changed nothing: not offered again on that screen
    let reached = false, note = '', errorShown = false;
    for (let step = 1; step <= MAX_STEPS + 1; step++) {
        const shot = `${r.dir}/shots/task-${slug(t.name)}-${step}.png`;
        await page.screenshot({ path: shot });
        const { opts, at, visible } = await options(r, page, vh, t.text, tried);
        // Scrolling is an option while there is more page below, at most twice per screen (a third look is a lost user).
        const scrolled = clicks.filter((c) => !c.place && c.from === page.url()).length;
        if (scrolled < 2 && await page.evaluate(() => scrollY + innerHeight < document.documentElement.scrollHeight - 40)) opts[SCROLL] = 'Scroll down to see more of the page.';
        // The last look only asks whether the goal is reached: after the last allowed click, or with nothing safe to click.
        const out = step === MAX_STEPS + 1, last = out || !Object.keys(opts).length;
        const q: Record<string, any> = { arrived: TASK_Q.arrived(t), error: TASK_Q.error };
        if (!last) Object.assign(q, { can_progress: TASK_Q.can_progress, hesitation: TASK_Q.hesitation, pick: TASK_Q.pick(opts) });
        const a = await ask(`task-${slug(t.name)}-${step}`, { goal: t.goal, already_clicked: clicks.map((c) => c.label), screenshot: img(shot), controls: Object.values(opts) }, q, [shot]);
        errorShown ||= bad(a.error.noul) === 'FAIL';
        if (step > 1 && good(a.arrived.noul) === 'pass') { reached = true; break; }
        if (last) { note = `${out ? `not reached after ${MAX_STEPS} clicks` : 'no safe control to click'} (p=${a.arrived.noul.toFixed(2)})`; break; }
        if (good(a.can_progress.noul) === 'FAIL') { note = `stuck: nothing on screen leads toward the goal (step ${step})`; break; }
        if (a.pick.choice === SCROLL) {
            await page.mouse.wheel(0, vh * 0.8);
            await settle(page);
            clicks.push({ step, label: '(scrolled down)', place: '', x: 0, y: 0, from: page.url(), to: page.url(), ms: 0, dead: false, hesitation: a.hesitation.noul, shot, requests: [] });
            continue;
        }
        const pick = at[a.pick.choice];
        if (!pick || !visible[pick.i]) { note = 'the chosen control was not found'; break; }
        // Guard: Jev judges the one control about to be clicked; above the "no" line it is not clicked and the task stops.
        const g = await ask(`task-${slug(t.name)}-${step}-guard`, { screenshot: img(shot), control: opts[a.pick.choice] }, { irreversible: TASK_Q.irreversible }, [shot]);
        if (g.irreversible.noul > NO) { note = `stopped before "${pick.c.label}": it may change data (p=${g.irreversible.noul.toFixed(2)})`; break; }
        const from = page.url();
        const before = await page.evaluate(() => document.body.innerHTML.length);
        const requests: Req[] = [];
        const onResponse = (res: Response) => { if (['xhr', 'fetch', 'document'].includes(res.request().resourceType())) requests.push({ method: res.request().method(), url: res.url(), status: res.status() }); };
        page.on('response', onResponse);
        const t0 = Date.now();
        try {
            if (pick.c.typing) { await visible[pick.i].fill(t.text!, { timeout: 5000 }); await visible[pick.i].press('Enter'); } // a search shows suggestions or submits
            else {
                // As a person does: the pointer arrives first, and a rail that widens under it has moved the control before the click.
                await visible[pick.i].hover({ timeout: 5000 });
                await page.waitForTimeout(250);
                await visible[pick.i].click({ timeout: 5000 });
            }
        } catch (e) { page.off('response', onResponse); note = `${pick.c.typing ? 'typing' : 'click'} failed on "${pick.c.label}": ${(e as Error).message.split('\n')[0].slice(0, 80)}`; break; }
        await settle(page);
        page.off('response', onResponse);
        const after = await page.evaluate(() => document.body.innerHTML.length);
        const to = page.url();
        // The pointer leaves, so a menu that opens on hover closes instead of covering the next screen.
        // ponytail: the top right corner, where few apps open anything on hover; pick a point over no control if one does.
        await page.mouse.move(page.viewportSize()!.width - 1, 0);
        await page.waitForTimeout(300);
        const c = pick.c;
        const dead = to === from && Math.abs(after - before) < 20 && !requests.length;
        if (dead || c.typing) tried.add(`${from}|${a.pick.choice}`);
        clicks.push({ step, label: c.typing ? `typed "${t.text}" into ${c.label}` : c.label, place: place(c), x: Math.round(c.x + c.w / 2), y: Math.round(c.y + c.h / 2), from, to,
            // Focusing a field changes nothing on screen by design, so only buttons and links can be dead clicks.
            ms: Date.now() - t0, dead: !c.typing && !['input', 'select', 'textarea'].includes(c.tag) && dead,
            hesitation: a.hesitation.noul, shot, requests });
    }
    return { reached, note, clicks, errorShown };
}

export async function run(r: Run) {
    // The check and status of a skipped part, so the report lists it under Skipped instead of counting it as clean.
    if (!r.side.tasks.length) { r.record({ suite: S, where: `${S}-${r.side.name}`, check: 'part ran', status: 'info', detail: 'skipped: no tasks for this side' }); return; }
    mkdirSync(`${r.dir}/shots`, { recursive: true });
    const vp = mainViewport(r.cfg);
    const ctx = await context(r, vp);
    const page = await ctx.newPage();
    const stream: unknown[] = [];
    try {
        for (const t of r.side.tasks) {
            const where = `${t.name}: ${t.goal}`;
            try {
                const a = await attempt(r, page, t, vp.height);
                const map = `${r.dir}/shots/clickstream-${slug(t.name)}.png`;
                await clickMap(page, a.clicks, map);
                const ev = a.clicks.some((c) => c.place) ? [map] : [];
                r.record({ suite: S, where, check: 'task completed', status: a.reached ? 'pass' : 'fail',
                    detail: [a.note, `${a.clicks.length} click(s): ${a.clicks.map((c) => c.label).join(' → ')}`].filter(Boolean).join(' · '), evidence: ev });
                if (a.reached) {
                    const extra = a.clicks.length - t.optimal;
                    r.record({ suite: S, where, check: 'path efficiency', status: extra <= 0 ? 'pass' : extra === 1 ? 'warn' : 'fail', detail: `${a.clicks.length} clicks, shortest path ${t.optimal}`, evidence: ev });
                }
                const hes = a.clicks.filter((c) => c.hesitation > 0.5);
                r.record({ suite: S, where, check: 'no hesitation', status: hes.length ? 'warn' : 'pass', detail: hes.map((c) => `step ${c.step} (p=${c.hesitation.toFixed(2)})`).join(', ') || undefined, evidence: ev });
                const dead = a.clicks.filter((c) => c.dead);
                r.record({ suite: S, where, check: 'no dead clicks', status: dead.length ? 'fail' : 'pass', detail: dead.map((c) => `"${c.label}"`).join(', ') || undefined, evidence: ev });
                r.record({ suite: S, where, check: 'no error on the way', status: a.errorShown ? 'fail' : 'pass' });
                // Request correlation: which click set off a failing request.
                const failed = a.clicks.flatMap((c) => c.requests.filter((q) => q.status >= 400).map((q) => `"${c.label}" → ${q.status} ${q.method} ${new URL(q.url).pathname}`));
                r.record({ suite: S, where, check: 'clicks set off no failing requests', status: failed.length ? 'fail' : 'pass',
                    detail: failed.slice(0, 5).join('; ') || `${a.clicks.reduce((n, c) => n + c.requests.length, 0)} request(s) across ${a.clicks.length} click(s)`, evidence: ev });
                stream.push({ task: t.name, goal: t.goal, reached: a.reached, note: a.note, clicks: a.clicks });
            } catch (e) {
                if (e instanceof BudgetReached || e instanceof SessionExpired) throw e;
                r.record({ suite: S, where, check: 'task ran', status: 'fail', detail: (e as Error).message.slice(0, 200) });
            }
        }
    } finally {
        writeFileSync(`${r.dir}/clickstream.json`, JSON.stringify(stream, null, 2));
        await ctx.close();
    }
}
