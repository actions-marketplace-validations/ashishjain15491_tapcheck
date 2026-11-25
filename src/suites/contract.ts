/*
 * Frontend contract QA, from every request the crawl recorded (measured, no Jev):
 * - nothing answers 5xx; the app's own XHR/fetch calls don't answer 4xx;
 * - a JSON content type always carries JSON that parses, and every response says its content type;
 * - an XHR/fetch call never gets a whole HTML document back (a login or error page served to a script);
 * - XHR/fetch latency: p95 under P95_MS;
 * - response shape: the top-level keys of each JSON endpoint (ids in the path normalised) against the saved baseline
 *   `contract-<side>.json` in the out folder; a key that disappeared is a breaking change. CONTRACT_UPDATE=1 rewrites
 *   the baseline; the first run creates it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { host, type Run } from '../browser.ts';
import { run as runCrawl } from './crawl.ts';

const P95_MS = 800;

/** /reports/01m7azs8…/stats → /reports/{id}/stats, so one endpoint is one contract. */
export const endpoint = (method: string, url: string) => {
    const u = new URL(url);
    return `${method} ${u.pathname.split('/').map((p) => (/^[0-9]+$|^[0-9a-z]{20,}$|^[0-9a-f-]{32,36}$/i.test(p) ? '{id}' : p)).join('/')}`;
};
export function shape(body: string): string[] | null {
    try {
        const j = JSON.parse(body);
        return Array.isArray(j) ? ['[array]'] : j && typeof j === 'object' ? Object.keys(j).sort() : null;
    } catch { return null; }
}

export async function run(r: Run) {
    const S = 'contract';
    if (!r.crawl.done) await runCrawl(r);
    const own = r.crawl.hits.filter((h) => host(h.url) === host(r.side.baseUrl));
    const calls = own.filter((h) => ['xhr', 'fetch'].includes(h.type));
    const where = (h: { method: string; url: string; page: string; status?: number }) => `${h.status ? `${h.status} ` : ''}${endpoint(h.method, h.url)} (on ${h.page})`;

    const server = own.filter((h) => h.status >= 500);
    r.record({ suite: S, where: 'all requests', check: 'no 5xx responses', status: server.length ? 'fail' : 'pass',
        detail: server.length ? server.slice(0, 8).map(where).join('; ') : `${own.length} requests` });
    const client = calls.filter((h) => h.status >= 400 && h.status < 500);
    r.record({ suite: S, where: 'XHR/fetch', check: "no 4xx from the app's own calls", status: client.length ? 'fail' : 'pass',
        detail: client.slice(0, 8).map(where).join('; ') || `${calls.length} calls` });
    const badJson = calls.filter((h) => h.json === 'invalid');
    r.record({ suite: S, where: 'XHR/fetch', check: 'JSON responses parse', status: badJson.length ? 'fail' : 'pass', detail: badJson.slice(0, 5).map((h) => endpoint(h.method, h.url)).join('; ') || undefined });
    const noType = own.filter((h) => !h.contentType && h.status >= 200 && h.status < 300 && h.status !== 204);
    r.record({ suite: S, where: 'all requests', check: 'content type declared', status: noType.length ? 'warn' : 'pass', detail: noType.slice(0, 5).map((h) => endpoint(h.method, h.url)).join('; ') || undefined });
    const htmlDocs = calls.filter((h) => /text\/html/.test(h.contentType) && /<!doctype html|<html[\s>]/i.test(h.body ?? ''));
    r.record({ suite: S, where: 'XHR/fetch', check: 'no whole HTML documents to scripts', status: htmlDocs.length ? 'fail' : 'pass',
        detail: htmlDocs.slice(0, 5).map((h) => `${endpoint(h.method, h.url)} (on ${h.page})`).join('; ') || undefined });

    const times = calls.map((h) => h.ms).sort((a, b) => a - b);
    const p95 = times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] : 0;
    r.record({ suite: S, where: 'XHR/fetch', check: `p95 latency under ${P95_MS} ms`, status: p95 < P95_MS ? 'pass' : 'warn', detail: `p95 ${p95} ms over ${times.length} calls` });

    // Response shape against the baseline. Bodies are kept to 400 characters, so longer ones would give partial keys.
    const now: Record<string, string[]> = {};
    for (const h of calls) {
        if (h.json !== 'ok' || h.status >= 300 || (h.body?.length ?? 0) >= 400) continue;
        const keys = shape(h.body ?? '');
        if (keys) now[endpoint(h.method, h.url)] = keys;
    }
    const file = `${r.cfg.out}/contract-${r.side.name}.json`;
    const had = existsSync(file);
    const base: Record<string, string[]> = had ? JSON.parse(readFileSync(file, 'utf8')) : {};
    if (!had || process.env.CONTRACT_UPDATE === '1') {
        writeFileSync(file, JSON.stringify({ ...base, ...now }, null, 2));
        r.record({ suite: S, where: 'response shapes', check: 'baseline', status: 'info', detail: `${Object.keys(now).length} endpoint shape(s) saved to ${file}` });
        return;
    }
    for (const [ep, keys] of Object.entries(now)) {
        const was = base[ep];
        if (!was) { r.record({ suite: S, where: ep, check: 'response shape', status: 'info', detail: `new endpoint: ${keys.join(', ')}` }); continue; }
        const gone = was.filter((k) => !keys.includes(k)), added = keys.filter((k) => !was.includes(k));
        r.record({ suite: S, where: ep, check: 'response shape', status: gone.length ? 'fail' : 'pass',
            detail: [gone.length ? `removed: ${gone.join(', ')}` : '', added.length ? `added: ${added.join(', ')}` : ''].filter(Boolean).join(' · ') || undefined });
    }
}
