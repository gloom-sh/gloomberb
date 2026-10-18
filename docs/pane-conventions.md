# Pane conventions

Every product area is a pane built from the same kit, so a user who learned
one pane has learned them all. New work drifts in the same ways each time: a
button row in the body, a fixed footer label, a row count, a list that stops
at page one, a warning paragraph above a chart, a title repeated in the body.
This file says what the app does instead. [PLUGINS.md](../PLUGINS.md) has
the APIs.

## Principles

These come first. Each is one rule, and a change that breaks one is wrong,
not the rule. Details follow below.

1. **One element, one look.** Every kind of element (button, tab, chip,
   input, table, heading, empty or locked state, notice) has exactly one
   convention, defined once in the shared kit. A pane never has its own.
2. **Same role, same size.** Type size, weight, colour, spacing, radius and
   borders come from tokens by role (body, heading, metadata, label,
   positive, negative). No raw px, hex or font-size in pane or plugin code.
3. **Levels differ on purpose.** Neighbouring levels differ by at least about
   15% in size, or by weight, colour and space. A step of 1 or 2 px reads as
   a mistake.
4. **Extend the kit, never fork it.** If the kit lacks what a pane needs, add
   it to the kit for every pane and migrate the callers. Never a pane-local
   variant.
5. **Plugins are panes.** Built-in and external plugins follow every rule
   here and use the same components. No plugin ships its own look.
6. **Change the class, test the whole app.** A UI change is made in the
   shared component and checked against all panes and plugins before it
   merges: before and after sheets of every view, not only the pane that
   prompted it. A change that moves views it should not touch is wrong.
7. **Look next to the neighbours.** A pane must look like it belongs beside
   the news reader, a table pane and a form pane at the same width. If you
   can tell it apart by its style rather than its content, fix it.
8. **Exceptions are written down.** A real deviation (a dense table, a chart
   axis) goes in the allowlist with a reason a reviewer accepted. No reason,
   no exception.
9. **The browser lays out the desktop and web.** Flex, wrapping and ellipsis,
   not cell counts. The terminal keeps its own cell layout, byte for byte.

A UI change says in its description what it was checked against: all views,
both themes, a narrow and a wide pane. Rules 2, 6 and 8 are enforced by CI as
the checks land (Linear GLO-768); until a check exists, the reviewer enforces
them.

## Design system (desktop and web)

The conventions below are the principles in numbers. Each family is one
shared component; a pane that needs something else extends the component.
The terminal keeps its own cell layout and takes none of these values.

### Tokens

Defined once: CSS variables in `src/renderers/dom/styles.css` (on `body`)
and TS constants in `src/theme/ui-tokens.ts` (`TYPE`, `WEIGHT`, `SPACE`,
`RADIUS`). Colour roles are set per theme by `src/theme/colors.ts`.
Style with `var(--gloom-…)`, never a number of your own.

| Token | Value | Use |
|---|---|---|
| `--gloom-type-caption` | 10px | key caps only |
| `--gloom-type-ui` | 12px | everything that is not reading text: chrome, tables, controls, tabs, footers, labels, metadata |
| `--gloom-type-body` | 14px, line height 1.6 | reading text in a reader column |
| `--gloom-type-heading` | 16px bold | a heading in reading text |
| `--gloom-type-title` | 20px bold | a reader's title, a pane's lead figure |
| `--gloom-weight-regular`, `-bold` | 400, 700 | the only two weights |
| `--gloom-space-xs/sm/md/lg/xl` | 4, 8, 12, 16, 24px | gaps, padding, margins |
| `--gloom-inset` | one cell (8px) | a pane body's inset on every side |
| `--gloom-radius-sm/md/lg/full` | 3, 6, 8, 999px; bars and tables 0 | small marks (key caps, chips); controls; floating surfaces; dots |
| `--gloom-hairline` | text at 14% | every rule inside the app: bars, footer, status bar, menus, dividers |
| `--gloom-hover-fill` | bright text at 8% | the pointer over a control, a menu item, a hint |
| `--gloom-band` | bright text at 3.5% | the query bar, stack header and figure bands |
| `--gloom-elevation` | `0 12px 32px` bg at 48% | the one shadow, for floating surfaces and floating panes only |
| `--gloom-surface-raised` | panel toward bg | dialogs, menus, popovers, toasts, the command bar, cards |
| `--gloom-surface-sunken` | bg | inside a field, a select, a checkbox |
| `--gloom-control-border` | border toward the accent | buttons, fields, selects, floating surfaces |
| `--gloom-accent` | border-focused | focus, the active tab's underline, a chosen control |
| `--gloom-link`, `--gloom-link-hover` | text, bright text | links |
| `--gloom-error` | negative | errors |
| `--gloom-locked` | dim text | the lock of a locked or Pro state |

Levels step by at least about 15% in size (12, 14, 16, 20) or differ by
weight and colour. 14 to 16 is 14%, so a reading heading is also bold,
bright and set off by space; the lead is the body size, bright. A reader
column under 480px steps every reading level down together (13.2px body).

### Families

| Family | The convention (component) |
|---|---|
| Buttons (`Button`, `IconButton`) | Four kinds, one radius (`md`), no shadow. Primary: accent fill, bold. Danger: the same in negative. Secondary: 1px control border, regular. Ghost (`ghost`, `plain`): text that takes the hover fill. Icon: 20×18, hover fill; a tab's close mark and a chart's tool are icon buttons. Height one row (18px), a bar's controls the bar's 20px. A chosen button takes the selection fill. What a settings row does when pressed is a secondary button; its current value is a chip. |
| Tabs, segmented choices (`Tabs`, `SegmentedControl`, query bar choices) | One look: 12px text, 8px padding, no box and no radius; inactive dim, hover the text colour, active bright and bold on a 2px accent underline. Title-bar tabs, sub-tabs and segmented choices are the same. |
| Chips (`Badge`, ticker chips) | 16px in an 18px row, `sm` radius, 8px padding, a subtle fill, the tone in the text. Regular weight; tickers bold. A chip that is chosen (a filter that is on) is the solid tone with the background colour in its text. A chip is a mark: a word drawn without a fill or a border is text, and a pressable one is a ghost button. |
| Key caps | 14px tall, caption size, `sm` radius, a 1px ring and a faint fill mixed from the text colour around it. |
| Fields and selects (`TextField`, `SelectField`, `SelectButton`) | One row tall, sunken fill, 1px control border, `md` radius, 8px padding; focused or open, the accent border (`fieldFrameStyle` for a field a pane frames itself, such as a text area). In a query bar they are its segments. A select in a form is `SelectButton variant="form"`: the label bold above the field, as a text field's. A search strip (`InputSearchBar` `strip`) is the band with the field's text at the inset. A block of code to copy is sunken too, `md` radius, 8 by 12px inside. |
| Checkbox | 14px, `sm` radius, control border, sunken fill; checked, the accent. |
| Links (`ExternalLinkText`) | The text around them, underlined; bright under the pointer or focus. |
| Toolbars (`QueryBar`) | The band: 20px, hairline under it, segments split by hairlines with 8px padding, the first one at the inset. |
| Tables (`DataTable`) | Header 20px, bold dim on a fill; rows 18px, cell padding 0 8px; hover fill on rows; selection fill on the chosen row. No zebra. A table inside a column of prose (HELP's Basics) drops its cell padding so its rows line up with the text. |
| Key-value rows (`KeyValueRow`, `StatGrid`, `FieldGrid`) | 18px rows, label dim, value regular or bold; no rule between rows. Grid bands keep their hairline below and between cells. |
| Section headings (`SectionHeading`) | 12px bold bright in data panes; 16px in readers. |
| Cards (`Card`, `cardSurfaceStyle`) | Raised surface, 1px hairline, `md` radius, 8px inside; chosen, the accent border. For a unit of content (a quote tile, a flow step, a company to pick), never for rows. A card that belongs to a colour (a relationship's role, a series) takes `accent`: a 2px rule down its left edge and the fill tinted toward it. A card that must be its own positioned box (a diagram node) draws `cardSurfaceStyle` and keeps its own rows. |
| Quotes (`quoteBlockStyle`) | A quoted passage (a filing, a disclosure): the 2px rule of the colour it belongs to (the accent by default), a faint tint of it, 4 by 12px inside. |
| Tooltips (`TOOLTIP_SURFACE_STYLE`) | What the pointer is over on a chart, map or heat map: the floating surface at its small size, raised fill, control border, `lg` radius, the elevation, 4 by 8px inside, 12px text. It never takes the pointer. A key that belongs to a chart (a legend's) is the same surface without the elevation (`FLAT_SURFACE_STYLE`). |
| Lists (`ListView`) | Rows 18px, `md` radius, 8px padding, hover fill. The chosen row is filled; a list a dialog's keyboard walks also rings it in the accent (`selection="frame"`, the default), one inside the command bar is filled alone, as the command bar's rows are (`selection="fill"`). |
| States (`EmptyState`, `PaneStatusBody`, `Spinner`, `Notice`, walls) | At the inset (8px from each edge); the message dim, an error in negative, actions under it. Loading is the one spinner and "Loading …". Locked: the lock in the locked colour, the action bright. An `EmptyState` that finds itself flush with its pane's edge (a tab body with no padding of its own) takes the inset itself, so a pane that already pads it is not padded twice. |
| Pane chrome | Title bar 20px, title 12px bold whatever the focus (focus changes colour, never weight), 8px inset, hairline below (accent when focused). Footer 20px, 12px, hairline above; hints are ghost buttons: key bright, word dim. Detail back row: the band, Back as its first segment. |
| Shell | App header and status bar at 12px, theme text roles (no greys of their own); status bar items are ghost buttons. |
| Dialogs, menus, popovers, toasts, command bar | One floating surface: raised fill, 1px control border, `lg` radius, the elevation shadow; 16px inside a dialog, 4px inside a menu; menu items a row with 4px above and below (26px), `md` radius, hover fill. |
| Readers (`ArticleReader`, `DetailReader`, Docs, `MarkdownText`) | One column, centred at 66ch of the reading size, the pane's inset on each side, 12px above and 16px below; title 20, headings 16 bold bright (a list's label too), body and lead 14 at line height 1.6, metadata and label and value facts 12. One paragraph gap (0.9em) after every block; a section heading 0.9em of its size above and 0.4em below. Every prose bullet (an article's key facts and lists, markdown and Docs lists) is body text: 14, a dim dot, the text hanging 2ch in, no space between items. The pane chrome check `readers:` holds the three to this. |
| Chart chrome | Legends and axes 12px dim; a legend over a map or chart sits at the inset. A chart drawn as a stretched SVG puts its labels in HTML over it, so they keep the app's type. Labels a heat map, treemap or map fits to its own shapes are allowed to size themselves. |

### Exceptions

A value written out instead of taken from a token (a font size, a weight
other than 400 and 700, a corner radius, a drop shadow, and in DOM-only code
a grey) is counted per file by `src/architecture/ui-literals.test.ts`. A file
may keep what `src/architecture/ui-literals-allowlist.json` records for it,
and every entry says why:

```json
"src/plugins/builtin/gpu/ladder.tsx": {
  "literals": { "radius": 4 },
  "why": "Ladder rungs, ranges and markers are data marks."
}
```

The count can only go down: `bun scripts/update-ui-literals-allowlist.ts`
lowers it after a cleanup and lists files that still need a reason. A
reviewer accepts a reason when the value belongs to the data rather than to
the chrome: data marks (bars, swatches, flags, markers), labels fitted to a
chart's shapes, pages drawn without the app's styles. Every pane is on the
kit; chat has its own owner and its entries say so.

### Seeing it

`bun run kit:page` serves the kit page: every family in every state, in the
white and paper themes, at any width (`scripts/pane-chrome/kit-page.ts`;
`--shots` writes one picture per family at 640 and 1280px). It is the
benchmark a UI change is compared against; `bun run audit:ui` measures the
whole app against it and `bun run audit:ui:compare --before <run> --after <run>`
says how far two runs differ, family by family (CONTRIBUTING.md).

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
- Header zone: the top of the body, in this order and nothing else: the
  `QueryBar` (search, filters, view), then a `StatGrid` of summary figures,
  then content. The title-bar tabs, the bar and the figures read as one
  surface: tabs are text on an underline, the bands share one fill.
  No loose text lines, blank rows or button rows above or between them.
- Footer, registered with `usePaneFooter`: `info` on the left (changing
  status), `hints` on the right (pane actions with their keys, visible only
  while focused). When AGENTS.md says "pane status bar" it means this footer.

## 2. Where does it go

| You have | It goes | Use |
|---|---|---|
| A pane action (add, edit, open source, sync, save search) | Footer hint | `usePaneFooter({ hints })` |
| Changing status (loading, error, live/delayed, stale, updated 2m ago, saving) | Footer info | `usePaneStatusFooter`, `loadingErrorFooterInfo` |
| Summary figures for the whole pane or an open detail (VWAP, spread, percentile, range) | Header zone, under the query bar | `StatGrid` |
| A control that changes what the pane shows (range, window, scope, level) | Query bar, never a cycling footer hint | `QueryBar` |
| Non-blocking data limitation (missing period, fallback dates, partial source) | One amber `⚠` in the footer, `!` or click opens details | `usePaneNoticeFooter` |
| Nothing can render yet (first load, hard failure, no data) | Body, replacing content | `PaneStatusBody` |
| No ticker, no selection, empty result | Body | `EmptyState` |
| Refresh failed but last data exists | Keep the data, failure in footer info | `loading={loading && !data}`, `error={!data ? error : null}` |
| Limitation on content still worth reading | Inline beside that content | `Notice` |
| Account state blocks the pane (signed out, unverified, plan) | Body | `SignInWall` (`cloud/auth-actions.tsx`) |
| Plan gating that only degrades the pane (delayed data, upgrade hint) | Footer, shared wording | `useCloudAccessFooter` (`shared/cloud-upgrade.ts`) |
| Retry (or look again) from an empty or failed state | Inside that state, first, so it answers Enter | `PaneStatusBody`/`EmptyState` `retry` |
| Upgrade or start button on an empty or failed state | Inside that state | `PaneStatusBody`/`EmptyState` `actions` |
| An operation finished (saved, exported, failed) | Toast | `notify` |
| Destructive or irreversible decision | Dialog | `ConfirmDialog`, `tone: "danger"` |
| Per-instance configuration | Pane settings via the `...` menu | `settings` on the pane def, `usePaneSettingValue` |
| Methodology, assumptions, how to use the pane | `docs/*.md` | never body text or an info button |

Nowhere: a row count as its own line, in the footer, in a tab label, or as "showing N of M";
the pane's own name; fixed labels; generic key hints (`j/k`, `Enter to open`,
`r to refresh`, a sidebar's `<`/`>`, a key that focuses a message field Enter
already focuses); explanatory paragraphs; the data provider.

**The data provider is invisible.** Never show which vendor or internal
route served the data: no `provider:gloomberb-cloud`, `gloomberb-cloud`,
raw feed names or `entry.source` values
in a footer, status line, header meta, table column, legend, tooltip or
headless report column. Say what the data is instead: `real-time`,
`15m delayed`, `settlement`, `daily closes`, `trade closes since …`, `as of`
date, `stale`. `QueryEntry.source` and `providerId` are for routing, caches
and tests, never for display. Two things are not providers and may appear:
the user's own account or imported source (a broker account, a statement
file), and the official publisher of a statistic in a detail view or its
`o` link (a FRED series id, BIS, CFTC report type, SEC form). Gloom Cloud is
named only for account and plan state (sign in, verify, upgrade), never as
the origin of a number. The one count the kit draws is the
`Label (n)` of a sectioned table header, and that is the kit's, not yours.

## 3. Footer

- `usePaneFooter(registrationId, factory, deps)` returns `{ order?, info?, hints? }`;
  several registrations in one pane merge by `order`, then id. Wrappers:
  `usePaneStatusFooter` (loading, error, stale), `usePaneStatusLinkFooter` (plus an
  `o` hint opening the current item's URL), `usePaneNoticeFooter` (warnings).
- Info is what changes. If a segment reads the same on every render of every
  instance, delete it.
- Hints are actions with keys. `{ key: "a", label: "dd" }` renders `[a]dd`,
  `{ key: "Ctrl+S", label: "save" }` renders `[Ctrl+S]save`. Every hint is
  clickable. Hints follow the selection: a different array when a row is
  selected, a detail is open, a tab changes. A hint with no target is omitted
  or `disabled`, never a no-op.
- A key that only repeats what Enter already does, or that adjusts the
  layout rather than acting on what the pane shows, is not drawn: it goes in
  `keys`, which binds it, and in `menu` with its `accelerator`, which lists
  it. `PaneSidebar` does this for `<` and `>`; Chat does it for Compose.
- `r` refreshes every pane. No per-pane refresh hint (PR #589). Built-in
  panes bind it with `usePaneRefreshKey(reload, { focused })`, or with
  `handleRefreshKey` inside a table's key handler.
- Tabs scope the footer: wrap each tab body in `PaneFooterScope active`, and
  pass `enabled: false` to wrappers for mounted but inactive views.
- Forms leave the footer alone. When the form shows Save and Cancel, the
  footer does not repeat them; Enter submits, Esc cancels. It keeps `saving`
  and the last result message.
- No toolbars in the body. A row of buttons above a table is a set of footer
  hints. Query controls are the exception: search, filters and sort go in one
  `QueryBar` in `rootBefore` (chart range and interval pickers sit above the
  plot). A body `Button` belongs only to a form (Save, Cancel) or to an empty
  or failed state's `actions`; never full width, never beside a heading. A
  toggle that acts on click looks like one (`Checkbox`, a query bar toggle).

## 4. Information density

- Say each thing once. The header names the pane; the body does not. A
  detail's `detailTitle` names the item; the detail body starts with metadata
  or content. If the footer leads with the ticker, its freshness segment
  (`15m delayed · 14:47 UTC`) does not repeat it.
- Units, dates and failures stay in context: currency and as-of beside the
  value, a failed input as a footer warning or a chart gap, not a paragraph.
- No standing explanations; docs are linked from README and Help.
- No count lines. The table shows the rows; scrolling shows the rest.
- Summary figures are a `StatGrid`, not stacked `KeyValueRow`s or `Text`
  lines: a short label, the value, muted `detail` (percentile, date,
  window). Drop sample sizes ("252 obs"), dates the footer already carries,
  and anything the title, the active tab or the selected row shows.
- Compact controls: `Button compact` with `displayLabel`, `Tabs dense` in
  narrow panes, `KeyValueRow`, `Badge` for a state word.
- Empty states are one line plus an optional `hint`.

## 5. Lists and tables

Table header labels are uppercased by the kit; write them in any case.
Section headings read in title case, bright and bold: the kit capitalises
lower-case words, so write acronyms in capitals and never a whole heading in
capitals. Pass `onHeaderClick` only when the table sorts (without it headers
are not interactive), and `selection={{ kind: "none" }}` for a static table.
A section header can carry one quiet `action` at its right end for the whole
group, such as the preset its rows are set to (the Plugins pane's starter
pack); it is a setting you apply, not a filter, and it also gets a footer key.
Never build a table from padded `Text` rows: the kit gives the header band,
gutters and fill to the footer. A few rows of figures inside a section (an
overview's positions, a quote book, label and value pairs in columns) are a
`ColumnGrid`: the terminal sets the columns at the cells you give them, and
the desktop lays them out as one CSS grid counted in characters, so they
follow a resize to the pixel and line up with their header. Text that can be
wider than its track (a column that shrinks to `growFrom`) is clipped at the
track at every frame of a resize, ending in an ellipsis.

Pick by interaction: `DataTableView` (sortable columns, cursor, Enter opens),
`DataTableStackView` (same, detail in the pane), `FeedDataTableStackView`
(dated items with read state), `TickerListTableView` (the user's own
columns), `ListView` (short single-column choice), `ActionRow` (summary row
with one action or a disclosure), `buildSectionedRows` (grouped rows). Every
table has `columns`, `items`, `getItemKey`, `renderCell`, a `selection`, and
`onActivate`; header clicks sort; `tableExport: true` on the pane def adds
CSV. A table that colors its cells passes `selectedTextOverridesCellColor`
so the selected row reads in the selection color without each cell checking
`rowState.selected`; a cell whose tone must survive the selection sets
`keepColorWhenSelected`. Custom `content` still takes its colors from
`rowState`. Artwork before a label on the desktop and web, such as a flag,
goes in a cell's `leading` or a column's `headerLeading`: the terminal skips
it, the text keeps its own selection color, and exports read only the text.

**A table set inline.** A short table that sits in a page between prose (keys in Help, a plan comparison) takes `fitRows` with `virtualize={false}`: the terminal gives it its rows, the desktop and the web make it exactly as tall as its header and rows, where a count of rows is short by the taller header bar. Its box takes no height there either.

**The body under a bar.** What sits under a pane's tabs, query bar and figures takes the rest of the pane by flex on the desktop and the web: spread `FILL_REST` (`components/ui/fill.ts`) on its box, and on the pane's own root box, instead of the rows the terminal counts. A chrome bar is taller than a row there, so a body given `height - 1` rows runs past the footer by the difference. Tables, charts and the 3D surface in that box fill it to the footer. `SeriesListDetail` does this for a series list beside its detail. A pane that shows other panes as views under its own bars (Fixed Income) puts each in a box with `data-gloom-role="nested-pane-content"`, and the view's root takes that box the way a pane's root takes the pane.

**Text that may not fit.** One line that can run past its room (a name in a table cell, a heading, a read under a chart) is `ClippedText`, or `SectionHeading` with a `width`: the terminal cuts it at a count of cells, the desktop and the web at the box's edge in CSS with an ellipsis. Siblings that must stay whole (a ticker, a kind badge) keep their room and the text gives way. Never pass a string already cut with `truncateToDisplayWidth` to a DOM render. `ClippedText` takes the caller's own terminal cut (`cut={truncateWithEllipsis}`) so the terminal frame stays as it was, a `lead` kept whole before the text, and `wrap` for a message or description the desktop should wrap rather than cut. An optional item that shows only when it fits beside the rest (a ticker after a name) goes in a row with `flexWrap: "wrap"`, one line tall and clipped: the browser moves what does not fit to the hidden line, as the terminal's count of columns dropped it.

**Against the right edge.** On the desktop and the web, whatever sits against a row's right edge (a track between two figures, a hint at the end of the footer, a figure at the end of a line) is placed by CSS in the box the row gives it. A box sized in cells keeps the cells its pane last rendered at until the next catch-up, so its right edge stays where the pane's was, past the new edge or short of it, for up to a tenth of a second of a resize, and the row jumps then. `RangeTrack` takes `fill` for a track that takes the room of its box; short pairs that wrap (a return strip) are a row with `flexWrap: "wrap"`, not rows packed by a count of cells. `check:pane-chrome` steps jump a pane's edge in one move and fail on a piece that is not where CSS puts it on the first frame.

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
- A detail read as text sits in a `DetailScrollBody` whose ref is the
  stack's `detailScrollRef`, so j/k step it a line at a time and the next
  item starts at the top. An item's facts and text read through
  `DetailReader` (`src/components/reader/detail-reader.tsx`): label and value
  pairs, then the text in short paragraphs in the reader's type, in the one
  reader column on the desktop and the web. `FeedDataTableStackView` takes the
  facts as `detailFacts`; the Changelog and Trials details are the reference.
- Reading text on the desktop and the web (the article reader, `DetailReader`,
  Docs) takes one type scale and one column, from
  `src/components/reader/reader-text.tsx` (Design system, Readers): metadata,
  facts, tables and coverage at the app's own size (12px) and dimmer; body and
  lead 14px at line height 1.6, the lead brighter; section headings 16px bold
  and bright with space above them; a title 20px bold. In a column under 480px
  the body is 13.2px and the levels above it follow. A pane does not set its
  own reading size or column.
- Any other scrolling body is a `ScrollBox`. Leaving `scrollY` out means it
  scrolls vertically, with the wheel and, while the pane is focused, with the
  arrows, j/k, PageUp, PageDown, Home and End; `scrollY={false}` turns that off.
  A body does not bind those keys itself unless it wants to step by a line.
- A detail the user reads and comes back from is the stack, not a dialog or
  a floating pane. A new pane (`pinTicker`, `createPaneFromTemplate`) is for
  something kept beside the list.
- A row that is shown but does not apply right now (an exited holder, a story
  or print after the tab's pinned moment) reads in `textMuted` and plain
  weight across the row, its value colours included, and stays selectable.
- A row's DES (`d`, a menu entry, a linked ticker) opens through
  `useOpenDescription` (`shared/open-description.ts`), which brings forward
  the DES already open for that listing instead of opening a second one.

**Long lists.** A paged or cursored source appends on scroll and never shows
page numbers or a Load more button. An offset-paged source loads through
`usePagedRows(loadPage, { getId })`, whose loader takes `{ offset, signal,
force }` and returns `{ rows, hasMore, nextOffset }`. It aborts and ignores
superseded requests, appends by id, keeps what is loaded when a page fails,
and starts over when the loader changes (a new query, sort or filter); the
pane changes `resetScrollKey` with it. Its `loadMore` goes to
`useTableLoadMore(scrollRef, hasMore && !detailOpen, loadMore)` in
`onBodyScrollActivity`, which fires within 8 rows of the end. The footer
shows `loading more` while a page is in flight. Restoring a persisted open
item past the first page expands to that page first. Client-side "reveal
more of what is loaded" uses the same scroll helper.

## 5b. A chart over a table

The pane that shows figures, a chart and the rows behind it (daily short
volume, credit spreads, a futures curve, a CDS spread) has one layout, built
with `ChartTableHeader` in the table's `rootBefore`. Never split rows between
a chart and a table by hand.

**Order.** Query bar, figures (`StatGrid`), chart, table. Range and window
controls go in the query bar and govern the chart and the table together.

**The chart says what it plots.** The legend row is the caption: each series
is named in the table's words (`Short %`, `US HY OAS`, `5Y spread`) and shows
its value, the latest one until the cursor moves. Units live in the axis
labels. No loose title line above a chart, no `yAxisLabel` row, no unnamed
single line. A chart that follows the selected row names that row. When the
legend runs short of width, a curve's caption gives way before any series
name does.

**The chart earns its rows.** It shows what the table cannot: a trend, a
curve's shape, how a level moved (look-back curves, trails). The table adds
what the chart cannot: dates, events, per-row detail. When every table row is
just a point of the chart, give the table a change column or fold the chart
into an inline bar column instead of drawing the same numbers twice. Two
points are not a trend: below three, leave the band to the table.

**One selection.** The table's selected row is the chart's cursor (a time
series), the chart's series (a board of instruments) or the curve's point.
`useChartTableSelection` wires it: Left and Right step through time from the
table in the direction the chart reads, whatever the sort; hovering the chart
previews without moving the selection; clicking it selects the nearest row.
From a row with no point on the chart, Left and Right step to the nearest row
that has one. Inside this layout the chart takes no keys of its own and is
never `navigable`. In a tabbed pane a focused tab strip keeps Left and Right;
Up and Down still move the table's selection and the chart follows it.

**Every size.** `chartTableLayout` decides, so every pane shrinks and grows
the same way:

| Pane body | Figures | Band | Table |
|---|---|---|---|
| Room for the chart (six rows: legend, four plot rows, axis) and the table's header plus four rows | up to a quarter of the body, trimmed from the end | the chart, 40% of what the figures leave, or all the rows a short table does not need | the rest; all its rows when they fit |
| Less room, but the whole table fits with four rows to spare | up to a quarter of the body | a compact chart in the spare rows | all its rows |
| Too short for either | one row | one row: `● label` sparkline value | the rest |
| Shorter still, or narrower than 24 columns | one row | none | the rest |

- The table keeps its header and four rows (all of them when it has fewer)
  at every size; the chart gives way first, then the second row of figures.
- Figures are listed most important first; the ones at the end go when rows
  run short, and the strip leaves out what the remaining figures already say.
- A short table never leaves a blank band: the chart grows into its spare rows.
- Custom charts (curves, scatters) pass their own `minRows` and a `strip`;
  content with a natural height (a few bars) passes `maxRows` and the table
  takes the rest.
- Pass the table's columns (`tableColumns`) so a horizontal scrollbar row is
  counted and never hides the last row. A `MarketBoardStack` fits its columns
  to the width, so its `rootBefore` can be a function that receives them.
- The desktop uses the same rows for the band and lets the table fill below.

**Axis.** Tick labels never repeat and take their decimals from the plotted
range (`formatBpAxis`, `formatPercentAxis`, `spanAxisFormatter`). A daily
series shorter than two weeks still spans two weeks, so the axis reads days.

**Loading and failure.** While a separate history request loads, the band
holds its rows (`loading`) so the table does not jump, and figures that come
with the history hold their place with `--`. A chart that follows the
selected row keeps its band on a row without history and says so (`empty`),
so moving through the table never makes it jump. A failed history is a footer
notice and the band collapses; the table stays.

**Export.** The table exports what it shows. A column left out only to save
room (a quote time every row shares) goes into `getExportMetadata`; a column
drawn only as graphics (an inline bar) is left out of the CSV by itself.
Numbers export as numbers: a right-aligned column whose cells all read as one
unit (`+1.25%`, `1.20B`, `$12.50`, `21.4x`, `12bp`) writes bare numbers and
names the unit in its header, and dashes become empty cells. Give a cell
`value` when the text rounds or shortens what it shows (compact volumes, a
date without its year, a time of day): the full number in the unit the cell
shows (3.45 for `+3.45%`), or an ISO date.

**Details.** A stack detail that shows a chart and a table uses the same
header, with the detail's height.

## 6. Tabs

- `Tabs` is the only tab strip: controlled, mouse, `h`/`l` and arrows while
  focused, `underline` for pane sections, `pill` for layout tabs, `bare`.
  A pane's primary strip is `usePaneTabs` (above any early return): the
  desktop draws it in the pane title bar and `strip` is null; the terminal
  draws `strip` as the first row of the body. Subtract `rows`. Never in the
  footer. Register `null` while a sign-in wall or any state makes every tab
  show the same thing.
- A chart you pan and draw on sits one level below a tab strip: the strip
  keeps Left, Right, `h` and `l`; Down, Enter, a click or a chart tool moves
  into the chart, and Esc or Up hands the keys back, with `[Esc]tabs` in the
  footer while inside. `Tabs` and `CompositeChart` do this; a pane adds nothing.
- A strip inside content that already has a title-bar strip (a Ticker
  Research tab, a stack detail) becomes a `QueryBar` view (`usePaneTabs`
  with `queryBarWidth`) or inline filter on the desktop; the terminal keeps
  its `Tabs` row.
- The active tab is `usePluginPaneState`. A user-configurable tab set is a
  pane setting, with `hideTabs` for panes locked to one view.
- Content, one of two ways: one body reloaded per tab when tabs are views
  over the same data (market movers), or lazy mount and keep mounted with
  `visible={false}` plus `PaneFooterScope` when tabs are different surfaces
  (Ticker Research). Never mount every tab up front.
- Labels are translated nouns.
- A Ticker Research tab is shown only for tickers it can have data for:
  `instruments` on the tab def (`["equity"]` for company filings,
  `["equity", "fund"]` for distributions and ownership), `isVisible` for
  narrower rules such as a US listing. Never ship a tab that opens on
  "not available for this instrument".
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
  The inline filter or view that picks a chart's range sets `chartRange`:
  choosing the selected range again sends the pane's charts back to it, as `0`
  does, so every chart's range strip behaves the same. Bind the range's number
  keys the same way (`useSeriesList` does for a list beside a detail chart).
- `useQueryBarSearch()` holds whether the search owns the keyboard; spread its
  `searchProps` into `search`. The bar already binds `/`, so a pane binds it
  again only to add a condition.
- A stack detail whose content starts with a `QueryBar` gets Back and the item
  title as the bar's first segments automatically; do not add a second row.
- Every menu, dropdown and pop-up list is `MenuPopover`/`Menu` in the kit
  `Popover`. No positioned boxes, no native `<select>`.
- Calculators and sizers: mode switches in the `QueryBar` (inline filters),
  inputs in a `FieldGrid`. Icon-only actions are `IconButton`s from the shared
  icon set. A long strip of choices above content (expiries, chart ranges) is
  an inline filter in the bar, not a raw `Tabs` row; `Tabs` stays for a
  pane's primary strip and for section switches inside content.
- On the desktop, pane headers, query bars, detail bars and table header rows
  share one chrome height (`chromeRowPx()`, `--chrome-h`). Tables and details
  fill to the pane footer; do not size them with terminal row arithmetic.

## 7. Tabs with forms

- Kit fields only: `TextField`, `NumberField`, `SelectButton`, `Checkbox`,
  `SegmentedControl`, `MultiSelectDialogButton`, each with a `label`. A raw
  `Input` is not a field.
- One `activeField` names the focused input; Tab and Shift+Tab (and `j`/`k`
  outside a text input) move the ring; a click focuses. `useFieldRing` is
  that ring, with Enter and Space actions and scroll into view. Pass the
  field's `active` to `TextField` (and `labelWidth` for a label column beside
  it), or use `FieldLabel`, so the terminal marks it; the desktop's focus ring
  already does. Capture input while a text field is focused so global
  shortcuts do not eat typing.
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
- Destructive actions ask with `confirmDialog` (a `ConfirmDialog`) from a
  `variant="danger"` button or a footer hint, never a bare button that acts
  on first press.
- A dialog's keys: the terminal names them in the `DialogFrame` footer line;
  the desktop and the web put each on its button as a keycap
  (`desktopShortcut`), put keys no button has and a note such as a deadline
  beside the buttons (`DialogActions` `hints`), and draw no footer line
  (`desktopFooter={null}`).
- A form inside a stack detail follows the same rules; Back is the navigation
  Cancel and the footer goes empty while editing.

## 8. Sidebars, loading, input

- A list of conversations, channels or documents beside the selected one is
  `PaneSidebar` on the left (`PaneSidebarRow`, `PaneSidebarAction`,
  `ActionRow` section headers), width persisted and drag-resizable,
  `<` and `>` bound to its width and listed in the pane menu (not the
  footer), `shouldShowPaneSidebar` deciding whether the pane is big enough. Sidebar
  when the user switches items many times a session; stack when they open
  one, read, and go back.
- Loading: `useAsyncResource` + `useAutoRefresh` + `useUpdatedAgo`, seeded
  from `createPluginCache`. First load shows `loadingText(subject)`, a hard
  failure `unavailableText(subject)` plus the message; once data exists a
  refresh never blanks it. Start `loading` at `true` when the first frame
  would otherwise claim an empty result. `useAutoRefresh` follows the
  configured interval; pass `{ intervalMs }` only for data that moves
  faster (a delayed curve in session). Live quotes go through
  `gloomberb/quotes` and `LIVE_STREAMING_QUICK_SETTING`. Fetching lives in
  `client.ts`, projection in `view.ts`/`model.ts`, shared with the `headless`
  definition.
- Live data: gate timers, polls and streams on `usePaneVisible()` (app
  visible and pane not covered), not on focus; `useAppVisible()` is for work
  that must continue while the pane is covered. A covered pane keeps its
  quote subscriptions at the off-screen cadence instead of dropping them.
  `useTickerFinancialsMap` is passive and only moves while another pane
  streams the symbol; a pane showing a price uses `useLiveTickerFinancials`
  or `useLiveTickerFinancialsMap` (`visible: false` for totals and weights).
  A pane that only needs the symbol uses `usePaneTickerIdentity`, not
  `usePaneTicker`, which re-renders on every tick. Tables fed by ticks keep
  `renderCell` stable (read data through refs) and pass `getRowVersion`, so
  one symbol's tick redraws one row.
- Everything interactive works by mouse and keyboard through the kit.
  Pane-local keys are single unmodified letters declared as hints, and a
  hint is the binding: the footer presses it while the pane is focused, so
  do not bind a hinted key again (if a handler must, it calls
  `preventDefault()` when it acts). Reserved: `j`/`k`/arrows move, Enter
  opens, Esc/Backspace back, `r` refresh, `Shift+R` refresh all, `!`
  warnings, `o` open source, `/` search, `.` pane menu, Tab/Shift+Tab next
  pane or field, `h`/`l` tabs, `<`/`>` the width of a resizable sidebar, `?` help, F1 the pane's help card, `` ` `` ticker search, `q` quit (terminal),
  `u` restart into a downloaded update or retry a failed one, `$` Pro upgrade, Ctrl+P command bar. `q`, `u`, `r`,
  `Shift+R`, `?` and `` ` `` reach the app before any pane. Table keys go
  through `onRootKeyDown` and `onDetailKeyDown` (return `true` when handled);
  global shortcuts through `registerShortcut` so Help lists them.
- A key held down repeats, and an action should run once per press. The
  shortcut registry drops the repeats (`event.repeat`) of command chords
  (Ctrl, Cmd or Super with a key), Esc, function keys and the menu key before
  any handler runs. The shell's own actions (pane keys, help, refresh, the
  command bar) also refuse a repeat and any second trigger within 600 ms,
  which covers a terminal that cannot say a key is a repeat and a native menu
  accelerator. Plain keys still repeat, as movement keys must (arrows, page
  keys, `j`/`k`, `+`/`-`), and a footer hint repeats only for those; a pane
  key that opens a dialog, writes the clipboard, downloads or sends ignores
  `event.repeat` itself.
- Esc Esc closes the focused pane, and only an Esc nobody consumed counts
  as the first press. Consume Esc only when it backs out of something (a
  detail, a menu, a selection, a draft); with nothing to back out of, let it
  through. An Esc that only leaves an empty text field still counts: call
  `countEscapeTowardClose(event)` and consume it.
- The pane menu (`.`, Shift+F10, the `...` button) is where the keyboard
  finds everything: it lists the footer hints with their keys, what kit
  controls add (table sort, query-bar filters, tab add/close/move, empty-state
  actions), quick settings and the pane actions. An action with no key of its
  own goes there with `usePaneMenuItems`, never in a body button row. Set a
  hint's `title` when its key is not the action's first letter. A pane that
  shows one ticker sets `tickerFollower` on its `PaneDef`, and the menu gains
  "Link to" each visible list, scanner, or other single-ticker pane and "Unlink from" the one it follows;
  the title then reads `OPX NVDA  ⧉ Linked to Watchlist`. Such a pane changes
  ticker while mounted, so it keys its view by symbol and keeps saved
  per-ticker choices (expiry, strike) per symbol.
- One component renders in the terminal, the desktop app and the web. Import
  only `gloomberb/ui`, `gloomberb/components`, `gloomberb/react`; detect the
  target with `getCurrentPluginTarget()`, not `window` or `location`. Never
  draw chrome with cell characters on the desktop (bars, chevrons, markers);
  `useUiCapabilities().nativePaneChrome` tells the renderers apart, and
  `jobs/share-bars.tsx` and `sectors/move-bar.tsx` show the terminal-only
  branch for a bar. Prefer `flexGrow`/`flexBasis={0}`/`overflow="hidden"`
  to hard heights; subtract the tab strip and `rootBefore` rows before passing
  `rootHeight`.
- The desktop app and the web are an app, not a document: Ctrl/Cmd+A, a double
  or triple click and a drag across panes select no text. Text people copy by
  hand opts in: `<Text selectable>` for a run, `data-gloom-selectable="true"`
  on the `Box` around a block (articles, answers, logs, code; `MarkdownText`
  and the reader already do). Fields keep their own selection. Anything else
  people need out of a pane is a copy action or an export, not a selection.
  The terminal selects with the mouse as it always did.

## 8b. Opening a function twice

Opening a function that is already open focuses its window; a window is added
only when none is open. That holds for every way in: the command bar, a
notification or alert, a deep or share link, a shortcut, `pane.show` and
`pane.createFromTemplate` from the Remote API, and an "Open" action in another
pane. The host decides it in `createPaneTemplateOrThrow` from what the
template's `createInstance` returns:

- **One window per function** (Plugins, Unread, a board that takes no
  argument): return no `instanceId` or a stable one (`"unread-inbox"`). Settings
  the user changes later do not make it another window.
- **One window per ticker or per query**: key the id by the argument
  (`financial-analysis:AAPL`, `jobs:home`), put the ticker in `binding` and the
  query in `settings`. The host also finds a pane that shows that ticker or
  query under another id, such as one unlinked from a list.
- **A window the user switches inside** (Chat changes channel in place) cannot
  be named by an id: the id says what it was opened on, not what it shows. Its
  `createInstance` reads `context.layout` and `context.focusedPaneId` and
  returns the `instanceId` of the pane to reuse: the one already showing the
  thing, else the focused one, else the one in front (`pickChatPaneToReuse`).
  Only with none open does it return a new id.
- **The spec holds identity, not preferences.** Binding, params and the
  settings that say what the window shows (`channelId`, `symbols`, `board`);
  never a view preference (live streaming, a range). The host matches a pane by
  what the spec names and ignores the settings it leaves out, so a pane the user
  has tuned is still found.
- **Two functions on one pane type** (ERN and EVTS, MA and DIST, POWER and
  EPWR, BI and THEM) tell their windows apart by binding, params and settings.
  Declare the settings that name a window as `identitySettings` on the pane def
  (`["board", "symbols", "symbolsText"]`; `[]` when binding and params say it
  all). A window that picked up any other setting is still found, and a window
  carrying an identity setting the function does not set is left to the function
  that does. This reads what the window stores, so panes saved before the
  declaration are found too. Without it a bare spec only matches a window with no
  settings at all, because the host cannot tell whose settings are whose.
- **New on purpose**: a blank form that builds something (`VIEW`), a function
  that creates a list (`PF`), "Open in new pane" (`forceNewPane`) and Duplicate
  Pane. Charts and quotes for different tickers are different specs, so they
  are different windows.

`workflow/pane-reuse.test.ts` opens every function in the catalog twice, after
its pane picked up a setting, and lists the ones that still add a window with
the reason. A new function that lands on that list fails the test: fix the
template, or add it with its reason.

## 9. Checklist for a new pane or tab

1. The title is the only place the pane names itself; the body starts with the header zone (query bar, figures) or content.
2. Every pane action is a footer hint with a key (or a `usePaneMenuItems` entry) and works by mouse; no button row in the body; nothing is mouse-only.
3. Footer info is changing state only: no labels, counts, generic hints, `r`.
4. Warnings via `usePaneNoticeFooter`; blocking states via `PaneStatusBody`/`EmptyState`; refresh failures keep the last data.
5. Lists use the kit tables; details open in the stack, keyed by a stable id, persisted with `usePluginPaneState`.
6. Paged sources load more on scroll, abort stale pages, reset on a new query.
7. Tabs use `Tabs`, persist the active tab, scope their footers, mount lazily.
8. Forms use kit fields, one Save per form at its bottom, Enter/Esc, busy and result in the footer, destructive actions confirmed.
9. Per-instance configuration is a pane setting; important toggles are `quickSettings`.
10. Methodology and usage text is in `docs/`.
11. Data panes have a `headless` definition; fetching is in `client.ts`. It declares `freshness` (source, status, schedule) wherever "Gloom Cloud" and the status read from the rows would be wrong, so the report's source, as-of and status line is true.
12. No `@opentui`, Electrobun or DOM imports; no cell-drawn chrome on the desktop.
13. A missing repeated pattern went into the kit with its callers migrated, not into the pane.
14. On the desktop and the web nothing is sized in cells: boxes fill with flex, percentages or CSS units, text wraps in CSS at the width it sits in (a reading measure is a CSS `max-width` in `ch`), and sizes are read from the laid-out page. Nothing ends in a dead band above the footer or a gap at the right edge. `bun run check:pane-layout` measures every function; `src/architecture/dom-cell-metrics.test.ts` keeps cell metrics out of DOM-only code, and its allowlist says for every file why the uses left stay (a shared API that speaks cells to every renderer, or a size the terminal shares by design).
15. A chart with a table uses `ChartTableHeader`: named series, one shared selection, `chartTableLayout` at every size, no repeated numbers.
16. Opening the function again focuses its window (8b): identity in the spec, preferences out of it, a stable `instanceId` for a one-window function.
17. Nothing animates while its box is being resized. Motion tied to the layout (a glide, a fade, a pulse) reads `resizing` from `useSettledLayoutSize` (`src/ui/resize-settle.ts`), the one signal for a pane resize, a divider, a maximise or restore and a window resize; content placed in percentages of its box holds its layout while the size changes and is laid out once the size settles, as the heat map's tiles are (`useHeatTreemapScene`). `bun run check:pane-chrome --only "market heat map"` drags, resizes the window and maximises with real input and fails on a relayout per move or a tile animating.

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
| Query bar + stat grid over a table, per-tab figures | `time-sales/pane.tsx` |
| Tabs as a query over one table | `market-movers/index.tsx` |
| Tabs with forms, Save per form, Ctrl+S | `account-management/pane.tsx`, `footer.ts` |
| Form in a stack detail, empty footer while editing | `broker-manager/detail.tsx`, `footer.ts` |
| Hints that follow selection and tab | `congress-trades/footer.ts` |
| Notice footer beside status footer | `dividend-yield/pane.tsx` |
| Failure in footer, not repeated in the empty body | `cds/pane.tsx` |
| Sidebar + content | `chat/sidebar.tsx`, `cloud/askg/sidebar.tsx` |
| Footer model and rendering | `src/components/layout/pane/footer/` |
| Status, notice, empty state | `src/components/ui/status.tsx` |
| Load-more helpers | `src/components/table-view-shared.tsx`, `src/components/paged-rows.ts` |
| Stack | `src/components/data-table/stack-view.tsx`, `ui/page-stack-view.tsx` |
| Item detail: facts, then the text across the pane | `clinical-trials/pane.tsx`, `changelog/index.tsx`, `src/components/reader/detail-reader.tsx` |
| Figures, chart and table, selection drives the cursor | `short-volume/pane.tsx` |
| Board whose chart follows the selected row | `credit-conditions/index.tsx` |
| Chart over table layout, strip, selection | `src/components/chart-table/` |
| Rationale in prose | `docs/research-data.md` intro, `PLUGINS.md` UI guidelines |
