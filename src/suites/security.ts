/*
 * Security evidence (measured, no Jev), over the pages the crawl reached:
 * - response headers on HTML pages: nosniff, framing blocked (X-Frame-Options or CSP frame-ancestors), Referrer-Policy,
 *   a CSP, HSTS when served over https;
 * - session cookies (a side that signs in): HttpOnly (not for a CSRF token cookie), SameSite, Secure over https;
 * - signed out, every crawled page of a side that signs in refuses or sends the visitor to sign in;
 * - CSRF (when security.csrf is set; on the sides that sign in, or every side when none does): the request, without a
 *   token, is refused with the expected status;
 * - secrets: no API keys, private keys or tokens in the served HTML or in the app's own scripts as served;
 * - links that open a new tab carry rel=noopener (or noreferrer);
 * - no requests to third-party hosts outside security.allowedHosts, listed with the page that made them.
 */
import { request as pwRequest } from 'playwright';
import { abs, context, host, site, type Run } from '../browser.ts';
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
        let html = 0;
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
            const opens = [...body.matchAll(/<a\b[^>]*target=["']?_blank[^>]*>/gi)].map((m) => m[0]).filter((a) => !/rel=["'][^"']*(noopener|noreferrer)/i.test(a));
            if (opens.length) blank.push(`${p.path} (${opens.length})`);
        }
        for (const name of headers) {
            const on = missing[name] ?? [];
            r.record({ suite: S, where: 'HTML pages', check: `header: ${name}`, status: on.length ? (name === 'Content-Security-Policy' ? 'warn' : 'fail') : 'pass',
                detail: on.length ? `missing on ${on.length}/${html}: ${on.slice(0, 5).join(', ')}` : `${html} pages` });
        }
        r.record({ suite: S, where: 'HTML pages', check: 'new-tab links use rel=noopener', status: blank.length ? 'warn' : 'pass', detail: blank.slice(0, 6).join('; ') || undefined });

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
            if (!session.length) r.record({ suite: S, where: 'cookies', check: 'session cookie flags', status: 'warn', detail: 'no session-like cookie in the saved session' });

            // Signed out: every page must refuse or send to sign in.
            const anon = await pwRequest.newContext();
            const open: string[] = [];
            for (const p of pages) {
                // Redirects are followed: `/` → `/admin` → `/login` refuses as surely as one hop does.
                const res = await anon.get(abs(r, p.path), { failOnStatusCode: false, maxRedirects: 5 }).catch(() => null);
                if (!res) continue;
                const to = new URL(res.url()).pathname, moved = to !== new URL(abs(r, p.path)).pathname;
                const refused = [401, 403, 404, 419].includes(res.status()) || (moved && r.cfg.loginPaths.test(to));
                if (!refused) open.push(`${res.status()} ${p.path}${moved ? ` → ${to}` : ''}`);
            }
            await anon.dispose();
            r.record({ suite: S, where: 'signed out', check: 'pages need sign-in', status: open.length ? 'fail' : 'pass', detail: open.slice(0, 8).join('; ') || `${pages.length} pages refused` });
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
