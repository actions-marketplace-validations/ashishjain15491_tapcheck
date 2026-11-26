import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { closeBrowser, launch, slices, type Run } from '../src/browser.ts';

after(closeBrowser);

test('slices: an app shell whose main panel scrolls is sliced by that panel, and put back where it was', async () => {
    const page = await (await (await launch()).newContext({ viewport: { width: 800, height: 600 } })).newPage();
    await page.setContent(`<body style="margin:0;height:100vh;overflow:hidden;display:flex">
        <nav style="width:80px">menu</nav><main style="flex:1;overflow-y:auto">${Array.from({ length: 60 }, (_, i) => `<p style="height:30px;margin:0">row ${i + 1}</p>`).join('')}</main></body>`);
    const r = { dir: mkdtempSync(`${tmpdir()}/tapcheck-slices-`) } as Run;
    const seen: number[] = [];
    const shoot = page.screenshot.bind(page);
    page.screenshot = async (o) => { seen.push(await page.evaluate(() => document.querySelector('main')?.scrollTop ?? -1)); return shoot(o); };

    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    const shots = await slices(r, page, 'shell', height, 600);
    assert.equal(shots.length, 3, '1800 px of rows in a 600 px panel'); // the window itself doesn't scroll
    assert.deepEqual(seen, [0, 600, 1200]);
    assert.deepEqual(await page.evaluate(() => [document.querySelector('main')!.scrollTop, document.querySelectorAll('[data-tapcheck-slices]').length]), [0, 0]);

    // A page that scrolls itself is sliced by the window, as before.
    await page.setContent(`<body style="margin:0">${Array.from({ length: 40 }, (_, i) => `<p style="height:30px;margin:0">row ${i + 1}</p>`).join('')}</body>`);
    assert.equal((await slices(r, page, 'page', await page.evaluate(() => document.documentElement.scrollHeight), 600)).length, 2);
});

test('popupShot: an opened menu is cut out of the screen for Jev, at least 280 px a side; a full-screen dialog is not', async () => {
    const { popupShot } = await import('../src/suites/audit.ts');
    const page = await (await (await launch()).newContext({ viewport: { width: 800, height: 600 } })).newPage();
    const dir = mkdtempSync(`${tmpdir()}/tapcheck-popup-`);
    const size = (file: string) => { const b = readFileSync(file); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
    await page.setContent(`<body style="margin:0"><div data-tapcheck-popup style="position:absolute;left:700px;top:40px;width:200px;height:320px">old</div>
        <div role="menu" data-tapcheck-popup style="position:absolute;left:500px;top:100px;width:120px;height:400px;background:#eee">menu</div></body>`);
    assert.deepEqual(size((await popupShot(page, `${dir}/menu.png`))!), [280, 400], 'the newest popup, widened to 280 px');
    await page.setContent('<body style="margin:0"><div role="dialog" data-tapcheck-popup style="position:fixed;inset:0">full</div></body>');
    assert.equal(await popupShot(page, `${dir}/full.png`), undefined);
});
