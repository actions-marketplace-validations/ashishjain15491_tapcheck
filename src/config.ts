/*
 * tapcheck.yml: load, fill in $VARS from the environment, check, and apply defaults. Every check names the field and
 * says what it should be, so a wrong config fails before any browser starts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';

export type Screen = { name: string; path?: string; from?: string; link?: string; suffix?: string; purpose?: string };
export type Login =
    | { none: true }
    | { manual: string } // the sign-in page; a person signs in in a visible browser, the session is kept
    | { form: { url: string; fields: Record<string, string>; submit?: string; totp?: { field: string; secret: string } } }
    | { command: string }; // prints a Playwright storageState JSON on stdout
/** A usability task: start at `from`, try to reach the screen `done` describes in about `optimal` clicks; `text` is what a person would type on the way. */
export type Task = { name: string; from: string; goal: string; done: string; notDone: string; optimal: number; text?: string };
/** Every suite, in run order. */
export const SUITES = ['crawl', 'contract', 'security', 'a11y', 'ux', 'usability'] as const;
export type Side = { name: string; baseUrl: string; login: Login; screens: Screen[]; tasks: Task[] };
export type Config = {
    baseUrl: string;
    app: { start?: string; stop?: string; reset?: string; ready: string; timeout: number; allowRemoteReset: boolean };
    sides: Side[];
    loginPaths: RegExp; // a page whose path matches is a sign-in page: being sent there means "not signed in"
    crawl: { max: number; skip: RegExp };
    security: { csrf?: { method: string; path: string; expect: number }; allowedHosts: string[] };
    viewports: { name: string; width: number; height: number; mobile: boolean }[];
    out: string;
    audience: string; // who the app is for, in the words Jev is asked with ("a shop owner", "a nurse on a ward")
    jev: { budget: number; headers: Record<string, string> }; // budget in USD per run; headers are sent with every Jev request
    i18n: { keys?: string }; // a shell command printing one translation key per line
    // CHANGED=1: which files each suite depends on, as globs on paths from the git root ("*" is every suite). A suite
    // with no globs reruns on any change. Globs are Node's path.matchesGlob: * and ** don't match names starting with a dot.
    changes: Record<string, string[]>;
};

const DEFAULT_SKIP = '/(logout|log-out|sign-?out|delete|destroy|remove|export|download|impersonat|unsubscribe)|\\.(csv|pdf|zip|png|jpe?g|gif|svg|webp|ico|xlsx?)$';
const DEFAULT_VIEWPORTS = [
    { name: 'desktop', width: 1440, height: 900, mobile: false },
    { name: 'mobile', width: 390, height: 844, mobile: true },
];

/** Replaces $NAME and ${NAME} in every string with the environment's value; a missing variable is an error. */
export function expand(v: unknown, at = ''): any {
    if (typeof v === 'string') {
        return v.replace(/\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g, (_m, a, b) => {
            const name = a ?? b;
            if (process.env[name] === undefined) throw new Error(`tapcheck.yml: ${at}: environment variable ${name} is not set`);
            return process.env[name]!;
        });
    }
    if (Array.isArray(v)) return v.map((x, i) => expand(x, `${at}[${i}]`));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x, at ? `${at}.${k}` : k)]));
    return v;
}

function fail(field: string, want: string): never {
    throw new Error(`tapcheck.yml: ${field} ${want}`);
}
const str = (v: unknown, field: string, optional = false): string | undefined => {
    if (v === undefined && optional) return undefined;
    if (typeof v !== 'string' || !v.trim()) fail(field, 'must be a non-empty string');
    return v;
};
const regex = (v: unknown, field: string, fallback: string): RegExp => {
    const s = str(v ?? fallback, field)!;
    try { return new RegExp(s, 'i'); } catch (e) { fail(field, `is not a valid regular expression: ${(e as Error).message}`); }
};
const url = (v: unknown, field: string): string => {
    const s = str(v, field)!;
    if (!/^https?:\/\/[^/]+/.test(s)) fail(field, `must be an http(s) URL, got "${s}"`);
    return s.replace(/\/$/, '');
};

function login(v: unknown, field: string): Login {
    if (v === undefined || v === 'none') return { none: true };
    if (v === 'manual') return { manual: '/login' };
    if (!v || typeof v !== 'object') fail(field, 'must be none, manual, or one of {manual: <path>}, {form: …}, {command: …}');
    const o = v as Record<string, any>;
    const keys = Object.keys(o);
    if (keys.length !== 1) fail(field, `must have exactly one of manual, form, command (got ${keys.join(', ') || 'none'})`);
    if ('manual' in o) return { manual: str(o.manual, `${field}.manual`)! };
    if ('command' in o) return { command: str(o.command, `${field}.command`)! };
    if ('form' in o) {
        const f = o.form ?? {};
        if (!f.fields || typeof f.fields !== 'object' || !Object.keys(f.fields).length) fail(`${field}.form.fields`, 'must map at least one field to its value');
        for (const [k, x] of Object.entries(f.fields)) str(x, `${field}.form.fields.${k}`);
        const totp = f.totp === undefined ? undefined : { field: str(f.totp.field, `${field}.form.totp.field`)!, secret: str(f.totp.secret, `${field}.form.totp.secret`)! };
        return { form: { url: str(f.url, `${field}.form.url`)!, fields: f.fields, submit: str(f.submit, `${field}.form.submit`, true), totp } };
    }
    fail(field, `has an unknown kind "${keys[0]}" (use manual, form or command)`);
}

function screens(v: unknown, field: string): Screen[] {
    if (v === undefined) return [];
    if (!Array.isArray(v)) fail(field, 'must be a list of screens');
    return v.map((s, i) => {
        const at = `${field}[${i}]`;
        if (!s || typeof s !== 'object') fail(at, 'must be {name, path} or {name, from, link}');
        const name = str(s.name, `${at}.name`)!;
        if (!s.path && !(s.from && s.link)) fail(at, 'needs a path, or from + link');
        if (s.link) regex(s.link, `${at}.link`, '');
        return { name, path: str(s.path, `${at}.path`, true), from: str(s.from, `${at}.from`, true), link: str(s.link, `${at}.link`, true),
            suffix: str(s.suffix, `${at}.suffix`, true), purpose: str(s.purpose, `${at}.purpose`, true) };
    });
}

function tasks(v: unknown, field: string): Task[] {
    if (v === undefined) return [];
    if (!Array.isArray(v)) fail(field, 'must be a list of tasks');
    return v.map((t, i) => {
        const at = `${field}[${i}]`;
        if (!t || typeof t !== 'object') fail(at, 'must be {name, from, goal, done, notDone, optimal}');
        if (!Number.isInteger(t.optimal) || t.optimal < 1) fail(`${at}.optimal`, 'must be the fewest clicks that reach the goal (a whole number above 0)');
        return { name: str(t.name, `${at}.name`)!, from: str(t.from, `${at}.from`)!, goal: str(t.goal, `${at}.goal`)!, done: str(t.done, `${at}.done`)!,
            notDone: str(t.notDone, `${at}.notDone`)!, optimal: t.optimal, text: str(t.text, `${at}.text`, true) };
    });
}

/** Checks a parsed (and expanded) config object and fills in the defaults. */
export function check(raw: any): Config {
    if (!raw || typeof raw !== 'object') fail('', 'must be a YAML mapping');
    const baseUrl = url(raw.baseUrl, 'baseUrl');
    const a = raw.app ?? {};
    const timeout = a.timeout ?? 120;
    if (typeof timeout !== 'number' || timeout <= 0) fail('app.timeout', 'must be a positive number of seconds');
    const app = { start: str(a.start, 'app.start', true), stop: str(a.stop, 'app.stop', true), reset: str(a.reset, 'app.reset', true),
        ready: str(a.ready ?? '/', 'app.ready')!, timeout, allowRemoteReset: a.allowRemoteReset === true };

    // screens and tasks: a list (every side) or a map of side → list.
    const byside = (key: 'screens' | 'tasks', side: string) => (Array.isArray(raw[key]) ? raw[key] : raw[key]?.[side]);
    const at = (key: 'screens' | 'tasks', side: string) => (Array.isArray(raw[key]) ? key : `${key}.${side}`);
    const sideDefs: Record<string, any> = raw.sides ?? { public: {} };
    if (typeof sideDefs !== 'object' || Array.isArray(sideDefs) || !Object.keys(sideDefs).length) fail('sides', 'must map each side name to {login, baseUrl?}');
    const sides = Object.entries(sideDefs).map(([name, s]): Side => {
        if (!/^[a-z][a-z0-9-]*$/.test(name)) fail(`sides.${name}`, 'name must be lowercase letters, digits and dashes');
        // Side names are tags too (ONLY=<side>), so they can't reuse a suite or kind tag.
        if ([...SUITES, 'jev', 'measured'].includes(name)) fail(`sides.${name}`, `name can't be a suite or tag name (${[...SUITES, 'jev', 'measured'].join(', ')})`);
        return { name, baseUrl: s?.baseUrl ? url(s.baseUrl, `sides.${name}.baseUrl`) : baseUrl, login: login(s?.login, `sides.${name}.login`),
            screens: screens(byside('screens', name), at('screens', name)), tasks: tasks(byside('tasks', name), at('tasks', name)) };
    });
    for (const key of ['screens', 'tasks'] as const) {
        if (!raw[key] || Array.isArray(raw[key])) continue;
        if (typeof raw[key] !== 'object') fail(key, `must be a list, or map each side to a list`);
        for (const k of Object.keys(raw[key])) if (!sides.some((s) => s.name === k)) fail(`${key}.${k}`, `names a side that isn't in sides (${sides.map((s) => s.name).join(', ')})`);
    }

    const c = raw.crawl ?? {};
    const max = c.max ?? 60;
    if (!Number.isInteger(max) || max < 1) fail('crawl.max', 'must be a whole number above 0');
    const s = raw.security ?? {};
    let csrf;
    if (s.csrf !== undefined) {
        const expect = s.csrf.expect;
        if (!Number.isInteger(expect)) fail('security.csrf.expect', 'must be the HTTP status the app answers with (e.g. 403 or 419)');
        csrf = { method: (str(s.csrf.method ?? 'POST', 'security.csrf.method')!).toUpperCase(), path: str(s.csrf.path, 'security.csrf.path')!, expect };
    }
    const allowedHosts = s.allowedHosts ?? [];
    if (!Array.isArray(allowedHosts)) fail('security.allowedHosts', 'must be a list of host names');

    const viewports = raw.viewports ?? DEFAULT_VIEWPORTS;
    if (!Array.isArray(viewports) || !viewports.length) fail('viewports', 'must be a list of {name, width, height, mobile?}');
    viewports.forEach((v: any, i: number) => {
        if (!v?.name || !Number.isInteger(v.width) || !Number.isInteger(v.height)) fail(`viewports[${i}]`, 'needs name, width and height');
        v.mobile = v.mobile === true;
    });

    const j = raw.jev ?? {};
    if (typeof j !== 'object' || Array.isArray(j)) fail('jev', 'must be {budget?, headers?}');
    const budget = process.env.JEV_BUDGET !== undefined ? Number(process.env.JEV_BUDGET) : j.budget ?? 1;
    if (typeof budget !== 'number' || !(budget > 0)) fail(process.env.JEV_BUDGET !== undefined ? 'JEV_BUDGET (environment)' : 'jev.budget', 'must be a number of US dollars above 0');
    const headers = j.headers ?? {};
    if (typeof headers !== 'object' || Array.isArray(headers)) fail('jev.headers', 'must map header names to values');
    for (const [k, x] of Object.entries(headers)) str(x, `jev.headers.${k}`);
    if (raw.i18n !== undefined && (!raw.i18n || typeof raw.i18n !== 'object')) fail('i18n', 'must be {keys: <command printing one translation key per line>}');

    const changes = raw.changes ?? {};
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) fail('changes', 'must map a suite name (or "*") to a list of globs');
    for (const [k, globs] of Object.entries(changes)) {
        if (k !== '*' && !(SUITES as readonly string[]).includes(k)) fail(`changes.${k}`, `names a suite that doesn't exist (use "*" or one of ${SUITES.join(', ')})`);
        if (!Array.isArray(globs) || !globs.length) fail(`changes.${k}`, 'must be a list of globs, e.g. ["src/**"]');
        globs.forEach((g, i) => str(g, `changes.${k}[${i}]`));
    }

    return { baseUrl, app, sides, changes, audience: str(raw.audience ?? 'a first-time visitor', 'audience')!, jev: { budget, headers },
        i18n: { keys: str(raw.i18n?.keys, 'i18n.keys', true) }, loginPaths: regex(raw.loginPaths, 'loginPaths', '/(login|sign-?in|two-factor|2fa)(/|$)'),
        crawl: { max, skip: regex(c.skip, 'crawl.skip', DEFAULT_SKIP) }, security: { csrf, allowedHosts }, viewports, out: str(raw.out ?? '.tapcheck', 'out')! };
}

export function load(file = 'tapcheck.yml'): Config {
    if (!existsSync(file)) throw new Error(`No ${file} here. Write one (see examples/) or let the tapcheck-setup skill write it.`);
    let raw;
    try { raw = parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file} is not valid YAML: ${(e as Error).message}`); }
    return check(expand(raw));
}

/** Hosts a reset may run against without allowRemoteReset: this machine, *.localhost and *.test. */
export const isLocal = (u: string) => {
    const h = new URL(u).hostname;
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(h) || h.endsWith('.localhost') || h.endsWith('.test');
};
