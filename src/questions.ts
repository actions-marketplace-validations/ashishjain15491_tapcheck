/*
 * The questions Jev answers in the ux and usability suites. Each asks one judgment a person could make at a glance from
 * the screenshots; code (src/jev.ts and the suites) turns the answers into verdicts. The screens and tasks they are
 * asked about come from tapcheck.yml.
 */
import { box, choice, noul, score } from '@typesafe-ai/sdk';
import type { Task } from './config.ts';

// ───────────────────────────── VISUAL QA (functional verification of the rendered screen) ─────────────────────────────
export const VISUAL = {
    loaded: noul("Do `screenshots` show the screen's main content, fully loaded?", {
        true: "The screen's own content is visible: the text, data or controls it exists to show.",
        false: 'The screen is blank, still shows a loading spinner or grey placeholder blocks, or shows only a header and menu.',
    }),
    error_shown: noul('Do `screenshots` show an error message?', {
        true: "A message says something went wrong, a request failed, a page wasn't found, or the server had an error.",
        false: 'No error message is shown. An empty state such as "Nothing here yet", a hint under a field, or a notice about the data (a check that found nothing yet, a limit nearly reached) is not an error.',
    }),
    overlap: noul('In `screenshots`, do any texts or controls overlap each other?', {
        true: 'Two pieces of text, or text and a control, are drawn on top of each other so part of one is hidden or hard to read.',
        false: 'Every piece of text and every control has its own space. A menu or dialog shown on purpose above the page is not overlap.',
    }),
    clipped: noul('In `screenshots`, is any text or control cut off?', {
        true: "A word, label, button or field is cut off by the side of the screen or by its own box, so part of it can't be seen.",
        false: 'All text and controls are fully visible. Content running past the bottom of one slice into the next is not cut off.',
    }),
    raw_key: noul('Do `screenshots` show a raw translation key or placeholder instead of words, such as "settings.profile.title", "validation.required" or ":count items"?', {
        true: 'Some label, button or message shows a dotted code-like key or an unfilled :placeholder instead of normal words.',
        false: 'Every label and message reads as normal words. Web addresses, email addresses and file names are not keys.',
    }),
    misaligned: noul('In `screenshots`, are items that belong in one row or column visibly out of line?', {
        true: 'Cards, fields, labels or buttons meant to line up start or end at slightly different places, or sit at different heights.',
        false: 'Items in each row and column line up along their edges or centres.',
    }),
};

// ───────────────────────────── EMAIL (t.mail.judge in flows) ─────────────────────────────
// `screenshot` is the email as a mail program on a computer shows it, `screenshot_mobile` the same email at a phone's width.
export const EMAIL = {
    rendered: noul('Does `screenshot` show a properly laid-out email?', {
        true: 'The email shows formatted text, and any images, buttons or columns sit where a designer would put them.',
        false: 'The email shows raw HTML or code, broken image boxes, or a jumbled layout.',
    }),
    unfilled_placeholder: noul('Does `screenshot` show a placeholder that was not replaced with real data?', {
        true: 'Text such as {{first_name}}, {first_name}, [FNAME] or %name% appears in the email.',
        false: 'Every name, date and link reads as real content.',
    }),
    actions_visible: noul('In `screenshot`, is every link and button easy to see and tell apart from plain text?', {
        true: 'Each link is underlined or coloured, and each button looks like a button with a readable label. An email with no links or buttons at all also counts.',
        false: 'A link looks like plain text, a button has no visible label, or a link or button is too faint to notice.',
    }),
    mobile_readable: noul('Can the email in `screenshot_mobile` be read on a phone without zooming or scrolling sideways?', {
        true: 'The text fits the width of the screen and is large enough to read.',
        false: 'Text or images are cut off at the side, the layout is wider than the screen, or the text is too small to read.',
    }),
};
/** The yes-or-no questions above where yes is a defect. For every other one, yes is the good answer. */
export const YES_IS_DEFECT = ['error_shown', 'overlap', 'clipped', 'raw_key', 'misaligned', 'unfilled_placeholder'];

// ───────────────────────────── VISUAL DESIGN (CTA, negative space, hierarchy, legibility) ─────────────────────────────
export const DESIGN = {
    cta: score('How clear is the main action a person can take in `screenshots`?', [
        'There is no visible main action, or several actions look equally important.',
        'A main action exists but is easy to miss.',
        'The main action is visible but competes with other actions.',
        'The main action is clear, with a little competition.',
        'One main action clearly stands out, and its label says what it does.',
    ]),
    cta_label: score('How well does the label of the most prominent button in `screenshots` say what will happen when it is clicked?', [
        'The label is vague, such as "Submit", "OK" or an icon with no words.',
        'The label hints at the result but could mean several things.',
        'The label names the action but not what it acts on.',
        'The label names the action and its object, a little loosely.',
        'The label says exactly what happens, such as "Add to basket".',
    ]),
    negative_space: score('How well does the empty space in `screenshots` group related things and separate unrelated ones?', [
        'Everything is crammed together, or space is scattered so groups cannot be told apart.',
        'Some groups run into each other; space does little to separate them.',
        'Groups are mostly separated, but some areas feel cramped or oddly empty.',
        'Space groups and separates content well, with one or two cramped or loose spots.',
        'Empty space alone makes every group and its boundaries obvious, and the screen feels calm.',
    ]),
    density: choice('How much is packed into the first screen of `screenshots`?', {
        too_sparse: 'Large empty areas with little content; a person has to scroll or hunt for anything useful.',
        balanced: 'Enough content to be useful at a glance, with room to breathe.',
        too_dense: 'So much text, data or controls that it is hard to know where to look.',
    }),
    hierarchy: score('How clear is the visual hierarchy in `screenshots`?', [
        'Nothing stands out: headings, content and actions all look equally important.',
        'Some headings stand out, but the main content and the actions are hard to tell apart.',
        'The page title is clear, but secondary parts compete with the main content.',
        'The title, main content and actions are clearly ranked, with a few minor distractions.',
        'At a glance a person can tell what the screen is, what matters most and what to do.',
    ]),
    legibility: score('How easy is the text in `screenshots` to read?', [
        'Much of the text is too faint, too small or too low in contrast to read.',
        'Several labels or paragraphs are hard to read.',
        'Most text is readable, but some secondary text is faint or tiny.',
        'Nearly all text is easy to read; one or two small labels are a little faint.',
        'All text is crisp, well sized and in strong contrast with its background.',
    ]),
    spacing: score('How consistent is the spacing in `screenshots`?', [
        'Elements are crammed together or scattered with no visible rhythm.',
        'Spacing varies noticeably between elements of the same kind.',
        'Spacing is mostly regular, with some cramped or loose areas.',
        'Spacing is regular, with one or two small inconsistencies.',
        'Spacing between and around every group is even and deliberate.',
    ]),
};

// ───────────────────────────── HEURISTIC EVALUATION (the usability heuristics a screenshot can show) ─────────────────────────────
// Error recovery, undo and shortcuts for experts need interaction, so the usability suite covers them, not these.
// `audience` is tapcheck.yml's audience: who the app is for, so plain wording is judged for that reader.
export const HEURISTICS = (audience: string, context?: string) => ({
    h1_status: score('How well do `screenshots` show where the person is and the state of things (current page, saved or not, loading, counts)?', [
        'Nothing tells the person where they are or what state things are in.',
        'The current page is hard to make out and states are not shown.',
        'The current page is shown, but states such as saved, draft or loading are unclear.',
        'The current page and most states are clear.',
        'The current page, item states and any progress are all plain to see.',
    ]),
    h2_language: score(`How well does the wording in \`screenshots\` use everyday words ${audience} would use?${context ? ' The terms of their field that `product` names count as their own words.' : ''}`, [
        'Much of the wording is technical jargon, codes or internal names.',
        'Several labels use jargon or words that reader would not use.',
        'Mostly plain, with a few technical terms left unexplained.',
        'Plain everyday wording, with one or two technical terms.',
        'Every label and message reads as a person would say it.',
    ]),
    h4_consistency: score('How consistent do buttons, links, icons and headings look across `screenshots`?', [
        'Things that do the same job look different everywhere.',
        'Several buttons or links of the same kind look different.',
        'Mostly consistent, with a few odd ones out.',
        'Consistent, with one small exception.',
        'Every control of a kind looks and behaves the same way.',
    ]),
    h6_recognition: score('How well do `screenshots` let a person see their options instead of having to remember them?', [
        'The options are hidden; a person must know where to go or what to type.',
        'Most options are behind menus or icons with no labels.',
        'The main options are visible, but some are hidden behind unlabelled icons.',
        'Options are visible and labelled, with a few behind a menu.',
        'Every option the person needs here is visible and labelled.',
    ]),
    h8_minimalist: score('How free are `screenshots` of things that do not help the person with this screen?', [
        'Most of what is shown is decoration, repetition or unrelated content.',
        'Several parts add nothing and compete for attention.',
        'Some parts could go without loss.',
        'Almost everything shown is useful.',
        "Everything shown helps with the screen's job and nothing else is there.",
    ]),
    h10_help: noul('Do `screenshots` show help for a person who gets stuck, such as a help link, an explanation or an example?', {
        true: 'A help link, a hint, a short explanation or an example is visible where a person might get stuck.',
        false: 'No help, hint or explanation is visible anywhere on the screen.',
    }),
});

// ───────────────────────────── GUERRILLA TEST (the five-second test a passer-by would take) ─────────────────────────────
// The screen's real purpose is one option among the other screens' purposes, so a wrong pick means the screen misleads.
export const guerrilla = (purpose: string, others: string[]) => ({
    purpose_clear: noul(`Could a first-time visitor shown \`screenshot\` for five seconds tell that this screen is for this: ${purpose}?`, {
        true: "The title, main content and main action make the screen's job plain at a glance.",
        false: "The screen could be for several things, or its job is hidden below the fold or behind jargon.",
    }),
    purpose_pick: choice('Which job is the screen in `screenshot` for?', Object.fromEntries([purpose, ...others].map((p) => [purposeKey(p), p]))),
    trust: score('How trustworthy and professional does `screenshot` look to a first-time visitor?', [
        'It looks broken, unfinished or like a scam.',
        'It looks rough: mismatched styles or obvious glitches.',
        'It looks acceptable but plain or a little dated.',
        'It looks polished, with a small rough edge.',
        'It looks polished and trustworthy throughout.',
    ]),
});
export const purposeKey = (p: string) => p.toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

// ───────────────────────────── ATTENTION (predicted eye tracking; Box questions on jev-preview) ─────────────────────────────
// These predict where people look; they are not eye-tracking data. Each is answered on its own, so each names its rank.
export const ATTENTION_MODEL = 'jev-preview';
export const ATTENTION = {
    look_1: box('The single element on this screen that a first-time visitor looks at first.'),
    look_2: box('The element a first-time visitor looks at second, after the most eye-catching one.'),
    look_3: box('The element a first-time visitor looks at third.'),
    main_cta: box('The main button or link a person would click to do what this screen is for.'),
};
export const ATTENTION_CHECK = {
    has_cta: noul("Is there a button or link in `screenshot` that does the main job of this screen?", {
        true: 'A visible button or link starts the screen\'s main task, such as "Get started" or "Sign up".',
        false: 'No such button or link is visible; the screen only shows information or navigation.',
    }),
};

// ───────────────────────────── USABILITY TASKS (Jev picks as a first-time user would) ─────────────────────────────
// A task's `done` describes the screen that means it is reached. tapcheck only navigates: it never submits or saves.
export const TASK_Q = {
    arrived: (t: Task) => noul(`Does \`screenshot\` show this: ${t.done}`, { true: t.done, false: t.notDone }),
    can_progress: noul('Does `screenshot` show a control that would move a person toward `goal`?', {
        true: 'One of the controls in `controls` leads toward the goal, or opens the place where it starts.',
        false: 'None of the controls in `controls` leads toward the goal.',
    }),
    pick: (options: Record<string, string>) => choice('Which control in `controls` would a first-time user click next to reach `goal`, after `already_clicked`?', options),
    hesitation: noul('Would a first-time user looking at `screenshot` be unsure what to click next to reach `goal`?', {
        true: 'Several controls look equally likely, or none is labelled in a way that matches the goal.',
        false: 'One control plainly matches the goal.',
    }),
    error: noul('Does `screenshot` show an error message?'),
    // Asked about the one control about to be clicked, before the click.
    irreversible: noul('Would clicking `control` on `screenshot` delete, send, publish, pay, sign out or change saved data in a way that cannot simply be undone?', {
        true: 'The click itself would remove, send, publish, charge, sign out, or save a change for real.',
        false: 'The click only opens a page, menu, tab, dialog or form, or changes a filter or view.',
    }),
};
export const SCROLL = 'scroll_down_to_see_more';
export const MAX_STEPS = 5;
