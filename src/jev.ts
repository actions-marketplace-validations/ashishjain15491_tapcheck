/*
 * The Jev client the ux, usability and audit suites share: one request function with a memo (the same images, state and
 * questions are answered once), a budget that stops the run before it overspends, a log of every payload so any answer
 * can be rerun, and the rules that turn Jev's probabilities and scores into verdicts. Decisions stay in code.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { image, TypeSafeClient } from '@typesafe-ai/sdk';
import type { Config } from './config.ts';
import type { Finding } from './report.ts';

// ───────────────────────────── verdict rules ─────────────────────────────
// Noul: above 0.7 is yes, below 0.3 is no, between is unsure. A Score's position 0–4 maps to 1–10; under 7 is flagged.
export const YES = 0.7, NO = 0.3, MIN_SCORE = 7;
export type Verdict = 'pass' | 'FAIL' | 'unsure';
export const good = (p: number): Verdict => (p > YES ? 'pass' : p < NO ? 'FAIL' : 'unsure'); // yes is good
export const bad = (p: number): Verdict => (p < NO ? 'pass' : p > YES ? 'FAIL' : 'unsure'); // yes is a defect
export const to10 = (pos: number) => Math.round((1 + (pos * 9) / 4) * 10) / 10;
/** Verdict → finding status: an unsure Jev answer is a warning for a person to look at, never a pass. */
export const status = (v: Verdict): Finding['status'] => (v === 'pass' ? 'pass' : v === 'FAIL' ? 'fail' : 'warn');

// ───────────────────────────── client ─────────────────────────────
const USD_PER_TOKEN = 0.042 / 1_000_000; // Jev input price; output tokens are free
// Image support is an opt-in in the SDK (its README, "Images"): this header turns it on. jev.headers is merged over it.
const IMAGES = { 'TypeSafe-Danger-Zone-Images': 'true' };

/** The part of the TypeSafe client this file uses, so a self-check can put a fake in its place. */
export type Client = { systemOne(req: { state: any; questions: Record<string, any>; model?: string }): Promise<{ answers: any; usage: { input_tokens: number | null } }> };
export class BudgetReached extends Error {}
/** Jev failed or didn't answer twice: the caller may carry on without its answers. */
export class Unavailable extends Error {}

/** The key from the environment, else from a TYPESAFE_API_KEY= line in ./.env; undefined when there is none. */
export function apiKey(): string | undefined {
    if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
    const line = existsSync('.env') ? readFileSync('.env', 'utf8').split('\n').find((l) => l.startsWith('TYPESAFE_API_KEY=')) : undefined;
    return line?.slice('TYPESAFE_API_KEY='.length).trim().replace(/^["']|["']$/g, '') || undefined;
}

/** Why Jev isn't asked in this run ('JEV=off', no key), or '' when it is. */
export const whyOff = () => (process.env.JEV === 'off' ? 'JEV=off' : client || apiKey() ? '' : 'no TYPESAFE_API_KEY');

let opts: Config['jev'] = { budget: 1, headers: {} };
let client: Client | null = null;
let tokens = 0, calls = 0, cached = 0, ms = 0;
export const payloads: unknown[] = [];
const memo = new Map<string, any>();

/** Starts a run: its budget and headers, counters and memo cleared. A self-check passes a fake client; nothing then reaches the network. */
export function setup(jev: Config['jev'], fake?: Client) {
    opts = jev;
    client = fake ?? null;
    tokens = calls = cached = ms = 0;
    payloads.length = 0;
    memo.clear();
}

/** One Jev request. `images` are the files behind the images in `state`: they key the memo and stand in for the bytes in the log. */
export async function ask(label: string, state: unknown, questions: Record<string, any>, images: string[], model?: string): Promise<any> {
    const shown = JSON.parse(JSON.stringify(state)); // the SDK writes each image as a short "<image:…>" name here, never its bytes
    const hash = createHash('sha256').update(JSON.stringify([model, shown, questions]));
    for (const f of images) hash.update(readFileSync(f));
    const key = hash.digest('hex');
    if (memo.has(key)) { cached++; payloads.push({ label, cached: true, images }); return memo.get(key); }
    if (spent() >= opts.budget) throw new BudgetReached(`Jev budget of $${opts.budget} reached (raise jev.budget or JEV_BUDGET)`);
    if (!client) {
        const key = apiKey();
        if (!key) throw new Error('TYPESAFE_API_KEY is not set (environment, or a TYPESAFE_API_KEY= line in .env here).');
        client = new TypeSafeClient({ apiKey: key, defaultHeaders: { ...IMAGES, ...opts.headers } });
    }
    const t0 = Date.now();
    // A request that hangs or fails is tried once more; a second failure is the caller's to report.
    const once = () => {
        let timer: NodeJS.Timeout | undefined;
        const cap = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error('Jev did not answer within 120 s')), 120_000); });
        return Promise.race([client!.systemOne({ state, questions, ...(model ? { model } : {}) }), cap]).finally(() => clearTimeout(timer));
    };
    const r = await once().catch(async () => { await new Promise((done) => setTimeout(done, 2000)); return once(); })
        .catch((e: Error) => { throw new Unavailable(String(e?.message ?? e)); });
    const took = Date.now() - t0;
    calls++; ms += took;
    tokens += r.usage.input_tokens ?? 0;
    payloads.push({ label, model: model ?? 'default', ms: took, input_tokens: r.usage.input_tokens, state: shown, images, questions });
    memo.set(key, r.answers);
    return r.answers;
}
export const img = (file: string) => image(readFileSync(file));
export const spent = () => tokens * USD_PER_TOKEN;
export const usage = () => ({ tokens, usd: Math.round(spent() * 10000) / 10000, budget: opts.budget, calls, cached, avgMs: calls ? Math.round(ms / calls) : 0 });
/** Every request of the run, as sent (images as file paths; the key and headers are not part of it). */
export const savePayloads = (dir: string) => writeFileSync(`${dir}/payloads.json`, JSON.stringify(payloads, null, 2));
