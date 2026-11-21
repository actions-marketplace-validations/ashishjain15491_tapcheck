/*
 * The browser side every suite shares: one Chromium, a context per viewport (signed in with the side's saved session, or
 * not), page settling, the facts code can measure on a page, and the Run each suite is handed.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Config, Screen, Side } from './config.ts';
import type { Finding } from './report.ts';

export type Viewport = Config['viewports'][number];
export type Hit = { url: string; method: string; type: string; status: number; contentType: string; ms: number; bytes: number; page: string; json?: 'ok' | 'invalid'; body?: string };
export type Visited = { path: string; status: number; finalPath: string; ms: number; errors: string[]; links: string[] };
/** One side's run: its config, where its evidence goes, its saved session, and what its crawl found (contract and security read it). */
export type Run = {
    cfg: Config; side: Side; dir: string; auth?: string;
    record: (f: Omit<Finding, 'side'>) => void;
    crawl: { pages: Visited[]; hits: Hit[]; done: boolean };
};

let browser: Browser | null = null;
export async function launch(headless = true) {
    browser ??= await chromium.launch({ headless });
    return browser;
}
export const closeBrowser = async () => { await browser?.close(); browser = null; };

/** A screen's address: a path on the side's base URL, or a full URL as given. */
export const abs = (r: Run, path: string) => (/^https?:\/\//.test(path) ? path : r.side.baseUrl + path);
export const host = (u: string) => { try { return new URL(u).host; } catch { return ''; } };
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48) || 'unlabelled';

/** A context at this viewport: signed in with the side's session unless auth is false. */
export async function context(r: Run, vp: Viewport, auth = true, bypassCSP = false): Promise<BrowserContext> {
    return (await launch()).newContext({ ...(auth && r.auth ? { storageState: r.auth } : {}), viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1, isMobile: vp.mobile, hasTouch: vp.mobile, bypassCSP });
}

/** Console errors and uncaught page errors, collected from now on. */
export function watch(page: Page) {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    return errors;
}

/** Network idle, then the DOM quiet for 500 ms (at most 5 s more), so late-rendering widgets are judged as people see them. */
export async function settle(page: Page) {
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await page.evaluate(() => new Promise<void>((done) => {
        let timer = setTimeout(finish, 500);
        const cap = setTimeout(finish, 5000);
        const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(finish, 500); });
        obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        function finish() { obs.disconnect(); clearTimeout(timer); clearTimeout(cap); done(); }
    })).catch(() => {});
}

export class SessionExpired extends Error {}
/** Being sent to a sign-in page on a side that signs in means the session is gone: stop rather than audit the login page. */
export function guard(r: Run, requested: string, landed: string) {
    if ('none' in r.side.login) return;
    if (r.cfg.loginPaths.test(new URL(landed).pathname) && !r.cfg.loginPaths.test(requested.split('?')[0])) {
        throw new SessionExpired(`Sent to sign in at ${landed}: the ${r.side.name} session has expired (run again with LOGIN=1).`);
    }
}

export async function open(r: Run, page: Page, path: string) {
    const res = await page.goto(abs(r, path), { waitUntil: 'domcontentloaded' });
    await settle(page);
    guard(r, path, page.url());
    return res;
}

/** A screen's path: given directly, or the first link on `from` whose path matches `link`. Null when no link matches. */
export async function resolve(r: Run, page: Page, s: Screen): Promise<string | null> {
    if (s.path) return s.path;
    await open(r, page, s.from!);
    const re = new RegExp(s.link!, 'i');
    const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => (a as HTMLAnchorElement).pathname));
    const hit = hrefs.find((h) => re.test(h));
    return hit ? hit + (s.suffix ?? '') : null;
}

export type Control = { tag: string; role: string; label: string; x: number; y: number; w: number; h: number; href?: string };

/** What code measures exactly: sideways scroll, broken images, off-screen and small controls, text coverage, headings. */
export async function facts(page: Page) {
    return page.evaluate(() => {
        const vw = innerWidth, vh = innerHeight;
        const visible = (el: Element) => {
            const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0 && !el.closest('[aria-hidden=true]');
        };
        const broken = [...document.images].filter((i) => visible(i) && i.complete && i.naturalWidth === 0).map((i) => i.currentSrc || i.src);
        const controls = [...document.querySelectorAll('a[href], button, [role=button], input:not([type=hidden]), select, textarea, summary')]
            .filter(visible).slice(0, 250).map((el) => {
                const r = el.getBoundingClientRect();
                const label = ((el as HTMLElement).innerText || el.getAttribute('aria-label') || el.getAttribute('title') || (el as HTMLInputElement).placeholder || '')
                    .replace(/\s+/g, ' ').trim().slice(0, 60);
                return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', label, x: Math.round(r.left), y: Math.round(r.top + scrollY),
                    w: Math.round(r.width), h: Math.round(r.height), href: (el as HTMLAnchorElement).href || undefined };
            });
        // Text coverage of the first screen: the share of the viewport covered by text runs (negative space is what's left).
        let ink = 0;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.textContent?.trim() || !n.parentElement || !visible(n.parentElement)) continue;
            range.selectNodeContents(n);
            for (const r of range.getClientRects()) {
                ink += Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
            }
        }
        // WCAG 2.2 target size (2.5.8): controls in the first screen smaller than 24 × 24 px, inline text links aside.
        const small = controls.filter((c) => c.y < vh && (c.w < 24 || c.h < 24) && c.tag !== 'a').map((c) => `${c.tag} "${c.label}" ${c.w}×${c.h}`);
        return {
            title: document.title, lang: document.documentElement.lang, overflowX: document.documentElement.scrollWidth > vw + 1,
            brokenImages: broken, offscreen: controls.filter((c) => c.x < -1 || c.x + c.w > vw + 1).length, controls,
            height: document.documentElement.scrollHeight, textCoverage: Math.round((ink / (vw * vh)) * 1000) / 1000, smallTargets: small,
            h1: document.querySelectorAll('h1').length,
        };
    });
}
