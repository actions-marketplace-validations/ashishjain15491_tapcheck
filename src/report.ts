/*
 * The evidence report: report.html (failures first, with evidence thumbnails and links), REPORT.md (for a PR or a
 * ticket: the failures, the warnings, what tapcheck.yml's `expect` rules accepted, what was skipped, and a count of the
 * other info rows) and findings.json, all in the run's folder next to the screenshots and JSON evidence they point to. A run with
 * RECORD=1 also lists its videos and Playwright traces, per side and part. A run with verify flows (flows with an `item`)
 * opens with "Release verification": what the release claimed and what held, in a QA report's order.
 */
import { writeFileSync } from 'node:fs';
import type { Recording } from './browser.ts';

/** item: the release item a verify flow checks (its `item`), on each of that flow's findings. */
export type Finding = { suite: string; side: string; where: string; check: string; status: 'pass' | 'fail' | 'warn' | 'info'; detail?: string; evidence?: string[]; item?: string };
export const findings: Finding[] = [];
/** The check t.untested() records under: a verify flow's item that couldn't be checked in this run. */
export const UNTESTED = 'not tested';
export const record = (f: Finding) => { findings.push(f); };

/** tapcheck.yml's expect: a fail or warn whose "<suite>: <check> @ <where>" matches a rule is right for this product. It is
 * kept as info, saying why and what it was, so the report still shows it and nothing is dropped. */
export function expected(f: Finding, rules: { match: RegExp; why: string }[]): Finding {
    if (f.status !== 'fail' && f.status !== 'warn') return f;
    const rule = rules.find((x) => x.match.test(`${f.suite}: ${f.check} @ ${f.where}`));
    return rule ? { ...f, status: 'info', detail: `expected: ${rule.why} (was ${f.status}${f.detail ? `: ${f.detail}` : ''})` } : f;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const ORDER = { fail: 0, warn: 1, info: 2, pass: 3 } as const;
const cell = (s: string) => s.replace(/[\\|]/g, '\\$&').replace(/\s+/g, ' '); // a backslash first, so `a\|b` stays one cell
const isExpected = (f: Finding) => f.status === 'info' && !!f.detail?.startsWith('expected:');
const png = (f: Finding) => f.evidence?.find((e) => /\.png$/.test(e));

/**
 * The verify flows' findings as the section that opens both reports: a one-line count, the failed items with their
 * steps and screenshots (its questions' are under the questions), the passed ones as a table, the questions (every
 * warning), and what wasn't tested and why.
 * An item is its flow: failed with any failing finding, else not tested with a t.untested(), else passed with a pass.
 * Null when the run had no verify flow.
 */
function verification(rel: (p: string) => string, ev: (e: string) => string) {
    const of = (f: Finding) => `${f.suite}\n${f.side}`;
    const items = [...new Set(findings.filter((f) => f.item).map(of))].map((k) => {
        const list = findings.filter((f) => of(f) === k), has = (st: Finding['status']) => list.some((f) => f.status === st);
        const why = list.find((f) => f.check === UNTESTED);
        return { item: list.find((f) => f.item)!.item!, list, why, state: has('fail') ? 'failed' : why ? 'untested' : has('pass') ? 'passed' : '' };
    });
    if (!items.length) return null;
    const failed = items.filter((i) => i.state === 'failed'), passed = items.filter((i) => i.state === 'passed'), untested = items.filter((i) => i.state === 'untested');
    const questions = items.flatMap((i) => i.list.filter((f) => f.status === 'warn').map((f) => ({ item: i.item, f })));
    const summary = `${passed.length} passed · ${failed.length} failed · ${questions.length} question${questions.length === 1 ? '' : 's'} · ${untested.length} not tested`;
    const step = (f: Finding) => `${f.check}${f.detail ? `: ${f.detail}` : ''}`;
    const checked = (i: (typeof items)[number]) => i.list.filter((f) => f.status === 'pass').map(step).join('; ');
    const shots = (i: (typeof items)[number], ...st: Finding['status'][]) => [...new Set(i.list.filter((f) => st.includes(f.status)).map(png).filter((e): e is string => !!e))];
    const html = `<h2>Release verification</h2><p class="meta">${summary}</p>`
        + (failed.length ? `<h3>Failed</h3>${failed.map((i) => `<h4>${esc(i.item)}</h4><ol>${i.list.map((f) => `<li><span class="tag ${f.status}">${f.status}</span> ${esc(step(f))}</li>`).join('')}</ol>`
            + `<p class="big">${shots(i, 'fail', 'info').map((e) => `<a href="${esc(rel(e))}" target="_blank" rel="noopener"><img src="${esc(rel(e))}" alt="evidence" loading="lazy"></a>`).join('')}</p>`).join('')}` : '')
        + (passed.length ? `<h3>Passed</h3><div class="wrap"><table><thead><tr><th>Release item</th><th>What was checked</th><th>Evidence</th></tr></thead><tbody>${passed.map((i) =>
            `<tr><td>${esc(i.item)}</td><td>${esc(checked(i))}</td><td>${shots(i, 'pass', 'info').map(ev).join('')}</td></tr>`).join('')}</tbody></table></div>` : '')
        + (questions.length ? `<h3>Questions for the team</h3><ul>${questions.map((q) => `<li><b>${esc(q.item)}</b> · ${esc(step(q.f))}${png(q.f) ? ev(png(q.f)!) : ''}</li>`).join('')}</ul>` : '')
        + (untested.length ? `<h3>Not tested</h3><div class="wrap"><table><thead><tr><th>Release item</th><th>Why not</th></tr></thead><tbody>${untested.map((i) =>
            `<tr><td>${esc(i.item)}</td><td>${esc(i.why!.detail ?? '')}</td></tr>`).join('')}</tbody></table></div>` : '');
    const md = ['## Release verification', '', summary, '',
        ...(failed.length ? ['### Failed', '', ...failed.flatMap((i) => [`**${i.item}**`, '', ...i.list.map((f, n) => `${n + 1}. ${f.status} · ${step(f)}`), '', ...shots(i, 'fail', 'info').map((e) => `![evidence](${rel(e)})`), ''])] : []),
        ...(passed.length ? ['### Passed', '', '| Release item | What was checked | Evidence |', '|---|---|---|', ...passed.map((i) => `| ${cell(i.item)} | ${cell(checked(i))} | ${shots(i, 'pass', 'info').map((e) => cell(rel(e))).join(' · ')} |`), ''] : []),
        ...(questions.length ? ['### Questions for the team', '', ...questions.map((q) => `- **${q.item}** · ${step(q.f)}${png(q.f) ? ` (${rel(png(q.f)!)})` : ''}`), ''] : []),
        ...(untested.length ? ['### Not tested', '', '| Release item | Why not |', '|---|---|', ...untested.map((i) => `| ${cell(i.item)} | ${cell(i.why!.detail ?? '')} |`), ''] : [])];
    return { html, md };
}

/** Writes the three reports into `dir`; returns the per-suite counts and the number of failures. */
export function write(dir: string, meta: { base: string; started: number; note?: string; recordings?: Recording[] }) {
    const rel = (p: string) => (p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : p);
    writeFileSync(`${dir}/findings.json`, JSON.stringify(findings, null, 2));
    const many = new Set(findings.map((f) => f.side).filter(Boolean)).size > 1; // the code part has no side
    const key = (f: Finding) => (many && f.side ? `${f.suite} · ${f.side}` : f.suite);
    const bySuite = [...new Set(findings.map(key))].map((s) => {
        const f = findings.filter((x) => key(x) === s);
        const n = (st: Finding['status']) => f.filter((x) => x.status === st).length;
        // A part with nothing but info rows checked nothing: skipped when one of them says so ("part ran"), else empty (a
        // side with no tasks, say). A row an `expect` rule turned into info was checked.
        const checked = f.some((x) => x.status !== 'info' || isExpected(x)), skipped = !checked && f.some((x) => x.check === 'part ran');
        return { s, pass: n('pass'), fail: n('fail'), warn: n('warn'), total: f.length, skipped, empty: !checked && !skipped };
    });
    const sorted = [...findings].sort((a, b) => ORDER[a.status] - ORDER[b.status] || key(a).localeCompare(key(b)) || a.where.localeCompare(b.where));
    const mins = ((Date.now() - meta.started) / 60000).toFixed(1);
    const when = new Date().toISOString();

    const ev = (e: string) => (/\.png$/.test(e)
        ? ` <a href="${esc(rel(e))}" target="_blank" rel="noopener"><img src="${esc(rel(e))}" alt="evidence" loading="lazy"></a>`
        : ` <a href="${esc(rel(e))}">${esc(rel(e))}</a>`);
    const row = (f: Finding) => `<tr class="${f.status}"><td><span class="tag ${f.status}">${f.status}</span></td><td>${esc(key(f))}</td><td>${esc(f.where)}</td>`
        + `<td>${esc(f.check)}</td><td>${esc(f.detail ?? '')}${(f.evidence ?? []).map(ev).join('')}</td></tr>`;
    const verify = verification(rel, ev);
    const recs = (meta.recordings ?? []).filter((r) => r.videos.length || r.trace);
    const recorded = recs.length ? `<h2>Recordings</h2><p class="meta">A video per browser page, and a trace of every action with the page as it was: open one with the command next to it.</p><ul>${recs.map((r) =>
        `<li>${esc(r.side)} · ${esc(r.label)}${r.videos.map((v, i) => ` · <a href="${esc(rel(v))}">video${r.videos.length > 1 ? ` ${i + 1}` : ''}</a>`).join('')}`
        + `${r.trace ? ` · <a href="${esc(rel(r.trace))}">trace</a> <code>npx playwright show-trace ${esc(r.trace)}</code>` : ''}</li>`).join('')}</ul>` : '';
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>tapcheck report</title><style>
:root{--bg:#fff;--fg:#1f2937;--mut:#6b7280;--line:#e5e7eb;--fail:#b91c1c;--warn:#b45309;--pass:#15803d;--info:#1d4ed8}
@media (prefers-color-scheme:dark){:root{--bg:#111827;--fg:#e5e7eb;--mut:#9ca3af;--line:#374151;--fail:#f87171;--warn:#fbbf24;--pass:#4ade80;--info:#93c5fd}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}main{max-width:1280px;margin:0 auto}
h1{margin:0 0 4px;font-size:22px}h2{margin:28px 0 4px;font-size:16px}h3{margin:20px 0 6px;font-size:14px}h4{margin:14px 0 2px;font-size:14px}.big img{display:block;max-width:min(100%,960px);margin:8px 0 16px;border:1px solid var(--line);border-radius:4px}li{margin:4px 0}code{font-size:12px;color:var(--mut)}p.meta{color:var(--mut);margin:0 0 20px}.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:24px}
.card{border:1px solid var(--line);border-radius:10px;padding:12px}.card b{display:block;text-transform:uppercase;font-size:12px;color:var(--mut);letter-spacing:.04em}
.card span{font-size:13px}.n{font-size:20px;font-weight:700}.f{color:var(--fail)}.w{color:var(--warn)}.p{color:var(--pass)}
.filters{margin:0 0 12px;display:flex;gap:8px;flex-wrap:wrap}.filters label{border:1px solid var(--line);border-radius:999px;padding:4px 10px;cursor:pointer}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid var(--line)}th{font-size:12px;color:var(--mut);text-transform:uppercase}
td img,li img{max-width:120px;max-height:80px;border:1px solid var(--line);border-radius:4px;vertical-align:middle;margin:2px}
.tag{font-size:11px;font-weight:700;text-transform:uppercase;padding:2px 6px;border-radius:4px;border:1px solid currentColor}.tag.fail{color:var(--fail)}.tag.warn{color:var(--warn)}.tag.pass{color:var(--pass)}.tag.info{color:var(--info)}
body:has(#hp:not(:checked)) tr.pass{display:none}body:has(#hw:not(:checked)) tr.warn{display:none}body:has(#hi:not(:checked)) tr.info{display:none}
</style></head><body><main><h1>tapcheck report</h1><p class="meta">${esc(meta.base)} · ${when} · ${mins} min${meta.note ? ` · ${esc(meta.note)}` : ''}</p>${verify ? `${verify.html}<h2>Every check</h2>` : ''}
<div class="cards">${bySuite.map((b) => `<div class="card"><b>${esc(b.s)}</b><span class="n ${b.fail ? 'f' : b.skipped || b.empty ? 'w' : 'p'}">${b.fail ? `${b.fail} failing` : b.skipped ? 'skipped' : b.empty ? 'nothing checked' : 'clean'}</span><br><span><span class="w">${b.warn} warn</span> · <span class="p">${b.pass} pass</span> · ${b.total} checks</span></div>`).join('')}</div>
<div class="filters"><label><input type="checkbox" id="hw" checked> warnings</label><label><input type="checkbox" id="hi" checked> info</label><label><input type="checkbox" id="hp"> passes</label></div>
<div class="wrap"><table><thead><tr><th>Status</th><th>Suite</th><th>Where</th><th>Check</th><th>Detail and evidence</th></tr></thead><tbody>${sorted.map(row).join('')}</tbody></table></div>${recorded}
<p class="meta">Raw evidence: findings.json, payloads.json (every Jev request), code.json (the gates' output), and per side crawl.json, network.json, missed-routes.json, axe.json, interact.json, audit.json, clickstream.json and hits.json (what each part reached, for COVERAGE=1).</p></main></body></html>`;
    writeFileSync(`${dir}/report.html`, html);

    const ran = (f: Finding) => f.check === 'part ran' && f.status === 'info';
    const others = sorted.filter((f) => f.status === 'info' && !isExpected(f) && !ran(f)).length;
    const line = (f: Finding) => `- **${key(f)}** · ${f.where} · ${f.check}${f.detail ? `: ${f.detail}` : ''}`;
    const md = [`# tapcheck · ${meta.base}`, '', `${when} · ${mins} min${meta.note ? ` · ${meta.note}` : ''}`, '', ...(verify?.md ?? []),
        '| Suite | Failing | Warnings | Passing |', '|---|---|---|---|', ...bySuite.map((b) => (b.empty ? `| ${b.s} | — | — | — nothing checked — |` : `| ${b.s} | ${b.fail} | ${b.warn} | ${b.pass} |`)), '',
        '## Failing', '', ...sorted.filter((f) => f.status === 'fail').map(line), '', '## Warnings', '', ...sorted.filter((f) => f.status === 'warn').map(line), '',
        ...(sorted.some(isExpected) ? ['## Expected', '', ...sorted.filter(isExpected).map(line), ''] : []),
        ...(sorted.some(ran) ? ['## Skipped', '', ...sorted.filter(ran).map(line), ''] : []),
        ...(others ? [`${others} info row${others === 1 ? '' : 's'} in report.html.`, ''] : []),
        ...(recs.length ? ['## Recordings', '', ...recs.map((r) => `- ${r.side} · ${r.label}: ${[...r.videos.map(rel), ...(r.trace ? [`\`npx playwright show-trace ${r.trace}\``] : [])].join(' · ')}`), ''] : [])].join('\n');
    writeFileSync(`${dir}/REPORT.md`, md);
    return { bySuite, fails: findings.filter((f) => f.status === 'fail').length };
}
