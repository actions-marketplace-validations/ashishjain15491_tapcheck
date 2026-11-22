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
 * returns `{ warn: '…' }` is a warning instead); the flow
 * carries on after a failed step, and a flow that takes longer than its `timeout` (seconds, default 3600) fails; t.note(name, detail, 'warn' | 'info') records a warning or a note without a step. Unlike the suites, a flow may click anything and change data: run it against a copy
 * you can reset. t.jev() and t.mail.judge() ask Jev to look at the current page or at an email; with JEV=off or no key
 * they record that they were skipped and return null, so a flow that calls them still runs everywhere.
 */
import { globSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserContext, Page } from 'playwright';
import { abs, context, settle, slices, slug, watch, type Run } from './browser.ts';
import { isLocal, type Config } from './config.ts';
import * as jev from './jev.ts';
import { EMAIL, VISUAL, YES_IS_DEFECT } from './questions.ts';
import type { Finding } from './report.ts';
import type { FailRule, Reply, Seen } from './stub.ts';

/** For a flow's own questions to t.jev() and t.mail.judge(). */
export { choice, noul, score } from '@typesafe-ai/sdk';
/** timeout: seconds the whole flow may take (default 3600); past it the flow fails and the run goes on. */
export type Flow = { name: string; side?: string; timeout?: number; run: (t: T) => Promise<void> };
/** A flow as loaded: its side settled and its part name. */
export type Loaded = Required<Flow> & { part: string };
/** One message in Mailpit. headers: every header by name, as Mailpit spells it ("List-Unsubscribe"), each with its values. */
export type Mail = { id: string; subject: string; from: string; to: string[]; html: string; text: string; links: string[]; headers: Record<string, string[]> };

/** What a flow's run() is handed. */
export class T {
    private r: Run;
    private flow: Loaded;
    private stubUrl?: string;
    private pages = new Map<boolean, Page>(); // signed in → page
    private errors = new WeakMap<Page, string[]>();
    private current?: Page; // the page last handed out: goto() drives it, a failed step shows it

    constructor(r: Run, flow: Loaded, stubUrl?: string) {
        this.r = r;
        this.flow = flow;
        this.stubUrl = stubUrl;
    }

    /** A page on the flow's side at the first viewport, signed in with the side's session (`{ auth: false }`: signed out). One of each is kept. */
    async page(opts: { auth?: boolean } = {}): Promise<Page> {
        const auth = opts.auth !== false;
        if (!this.pages.has(auth)) {
            const page = await (await context(this.r, this.r.cfg.viewports[0], auth)).newPage();
            this.errors.set(page, watch(page));
            this.pages.set(auth, page);
        }
        return (this.current = this.pages.get(auth)!);
    }

    /** Opens a path of the side (or a full URL) on the current page and waits for it to settle. */
    async goto(path: string): Promise<Page> {
        const page = this.current ?? await this.page();
        await page.goto(abs(this.r, path), { waitUntil: 'domcontentloaded' });
        await settle(page);
        return page;
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
        const errors = this.current && this.errors.get(this.current);
        if (errors) errors.length = 0;
        const base = { suite: this.flow.part, where: this.flow.name, check: name };
        this.r.step = name; // what the step reaches is filed under it (hits.json)
        try {
            const out = await fn();
            if (out && typeof out === 'object') this.r.record({ ...base, status: 'warn', detail: out.warn });
            else this.r.record({ ...base, status: 'pass', detail: out || undefined });
            return true;
        } catch (e) {
            const page = this.current, seen = (page && this.errors.get(page)) ?? [];
            let shot: string | undefined = `${this.r.dir}/shots/${this.flow.part}-${slug(name)}.png`;
            mkdirSync(`${this.r.dir}/shots`, { recursive: true });
            if (!page || page.isClosed() || !(await page.screenshot({ path: shot }).then(() => true, () => false))) shot = undefined;
            this.r.record({ ...base, status: 'fail', evidence: shot ? [shot] : undefined,
                detail: [String((e as Error).message ?? e).split('\n').slice(0, 4).join(' ⏎ ').slice(0, 500), seen.length ? `console: ${seen.slice(0, 3).join(' | ').slice(0, 300)}` : ''].filter(Boolean).join(' · ') });
            return false;
        } finally {
            this.r.step = undefined;
        }
    }

    /** A finding the flow decides itself: a warning (default), or info such as a check it skipped and why. */
    note(name: string, detail: string, status: 'warn' | 'info' = 'warn'): void {
        this.r.record({ suite: this.flow.part, where: this.flow.name, check: name, status, detail });
    }

    /** Records that Jev's look at `label` was skipped, and why. */
    private skipped(label: string, why: string): null {
        this.r.record({ suite: this.flow.part, where: `${this.flow.name} › ${label}`, check: "Jev's look", status: 'info', detail: `skipped (${why})` });
        return null;
    }

    /** Asks Jev about `shots`; one finding per answer. Null (and one info finding) when its budget is spent. */
    private async look(label: string, state: Record<string, unknown>, questions: Record<string, any>, shots: string[]): Promise<Record<string, any> | null> {
        const rec = (check: string, status: Finding['status'], detail?: string) => this.r.record({ suite: this.flow.part, where: `${this.flow.name} › ${label}`, check, status, detail, evidence: shots });
        let a: Record<string, any>;
        try { a = await jev.ask(`${this.flow.part}:${label}`, state, questions, shots); } catch (e) {
            if (e instanceof jev.BudgetReached) return this.skipped(label, e.message);
            throw e;
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
        if (jev.whyOff()) return this.skipped(label, jev.whyOff());
        const page = this.current ?? await this.page();
        const vh = page.viewportSize()?.height ?? 800;
        const shoot = async () => {
            await settle(page);
            return slices(this.r, page, `${this.flow.part}-jev-${slug(label)}`, await page.evaluate(() => document.documentElement.scrollHeight), vh);
        };
        // A page that reloads itself while it is looked at (after a save, say) throws the look out: look again once it is back.
        const shots = await shoot().catch((e) => { if (!/context was destroyed|navigat/i.test(String(e))) throw e; return shoot(); });
        return this.look(label, { screen: label, screenshots: shots.map(jev.img),
            note: shots.length > 1 ? 'The screenshots are consecutive slices of one screen, top to bottom.' : undefined }, questions, shots);
    }

    private async api(base: string, path: string, method = 'GET', body?: unknown): Promise<any> {
        const res = await fetch(base + path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        if (!res.ok) throw new Error(`${method} ${base}${path} answered ${res.status}`);
        return res.json();
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
            /** Every such message, newest first (at most 500), each read in full. */
            all: async (f: Filter = {}): Promise<Mail[]> => {
                const out: Mail[] = [];
                for (const m of (await search(f, 500).found).messages ?? []) out.push(await read(m.ID));
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
            clear: async () => { await fetch(`${base}/api/v1/messages`, { method: 'DELETE' }); },
        };
    }

    /** Closes the flow's pages. */
    async close() {
        for (const page of this.pages.values()) await page.context().close().catch(() => {});
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
    const limit = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`the flow didn't finish within ${flow.timeout} s (raise its timeout if it needs longer)`)), flow.timeout * 1000); });
    try { await Promise.race([flow.run(t), limit]); } finally { clearTimeout(timer); await t.close(); }
}
