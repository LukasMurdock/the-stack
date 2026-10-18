# Building screens

Signed-in screens are built from a few shared primitives so every screen reads
and behaves the same. Follow these rules for new screens and when changing old
ones.

## Principles

- **One primary action per screen.** It sits in the page or section header
  (`PageHeader`/`Unit` `action`), usually a `FormDialog` button such as
  "New organization". Secondary and rare actions go in an `OverflowMenu` (⋯).
- **State, not narration.** Copy says where things stand ("Owner access",
  "Expires Oct 25", "No pending invitations"), not what the screen is or how to
  use it. No "This page lets you…", no success toasts when the screen already
  shows the result (creating an organization opens it).
- **Whole-row tap targets.** A row that opens something is one link with
  `unitRowClass` (at least 44px tall), not a small link inside a row. Rows with
  their own controls use `unitRowStaticClass`.
- **Phone first.** Lay out for 390px wide, then let it widen. Text wraps or
  truncates instead of overflowing; filters wrap onto a new line rather than
  scroll sideways; only tab rows (`ScrollTabs`) scroll.
- **Fills, not outlines.** Fields, search boxes and secondary buttons are a
  light gray fill (`bg-input/60`, darker on hover) with no border; only focus
  rings and invalid fields draw an edge. The primary button is the one solid
  dark control.
- **Shared primitives in `src/react-app/ui/`.** Use them before writing markup;
  add one there once two screens need the same thing.
- **A per-feature copy catalog.** Each feature keeps its strings in
  `src/react-app/features/<feature>/copy.ts`; screens pick from it. Strings
  every screen shares (retry, "More actions") are in `ui/copy.ts`.

## Primitives

| Primitive                             | Use                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `ui/PageHeader`                       | A top-level page's h1, one-line meta and at most one action.               |
| `ui/RecordHeader`                     | One record's back link, h1 and key facts; its tabs follow.                 |
| `ui/Unit`                             | A section: h2, meta, one action and its loading, empty and error states.   |
| `queryState`, `rowsState` (`ui/Unit`) | A Unit's state from a query, or from rows already loaded.                  |
| `unitRowClass`, `unitRowStaticClass`  | Rows inside a Unit's `<ul className="-mx-3">`.                             |
| `ui/LinkRow`                          | A row that opens a link in a new tab.                                      |
| `ui/StatusPill`, `ui/tone`            | A state as a labelled chip; color comes from the tone tokens in index.css. |
| `ui/OverflowMenu`                     | The ⋯ menu of secondary actions; drops stray separators.                   |
| `ui/Pagination`                       | Previous/next for a `pagedResponse` list.                                  |
| `ui/format`                           | `formatCount`, `plural`, `formatDate`.                                     |
| `forms/FormDialog`                    | A primary-action button that opens its form in a dialog.                   |
| `components/ScrollTabs`               | A sub-tab row (navigation chrome, beside the header and `nav-items.ts`).   |

A record page is `RecordHeader`, then `ScrollTabs`, then the tab's Units. A
list page is `PageHeader`, then a Unit holding the rows, then `Pagination`
outside the Unit (so a page emptied by changes elsewhere can still be left).
Start each screen component with a one-line comment saying what the user is
there to do; it keeps the screen to one job.

Not included until a screen needs them (add them to `ui/` when one does):
filter chips that wrap (`flex flex-wrap gap-2` toggle buttons), a step
progress bar, headline stat tiles, a "next step" card and an activity list.
