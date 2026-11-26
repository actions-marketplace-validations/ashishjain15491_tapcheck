---
name: tapcheck-run
description: >
  Run tapcheck on a project that already has a tapcheck.yml and report what it found: failures first, each with its
  evidence, then the report's path. Use when the user says "run tapcheck", "run the e2e tests", "run the UI audit",
  "check my changes with tapcheck", "audit the app again", "only run the accessibility checks", "what does tapcheck
  cover", or after changing code in a project that has a tapcheck.yml. If there is no tapcheck.yml, use tapcheck-setup.
---

# Run tapcheck and report

## The CLI

`TAPCHECK` below stands for `<this skill's base directory>/../../bin/tapcheck` (an absolute path; the first run
installs its dependencies and a browser). Options are environment variables in front of it. Run it from the folder
that holds `tapcheck.yml`; if that file is missing, stop and use the `tapcheck-setup` skill.

If there is no `bin/tapcheck` there (the skill was copied on its own), `npx @ashishjain15491/tapcheck@<version>` is the same CLI from
npm; see the `tapcheck-setup` skill.

## 1. Choose the parts

Every suite on every side is a part, `<suite>-<side>` (`crawl-public`, `ux-customer`); `code` is the project's own
gates; each custom flow is `flow-<name>`. Each part has tags: its suite, its side, and `jev` (ux, usability) or
`measured` (everything else). `LIST=1 TAPCHECK` prints them all and marks what the other variables would select; it
starts nothing. Use it when the user asks what there is, or when you are unsure a name exists.

| The user wants | Run |
|---|---|
| nothing specific, or "check my changes" (default) | `CHANGED=1 TAPCHECK` |
| QA for a pull request or a branch: "test PR 42", "what does this branch break" | `CHANGED=origin/<base> TAPCHECK` on the PR's code (below) |
| everything, a full audit, a release check | `TAPCHECK` |
| one area: "accessibility", "security", "the admin side" | `ONLY=a11y TAPCHECK`, `ONLY=security TAPCHECK`, `ONLY=admin TAPCHECK` |
| "do the buttons, dialogs and tables work", "click through everything" | `ONLY=interact TAPCHECK` (brings its side's crawl) |
| "audit the UI", design consistency, dark mode, tablet and phone layout, design tokens | `ONLY=audit TAPCHECK` (`JEV=off` leaves out Jev's look) |
| several | `ONLY=crawl,a11y TAPCHECK` (part names or tags, comma-separated; `ONLY='flow-*'` matches a name prefix) |
| everything but something | `SKIP=usability TAPCHECK`; both together: `ONLY=customer SKIP=jev TAPCHECK` |
| no AI judgment, free, fast | `JEV=off TAPCHECK` (or `ONLY=measured`) |
| only the linters and audits | `ONLY=code TAPCHECK` (starts no app and no browser) |
| "verify this release", "check what PR 42 claims", "QA the deploy" | the `tapcheck-verify` skill (it writes a flow per release item, then `MARK=1 ONLY=verify TAPCHECK`) |
| screenshots that show where the problem is | add `MARK=1` to any of the above |
| what would run | add `LIST=1` to any of the above |

- `CHANGED=1` runs, of the chosen parts, those whose files changed since each last passed, and any that never
  passed. It needs a git repository. "Nothing to run" means nothing relevant changed: say so, and offer a full run.
  It combines with `ONLY` and `SKIP`.
- `CHANGED=<git ref>` runs the parts whose files changed since the branch point with that ref: a pull request's own
  changes, committed or not, whatever ran before. For a PR by number, get its code first: if the working tree has
  uncommitted changes, ask before switching; otherwise `gh pr checkout <number>`, take the base from
  `gh pr view <number> --json baseRefName -q .baseRefName`, `git fetch origin <base>`, and run
  `CHANGED=origin/<base> TAPCHECK`. Say which parts ran and why (the files the PR changed), and switch back to the
  user's branch afterwards. Parts that fail here may have failed before the PR too: when one does, say so only after
  checking it on the base branch, or say you didn't.
- Many flows and a long run: `PARALLEL=4 TAPCHECK` runs four flows of a side at once (flows with `serial: true` run
  alone). Use it only if the flows each make their own data and the app takes several users at once; if steps that
  pass one at a time fail together, say so and rerun those flows without it.
- `contract`, `security` and `interact` read the crawl, so choosing them brings their side's `crawl` along.
- `interact` clicks every control that isn't labelled as destructive and isn't a POST form's submit button. Run it
  against test data. If `tapcheck.yml` has `interact.submit: true` it also submits dialog forms and changes data:
  say so before the run, as for flows.
- `audit` checks only the configured screens unless `audit.max` is set; then it needs the crawl in the same run
  (`ONLY=crawl,audit`).
- Flows may submit forms and change data. If `tapcheck.yml` has `flows:` and the user didn't ask for them, say that
  they are included; `SKIP=flow` leaves them out, `RESET=1` runs `app.reset` first to start from clean data. Use
  `RESET=1` only when the user asks or has agreed: it wipes the test database.
- A side with `login: manual` opens a browser window for the user to sign in the first time; tell them before you
  start. `LOGIN=1` makes it ask again when the saved session has expired. The saved session is written again as each
  part ends, so it stays good across a long run; a side that stops as "session expired" partway needs `LOGIN=1`.
- `CONTRACT_UPDATE=1` accepts the current JSON response shapes as the new baseline. Only when the user confirms the
  API change was intended.
- If `tapcheck.yml` has `app.resetWhen`, `app.reset` runs by itself when one of those files changed since the last
  reset (the output says `Resetting (<why>)`). It wipes the test database like `RESET=1`: say so before the run when a
  matching file has changed.
- `HEADED=1` shows the browser, for a user who wants to watch; add `SLOWMO=150` (milliseconds per action) to make it
  followable and `START_DELAY=10` for a countdown before the first action. The run still ends by itself. Leave them
  off otherwise: headless is faster.
- `RECORD=1` keeps a video and a Playwright trace of every browser context. Use it when a failure can't be understood
  from its screenshot, on the failing parts only (`RECORD=1 ONLY=flow-checkout`): it makes runs slower and the run
  folder larger.
- `MARK=1` (or `marks: true` in `tapcheck.yml`) puts a marked screenshot first in the evidence of each failing or
  warning finding: a banner saying the check, and a box and a note on each element the check found (`audit`, `a11y`,
  `crawl`, `interact`, a flow's `t.mark`); what Jev judged gets the banner alone. Use it when the report is for
  people to read; it adds screenshots, not checks.
- `TAPCHECK_CONFIG=path` uses another config file.

### Jev and its cost

`ux` and `usability` ask Jev (a paid API), as does `audit` for its look at each screen, menu and dialog; they need `TYPESAFE_API_KEY` in the environment or in `.env` next to
`tapcheck.yml`. Never ask for the key in chat and never read `.env`; without a key those parts (and `audit`'s
looks) are skipped and the rest runs. A run stops asking Jev once it has spent its budget: `jev.budget` in `tapcheck.yml`, default 1 USD.
`JEV_BUDGET=0.25 TAPCHECK` sets it for one run. When the budget is reached, the part that hit it fails ("suite ran to
the end"), the remaining Jev parts are listed under Skipped in the report, and the run exits 1 even if nothing else
failed. Say that the failure is the budget, not the app, and give the `JEV_BUDGET` that would let them finish. A run
can go over the budget by one request's cost.

## 2. Run

Run the command in the foreground and give it time: a full run takes minutes (allow 10; more with many screens).
The app's own log lines are mixed into the output; tapcheck's summary table and the list of parts are at the end.
Exit code 0 means no failing finding, 1 at least one, 2 that the run could not start.

- Ends with a `Report: <dir>/report.html` line: the run completed. Go to step 3.
- Stops with `tapcheck: tapcheck.yml: <field> …`, "environment variable … is not set", "The app isn't answering" or
  "Chromium isn't installed. Run: npx playwright install chromium" (run that command, then again): the run
  didn't start. Report the message; fix `tapcheck.yml` only if the cause is plainly in it (see `tapcheck-setup`), and
  tell the user which variable to export rather than inventing a value.

## 3. Read the findings

The run folder is the one on the `Report:` line (the newest `run-*` under `out`, `.tapcheck` by default:
`ls -d .tapcheck/run-* | tail -1`). Read `findings.json` there: a list of

```json
{ "suite": "a11y", "side": "public", "where": "Home · mobile", "check": "axe: no serious violations",
  "status": "fail", "detail": "color-contrast (3 nodes) …", "evidence": [".tapcheck/run-…/public/shots/….png"] }
```

`status` is `fail`, `warn`, `info` or `pass`. `evidence` paths are relative to the folder you ran in; look at a
screenshot before describing what it shows (a `shots/marked-*.png` one has the problem boxed). A finding of a verify
flow also carries `item`, the release item it checks, and the report then opens with "Release verification". More detail per side is in the run folder: `crawl.json` (pages and link
statuses), `network.json` (every request), `axe.json`, `interact.json` (the controls, dialogs and tables exercised),
`audit.json` (every audit problem, the looks of each kind of control, styles outside the tokens), `clickstream.json`,
`missed-routes.json`, `hits.json` (what each part reached), and `code.json` (the gates' output) at the top.

After a `RECORD=1` run, `report.html` and `REPORT.md` end with a Recordings list: per side and part, the videos
(`<side>/videos/*.webm`) and the trace with its command, `npx playwright show-trace <file>`. Give the user that
command for the failing part; the trace viewer opens a window, so don't run it yourself unless asked.

### Coverage across runs

`COVERAGE=1 TAPCHECK` runs nothing. It merges the `hits.json` of every run folder under `out` into `COVERAGE.md` next
to `tapcheck.yml` (or `coverage.file`) and prints the count and each `GAP`. With `routes:` configured, every route is
listed with the part or flow step that reached it, or **GAP**; dialogs and table controls `interact` exercised follow.
Use it when the user asks what the checks cover or what is untested. A GAP is a route no part reached: propose a
screen, a flow step, or a `coverage.reasons` entry (`{match, why}`) when it is left out on purpose; don't add a reason
without the user's agreement.

## 4. Report

Keep it short and in this order:

1. One line: what ran, and the totals (failing, warnings, passing).
2. **Failures**, grouped by suite: where, what was checked, the detail, and the evidence path. Merge repeats (the
   same header missing on every page is one line). A `suite ran to the end` or `signed in` failure means a part
   stopped early: put it first, since its other checks never ran.
3. **Warnings**, briefly. A warning from `interact` (a control that did nothing) or `audit` (several looks for one
   kind of control, mixed label case, a style outside the design tokens) is measured, and usually a design decision.
   A warning from `ux` or `usability` is Jev being unsure, or a score just under 7 (5.5 to 7): it is for a person to
   look at with the screenshot, not a defect and not a pass. Say that.
4. Parts skipped or not run, and why (no key, `JEV=off`, budget reached, sign-in failed).
5. The Jev spend line the run printed (`Jev: … calls, … $0.12 of the $1 budget`), if Jev ran.
6. The path of `report.html`, for the user to open; `REPORT.md` next to it is the same in a form that pastes into a
   pull request.

Don't call a run with failures "passing", don't drop findings to make the summary tidy, and don't start fixing
unless the user asked: offer the `tapcheck-fix` skill.
