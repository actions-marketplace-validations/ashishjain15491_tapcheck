/*
 * Code gates (measured, no Jev, no browser, no running app). A code review needs certainty, so this runs the project's
 * own toolchain and keeps the evidence:
 * - each `gates` command (a linter, a type check, a dependency audit…) runs from the config file's folder: exit 0
 *   passes, anything else fails (or warns, with `warn: true`) with the exit code and the last lines of output; a gate
 *   still running after its `timeout` is stopped and fails. The end of every gate's output is kept in code.json;
 * - when the `routes` command says which routes need sign-in (`auth`): state-changing routes (POST, PUT, PATCH, DELETE)
 *   with `auth: false` that don't match security.publicWrites are listed as a warning for a person to look at.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import type { Config, Gate } from '../config.ts';
import type { Finding } from '../report.ts';
import { routes } from '../routes.ts';

const KEEP = 20_000; // characters of each gate's output kept

/** Runs one gate in its own process group, so a timeout stops everything it started. */
export function gate(g: Gate, cwd: string): Promise<{ code: number; out: string; timedOut: boolean }> {
    return new Promise((done) => {
        const child = spawn('/bin/sh', ['-c', g.run], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', timedOut = false;
        const keep = (d: Buffer) => { out = (out + d).slice(-KEEP); };
        child.stdout.on('data', keep);
        child.stderr.on('data', keep);
        const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } }, g.timeout * 1000);
        child.on('close', (code) => { clearTimeout(timer); done({ code: code ?? -1, out: out.replace(/\x1b\[[0-9;]*m/g, ''), timedOut }); });
    });
}
export const tail = (s: string, n = 6) => s.trim().split('\n').filter((l) => l.trim()).slice(-n).join(' ⏎ ').slice(-600);

export async function run(cfg: Config, dir: string, record: (f: Omit<Finding, 'side'>) => void) {
    const S = 'code';
    const log: Record<string, { code: number; out: string }> = {};
    for (const g of cfg.gates) {
        const res = await gate(g, cfg.root);
        log[g.name] = { code: res.code, out: res.out };
        record({ suite: S, where: 'repository', check: g.name, status: res.code === 0 ? 'pass' : g.warn ? 'warn' : 'fail',
            detail: res.code === 0 ? undefined : `${res.timedOut ? `stopped after ${g.timeout} s` : `exit ${res.code}`}: ${tail(res.out) || 'no output'}`,
            evidence: res.code === 0 ? undefined : [`${dir}/code.json`] });
    }
    if (cfg.gates.length) writeFileSync(`${dir}/code.json`, JSON.stringify(log, null, 2));

    const list = routes(cfg);
    if (!list.some((x) => x.auth !== undefined)) return;
    const open = list.filter((x) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(x.method) && x.auth === false && !cfg.security.publicWrites?.test(x.path));
    record({ suite: S, where: 'routes', check: 'state-changing routes need sign-in', status: open.length ? 'warn' : 'pass',
        detail: open.length ? `${open.slice(0, 8).map((x) => `${x.method} ${x.path}`).join('; ')}${open.length > 8 ? ` (+${open.length - 8})` : ''}` : `${list.length} routes checked` });
}
