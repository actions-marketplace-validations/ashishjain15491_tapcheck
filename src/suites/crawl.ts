/*
 * End-to-end crawl (measured, no Jev). Breadth-first from the side's screens (or / when none are configured) through every
 * in-app link they show, two levels deep and at most crawl.max pages: each page's status, load time (to the load event, not
 * to the quiet network the crawl then waits for), console and page
 * errors, broken images, links that answer 4xx/5xx, form fields without a label, and every request the page made (kept for
 * the contract and security suites). GET only: links matching crawl.skip (sign out, delete, export…) are never followed.
 * With a `routes` command, the app's parameterless GET routes fill what the links leave of crawl.max (one this side is
 * refused, or that isn't a page, is left out quietly), and "route coverage" says how many GET routes the crawl reached; the rest are listed in
 * missed-routes.json. Two configured screens that land on one address, or show the same title, heading and controls, get
 * a "screens are distinct" warning: every suite would report that screen's findings twice.
 */
import { writeFileSync } from 'node:fs';
import type { Page, Request, Response } from 'playwright';
import { abs, context, facts, here, host, load, marked, reachHash, signedIn, site, watch, type Hit, type Run } from '../browser.ts';
import { coverage, hasParams, routes } from '../routes.ts';

const SLOW_MS = 3000;

/** The top-level keys of a JSON value, sorted; ['[array]'] for a list, null for anything else. */
const keysOf = (j: unknown) => (Array.isArray(j) ? ['[array]'] : j && typeof j === 'object' ? Object.keys(j).sort() : null);
export function shape(body: string): string[] | null {
    try { return keysOf(JSON.parse(body)); } catch { return null; }
}

function listen(r: Run, page: Page, current: () => string) {
    const started = new Map<Request, number>();
    page.on('request', (q) => started.set(q, Date.now()));
    page.on('response', async (res: Response) => {
        const q = res.request();
        const ct = res.headers()['content-type'] ?? '';
        const hit: Hit = { url: q.url(), method: q.method(), type: q.resourceType(), status: res.status(), contentType: ct,
            ms: Date.now() - (started.get(q) ?? Date.now()), bytes: 0, page: current() };
        r.crawl.hits.push(hit);
        if (['xhr', 'fetch'].includes(hit.type)) {
            const body = await res.text().catch(() => null);
            if (body === null || (body === '' && res.status() !== 204 && res.status() < 300 && !res.headers()['content-length'])) return; // unread: the page moved on first
            hit.bytes = body.length;
            if (/json/.test(ct) && body !== '') { try { hit.keys = keysOf(JSON.parse(body)) ?? undefined; hit.json = 'ok'; } catch { hit.json = 'invalid'; } }
            hit.body = body.slice(0, 400);
        }
    });
}

export async function run(r: Run) {
    const S = 'crawl';
    const own = host(r.side.baseUrl);
    const skip = r.cfg.crawl.skip;
    const gets = routes(r.cfg).filter((x) => x.method === 'GET' && !skip.test(x.path)); // the same list for every side
    const signedOut = 'none' in r.side.login;
    const ctx = await context(r, r.cfg.viewports[0]);
    const page = await ctx.newPage();
    let current = '';
    listen(r, page, () => current);
    const errors = watch(page);
    const seeds = r.side.screens.filter((s) => s.path && host(abs(r, s.path)) === own).map((s) => s.path!);
    const queue = (seeds.length ? seeds : ['/']).map((path) => ({ path, depth: 0, route: false }));
    const seen = new Set(queue.map((q) => q.path));
    // The routes fill what the links leave of crawl.max: links first, so a long route list can't crowd them out.
    // A signed-out side skips the routes the list marks as needing sign-in: each would only redirect to it.
    const fill = gets.filter((x) => !hasParams(x.path) && !seen.has(x.path) && !(signedOut && x.auth)).map((x) => ({ path: x.path, depth: 0, route: true }));
    let visits = 0;
    const linkStatus = new Map<string, number>();
    const shown: { path: string; url: string; looks: string }[] = []; // the configured screens opened so far

    try {
        while (visits < r.cfg.crawl.max) {
            const next = queue.shift() ?? fill.shift();
            if (!next) break;
            const { path, depth, route } = next;
            if (route && seen.has(path)) continue; // a link reached it already
            if (route) seen.add(path);
            current = path;
            errors.length = 0;
            const t0 = Date.now();
            let download = false; // a link to a file (a PDF invoice): Playwright downloads it and goto throws
            const res = await load(page, abs(r, path)).catch((e: Error) => { download = /Download is starting/.test(e.message); return null; });
            if (download) continue; // not a page; "in-app links answer" still checks that it answers
            // The load time is the document's own (Navigation Timing), else the time until `load` fired. The wait for a quiet
            // network after it lets the page settle and isn't counted: an app with a live feed never goes quiet.
            await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
            const waited = Date.now() - t0;
            const ms = Math.round(await page.evaluate(() => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.loadEventEnd ?? 0).catch(() => 0)) || waited;
            await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
            const finalPath = here(page.url(), path);
            const st = res?.status() ?? 0;
            // A route from the list that isn't this side's (refused, sent to sign in) or isn't a page (a download): not a finding.
            if (route && (st === 0 || [401, 403, 404, 405].includes(st) || (r.cfg.loginPaths.test(finalPath) && !r.cfg.loginPaths.test(path)))) continue;
            await signedIn(r, page, path);
            reachHash(r, page, path, st);
            const f = await facts(page).catch(() => null);
            const screen = depth === 0 && !route ? r.side.screens.find((s) => s.path === path) : undefined;
            if (screen && f) {
                // The same screen twice: one address, or one title, main heading and list of controls (a page with no control is left alone).
                const heading = await page.evaluate(() => document.querySelector('h1')?.textContent?.trim() ?? '').catch(() => '');
                const now = { path, url: page.url(), looks: f.controls.length ? JSON.stringify([f.title, heading, f.controls.map((c) => c.label)]) : '' };
                const twin = shown.find((o) => o.url === now.url || (now.looks && o.looks === now.looks));
                if (twin) r.record({ suite: S, where: path, check: 'screens are distinct', status: 'warn', detail: `"${screen.name}" renders the same as "${r.side.screens.find((s) => s.path === twin.path)!.name}" (${twin.path}): every suite reports its findings twice; drop one from screens` });
                shown.push(now);
            }
            const links = [...new Set((f?.controls ?? []).map((c) => c.href).filter((h): h is string => !!h && host(h) === own)
                .map((h) => { const u = new URL(h); return u.pathname + u.search + (/^#!?\//.test(u.hash) ? u.hash : ''); }))]; // #/orders is a route, #section a place on the page
            r.crawl.pages.push({ path, status: st, finalPath, ms, errors: [...errors], links });
            visits++;

            const where = path;
            r.record({ suite: S, where, check: 'page answers', status: st >= 200 && st < 400 ? 'pass' : 'fail', detail: `${st}${finalPath !== path.split('?')[0].replace(/#$/, '') ? ` → ${finalPath}` : ''}` });
            r.record({ suite: S, where, check: `loads under ${SLOW_MS} ms`, status: ms < SLOW_MS ? 'pass' : 'warn', detail: `${ms} ms` });
            r.record({ suite: S, where, check: 'no console or page errors', status: errors.length ? 'fail' : 'pass', detail: errors.slice(0, 3).join(' | ') || undefined });
            // MARK=1: the elements a failing check tagged while it measured, boxed on the page as it is now.
            const shot = async (check: string, detail: string, tag: string) => { const m = r.cfg.marks ? await marked(r, page, `crawl ${where} ${check}`, { status: 'fail', title: check, detail: `${where} · ${detail}` }, [{ target: `[data-tapcheck-mark-${tag}]` }]) : undefined; return m ? [m] : undefined; };
            if (f?.brokenImages.length) r.record({ suite: S, where, check: 'images load', status: 'fail', detail: f.brokenImages.slice(0, 5).join(', '), evidence: await shot('images load', f.brokenImages.slice(0, 5).join(', '), 'broken') });
            const unlabelled = await page.$$eval('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea', (els) => els.filter((el) => {
                const e = el as HTMLInputElement;
                if (e.offsetParent === null || el.closest('[aria-hidden=true]')) return false;
                return !(e.labels?.length || e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.title);
            }).map((el) => { el.setAttribute('data-tapcheck-mark-unlabelled', 'no label'); return (el as HTMLInputElement).name || el.id || el.tagName.toLowerCase(); })).catch(() => [] as string[]);
            r.record({ suite: S, where, check: 'form fields labelled', status: unlabelled.length ? 'fail' : 'pass', detail: unlabelled.slice(0, 6).join(', ') || undefined,
                evidence: unlabelled.length ? await shot('form fields labelled', unlabelled.slice(0, 6).join(', '), 'unlabelled') : undefined });

            for (const l of links) {
                if (skip.test(l.split('?')[0])) continue;
                if (!linkStatus.has(l)) {
                    const lr = await page.request.get(abs(r, l), { maxRedirects: 3, failOnStatusCode: false }).catch(() => null);
                    linkStatus.set(l, lr?.status() ?? 0);
                }
                if (depth < 2 && !seen.has(l) && !/[?&](page|sort|q|search)=/.test(l)) { seen.add(l); queue.push({ path: l, depth: depth + 1, route: false }); }
            }
        }
    } finally {
        await ctx.close();
    }

    const broken = [...linkStatus].filter(([, s]) => s === 0 || s >= 400);
    r.record({ suite: S, where: 'all crawled pages', check: 'in-app links answer', status: broken.length ? 'fail' : 'pass',
        detail: broken.length ? broken.slice(0, 10).map(([l, s]) => `${s} ${l}`).join('; ') : `${linkStatus.size} links checked` });
    r.record({ suite: S, where: 'all crawled pages', check: 'crawl coverage', status: 'info', detail: `${r.crawl.pages.length} pages, ${r.crawl.hits.length} requests, cap ${r.cfg.crawl.max}` });
    if (gets.length) {
        // Reached: every GET on this site that answered 2xx, pages and the requests they made alike. The route list names no
        // host, so a path on the app's API host (api.<domain>) counts as it does on its own.
        const reached = r.crawl.hits.filter((h) => h.method === 'GET' && site(h.url) === site(r.side.baseUrl) && h.status >= 200 && h.status < 300).map((h) => new URL(h.url).pathname);
        const { total, missed } = coverage(gets, reached);
        writeFileSync(`${r.dir}/missed-routes.json`, JSON.stringify(missed, null, 2));
        r.record({ suite: S, where: 'routes', check: 'route coverage', status: 'info',
            detail: `${total - missed.length}/${total} GET routes reached${missed.length ? `; unreached in ${r.dir}/missed-routes.json` : ''}` });
    }
    r.crawl.done = true;
    writeFileSync(`${r.dir}/crawl.json`, JSON.stringify({ pages: r.crawl.pages, links: Object.fromEntries(linkStatus) }, null, 2));
    writeFileSync(`${r.dir}/network.json`, JSON.stringify(r.crawl.hits, null, 2));
}
