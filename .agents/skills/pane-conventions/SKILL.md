---
name: pane-conventions
description: >-
  How Gloomberb windows and panes are built: pane anatomy (header, body,
  footer), where actions, status, warnings and errors go, table + detail
  stack, load-more for long lists, tabs, tabs with forms, sidebar layouts,
  information density, and the checklist for a new pane. Load this whenever
  you add or change a pane, a Ticker Research tab, plugin UI, a footer, status
  text, or any list/detail/form surface, in the terminal or the desktop app.
---

# Pane conventions

Gloomberb is a grid of panes. Every product area (Portfolio, Ticker Research,
SEC filings, Chat) is a pane built from the same shared kit, so a user who has
learned one pane has learned them all. New work drifts from that in the same
handful of ways every time: a toolbar of buttons in the body, a fixed label in
the footer, a "Showing 50 of 1,200" row, a list that stops at the first page,
a warning paragraph above a chart, a title repeated in the first line of the
body. This skill is the reference for what the app does instead.

Read `PLUGINS.md` (`Reusable components`, `Loading data into a pane`, and
`UI guidelines for plugins`) for the API surface. This file is about where
things go and why.

## 1. Anatomy

Two levels of chrome, and they are not interchangeable.

### App chrome (owned by the shell, not by panes)

- **Header** (top): the command bar prompt, update notices, and the live
  market summary at the right edge. Nothing else repeats the market summary.
- **Status bar** (bottom): layout tabs (personal and team groups), Tidy
  Windows, the version chip, and the `status:widget` plugin slot on the
  right. A plugin contributes a widget here only for app-wide state that
  matters outside its own pane (unread chat count, account verification,
  team activity). Pane data never goes here.

### Pane chrome (one per pane instance)

```
┌ Title                                    ⚡ ... x ┐   header: title, quick settings, action menu
│                                                   │
│ body: tabs, table, detail, form, chart            │
│                                                   │
└ ⚠ updated 2m ago · loading      [a]dd [e]dit [o]pen ┘   footer: status (left) + hints (right)
```

- **Header**: the title comes from the pane definition, the template's
  `createInstance`, or `usePaneTitle()` for content-derived titles. It is
  the only place the pane says what it is. Quick settings (`quickSettings`
  with the `zap` icon) sit next to it; the `...` menu opens pane settings,
  lock, share, close.
- **Body**: content. Tabs, tables, detail views, forms, charts. Never
  chrome.
- **Footer** (what AGENTS.md calls the pane status bar): registered through
  `usePaneFooter`. Left side is `info` (changing status). Right side is
  `hints` (pane-specific actions with their keys), shown only while the pane
  is focused.

When someone says "status bar" about a pane, they mean the footer. The app
status bar at the bottom of the window is layout navigation.

## 2. Where does it go?

| You have | Put it | Component / hook |
|---|---|---|
| A pane-specific action (add, edit, open source, sync, save search) | Footer hint, right side | `usePaneFooter(..., { hints })` |
| Status that changes (loading, error, live/delayed, stale, updated 2m ago, saving) | Footer info, left side | `usePaneStatusFooter` or `usePaneFooter(..., { info })` |
| A non-blocking data limitation (missing period, fallback dates, partial source) | One amber `⚠` in the footer; `!` or click opens the details | `usePaneNoticeFooter` |
| Nothing can render yet (first load, hard failure, no data at all) | Body replaced by the state | `PaneStatusBody` |
| No ticker / no selection / empty result | Body | `EmptyState` |
| A refresh failed but the last good data is still there | Keep the data, put the failure in the footer info | `loading={loading && !data}`, `error={!data ? error : null}`, `loadingErrorFooterInfo` |
| A limitation that applies to content that is still useful (chart drawn from partial history) | Inline, above or below the content it qualifies | `Notice` |
| The account state blocks the whole pane (signed out, unverified, plan) | Body | `SignInWall` from `src/plugins/builtin/cloud/auth-actions.tsx` |
| Feedback for an operation that finished (saved, exported, failed to send) | Toast | `ctx.notify` / `usePluginAppActions().notify` |
| A destructive or irreversible decision | Dialog | `ConfirmDialog` |
| A choice between a few options | Dialog | `ChoiceDialog`, `SelectButton` |
| Per-instance configuration (columns, symbol, hide tabs) | Pane settings, via the `...` menu | `settings` on the pane def, `usePaneSettingValue` |
| Methodology, model assumptions, how to use the pane | `docs/*.md`, never body text or an info button | |

Things that go nowhere in the UI: row counts, the pane's own name, fixed
labels ("Filings", "Results"), generic keyboard hints (`j/k to move`,
`Enter to open`, `r to refresh`), explanatory paragraphs.

## 3. Footer rules

`usePaneFooter(registrationId, factory, deps)` registers `{ order?, info?, hints? }`.
Registrations from several hooks in one pane are merged, ordered by `order`
then id. The wrappers cover the common shapes:

```tsx
// Loading / error status, nothing else.
usePaneStatusFooter({ registrationId: "cds", loading, error });

// Same, plus an `o` hint that opens the current item's source URL.
usePaneStatusLinkFooter({ registrationId: "sec", focused, url: selected?.url, source: "EDGAR", loading, error });

// Data warnings behind one amber indicator.
usePaneNoticeFooter({ registrationId: "dividend-yield", notices, focused, enabled: !detailOpen });

// Full control.
usePaneFooter("broker-manager", () => ({
  info: payload ? [{ id: "asof", parts: [{ text: `updated ${formatTimeAgo(payload.asOf)}`, tone: "muted" }] }] : [],
  hints: [
    { id: "add", key: "a", label: "dd", onPress: openAddBroker },
    { id: "edit", key: "e", label: "dit", onPress: startEdit, disabled: !selected },
  ],
}), [payload, selected, openAddBroker, startEdit]);
```

- **Info is for what changes.** `loading`, `loading more`, `error`,
  `updated 3m ago`, `delayed 15m`, `saving`, the last save message. If the
  text is the same on every render of every instance, it does not belong.
- **Hints are actions, with their key.** `{ key: "a", label: "dd" }` renders
  `[a]dd`; `{ key: "Ctrl+S", label: "save" }` renders `[Ctrl+S]save`. Every
  hint is clickable, so mouse users get the same actions. Hints are only
  visible while the pane is focused.
- **Hints follow the selection.** Return a different array when a row is
  selected, when the detail is open, when a tab changes. A hint whose target
  does not exist right now is omitted or `disabled: true`, never shown as a
  no-op.
- **`r` is global.** Every pane refreshes on `r`; do not add a per-pane
  refresh hint. See PR #589 and the comment in `shared/pane-footer.ts`.
- **Tabs scope the footer.** Wrap each tab body in
  `<PaneFooterScope active={isActive}>` so a hidden tab's registrations do
  not leak into the visible footer. Pass `enabled: false` to hook wrappers
  for views that are mounted but inactive.
- **Forms leave the footer alone.** When a form shows its own Save and
  Cancel buttons, the footer does not repeat them; Enter submits and Esc
  cancels app-wide. The footer keeps `saving` and the last result message.
  See `account-management/footer.ts` and `broker-manager/footer.ts`.
- **No toolbars in the body.** If you want a row of buttons above a table,
  you want footer hints. The exceptions are controls that change the query
  (search bars, filter bars, range/interval pickers above a chart), which
  sit in `rootBefore` above the table or above the plot.

## 4. Information density

Every cell of a pane is paid for by the user's screen. The rules:

- **Say each thing once.** The header names the pane; the body does not
  repeat it. A detail stack's title names the item (`NVDA · NVIDIA Corp`,
  the document title); the detail body starts with metadata or content, not
  with the name again. If the footer leads with the ticker, the source
  segment does not also say the ticker. Comments in `research-search/pane.tsx`
  show the reasoning at each site.
- **Units, dates and failures stay in context.** A value keeps its currency
  and its as-of date beside it. A source that failed shows as a warning in
  the footer, or a gap in the chart, not as a paragraph.
- **No standing explanations.** Methodology, model assumptions, "how this is
  calculated", "press X to do Y" all go to `docs/`. Docs are linked from the
  README and the Help pane.
- **No counts.** "12 filings", "Showing 50 of 200" are not information the
  user asked for. The table shows the rows; scrolling reveals the rest.
- **Compact controls.** `Button compact` with a short `displayLabel` for
  icon-sized actions; `Tabs dense` in narrow panes; `KeyValueRow` for label
  and value on one line; `Badge` for a state word, not a sentence.
- **Empty state text is one line.** `EmptyState title="No filings for this ticker."`
  plus an optional `hint`. Not a bulleted list of reasons.

## 5. Lists and tables

Pick the control by the interaction, not by the look:

| Rows are | Use |
|---|---|
| Sortable columns, a selection cursor, Enter opens something | `DataTableView` |
| The same, and Enter opens a detail in the same pane | `DataTableStackView` |
| A feed of dated items with read state and a detail (news, filings, tweets) | `FeedDataTableStackView` |
| The user's own ticker columns (portfolio, watchlist, screener) | `TickerListTableView` |
| A short, single-column choice list (settings, pickers, sidebars) | `ListView` |
| A summary row with one action or a disclosure (expandable section header) | `ActionRow` |
| Grouped rows with section headers | `buildSectionedRows` + `renderSectionHeader` |

Every table gets `columns`, `items`, `getItemKey`, `renderCell`, a
`selection` (`index` or `id` kind), and `onActivate`. Header clicks sort. In a
pane whose rows the user may want in a spreadsheet, set `tableExport: true` on
the pane definition and the host adds the CSV action.

### Table + detail (the stack)

The standard "list, then open one" shape is `DataTableStackView`. The table is
the root; Enter or a click on a row calls `onActivate`, the pane sets the open
item, and the stack swaps in the detail with a `← Back` row and the
`detailTitle`. Esc, Backspace, the mouse back button, or clicking Back pops
it. `PageStackView` under the hood is the same stack for non-table roots.

```tsx
const [openKey, setOpenKey] = usePluginPaneState<string | null>("openEvent", null);
const [selectedIdx, setSelectedIdx] = usePluginPaneState<number>("selectedIdx", 0);

<DataTableStackView<EarningsRow, EarningsColumn>
  focused={focused}
  detailOpen={!!openEvent}
  onBack={() => setOpenKey(null)}
  detailTitle={openEvent ? `${openEvent.symbol} · ${openEvent.name}` : undefined}
  detailContent={detailContent}
  prefetchDetail={(row) => warmDetailCache(row)}
  selection={{ kind: "index", selectedIndex: selectedIdx, onChange: (i) => setSelectedIdx(i) }}
  onActivate={(row) => setOpenKey(eventKey(row))}
  columns={columns} items={rows} getItemKey={(row) => row.key} renderCell={renderCell}
  rootWidth={width} rootHeight={height}
/>
```

- The open item and the selected row are `usePluginPaneState`, so a layout
  reload, a restart, or a shared layout lands on the same row. Key the open
  item by something stable (symbol + date, accession number, id), not by
  index.
- `detailTitle` names the item; the detail body starts with metadata.
- Footer hints change when the detail is open (`o` open source, `t` go to
  ticker) and the list's hints drop out. Pass `enabled: !detailOpen` to
  notice footers that describe the list.
- `prefetchDetail` warms the cache once the cursor rests on a row, so Enter
  is instant. It must not mark read or mutate state.
- Do not open a second pane, a dialog, or a floating window for a detail the
  user will read and go back from. The stack is the pattern. Open a new pane
  only for something the user will keep next to the list (a chart, a ticker
  research pane), through `pinTicker` or `createPaneFromTemplate`.

### Long lists: load more on scroll

A list backed by a paged or cursored source never stops at the first page and
never shows page numbers. It appends as the user scrolls:

```tsx
const tableScrollRef = useRef<ScrollBoxRenderable | null>(null);
const [hasMore, setHasMore] = useState(false);
const [nextOffset, setNextOffset] = useState(0);
const [loadingMore, setLoadingMore] = useState(false);
const moreAbortRef = useRef<AbortController | null>(null);

const loadMore = useCallback(() => {
  if (loadingMore || !hasMore || status !== "loaded") return;
  moreAbortRef.current?.abort();
  const controller = new AbortController();
  moreAbortRef.current = controller;
  setLoadingMore(true);
  void fetchPage({ offset: nextOffset }, controller.signal)
    .then((page) => {
      if (moreAbortRef.current !== controller) return;      // a newer request took over
      setItems((current) => appendUnique(current, page.items));
      setHasMore(page.hasMore === true);
      setNextOffset(page.nextOffset ?? nextOffset + page.items.length);
    })
    .catch((error) => { if (moreAbortRef.current === controller && !isAbortError(error)) setError(errorMessage(error)); })
    .finally(() => { if (moreAbortRef.current === controller) setLoadingMore(false); });
}, [hasMore, loadingMore, nextOffset, status]);

const loadMoreFromScroll = useTableLoadMore(tableScrollRef, hasMore && !loadingMore && status === "loaded", loadMore);

<DataTableStackView
  scrollRef={tableScrollRef}
  onBodyScrollActivity={loadMoreFromScroll}
  resetScrollKey={`${query}:${filters.sort}:${filters.range}`}
  ...
/>
```

- `useTableLoadMore` fires the loader when the viewport is within 8 rows of
  the end. That is the whole UI: no "Load more" button, no spinner row, no
  page counter.
- `loading more` is a muted footer info token while a page is in flight.
- A new query, sort, or filter resets the list and the scroll
  (`resetScrollKey`) and aborts any in-flight page. Guard every response
  with the controller identity so a stale page cannot append to a new list.
- Append by id (`appendUnique`) so an overlapping page does not duplicate.
- Restoring a persisted open item that sits past the first page expands the
  list to that page first (see `sec/index.tsx`).
- Client-side "reveal more of what is already loaded" uses the same helper
  with a local window size (`insider/index.tsx`). The user sees no
  difference.
- While a detail is open, loading more is off
  (`canLoadMore = hasMore && !loadingMore && !detailOpen`, see
  `earnings-calls/pane.tsx`); the list resumes when the user comes back.

## 6. Tabs

`Tabs` from the kit is the only tab strip. It is controlled (`activeValue`,
`onSelect`), supports mouse, `h`/`l` and arrow keys while focused, optional
close/add/reorder, and `variant` `underline` (default, pane sections), `pill`
(layout tabs in the status bar), or `bare`.

```tsx
const [activeTab, setActiveTab] = usePluginPaneState<TabId>("activeTab", "trades");

<Box flexDirection="column" width={width} height={height}>
  <Tabs tabs={tabItems} activeValue={activeTab} onSelect={setActiveTab} focused={focused && !inputCaptured} />
  <Box flexGrow={1} flexBasis={0} overflow="hidden">
    {body}
  </Box>
</Box>
```

- The strip is the first row of the body, full width, one cell high. It is
  never inside a bordered box and never in the footer.
- The active tab is `usePluginPaneState`, so it survives reloads and travels
  with a shared layout. If the tab set is user-configurable, that set is a
  pane setting (`usePaneSettingValue`) and the pane offers `hideTabs` for
  users who lock a pane to one view (see `ticker-detail/pane.tsx`,
  `market-movers/index.tsx`).
- Two ways to render tab content, choose one:
  1. **One body, reloaded per tab** when tabs are views over the same kind
     of data (market movers: gainers, losers, active). Switching a tab
     changes the query; the table stays.
  2. **Lazy mount, keep mounted** when tabs are different surfaces (Ticker
     Research). Mount a tab the first time it is selected, keep it mounted
     but `visible={false}` afterwards, and wrap each in
     `<PaneFooterScope active={isActive}>` so only the active tab owns the
     footer. Never mount every tab up front.
- Tab labels are nouns (`Trades`, `Members`, `Holdings`), translated with
  `t()`. No counts in labels.
- `SegmentedControl` is not a tab strip. Use it for a mode inside a form or
  a dialog (price basis, direction), where the choice is part of the input.
- Tabs and detail stacks compose: tabs above, stack below. When the detail
  is open the tab strip stays, so the user can see where they are.

## 7. Tabs with forms

Settings-like panes (Account, Team, Broker setup, Kelly sizer) put a form in
each tab. The conventions:

- **Fields from the kit only**: `TextField`, `NumberField`, `SelectButton`,
  `Checkbox`, `SegmentedControl`, `MultiSelectDialogButton`. Each gets a
  `label`. A raw `Input` is not a field.
- **Focus ring**: one `activeField` state names the focused input; Tab and
  Shift+Tab move through the ring (`j`/`k` too, outside a text input); a
  click focuses. Call `onCapture(true)`
  (Ticker Research tabs) or dispatch input capture while a text input is
  focused so global shortcuts do not eat typing.
- **Submit lives with the form.** The primary `Button label="Save"
  variant="primary"` and its `Cancel` (`variant="secondary"`) sit at the
  bottom of the section they save, on one row. Enter in any field submits
  (`onSubmit`), Esc cancels. A pane with several independent forms in
  several tabs has one Save per form, not one global Save.
- **Ctrl+S in the footer** is optional and only for the primary form of the
  pane. It does not replace the button.
- **Busy and result**: `saving` in the footer info while in flight; the last
  success or error message as a footer info segment with `positive` or
  `negative` tone. A `Notice` under the form is acceptable for a field-level
  validation error the user must fix before submitting.
- **Fixed metadata is body, not footer.** Email, plan, visibility are
  already in the tab; the footer only carries what changes.
- **Reactive forms need no Save.** A calculator whose result updates as the
  user types (Kelly sizer) persists drafts with `usePluginPaneState` and
  shows no Save button at all.
- **Destructive actions** (delete account, disconnect broker) go through
  `ConfirmDialog` with `tone: "danger"`, from a `variant="danger"` button
  at the end of the form or a footer hint, never a bare button that acts on
  first press.
- A form inside a detail stack (edit a broker) uses the same rules; the
  stack's Back is the Cancel for navigation, and the footer goes empty while
  editing (`broker-manager/footer.ts`).

## 8. Sidebar layouts

A pane that is a list of conversations, channels, or documents next to the
selected one uses `PaneSidebar` on the left: `PaneSidebarRow` for entries,
`PaneSidebarAction` for the one or two controls at its head (new, delete),
`ActionRow` for collapsible section headers. Width is persisted
(`readStoredPaneSidebarWidth`) and drag-resizable; `shouldShowPaneSidebar(itemCount, width, height)`
decides whether the pane is big enough, and has enough items, to show it at all. See `chat/sidebar.tsx` and `cloud/askg/sidebar.tsx`.

Use a sidebar when the user switches between items many times a session.
Use a stack when they open one, read it, and go back.

## 9. Loading data

```tsx
const { data, loading, error, updatedAt, load } = useAsyncResource(loadThing, { initialData: getCachedThing });
useAutoRefresh(updatedAt, load);
const updatedAgo = useUpdatedAgo(updatedAt);
usePaneStatusFooter({ registrationId: "my-pane", loading, error });

<PaneStatusBody loading={loading && !data} error={!data ? error : null}
  empty={!loading && !error && !data} subject="filings">
  ...
</PaneStatusBody>
```

- First load replaces the body with `Loading filings...` (the one phrasing,
  three dots, via `loadingText`). A failure with nothing to show replaces
  the body with `Filings unavailable.` plus the message
  (`unavailableText`).
- Once data exists, a refresh never blanks it. `loading` and `error` move to
  the footer; the stale rows stay.
- Seed from cache (`createPluginCache`, `initialData`) so a restarted app has
  something to show before the first fetch answers.
- Start `loading` at `true` when the first frame would otherwise claim an
  empty result.
- Live quotes go through `gloomberb/quotes` and the
  `LIVE_STREAMING_QUICK_SETTING` header toggle, not per-pane timers.
- Fetching and projection live in `client.ts` and `view.ts`/`model.ts` so
  the `headless` definition and the CLI (`gloomberb fn`) use the same code.

## 10. Keyboard and mouse

- Everything interactive works with both. A row is clickable, a hint is
  clickable, a tab is clickable, a footer segment with `onPress` is
  clickable. Add `cursor="pointer"` semantics through the kit, not by hand.
- Pane-local keys are single lowercase letters with no modifier, declared
  as footer hints. Reserve `j`/`k`/arrows (move), `Enter` (open), `Esc` and
  `Backspace` (back), `r` (refresh), `!` (warnings), `o` (open source),
  `Tab` (next field), `h`/`l` (tabs), `Ctrl+P` (command bar) for what they
  already mean.
- Table keys go through `onRootKeyDown` (list) and `onDetailKeyDown`
  (detail); return `true` when handled. `handleRefreshKey` covers `r`.
- Global shortcuts belong in `ctx.registerShortcut` so they appear in Help
  and can be remapped. Command-bar prefixes belong on the command or
  template's `shortcut` field; the Help pane picks them up.

## 11. Terminal and desktop

One pane component renders in the terminal (OpenTUI), the desktop app
(Electrobun), and term.gloom.sh. The kit picks the native control where one
exists (`useUiHost().Tabs`, native selects, native context menus). Rules:

- Import from `gloomberb/ui`, `gloomberb/components`, `gloomberb/react`.
  Never from `@opentui/*`, Electrobun, or the DOM in a pane.
- Never draw GUI primitives with cell characters on the desktop. Lines,
  markers, chevrons, overlays are DOM/CSS/SVG there; cell drawing is for the
  terminal renderer only. `useUiCapabilities().nativePaneChrome` tells the
  two apart when a height or padding differs.
- Heights: the pane receives `width` and `height`; subtract the tab strip
  (1) and any `rootBefore` rows before handing `rootHeight` to a table. On
  native chrome the frame flexes, so prefer `flexGrow`/`flexBasis={0}`/
  `overflow="hidden"` to hard heights.

## 12. Checklist for a new pane or tab

Before opening the PR, walk the pane against this list:

1. Title is the only place the pane names itself. Body starts with content.
2. Every action the pane owns is a footer hint with a key, and works by
   mouse. No button row in the body.
3. Footer info contains only changing state. No labels, no counts, no
   generic hints, no `r` hint.
4. Data warnings go through `usePaneNoticeFooter`; blocking states through
   `PaneStatusBody`/`EmptyState`; refresh failures keep the last data.
5. Lists use `DataTableView`/`DataTableStackView`/`ListView`. Details open
   in the stack, keyed by a stable id, persisted with `usePluginPaneState`.
6. Any paged source loads more on scroll, aborts stale pages, resets on a
   new query.
7. Tabs use `Tabs`, persist the active tab, scope their footers, and mount
   lazily.
8. Forms use kit fields, one Save per form at its bottom, Enter/Esc, busy
   and result in the footer, destructive actions confirmed.
9. Per-instance configuration is a pane setting, reachable from the `...`
   menu; important toggles are `quickSettings`.
10. Methodology and usage text is in `docs/`, linked, not rendered.
11. The pane has a `headless` definition when it shows data, and fetching is
    in `client.ts`.
12. No `@opentui`, Electrobun, or DOM imports; no cell-drawn shapes on the
    desktop.
13. A missing repeated pattern was added to the kit and its callers
    migrated, not reimplemented locally.

## Reference implementations

| Pattern | File |
|---|---|
| Table + stack, persisted open item | `src/plugins/builtin/earnings/index.tsx` |
| Feed stack with read state, restore past first page | `src/plugins/builtin/sec/index.tsx` |
| Load more on scroll, abort, append unique, density comments | `src/plugins/builtin/research-search/pane.tsx` |
| Paged shelf with keyed first-page identity | `src/plugins/builtin/jobs/pane.tsx`, `jobs/pages.ts` |
| Tabs, lazy mount, `PaneFooterScope`, `hideTabs` | `src/plugins/builtin/ticker-detail/pane.tsx` |
| Tabs as query over one table | `src/plugins/builtin/market-movers/index.tsx` |
| Tabs with forms, Save per form, Ctrl+S | `src/plugins/builtin/account-management/pane.tsx`, `footer.ts` |
| Form in a stack detail, empty footer while editing | `src/plugins/builtin/broker-manager/detail.tsx`, `footer.ts` |
| Contextual footer hints by selection and tab | `src/plugins/builtin/congress-trades/footer.ts` |
| Notice footer beside status footer | `src/plugins/builtin/dividend-yield/pane.tsx` |
| Failure reason in footer, not repeated in empty body | `src/plugins/builtin/cds/pane.tsx` |
| Sidebar + content | `src/plugins/builtin/chat/sidebar.tsx`, `cloud/askg/sidebar.tsx` |
| Footer model and rendering | `src/components/layout/pane/footer/` |
| Status, notice, empty state | `src/components/ui/status.tsx` |
| Load-more helper | `src/components/table-view-shared.tsx` |
| Stack | `src/components/data-table/stack-view.tsx`, `ui/page-stack-view.tsx` |
| Written rationale for the density rules | `docs/research-data.md` (intro), `PLUGINS.md` (UI guidelines) |
