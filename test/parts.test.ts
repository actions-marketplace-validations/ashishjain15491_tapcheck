import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { build, changedParts, mark, select, snapshot, withNeeds, type State } from '../src/parts.ts';

const PARTS = build(['customer', 'staff']);
const names = (only: string, skip = '') => withNeeds(PARTS, select(PARTS, only ? only.split(',') : [], skip ? skip.split(',') : [])).map((p) => p.name);

test('parts: one per suite and side, tagged, in run order', () => {
    assert.deepEqual(PARTS.slice(0, 7).map((p) => p.name), ['crawl-customer', 'contract-customer', 'security-customer', 'a11y-customer', 'ux-customer', 'usability-customer', 'crawl-staff']);
    assert.deepEqual(PARTS.find((p) => p.name === 'ux-staff')!.tags, ['ux', 'staff', 'jev']);
    assert.deepEqual(PARTS.find((p) => p.name === 'contract-staff')!.tags, ['contract', 'staff', 'measured']);
});

test('select: names, tags, * prefix, SKIP after ONLY, unknown keys', () => {
    assert.equal(names('').length, 12);
    assert.deepEqual(names('a11y-staff'), ['a11y-staff']);
    assert.deepEqual(names('a11y'), ['a11y-customer', 'a11y-staff']);
    assert.deepEqual(names('jev'), ['ux-customer', 'usability-customer', 'ux-staff', 'usability-staff']);
    assert.deepEqual(names('u*'), ['ux-customer', 'usability-customer', 'ux-staff', 'usability-staff']);
    assert.deepEqual(names('ux-*,a11y-staff'), ['ux-customer', 'a11y-staff', 'ux-staff']); // run order, not ONLY order
    assert.deepEqual(names('staff', 'jev,crawl'), ['crawl-staff', 'contract-staff', 'security-staff', 'a11y-staff']); // contract needs the crawl back
    assert.deepEqual(names('measured', 'security,staff'), ['crawl-customer', 'contract-customer', 'a11y-customer']);
    assert.deepEqual(names('', 'customer,staff'), []);
    assert.throws(() => names('nope'), /No part or tag called nope\. Run with LIST=1/);
    assert.throws(() => names('ux', 'e2e,zz*'), /No part or tag called e2e, zz\*/);
});

test('needs: contract and security bring the crawl on their own side', () => {
    assert.deepEqual(names('security-staff'), ['crawl-staff', 'security-staff']);
    assert.deepEqual(names('contract'), ['crawl-customer', 'contract-customer', 'crawl-staff', 'contract-staff']);
    assert.deepEqual(names('ux-customer'), ['ux-customer']);
});

test('mark: a part with a failing finding of its own is not recorded, a clean one is', () => {
    const [crawl, contract, security] = PARTS;
    const snap = { snapshot: 'abc', untracked: [] };
    const state: State = { parts: { 'security-customer': { snapshot: 'old', untracked: [] }, 'a11y-customer': { snapshot: 'old', untracked: [] } } };
    const passed = mark(state, [crawl, contract, security], [
        { suite: 'crawl', side: 'customer', status: 'warn' },
        { suite: 'security', side: 'customer', status: 'fail' },
        { suite: 'contract', side: 'staff', status: 'fail' }, // another side's failure
    ], snap);
    assert.deepEqual(passed, { 'crawl-customer': true, 'contract-customer': true, 'security-customer': false });
    assert.deepEqual(state.parts, { 'a11y-customer': { snapshot: 'old', untracked: [] }, 'crawl-customer': snap, 'contract-customer': snap });
    assert.deepEqual(mark({ parts: {} }, [crawl], [], null), { 'crawl-customer': true }); // not a git repo: passes, nothing to record
});

test('CHANGED: only the parts whose files changed since they last passed', () => {
    const cwd = mkdtempSync(`${tmpdir()}/tapcheck-parts-`);
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd, stdio: 'pipe' });
    const put = (file: string, text: string) => { mkdirSync(dirname(`${cwd}/${file}`), { recursive: true }); writeFileSync(`${cwd}/${file}`, text); };
    const at = { config: 'tapcheck.yml', out: '.tapcheck', cwd };
    const parts = build(['public']);
    const changes = { a11y: ['**/*.css'], ux: ['views/**'], '*': ['src/**'] };
    const changed = (state: State, c: Record<string, string[]> = changes) => changedParts(parts, state, c, at).map((p) => p.suite);

    assert.throws(() => changedParts(parts, { parts: {} }, {}, at), /CHANGED=1 needs a git repository/);
    assert.equal(snapshot(cwd), null);
    git('init', '-q');
    put('src/app.js', '1'); put('site.css', '1'); put('tapcheck.yml', 'baseUrl: http://x');
    git('add', '.'); git('commit', '-qm', 'one');

    put('notes.txt', 'untracked before the snapshot');
    const snap = snapshot(cwd)!;
    assert.deepEqual(snap.untracked, ['notes.txt']);
    const state: State = { parts: Object.fromEntries(parts.map((p) => [p.name, snap])) };

    assert.deepEqual(changed(state), [], 'unchanged');
    assert.deepEqual(changed({ parts: {} }), ['crawl', 'contract', 'security', 'a11y', 'ux', 'usability'], 'never passed');
    put('.tapcheck/run-1/findings.json', '[]');
    assert.deepEqual(changed(state, {}), [], "tapcheck's own output doesn't count");

    put('site.css', '2'); // tracked, modified, not committed
    assert.deepEqual(changed(state), ['a11y'], 'only the suite whose glob matches');
    assert.deepEqual(changed(state, {}), ['crawl', 'contract', 'security', 'a11y', 'ux', 'usability'], 'no globs: any change');
    assert.deepEqual(changed(state, { ux: ['views/**'] }), ['crawl', 'contract', 'security', 'a11y', 'usability'], 'a suite without globs reruns on any change');

    const snap2 = snapshot(cwd)!; // a11y passed with the new CSS
    assert.notEqual(snap2.snapshot, snap.snapshot);
    state.parts['a11y-public'] = snap2;
    assert.deepEqual(changed(state), []);

    put('views/home.html', '1'); // untracked and new since the snapshot
    assert.deepEqual(changed(state), ['ux']);
    put('src/new.js', '1');
    assert.deepEqual(changed(state), ['crawl', 'contract', 'security', 'a11y', 'ux', 'usability'], '"*" globs are every suite\'s');

    git('add', '.'); git('commit', '-qm', 'two');
    for (const p of parts) state.parts[p.name] = snapshot(cwd)!;
    assert.deepEqual(changed(state), []);
    put('tapcheck.yml', 'baseUrl: http://y');
    assert.deepEqual(changed(state), ['crawl', 'contract', 'security', 'a11y', 'ux', 'usability'], 'the config file reruns everything');
    git('checkout', '-q', 'tapcheck.yml');

    state.parts['security-public'] = { snapshot: '0123456789abcdef0123456789abcdef01234567', untracked: [] };
    assert.deepEqual(changed(state), ['security'], 'a snapshot that is gone counts as changed');

    // From a folder inside the repository: paths still count from the git root.
    put('app/tapcheck.yml', 'baseUrl: http://x');
    git('add', '.'); git('commit', '-qm', 'three');
    const inner = { ...at, cwd: `${cwd}/app` };
    const fresh: State = { parts: Object.fromEntries(parts.map((p) => [p.name, snapshot(inner.cwd)!])) };
    put('src/app.js', '2');
    assert.deepEqual(changedParts(parts, fresh, { ux: ['app/**'] }, inner).map((p) => p.suite), ['crawl', 'contract', 'security', 'a11y', 'usability']);
    put('app/tapcheck.yml', 'baseUrl: http://z');
    assert.equal(changedParts(parts, fresh, { ux: ['app/**'] }, inner).length, 6);
});
