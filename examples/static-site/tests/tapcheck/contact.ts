/*
 * An example flow: the contact form can be found and filled in by its labels, Jev looks at it (skipped without a key or
 * with JEV=off), and the stub stands in for an outside API and for DNS. A flow may click and submit anything; this one
 * only looks and types.
 */
import { Resolver } from 'node:dns/promises';
import type { Flow } from 'tapcheck';

export default {
    name: 'Contact',
    run: async (t) => {
        const page = await t.goto('/');
        await t.step('Home links to the contact form', async () => {
            await page.getByRole('link', { name: 'Contact' }).first().click();
            await page.waitForURL('**/contact.html');
        });
        await t.step('the form fields are labelled', async () => {
            await page.getByLabel('Your email').fill('ada@example.com');
            await page.getByLabel('Your question').fill('How much light does a fern need?');
            t.expect(await page.getByRole('button', { name: 'Send question' }).isVisible(), 'no "Send question" button');
        });
        await t.jev('contact form, filled in'); // its own findings: one per visual question, or one saying it was skipped
        // This site calls no outside service, so the flow does it here: what the app would get from the stub, and the stub's record of it.
        await t.step('the stub answers for the plant API', async () => {
            const since = Date.now();
            const plant = await (await fetch(`${process.env.TAPCHECK_STUB_URL}/api.example.com/v1/plants/7`)).json();
            t.expect(plant.name === 'Boston fern', `the stub answered ${JSON.stringify(plant)}`);
            const seen = await t.stub.requests({ host: 'api.example.com', since });
            t.expect(seen.length === 1 && seen[0].path === '/v1/plants/7', `the stub saw ${seen.length} request(s)`);
            return `GET ${seen[0].host}${seen[0].path} → ${seen[0].status}`;
        });
        await t.step('the stub answers DNS for the shop domain', async () => {
            const dns = new Resolver();
            dns.setServers([process.env.TAPCHECK_DNS!]);
            const txt = (await dns.resolveTxt('shop.example.com')).flat();
            t.expect(txt.includes('plant-shop-verification=fern'), `TXT was ${JSON.stringify(txt)}`);
            return txt.join(', ');
        });
    },
} satisfies Flow;
