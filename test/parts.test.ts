import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { build, changedParts, mark, resetDue, select, snapshot, withNeeds, type State } from '../src/parts.ts';

const PARTS = build(['customer', 'staff']);
const names = (only: string, skip = '') => withNeeds(PARTS, select(PARTS, only ? only.split(',') : [], skip ? skip.split(',') : [])).map((p) => p.name);

test('parts: one per suite and side, tagged, in run order', () => {
    assert.deepEqual(PARTS.slice(0, 9).map((p) => p.name), ['crawl-customer', 'contract-customer', 'security-customer', 'a11y-customer', 'interact-customer', 'audit-customer', 'ux-customer', 'usability-customer', 'crawl-staff']);
    assert.deepEqual(PARTS.find((p) => p.name === 'ux-staff')!.tags, ['ux', 'staff', 'jev']);
    assert.deepEqual(PARTS.find((p) => p.name === 'contract-staff')!.tags, ['contract', 'staff', 'measured']);
    assert.deepEqual(PARTS.find((p) => p.name === 'audit-staff')!.tags, ['audit', 'staff', 'measured']);
});

test('select: names, tags, * prefix, SKIP after ONLY, unknown keys', () => {
    assert.equal(names('').length, 16);
    assert.deepEqual(names('a11y-staff'), ['a11y-staff']);
    assert.deepEqual(names('a11y'), ['a11y-customer', 'a11y-staff']);
    assert.deepEqual(names('jev'), ['ux-customer', 'usability-customer', 'ux-staff', 'usability-staff']);
    assert.deepEqual(names('u*'), ['ux-customer', 'usability-customer', 'ux-staff', 'usability-staff']);
    assert.deepEqual(names('ux-*,a11y-staff'), ['ux-customer', 'a11y-staff', 'ux-staff']); // run order, not ONLY order
    assert.deepEqual(names('staff', 'jev,crawl'), ['crawl-staff', 'contract-staff', 'security-staff', 'a11y-staff', 'interact-staff', 'audit-staff']); // contract needs the crawl back
    assert.deepEqual(names('measured', 'security,staff'), ['crawl-customer', 'contract-customer', 'a11y-customer', 'interact-customer', 'audit-customer']);
    assert.deepEqual(names('', 'customer,staff'), []);
    assert.throws(() => names('nope'), /No part or tag called nope\. Run with LIST=1/);
    assert.throws(() => names('ux', 'e2e,zz*'), /No part or tag called e2e, zz\*/);
});

test('needs: contract, security and interact bring the crawl on their own side', () => {
    assert.deepEqual(names('security-staff'), ['crawl-staff', 'security-staff']);
    assert.deepEqual(names('contract'), ['crawl-customer', 'contract-customer', 'crawl-staff', 'contract-staff']);
    assert.deepEqual(names('interact-staff,audit-staff'), ['crawl-staff', 'interact-staff', 'audit-staff']);
    assert.deepEqual(names('ux-customer'), ['ux-customer']);
});

test('code and flows: code has no side and comes first, each flow is a part on its side', () => {
    const parts = build(['customer', 'staff'], { code: true, flows: [{ part: 'flow-invite', side: 'staff' }, { part: 'flow-check-out', side: 'customer' }, { part: 'flow-sign-up', side: 'customer' }] });
    const pick = (only: string, skip = '') => withNeeds(parts, select(parts, only ? only.split(',') : [], skip ? skip.split(',') : [])).map((p) => p.name);
    assert.deepEqual(parts[0], { name: 'code', suite: 'code', side: '', tags: ['code', 'measured'], needs: [] });
    assert.deepEqual(parts.slice(8, 11).map((p) => p.name), ['usability-customer', 'flow-check-out', 'flow-sign-up']);
    assert.deepEqual(parts.at(-1), { name: 'flow-invite', suite: 'flow', side: 'staff', tags: ['flow', 'staff', 'measured'], needs: [] });
    assert.deepEqual(pick('code'), ['code']);
    assert.deepEqual(pick('flow'), ['flow-check-out', 'flow-sign-up', 'flow-invite']);
    assert.deepEqual(pick('customer', 'jev,crawl,contract,security,a11y,interact,audit'), ['flow-check-out', 'flow-sign-up']); // a side's tag never brings code
    assert.deepEqual(pick('measured', 'customer,staff'), ['code']);
    assert.ok(!build(['customer']).some((p) => p.name === 'code'), 'no gates and no routes: no code part');

    // One flow failing doesn't fail the other flow on its side, and a side's failures aren't code's.
    const state: State = { parts: {} };
    const ran = parts.filter((p) => ['code', 'flow-check-out', 'flow-sign-up'].includes(p.name));
    assert.deepEqual(mark(state, ran, [{ suite: 'flow-sign-up', side: 'customer', status: 'fail' }, { suite: 'crawl', side: 'customer', status: 'fail' }], { snapshot: 'abc', untracked: [] }),
        { code: true, 'flow-check-out': true, 'flow-sign-up': false });
    assert.deepEqual(mark(state, ran, [{ suite: 'code', side: '', status: 'fail' }], null), { code: false, 'flow-check-out': true, 'flow-sign-up': true });
});

// ───────────────────────────── the CLI itself, on a config whose app can't start ─────────────────────────────
test('cli: LIST shows the code and flow parts; a code-only run starts no app and no stub is left behind', () => {
    const cwd = mkdtempSync(`${tmpdir()}/tapcheck-cli-`);
    writeFileSync(`${cwd}/flow.ts`, "import type { Flow } from 'tapcheck';\nexport default { name: 'Sign up!', run: async () => {} } satisfies Flow;\n");
    writeFileSync(`${cwd}/tapcheck.yml`, [
        'baseUrl: http://127.0.0.1:9', // nothing answers on the discard port
        'app: { start: "touch started.txt; sleep 30", timeout: 2 }',
        'gates:',
        '  - { name: sees the stub, run: \'test "$TAPCHECK_STUB_URL" = "http://127.0.0.1:18766"\' }',
        '  - { name: lint, run: "echo two problems; exit 1" }',
        'stub: { port: 18766 }',
        'flows: "*.ts"',
    ].join('\n'));
    const cli = (env: Record<string, string>) => spawnSync(process.execPath, [resolve('src/cli.ts')], { cwd, encoding: 'utf8', env: { ...process.env, JEV: 'off', ...env } });

    const listed = cli({ LIST: '1', ONLY: 'code,flow' });
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(listed.stdout.trim().split('\n').map((l) => l.replace(/\s+/g, ' ')),
        ['▶ code code, measured', ' crawl-public crawl, public, measured', ' contract-public contract, public, measured', ' security-public security, public, measured',
            ' a11y-public a11y, public, measured', ' interact-public interact, public, measured', ' audit-public audit, public, measured', ' ux-public ux, public, jev', ' usability-public usability, public, jev', '▶ flow-sign-up flow, public, measured']);

    const run = cli({ ONLY: 'code' });
    assert.match(run.stdout, /Running: code\n/);
    assert.match(run.stdout, /✗ code\n/);
    assert.equal(run.status, 1, 'the failing gate fails the run');
    assert.ok(!existsSync(`${cwd}/started.txt`), 'app.start never ran');
    const out = execFileSync('sh', ['-c', 'cat .tapcheck/run-*/findings.json'], { cwd, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out).map((f: any) => [f.suite, f.side, f.check, f.status, f.detail]),
        [['code', '', 'sees the stub', 'pass', undefined], ['code', '', 'lint', 'fail', 'exit 1: two problems']]);
});

test('cli: the app is stopped with the workers its start left behind, and app.stop runs only after tapcheck started it', async () => {
    const cwd = mkdtempSync(`${tmpdir()}/tapcheck-stop-`);
    const free = createServer().listen(0);
    await once(free, 'listening');
    const port = (free.address() as AddressInfo).port;
    free.close();
    const serverJs = `require('http').createServer((q, s) => s.end('<title>t</title>')).listen(${port})`;
    // The start command returns at once, leaving the server and a "worker" in the background.
    writeFileSync(`${cwd}/tapcheck.yml`, [
        `baseUrl: http://127.0.0.1:${port}`,
        `app: { start: "sleep 300 & echo $! > worker.pid; node -e \\"${serverJs}\\" &", stop: "touch stopped.txt", timeout: 20 }`,
        'crawl: { max: 1 }',
    ].join('\n'));
    const cli = () => spawnSync(process.execPath, [resolve('src/cli.ts')], { cwd, encoding: 'utf8', env: { ...process.env, JEV: 'off', ONLY: 'crawl-public' }, timeout: 120_000 }); // a leaked child would hold stdout open
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const up = async () => {
        for (const until = Date.now() + 10_000; Date.now() < until; await new Promise((r) => setTimeout(r, 100))) {
            if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) return;
        }
        throw new Error(`nothing answered on ${port}`);
    };

    let worker = 0;
    try {
        const first = cli();
        assert.match(first.stdout, /Starting the app/, first.stderr);
        worker = Number(readFileSync(`${cwd}/worker.pid`, 'utf8'));
        await new Promise((r) => setTimeout(r, 300));
        assert.ok(!alive(worker), 'the background worker was stopped');
        assert.ok(existsSync(`${cwd}/stopped.txt`), 'app.stop ran');
        assert.ok(!(await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)), 'the server was stopped');
    } finally {
        if (worker && alive(worker)) process.kill(worker);
        spawnSync('sh', ['-c', `lsof -ti tcp:${port} -sTCP:LISTEN | xargs kill 2>/dev/null`]);
    }

    // Already up (started here, not by tapcheck, in its own process: spawnSync blocks this one): tapcheck neither starts nor stops it.
    rmSync(`${cwd}/stopped.txt`);
    const server = spawn(process.execPath, ['-e', serverJs]);
    try {
        await up();
        const second = cli();
        assert.doesNotMatch(second.stdout, /Starting the app/);
        assert.ok(!existsSync(`${cwd}/stopped.txt`), 'app.stop did not run');
        assert.equal(server.exitCode, null, 'the app that was already up is still running');
    } finally { server.kill(); }
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
    assert.deepEqual(changed({ parts: {} }), ['crawl', 'contract', 'security', 'a11y', 'interact', 'audit', 'ux', 'usability'], 'never passed');
    put('.tapcheck/run-1/findings.json', '[]');
    assert.deepEqual(changed(state, {}), [], "tapcheck's own output doesn't count");

    put('site.css', '2'); // tracked, modified, not committed
    assert.deepEqual(changed(state), ['a11y'], 'only the suite whose glob matches');
    assert.deepEqual(changed(state, {}), ['crawl', 'contract', 'security', 'a11y', 'interact', 'audit', 'ux', 'usability'], 'no globs: any change');
    assert.deepEqual(changed(state, { ux: ['views/**'] }), ['crawl', 'contract', 'security', 'a11y', 'interact', 'audit', 'usability'], 'a suite without globs reruns on any change');

    const snap2 = snapshot(cwd)!; // a11y passed with the new CSS
    assert.notEqual(snap2.snapshot, snap.snapshot);
    state.parts['a11y-public'] = snap2;
    assert.deepEqual(changed(state), []);

    put('views/home.html', '1'); // untracked and new since the snapshot
    assert.deepEqual(changed(state), ['ux']);
    put('src/new.js', '1');
    assert.deepEqual(changed(state), ['crawl', 'contract', 'security', 'a11y', 'interact', 'audit', 'ux', 'usability'], '"*" globs are every suite\'s');

    git('add', '.'); git('commit', '-qm', 'two');
    for (const p of parts) state.parts[p.name] = snapshot(cwd)!;
    assert.deepEqual(changed(state), []);
    put('tapcheck.yml', 'baseUrl: http://y');
    assert.deepEqual(changed(state), ['crawl', 'contract', 'security', 'a11y', 'interact', 'audit', 'ux', 'usability'], 'the config file reruns everything');
    git('checkout', '-q', 'tapcheck.yml');

    state.parts['security-public'] = { snapshot: '0123456789abcdef0123456789abcdef01234567', untracked: [] };
    assert.deepEqual(changed(state), ['security'], 'a snapshot that is gone counts as changed');

    // From a folder inside the repository: paths still count from the git root.
    put('app/tapcheck.yml', 'baseUrl: http://x');
    git('add', '.'); git('commit', '-qm', 'three');
    const inner = { ...at, cwd: `${cwd}/app` };
    const fresh: State = { parts: Object.fromEntries(parts.map((p) => [p.name, snapshot(inner.cwd)!])) };
    put('src/app.js', '2');
    assert.deepEqual(changedParts(parts, fresh, { ux: ['app/**'] }, inner).map((p) => p.suite), ['crawl', 'contract', 'security', 'a11y', 'interact', 'audit', 'usability']);
    put('app/tapcheck.yml', 'baseUrl: http://z');
    assert.equal(changedParts(parts, fresh, { ux: ['app/**'] }, inner).length, 8);
});

test('app.resetWhen: a reset is due on first use and when a matching file changed since the last one', () => {
    const cwd = mkdtempSync(`${tmpdir()}/tapcheck-reset-`);
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd, stdio: 'pipe' });
    const put = (file: string, text: string) => { mkdirSync(dirname(`${cwd}/${file}`), { recursive: true }); writeFileSync(`${cwd}/${file}`, text); };
    git('init', '-q');
    put('database/seed.sql', '1'); put('src/app.js', '1');
    git('add', '.'); git('commit', '-qm', 'one');
    const globs = ['database/**', '*.seed.json'];
    const state: State = { parts: {} };
    assert.equal(resetDue(state, globs, cwd), 'first use');
    state.reset = snapshot(cwd)!;
    assert.equal(resetDue(state, globs, cwd), null, 'nothing changed');
    put('src/app.js', '2'); put('notes.txt', 'new');
    assert.equal(resetDue(state, globs, cwd), null, 'changes elsewhere');
    put('database/seed.sql', '2'); // tracked, not committed
    assert.equal(resetDue(state, globs, cwd), 'database/seed.sql changed since the last reset');
    state.reset = snapshot(cwd)!;
    assert.equal(resetDue(state, globs, cwd), null, 'reset at this code');
    put('users.seed.json', '[]'); // untracked and new
    assert.equal(resetDue(state, globs, cwd), 'users.seed.json changed since the last reset');
    state.reset = { snapshot: '0123456789abcdef0123456789abcdef01234567', untracked: [] };
    assert.equal(resetDue(state, globs, cwd), 'the snapshot of the last reset is gone');
});
