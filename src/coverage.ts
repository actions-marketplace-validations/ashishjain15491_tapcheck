/*
 * The coverage map across runs (COVERAGE=1). Coverage is observed, not claimed: every run writes <side dir>/hits.json,
 * what each part touched (every request the app answered, the dialogs and table controls interact exercised, and for a
 * flow the step that did it). This merges the hits of every run folder under `out`, so parts run one at a time still
 * add up, into one Markdown file: each route of the `routes` command with the parts that reached it, or GAP (with the
 * reason, when `coverage.reasons` gives one), then the dialogs and table controls seen. Without a `routes` command there
 * is nothing to measure against, so it lists what was reached.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { Reach } from './browser.ts';
import type { Config } from './config.ts';
import { matcher, type Route } from './routes.ts';

/** The hits of every run under `out`, newest run first, and how many runs had any. */
export function hits(out: string): { all: Reach[]; runs: number } {
    const runs = (existsSync(out) ? readdirSync(out) : []).filter((d) => d.startsWith('run-')).sort().reverse()
        .map((d) => readdirSync(`${out}/${d}`, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(`${out}/${d}/${e.name}/hits.json`))
            .flatMap((e) => JSON.parse(readFileSync(`${out}/${d}/${e.name}/hits.json`, 'utf8')) as Reach[]))
        .filter((h) => h.length);
    return { all: runs.flat(), runs: runs.length };
}

/** The coverage map as Markdown, and its counts. `reasons` are matched against "GET /path", "dialog <name>" and "table <headers>: <control>". */
export function coverage(all: Reach[], runs: number, routes: Route[], reasons: Config['coverage']['reasons']) {
    const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ');
    const by = (ok: (what: string) => boolean) => [...new Set(all.filter((h) => ok(h.what)).map((h) => (h.step ? `${h.part}: ${h.step}` : h.part)))];
    const who = (w: string[]) => cell(w.slice(0, 2).join(', ') + (w.length > 2 ? ` (+${w.length - 2})` : ''));
    const kind = (prefix: string) => [...new Set(all.filter((h) => h.what.startsWith(prefix)).map((h) => h.what))].sort().map((what) => `| ${cell(what.slice(prefix.length))} | ${who(by((w) => w === what))} |`);
    const out: string[] = [], gaps: string[] = [];
    let covered = 0, excused = 0;

    if (routes.length) {
        out.push('## Routes', '', '| Route | Reached by |', '|---|---|');
        for (const key of [...new Set(routes.map((r) => `${r.method} ${r.path}`))].sort((a, b) => a.split(' ')[1].localeCompare(b.split(' ')[1]) || a.localeCompare(b))) {
            const [method, path] = key.split(' '), re = matcher(path);
            const w = by((what) => what.startsWith(`${method} `) && re.test(what.slice(method.length + 1)));
            const why = w.length ? undefined : reasons.find((r) => r.match.test(key))?.why;
            if (w.length) covered++; else if (why) excused++; else gaps.push(key);
            out.push(`| \`${cell(key)}\` | ${w.length ? who(w) : why ? `GAP: ${cell(why)}` : '**GAP**'} |`);
        }
    } else {
        const reached = kind('').filter((row) => /^\| [A-Z]+ \//.test(row));
        out.push('## Reached', '', 'tapcheck.yml has no `routes` command, so there is no route list to find gaps in. These requests were answered:', '', '| Request | Reached by |', '|---|---|', ...reached);
    }
    for (const [prefix, title, head] of [['dialog ', 'Dialogs', 'Dialog'], ['table ', 'Table controls', 'Table: control']]) {
        const rows = kind(prefix);
        if (rows.length) out.push('', `## ${title}`, '', `| ${head} | Reached by |`, '|---|---|', ...rows);
    }
    const total = covered + excused + gaps.length;
    const summary = routes.length ? `${total} routes: ${covered} reached, ${excused} left out on purpose, ${gaps.length} GAP` : `${new Set(all.map((h) => h.what)).size} things reached (no route list)`;
    const md = ['# Coverage map', '', 'Written by `COVERAGE=1 tapcheck` from the hits.json of every run. Do not edit by hand: run more parts, then write it again.', '',
        `**${summary}.** Runs merged: ${runs}.`, '', ...out, ''].join('\n');
    return { md, summary, total, covered, excused, gaps };
}
