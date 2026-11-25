/*
 * The browser side every suite shares: one Chromium, a context per viewport (signed in with the side's saved session, or
 * not), page settling, the facts code can measure on a page, screenshot slices, and the Run each suite is handed.
 */
import { mkdirSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright';
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
    part?: string; // the part running now, and inside a flow its step: what a recording and a reached route are filed under
    step?: string;
    reached?: Reach[]; // what the run touched, for hits.json and the coverage map (src/coverage.ts)
    prefix?: string; // printed before each of a flow's step lines when flows run in parallel: "[flow-checkout] "
};
/** One thing a part touched: "GET /orders", "dialog <name>", "table <headers>: sort". */
export type Reach = { part: string; step?: string; what: string };
export type Recording = { side: string; part: string; label: string; videos: string[]; trace?: string };
/** Every recording of the run (RECORD=1), for the report. */
export const recordings: Recording[] = [];

const seconds = (name: string, env: NodeJS.ProcessEnv) => {
    const n = Number(env[name] ?? 0);
    if (!(n >= 0)) throw new Error(`${name} must be a number, 0 or more (got "${env[name]}").`);
    return n;
};
/** How the run's browser starts: HEADED=1 shows it, SLOWMO=<ms> waits that long between its actions; `args` are the config's browser.args. */
export const launchOptions = (env = process.env, args: string[] = []) => ({ headless: env.HEADED !== '1', slowMo: seconds('SLOWMO', env), ...(args.length ? { args } : {}) });
/** START_DELAY=<s>: seconds to count down before the first action (time to start a screen recording). */
export const startDelay = (env = process.env) => seconds('START_DELAY', env);

let browser: Browser | null = null;
const live = new Set<BrowserContext>(); // recorded contexts not closed yet
/** The run's one Chromium; `args` (browser.args) count on the call that starts it. */
export async function launch(args: string[] = []) {
    browser ??= await chromium.launch(launchOptions(process.env, args));
    return browser;
}
/** Closes the browser. A recorded context a suite left open is closed first, so its video and trace are still written. */
export const closeBrowser = async () => {
    for (const ctx of [...live]) await ctx.close().catch(() => {});
    await browser?.close();
    browser = null;
};

/** Counts down START_DELAY seconds, in the terminal and (headed) in the browser window. */
export async function countdown(s = startDelay()) {
    if (!s) return;
    const ctx = launchOptions().headless ? null : await (await launch()).newContext();
    const page = await ctx?.newPage();
    for (let left = Math.ceil(s); left > 0; left--) {
        process.stdout.write(`\rStarting in ${left} s… `);
        await page?.setContent(`<body style="font:48px system-ui;display:grid;place-items:center;height:90vh">tapcheck starts in ${left}…</body>`).catch(() => {});
        await new Promise((done) => setTimeout(done, 1000));
    }
    process.stdout.write('\n');
    await ctx?.close();
}

/** Files `what` under the part (and flow step) running now, once. */
export function reach(r: Run, what: string, step = r.step) {
    const list = (r.reached ??= []), part = r.part ?? '';
    if (!list.some((x) => x.part === part && x.step === step && x.what === what)) list.push({ part, ...(step ? { step } : {}), what });
}
const ASSET = ['image', 'font', 'stylesheet', 'script', 'media', 'manifest'];
/** Answers that mean the app refused the request or has no such route: not reached. */
export const REFUSED = [401, 403, 404, 405];

/** The method the app routes a request by: a form POST that says `_method` (Laravel, Rails, Symfony) or an override header is that method. */
export function routedMethod(q: { method(): string; url(): string; headers(): Record<string, string>; postData(): string | null }): string {
    if (q.method() !== 'POST') return q.method();
    let body = '';
    try { body = q.postData() ?? ''; } catch { /* a body that isn't text */ }
    const said = q.headers()['x-http-method-override'] ?? new URL(q.url()).searchParams.get('_method')
        ?? body.match(/(?:^|&)_method=([A-Za-z]+)(?:&|$)|name="_method"\r?\n\r?\n([A-Za-z]+)|"_method"\s*:\s*"([A-Za-z]+)"/)?.slice(1).find(Boolean);
    return said && /^(PUT|PATCH|DELETE)$/i.test(said) ? said.toUpperCase() : 'POST';
}

/** A screen's address: a path on the side's base URL, or a full URL as given. */
export const abs = (r: Run, path: string) => (/^https?:\/\//.test(path) ? path : r.side.baseUrl + path);
export const host = (u: string) => { try { return new URL(u).host; } catch { return ''; } };
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48) || 'unlabelled';

/**
 * A context at this viewport: signed in with the side's session unless auth is false. Every suite and flow gets its
 * contexts here, so two things hold for all of them: each answered request to the side's own host is filed for the
 * coverage map, and with RECORD=1 the context records a video per page (<side dir>/videos/) and a Playwright trace
 * (<side dir>/traces/), written when the context closes.
 */
export async function context(r: Run, vp: Viewport, auth = true, bypassCSP = false, more: BrowserContextOptions = {}): Promise<BrowserContext> {
    const record = process.env.RECORD === '1';
    const ctx = await (await launch()).newContext({ ...(auth && r.auth ? { storageState: r.auth } : {}), viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1, isMobile: vp.mobile, hasTouch: vp.mobile, bypassCSP, ...(record ? { recordVideo: { dir: `${r.dir}/videos` } } : {}), ...more });
    const own = host(r.side.baseUrl);
    // Reached: a request to the app itself that it didn't refuse (401, 403, 405) or not find (404). Page assets aside.
    ctx.on('response', (res) => {
        const q = res.request();
        if (host(q.url()) === own && !ASSET.includes(q.resourceType()) && !REFUSED.includes(res.status())) reach(r, `${routedMethod(q)} ${new URL(q.url()).pathname}`);
    });
    if (!record) return ctx;

    const label = `${r.part ?? 'run'}-${vp.name}${auth ? '' : '-signed-out'}`;
    const name = `${String(recordings.length + 1).padStart(3, '0')}-${slug(label).replace(/_/g, '-')}`;
    const rec: Recording = { side: r.side.name, part: r.part ?? '', label, videos: [], trace: `${r.dir}/traces/${name}.zip` };
    recordings.push(rec); // now, so the number in the name is taken
    const pages: Page[] = [];
    ctx.on('page', (p) => pages.push(p));
    await ctx.tracing.start({ screenshots: true, snapshots: true, title: label });
    live.add(ctx);
    const close = ctx.close.bind(ctx);
    ctx.close = async (...a) => {
        if (!live.delete(ctx)) return close(...a);
        await ctx.tracing.stop({ path: rec.trace }).catch(() => { rec.trace = undefined; });
        await close(...a); // the videos are complete once the context is closed
        for (const [i, p] of pages.entries()) {
            const file = `${r.dir}/videos/${name}${i ? `-${i + 1}` : ''}.webm`;
            if (await p.video()?.saveAs(file).then(() => true, () => false)) rec.videos.push(file);
            await p.video()?.delete().catch(() => {}); // the copy under Playwright's own random name
        }
    };
    return ctx;
}

/** Console errors and uncaught page errors, collected from now on. */
export function watch(page: Page) {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // Not the page's own: a trace (RECORD=1) puts a script in every frame, and a sandboxed frame refuses it out loud.
    page.on('console', (m) => m.type() === 'error' && !/Blocked script execution in .* sandboxed/.test(m.text()) && errors.push(m.text()));
    return errors;
}

/**
 * Network idle, then the DOM quiet for 500 ms (at most 5 s more), so late-rendering widgets are judged as people see them.
 * page.evaluate has no timeout, and a page's own timers never fire when its CSP sandboxes it without allow-scripts (an
 * email preview, say) or its main thread never yields, so the 6 s cap is kept here, outside the page.
 */
export async function settle(page: Page) {
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    let cap: NodeJS.Timeout | undefined;
    const outside = new Promise<void>((done) => { cap = setTimeout(done, 6000); });
    const quiet = page.evaluate(() => new Promise<void>((done) => {
        let timer = setTimeout(finish, 500);
        const cap = setTimeout(finish, 5000);
        const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(finish, 500); });
        obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        function finish() { obs.disconnect(); clearTimeout(timer); clearTimeout(cap); done(); }
    })).catch(() => {});
    await Promise.race([quiet, outside]);
    clearTimeout(cap);
}

export class SessionExpired extends Error {}
/** Being sent to a sign-in page on a side that signs in means the session is gone: stop rather than audit the login page. */
export function guard(r: Run, requested: string, landed: string) {
    if ('none' in r.side.login) return;
    if (r.cfg.loginPaths.test(new URL(landed).pathname) && !r.cfg.loginPaths.test(requested.split('?')[0])) {
        // LOGIN=1 only does something on a manual side; form and command sides sign in afresh on every run.
        const hint = 'manual' in r.side.login ? 'run again with LOGIN=1' : 'it ended during the run, or this user may not open that page';
        throw new SessionExpired(`Sent to sign in at ${landed}: the ${r.side.name} session has expired (${hint}).`);
    }
}

/** Opens a page of the app and waits for it to settle. A load that fails (a timeout on a busy app, a navigation
 * aborted or cut short by another) is tried once more before the error counts; a download is not a page and isn't. */
export async function open(r: Run, page: Page, path: string) {
    const go = () => page.goto(abs(r, path), { waitUntil: 'domcontentloaded' });
    const res = await go().catch(async (e: Error) => {
        if (/Download is starting/.test(e.message)) throw e;
        await page.waitForTimeout(1000);
        return go();
    });
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

/** The screen as up to `max` viewport-sized slices, top to bottom, saved as <run dir>/shots/<key>-<n>.png (Jev takes images 280–1568 px a side). */
export async function slices(r: Run, page: Page, key: string, height: number, vh: number, max = 3) {
    mkdirSync(`${r.dir}/shots`, { recursive: true });
    const n = Math.min(max, Math.max(1, Math.ceil(height / vh)));
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
        await page.evaluate((y) => scrollTo(0, y), i * vh);
        await page.waitForTimeout(250);
        const file = `${r.dir}/shots/${key}-${i + 1}.png`;
        await page.screenshot({ path: file });
        out.push(file);
    }
    await page.evaluate(() => scrollTo(0, 0));
    return out;
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
