/*
 * Parts: every suite on every side is one part, named <suite>-<side>; the code gates are one part with no side, `code`;
 * every custom flow is a part on its side, flow-<name>. Here: build them, pick some by name or tag (ONLY, SKIP), find the
 * ones whose files changed since they last passed (CHANGED=1) or since a git ref (CHANGED=<ref>), and record the ones that passed.
 */
import { execFileSync } from 'node:child_process';
import { matchesGlob, posix, relative, resolve } from 'node:path';
import { SUITES } from './config.ts';

export type Part = { name: string; suite: string; side: string; tags: string[]; needs: string[] }; // side '' for code: no app, no browser
export type Snap = { snapshot: string; untracked: string[] };
export type State = { parts: Record<string, Snap>; reset?: Snap }; // the code each part last passed at, and the code at the last app.reset

const JEV = ['ux', 'usability']; // the suites Jev judges
const NEEDS_CRAWL = ['contract', 'security', 'interact']; // they read the crawl's records

/** Every part in run order: code (when there is any), then by side its suites and its flows (`part` is a flow's part
 * name; one with an `item` verifies a release item and is tagged verify too). */
export const build = (sides: string[], extra: { code?: boolean; flows?: { part: string; side: string; item?: string }[] } = {}): Part[] => [
    ...(extra.code ? [{ name: 'code', suite: 'code', side: '', tags: ['code', 'measured'], needs: [] }] : []),
    ...sides.flatMap((side) => [
        ...SUITES.map((suite) => ({ name: `${suite}-${side}`, suite, side, tags: [suite, side, JEV.includes(suite) ? 'jev' : 'measured'],
            needs: NEEDS_CRAWL.includes(suite) ? [`crawl-${side}`] : [] })),
        ...(extra.flows ?? []).filter((f) => f.side === side).map((f) => ({ name: f.part, suite: 'flow', side, tags: ['flow', side, 'measured', ...(f.item ? ['verify'] : [])], needs: [] })),
    ]),
];
/** The suite name a part's findings carry: its suite, or for a flow its own name (so one flow failing doesn't fail the others). */
export const findingSuite = (p: Part) => (p.suite === 'flow' ? p.name : p.suite);

export const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const hit = (p: Part, keys: string[]) => keys.some((k) => (k.endsWith('*') ? p.name.startsWith(k.slice(0, -1)) : p.name === k || p.tags.includes(k)));

/** The parts ONLY names (all when empty) without the ones SKIP names. A key is a part name, a tag, or a name prefix ending in *. */
export function select(parts: Part[], only: string[], skip: string[]): Part[] {
    const unknown = [...only, ...skip].filter((k) => !parts.some((p) => hit(p, [k])));
    if (unknown.length) throw new Error(`No part or tag called ${unknown.join(', ')}. Run with LIST=1 to see them.`);
    return parts.filter((p) => (!only.length || hit(p, only)) && !hit(p, skip));
}

/** `chosen` plus the parts they need, in run order. */
export const withNeeds = (parts: Part[], chosen: Part[]): Part[] => {
    const names = new Set(chosen.flatMap((p) => [p.name, ...p.needs]));
    return parts.filter((p) => names.has(p.name));
};

/**
 * Runs `run` on each item, at most `n` at a time, starting them in order. An item `alone` says is alone waits for the
 * running ones to end and ends before the next starts. Once `stopped()` is true no more start. `run` must not reject.
 */
export async function pool<T>(items: T[], n: number, alone: (x: T) => boolean, run: (x: T) => Promise<void>, stopped = () => false): Promise<void> {
    const running = new Set<Promise<void>>();
    for (const x of items) {
        if (alone(x)) await Promise.all(running);
        while (running.size >= n) await Promise.race(running);
        if (stopped()) break;
        const p: Promise<void> = run(x).finally(() => running.delete(p));
        running.add(p);
        if (alone(x)) await p;
    }
    await Promise.all(running);
}

// ── git: the only place it is called ──
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const untracked = (cwd: string) => git(cwd, 'ls-files', '--others', '--exclude-standard', '--full-name', '--', ':/').split('\n').filter(Boolean);

/** The code as it is now (uncommitted work included), or null when this isn't a git repository with a commit. */
export function snapshot(cwd = process.cwd()): Snap | null {
    // `stash create` writes a commit, which git refuses without an author; a container or a CI runner has none set.
    const stash = ['-c', 'user.name=tapcheck', '-c', 'user.email=tapcheck@example.invalid', 'stash', 'create'];
    try { return { snapshot: git(cwd, ...stash) || git(cwd, 'rev-parse', 'HEAD'), untracked: untracked(cwd) }; } catch { return null; }
}

/** Tracked files changed since the snapshot, as paths from the git root; null when the snapshot is gone (garbage-collected). */
function diff(cwd: string, snap: string): string[] | null {
    try { return git(cwd, 'diff', '--name-only', snap).split('\n').filter(Boolean); } catch { return null; }
}

/**
 * app.resetWhen: why the app's data should be reset before this run, or null when it needn't be. It is due on first use
 * and when a file matching one of `globs` (paths from the git root) changed since the last reset (`state.reset`).
 * Call it only where snapshot() works (a git repository with a commit).
 */
export function resetDue(state: State, globs: string[], cwd = process.cwd()): string | null {
    const s = state.reset;
    if (!s) return 'first use';
    const tracked = diff(cwd, s.snapshot);
    if (!tracked) return 'the snapshot of the last reset is gone';
    const file = [...tracked, ...untracked(cwd).filter((f) => !s.untracked.includes(f))].find((f) => globs.some((g) => matchesGlob(f, g)));
    return file ? `${file} changed since the last reset` : null;
}

/**
 * CHANGED=1: of `chosen`, the parts whose files changed since each last passed. With `at.base` (CHANGED=<git ref>), the
 * files changed since the branch point with that ref instead, the same for every part and with no state needed: a pull
 * request's own changes, committed or not. `changes` maps a part name, a suite or "*" to the globs it depends on; a
 * part's own name wins over its suite, "*" adds to both, a part with none reruns on any change, and a change to the
 * `config` file reruns everything. Files under `out` (tapcheck's own output) never count. `config` and `out` are paths from `cwd`.
 */
export function changedParts(chosen: Part[], state: State, changes: Record<string, string[]>, at: { config: string; out: string; cwd?: string; base?: string }): Part[] {
    const cwd = at.cwd ?? process.cwd();
    let prefix: string;
    try { git(cwd, 'rev-parse', 'HEAD'); prefix = git(cwd, 'rev-parse', '--show-prefix'); } catch {
        throw new Error(`CHANGED=${at.base ?? 1} needs a git repository with at least one commit here: it compares files with ${at.base ? 'that ref' : 'the last passing run'}.`);
    }
    const fromRoot = (file: string) => posix.normalize(prefix + relative(cwd, resolve(cwd, file)));
    const config = fromRoot(at.config), out = fromRoot(at.out) + '/';
    const now = untracked(cwd), diffs = new Map<string, string[] | null>(); // parts that passed together share a snapshot
    let sinceBase: string[] | undefined;
    if (at.base) {
        let fork: string;
        try { fork = git(cwd, 'merge-base', at.base, 'HEAD'); } catch {
            throw new Error(`CHANGED=${at.base}: git finds no commit shared by ${at.base} and HEAD. Fetch it first (git fetch origin <branch>); in CI, check out with full history (fetch-depth: 0).`);
        }
        sinceBase = [...(diff(cwd, fork) ?? []), ...now];
    }
    return chosen.filter((p) => {
        let files = sinceBase;
        if (!files) {
            const s = state.parts[p.name]; // none: it never passed
            if (s && !diffs.has(s.snapshot)) diffs.set(s.snapshot, diff(cwd, s.snapshot));
            const tracked = s && diffs.get(s.snapshot);
            if (!s || !tracked) return true;
            // ponytail: an untracked file edited again since the snapshot isn't seen (only new ones are); hash them if that bites.
            files = [...tracked, ...now.filter((f) => !s.untracked.includes(f))];
        }
        files = files.filter((f) => !f.startsWith(out));
        if (files.includes(config)) return true;
        const globs = [...(changes[p.name] ?? changes[p.suite] ?? []), ...(changes['*'] ?? [])];
        return globs.length ? files.some((f) => globs.some((g) => matchesGlob(f, g))) : files.length > 0;
    });
}

/**
 * Which of the parts that ran passed: a part passes when it has no failing finding of its own (its suite, or its flow, on its side).
 * Only a passing part is recorded in `state` (at `snap`), so CHANGED=1 runs a failing part again until it passes.
 */
export function mark(state: State, ran: Part[], findings: { suite: string; side: string; status: string }[], snap: Snap | null): Record<string, boolean> {
    return Object.fromEntries(ran.map((p) => {
        const ok = !findings.some((f) => f.suite === findingSuite(p) && f.side === p.side && f.status === 'fail');
        if (ok && snap) state.parts[p.name] = snap; else delete state.parts[p.name];
        return [p.name, ok];
    }));
}
