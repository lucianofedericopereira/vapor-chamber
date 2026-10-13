# Accessibility

What the library guarantees to people using a keyboard, a screen reader,
magnification or reduced motion, and what only the app can do. Accessibility
is designed in, not audited after: every UI-facing change names who it could
exclude before it is built, and is done only when its WCAG criterion has a
test. The open items are in [ROADMAP.md](../ROADMAP.md).

## What the library does

- **Commands keep focus.** `v-vc-command` marks a control busy with
  `aria-disabled`, never `disabled`, which would send keyboard focus to
  `<body>`, and never `aria-busy`, which can hide a button's name. A guard
  blocks presses while in flight, never focus
  (tests/browser/command-focus.browser.test.ts).
- **Keyboard on a non-native button.** On `role="button"` the directive makes
  the element focusable and answers Enter on key down and Space on key up
  (tests/browser/command-keyboard.browser.test.ts).
- **Failures are said, not only coloured.** A failed command is announced in
  words through one shared pair of live regions per document (`announce()`,
  src/a11y.ts). `vc-error` stays for styling
  (tests/a11y-announce.test.ts, tests/browser/command-errors.browser.test.ts).
- **Navigation is announced.** The router announces each client-side page
  change and can move focus to an element the app names (`focusOnNavigate`,
  `tabindex="-1"` only when the element is not focusable). A query-only
  change moves no focus and says nothing (src/router/announce.ts).
- **The current link is marked.** `stampActiveLinks` sets
  `aria-current="page"` on the exact match only and leaves another
  `aria-current` value alone. `MenuItem.exactActive` and `Breadcrumb.current`
  are the fields to bind it to; `MenuItem.active` also lights a parent
  (tests/router/dom.test.ts).
- **Form errors point at their field.** FormBus takes a failure's field
  errors and gives each field its `aria` facts, an `errorId` and
  `firstInvalid` (tests/form-a11y.test.ts,
  tests/browser/form-errors.browser.test.ts).
- **Undo is honest.** Both histories move their stacks back when an undo or a
  redo does not land (tests/history-undo-lands.test.ts).

The library holds no words of its own beyond a failure's message. A
backend's `detail` arrives localized. An app that wants other words, or its
own status bar, replaces the announcer with `setAnnouncer`.

## What only the app can do

The words, headings, page titles (the router's `meta.title` is an i18n key
the app turns into `document.title`), a skip link (`focusOnNavigate` can
target it), images' text alternatives and colour contrast.

## Definition of done

A UI-facing feature is done when its WCAG criterion has a test: a browser
test where the platform matters, with an accessibility-tree assertion
(Playwright's role engine: name, role, state). The browser suite runs in CI,
in production and development mode.

Automation finds about half the barriers: GDS tested tools on a deliberately
inaccessible page, and the best found about half
(https://accessibility.blog.gov.uk/2017/02/24/what-we-found-when-we-tested-tools-on-the-worlds-least-accessible-webpage/).
So the main flows also get manual passes with NVDA and VoiceOver.

## Criteria the library touches

From WCAG 2.1 AA. Page content is the app's. These are the criteria a library
feature can meet or break.

| Criterion | Library piece | Status | Test |
|---|---|---|---|
| 2.1.2 no keyboard trap | the directive's in-flight guard blocks presses only, never focus | holds | command-focus.browser |
| 2.4.2 page titled | the app sets `document.title`, the announcer reads it | app | router announce tests |
| 2.4.1 bypass blocks | `focusOnNavigate` can target a skip link | app gives the link | announce test (skip link kept focusable) |
| 1.1.1, 4.1.2, 2.5.3 name kept | the directive keeps the name in flight (no `aria-busy`) | holds | command-focus.browser |
| 4.1.2 role and state | `aria-disabled` in flight, `aria-current`, FormBus `aria(field)` | holds | browser, router/dom, form-a11y |
| 2.1.1 keyboard | the directive on `role="button"` | holds | command-keyboard.browser |
| 2.5.2 action on release | the directive listens to `click` | holds | directive tests |
| 3.2.1, 3.2.2 no change on focus or input | preheat on hover or focus never navigates; a query-only navigation moves no focus | holds | announce test (query-only), router/preheat-gate (a warm-up never navigates) |
| 2.2.1 timing adjustable | a 419 refreshes the CSRF token and resends, so no user-facing expiry | holds | bridge tests |
| 4.1.3 status messages | `announce()`: the directive's failures, the router's page changes | holds for commands and the router | a11y-announce, command-errors.browser |
| 3.3.1, 3.3.3 error identified and suggested | a failure's `detail` and field; FormBus `setErrors`, `aria`, `errorId`, `firstInvalid` | holds for FormBus; focusing the first invalid field is open | form-a11y, form-errors.browser |
| 3.3.4 error prevention | both histories move back when an undo or redo does not land | holds | history-undo-lands |
| 1.4.1 not by colour alone | `vc-error` for styling, the failure also announced | holds | command-errors.browser |
| 2.2.2 pause, stop, hide | revalidation, polling and SSE update what is on screen | open: does the app get a pause? | none |
