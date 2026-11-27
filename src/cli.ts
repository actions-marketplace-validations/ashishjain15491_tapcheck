#!/usr/bin/env node
/*
 * tapcheck: start (or find) the app, sign in each side, run the suites, write one report.
 *
 * Every suite on every side is a part, named <suite>-<side> (crawl-public, ux-customer), tagged with its suite, its
 * side, and jev (ux, usability) or measured (crawl, contract, security, a11y, interact, audit). Two more kinds of part:
 *   code          the project's own gates (`gates:`) and the route sign-in check (`routes:`); tags code, measured. It has
 *                 no side: a run of only `code` starts no app and no browser.
 *   flow-<name>   each custom flow (`flows:`, see src/flow.ts) on its side; tags flow, its side, measured, and verify
 *                 when it checks a release item (`item`): the report then opens with "Release verification".
 * With `stub:` in tapcheck.yml, a stub server (src/stub.ts) stands in for the outside services the app calls; it starts
 * before the app, and its address is TAPCHECK_STUB_URL for app.start, the gates and tapcheck.yml itself (with `stub.dns`
 * it answers DNS too, at TAPCHECK_DNS).
 *
 *   tapcheck                        every part, with ./tapcheck.yml
 *   ONLY=crawl,a11y tapcheck        only these parts: part names or tags, comma-separated; a trailing * matches name prefixes
 *   ONLY=customer SKIP=jev tapcheck SKIP takes parts out again (contract, security and interact still bring their side's crawl)
 *   CHANGED=1 tapcheck              of the chosen parts, only those whose files changed since each last passed (needs git;
 *                                   `changes:` in tapcheck.yml says which files count for which part or suite)
 *   CHANGED=origin/main tapcheck    the same, but files changed since the branch point with that git ref: QA for a pull
 *                                   request's own changes, with no state from earlier runs
 *   PARALLEL=4 tapcheck             run up to 4 flows of a side at once (default `parallel` in tapcheck.yml, or 1); a flow
 *                                   with `serial: true` runs alone; the suites still run one by one
 *   LIST=1 tapcheck                 print the parts and their tags, mark what would run, and exit
 *   JEV=off tapcheck                skip the suites Jev judges (ux, usability) and audit's Jev looks; also skipped when there is no key
 *   JEV_BUDGET=0.5 tapcheck         the most to spend on Jev this run, in USD (default jev.budget, or 1)
 *   RESET=1 tapcheck                run app.reset first (refused unless the app is local or allowRemoteReset is set); with
 *                                   app.resetWhen it also runs by itself when a matching file changed since the last reset
 *   HEADED=1 tapcheck               a visible browser instead of a headless one; SLOWMO=150 waits that many ms between its
 *                                   actions; START_DELAY=10 counts down that many seconds before the first one
 *   RECORD=1 tapcheck               a video and a Playwright trace of every browser context, per side under videos/ and
 *                                   traces/, linked from the report (open a trace with npx playwright show-trace <file>)
 *   MARK=1 tapcheck                 marked screenshots (default `marks` in tapcheck.yml): a fail's or warning's evidence opens
 *                                   with the screen as it was, a banner saying the check, and a box and a note on each element
 *                                   the check knows; what Jev judged gets the banner alone
 *   COVERAGE=1 tapcheck             no run: merge the hits.json of every run so far into COVERAGE.md (coverage.file): each
 *                                   route of `routes:` with the part that reached it or GAP, and the dialogs and tables seen
 *   LOGIN=1 tapcheck                sign in again by hand on manual sides
 *   DEVICES=desktop,tablet tapcheck only these kinds of device (default `devices` in tapcheck.yml, or all): desktop,
 *                                   tablet, mobile; the viewports and audit's sizes of the others are left out
 *   TAPCHECK_CONFIG=path tapcheck   another config file
 *
 * ux, usability and audit ask Jev (TypeSafe): put TYPESAFE_API_KEY in the environment, or in a .env file next to tapcheck.yml.
 *
 * Output: <out>/run-<time>/report.html (open it), REPORT.md, findings.json, payloads.json (every Jev request) and per
 * side the raw evidence, with hits.json (what each part reached). <out>/state.json remembers the code each part last
 * passed at, and the code at the last reset. Exit code 1 when any check fails.
 * The suites only read: they never submit a form or follow a delete, send or sign-out. Two exceptions. interact clicks
 * every control whose label isn't one of those, so a button that saves on click is clicked: run it on test data
 * (interact.submit: true goes further and submits valid input in dialog forms: a throwaway database only). Flows are
 * your own code, may click and submit anything, and so may change data (leave them out with SKIP=flow).
 */
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CHANGE_KEYS, isLocal, load, SUITES, type Config } from './config.ts';
import { build, changedParts, findingSuite, list, mark, pool, resetDue, select, snapshot, withNeeds, type Part, type State } from './parts.ts';
import { signIn } from './auth.ts';
import { banners, closeBrowser, countdown, launch, recordings, SessionExpired, startDelay, type Run } from './browser.ts';
import { coverage, hits } from './coverage.ts';
import { routes } from './routes.ts';
import * as jev from './jev.ts';
import { loadFlows, runFlow } from './flow.ts';
import { expected, findings, record, write } from './report.ts';
import { start as startStub } from './stub.ts';
import * as code from './suites/code.ts';
import * as crawl from './suites/crawl.ts';
import * as contract from './suites/contract.ts';
import * as security from './suites/security.ts';
import * as a11y from './suites/a11y.ts';
import * as interact from './suites/interact.ts';
import * as audit from './suites/audit.ts';
import * as ux from './suites/ux.ts';
import * as usability from './suites/usability.ts';

// A config or usage error reads better as one line than a stack trace (agents parse this output too).
// TAPCHECK_DEBUG=1 keeps the stack for real bugs.
if (process.env.TAPCHECK_DEBUG !== '1') {
    process.setUncaughtExceptionCaptureCallback((e) => {
        console.error(`tapcheck: ${(e as Error)?.message ?? e}`);
        process.exit(2);
    });
}

const RUN: Record<(typeof SUITES)[number], (r: Run) => Promise<void>> = { crawl: crawl.run, contract: contract.run, security: security.run, a11y: a11y.run, interact: interact.run, audit: audit.run, ux: ux.run, usability: usability.run };

async function answers(url: string) {
    return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) }).then((r) => r.status > 0 && r.status < 500).catch(() => false);
}

/** Starts the app unless it already answers; resolves with the process tapcheck started (to stop it after), if any. */
async function startApp(cfg: Config): Promise<ChildProcess | null> {
    const ready = new URL(cfg.app.ready, cfg.baseUrl + '/').href;
    if (await answers(ready)) return null;
    if (!cfg.app.start) throw new Error(`The app isn't answering at ${ready}, and tapcheck.yml has no app.start to start it.`);
    console.log(`Starting the app: ${cfg.app.start}`);
    // `wait` keeps the shell alive while anything it started in the background runs, so stopApp can stop that whole
    // process group, and its id can't be reused by an unrelated one meanwhile.
    const child = spawn('/bin/sh', ['-c', `${cfg.app.start}\nwait`], { stdio: 'inherit', detached: true });
    const until = Date.now() + cfg.app.timeout * 1000;
    while (Date.now() < until) {
        if (await answers(ready)) return child;
        await new Promise((r) => setTimeout(r, 1000));
    }
    stopApp(cfg, child);
    throw new Error(`The app didn't answer at ${ready} within ${cfg.app.timeout} s of app.start.`);
}

/** Stops what app.start started, nothing when the app was already up: app.stop, then the whole process group,
 * background workers included. */
function stopApp(cfg: Config, child: ChildProcess | null) {
    if (!child?.pid) return;
    if (cfg.app.stop) { try { execSync(cfg.app.stop, { stdio: 'inherit', shell: '/bin/sh' }); } catch { /* reported by the command itself */ } }
    if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } }
}

const configFile = process.env.TAPCHECK_CONFIG ?? 'tapcheck.yml';
const cfg = load(configFile);
if (process.env.COVERAGE === '1') {
    const { all, runs } = hits(cfg.out);
    const c = coverage(all, runs, routes(cfg), cfg.coverage.reasons);
    const file = resolve(cfg.root, cfg.coverage.file);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, c.md);
    console.log(`${c.summary}; ${runs} run(s) merged → ${file}`);
    for (const g of c.gaps) console.log(`  GAP ${g}`);
    process.exit(0);
}
const flows = await loadFlows(cfg);
const PARTS = build(cfg.sides.map((s) => s.name), { code: cfg.gates.length > 0 || !!cfg.routes, flows });
const statePath = `${cfg.out}/state.json`;
const state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { parts: {} };
let chosen = select(PARTS, list(process.env.ONLY), list(process.env.SKIP));
const changedBase = process.env.CHANGED && !['0', '1'].includes(process.env.CHANGED) ? process.env.CHANGED : undefined;
const unknownKeys = Object.keys(cfg.changes).filter((k) => k !== '*' && !CHANGE_KEYS.includes(k) && !PARTS.some((p) => p.name === k));
if (unknownKeys.length) throw new Error(`changes: ${unknownKeys.join(', ')} ${unknownKeys.length > 1 ? 'are' : 'is'} not a part. Run with LIST=1 to see them.`);
if (process.env.CHANGED === '1' || changedBase) chosen = changedParts(chosen, state, cfg.changes, { config: configFile, out: cfg.out, base: changedBase });
chosen = withNeeds(PARTS, chosen);

if (process.env.LIST === '1') {
    const w = Math.max(...PARTS.map((p) => p.name.length));
    for (const p of PARTS) console.log(`${chosen.includes(p) ? '▶' : ' '} ${p.name.padEnd(w)}  ${p.tags.join(', ')}`);
    process.exit(0);
}
if (!chosen.length) {
    console.log(`Nothing to run: ${changedBase ? `no chosen part has changed files since ${changedBase}.` : process.env.CHANGED === '1' ? 'no chosen part has changed files since it last passed.' : 'SKIP took out every chosen part.'}`);
    process.exit(0);
}
console.log(`Running: ${chosen.map((p) => p.name).join(', ')}${cfg.devices.length < 3 ? ` (devices: ${cfg.devices.join(', ')})` : ''}`);

jev.setup({ ...cfg.jev, context: cfg.context });
// Why the Jev parts are skipped, or '' when they run. Once the budget is reached it says so, and the rest are skipped too.
let jevOff = jev.whyOff();
const jevParts = chosen.filter((p) => p.tags.includes('jev'));
const jevAsked = !jevOff && jevParts.length > 0;
const ran: typeof chosen = []; // parts that ran, to the end or not
const skipped: Record<string, string> = {}; // Jev parts left out, and why: neither passed nor failed
const notRun: Record<string, string> = {}; // parts that couldn't run, and why: they count as failed

const label = (p: Part) => (p.suite === 'flow' ? p.name : p.suite);
/** A verify flow's release item, for the findings the run itself records about that part. */
const itemOf = (p: Part) => { const item = flows.find((f) => f.part === p.name)?.item; return item ? { item } : {}; };
/** Runs one part; what it throws becomes a failing finding of its own and is returned. */
async function runPart(p: Part, rec: Run['record'], fn: () => Promise<void>, together = false): Promise<unknown> {
    const t0 = Date.now();
    const flow = p.suite === 'flow'; // a flow prints a line per step under its name
    const end = `${flow ? '  ' : ''}${together ? `${label(p)} ` : ''}`; // flows running together: say whose end it is
    process.stdout.write(`  ${label(p)}…${flow ? '\n' : ' '}`);
    ran.push(p);
    try {
        await fn();
        console.log(`${end}done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    } catch (e) {
        const msg = (e as Error).message;
        console.log(`${end}stopped: ${msg}`);
        rec({ suite: findingSuite(p), where: 'suite', check: 'suite ran to the end', status: 'fail', detail: msg.slice(0, 300), ...itemOf(p) });
        return e;
    }
}

startDelay(); // a wrong START_DELAY or SLOWMO stops the run here, before anything starts
const started = Date.now();
const dir = `${cfg.out}/run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
mkdirSync(dir, { recursive: true });
const needsApp = chosen.some((p) => p.side); // the code part alone needs neither the app nor a browser
// The browser first, before anything else starts: a missing Chromium is one line here, not Playwright's long error in every part.
if (needsApp) {
    await launch(cfg.browser.args).catch((e: Error) => {
        throw new Error(/Executable doesn't exist|playwright install/.test(e.message) ? "Chromium isn't installed. Run: npx playwright install chromium" : e.message);
    });
}
const stub = cfg.stub ? await startStub(cfg.stub, cfg.out, cfg.root) : null; // before the app, which is started with its address
const app = needsApp ? await startApp(cfg).catch(async (e) => { await stub?.stop(); throw e; }) : null;
const onSignal = () => { if (needsApp) stopApp(cfg, app); process.exit(130); };
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);

try {
    // Reset: asked for (RESET=1), or due by app.resetWhen (first use, or a matching file changed since the last one).
    const now = needsApp && cfg.app.resetWhen.length ? snapshot() : null;
    if (needsApp && cfg.app.resetWhen.length && !now) console.log('app.resetWhen is ignored: this is not a git repository with a commit.');
    const why = process.env.RESET === '1' ? 'RESET=1' : now && resetDue(state, cfg.app.resetWhen);
    if (why) {
        if (!cfg.app.reset) throw new Error('RESET=1 but tapcheck.yml has no app.reset.');
        if (!isLocal(cfg.baseUrl) && !cfg.app.allowRemoteReset) {
            throw new Error(`Refusing to reset ${cfg.baseUrl} (${why}): it isn't local. Set app.allowRemoteReset: true if that's really a throwaway copy.`);
        }
        console.log(`Resetting (${why}): ${cfg.app.reset}`);
        execSync(cfg.app.reset, { stdio: 'inherit', shell: '/bin/sh' });
        const snap = now ?? snapshot();
        if (snap) state.reset = snap;
    }
    if (needsApp) await countdown();
    const codePart = chosen.find((p) => p.suite === 'code');
    if (codePart) {
        const rec: Run['record'] = (f) => record(expected({ ...f, side: '' }, cfg.expect));
        console.log(`\ncode: ${cfg.gates.length} gate(s)${cfg.routes ? ', routes' : ''}`);
        await runPart(codePart, rec, () => code.run(cfg, dir, rec));
    }
    for (const side of cfg.sides) {
        const parts = chosen.filter((p) => p.side === side.name);
        if (!parts.length) continue;
        const sideDir = `${dir}/${side.name}`;
        mkdirSync(sideDir, { recursive: true });
        console.log(`\n${side.name} at ${side.baseUrl}: ${parts.map(label).join(', ')}`);
        // reached: one list, so the copies the flows running together get (each its own part and step) share it
        const r: Run = { cfg, side, dir: sideDir, record: (f) => record(expected({ ...f, side: side.name }, cfg.expect)), crawl: { pages: [], hits: [], done: false }, reached: [],
            scoped: !!process.env.ONLY || !['', '0'].includes(process.env.CHANGED ?? '') };
        try {
            r.auth = await signIn(cfg, side);
        } catch (e) {
            console.log(`  sign-in failed, so ${parts.map(label).join(', ')} didn't run: ${(e as Error).message}`);
            r.record({ suite: 'sign-in', where: side.baseUrl, check: 'signed in', status: 'fail', detail: (e as Error).message.slice(0, 300) });
            for (const p of parts) notRun[p.name] = 'sign-in failed';
            continue;
        }
        let expired = false;
        const one = async (p: Part, rp: Run, together = false) => {
            if (jevOff && p.tags.includes('jev')) { console.log(`  ${p.suite}… skipped (${jevOff})`); skipped[p.name] = jevOff; return; }
            const flow = flows.find((f) => f.part === p.name);
            const from = findings.length;
            const e = await runPart(p, rp.record, () => (flow ? runFlow(flow, rp, stub?.url) : RUN[p.suite as keyof typeof RUN](rp)), together);
            // MARK=1: what this part found with a plain screenshot (Jev's judgments, a failed step) gets the banner on it.
            if (cfg.marks) await banners(rp, findings.slice(from).filter((f) => f.suite === findingSuite(p) && f.side === p.side)).catch(() => {});
            if (e instanceof jev.BudgetReached) jevOff = 'Jev budget reached';
            if (e instanceof SessionExpired) expired = true;
        };
        // The suites one by one, then the flows: `parallel` at a time (a serial flow alone), each with its own copy of the run.
        const together = cfg.parallel > 1 ? parts.filter((p) => p.suite === 'flow') : [];
        for (const p of parts.filter((q) => !together.includes(q))) {
            if (expired) break;
            r.part = p.name;
            await one(p, r);
        }
        if (together.length) {
            console.log(`  flows, ${cfg.parallel} at a time: their step lines start with the flow's name`);
            const alone = (p: Part) => flows.find((f) => f.part === p.name)?.serial === true;
            await pool(together, cfg.parallel, alone, (p) => one(p, { ...r, part: p.name, step: undefined, prefix: `[${p.name}] ` }, true), () => expired);
        }
        if (expired) for (const q of parts) if (!ran.includes(q) && !(q.name in skipped)) notRun[q.name] = 'the session expired';
        writeFileSync(`${sideDir}/hits.json`, JSON.stringify(r.reached ?? [], null, 1));
    }
} finally {
    await closeBrowser();
    if (needsApp) stopApp(cfg, app);
    await stub?.stop();
    const u = jev.usage();
    const asked = jevAsked || u.calls + u.cached > 0; // audit asks Jev too, and isn't a Jev part
    const note = asked ? `Jev: ${u.calls} calls (avg ${u.avgMs} ms, ${u.cached} from cache), ${u.tokens} input tokens, $${u.usd} of the $${u.budget} budget` : undefined;
    if (asked) jev.savePayloads(dir);
    // Every part that didn't run gets a finding of its own, so the report (not just this terminal) says which and why.
    // Skipped Jev parts are neither passed nor failed (info); a part that couldn't run counts as failed.
    for (const p of chosen) {
        if (ran.includes(p)) continue;
        const skip = skipped[p.name];
        const hint = skip && !/budget/.test(skip) ? ' To run it, set TYPESAFE_API_KEY in the environment or in .env here, without JEV=off.'
            : skip ? ' Raise JEV_BUDGET (or jev.budget) to let it finish.' : '';
        record({ ...itemOf(p), suite: findingSuite(p), side: p.side, where: p.name, check: 'part ran', status: skip ? 'info' : 'fail',
            detail: `${skip ? `skipped (${skip})` : `not run (${notRun[p.name] ?? 'the run stopped before it'})`}.${hint}` });
    }
    const { bySuite, fails } = write(dir, { base: cfg.baseUrl, started, note, recordings });
    console.log('');
    console.table(bySuite.map((b) => ({ suite: b.s, failing: b.fail, warnings: b.warn, passing: b.pass })));
    if (note) console.log(note);
    const passed = mark(state, ran, findings, snapshot());
    for (const p of chosen) {
        if (p.name in skipped) { console.log(`  – ${p.name} (skipped: ${skipped[p.name]})`); continue; }
        if (!passed[p.name]) delete state.parts[p.name];
        console.log(`  ${passed[p.name] ? '✓' : '✗'} ${p.name}${p.name in notRun ? ` (not run: ${notRun[p.name]})` : ran.includes(p) ? '' : ' (not run)'}`);
    }
    writeFileSync(statePath, JSON.stringify(state, null, 1));
    if (recordings.length) console.log(`Recordings: ${recordings.length} (videos and traces, listed in the report). Open a trace: npx playwright show-trace <file>`);
    console.log(`Report: ${dir}/report.html`);
    process.exitCode = fails ? 1 : 0;
    // A flow that timed out may leave its own browser or timers behind, which would keep the process alive.
    setTimeout(() => process.exit(), 10_000).unref();
}
