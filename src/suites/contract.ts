/*
 * Frontend contract QA, from every request the crawl recorded (measured, no Jev):
 * - nothing answers 5xx; the app's own XHR/fetch calls don't answer 4xx;
 * - a JSON content type always carries JSON that parses, and every response says its content type;
 * - an XHR/fetch call never gets a whole HTML document back (a login or error page served to a script);
 * - XHR/fetch latency: p95 under P95_MS for calls to the app's own host, under REMOTE_P95_MS for calls to its other hosts
 *   (an API at api.<domain>, a network away); fewer than MIN_CALLS calls are too few for a p95 and are only reported;
 * - response shape: the top-level keys of each JSON endpoint (ids in the path normalised; the keys of all its responses in
 *   the run together), the app's own calls being those to its site's hosts (api.<domain> too) against the saved baseline
 *   `contract-<side>.json` in the out folder; a key that disappeared is a breaking change. The first run creates the
 *   baseline, later runs add the endpoints they see for the first time, and CONTRACT_UPDATE=1 rewrites it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { host, site, type Run } from '../browser.ts';
import { run as runCrawl } from './crawl.ts';

export { shape } from './crawl.ts';

const P95_MS = 800, REMOTE_P95_MS = 2000, MIN_CALLS = 20;

/** /reports/01m7azs8…/stats → /reports/{id}/stats, so one endpoint is one contract; a call to another host than `base` (the app's API) is named with its host. */
// ponytail: one to five capital letters (a ticker, a currency or country code: /strikes/SPY) is an id too; compare the calls of a run if a real route is ever spelt that way
export const endpoint = (method: string, url: string, base?: string) => {
    const u = new URL(url);
    return `${method} ${base && u.host !== host(base) ? u.host : ''}${u.pathname.split('/').map((p) => (/^[0-9]+$|^[0-9a-z]{20,}$|^[0-9a-f-]{32,36}$/i.test(p) || /^[A-Z]{1,5}$/.test(p) ? '{id}' : p)).join('/')}`;
};
export async function run(r: Run) {
    const S = 'contract';
    if (!r.crawl.done) await runCrawl(r);
    // The app's own requests: its host, and the other hosts of its site (an API at api.<domain>).
    const own = r.crawl.hits.filter((h) => site(h.url) === site(r.side.baseUrl));
    const calls = own.filter((h) => ['xhr', 'fetch'].includes(h.type));
    const where = (h: { method: string; url: string; page: string; status?: number }) => `${h.status ? `${h.status} ` : ''}${endpoint(h.method, h.url, r.side.baseUrl)} (on ${h.page})`;

    const server = own.filter((h) => h.status >= 500);
    r.record({ suite: S, where: 'all requests', check: 'no 5xx responses', status: server.length ? 'fail' : 'pass',
        detail: server.length ? server.slice(0, 8).map(where).join('; ') : `${own.length} requests` });
    const client = calls.filter((h) => h.status >= 400 && h.status < 500);
    r.record({ suite: S, where: 'XHR/fetch', check: "no 4xx from the app's own calls", status: client.length ? 'fail' : 'pass',
        detail: client.slice(0, 8).map(where).join('; ') || `${calls.length} calls` });
    const badJson = calls.filter((h) => h.json === 'invalid');
    r.record({ suite: S, where: 'XHR/fetch', check: 'JSON responses parse', status: badJson.length ? 'fail' : 'pass', detail: badJson.slice(0, 5).map((h) => endpoint(h.method, h.url, r.side.baseUrl)).join('; ') || undefined });
    const noType = own.filter((h) => !h.contentType && h.status >= 200 && h.status < 300 && h.status !== 204);
    r.record({ suite: S, where: 'all requests', check: 'content type declared', status: noType.length ? 'warn' : 'pass', detail: noType.slice(0, 5).map((h) => endpoint(h.method, h.url, r.side.baseUrl)).join('; ') || undefined });
    const htmlDocs = calls.filter((h) => /text\/html/.test(h.contentType) && /<!doctype html|<html[\s>]/i.test(h.body ?? ''));
    r.record({ suite: S, where: 'XHR/fetch', check: 'no whole HTML documents to scripts', status: htmlDocs.length ? 'fail' : 'pass',
        detail: htmlDocs.slice(0, 5).map((h) => `${endpoint(h.method, h.url, r.side.baseUrl)} (on ${h.page})`).join('; ') || undefined });

    const base = host(r.side.baseUrl);
    for (const remote of [false, true]) {
        const group = calls.filter((h) => (host(h.url) !== base) === remote), times = group.map((h) => h.ms).sort((a, b) => a - b);
        if (remote && !times.length) continue;
        const limit = remote ? REMOTE_P95_MS : P95_MS, to = remote ? ` to ${[...new Set(group.map((h) => host(h.url)))].join(', ')}` : '';
        const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] ?? 0;
        if (times.length < MIN_CALLS) r.record({ suite: S, where: `XHR/fetch${to}`, check: `p95 latency under ${limit} ms`, status: 'info', detail: `too few calls for a p95 (${times.length} call${times.length === 1 ? '' : 's'}, slowest ${times.at(-1) ?? 0} ms)` });
        else r.record({ suite: S, where: `XHR/fetch${to}`, check: `p95 latency under ${limit} ms`, status: p95 < limit ? 'pass' : 'warn', detail: `p95 ${p95} ms over ${times.length} calls${to}` });
    }

    // Response shape against the baseline: per endpoint, the keys of every response of the run together (what an endpoint
    // answers may depend on the query), from the whole body.
    const now: Record<string, string[]> = {};
    for (const h of calls) {
        if (h.json !== 'ok' || h.status >= 300 || !h.keys) continue;
        const ep = endpoint(h.method, h.url, r.side.baseUrl);
        now[ep] = [...new Set([...(now[ep] ?? []), ...h.keys])].sort();
    }
    const file = `${r.cfg.out}/contract-${r.side.name}.json`;
    const had = existsSync(file);
    const was: Record<string, string[]> = had ? JSON.parse(readFileSync(file, 'utf8')) : {};
    if (!had || process.env.CONTRACT_UPDATE === '1') {
        writeFileSync(file, JSON.stringify({ ...was, ...now }, null, 2));
        r.record({ suite: S, where: 'response shapes', check: 'baseline', status: 'info', detail: `${Object.keys(now).length} endpoint shape(s) saved to ${file}` });
        return;
    }
    // A list in some answers and an object in others (it depends on the query): there are no keys to compare.
    const list = (k: string[]) => k.includes('[array]'), both = (k: string[]) => list(k) && k.length > 1;
    for (const [ep, keys] of Object.entries(now)) {
        const old = was[ep];
        if (!old) r.record({ suite: S, where: ep, check: 'response shape', status: 'info', detail: `new endpoint, added to the baseline: ${keys.join(', ')}` });
        else if (both(old) || both(keys)) r.record({ suite: S, where: ep, check: 'response shape', status: 'info', detail: 'answers a list to some calls and an object to others: not compared' });
        else if (list(old) !== list(keys)) r.record({ suite: S, where: ep, check: 'response shape', status: 'warn', detail: `was ${list(old) ? 'a list' : 'an object'}, now ${list(keys) ? 'a list' : 'an object'}: a breaking change unless it depends on the query (CONTRACT_UPDATE=1 saves what it answers now)` });
        else {
            const gone = old.filter((k) => !keys.includes(k)), added = keys.filter((k) => !old.includes(k));
            r.record({ suite: S, where: ep, check: 'response shape', status: gone.length ? 'fail' : 'pass',
                detail: [gone.length ? `removed: ${gone.join(', ')}` : '', added.length ? `added: ${added.join(', ')}` : ''].filter(Boolean).join(' · ') || undefined });
        }
    }
    // Endpoints seen for the first time join the baseline; one already in it keeps its keys.
    if (Object.keys(now).some((ep) => !was[ep])) writeFileSync(file, JSON.stringify({ ...now, ...was }, null, 2));
}
