---
name: tapcheck-verify
description: >
  Verify one release or one pull request on the running app, item by item: split the release note, the PR or the
  commits since the last deploy into what each claims, write a tapcheck flow that checks each claim and marks the
  screenshot, run only those flows, and report passed, failed, questions and not tested. Use when the user says
  "verify this release", "QA the deploy", "check the release note against the app", "does PR 42 do what it says",
  "test what we shipped since the last deploy", or pastes a release note and asks whether it is true. The project
  needs a tapcheck.yml (tapcheck-setup writes one). For a general audit use tapcheck-run.
---

# Verify a release or a pull request

A release note is a list of claims about the app. The work here is to check each claim on the running app and to
show the evidence: one flow per claim, one marked screenshot per check, one report in the order a QA report has.
It checks only what this release changed; the rest of the app is `tapcheck-run`'s job.

`TAPCHECK` below stands for `<this skill's base directory>/../../bin/tapcheck`; run it from the folder that holds
`tapcheck.yml`. (No `bin/tapcheck` there: `npx @ashishjain15491/tapcheck@<version>` from npm; see `tapcheck-setup`.)

## Hard rules

1. **Use the app's test or sandbox environment** (the one `tapcheck.yml`'s `baseUrl` names) unless the user names
   production in so many words. Say which environment you are about to use before the run.
2. **Never change data beyond a setting the flow restores.** A flow here may read, open, sort, filter, page, and flip
   a display setting or preference that it puts back with `t.cleanup`. It never places an order, pays, sends,
   invites, deletes, or edits a record. An item that can only be checked by doing one of those is recorded as not
   tested, with that reason, unless the user says this environment is a throwaway copy.
3. **Never ask for a password, a code or a key in chat**, and never read `.env`. Sign-in is the side's `login:` in
   `tapcheck.yml`, with its values in environment variables; a `manual` side opens a browser for the user to sign in.
4. **The flow checks the claim, not the code.** Read the number, the label or the state off the screen and compare
   it with what the item says. Don't make an item pass by loosening its check, and don't drop an item because it
   failed: a failed item is the result.
5. Don't invent an expectation. Where the release note doesn't say what should happen, record a question
   (`'warn'`), not a failure.

## Steps

### 1. Get the release

| The user gives | Read it with |
|---|---|
| a release note, pasted or as a file | the text itself |
| a pull request | `gh pr view <number> --json title,body,files` and `gh pr diff <number>` |
| "since the last deploy", two tags, a branch | `git log --no-merges --format='%h %s%n%b' <from>..<to>` and `git diff --stat <from>..<to>`; ask for the range if it isn't given |

Pick a short slug for it, such as `r0612` or `pr-42`: the folder and the flows' names start with it.

### 2. Split it into items

One item is one claim a person could check on a screen: "the cart total always equals the sum of the lines", "the
order history shows 20 orders per page". Use the release note's own words. Leave out what has no screen (a
refactor, a dependency bump) and say that you did. For a PR or a range of commits, the diff says where to look
(which route, which component), and the description says what should be true.

Then sort each item:

- **testable now**: there is a screen in this environment that shows whether it holds;
- **not testable now**: it needs something this run doesn't have (opening hours, a second signed-in device, a
  feature that is switched off here, data this environment lacks, a change rule 2 forbids). It still gets a flow,
  which only says why.

Show the user the list, with the sort, before writing flows. Ask about any item whose claim you can't turn into a
check.

### 3. Write one flow per item

In `tapcheck/verify/<slug>/`, one file per item. `tapcheck.yml`'s `flows:` has to match them: add
`tapcheck/verify/*/*.ts` to it once (say so; it is the only change to `tapcheck.yml` this skill makes). In a
project whose `package.json` says `"type": "commonjs"`, name the files `.mts`.

Each flow's export has `name`, starting with the slug and short (the part name is cut at 48 characters), and
`item`, the release item in the note's words. `item` is what makes it a verify flow: it is tagged `verify`, and its
findings open the report. Inside, `t.mark(check, status, marks, detail?)` records one check with a marked
screenshot of the page as it is:

| Status | Colour | Use it for |
|---|---|---|
| `'pass'` | green | the claim holds |
| `'fail'` | red | it doesn't: `detail` says what was expected and what is there |
| `'info'` | blue | the state of a setting the check depends on |
| `'warn'` | amber | a question for the team: something the note doesn't settle |

`marks` is a list of `{ target, note, kind? }`: the element (a selector, a Playwright locator, or a box
`{ x, y, width, height }`), the few words to print next to it, and optionally a colour of its own (`'bug'`,
`'pass'`, `'setting'`, `'question'`), so one screenshot can show the total in red and the setting it depends on in
blue. Mark the elements the claim is about, at most eight. Put the numbers in `detail` and in the notes: a reader
should see from the screenshot alone what was compared.

The worked example: a shop's release note says **"The cart total always equals the sum of the lines"**. The cart
has a "Show prices with tax" switch, so the claim is checked both ways and the switch is put back.

```ts
// tapcheck/verify/r0612/cart-total.ts
import type { Flow } from 'tapcheck';

const money = (s: string) => Math.round(Number(s.replace(/[^0-9.-]/g, '')) * 100);

export default {
    name: 'r0612 cart total',
    item: 'The cart total always equals the sum of the lines',
    run: async (t) => {
        const page = await t.goto('/cart');
        const tax = page.getByRole('switch', { name: 'Show prices with tax' });
        const was = await tax.isChecked();
        // Put the switch back however the flow ends.
        t.cleanup(async () => {
            const p = await t.goto('/cart');
            const s = p.getByRole('switch', { name: 'Show prices with tax' });
            if ((await s.isChecked()) !== was) await s.click();
        });
        for (const on of [was, !was]) {
            if ((await tax.isChecked()) !== on) await tax.click();
            const lines = (await page.locator('.cart-line .line-total').allInnerTexts()).map(money);
            const sum = lines.reduce((a, b) => a + b, 0);
            const total = money(await page.locator('#cart-total').innerText());
            await t.mark(`the total equals the lines, tax ${on ? 'shown' : 'hidden'}`, sum === total ? 'pass' : 'fail', [
                { target: '#cart-total', note: `total ${total / 100}` },
                { target: '.cart-line .line-total', note: 'a line' },
                { target: tax, note: `tax ${on ? 'on' : 'off'}${on === was ? ' (as found)' : ''}`, kind: 'setting' },
            ], `expected ${sum / 100} (${lines.length} lines added up), shown ${total / 100}`);
        }
        // Something the note doesn't settle is a question, not a failure.
        if (await page.getByText('Shipping').count() === 0) {
            await t.mark('is shipping meant to be left out of the cart total?', 'warn', [{ target: '#cart-total', note: 'no shipping line' }]);
        }
    },
} satisfies Flow;
```

An item that can't be checked now is a flow that says so, and nothing else:

```ts
// tapcheck/verify/r0612/refund-email.ts
import type { Flow } from 'tapcheck';

export default {
    name: 'r0612 refund email',
    item: 'Refund emails say the amount',
    run: async (t) => { t.untested('needs a refunded order, and refunding one would change data here'); },
} satisfies Flow;
```

Other things a flow can use: `t.step(name, fn)` for a step that passes or fails by throwing (opening a screen,
paging to the last page), `t.expect(cond, msg)` inside one, `t.page({ viewport: 'mobile' })` for an item about the
phone layout, and the rest of the flow API at the top of `src/flow.ts` in the tapcheck folder. Find selectors by
reading the app's templates or components, not by guessing; prefer roles and labels to class names.

Every setting a flow changes gets a `t.cleanup` before the change, as above.

### 4. Run only those flows

```bash
LIST=1 ONLY=verify TAPCHECK                 # what would run; starts nothing
MARK=1 ONLY='flow-r0612-*' TAPCHECK         # this release's flows, with marked screenshots
MARK=1 ONLY=verify TAPCHECK                 # every verify flow there is, if this is the only release folder
```

`MARK=1` is what draws the screenshots; without it the findings are the same and have no pictures. Add `JEV=off` if
no flow calls `t.jev`: nothing here needs Jev. If the flows should run on another environment than `tapcheck.yml`'s
(a sandbox rather than the local app), copy the file, change `baseUrl` in the copy, and run with
`TAPCHECK_CONFIG=<the copy>`; rule 1 still decides which environment that may be.

A step that fails because the flow is wrong (a selector that matches nothing, a page that needed a click first) is
the flow's bug: fix the flow and run it again. A check that fails because the app doesn't do what the note says is
the finding: leave it.

To also run tapcheck's own checks on what a pull request touched, that is `tapcheck-run`'s
`CHANGED=origin/<base> TAPCHECK`; it chooses the built-in parts as before.

### 5. Report

The run folder's `report.html` and `REPORT.md` open with **Release verification**, already in this order. Look at
each failed item's marked screenshot before describing it, then tell the user:

1. One line: the release, the environment, when, and the count (`6 passed · 1 failed · 2 questions · 3 not tested`).
2. **Failed**, each with what was expected, what is there, the steps to see it, and the screenshot's path.
3. **Passed**, as a short table: the item, what was checked, the evidence.
4. **Questions for the team**: each amber finding, in one sentence.
5. **Not tested**, each with why, and what it would take.
6. Every setting a flow changed and that it was put back (a `cleanup ran` warning means one wasn't: say which).
7. The path of `report.html`, and `REPORT.md` for pasting into the pull request or the release ticket.

Don't call a release verified when an item failed or most of it wasn't tested, and don't start fixing: offer
`tapcheck-fix` for the failures. Keep the flows: they are the regression checks for this release, and
`ONLY=verify` runs them again after a fix.
