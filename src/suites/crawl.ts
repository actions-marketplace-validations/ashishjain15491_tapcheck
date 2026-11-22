/*
 * End-to-end crawl (measured, no Jev). Breadth-first from the side's screens (or / when none are configured) through every
 * in-app link they show, two levels deep and at most crawl.max pages: each page's status, load time, console and page
 * errors, broken images, links that answer 4xx/5xx, form fields without a label, and every request the page made (kept for
 * the contract and security suites). GET only: links matching crawl.skip (sign out, delete, export…) are never followed.
 * With a `routes` command, the app's parameterless GET routes fill what the links leave of crawl.max (one this side is
 * refused, or that isn't a page, is left out quietly), and "route coverage" says how many GET routes the crawl reached; the rest are listed in
 * missed-routes.json.
 */
import { writeFileSync } from 'node:fs';
import type { Page, Request, Response } from 'playwright';
import { abs, context, facts, guard, host, watch, type Hit, type Run } from '../browser.ts';
import { coverage, hasParams, routes } from '../routes.ts';

const SLOW_MS = 3000;

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
            if (/json/.test(ct) && body !== '') { try { JSON.parse(body); hit.json = 'ok'; } catch { hit.json = 'invalid'; } }
            hit.body = body.slice(0, 400);
        }
    });
}

export async function run(r: Run) {
    const S = 'crawl';
    const own = host(r.side.baseUrl);
    const skip = r.cfg.crawl.skip;
    const gets = routes(r.cfg).filter((x) => x.method === 'GET' && !skip.test(x.path)); // the same list for every side
    const ctx = await context(r, r.cfg.viewports[0]);
    const page = await ctx.newPage();
    let current = '';
    listen(r, page, () => current);
    const errors = watch(page);
    const seeds = r.side.screens.filter((s) => s.path && host(abs(r, s.path)) === own).map((s) => s.path!);
    const queue = (seeds.length ? seeds : ['/']).map((path) => ({ path, depth: 0, route: false }));
    const seen = new Set(queue.map((q) => q.path));
    // The routes fill what the links leave of crawl.max: links first, so a long route list can't crowd them out.
    const fill = gets.filter((x) => !hasParams(x.path) && !seen.has(x.path)).map((x) => ({ path: x.path, depth: 0, route: true }));
    let visits = 0;
    const linkStatus = new Map<string, number>();

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
            const res = await page.goto(abs(r, path), { waitUntil: 'domcontentloaded' }).catch(() => null);
            await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
            const ms = Date.now() - t0;
            const finalPath = new URL(page.url()).pathname;
            const st = res?.status() ?? 0;
            // A route from the list that isn't this side's (refused, sent to sign in) or isn't a page (a download): not a finding.
            if (route && (st === 0 || [401, 403, 404, 405].includes(st) || (r.cfg.loginPaths.test(finalPath) && !r.cfg.loginPaths.test(path)))) continue;
            guard(r, path, page.url());
            const f = await facts(page).catch(() => null);
            const links = [...new Set((f?.controls ?? []).map((c) => c.href).filter((h): h is string => !!h && host(h) === own)
                .map((h) => { const u = new URL(h); return u.pathname + u.search; }))];
            r.crawl.pages.push({ path, status: st, finalPath, ms, errors: [...errors], links });
            visits++;

            const where = path;
            r.record({ suite: S, where, check: 'page answers', status: st >= 200 && st < 400 ? 'pass' : 'fail', detail: `${st}${finalPath !== path.split('?')[0] ? ` → ${finalPath}` : ''}` });
            r.record({ suite: S, where, check: `loads under ${SLOW_MS} ms`, status: ms < SLOW_MS ? 'pass' : 'warn', detail: `${ms} ms` });
            r.record({ suite: S, where, check: 'no console or page errors', status: errors.length ? 'fail' : 'pass', detail: errors.slice(0, 3).join(' | ') || undefined });
            if (f?.brokenImages.length) r.record({ suite: S, where, check: 'images load', status: 'fail', detail: f.brokenImages.slice(0, 5).join(', ') });
            const unlabelled = await page.$$eval('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea', (els) => els.filter((el) => {
                const e = el as HTMLInputElement;
                if (e.offsetParent === null || el.closest('[aria-hidden=true]')) return false;
                return !(e.labels?.length || e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.title);
            }).map((el) => (el as HTMLInputElement).name || el.id || el.tagName.toLowerCase())).catch(() => [] as string[]);
            r.record({ suite: S, where, check: 'form fields labelled', status: unlabelled.length ? 'fail' : 'pass', detail: unlabelled.slice(0, 6).join(', ') || undefined });

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
        // Reached: every GET on this host that answered 2xx, pages and the requests they made alike.
        const reached = r.crawl.hits.filter((h) => h.method === 'GET' && host(h.url) === own && h.status >= 200 && h.status < 300).map((h) => new URL(h.url).pathname);
        const { total, missed } = coverage(gets, reached);
        writeFileSync(`${r.dir}/missed-routes.json`, JSON.stringify(missed, null, 2));
        r.record({ suite: S, where: 'routes', check: 'route coverage', status: 'info',
            detail: `${total - missed.length}/${total} GET routes reached${missed.length ? `; unreached in ${r.dir}/missed-routes.json` : ''}` });
    }
    r.crawl.done = true;
    writeFileSync(`${r.dir}/crawl.json`, JSON.stringify({ pages: r.crawl.pages, links: Object.fromEntries(linkStatus) }, null, 2));
    writeFileSync(`${r.dir}/network.json`, JSON.stringify(r.crawl.hits, null, 2));
}
