/*
 * tapcheck.yml: load, fill in $VARS from the environment, check, and apply defaults. Every check names the field and
 * says what it should be, so a wrong config fails before any browser starts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isIPv4, isIPv6 } from 'node:net';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';

export type Screen = { name: string; path?: string; from?: string; link?: string; suffix?: string; purpose?: string };
export type Login =
    | { none: true }
    | { manual: string } // the sign-in page; a person signs in in a visible browser, the session is kept
    | { form: { url: string; fields: Record<string, string>; submit?: string; totp?: { field: string; secret: string } } }
    | { command: string }; // prints a Playwright storageState JSON on stdout
/** A usability task: start at `from`, try to reach the screen `done` describes in about `optimal` clicks; `text` is what a person would type on the way. */
export type Task = { name: string; from: string; goal: string; done: string; notDone: string; optimal: number; text?: string };
/** Every suite that runs once per side, in run order. */
export const SUITES = ['crawl', 'contract', 'security', 'a11y', 'interact', 'audit', 'ux', 'usability'] as const;
/** The suite names `changes` can key on: the suites, plus the side-less `code` part and the custom flows. A part name
 * (a11y-customer, flow-checkout) is a key too; the CLI checks those once the flows are loaded. */
export const CHANGE_KEYS: string[] = [...SUITES, 'code', 'flow'];
/** A command from the project's own toolchain: exit 0 passes; `warn` makes a non-zero exit a warning. `timeout` in seconds. */
export type Gate = { name: string; run: string; timeout: number; warn: boolean };
/** One canned answer of the stub server (src/stub.ts). `path` is a glob, or a regular expression when it starts with ^. */
export type StubRule = { host?: string; method?: string; path?: string; status: number; json?: unknown; body?: string; file?: string; headers: Record<string, string>; delayMs: number };
/** One answer of the stub's DNS server. An MX value is "<priority> <host>" or just the host (priority 10). */
export const DNS_TYPES = ['A', 'AAAA', 'MX', 'TXT', 'CNAME', 'NS'] as const;
export type DnsRecord = { name: string; type: (typeof DNS_TYPES)[number]; values: string[] };
export type Csrf = { method: string; path: string; expect: number };
/** `csrf`: this side's own CSRF probe, in place of security.csrf (another host often has other routes). */
export type Side = { name: string; baseUrl: string; login: Login; screens: Screen[]; tasks: Task[]; csrf?: Csrf;
    signedIn?: string }; // a selector on every signed-in page and not on the sign-in form (the account menu): its absence means signed out
export type Config = {
    root: string; // the config file's folder: gates, the routes command, flows and stub files are relative to it
    baseUrl: string;
    // resetWhen: globs on paths from the git root; a matching file changed since the last reset runs `reset` before the run.
    app: { start?: string; stop?: string; reset?: string; resetWhen: string[]; ready: string; timeout: number; allowRemoteReset: boolean };
    sides: Side[];
    loginPaths: RegExp; // a page whose path matches is a sign-in page: being sent there means "not signed in"
    crawl: { max: number; skip: RegExp };
    // interact: `max` crawled screens are clicked through; `submit` also sends valid input in dialog forms, which changes data.
    interact: { max: number; submit: boolean };
    audit: { max: number; skip?: RegExp }; // max: crawled pages audited on top of the screens (0: screens only); skip: paths left out
    // The design tokens the audit holds computed styles to; a list left out isn't checked. Colours are hex, radii and spacing px.
    design?: { colors?: string[]; fonts?: string[]; radii?: number[]; spacing?: number[] };
    security: { csrf?: Csrf; allowedHosts: string[]; publicWrites?: RegExp }; // publicWrites: routes that write without sign-in on purpose
    viewports: { name: string; width: number; height: number; mobile: boolean }[];
    out: string;
    audience: string; // who the app is for, in the words Jev is asked with ("a shop owner", "a nurse on a ward")
    context?: string; // what kind of product it is and the conventions its users expect; sent to Jev with every question
    // Findings that are right for this product: a fail or warn whose "<suite>: <check> @ <where>" matches is recorded as info, with why.
    expect: { match: RegExp; why: string }[];
    jev: { budget: number; headers: Record<string, string> }; // budget in USD per run; headers are sent with every Jev request
    i18n: { keys?: string }; // a shell command printing one translation key per line
    // CHANGED=1: which files each suite depends on, as globs on paths from the git root ("*" is every suite). A suite
    // with no globs reruns on any change. Globs are Node's path.matchesGlob: * and ** don't match names starting with a dot.
    changes: Record<string, string[]>;
    gates: Gate[];
    routes?: string; // a shell command printing the app's routes as JSON: [{method, path, auth?}]
    stub?: { port: number; rules: StubRule[]; dns?: { port: number; records: DnsRecord[]; defaultA?: string } };
    // COVERAGE=1: where the merged coverage map goes (from the config file's folder), and the gaps that are there on purpose.
    coverage: { file: string; reasons: { match: RegExp; why: string }[] };
    flows: string[]; // globs of flow files (src/flow.ts)
    parallel: number; // how many flows of a side run at once (PARALLEL overrides it); 1 runs them one by one
    mail: { mailpit?: string }; // Mailpit's web address, for t.mail in flows
    browser: { args: string[] }; // extra command-line switches for the run's Chromium
    marks: boolean; // marked screenshots (MARK=1 or MARK=0 overrides it): the banner, boxes and notes drawn on a fail's or warning's evidence
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

function csrfOf(v: any, field: string): Csrf | undefined {
    if (v === undefined) return undefined;
    if (!v || typeof v !== 'object') fail(field, 'must be {method?, path, expect}');
    if (!Number.isInteger(v.expect)) fail(`${field}.expect`, 'must be the HTTP status the app answers with (e.g. 403 or 419)');
    return { method: (str(v.method ?? 'POST', `${field}.method`)!).toUpperCase(), path: str(v.path, `${field}.path`)!, expect: v.expect };
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

function gates(v: unknown): Gate[] {
    if (v === undefined) return [];
    if (!Array.isArray(v)) fail('gates', 'must be a list of {name, run, timeout?, warn?}');
    return v.map((g, i) => {
        const at = `gates[${i}]`;
        if (!g || typeof g !== 'object') fail(at, 'must be {name, run, timeout?, warn?}');
        const timeout = g.timeout ?? 600;
        if (typeof timeout !== 'number' || timeout <= 0) fail(`${at}.timeout`, 'must be a positive number of seconds');
        return { name: str(g.name, `${at}.name`)!, run: str(g.run, `${at}.run`)!, timeout, warn: g.warn === true };
    });
}

function stub(v: any, root: string): Config['stub'] {
    if (v === undefined) return undefined;
    if (!v || typeof v !== 'object' || Array.isArray(v)) fail('stub', 'must be {port?, rules?, dns?}');
    const port = v.port ?? 8766;
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail('stub.port', 'must be a port number (1–65535)');
    if (v.rules !== undefined && !Array.isArray(v.rules)) fail('stub.rules', 'must be a list of {host?, method?, path?, status?, json? | body? | file?, headers?, delayMs?}');
    const rules = (v.rules ?? []).map((r: any, i: number): StubRule => {
        const at = `stub.rules[${i}]`;
        if (!r || typeof r !== 'object') fail(at, 'must be {host?, method?, path?, status?, json? | body? | file?, headers?, delayMs?}');
        const status = r.status ?? 200, delayMs = r.delayMs ?? 0, headers = r.headers ?? {};
        if (!Number.isInteger(status) || status < 100 || status > 599) fail(`${at}.status`, 'must be an HTTP status (100–599)');
        if (typeof delayMs !== 'number' || delayMs < 0) fail(`${at}.delayMs`, 'must be a number of milliseconds, 0 or more');
        if (typeof headers !== 'object' || Array.isArray(headers)) fail(`${at}.headers`, 'must map header names to values');
        if (['json', 'body', 'file'].filter((k) => r[k] !== undefined).length > 1) fail(at, 'takes one of json, body or file');
        const path = str(r.path, `${at}.path`, true);
        if (path?.startsWith('^')) regex(path, `${at}.path`, '');
        const file = str(r.file, `${at}.file`, true);
        if (file && !existsSync(resolve(root, file))) fail(`${at}.file`, `is not a file next to tapcheck.yml: ${file}`);
        return { host: str(r.host, `${at}.host`, true)?.toLowerCase(), method: str(r.method, `${at}.method`, true)?.toUpperCase(), path, status, json: r.json,
            body: r.body === undefined ? undefined : String(r.body), file, headers, delayMs };
    });
    return { port, rules, dns: dns(v.dns) };
}

/** A record value as the stub can encode it: an address for A and AAAA, [priority] host for MX, any text otherwise. */
export const dnsValue = (type: string, x: unknown) => typeof x === 'string' && !!x.trim()
    && (type === 'A' ? isIPv4(x) : type === 'AAAA' ? isIPv6(x) && !x.includes('.') : type === 'MX' ? /^(\d+\s+)?\S+$/.test(x) : true);

function dns(v: any): NonNullable<Config['stub']>['dns'] {
    if (v === undefined) return undefined;
    if (!v || typeof v !== 'object' || Array.isArray(v)) fail('stub.dns', 'must be {port?, records?, defaultA?}');
    const port = v.port ?? 8767;
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail('stub.dns.port', 'must be a port number (1–65535)');
    if (v.records !== undefined && !Array.isArray(v.records)) fail('stub.dns.records', 'must be a list of {name, type, values}');
    const records = (v.records ?? []).map((r: any, i: number): DnsRecord => {
        const at = `stub.dns.records[${i}]`;
        if (!r || typeof r !== 'object') fail(at, 'must be {name, type, values}');
        const type = String(r.type ?? '').toUpperCase() as DnsRecord['type'];
        if (!DNS_TYPES.includes(type)) fail(`${at}.type`, `must be one of ${DNS_TYPES.join(', ')}`);
        if (!Array.isArray(r.values) || !r.values.length) fail(`${at}.values`, 'must be a list with at least one value');
        r.values.forEach((x: unknown, j: number) => dnsValue(type, x) || fail(`${at}.values[${j}]`,
            type === 'A' ? 'must be an IPv4 address' : type === 'AAAA' ? 'must be an IPv6 address (hex groups only)' : type === 'MX' ? 'must be a mail host, or "<priority> <host>"' : 'must be a non-empty string'));
        return { name: str(r.name, `${at}.name`)!.toLowerCase().replace(/\.$/, ''), type, values: r.values };
    });
    if (v.defaultA !== undefined && !dnsValue('A', v.defaultA)) fail('stub.dns.defaultA', 'must be an IPv4 address');
    return { port, records, defaultA: v.defaultA };
}

function coverage(v: any): Config['coverage'] {
    if (v !== undefined && (!v || typeof v !== 'object' || Array.isArray(v))) fail('coverage', 'must be {file?, reasons?}');
    if (v?.reasons !== undefined && !Array.isArray(v.reasons)) fail('coverage.reasons', 'must be a list of {match, why}');
    return { file: str(v?.file ?? 'COVERAGE.md', 'coverage.file')!, reasons: (v?.reasons ?? []).map((r: any, i: number) => {
        if (!r || typeof r !== 'object') fail(`coverage.reasons[${i}]`, 'must be {match, why}');
        return { match: regex(r.match, `coverage.reasons[${i}].match`, ''), why: str(r.why, `coverage.reasons[${i}].why`)! };
    }) };
}

function expect(v: any): Config['expect'] {
    if (v !== undefined && !Array.isArray(v)) fail('expect', 'must be a list of {match, why}');
    return (v ?? []).map((r: any, i: number) => {
        if (!r || typeof r !== 'object' || Array.isArray(r)) fail(`expect[${i}]`, 'must be {match, why}');
        return { match: regex(r.match, `expect[${i}].match`, ''), why: str(r.why, `expect[${i}].why`)! };
    });
}

function design(v: any): Config['design'] {
    if (v === undefined) return undefined;
    if (!v || typeof v !== 'object' || Array.isArray(v)) fail('design', 'must be {colors?, fonts?, radii?, spacing?}');
    const list = <T>(key: string, ok: (x: unknown) => boolean, want: string): T[] | undefined => {
        if (v[key] === undefined) return undefined;
        if (!Array.isArray(v[key])) fail(`design.${key}`, 'must be a list');
        v[key].forEach((x: unknown, i: number) => ok(x) || fail(`design.${key}[${i}]`, want));
        return v[key];
    };
    const px = (x: unknown) => typeof x === 'number' && x >= 0;
    return { colors: list('colors', (x) => typeof x === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(x), 'must be a hex colour in quotes, such as "#1f2937"'),
        fonts: list('fonts', (x) => typeof x === 'string' && !!x.trim(), 'must be a font family name'),
        radii: list('radii', px, 'must be a number of pixels, 0 or more'), spacing: list('spacing', px, 'must be a number of pixels, 0 or more') };
}

/** Checks a parsed (and expanded) config object and fills in the defaults. `root` is the config file's folder. */
export function check(raw: any, root = process.cwd()): Config {
    if (!raw || typeof raw !== 'object') fail('', 'must be a YAML mapping');
    const baseUrl = url(raw.baseUrl, 'baseUrl');
    const a = raw.app ?? {};
    const timeout = a.timeout ?? 120;
    if (typeof timeout !== 'number' || timeout <= 0) fail('app.timeout', 'must be a positive number of seconds');
    const resetWhen = a.resetWhen ?? [];
    if (!Array.isArray(resetWhen)) fail('app.resetWhen', 'must be a list of globs, e.g. ["database/**"]');
    resetWhen.forEach((g: unknown, i: number) => str(g, `app.resetWhen[${i}]`));
    if (resetWhen.length && !a.reset) fail('app.resetWhen', 'needs app.reset: the command it runs');
    const app = { start: str(a.start, 'app.start', true), stop: str(a.stop, 'app.stop', true), reset: str(a.reset, 'app.reset', true), resetWhen,
        ready: str(a.ready ?? '/', 'app.ready')!, timeout, allowRemoteReset: a.allowRemoteReset === true };

    // screens and tasks: a list (every side) or a map of side → list.
    const byside = (key: 'screens' | 'tasks', side: string) => (Array.isArray(raw[key]) ? raw[key] : raw[key]?.[side]);
    const at = (key: 'screens' | 'tasks', side: string) => (Array.isArray(raw[key]) ? key : `${key}.${side}`);
    const sideDefs: Record<string, any> = raw.sides ?? { public: {} };
    if (typeof sideDefs !== 'object' || Array.isArray(sideDefs) || !Object.keys(sideDefs).length) fail('sides', 'must map each side name to {login, baseUrl?, csrf?, signedIn?}');
    const sides = Object.entries(sideDefs).map(([name, s]): Side => {
        if (!/^[a-z][a-z0-9-]*$/.test(name)) fail(`sides.${name}`, 'name must be lowercase letters, digits and dashes');
        // Side names are tags too (ONLY=<side>), so they can't reuse a suite or kind tag.
        if ([...CHANGE_KEYS, 'jev', 'measured', 'verify'].includes(name)) fail(`sides.${name}`, `name can't be a suite or tag name (${[...CHANGE_KEYS, 'jev', 'measured', 'verify'].join(', ')})`);
        return { name, baseUrl: s?.baseUrl ? url(s.baseUrl, `sides.${name}.baseUrl`) : baseUrl, login: login(s?.login, `sides.${name}.login`), csrf: csrfOf(s?.csrf, `sides.${name}.csrf`), signedIn: str(s?.signedIn, `sides.${name}.signedIn`, true),
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
    const it = raw.interact ?? {}, au = raw.audit ?? {};
    if (typeof it !== 'object' || Array.isArray(it)) fail('interact', 'must be {max?, submit?}');
    const interactMax = it.max ?? 40;
    if (!Number.isInteger(interactMax) || interactMax < 1) fail('interact.max', 'must be a whole number above 0');
    if (it.submit !== undefined && typeof it.submit !== 'boolean') fail('interact.submit', 'must be true or false');
    if (typeof au !== 'object' || Array.isArray(au)) fail('audit', 'must be {max?, skip?}');
    const auditMax = au.max ?? 0;
    if (!Number.isInteger(auditMax) || auditMax < 0) fail('audit.max', 'must be a whole number, 0 or more');
    const s = raw.security ?? {};
    const csrf = csrfOf(s.csrf, 'security.csrf');
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
        if (k !== '*' && !CHANGE_KEYS.includes(k) && !(k.startsWith('flow-') || CHANGE_KEYS.some((x) => k.startsWith(`${x}-`)))) {
            fail(`changes.${k}`, `names a suite that doesn't exist (use "*", a part name such as flow-<name> or a11y-<side>, or one of ${CHANGE_KEYS.join(', ')})`);
        }
        if (!Array.isArray(globs) || !globs.length) fail(`changes.${k}`, 'must be a list of globs, e.g. ["src/**"]');
        globs.forEach((g, i) => str(g, `changes.${k}[${i}]`));
    }

    const parallel = process.env.PARALLEL !== undefined && process.env.PARALLEL !== '' ? Number(process.env.PARALLEL) : raw.parallel ?? 1;
    if (!Number.isInteger(parallel) || parallel < 1 || parallel > 32) fail(process.env.PARALLEL ? 'PARALLEL (environment)' : 'parallel', 'must be a whole number from 1 to 32');
    const flows = raw.flows === undefined ? [] : Array.isArray(raw.flows) ? raw.flows : [raw.flows];
    flows.forEach((g: unknown, i: number) => str(g, Array.isArray(raw.flows) ? `flows[${i}]` : 'flows'));
    if (raw.mail !== undefined && (!raw.mail || typeof raw.mail !== 'object')) fail('mail', 'must be {mailpit: <the address of Mailpit\'s web page>}');

    const args = raw.browser?.args ?? [];
    if ((raw.browser !== undefined && (!raw.browser || typeof raw.browser !== 'object' || Array.isArray(raw.browser))) || !Array.isArray(args) || args.some((a: unknown) => typeof a !== 'string' || !a.startsWith('--')))
        fail('browser', 'must be {args: ["--a-chromium-switch", …]}');

    if (raw.marks !== undefined && typeof raw.marks !== 'boolean') fail('marks', 'must be true or false');
    const marks = ['0', '1'].includes(process.env.MARK ?? '') ? process.env.MARK === '1' : raw.marks === true;

    return { root, baseUrl, app, sides, changes, marks, browser: { args }, gates: gates(raw.gates), routes: str(raw.routes, 'routes', true), stub: stub(raw.stub, root), coverage: coverage(raw.coverage), flows, parallel,
        mail: { mailpit: raw.mail?.mailpit === undefined ? undefined : url(raw.mail.mailpit, 'mail.mailpit') }, audience: str(raw.audience ?? 'a first-time visitor', 'audience')!, context: str(raw.context, 'context', true), expect: expect(raw.expect), jev: { budget, headers },
        i18n: { keys: str(raw.i18n?.keys, 'i18n.keys', true) }, loginPaths: regex(raw.loginPaths, 'loginPaths', '/(login|sign-?in|two-factor|2fa)(/|$)'),
        crawl: { max, skip: regex(c.skip, 'crawl.skip', DEFAULT_SKIP) }, interact: { max: interactMax, submit: it.submit === true },
        audit: { max: auditMax, skip: au.skip === undefined ? undefined : regex(au.skip, 'audit.skip', '') }, design: design(raw.design), security: { csrf, allowedHosts, publicWrites: s.publicWrites === undefined ? undefined : regex(s.publicWrites, 'security.publicWrites', '') }, viewports, out: str(raw.out ?? '.tapcheck', 'out')! };
}

export function load(file = 'tapcheck.yml'): Config {
    if (!existsSync(file)) throw new Error(`No ${file} here. Write one (see examples/) or let the tapcheck-setup skill write it.`);
    let raw;
    try { raw = parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file} is not valid YAML: ${(e as Error).message}`); }
    // The stub's address is known before anything starts, so tapcheck.yml itself can use $TAPCHECK_STUB_URL (in app.start, say).
    if (raw?.stub) process.env.TAPCHECK_STUB_URL = `http://127.0.0.1:${raw.stub.port ?? 8766}`;
    if (raw?.stub?.dns) process.env.TAPCHECK_DNS = `127.0.0.1:${raw.stub.dns.port ?? 8767}`; // the stub's DNS server, as host:port
    return check(expand(raw), dirname(resolve(file)));
}

/** Hosts a reset may run against without allowRemoteReset: this machine, *.localhost and *.test. */
export const isLocal = (u: string) => {
    const h = new URL(u).hostname;
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(h) || h.endsWith('.localhost') || h.endsWith('.test');
};
