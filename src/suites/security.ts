/*
 * Security evidence (measured, no Jev), over the pages the crawl reached:
 * - response headers on HTML pages: nosniff, framing blocked (X-Frame-Options or CSP frame-ancestors), Referrer-Policy,
 *   a CSP, HSTS when served over https;
 * - session cookies (a side that signs in): HttpOnly (not for a CSRF token cookie), SameSite, Secure over https;
 * - signed out, every crawled page of a side that signs in refuses or sends the visitor to sign in. With the side's
 *   `signedIn` selector set (an app that shows its sign-in form in place), its screens and the pages the server sends
 *   to everyone are opened signed out and must not show that selector; and up to 20 of the app's GET calls the crawl
 *   saw are sent again signed out, those that still answer with JSON listed as an info finding;
 * - CSRF (when security.csrf is set; on the sides that sign in, or every side when none does): the request, without a
 *   token, is refused with the expected status;
 * - secrets: no API keys, private keys or tokens in the served HTML or in the app's own scripts as served;
 * - links that open a new tab carry rel=noopener (or noreferrer), in the first 20 pages as the browser renders them;
 * - no requests to third-party hosts outside security.allowedHosts, listed with the page that made them.
 */
import { request as pwRequest } from 'playwright';
import { abs, context, host, load, open, SessionExpired, settle, site, type Run } from '../browser.ts';
import { run as runCrawl } from './crawl.ts';

export const SECRETS: [string, RegExp][] = [
    ['Anthropic key', /sk-ant-[a-z0-9_-]{20,}/i], ['OpenAI-style key', /\bsk-[a-zA-Z0-9]{32,}/], ['Stripe live key', /\b[rs]k_live_[0-9a-zA-Z]{16,}/],
    ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/], ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/], ['Slack token', /\bxox[abpr]-[0-9a-zA-Z-]{10,}/],
    ['GitHub token', /\bgh[pousr]_[0-9a-zA-Z]{30,}/], ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
];
export const leaksIn = (text: string) => SECRETS.filter(([, re]) => re.test(text)).map(([name]) => name);

export async function run(r: Run) {
    const S = 'security';
    if (!r.crawl.done) await runCrawl(r);
    const base = r.side.baseUrl;
    const https = base.startsWith('https://');
    const signsIn = !('none' in r.side.login);
    const headers = ['X-Content-Type-Options: nosniff', 'framing blocked', 'Referrer-Policy', 'Content-Security-Policy', ...(https ? ['Strict-Transport-Security'] : [])];
    const pages = r.crawl.pages.filter((p) => p.status < 400 && !r.cfg.crawl.skip.test(p.path)).slice(0, 40);
    const ctx = await context(r, r.cfg.viewports[0]);
    const api = ctx.request;

    try {
        // Headers and bodies, as the side sees them.
        const missing: Record<string, string[]> = {};
        const leaks: string[] = [];
        const blank: string[] = [];
        let html = 0, tabs = 0;
        const page = await ctx.newPage();
        for (const p of pages) {
            const res = await api.get(abs(r, p.path), { failOnStatusCode: false, maxRedirects: 0 }).catch(() => null);
            if (!res || !/text\/html/.test(res.headers()['content-type'] ?? '')) continue;
            html++;
            const h = res.headers();
            const csp = h['content-security-policy'] ?? '';
            const has: Record<string, boolean> = {
                'X-Content-Type-Options: nosniff': /nosniff/i.test(h['x-content-type-options'] ?? ''),
                'framing blocked': /deny|sameorigin/i.test(h['x-frame-options'] ?? '') || /frame-ancestors/i.test(csp),
                'Referrer-Policy': !!h['referrer-policy'],
                'Content-Security-Policy': !!csp,
                'Strict-Transport-Security': !!h['strict-transport-security'],
            };
            for (const name of headers) if (!has[name]) (missing[name] ??= []).push(p.path);
            const body = await res.text();
            for (const name of leaksIn(body)) leaks.push(`${name} in ${p.path}`);
            // New-tab links, in the page as rendered: a client-rendered app's served HTML has no links at all.
            if (html > 20) continue;
            await open(r, page, p.path).catch((e) => { if (e instanceof SessionExpired) throw e; });
            const rels = await page.$$eval('a[target=_blank]', (links) => links.map((a) => /noopener|noreferrer/i.test(a.getAttribute('rel') ?? ''))).catch(() => [] as boolean[]);
            tabs += rels.length;
            if (rels.includes(false)) blank.push(`${p.path} (${rels.filter((ok) => !ok).length})`);
        }
        await page.close();
        for (const name of headers) {
            const on = missing[name] ?? [];
            r.record({ suite: S, where: 'HTML pages', check: `header: ${name}`, status: on.length ? (name === 'Content-Security-Policy' ? 'warn' : 'fail') : 'pass',
                detail: on.length ? `missing on ${on.length}/${html}: ${on.slice(0, 5).join(', ')}` : `${html} pages` });
        }
        r.record({ suite: S, where: 'HTML pages', check: 'new-tab links use rel=noopener', status: blank.length ? 'warn' : 'pass', detail: blank.slice(0, 6).join('; ') || `${tabs} new-tab links on ${Math.min(html, 20)} rendered page(s)` });

        // The app's own scripts, as served (whatever built them).
        const scripts = [...new Set(r.crawl.hits.filter((h) => h.type === 'script' && host(h.url) === host(base) && h.status < 400).map((h) => h.url))].slice(0, 60);
        for (const u of scripts) {
            const js = await api.get(u, { failOnStatusCode: false }).then((x) => x.text()).catch(() => '');
            for (const name of leaksIn(js)) leaks.push(`${name} in ${new URL(u).pathname}`);
        }
        r.record({ suite: S, where: 'served HTML and scripts', check: 'no secrets', status: leaks.length ? 'fail' : 'pass',
            detail: leaks.slice(0, 6).join('; ') || `${html} pages, ${scripts.length} scripts` });

        if (signsIn) {
            // Cookies.
            const session = (await ctx.cookies(base)).filter((c) => /sess|auth|token|sid/i.test(c.name));
            for (const c of session) {
                const bad = cookieProblems(c, https);
                r.record({ suite: S, where: `cookie ${c.name}`, check: 'session cookie flags', status: bad.length ? 'fail' : 'pass',
                    detail: bad.join(', ') || `${c.httpOnly ? 'HttpOnly' : 'readable by script (a CSRF token)'}, SameSite=${c.sameSite}${https ? ', Secure' : ''}` });
            }
            if (!session.length) r.record({ suite: S, where: 'cookies', check: 'session cookie flags', status: 'info', detail: 'no session cookie to check: the saved session has none (it may be kept in local storage)' });

            // Signed out: every page must refuse or send to sign in.
            const anon = await pwRequest.newContext();
            const unrefused: string[] = [], shell: string[] = [];
            for (const p of pages) {
                // Redirects are followed: `/` → `/admin` → `/login` refuses as surely as one hop does.
                const res = await anon.get(abs(r, p.path), { failOnStatusCode: false, maxRedirects: 5 }).catch(() => null);
                if (!res) continue;
                const to = new URL(res.url()).pathname, moved = to !== new URL(abs(r, p.path)).pathname;
                const refused = [401, 403, 404, 419].includes(res.status()) || (moved && r.cfg.loginPaths.test(to));
                if (!refused) { unrefused.push(`${res.status()} ${p.path}${moved ? ` → ${to}` : ''}`); shell.push(p.path); }
            }
            const sel = r.side.signedIn;
            if (!sel) r.record({ suite: S, where: 'signed out', check: 'pages need sign-in', status: unrefused.length ? 'fail' : 'pass', detail: unrefused.slice(0, 8).join('; ') || `${pages.length} pages refused` });
            else {
                // An app that signs in in place sends its shell to everyone, so the answer above tells nothing: the side's
                // screens, and the pages that were sent, are opened without the session and must not show what only a signed-in page has.
                const out = await context(r, r.cfg.viewports[0], false);
                const tab = await out.newPage(), paths = [...new Set([...r.side.screens.flatMap((x) => x.path ?? []), ...shell])].slice(0, 20), shown: string[] = [];
                for (const path of paths) {
                    await load(tab, abs(r, path)).catch(() => null);
                    await settle(tab);
                    if (await tab.locator(sel).count().catch(() => 0)) shown.push(path);
                }
                await out.close();
                r.record({ suite: S, where: 'signed out', check: 'pages need sign-in', status: shown.length ? 'fail' : 'pass',
                    detail: shown.length ? `shows ${sel} signed out: ${shown.slice(0, 8).join(', ')}` : `${paths.length} page(s) opened signed out, none shows ${sel}; ${pages.length - unrefused.length} of ${pages.length} refused by the server` });
            }

            // The app's own GET calls, sent again without the session. Data for everyone may be meant, so it is a note.
            const calls = [...new Set(r.crawl.hits.filter((h) => h.method === 'GET' && /^(xhr|fetch)$/.test(h.type) && h.status === 200 && site(h.url) === site(base)).map((h) => h.url))].slice(0, 20);
            const answered: string[] = [];
            for (const u of calls) {
                const res = await anon.get(u, { failOnStatusCode: false }).catch(() => null);
                if (res?.status() === 200 && /json/.test(res.headers()['content-type'] ?? '') && (await res.text().catch(() => '')).trim()) answered.push(new URL(u).pathname);
            }
            if (calls.length) r.record({ suite: S, where: 'signed out', check: 'API data needs sign-in', status: answered.length ? 'info' : 'pass',
                detail: answered.length ? `${answered.length} of ${calls.length} GET call(s) answer with JSON signed out (fine when meant for everyone): ${[...new Set(answered)].slice(0, 8).join(', ')}` : `${calls.length} GET call(s) sent again, none answered with JSON` });
            await anon.dispose();
        }

        // CSRF: the configured request, signed in, without a token.
        // Sent on the sides that sign in, or on every side when none does (a public app's own forms).
        const c = r.side.csrf ?? r.cfg.security.csrf;
        if (c && (signsIn || r.cfg.sides.every((s) => 'none' in s.login))) {
            const res = await api.fetch(abs(r, c.path), { method: c.method, headers: { Accept: 'application/json' }, data: {}, failOnStatusCode: false });
            r.record({ suite: S, where: `${c.method} ${c.path} without a CSRF token`, check: `refused with ${c.expect}`, status: res.status() === c.expect ? 'pass' : 'fail', detail: `answered ${res.status()}` });
        }

        // Third-party requests.
        const third = new Map<string, Set<string>>();
        for (const h of r.crawl.hits) {
            const hh = host(h.url);
            if (!hh || site(h.url) === site(base) || r.cfg.security.allowedHosts.includes(hh)) continue; // the app's own subdomains aren't a third party
            if (!third.has(hh)) third.set(hh, new Set());
            third.get(hh)!.add(h.page);
        }
        r.record({ suite: S, where: 'all crawled pages', check: 'no third-party requests', status: third.size ? 'fail' : 'pass',
            detail: [...third].map(([hh, ps]) => `${hh} (from ${[...ps].slice(0, 3).join(', ')})`).join('; ') || undefined });
        if (!https) r.record({ suite: S, where: base, check: 'https-only checks', status: 'info', detail: 'HSTS and Secure cookies are checked only over https' });
    } finally {
        await ctx.close();
    }
}

/** What is wrong with a session-like cookie's flags. A CSRF token cookie (XSRF-TOKEN, csrftoken) is meant to be read
 * by the page's script, so it may lack HttpOnly; SameSite and Secure still apply. */
export const cookieProblems = (c: { name: string; httpOnly: boolean; sameSite: string; secure: boolean }, https: boolean): string[] =>
    [!c.httpOnly && !/xsrf|csrf/i.test(c.name) && 'not HttpOnly', !['Lax', 'Strict'].includes(c.sameSite) && `SameSite=${c.sameSite}`,
        https && !c.secure && 'not Secure'].filter((x): x is string => !!x);
