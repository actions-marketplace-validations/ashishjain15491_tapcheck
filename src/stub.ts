/*
 * The stub: one small HTTP server standing in for every outside service the app calls (payment, mail, AI and other
 * providers, webhook targets), so a run never reaches a real one. tapcheck starts it before the app when tapcheck.yml has
 * `stub:`, and hands its address to the app's start command and the gates as TAPCHECK_STUB_URL.
 *
 * Which outside host a request was meant for, first that applies:
 *   1. the X-Forwarded-Host header;
 *   2. the Host header, when it isn't the stub's own (a proxy or a hosts-file entry sent it here);
 *   3. a first path segment with a dot in it: /api.example.com/v1/x is host api.example.com, path /v1/x.
 * So the simplest wiring is to point each provider's base URL at ${TAPCHECK_STUB_URL}/<its host>.
 *
 * The answer, first that applies:
 *   1. a failure switched on through the control API (below);
 *   2. 500 for any request with "tapcheck-fail" in its URL or body (a failure a flow can trigger with plain test data);
 *   3. a one-off reply queued through the control API;
 *   4. the first of stub.rules that matches host (or a parent domain), method and path;
 *   5. 200 {} (so anything can be a webhook target).
 *
 * Control API, on the stub's own host (flows use it through t.stub):
 *   GET    /_tapcheck/requests?host=&path=&since=   requests seen, oldest first (path: a part of it; since: ms timestamp)
 *   DELETE /_tapcheck/requests                      forget them
 *   POST   /_tapcheck/fail  {host, path?, status?, body?, times?}   fail the next `times` matching requests (default 1; 0 = until cleared)
 *   DELETE /_tapcheck/fail                          clear the failures
 *   POST   /_tapcheck/reply {host, path?, status?, json? | body?}   answer the next matching request with this, once
 *   DELETE /_tapcheck/reply                         clear the queued replies
 * Every request is also appended to <out>/stub-requests.jsonl (sign-in headers left out).
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { matchesGlob, resolve } from 'node:path';
import type { Config, StubRule } from './config.ts';

export type Seen = { t: number; method: string; host: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: unknown; status: number; ms: number };
export type FailRule = { host?: string; path?: string; status?: number; body?: unknown; times?: number };
export type Reply = { host?: string; path?: string; status?: number; json?: unknown; body?: string };

const OWN = ['127.0.0.1', 'localhost', '[::1]'];
const SECRET = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/;
const TYPES: Record<string, string> = { json: 'application/json', html: 'text/html; charset=utf-8', xml: 'application/xml', txt: 'text/plain; charset=utf-8' };

/** The outside host a request was meant for ('' when it is for the stub itself) and its path there. */
export function target(headers: IncomingHttpHeaders, path: string, port: number): { host: string; path: string } {
    const name = (h: string) => h.trim().toLowerCase().replace(/:\d+$/, '');
    const fwd = String(headers['x-forwarded-host'] ?? '').split(',')[0];
    if (fwd.trim()) return { host: name(fwd), path };
    const h = headers.host ?? '';
    if (h && !(OWN.includes(name(h)) && (h.match(/:(\d+)$/)?.[1] ?? '80') === String(port))) return { host: name(h), path };
    const m = path.match(/^\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*)(\/.*)?$/i); // shaped like a host name, so /v1.2/x isn't one
    return m ? { host: m[1].toLowerCase(), path: m[2] ?? '/' } : { host: '', path };
}

const onHost = (want: string | undefined, host: string) => !want || host === want || host.endsWith(`.${want}`);
/** The first rule matching the request. */
export const match = (rules: StubRule[], host: string, method: string, path: string) => rules.find((r) => onHost(r.host, host)
    && (!r.method || r.method === method) && (!r.path || (r.path.startsWith('^') ? new RegExp(r.path).test(path) : matchesGlob(path, r.path))));

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    const raw = typeof body === 'string' || Buffer.isBuffer(body);
    res.writeHead(status, { 'content-type': raw ? TYPES.txt : TYPES.json, ...headers }).end(raw ? body : JSON.stringify(body));
    return status;
}

/** Starts the stub on 127.0.0.1; `out` is where stub-requests.jsonl goes, `root` what rule files are relative to. */
export async function start(cfg: NonNullable<Config['stub']>, out: string, root = process.cwd()) {
    const log: Seen[] = [], fails: FailRule[] = [], replies: Reply[] = [];
    const file = `${out}/stub-requests.jsonl`;
    mkdirSync(out, { recursive: true });
    writeFileSync(file, '');
    let port = cfg.port;

    function control(method: string, path: string, q: URLSearchParams, body: any, res: ServerResponse) {
        const list = path === '/_tapcheck/fail' ? fails : path === '/_tapcheck/reply' ? replies : path === '/_tapcheck/requests' ? log : null;
        if (!list) return send(res, 404, { error: 'tapcheck stub: no such control path' });
        if (method === 'DELETE') { list.length = 0; return send(res, 200, { ok: true }); }
        if (list === log) {
            const since = Number(q.get('since') ?? 0), part = q.get('path');
            return send(res, 200, log.filter((s) => s.t >= since && onHost(q.get('host')?.toLowerCase(), s.host) && (!part || s.path.includes(part))));
        }
        if (method !== 'POST' || !body || typeof body !== 'object') return send(res, 400, { error: 'tapcheck stub: POST a JSON object' });
        (list as unknown[]).push(list === fails ? { ...body, times: body.times ?? 1 } : body);
        return send(res, 200, { ok: true });
    }

    /** Takes the first entry matching host and path (a part of it) out of a queue; a fail rule stays until its `times` are used. */
    function take<R extends FailRule | Reply>(list: R[], host: string, path: string): R | undefined {
        const i = list.findIndex((r) => onHost(r.host?.toLowerCase(), host) && (!r.path || path.includes(r.path)));
        if (i < 0) return undefined;
        const r = list[i] as R & { times?: number };
        if (r.times === undefined || (r.times > 0 && --r.times === 0)) list.splice(i, 1);
        return r;
    }

    const server = createServer(async (req, res) => {
        const t = Date.now();
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c);
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = text;
        if (/json/.test(req.headers['content-type'] ?? '')) { try { body = JSON.parse(text); } catch { /* kept as text */ } }
        const u = new URL(req.url ?? '/', 'http://stub');
        const { host, path } = target(req.headers, u.pathname, port);
        const method = req.method ?? 'GET';
        if (!host && path.startsWith('/_tapcheck/')) { control(method, path, u.searchParams, body, res); return; } // not logged

        let status: number;
        const fail = take(fails, host, path);
        const forced = !!fail || /tapcheck-fail/i.test(req.url + text);
        const reply = forced ? undefined : take(replies, host, path);
        if (forced) status = send(res, fail?.status ?? 500, fail?.body ?? { error: 'tapcheck stub: forced failure' });
        else if (reply) status = send(res, reply.status ?? 200, reply.body ?? reply.json ?? {});
        else {
            const r = match(cfg.rules, host, method, path);
            if (r?.delayMs) await new Promise((done) => setTimeout(done, r.delayMs));
            const type = r?.file ? { 'content-type': TYPES[r.file.split('.').pop()!] ?? 'application/octet-stream' } : {};
            status = send(res, r?.status ?? 200, r?.file ? readFileSync(resolve(root, r.file)) : r?.body ?? r?.json ?? {}, { ...type, ...r?.headers });
        }
        const seen: Seen = { t, method, host, path, query: Object.fromEntries(u.searchParams), body: typeof body === 'string' ? body.slice(0, 65_536) : body, status, ms: Date.now() - t,
            headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !SECRET.test(k)).map(([k, v]) => [k, String(v)])) };
        log.push(seen);
        if (log.length > 5000) log.shift();
        appendFileSync(file, JSON.stringify(seen) + '\n');
    });
    await new Promise<void>((done, failed) => {
        server.once('error', (e) => failed(new Error(`The stub can't listen on 127.0.0.1:${cfg.port} (stub.port): ${e.message}`)));
        server.listen(cfg.port, '127.0.0.1', done);
    });
    port = (server.address() as AddressInfo).port;
    return { url: `http://127.0.0.1:${port}`, stop: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }) };
}
