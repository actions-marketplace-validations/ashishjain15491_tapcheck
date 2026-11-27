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
// Noul: above 0.7 is yes, below 0.3 is no, between is unsure. A Score's position 0–4 maps to 1–10: 7 or more passes,
// under FAIL_SCORE fails, and between is a warning (a near miss is a judgement call, not a defect). A check whose scale
// puts "fine" lower gives scoreStatus its own two marks.
export const YES = 0.7, NO = 0.3, MIN_SCORE = 7, FAIL_SCORE = 5.5;
export type Verdict = 'pass' | 'FAIL' | 'unsure';
export const good = (p: number): Verdict => (p > YES ? 'pass' : p < NO ? 'FAIL' : 'unsure'); // yes is good
export const bad = (p: number): Verdict => (p < NO ? 'pass' : p > YES ? 'FAIL' : 'unsure'); // yes is a defect
export const to10 = (pos: number) => Math.round((1 + (pos * 9) / 4) * 10) / 10;
/** A Score's status: 7 or more passes; a near miss (from FAIL_SCORE), or a low score Jev was split on, is a warning. */
export const scoreStatus = (v: number, confidence: number, split = 0.3, pass = MIN_SCORE, fail = FAIL_SCORE): Finding['status'] => (v >= pass ? 'pass' : v >= fail || confidence < split ? 'warn' : 'fail');
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

let opts: Config['jev'] & { context?: string } = { budget: 1, headers: {} };
let client: Client | null = null;
let tokens = 0, calls = 0, cached = 0, ms = 0;
export const payloads: unknown[] = [];
/** "<run dir> <screen>": the screens audit asked the VISUAL questions of at the desktop viewport, so ux needn't ask again. */
export const looked = new Set<string>();
const memo = new Map<string, any>();

/** Starts a run: its budget and headers, counters and memo cleared. A self-check passes a fake client; nothing then reaches the network. */
export function setup(jev: Config['jev'] & { context?: string }, fake?: Client) {
    opts = jev;
    client = fake ?? null;
    tokens = calls = cached = ms = 0;
    payloads.length = 0;
    memo.clear();
}

/** One Jev request. `images` are the files behind the images in `state`: they key the memo and stand in for the bytes in the log. */
export async function ask(label: string, state: unknown, questions: Record<string, any>, images: string[], model?: string): Promise<any> {
    // tapcheck.yml's context: the kind of product, so every judgment is made against what its users expect.
    // Only a plain record of fields: a request whose state is the image itself (predicted attention) is left as it is.
    if (opts.context && state && Object.getPrototypeOf(state) === Object.prototype) state = { product: opts.context, ...state };
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

// ───────────────────────────── Details a person can act on ─────────────────────────────
type Q = { instructions?: unknown; criteria?: unknown };
/** A question as a person reads it: its first sentence, with the request's field names put as words. */
export const asked = (q: Q) => { const t = String(q.instructions ?? ''); return (t.match(/^.*?\?(?=\s|$)/)?.[0] ?? t).replace(/`(\w+)`/g, 'the $1'); };
/** A yes-or-no answer in words: the question, Jev's lean, and (`full`, for a fail or warning) what that answer means.
 * An unsure answer (between NO and YES) with `bad`, the answer that is the defect, says what to look for instead. */
export function sayNoul(q: Q, p: number, full = true, bad?: boolean) {
    const yes = p >= 0.5, criteria = q.criteria as Record<string, string> | undefined;
    if (full && bad !== undefined && p > NO && p < YES)
        return `"${asked(q)}" Jev is unsure (yes ${Math.round(p * 100)}%)${criteria ? `. Look for: ${criteria[String(bad)]}` : ''}`;
    const means = full && criteria?.[yes ? 'true' : 'false'];
    return `"${asked(q)}" Jev: ${yes ? 'yes' : 'no'} (${Math.round((yes ? p : 1 - p) * 100)}% sure)${means ? `. ${yes ? 'Yes' : 'No'} means: ${means}` : ''}`;
}
/** A score in words: the question and (`full`) the description of the level the score is nearest to. */
export function sayScore(q: Q, a: { score: number; confidence: number }, full = true) {
    const levels = Array.isArray(q.criteria) && full ? q.criteria : [], i = Math.max(0, Math.min(levels.length - 1, Math.round(a.score)));
    return `${to10(a.score)}/10 (confidence ${a.confidence.toFixed(2)}) for "${asked(q)}"${levels.length ? ` Nearest level (${i + 1} of ${levels.length}): ${levels[i]}` : ''}`;
}
/** A choice in words: what Jev picked, with its description, and how sure it was. */
export function sayChoice(q: Q, a: { choice: string; probabilities?: Record<string, number> }) {
    const p = a.probabilities?.[a.choice], means = (q.criteria as Record<string, string> | undefined)?.[a.choice];
    return `"${asked(q)}" Jev: ${a.choice.replace(/_/g, ' ')}${p === undefined ? '' : ` (${Math.round(p * 100)}%)`}${means ? `: ${means}` : ''}`;
}
