# Wording purposes, tasks and the audience

Three suites read these words. `ux` asks Jev whether a stranger can tell what each screen is for and whether its
wording suits the audience. `usability` gives Jev a goal and lets it click as a first-time user would, checking after
every click whether the screen it sees is the one `done` describes. Vague words give vague verdicts, so each field
has a job.

## audience

Who the app is for, as a short noun phrase that fits the sentence "words that … would use".

| Weak | Better |
|---|---|
| `users` | `a nurse on a hospital ward, using a shared tablet` |
| `customers of our platform` | `someone buying a house plant for the first time` |
| `developers and admins` | `a small-business owner doing their own bookkeeping` |

Say what they know, not what they are called in the code. One audience for the whole file; if the admin side is for
very different people, write for the side most people use.

## Screen purpose

What a person comes to this screen to do, in their words, starting with a verb. Jev is asked whether a visitor could
tell this in five seconds, and then to pick this purpose from among the other screens' purposes, so:

- make each one distinct from the others (and distinct within its first few words: only the start is used to tell
  them apart);
- describe the job, not the page: no "dashboard", "page", "view", "screen";
- keep it to one job. If a screen has two, name the main one.

| Weak | Better |
|---|---|
| `Dashboard` | `see today's appointments and which ones still need a room` |
| `Settings page` | `change who gets the weekly report` |
| `View plant` | `decide whether this plant suits a dark room` |
| `manage orders` (next to `manage order`) | `find an order by customer or date` / `check one order's items and delivery` |

The five-second test runs on the first screen of each side, so list the screen a newcomer lands on first.

## Tasks

A task is something a first-time user arrives wanting to do. tapcheck only navigates: it clicks links, tabs, menus
and buttons that open things, may type `text` into a search box, and never submits a form or saves anything. So a
task ends when the right place is **open**, not when the action is finished. It gets five clicks at most.

- `from`: where the person starts, usually the side's first screen.
- `goal`: what they want, as they would say it. Don't name the control or the menu that leads there; that is what is
  being tested.
- `done`: what is on the screen when they have arrived. It must be something a screenshot shows: a heading, a form
  with certain fields, a table with certain columns. Not "the user is on /settings/billing", not "they understand
  the pricing".
- `notDone`: every other screen, described so that it can't also be true of the `done` screen. Name the starting
  screen explicitly, since that is the one most often confused with it.
- `optimal`: the fewest clicks from `from` to the `done` screen. Count them in the app. One extra click is a warning,
  two or more a failure, so a wrong number here makes a wrong finding.
- `text` (optional): what they would type if the path goes through a search box.

Weak:

```yaml
- name: Billing
  from: /
  goal: Click Settings, then Billing.            # gives the path away
  done: The user has updated their card.         # needs a submit; not visible in one screenshot
  notDone: The user has not updated their card.  # true of every screen, including the right one
  optimal: 3
```

Better:

```yaml
- name: Find where to change the payment card
  from: /dashboard
  goal: Find where to replace the card your subscription is charged to.
  done: A screen about payment is open and shows the current card with a way to change it.
  notDone: It shows the dashboard, a settings screen without card details, or an error.
  optimal: 2
```

More `done` / `notDone` pairs that hold up:

| done | notDone |
|---|---|
| `A form for a new appointment is open, with fields for patient and time.` | `It shows the list of appointments, a calendar without a form, or an error.` |
| `One plant's own page is open, with its price and a light requirement.` | `It shows a list or grid of several plants, the home page, or an error.` |
| `Search results are listed and at least one mentions "fern".` | `It shows an empty search box, "no results", or the home page.` |

Check each pair by asking: looking at one screenshot, could both be true? Could neither? If so, tighten them.

Choose tasks that matter (what most people come for, what earns money, what support gets asked about), one to
three per side. Don't write a task whose only path is through a submit, a delete or a payment.
