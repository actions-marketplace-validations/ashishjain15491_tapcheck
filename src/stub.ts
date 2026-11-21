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
 *   POST   /_tapcheck/dns   {name, type, values}                    answer that DNS question with these values (null: back to the config)
 *   DELETE /_tapcheck/dns                           forget those
 * Every request is also appended to <out>/stub-requests.jsonl (sign-in headers left out).
 *
 * DNS: with `stub.dns`, the same process answers DNS questions over UDP (its address is TAPCHECK_DNS, host:port), so an
 * app that verifies domains can be pointed at it instead of a real resolver. The answer, first that applies: an override
 * set through the control API; no such name (NXDOMAIN) for a name containing "tapcheck-fail"; the `records` for that name
 * and type; `defaultA` for an A question; else no records. Only A, AAAA, MX, TXT, CNAME and NS, one question per message,
 * UDP only. Each question is logged like a request: method DNS, host the name, path the type, status the DNS rcode.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createSocket } from 'node:dgram';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { matchesGlob, resolve } from 'node:path';
import { DNS_TYPES, dnsValue, type Config, type StubRule } from './config.ts';

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

// ── DNS: just enough of RFC 1035 to answer one question with records of the six types ──
const QTYPE: Record<number, string> = { 1: 'A', 2: 'NS', 5: 'CNAME', 15: 'MX', 16: 'TXT', 28: 'AAAA' };
const encName = (n: string) => Buffer.concat([...n.replace(/\.$/, '').split('.').filter(Boolean).map((l) => Buffer.concat([Buffer.from([Buffer.byteLength(l)]), Buffer.from(l)])), Buffer.from([0])]);
function rdata(type: string, v: string): Buffer {
    if (type === 'A') return Buffer.from(v.split('.').map(Number));
    if (type === 'AAAA') { // hex groups, with at most one :: standing for the zero groups left out
        const [head, tail] = v.split('::').map((x) => (x ? x.split(':') : []));
        const groups = tail ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head;
        return Buffer.from(groups.flatMap((g) => { const n = parseInt(g, 16); return [n >> 8, n & 255]; }));
    }
    if (type === 'MX') { const [, pri, name] = v.match(/^(?:(\d+)\s+)?(\S+)$/)!; const b = Buffer.alloc(2); b.writeUInt16BE(Number(pri ?? 10)); return Buffer.concat([b, encName(name)]); }
    if (type === 'TXT') { // character strings of at most 255 bytes each
        const s = Buffer.from(v), parts: Buffer[] = [];
        for (let i = 0; i < s.length || i === 0; i += 255) { const c = s.subarray(i, i + 255); parts.push(Buffer.from([c.length]), c); }
        return Buffer.concat(parts);
    }
    return encName(v); // CNAME, NS
}
/** The question in a DNS message (lower-cased name, type by name or ''), or null when it isn't a plain query. */
export function dnsQuestion(msg: Buffer): { name: string; type: string; end: number } | null {
    if (msg.length < 17 || msg[2] & 0xf8 || msg.readUInt16BE(4) !== 1) return null; // a response, another opcode, or not one question
    const labels: string[] = [];
    let off = 12;
    while (msg[off]) { if (msg[off] > 63 || off + msg[off] + 5 >= msg.length) return null; labels.push(msg.subarray(off + 1, off + 1 + msg[off]).toString()); off += msg[off] + 1; }
    return { name: labels.join('.').toLowerCase(), type: QTYPE[msg.readUInt16BE(off + 1)] ?? '', end: off + 5 };
}
/** The reply to `msg`: its question, then one record per value (the name is a pointer back to the question). */
export function dnsReply(msg: Buffer, q: { type: string; end: number }, values: string[], rcode = 0): Buffer {
    const head = Buffer.alloc(12);
    head.writeUInt16BE(msg.readUInt16BE(0), 0); head.writeUInt16BE(0x8180 | rcode, 2); head.writeUInt16BE(1, 4); head.writeUInt16BE(values.length, 6);
    return Buffer.concat([head, msg.subarray(12, q.end), ...values.map((v) => {
        const d = rdata(q.type, v), h = Buffer.alloc(12);
        h.writeUInt16BE(0xc00c, 0); h.writeUInt16BE(msg.readUInt16BE(q.end - 4), 2); h.writeUInt16BE(1, 4); h.writeUInt16BE(d.length, 10); // TTL 0 (the zeroes at 6): never cached, so an override shows at once
        return Buffer.concat([h, d]);
    })]);
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    const raw = typeof body === 'string' || Buffer.isBuffer(body);
    res.writeHead(status, { 'content-type': raw ? TYPES.txt : TYPES.json, ...headers }).end(raw ? body : JSON.stringify(body));
    return status;
}

/** Starts the stub on 127.0.0.1; `out` is where stub-requests.jsonl goes, `root` what rule files are relative to. */
export async function start(cfg: NonNullable<Config['stub']>, out: string, root = process.cwd()) {
    const log: Seen[] = [], fails: FailRule[] = [], replies: Reply[] = [];
    const dnsOver = new Map<string, string[]>(); // "name|TYPE" → values, set through the control API
    const file = `${out}/stub-requests.jsonl`;
    mkdirSync(out, { recursive: true });
    writeFileSync(file, '');
    let port = cfg.port;

    function control(method: string, path: string, q: URLSearchParams, body: any, res: ServerResponse) {
        if (path === '/_tapcheck/dns') {
            if (method === 'DELETE') { dnsOver.clear(); return send(res, 200, { ok: true }); }
            if (!cfg.dns) return send(res, 400, { error: 'tapcheck stub: tapcheck.yml has no stub.dns' });
            const type = String(body?.type ?? '').toUpperCase(), key = `${String(body?.name ?? '').toLowerCase().replace(/\.$/, '')}|${type}`;
            const ok = method === 'POST' && body?.name && (DNS_TYPES as readonly string[]).includes(type) && (body.values === null || (Array.isArray(body.values) && body.values.every((x: unknown) => dnsValue(type, x))));
            if (!ok) return send(res, 400, { error: `tapcheck stub: POST {name, type (${DNS_TYPES.join(', ')}), values: [..] or null}` });
            if (body.values === null) dnsOver.delete(key); else dnsOver.set(key, body.values);
            return send(res, 200, { ok: true });
        }
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
            const type: Record<string, string> = r?.file ? { 'content-type': TYPES[r.file.split('.').pop()!] ?? 'application/octet-stream' } : {};
            status = send(res, r?.status ?? 200, r?.file ? readFileSync(resolve(root, r.file)) : r?.body ?? r?.json ?? {}, { ...type, ...r?.headers });
        }
        const seen: Seen = { t, method, host, path, query: Object.fromEntries(u.searchParams), body: typeof body === 'string' ? body.slice(0, 65_536) : body, status, ms: Date.now() - t,
            headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !SECRET.test(k)).map(([k, v]) => [k, String(v)])) };
        keep(seen);
    });
    function keep(seen: Seen) {
        log.push(seen);
        if (log.length > 5000) log.shift();
        appendFileSync(file, JSON.stringify(seen) + '\n');
    }
    await new Promise<void>((done, failed) => {
        server.once('error', (e) => failed(new Error(`The stub can't listen on 127.0.0.1:${cfg.port} (stub.port): ${e.message}`)));
        server.listen(cfg.port, '127.0.0.1', done);
    });
    port = (server.address() as AddressInfo).port;

    const d = cfg.dns, udp = d ? createSocket('udp4') : null;
    if (d && udp) {
        udp.on('message', (msg, from) => {
            const q = dnsQuestion(msg);
            if (!q) return;
            const over = dnsOver.get(`${q.name}|${q.type}`), gone = !over && q.name.includes('tapcheck-fail');
            const values = over ?? (gone || !q.type ? [] : d.records.filter((r) => r.name === q.name && r.type === q.type).flatMap((r) => r.values));
            if (!over && !gone && !values.length && q.type === 'A' && d.defaultA) values.push(d.defaultA);
            udp.send(dnsReply(msg, q, values, gone ? 3 : 0), from.port, from.address);
            keep({ t: Date.now(), method: 'DNS', host: q.name, path: q.type, query: {}, headers: {}, body: values, status: gone ? 3 : 0, ms: 0 });
        });
        await new Promise<void>((done, failed) => {
            udp.once('error', (e) => { server.close(); failed(new Error(`The stub's DNS can't listen on 127.0.0.1:${d.port} (stub.dns.port): ${e.message}`)); });
            udp.bind(d.port, '127.0.0.1', done);
        });
    }
    return { url: `http://127.0.0.1:${port}`, dns: udp ? `127.0.0.1:${udp.address().port}` : undefined,
        stop: () => new Promise<void>((done) => { udp?.close(); server.closeAllConnections(); server.close(() => done()); }) };
}
