---
name: tapcheck-fix
description: >
  Fix what a tapcheck run found: take the failing findings, find the code behind each one, fix it, and rerun only
  that part until it passes. Use when the user says "fix the tapcheck failures", "fix what tapcheck found", "fix the
  accessibility issues from the audit", "make tapcheck pass", "fix the failing e2e checks", or asks to act on a
  tapcheck report.
---

# Fix tapcheck's findings

The findings are evidence about the app. The work here is to change the app so the finding is no longer true, and
to prove it by running the same check again.

`TAPCHECK` below stands for `<this skill's base directory>/../../bin/tapcheck`; run it from the folder that holds
`tapcheck.yml`. (No `bin/tapcheck` there: `npx @ashishjain15491/tapcheck@<version>` from npm; see `tapcheck-setup`.)

## Hard rules

1. **Never make a finding pass by weakening the check.** That means: no raising or removing a threshold; no adding
   to `crawl.skip`, `audit.skip`, `security.allowedHosts` or `security.publicWrites`; no adding a value to `design:` because a
   page uses it; no lowering `interact.max` or `audit.max`; no deleting a screen, task, gate, route or
   flow step; no `warn: true` on a gate; no `CONTRACT_UPDATE=1`; no editing `done`/`notDone`/`optimal` until the
   task passes; no `SKIP` to hide a part; no linter ignore comments or loosened linter config; no editing tapcheck's
   own source. If one of these really is the right answer (a third-party host is intended, an API change was
   deliberate), that is the user's decision: ask, and say what would then stop being checked.
2. **Never edit the app's data** to make a finding go away: no changing rows, seeds or fixtures by hand, no deleting
   records, and no `RESET=1` unless the user has agreed. Fix the code that produced the state.
3. **A Jev warning is not a bug report.** A `warn` from `ux` or `usability` means Jev was unsure. Show the user the
   screenshot and the question, and let them judge. Don't redesign a screen on an unsure verdict.
4. **Stop and ask when the fix is a product decision**: changing wording, navigation, layout or visual design beyond
   an obvious defect; changing what an API returns; adding sign-in to a route; choosing a Content-Security-Policy;
   removing a third-party script. Bring the finding, the evidence and one or two options.
5. Fix the cause once, where every page gets it (a layout, a middleware, a shared component), not page by page.
6. Never read or print `.env`, and never put a secret in `tapcheck.yml`.

## Steps

### 1. Collect the failures

Use the newest run (`ls -d .tapcheck/run-* | tail -1`, or the folder the user names; `out` in `tapcheck.yml` if it
isn't `.tapcheck`) and read its `findings.json`. If there is no run yet, or the code has changed since, run first
(`tapcheck-run`). Take the entries with `status: "fail"`; group those with the same `check` and cause. List them for
the user in the order you'll take them: parts that stopped early (`suite ran to the end`, `signed in`) first, then
`code`, `crawl`, `contract`, `security`, `a11y`, `interact`, `audit`, flows, and Jev's last.

### 2. Find the code

Open the evidence before the code: the screenshot, and the JSON that goes with the suite.

| Suite | A finding means | Evidence in the run folder | Where the fix usually is |
|---|---|---|---|
| `code` | one of the project's own gates exited non-zero | `code.json` (the gate's output) | the files the linter, type checker or audit names |
| `crawl` | a page answers 4xx/5xx, is slow, logs console errors, has broken images or dead links, or a form field has no label | `<side>/crawl.json` | the route and its controller or handler (status, errors); the template (links, images, labels); front-end code (console errors) |
| `contract` | an API call answers 5xx/4xx, returns HTML or unparsable JSON to a script, is slow, or lost a top-level key | `<side>/network.json`; the baseline `contract-<side>.json` in `out` | the API handler, its serializer or resource; error handling that renders a page for an API request |
| `security` | a header is missing, a cookie flag is off, a page opens signed out, CSRF isn't refused, a secret is served, a third-party host is called | the finding's `detail` lists pages; `<side>/network.json` | headers middleware or web-server config; session and cookie config; auth middleware on the route; the template or bundle that embeds the key or script |
| `a11y` | an axe rule fails on a screen at a viewport, focus isn't visible, Tab is trapped, the page has no language | `<side>/axe.json` (rule, selector, HTML of each node) | the template or component that renders the node; CSS for contrast and focus styles; the layout for `lang` |
| `interact` | clicking a control raised a page or console error, a 5xx or a native `alert`/`confirm`; a dialog has no accessible name, doesn't close with Escape, or takes invalid input without an error state. Warnings: a control that did nothing (once per run, with the other screens it is on; a selected tab or the current page isn't counted, nor errors on another site's page), focus left behind a dialog, a table control that changed nothing | `<side>/interact.json` (what was clicked, each dialog and table); the finding's `where` is the page and the dialog's name | the click handler named by the control's label; the dialog component (`aria-labelledby`, focus on open, an Escape handler, or a native `<dialog>` with `showModal()`); the form's validation (`required`, `aria-invalid`, a visible message) |
| `audit` | on a screen at a size: text cut off, controls overlapping, a target under 24 px, a leaked placeholder (`undefined`, `{{name}}`), an image without `alt`, no focus ring, a menu or dialog off the screen, poor contrast or a white background in dark mode. Warnings: several looks for one kind of control, mixed label case, styles outside `design:` | `<side>/audit.json`; the screenshot in `<side>/shots/audit-*.png` | CSS at that width or colour scheme; the shared button and field styles (fix the odd one out, not every page); the template for placeholders and `alt`. Consistency and token warnings are product decisions (rule 4) |
| `ux` (fail) | a measured fact (sideways scroll, a control off the screen, more than one h1, a raw translation key) or a clear Jev verdict on the screenshot. `design: cta`, `cta label` and the attention check are info, "no main call to action on this screen", where there is none | `<side>/shots/` | CSS and layout at that viewport; the template; the translation file for a missing key |
| `usability` (fail) | a first-time user didn't reach the task's screen, took a longer path, or hit dead clicks or errors; a click that failed names its control (`click failed on "<label>"`), and a control something covers is never offered | `<side>/clickstream.json` and the clickstream image | navigation and labels; a control that does nothing; usually a product decision (rule 4) |
| `flow-<name>` | a step of the project's own flow threw | the step's screenshot; the flow file named by `flows:` | the app code the step exercises. Change the flow file only if it is plainly out of date with an intended change, and say so |

Search the code for the text in the finding: the path, the selector, the header name, the visible label. A finding
on every page points at a layout or middleware; on one page, at that page's template or handler.

A crawl, contract or security failure can come from the test setup rather than the app (a missing seed row, an
unbuilt asset, a service that isn't running). Check that first; if so, the fix is in the setup, and you say that
plainly instead of changing app code.

### 3. Fix, then rerun that part

Make the smallest change that removes the cause. Then rerun only the part the finding came from, named
`<suite>-<side>` (the finding's `suite` and `side`); for a flow, the `suite` is already the part name:

```bash
ONLY=a11y-public TAPCHECK
ONLY=security-admin TAPCHECK      # brings crawl-admin along (so does interact-admin)
JEV=off ONLY=audit-public TAPCHECK   # the measured audit, without Jev's look
ONLY=code TAPCHECK                # no app, no browser
ONLY=flow-checkout TAPCHECK
JEV_BUDGET=0.25 ONLY=ux-public TAPCHECK
```

Read the new `findings.json` (a new `run-*` folder each time) and check that this finding is now `pass` and that
nothing that passed before in this part now fails. Repeat until the part has no failures you are allowed to fix. If
the same finding survives two attempts, stop and re-read the evidence rather than trying a third variation.

If the app was already running when tapcheck started, tapcheck used it as it was: restart or rebuild it so the
rerun sees your change.

Then the next finding. After the last one, run the project's own tests if it has any, and finish with one wider run
(`CHANGED=1 TAPCHECK`, or `JEV=off TAPCHECK`) to catch anything the fixes broke elsewhere.

### 4. Report

- Fixed: each finding, the file changed, and the rerun that now passes.
- Not fixed, and why: needs a decision (with the options), Jev was unsure (with the screenshot path), caused by the
  test setup, or outside what you could change.
- Anything in `tapcheck.yml` you changed, with the reason. Normally: nothing.
- The path of the last `report.html`.
