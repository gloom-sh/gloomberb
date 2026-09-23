---
name: pane-conventions
description: >-
  How Gloomberb windows and panes are built: pane anatomy, where actions,
  status, warnings and errors go, table + detail stacks, load-more lists,
  tabs, tabs with forms, information density, and the checklist for a new
  pane. Load this whenever you add or change a pane, a Ticker Research tab,
  plugin UI, a footer, status text, or any list/detail/form surface, in the
  terminal or the desktop app.
---

# Pane conventions

Every product area is a pane built from the same kit, so a user who learned
one pane has learned them all. New work drifts in the same ways each time: a
button row in the body, a fixed footer label, a row count, a list that stops
at page one, a warning paragraph above a chart, a title repeated in the body.
This file says what the app does instead. `PLUGINS.md` has the APIs.

## 1. Anatomy

**App chrome** (the shell's, never a pane's): the header holds the command
bar prompt, update notices and the market summary; the status bar at the
bottom holds layout tabs, Tidy Windows, the version chip and the
`status:widget` slot. A plugin puts a widget there only for app-wide state
that matters outside its pane (unread count, account verification). Pane data
never goes there.

**Pane chrome**, one per instance:

- Header: the title (pane def, template `createInstance`, or `usePaneTitle`
  for content-derived titles). The only place the pane names itself. Quick
  settings (`quickSettings`, `zap` icon) sit beside it; the `...` menu opens
  settings, lock, share, close.
- Body: content only. Tabs, tables, details, forms, charts.
- Footer, registered with `usePaneFooter`: `info` on the left (changing
  status), `hints` on the right (pane actions with their keys, visible only
  while focused). When AGENTS.md says "pane status bar" it means this footer.

## 2. Where does it go

| You have | It goes | Use |
|---|---|---|
| A pane action (add, edit, open source, sync, save search) | Footer hint | `usePaneFooter({ hints })` |
| Changing status (loading, error, live/delayed, stale, updated 2m ago, saving) | Footer info | `usePaneStatusFooter`, `loadingErrorFooterInfo` |
| Non-blocking data limitation (missing period, fallback dates, partial source) | One amber `⚠` in the footer, `!` or click opens details | `usePaneNoticeFooter` |
| Nothing can render yet (first load, hard failure, no data) | Body, replacing content | `PaneStatusBody` |
| No ticker, no selection, empty result | Body | `EmptyState` |
| Refresh failed but last data exists | Keep the data, failure in footer info | `loading={loading && !data}`, `error={!data ? error : null}` |
| Limitation on content still worth reading | Inline beside that content | `Notice` |
| Account state blocks the pane (signed out, unverified, plan) | Body | `SignInWall` (`cloud/auth-actions.tsx`) |
| Plan gating that only degrades the pane (delayed data, upgrade hint) | Footer, shared wording | `useCloudAccessFooter` (`shared/cloud-upgrade.ts`) |
| Retry, upgrade, or start button on an empty or failed state | Inside that state | `PaneStatusBody`/`EmptyState` `actions` |
| An operation finished (saved, exported, failed) | Toast | `notify` |
| Destructive or irreversible decision | Dialog | `ConfirmDialog`, `tone: "danger"` |
| Per-instance configuration | Pane settings via the `...` menu | `settings` on the pane def, `usePaneSettingValue` |
| Methodology, assumptions, how to use the pane | `docs/*.md` | never body text or an info button |

Nowhere: a row count as its own line, in the footer, or as "showing N of M";
the pane's own name; fixed labels; generic key hints (`j/k`, `Enter to open`,
`r to refresh`); explanatory paragraphs. The one count the kit draws is the
`Label (n)` of a sectioned table header, and that is the kit's, not yours.

## 3. Footer

- `usePaneFooter(registrationId, factory, deps)` returns `{ order?, info?, hints? }`;
  several registrations in one pane merge by `order`, then id. Wrappers:
  `usePaneStatusFooter` (loading/error), `usePaneStatusLinkFooter` (plus an
  `o` hint opening the current item's URL), `usePaneNoticeFooter` (warnings).
- Info is what changes. If a segment reads the same on every render of every
  instance, delete it.
- Hints are actions with keys. `{ key: "a", label: "dd" }` renders `[a]dd`,
  `{ key: "Ctrl+S", label: "save" }` renders `[Ctrl+S]save`. Every hint is
  clickable. Hints follow the selection: a different array when a row is
  selected, a detail is open, a tab changes. A hint with no target is omitted
  or `disabled`, never a no-op.
- `r` refreshes every pane. No per-pane refresh hint (PR #589).
- Tabs scope the footer: wrap each tab body in `PaneFooterScope active`, and
  pass `enabled: false` to wrappers for mounted but inactive views.
- Forms leave the footer alone. When the form shows Save and Cancel, the
  footer does not repeat them; Enter submits, Esc cancels. It keeps `saving`
  and the last result message.
- No toolbars in the body. A row of buttons above a table is a set of footer
  hints. Query controls are the exception: search, filters and sort go in one
  `QueryBar` in `rootBefore` (chart range and interval pickers sit above the
  plot).

## 4. Information density

- Say each thing once. The header names the pane; the body does not. A
  detail's `detailTitle` names the item; the detail body starts with metadata
  or content. If the footer leads with the ticker, its source segment does
  not repeat it.
- Units, dates and failures stay in context: currency and as-of beside the
  value, a failed source as a footer warning or a chart gap, not a paragraph.
- No standing explanations; docs are linked from README and Help.
- No count lines. The table shows the rows; scrolling shows the rest.
- Compact controls: `Button compact` with `displayLabel`, `Tabs dense` in
  narrow panes, `KeyValueRow`, `Badge` for a state word.
- Empty states are one line plus an optional `hint`.

## 5. Lists and tables

Pick by interaction: `DataTableView` (sortable columns, cursor, Enter opens),
`DataTableStackView` (same, detail in the pane), `FeedDataTableStackView`
(dated items with read state), `TickerListTableView` (the user's own
columns), `ListView` (short single-column choice), `ActionRow` (summary row
with one action or a disclosure), `buildSectionedRows` (grouped rows). Every
table has `columns`, `items`, `getItemKey`, `renderCell`, a `selection`, and
`onActivate`; header clicks sort; `tableExport: true` on the pane def adds
CSV.

**Table + detail.** `DataTableStackView` is the "list, then open one" shape:
Enter or click calls `onActivate`, the pane sets the open item, the stack
shows `← Back` plus `detailTitle` and the detail. Esc, Backspace, the mouse
back button or clicking Back pops it. Rules:

- The open item is keyed by a stable id (symbol + date, accession, id),
  never an index, and lives in `usePluginPaneState` with the selected row so
  a reload or a shared layout lands on the same row.
- Footer hints change when the detail is open; notice footers describing the
  list get `enabled: !detailOpen`.
- `prefetchDetail` warms the cache once the cursor rests; it never mutates.
- A detail the user reads and comes back from is the stack, not a dialog or
  a floating pane. A new pane (`pinTicker`, `createPaneFromTemplate`) is for
  something kept beside the list.

**Long lists.** A paged or cursored source appends on scroll and never shows
page numbers or a Load more button. `useTableLoadMore(scrollRef, canLoadMore,
loadMore)` goes into `onBodyScrollActivity` and fires within 8 rows of the
end. `loadMore` is guarded by `hasMore && !loadingMore && status === "loaded"
&& !detailOpen`, keeps an `AbortController` per request and ignores answers
from a superseded one, appends by id, and updates `hasMore`/`nextOffset`. A
new query, sort or filter aborts, resets the list and `resetScrollKey`. The
footer shows `loading more` while a page is in flight. Restoring a persisted
open item past the first page expands to that page first. Client-side "reveal
more of what is loaded" uses the same helper.

## 6. Tabs

- `Tabs` is the only tab strip: controlled, mouse, `h`/`l` and arrows while
  focused, `underline` for pane sections, `pill` for layout tabs, `bare`.
  A pane's primary strip is registered with `usePaneHeaderTabs` (above any
  early return): the desktop draws it in the pane title bar and the hook
  returns true; the terminal draws the pane's own `Tabs` as the first row of
  the body. Subtract the tab row only when it is in the body. Never in the
  footer.
- The active tab is `usePluginPaneState`. A user-configurable tab set is a
  pane setting, with `hideTabs` for panes locked to one view.
- Content, one of two ways: one body reloaded per tab when tabs are views
  over the same data (market movers), or lazy mount and keep mounted with
  `visible={false}` plus `PaneFooterScope` when tabs are different surfaces
  (Ticker Research). Never mount every tab up front.
- Labels are translated nouns.
- `SegmentedControl` is a mode inside a form or dialog, not a tab strip.
- Tabs and stacks compose: strip on top, stack below, strip stays while the
  detail is open.

## 6b. Query bar, menus, detail header

- `QueryBar` is the one row above a list: `search`, `filters` and one `view`.
  A `select` filter takes a `defaultValue` when it narrows (the chip shows a
  reset while it differs); omit it when it picks what is shown. `inline` for
  four or fewer short exclusive options, `multi`, `toggle`, `text` for a second
  field. One terminal row; on the desktop it scrolls sideways when narrow.
  Status never goes in the bar; units and as-of context may use `meta`.
- A stack detail whose content starts with a `QueryBar` gets Back and the item
  title as the bar's first segments automatically; do not add a second row.
- Every menu, dropdown and pop-up list is `MenuPopover`/`Menu` in the kit
  `Popover`. No positioned boxes, no native `<select>`.
- On the desktop, pane headers, query bars, detail bars and table header rows
  share one chrome height (`chromeRowPx()`, `--chrome-h`). Tables and details
  fill to the pane footer; do not size them with terminal row arithmetic.

## 7. Tabs with forms

- Kit fields only: `TextField`, `NumberField`, `SelectButton`, `Checkbox`,
  `SegmentedControl`, `MultiSelectDialogButton`, each with a `label`. A raw
  `Input` is not a field.
- One `activeField` names the focused input; Tab and Shift+Tab (and `j`/`k`
  outside a text input) move the ring; a click focuses. Capture input while
  a text field is focused so global shortcuts do not eat typing.
- Submit lives with the form: `Save` (`variant="primary"`) and `Cancel`
  (`secondary`) on one row at the bottom of the section they save. Enter in
  any field submits, Esc cancels. Several forms in several tabs means one
  Save per form, never one global Save. `Ctrl+S` in the footer is optional,
  for the primary form only, and never replaces the button.
- `saving` in footer info while in flight; the last result as a footer
  segment with `positive` or `negative` tone. A `Notice` under the form only
  for a field error the user must fix.
- Fixed metadata (email, plan, visibility) is body, not footer.
- A reactive form whose result updates as the user types (Kelly sizer) has no
  Save; drafts persist with `usePluginPaneState`.
- Destructive actions use `ConfirmDialog` from a `variant="danger"` button or
  a footer hint, never a bare button that acts on first press.
- A form inside a stack detail follows the same rules; Back is the navigation
  Cancel and the footer goes empty while editing.

## 8. Sidebars, loading, input

- A list of conversations, channels or documents beside the selected one is
  `PaneSidebar` on the left (`PaneSidebarRow`, `PaneSidebarAction`,
  `ActionRow` section headers), width persisted and drag-resizable,
  `shouldShowPaneSidebar` deciding whether the pane is big enough. Sidebar
  when the user switches items many times a session; stack when they open
  one, read, and go back.
- Loading: `useAsyncResource` + `useAutoRefresh` + `useUpdatedAgo`, seeded
  from `createPluginCache`. First load shows `loadingText(subject)`, a hard
  failure `unavailableText(subject)` plus the message; once data exists a
  refresh never blanks it. Start `loading` at `true` when the first frame
  would otherwise claim an empty result. Live quotes go through
  `gloomberb/quotes` and `LIVE_STREAMING_QUICK_SETTING`. Fetching lives in
  `client.ts`, projection in `view.ts`/`model.ts`, shared with the `headless`
  definition.
- Everything interactive works by mouse and keyboard through the kit.
  Pane-local keys are single unmodified letters declared as hints. Reserved:
  `j`/`k`/arrows move, Enter opens, Esc/Backspace back, `r` refresh, `!`
  warnings, `o` open source, Tab next field, `h`/`l` tabs, Ctrl+P command
  bar. Table keys go through `onRootKeyDown` and `onDetailKeyDown`; global
  shortcuts through `registerShortcut` so Help lists them.
- One component renders in the terminal, the desktop app and the web. Import
  only `gloomberb/ui`, `gloomberb/components`, `gloomberb/react`; detect the
  target with `getCurrentPluginTarget()`, not `window` or `location`. Never
  draw chrome with cell characters on the desktop (bars, chevrons, markers);
  `useUiCapabilities().nativePaneChrome` tells the renderers apart, and
  `jobs/share-bars.tsx` and `sectors/move-bar.tsx` show the terminal-only
  branch for a bar. Prefer `flexGrow`/`flexBasis={0}`/`overflow="hidden"`
  to hard heights; subtract the tab strip and `rootBefore` rows before passing
  `rootHeight`.

## 9. Checklist for a new pane or tab

1. The title is the only place the pane names itself; the body starts with content.
2. Every pane action is a footer hint with a key and works by mouse; no button row in the body.
3. Footer info is changing state only: no labels, counts, generic hints, `r`.
4. Warnings via `usePaneNoticeFooter`; blocking states via `PaneStatusBody`/`EmptyState`; refresh failures keep the last data.
5. Lists use the kit tables; details open in the stack, keyed by a stable id, persisted with `usePluginPaneState`.
6. Paged sources load more on scroll, abort stale pages, reset on a new query.
7. Tabs use `Tabs`, persist the active tab, scope their footers, mount lazily.
8. Forms use kit fields, one Save per form at its bottom, Enter/Esc, busy and result in the footer, destructive actions confirmed.
9. Per-instance configuration is a pane setting; important toggles are `quickSettings`.
10. Methodology and usage text is in `docs/`.
11. Data panes have a `headless` definition; fetching is in `client.ts`.
12. No `@opentui`, Electrobun or DOM imports; no cell-drawn chrome on the desktop.
13. A missing repeated pattern went into the kit with its callers migrated, not into the pane.

## Reference implementations

All under `src/plugins/builtin/` unless noted.

| Pattern | File |
|---|---|
| Table + stack, persisted open item | `earnings/index.tsx` |
| Feed stack with read state, restore past page one | `sec/index.tsx` |
| Load more on scroll, abort, dedupe, density comments | `research-search/pane.tsx` |
| Paged shelf with keyed first-page identity | `jobs/pane.tsx`, `jobs/pages.ts` |
| Tabs, lazy mount, `PaneFooterScope`, `hideTabs`, header tabs | `ticker-detail/pane.tsx` |
| Query bar: search, selects, toggle, header tabs | `cot/pane.tsx`, `congress-trades/filters.tsx` |
| Query bar: multi, text field, inline, view | `research-search/pane.tsx` |
| Tabs as a query over one table | `market-movers/index.tsx` |
| Tabs with forms, Save per form, Ctrl+S | `account-management/pane.tsx`, `footer.ts` |
| Form in a stack detail, empty footer while editing | `broker-manager/detail.tsx`, `footer.ts` |
| Hints that follow selection and tab | `congress-trades/footer.ts` |
| Notice footer beside status footer | `dividend-yield/pane.tsx` |
| Failure in footer, not repeated in the empty body | `cds/pane.tsx` |
| Sidebar + content | `chat/sidebar.tsx`, `cloud/askg/sidebar.tsx` |
| Footer model and rendering | `src/components/layout/pane/footer/` |
| Status, notice, empty state | `src/components/ui/status.tsx` |
| Load-more helper | `src/components/table-view-shared.tsx` |
| Stack | `src/components/data-table/stack-view.tsx`, `ui/page-stack-view.tsx` |
| Rationale in prose | `docs/research-data.md` intro, `PLUGINS.md` UI guidelines |
