/*
 * Custom flows: the journeys only this app has (sign up, check out, invite a colleague), written by the project as
 * TS/JS files that tapcheck.yml names with `flows:`. Each file's default export is a Flow; it runs as its own part,
 * flow-<name>, on one side:
 *
 *   import type { Flow } from 'tapcheck';
 *   export default {
 *       name: 'Contact',
 *       run: async (t) => {
 *           const page = await t.goto('/contact');
 *           await t.step('the form has a message field', async () => { t.expect(await page.getByLabel('Message').count(), 'no field labelled Message'); });
 *       },
 *   } satisfies Flow;
 *
 * Each step is one finding: pass, or fail with what was thrown, a screenshot and the page's console errors (a step that
 * returns `{ warn: '…' }` is a warning instead); the flow carries on after a failed step. A flow that takes longer than
 * its `timeout` (seconds, default 3600) fails: nothing it does after that is recorded, t.signal is aborted, and what it
 * gave t.cleanup(fn) runs (as it does when the flow ends). t.note(name, detail, 'warn' | 'info' | 'fail') records a
 * finding without a step. Unlike the suites, a flow may click anything and change data: run it against a copy
 * you can reset. t.jev() and t.mail.judge() ask Jev to look at the current page or at an email; with JEV=off or no key
 * they record that they were skipped and return null, so a flow that calls them still runs everywhere.
 */
import { globSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserContext, Page } from 'playwright';
import { AsyncLocalStorage } from 'node:async_hooks';
import { abs, context, guard, host, reach, REFUSED, settle, slices, slug, watch, type Run } from './browser.ts';
import { isLocal, type Config } from './config.ts';
import * as jev from './jev.ts';
import { EMAIL, VISUAL, YES_IS_DEFECT } from './questions.ts';
import type { Finding } from './report.ts';
import type { FailRule, Reply, Seen } from './stub.ts';

/** For a flow's own questions to t.jev(), t.ask() and t.mail.judge(), and tapcheck's own sets to start from. */
export { choice, noul, score } from '@typesafe-ai/sdk';
export { EMAIL, VISUAL } from './questions.ts';
/** timeout: seconds the whole flow may take (default 3600); past it the flow fails and the run goes on. */
export type Flow = { name: string; side?: string; timeout?: number; run: (t: T) => Promise<void> };
/** A flow as loaded: its side settled and its part name. */
export type Loaded = Required<Flow> & { part: string };
/** One message in Mailpit. headers: every header by name, as Mailpit spells it ("List-Unsubscribe"), each with its values. */
export type Mail = { id: string; subject: string; from: string; to: string[]; html: string; text: string; links: string[]; headers: Record<string, string[]> };

// Set while a cleanup runs, so its t.* calls work past the timeout while the abandoned run()'s, in another async context,
// don't. One token per cleanup, switched off when its 60 s are up, so a cleanup that hangs past them loses it too.
const inCleanup = new AsyncLocalStorage<{ on: boolean }>();

/** What a flow's run() is handed. */

export class T {
    private r: Run;
    private flow: Loaded;
    private stubUrl?: string;
    private pages = new Map<string, Page>(); // "<viewport> <signed in>" → page
    private fresh: BrowserContext[] = []; // contexts of t.page({ fresh: true }), closed with the flow
    private signedOut = new WeakSet<BrowserContext>();
    private errors = new WeakMap<Page, string[]>();
    private current?: Page; // the page last handed out: goto() drives it, a failed step shows it
    private cleanups: (() => unknown)[] = [];
    private shots = 0;
    private dead = false; // past the flow's timeout: what it still records is dropped
    private abort = new AbortController();
    /** Aborted when the flow runs out of time: pass it to long waits of your own, or check `t.signal.aborted` in a loop. */
    readonly signal = this.abort.signal;

    constructor(r: Run, flow: Loaded, stubUrl?: string) {
        this.r = r;
        this.flow = flow;
        this.stubUrl = stubUrl;
    }

    /** The run's folder, for files of the flow's own (a payload log, a list it made). */
    get dir(): string { return this.r.dir; }

    private record(f: Omit<Finding, 'side'>) { if (this.live()) this.r.record(f); }
    private live() { return !this.dead || inCleanup.getStore()?.on === true; }

    /** Stops the flow at its timeout: later findings are dropped and `t.signal` is aborted. */
    kill(why: string) { this.dead = true; this.abort.abort(new Error(why)); }

    /** Past the timeout every t.* call but a cleanup's throws, so the abandoned run() stops at its next one. */
    private alive() { if (!this.live()) throw this.signal.reason; }

    /** Runs `fn` when the flow ends, also when it fails or runs out of time (each one gets 60 s): put back what it changed. */
    cleanup(fn: () => unknown): void { this.alive(); this.cleanups.push(fn); }

    /**
     * Runs the cleanups, last added first; one that throws or hangs is a warning. Past the timeout the flow's pages are
     * closed first, so the abandoned run() can't drive one while a cleanup works: a cleanup's t.page() opens new ones.
     * Only what a cleanup awaits itself carries its t.* rights: a Playwright handler it adds (page.on) runs outside them
     * unless wrapped with AsyncResource.bind (node:async_hooks).
     */
    async finish() {
        if (this.dead) { await this.close(); this.pages.clear(); this.fresh = []; this.current = undefined; }
        for (let fn; (fn = this.cleanups.pop()); ) {
            let timer: NodeJS.Timeout | undefined;
            const token = { on: true };
            const cap = new Promise((_, no) => { timer = setTimeout(() => no(new Error('it took over 60 s')), 60_000); });
            try { await Promise.race([inCleanup.run(token, () => Promise.resolve().then(fn)), cap]); } catch (e) {
                this.r.record({ suite: this.flow.part, where: this.flow.name, check: 'cleanup ran', status: 'warn', detail: String((e as Error).message ?? e).slice(0, 300) });
            } finally { token.on = false; clearTimeout(timer); }
        }
        this.dead = true; // the flow is over: an abandoned run() that wakes up later records nothing
    }

    /**
     * A page on the flow's side, signed in with the side's session (`{ auth: false }`: signed out), at the first viewport
     * or the one `viewport` names (`{ viewport: 'mobile' }`, a name from the config's viewports). One of each is kept, and
     * the page handed out last is the current one: t.goto() and t.jev() act on it. `{ fresh: true }` gives a new page in
     * a context of its own every time (cookies and storage its own too), for a second visitor or a sign-in of the flow's own;
     * it is the current page too, until t.page() or t.use() hands out another.
     */
    async page(opts: { auth?: boolean; viewport?: string; fresh?: boolean } = {}): Promise<Page> {
        this.alive();
        const auth = opts.auth !== false, all = this.r.cfg.viewports;
        const vp = opts.viewport === undefined ? all[0] : all.find((v) => v.name === opts.viewport);
        if (!vp) throw new Error(`t.page: no viewport is called "${opts.viewport}" (viewports: ${all.map((v) => v.name).join(', ')}).`);
        const open = async () => {
            const ctx = await context(this.r, vp, auth);
            const page = await ctx.newPage().catch(async (e) => { await ctx.close().catch(() => {}); throw e; });
            if (!this.live()) { await ctx.close().catch(() => {}); this.alive(); } // timed out while it opened: not into the cleanups' cache
            this.errors.set(page, watch(page));
            if (!auth) this.signedOut.add(ctx);
            return { ctx, page };
        };
        if (opts.fresh) { const { ctx, page } = await open(); this.fresh.push(ctx); return (this.current = page); }
        const key = `${vp.name} ${auth}`;
        if (!this.pages.has(key)) this.pages.set(key, (await open()).page);
        return (this.current = this.pages.get(key)!);
    }

    /**
     * Makes `page` the current one: t.goto(), t.jev() and a failed step's screenshot act on it. For a page t.page() handed
     * out earlier (back to the first visitor after a second one), or a tab the app opened itself (`context.waitForEvent('page')`).
     */
    use(page: Page): Page {
        this.alive();
        if (!this.errors.has(page)) this.errors.set(page, watch(page));
        return (this.current = page);
    }

    /**
     * Opens a path of the side (or a full URL) on the current page and waits for it to settle. On a signed-in page, being
     * sent to sign in (`loginPaths`) when the path isn't a sign-in page throws: the side's session has ended. A flow that
     * expects to be sent there (after signing out, or to check a page is refused) passes `{ guard: false }`.
     */
    async goto(path: string, opts: { guard?: boolean } = {}): Promise<Page> {
        this.alive();
        const page = this.current ?? await this.page();
        const url = abs(this.r, path);
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await settle(page);
        if (opts.guard !== false && !this.signedOut.has(page.context())) guard(this.r, new URL(url).pathname, page.url());
        return page;
    }

    /**
     * Counts a request to the app the flow made itself (page.request, fetch) as reached, for hits.json and COVERAGE=1.
     * Pass its answer's status, and one the app refused (401, 403, 405) or didn't find (404) isn't counted, as in the browser.
     */
    reach(method: string, url: string, status?: number): void {
        this.alive();
        const u = new URL(abs(this.r, url));
        if (status !== undefined && REFUSED.includes(status)) return;
        if (host(u.href) === host(this.r.side.baseUrl)) reach(this.r, `${method.toUpperCase()} ${u.pathname}`); // another host isn't the app's
    }

    /** Throws `msg` unless `cond` holds. (Not an `asserts` signature: TypeScript refuses those on the untyped `t` of `run: async (t) => …`.) */
    expect(cond: unknown, msg: string): void {
        if (!cond) throw new Error(msg);
    }

    /**
     * One finding: passes when `fn` returns (a string it returns is the detail), fails when it throws; returning
     * `{ warn }` makes it a warning with that detail (it worked, with something to look at). Returns whether it didn't fail.
     */
    async step(name: string, fn: () => Promise<void | string | { warn: string }>): Promise<boolean> {
        this.alive();
        const errors = this.current && this.errors.get(this.current);
        if (errors) errors.length = 0;
        const base = { suite: this.flow.part, where: this.flow.name, check: name };
        const t0 = Date.now();
        const done = (mark: string) => { if (this.live()) process.stdout.write(`    ${mark} ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)\n`); }; // progress, one line a step
        this.r.step = name; // what the step reaches is filed under it (hits.json)
        try {
            const out = await fn();
            if (out && typeof out === 'object') { this.record({ ...base, status: 'warn', detail: out.warn }); done('!'); }
            else { this.record({ ...base, status: 'pass', detail: out || undefined }); done('✓'); }
            return true;
        } catch (e) {
            const page = this.current, seen = (page && this.errors.get(page)) ?? [];
            let shot: string | undefined = `${this.r.dir}/shots/${this.flow.part}-${String(++this.shots).padStart(3, '0')}-${slug(name)}.png`;
            mkdirSync(`${this.r.dir}/shots`, { recursive: true });
            if (!page || page.isClosed() || !(await page.screenshot({ path: shot }).then(() => true, () => false))) shot = undefined;
            this.record({ ...base, status: 'fail', evidence: shot ? [shot] : undefined,
                detail: [String((e as Error).message ?? e).split('\n').slice(0, 6).join(' ⏎ ').slice(0, 800), seen.length ? `console: ${seen.slice(0, 3).join(' | ').slice(0, 300)}` : ''].filter(Boolean).join(' · ') });
            done('✗');
            return false;
        } finally {
            this.r.step = undefined;
        }
    }

    /** A finding the flow decides itself: a warning (default), a failure, or info such as a check it skipped and why. */
    note(name: string, detail: string, status: 'warn' | 'info' | 'fail' = 'warn'): void {
        this.alive();
        this.record({ suite: this.flow.part, where: this.flow.name, check: name, status, detail });
    }

    /** Records that Jev's look at `label` was skipped, and why. */
    private skipped(label: string, why: string): null {
        this.record({ suite: this.flow.part, where: `${this.flow.name} › ${label}`, check: "Jev's look", status: 'info', detail: `skipped (${why})` });
        return null;
    }

    /**
     * Asks Jev about `state`; one finding per answer. Null, and one finding, when its budget is spent (info) or Jev can't
     * be reached (a warning): a look never stops the flow.
     */
    private async look(label: string, state: Record<string, unknown>, questions: Record<string, any>, shots: string[]): Promise<Record<string, any> | null> {
        const rec = (check: string, status: Finding['status'], detail?: string) => this.record({ suite: this.flow.part, where: `${this.flow.name} › ${label}`, check, status, detail, evidence: shots.length ? shots : undefined });
        let a: Record<string, any>;
        try { a = await jev.ask(`${this.flow.part}:${label}`, state, questions, shots); } catch (e) {
            if (e instanceof jev.BudgetReached) return this.skipped(label, e.message);
            if (!(e instanceof jev.Unavailable)) throw e; // the flow's own mistake (a missing image file, say)
            rec("Jev's look", 'warn', `Jev couldn't be asked: ${e.message.slice(0, 300)}`);
            return null;
        }
        for (const [k, v] of Object.entries(a)) {
            const name = `jev: ${k.replace(/_/g, ' ')}`;
            if (typeof v?.noul === 'number') rec(name, jev.status((YES_IS_DEFECT.includes(k) ? jev.bad : jev.good)(v.noul)), `p=${v.noul.toFixed(2)}`);
            else if (typeof v?.score === 'number') rec(name, jev.to10(v.score) >= jev.MIN_SCORE ? 'pass' : 'warn', `${jev.to10(v.score)}/10`);
            else rec(name, 'info', JSON.stringify(v?.choice ?? v).slice(0, 200));
        }
        return a;
    }

    /**
     * Jev's look at the current page: screenshots of it (up to three screens, top to bottom) and the visual questions
     * (loaded, no error, overlap, clipping, raw keys, alignment), or your own `questions` about `screenshots` (built with
     * the TypeSafe SDK's noul, score and choice). Each answer is a finding of the flow, and an unsure one a warning. A
     * yes-or-no question of your own passes on yes; a score passes from 7 of 10 and is a warning below; any other answer is
     * recorded as info. The page is looked at once it has settled. The answers are returned for the flow's own checks; null when Jev is off or over its budget.
     */
    async jev(label: string, questions: Record<string, any> = VISUAL): Promise<Record<string, any> | null> {
        this.alive();
        if (jev.whyOff()) return this.skipped(label, jev.whyOff());
        const page = this.current ?? await this.page();
        const vh = page.viewportSize()?.height ?? 800;
        const shoot = async () => {
            await settle(page);
            // With a dialog open only the screen is looked at: the page behind it scrolled into slices would be the same shot again.
            const height = await page.evaluate(() => [...document.querySelectorAll('dialog[open], [role=dialog][aria-modal=true], [role=alertdialog]')].some((d) => {
                if (d.tagName === 'DIALOG' && !d.matches(':modal')) return false; // dialog.show(): a banner, not modal
                const b = d.getBoundingClientRect();
                return d.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && b.width > 0 && b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth;
            }) ? 0 : document.documentElement.scrollHeight);
            return slices(this.r, page, `${this.flow.part}-jev-${slug(label)}`, height || vh, vh);
        };
        // A page that reloads itself while it is looked at (after a save, say) throws the look out: look again once it is back.
        const shots = await shoot().catch((e) => { if (!/context was destroyed|navigat/i.test(String(e))) throw e; return shoot(); });
        return this.look(label, { screen: label, screenshots: shots.map(jev.img),
            note: shots.length > 1 ? 'The screenshots are consecutive slices of one screen, top to bottom.' : undefined }, questions, shots);
    }

    /**
     * Jev's answers to `questions` about `state` you describe yourself (text, data; images built with the SDK's image()
     * whose files are `images`): no screenshot is taken. Findings, budget and null as for t.jev().
     */
    async ask(label: string, state: Record<string, unknown>, questions: Record<string, any>, images: string[] = []): Promise<Record<string, any> | null> {
        this.alive();
        if (jev.whyOff()) return this.skipped(label, jev.whyOff());
        return this.look(label, state, questions, images);
    }

    /** Mailpit and the stub: 30 s at most a call, and none past the flow's timeout (but a cleanup's). */
    private async api(base: string, path: string, method = 'GET', body?: unknown): Promise<any> {
        this.alive();
        const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(inCleanup.getStore()?.on ? [] : [this.signal])]);
        const res = await fetch(base + path, { method, signal, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        if (!res.ok) throw new Error(`${method} ${base}${path} answered ${res.status}`);
        const text = await res.text();
        try { return JSON.parse(text); } catch {
            if (method === 'DELETE') return text; // Mailpit's answers "ok"
            throw new Error(`${method} ${base}${path} answered ${res.status} but not with JSON: ${text.slice(0, 80)}`);
        }
    }
    private need(u: string | undefined, field: string): string {
        if (!u) throw new Error(`This flow uses ${field === 'stub' ? 't.stub' : 't.mail'}, but tapcheck.yml has no ${field}.`);
        return u;
    }

    /** The stub server (src/stub.ts): the outside requests it saw, and how it answers the next ones. */
    get stub() {
        const base = this.need(this.stubUrl, 'stub');
        const call = (path: string, method?: string, body?: unknown) => this.api(base, `/_tapcheck/${path}`, method, body);
        return {
            /** Requests seen, oldest first: by host (or parent domain), a part of the path, and from a time (ms) on. */
            requests: (f: { host?: string; path?: string; since?: number } = {}): Promise<Seen[]> =>
                call(`requests?${new URLSearchParams(Object.entries(f).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`),
            /** Fails the next `times` matching requests (default 1; 0: until clear()). */
            fail: (rule: FailRule): Promise<void> => call('fail', 'POST', rule),
            /** Answers the next matching request with this, once. */
            reply: (rule: Reply): Promise<void> => call('reply', 'POST', rule),
            /** Answers that DNS question with these values from now on (stub.dns); null puts the config's answer back. */
            dns: (name: string, type: string, values: string[] | null): Promise<void> => call('dns', 'POST', { name, type, values }),
            /** Forgets the requests seen, the failures, the queued replies and the DNS answers set here. */
            clear: async () => { for (const p of ['requests', 'fail', 'reply', 'dns']) await call(p, 'DELETE'); },
        };
    }

    /**
     * Sends a browser context's requests for hosts that aren't local through the stub, so nothing in the browser reaches a
     * real outside service. Redirects are followed here hop by hop (a browser doesn't hand them back), so the app sending
     * the browser to an outside page (a provider's sign-in or checkout) lands on the stub too.
     */
    async routeOutside(ctx: BrowserContext): Promise<void> {
        const stub = this.need(this.stubUrl, 'stub');
        await ctx.route((u) => /^https?:$/.test(u.protocol), (route) => (async () => {
            const req = route.request();
            if (isLocal(req.url()) && !req.isNavigationRequest()) return route.fallback();
            const headers = Object.fromEntries(Object.entries(await req.allHeaders()).filter(([k]) => !/^(:|host$|content-length$)/.test(k)));
            let url = req.url(), method = req.method();
            for (let hop = 0; ; hop++) {
                const u = new URL(url), local = isLocal(url);
                const res = await route.fetch({ url: local ? url : stub + u.pathname + u.search, method, headers: local ? headers : { ...headers, 'x-forwarded-host': u.host },
                    maxRedirects: 0, ...(hop && method === 'GET' ? { postData: '' } : {}) });
                const to = res.status() >= 300 && res.status() < 400 ? res.headers().location : undefined;
                const next = to ? new URL(to, url).href : null;
                if (!next || isLocal(next) || hop === 5) return route.fulfill({ response: res });
                if (req.isNavigationRequest()) { // let the browser go there itself, which comes back through this route
                    const kept = Object.fromEntries(Object.entries(res.headers()).filter(([k]) => !/^(location|content-length|content-type)$/.test(k)));
                    return route.fulfill({ status: 200, headers: kept, contentType: 'text/html', body: `<meta http-equiv="refresh" content="0;url=${next.replace(/"/g, '&quot;')}">` });
                }
                [url, method] = [next, [307, 308].includes(res.status()) ? method : 'GET'];
            }
        })().catch(() => route.abort('failed').catch(() => {}))); // never fall through to the real host
    }

    /** The mail the app sent, read from Mailpit (config `mail.mailpit`). */
    get mail() {
        const base = this.need(this.r.cfg.mail.mailpit, 'mail.mailpit');
        const call = (path: string, method?: string) => this.api(base, `/api/v1/${path}`, method);
        type Filter = { to?: string; subject?: string };
        const search = (f: Filter, limit: number) => {
            const query = [f.to ? `to:"${f.to}"` : '', f.subject ? `subject:"${f.subject}"` : ''].filter(Boolean).join(' ');
            return { query, found: call(query ? `search?limit=${limit}&query=${encodeURIComponent(query)}` : `messages?limit=${limit}`) as Promise<{ messages?: { ID: string }[]; messages_count?: number; total?: number }> };
        };
        const read = async (id: string): Promise<Mail> => {
            const m = await call(`message/${id}`);
            const html: string = m.HTML ?? '';
            return { id, subject: m.Subject ?? '', from: m.From?.Address ?? '', to: (m.To ?? []).map((x: any) => x.Address), html, text: m.Text ?? '',
                links: [...new Set([...html.matchAll(/href="([^"]+)"/g)].map((x) => x[1].replace(/&amp;/g, '&')))],
                headers: await call(`message/${id}/headers`).catch(() => ({})) };
        };
        return {
            /** The newest message to that address and/or with that subject (a part of it), waiting up to timeoutMs (default 30 s) for it. */
            waitFor: async (f: Filter & { timeoutMs?: number } = {}): Promise<Mail> => {
                const until = Date.now() + (f.timeoutMs ?? 30_000);
                for (;;) {
                    const { query, found } = search(f, 1);
                    const hit = (await found).messages?.[0];
                    if (hit) return read(hit.ID);
                    if (Date.now() > until) throw new Error(`No email${query ? ` matching ${query}` : ''} arrived in Mailpit within ${(f.timeoutMs ?? 30_000) / 1000} s.`);
                    await new Promise((done) => setTimeout(done, 500));
                }
            },
            /** How many messages are to that address and/or have that subject (a part of either); all of them without a filter. */
            count: async (f: Filter = {}): Promise<number> => { const a = await search(f, 1).found; return a.messages_count ?? a.total ?? 0; },
            /** Every such message, newest first, each read in full: at most `limit` (1 to 500, default 500); `limit: 1` is the newest or none. */
            all: async (f: Filter & { limit?: number } = {}): Promise<Mail[]> => {
                const limit = f.limit ?? 500;
                if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error(`t.mail.all: limit must be a whole number from 1 to 500, not ${limit}.`);
                const out: Mail[] = [];
                for (const m of (await search(f, limit).found).messages ?? []) out.push(await read(m.ID));
                return out;
            },
            /**
             * Jev's look at an email: its HTML drawn in a page (scripts off) at a computer's and at a phone's width, then asked
             * whether it is laid out properly, has no unfilled placeholder, shows its links and buttons, and reads on a phone
             * (or your own `questions` about `screenshot` and `screenshot_mobile`). Findings and null as for t.jev().
             * ponytail: only the first 1500 px of the email are looked at; slice it if long emails matter.
             */
            judge: async (m: Pick<Mail, 'subject' | 'html'>, questions: Record<string, any> = EMAIL): Promise<Record<string, any> | null> => {
                const label = `email "${m.subject}"`;
                const off = jev.whyOff() || (m.html.trim() ? '' : 'the email has no HTML part');
                if (off) return this.skipped(label, off);
                const ctx = await context(this.r, { name: 'email', width: 700, height: 1000, mobile: false }, false, false, { javaScriptEnabled: false });
                try {
                    const page = await ctx.newPage();
                    mkdirSync(`${this.r.dir}/shots`, { recursive: true });
                    const shots: string[] = [];
                    for (const [suffix, width] of [['', 700], ['-mobile', 390]] as const) {
                        await page.setViewportSize({ width, height: 1000 });
                        await page.setContent(m.html, { waitUntil: 'load' });
                        const height = Math.min(1500, Math.max(300, await page.evaluate(() => document.documentElement.scrollHeight)));
                        shots.push(`${this.r.dir}/shots/${this.flow.part}-email-${slug(m.subject)}${suffix}.png`);
                        await page.screenshot({ path: shots.at(-1), fullPage: true, clip: { x: 0, y: 0, width, height } });
                    }
                    return await this.look(label, { email_subject: m.subject, screenshot: jev.img(shots[0]), screenshot_mobile: jev.img(shots[1]) }, questions, shots);
                } finally {
                    await ctx.close().catch(() => {});
                }
            },
            /** Deletes every message in Mailpit. */
            clear: async () => { await call('messages', 'DELETE'); },
        };
    }

    /** Closes the flow's pages. */
    async close() {
        for (const page of this.pages.values()) await page.context().close().catch(() => {});
        for (const ctx of this.fresh) await ctx.close().catch(() => {});
    }
}

/** Imports every file the `flows` globs match (relative to the config file) and checks each default export. */
export async function loadFlows(cfg: Config): Promise<Loaded[]> {
    const out: Loaded[] = [], seen = new Set<string>();
    for (const glob of cfg.flows) {
        const files = globSync(glob, { cwd: cfg.root }).sort();
        if (!files.length) throw new Error(`tapcheck.yml: flows: "${glob}" matches no file.`);
        for (const file of files) {
            if (seen.has(file)) continue; // matched by an earlier glob too
            seen.add(file);
            // Node reads a .ts or .js file as CommonJS when the nearest package.json says so, and then `export` is a syntax error.
            const mod = await import(pathToFileURL(resolve(cfg.root, file)).href).catch((e: Error) => {
                throw new Error(`${file}: ${e.message}${e instanceof SyntaxError ? ' (if the nearest package.json has "type": "commonjs", name flow files .mts or .mjs)' : ''}`);
            });
            const f = mod.default as Flow | undefined;
            if (!f || typeof f.name !== 'string' || !f.name.trim() || typeof f.run !== 'function') throw new Error(`${file}: a flow file needs \`export default { name, side?, run: async (t) => {…} }\`.`);
            const side = f.side ?? cfg.sides[0].name;
            if (!cfg.sides.some((s) => s.name === side)) throw new Error(`${file}: side "${side}" isn't in sides (${cfg.sides.map((s) => s.name).join(', ')}).`);
            if (f.timeout !== undefined && !(Number.isFinite(f.timeout) && f.timeout > 0)) throw new Error(`${file}: timeout must be a number of seconds above 0.`);
            const part = `flow-${slug(f.name).replace(/_/g, '-')}`;
            if (out.some((o) => o.part === part)) throw new Error(`${file}: another flow is already called "${f.name}" (part ${part}).`);
            out.push({ name: f.name, side, timeout: f.timeout ?? 3600, run: f.run, part });
        }
    }
    return out;
}

/** Runs one flow on its side; whatever it throws outside a step is the caller's to record. */
export async function runFlow(flow: Loaded, r: Run, stubUrl?: string) {
    const t = new T(r, flow, stubUrl);
    let timer: NodeJS.Timeout | undefined;
    // A flow stuck on a promise that never settles would otherwise hold up every part after it.
    const limit = new Promise<never>((_, no) => {
        timer = setTimeout(() => {
            const why = `the flow didn't finish within ${flow.timeout} s (raise its timeout if it needs longer)`;
            t.kill(why); // what the abandoned run() still does is no longer recorded
            no(new Error(why));
        }, flow.timeout * 1000);
    });
    const running = flow.run(t);
    running.catch(() => {}); // abandoned at the timeout, it ends by throwing at its next t.* call: not an unhandled rejection
    try { await Promise.race([running, limit]); } finally { clearTimeout(timer); await t.finish(); await t.close(); }
}
