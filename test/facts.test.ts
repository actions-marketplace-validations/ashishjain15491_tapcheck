import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeBrowser, facts, launch } from '../src/browser.ts';

after(closeBrowser);

test('facts: chips in a rail that scrolls sideways are on screen, a control pushed past the edge is not, and it is named', async () => {
    const page = await (await (await launch()).newContext({ viewport: { width: 400, height: 600 } })).newPage();
    await page.setContent(`<body style="margin:0;overflow-x:hidden">
        <div style="display:flex;overflow-x:auto;width:400px">${Array.from({ length: 12 }, (_, i) => `<button style="flex:none;width:90px">Chip ${i + 1}</button>`).join('')}</div>
        <div style="overflow:hidden;width:400px"><button style="margin-left:380px;width:90px">Clipped</button></div>
        <button style="position:absolute;left:-200px;width:90px">Lost</button><button>Fine</button></body>`);
    const f = await facts(page);
    assert.deepEqual([f.offscreen, f.offscreenLabels], [2, ['Clipped', 'Lost']]);
});
