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

## 1. Choose the parts

Every suite on every side is a part, `<suite>-<side>` (`crawl-public`, `ux-customer`); `code` is the project's own
gates; each custom flow is `flow-<name>`. Each part has tags: its suite, its side, and `jev` (ux, usability) or
`measured` (everything else). `LIST=1 TAPCHECK` prints them all and marks what the other variables would select; it
starts nothing. Use it when the user asks what there is, or when you are unsure a name exists.

| The user wants | Run |
|---|---|
| nothing specific, or "check my changes" (default) | `CHANGED=1 TAPCHECK` |
| everything, a full audit, a release check | `TAPCHECK` |
| one area: "accessibility", "security", "the admin side" | `ONLY=a11y TAPCHECK`, `ONLY=security TAPCHECK`, `ONLY=admin TAPCHECK` |
| several | `ONLY=crawl,a11y TAPCHECK` (part names or tags, comma-separated; `ONLY='flow-*'` matches a name prefix) |
| everything but something | `SKIP=usability TAPCHECK`; both together: `ONLY=customer SKIP=jev TAPCHECK` |
| no AI judgment, free, fast | `JEV=off TAPCHECK` (or `ONLY=measured`) |
| only the linters and audits | `ONLY=code TAPCHECK` (starts no app and no browser) |
| what would run | add `LIST=1` to any of the above |

- `CHANGED=1` runs, of the chosen parts, those whose files changed since each last passed, and any that never
  passed. It needs a git repository. "Nothing to run" means nothing relevant changed: say so, and offer a full run.
  It combines with `ONLY` and `SKIP`.
- `contract` and `security` read the crawl, so choosing them brings their side's `crawl` along.
- Flows may submit forms and change data. If `tapcheck.yml` has `flows:` and the user didn't ask for them, say that
  they are included; `SKIP=flow` leaves them out, `RESET=1` runs `app.reset` first to start from clean data. Use
  `RESET=1` only when the user asks or has agreed: it wipes the test database.
- A side with `login: manual` opens a browser window for the user to sign in the first time; tell them before you
  start. `LOGIN=1` makes it ask again when the saved session has expired.
- `CONTRACT_UPDATE=1` accepts the current JSON response shapes as the new baseline. Only when the user confirms the
  API change was intended.
- `TAPCHECK_CONFIG=path` uses another config file.

### Jev and its cost

`ux` and `usability` ask Jev (a paid API) and need `TYPESAFE_API_KEY` in the environment or in `.env` next to
`tapcheck.yml`. Never ask for the key in chat and never read `.env`; without a key those parts are skipped and the
rest runs. A run stops asking Jev once it has spent its budget: `jev.budget` in `tapcheck.yml`, default 1 USD.
`JEV_BUDGET=0.25 TAPCHECK` sets it for one run. When the budget is reached the remaining Jev parts are skipped and
marked so; mention it and the `JEV_BUDGET` that would let them finish.

## 2. Run

Run the command in the foreground and give it time: a full run takes minutes (allow 10; more with many screens).
The app's own log lines are mixed into the output; tapcheck's summary table and the list of parts are at the end.
Exit code 0 means no failing finding, 1 means at least one, or that the run could not start.

- Ends with a `Report: <dir>/report.html` line: the run completed. Go to step 3.
- Stops with `tapcheck.yml: <field> …`, "environment variable … is not set", or "The app isn't answering": the run
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
screenshot before describing what it shows. More detail per side is in the run folder: `crawl.json` (pages and link
statuses), `network.json` (every request), `axe.json`, `clickstream.json`, `missed-routes.json`, and `code.json` (the
gates' output) at the top.

## 4. Report

Keep it short and in this order:

1. One line: what ran, and the totals (failing, warnings, passing).
2. **Failures**, grouped by suite: where, what was checked, the detail, and the evidence path. Merge repeats (the
   same header missing on every page is one line). A `suite ran to the end` or `signed in` failure means a part
   stopped early: put it first, since its other checks never ran.
3. **Warnings**, briefly. A warning from `ux` or `usability` is Jev being unsure: it is for a person to look at with
   the screenshot, not a defect and not a pass. Say that.
4. Parts skipped or not run, and why (no key, `JEV=off`, budget reached, sign-in failed).
5. The Jev spend line the run printed (`Jev: … calls, … $0.12 of the $1 budget`), if Jev ran.
6. The path of `report.html`, for the user to open; `REPORT.md` next to it is the same in a form that pastes into a
   pull request.

Don't call a run with failures "passing", don't drop findings to make the summary tidy, and don't start fixing
unless the user asked: offer the `tapcheck-fix` skill.
