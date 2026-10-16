# UI audit

469 views (461 pane views of 154 functions and plugin panes, 8 shell views), at 640 and 1280 px, measured in the white theme. 79 views show a sign-in wall, gate or Pro lock. 

## Element families

| Family | Variants | Components | Views | Functions | Functions off the main variant | Kit share | Most used variant's share | Picture |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Buttons | 29 | 14 | 468 | 162 | 162 | 78% | 99% | [grid](grids/button.png) |
| Chips and badges | 16 | 8 | 166 | 73 | 31 | 87% | 82% | [grid](grids/chip.png) |
| Toolbars and filter rows | 16 | 3 | 312 | 98 | 98 | 96% | 54% | [grid](grids/toolbar.png) |
| Tabs | 11 | 1 | 357 | 73 | 72 | 100% | 100% | [grid](grids/tab.png) |
| Toggles and checkboxes | 9 | 3 | 151 | 58 | 58 | 100% | 97% | [grid](grids/toggle.png) |
| Chart legends | 7 | 3 | 71 | 47 | 47 | 100% | 96% | [grid](grids/legend.png) |
| Selects | 6 | 4 | 141 | 52 | 29 | 100% | 65% | [grid](grids/select.png) |
| Table header cells | 5 | 1 | 320 | 116 | 49 | 100% | 100% | [grid](grids/table-header-cell.png) |
| Tab bars | 5 | 2 | 357 | 73 | 73 | 68% | 72% | [grid](grids/tab-bar.png) |
| Cards | 4 | 4 | 4 | 3 | 3 | 0% | 50% | [grid](grids/card.png) |
| Key-value rows | 4 | 6 | 117 | 65 | 47 | 98% | 99% | [grid](grids/kv-row.png) |
| Key caps | 3 | 2 | 174 | 80 | 33 | 100% | 70% | [grid](grids/keycap.png) |
| Inputs and search boxes | 3 | 5 | 175 | 70 | 3 | 29% | 97% | [grid](grids/input.png) |
| Pane title bars | 3 | 1 | 467 | 160 | 19 | 0% | 97% | [grid](grids/pane-title-bar.png) |
| Table rows | 3 | 1 | 254 | 104 | 26 | 100% | 90% | [grid](grids/table-row.png) |
| Pane footers | 3 | 1 | 402 | 132 | 59 | 0% | 65% | [grid](grids/pane-footer.png) |
| Empty states | 3 | 2 | 149 | 74 | 5 | 100% | 95% | [grid](grids/state-empty.png) |
| Chart axes | 3 | 2 | 100 | 51 | 28 | 100% | 100% | [grid](grids/axis.png) |
| List rows | 3 | 1 | 2 | 2 | 2 | 0% | 100% | [grid](grids/list-row.png) |
| Links | 3 | 2 | 10 | 10 | 3 | 100% | 80% | [grid](grids/link.png) |
| Table header rows | 2 | 1 | 320 | 116 | 1 | 100% | 100% | [grid](grids/table-header-row.png) |
| Table section rows | 2 | 1 | 37 | 26 | 1 | 100% | 97% | [grid](grids/table-section-row.png) |
| Locked, Pro and sign-in states | 2 | 2 | 42 | 20 | 2 | 0% | 81% | [grid](grids/state-locked.png) |
| Notices (stale, delayed, errors) | 2 | 2 | 50 | 32 | 1 | 100% | 98% | [grid](grids/state-notice.png) |
| Detail back rows | 2 | 1 | 43 | 40 | 2 | 100% | 100% | [grid](grids/back-row.png) |
| Loading states | 2 | 2 | 7 | 3 | 3 | 100% | 100% | [grid](grids/state-loading.png) |
| App header | 1 | 1 | 8 | 8 | 0 | 0% | 100% | [grid](grids/app-header.png) |
| Status bar | 1 | 1 | 8 | 8 | 0 | 0% | 100% | [grid](grids/status-bar.png) |
| Dialogs | 1 | 1 | 2 | 2 | 0 | 100% | 100% | [grid](grids/dialog.png) |
| Footer key hints | 1 | 1 | 306 | 104 | 0 | 100% | 100% | [grid](grids/pane-hint.png) |
| Sort indicators | 1 | 1 | 132 | 65 | 0 | 100% | 100% | [grid](grids/sort-indicator.png) |
| Section headings | 1 | 1 | 13 | 12 | 0 | 100% | 100% | [grid](grids/section-heading.png) |

A variant is one shape (height, padding, border, radius, shadow, type); colours are listed apart. Kit share is the share of elements drawn by a component of the shared kit (src/components/ui, src/ui, the DOM renderer, the readers and tables).

## Type

Labels a heat map, treemap, graph or map fits to its own shapes are left out: 406 sizes from 0.62 to 26px.

### 640px: 14 font sizes

| Size | Views | Runs | Roles | Drawn by |
|---|---:|---:|---:|---:|
| 12px | 469 | 34917 | table-cell 27287, table-header 1683, chart 1367, toolbar 1113 | CellText, DataTable, StatGrid |
| 11.5px | 369 | 1724 | footer-hint 1282, footer-status 402, status-bar 40 | ShortcutHint, SegmentView, Button |
| 13px | 359 | 1568 | tab 1558, other 10 | Tabs, FigureText |
| 10px | 109 | 109 | toolbar 109 | QueryBar |
| 10.08px | 55 | 63 | keycap 55, app-header 8 | Button |
| 16px | 8 | 8 | other 8 | Shell |
| 16.1px | 5 | 8 | heading 5, body 3 | ReaderText:label, Block, SegmentSpan |
| 20.02px | 5 | 5 | title 5 | ReaderText:headline |
| 14.98px | 5 | 5 | lead 5 | ReaderText:lead |
| 14px | 4 | 80 | body 59, heading 15, link 6 | SegmentSpan, ReaderText:item, ReaderText:body |
| 11px | 3 | 7 | other 4, chart 3 | QuoteMonitorCard,  |
| 15px | 3 | 12 | other 8, other-strong 4 | SvgText3, QuoteMonitorCard |
| 22px | 3 | 5 | other-strong 5 | FigureText |
| 10.2px | 2 | 4 | chart 4 | GeoLegend |

### 1280px: 14 font sizes

| Size | Views | Runs | Roles | Drawn by |
|---|---:|---:|---:|---:|
| 12px | 469 | 44914 | table-cell 36191, table-header 2258, chart 1680, toolbar 1231 | CellText, DataTable, StatGrid |
| 11.5px | 397 | 1916 | footer-hint 1444, footer-status 432, status-bar 40 | ShortcutHint, SegmentView, Button |
| 13px | 359 | 2046 | tab 2036, other 10 | Tabs, FigureText |
| 10px | 117 | 117 | toolbar 117 | QueryBar |
| 10.08px | 49 | 57 | keycap 49, app-header 8 | Button |
| 16px | 8 | 8 | other 8 | Shell |
| 16.1px | 5 | 8 | heading 5, body 3 | ReaderText:label, Block, SegmentSpan |
| 20.02px | 5 | 5 | title 5 | ReaderText:headline |
| 14.98px | 5 | 5 | lead 5 | ReaderText:lead |
| 14px | 4 | 84 | body 63, heading 15, link 6 | SegmentSpan, ReaderText:item, ReaderText:body |
| 11px | 3 | 7 | other 4, chart 3 | QuoteMonitorCard,  |
| 15px | 3 | 12 | other 8, other-strong 4 | SvgText3, QuoteMonitorCard |
| 22px | 3 | 5 | other-strong 5 | FigureText |
| 10.2px | 2 | 4 | chart 4 | GeoLegend |

### By role (1280px)

| Role | Variants | Size/line height/weight: views (drawn by) |
|---|---:|---:|
| other | 7 | 12px/18/400: 80 (CurveSurface, NewsStoryTimelineItemView); 16px/16/400: 8 (Shell); 13px/14.3/500: 3 (FigureText); 12px/14/400: 2 (ExtendedSessionLine, QuoteMonitorCard); 11px/13/400: 2 (QuoteMonitorCard); 12px/22.8/400: 1 (ReaderTable) |
| app-header | 4 | 12px/18/700: 8 (HeaderCommandPrompt, HeaderMarketSummary); 12px/18/400: 8 (HeaderMarketSummary, HeaderCommandPrompt); 12px/18/600: 8 (Button); 10.08px/10.08/500: 8 (Button) |
| tab | 4 | 13px/16/700: 357 (Tabs); 13px/16/500: 355 (Tabs); 12px/12/700: 35 (Tabs); 12px/12/500: 35 (Tabs) |
| toolbar | 4 | 12px/18/400: 253 (FilterChip, QueryBar); 12px/18/600: 147 (QueryBar, InlineChoices); 10px/15/400: 117 (QueryBar); 12px/18/700: 2 (TickerBadge, QueryBar) |
| chart | 4 | 12px/18/400: 101 (StaticXAxisLabels, PriceAxisLabels); 10.2px/18/400: 2 (GeoLegend); 11px/18/600: 1 (); 12px/18/600: 1 () |
| other-strong | 4 | 12px/18/700: 9 (ChatMessageHeader, AnswerRow); 12px/18/600: 5 (TextFieldControl); 22px/23.1/700: 3 (FigureText); 15px/18/700: 2 (QuoteMonitorCard) |
| body | 4 | 12px/18/400: 4 (Prose); 14px/22.4/400: 3 (SegmentSpan, ReaderText:item); 14px/23.8/400: 1 (SegmentSpan, Block); 16.1px/21.74/700: 1 (Block) |
| button | 3 | 12px/18/600: 71 (Button); 12px/18/400: 44 (PageStackView, ClippedText); 12px/18/700: 34 (Button, ClippedText) |
| dialog-title | 3 | 12px/18/700: 2 (DialogFrame); 12px/18/650: 1 (DesktopSettingsRow, DesktopActionPill); 12px/18/600: 1 (DesktopValuePill, DesktopSettingsRow) |
| link | 3 | 12px/18/400: 8 (ExternalLinkText); 14px/22.4/400: 1 (SegmentSpan); 14px/23.8/400: 1 (SegmentSpan) |
| pane-title | 2 | 12px/18/700: 455 (PaneHeader); 12px/18/600: 12 (PaneHeader) |
| table-cell | 2 | 12px/18/400: 254 (CellText, DataTable); 12px/18/700: 109 (CellText, Badge) |
| footer-status | 2 | 11.5px/18/400: 269 (SegmentView); 11.5px/18/700: 41 (SegmentView) |
| command-bar | 2 | 12px/18/700: 2 (CommandBarPanel); 12px/18/400: 2 (CommandBarPanel, CommandBarRowBadge) |
| dialog-text | 2 | 12px/20/500: 1 (Checkbox); 12px/18/400: 1 (DesktopSettingsRow) |
| label-value | 2 | 12px/18/700: 110 (StatGrid, NativeKeyValueRow); 12px/18/400: 105 (NativeKeyValueRow, StatGrid) |
| heading | 2 | 16.1px/21.74/700: 4 (ReaderText:label, SegmentSpan); 14px/22.4/700: 1 (SegmentSpan) |
| keycap | 1 | 10.08px/10.08/500: 49 (Button) |
| status-bar | 1 | 11.5px/18/600: 8 (Button) |
| table-header | 1 | 12px/20/700: 320 (DataTable) |
| table-section | 1 | 12px/18/700: 37 (DataTable) |
| state | 1 | 12px/18/400: 137 (EmptyStateBody, UpgradeLabel) |
| footer-hint | 1 | 11.5px/18/700: 302 (ShortcutHint) |
| label | 1 | 12px/18/400: 100 (StatGrid, GridFieldView) |
| back-row | 1 | 12px/18/700: 37 (PageStackView) |
| section-heading | 1 | 12px/18/700: 13 (SectionHeading) |
| metadata | 1 | 12px/18/400: 6 (ReaderText:meta) |
| title | 1 | 20.02px/25.03/700: 5 (ReaderText:headline) |
| lead | 1 | 14.98px/23.22/400: 5 (ReaderText:lead) |
| chip | 1 | 12px/18/700: 2 (Badge) |

## Content inset of the pane body

### 640px

- left: 8px in 379 views, 6px in 33 views, 0px in 18 views, 2px in 7 views, 4px in 6 views, 25px in 5 views, 1px in 2 views, 18px in 2 views, 16px in 2 views, 10px in 2 views
- right: 8px in 244 views, 0px in 163 views, 10px in 11 views, 5px in 9 views, 4px in 7 views, 6px in 3 views, 43px in 3 views, 9px in 3 views, 42px in 3 views, 2px in 2 views
- top: 3px in 293 views, 2px in 49 views, 4px in 44 views, 20px in 42 views, 1px in 26 views, 23px in 2 views, 5px in 2 views, -2px in 1 views, 24px in 1 views, 11px in 1 views

### 1280px

- left: 8px in 391 views, 6px in 23 views, 0px in 16 views, 25px in 7 views, 2px in 7 views, 4px in 6 views, 1px in 2 views, 16px in 2 views, 10px in 2 views, 7px in 1 views
- right: 8px in 352 views, 0px in 35 views, 5px in 18 views, 10px in 13 views, 4px in 12 views, 6px in 7 views, 102px in 4 views, 363px in 3 views, 105px in 3 views, 360px in 2 views
- top: 3px in 313 views, 2px in 49 views, 4px in 45 views, 20px in 30 views, 1px in 16 views, 23px in 2 views, 5px in 2 views, -2px in 1 views, 24px in 1 views, 22px in 1 views

## Row heights (1280px)

| Row | Heights: views (drawn by) |
|---|---:|
| data-table-header-row | 20px: 320 (DataTable) |
| data-table-section-header | 18px: 37 (DataTable) |
| data-table-row | 18px: 254 (DataTable) |
| pane-setting-row | 37px: 1 (DesktopSettingsRow); 55px: 1 (DesktopSettingsRow); 51px: 1 (DesktopSettingsRow) |
| tab-button | 18px: 357 (Tabs); 14px: 12 (Tabs) |
| stat-grid-row | 18px: 97 (StatGrid) |
| pane-sidebar-item | 18px: 2 (PaneSidebarRow) |
| field-grid-row | 18px: 10 (FieldGrid) |

## Colours against the theme (1280px)

Text colour by role:

| Text role | Colours (runs) |
|---|---:|
| table-cell | text 11838, text-dim 7909, text-bright 5740, text-muted 4236, positive 3204, negative 1985 |
| chart | text-dim 1355, text 147, text-bright 51, positive 45, text-muted 33, warning 31 |
| label-value | text-dim 516, text-bright 355, text 193, positive 27, negative 16, neutral 14 |
| other | text-dim 166, text-muted 145, text 122, text-bright 44, positive 19, negative 10 |
| other-strong | text-dim 34, text-bright 17, positive 12, negative 7, warning 3, text 1 |
| button | text 132, text-bright 80, bg 30, text-dim 22, off-palette rgb(177, 151, 252) 3, off-palette rgb(255, 169, 77) 3 |
| app-header | off-palette rgb(159, 159, 159) 14, text 10, off-palette rgb(149, 149, 149) 8, text-bright 8, negative 8, off-palette rgb(221, 221, 221) 6 |
| command-bar | text 27, off-palette rgb(210, 210, 210) 23, derived commandBarSubtleText() 8, off-palette rgb(198, 172, 85) 5, text-bright 4, neutral 2 |
| table-header | text-dim 2096, text 129, text-bright 13, warning 8, positive 8, negative 4 |
| footer-status | text-muted 285, warning 84, text 35, text-dim 26, negative 2 |
| state | text-dim 115, text-muted 34, negative 19, text-bright 12 |
| toolbar | mixed (color-mix) 702, text 269, text-muted 208, text-bright 169 |
| body | text 44, text-dim 20, text-bright 8, text-muted 4 |
| keycap | off-palette rgb(149, 149, 149) 26, off-palette rgb(71, 71, 71) 22, off-palette rgb(91, 91, 91) 1 |
| table-section | text-bright 105, text-muted 7, warning 1 |
| dialog-title | text 6, text-dim 1, text-muted 1 |
| tab | text-dim 1738, text-bright 386, text 20 |
| heading | text-bright 13, text 4, text-dim 3 |
| pane-title | text-bright 456, derived paneTitleText() 12 |
| dialog-text | text-muted 2, text 1 |
| footer-hint | text-bright 722, text-dim 722 |
| link | text-bright 21, text 3 |
| status-bar | text-dim 40 |
| label | text-dim 489 |
| back-row | text-bright 37 |
| section-heading | text-bright 33 |
| metadata | text-dim 6 |
| title | text-bright 5 |
| lead | text-bright 5 |
| chip | text-bright 2 |

Every colour drawn, as text, fill or border:

| Colour | Views | Drawn by |
|---|---:|---:|
| text-bright | 468 | CellText, Tabs, ShortcutHint, DomHeatTreemap |
| text-dim | 468 | CellText, DataTable, Tabs, StaticXAxisLabels |
| derived paneTitleBg(focused) | 455 | PaneHeader |
| derived paneBg(focused) | 418 | PaneFooterBar, SeriesAxisTags, Tabs, DataTable |
| text | 413 | CellText, DataTable, FilterChip, NativeKeyValueRow |
| border | 404 | PaneFooterBar, NativeStatusBar, Tabs, DesktopValuePill |
| bg (translucent) | 381 | Tabs, Button, HeaderCommandPrompt |
| text-muted | 376 | CellText, SegmentView, QueryBar, DataTable |
| mixed (color-mix) | 347 | QueryBar, FilterChip, InlineChoices, PageStackView |
| panel | 333 | DataTable, Tabs, PaneSidebarRow, NativeStatusBar |
| bg | 280 | DataTable, DomHeatTreemap, TextFieldControl, Button |
| selected | 257 | DataTable, Badge, ChartToolChip |
| off-palette rgb(23, 23, 23) | 247 | Tabs |
| positive | 162 | CellText, DataTable, CompositeSeriesSwatch, SeriesAxisTags |
| warning | 157 | CellText, SegmentView, CompositeSeriesSwatch, SeriesAxisTags |
| negative | 129 | CellText, DataTable, DomHeatTreemap, EmptyStateBody |
| derived panelBorder() | 58 | Button, DomHostProviders, Checkbox, CompositeSeriesSwatch |
| derived panelFill() | 55 | Button, Checkbox, DesktopValuePill, DesktopActionPill |
| derived floatingPaneBg(focused) | 37 | Tabs, DesktopSettingsRow, Button |
| derived commandBarInputBg() | 28 | Button, PaneSidebarRow |
| off-palette rgb(149, 149, 149) | 26 | Button |
| off-palette rgb(71, 71, 71) | 26 | Button, Badge |
| off-palette rgb(230, 230, 230) | 22 | Button |
| neutral | 20 | CellText, StatGrid, DataTable, CommandBarPanel |
| off-palette rgb(77, 171, 247) | 14 | CompositeSeriesSwatch, FlowCard, PriceAxisLabels, SupplyGraph |
| off-palette rgb(68, 68, 68) | 13 | Tabs |
| derived paneTitleText() | 12 | PaneHeader |
| derived paneTitleBg() | 12 | PaneHeader |
| off-palette rgb(159, 159, 159) | 8 | HeaderMarketSummary, HeaderCommandPrompt |
| header | 8 | Header |
| off-palette rgb(98, 98, 98) | 7 | SeriesAxisTags |
| off-palette rgb(46, 46, 46) | 7 | TickerBadge |
| off-palette rgb(221, 221, 221) | 6 | HeaderCommandPrompt |
| off-palette rgb(113, 113, 113) | 6 | HeaderCommandPrompt |
| derived commandBarPanelBg() | 6 | Badge, HeaderCommandPrompt, CommandBarPanel, MessageImage |
| off-palette rgb(246, 200, 95) | 6 | CompositeSeriesSwatch, SeriesAxisTags |
| off-palette rgb(99, 230, 190) | 5 | DataTable, CompositeSeriesSwatch, FlowCard, SupplyGraph |
| off-palette rgb(0, 37, 18) | 4 | TickerBadge |
| off-palette rgb(46, 9, 9) | 4 | TickerBadge |
| off-palette rgb(255, 169, 77) | 3 | ClippedText, SupplyGraph, CompositeSeriesSwatch, StatGrid |

## Static scan: literals that bypass the theme and the kit

| Area | Literals | colour | fontSize | fontWeight | lineHeight | letterSpacing | spacing | border | radius | shadow | derivedColour | cellProps |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| theme | 523 | 498 | 0 | 0 | 0 | 0 | 0 | 25 | 0 | 0 | 58 | 0 |
| dom-renderer | 342 | 91 | 20 | 17 | 14 | 3 | 98 | 41 | 28 | 30 | 32 | 1 |
| other | 149 | 70 | 8 | 0 | 1 | 1 | 51 | 15 | 3 | 0 | 23 | 20 |
| shared-components | 139 | 20 | 9 | 6 | 16 | 5 | 54 | 10 | 17 | 2 | 28 | 42 |
| kit | 136 | 116 | 0 | 2 | 0 | 0 | 7 | 2 | 8 | 1 | 4 | 21 |
| shell | 81 | 8 | 3 | 0 | 2 | 1 | 47 | 8 | 7 | 5 | 24 | 31 |
| plugin:chat | 56 | 5 | 5 | 2 | 0 | 0 | 31 | 5 | 8 | 0 | 18 | 21 |
| plugin:ticker-detail | 35 | 0 | 8 | 0 | 8 | 0 | 12 | 3 | 1 | 3 | 0 | 20 |
| plugin:world-venue-map | 27 | 8 | 2 | 2 | 1 | 0 | 8 | 2 | 4 | 0 | 7 | 2 |
| plugin:cloud | 25 | 4 | 2 | 0 | 2 | 0 | 10 | 1 | 5 | 1 | 3 | 73 |
| plugin:supply-chain | 23 | 1 | 0 | 0 | 0 | 0 | 5 | 7 | 6 | 4 | 21 | 23 |
| plugin:gpu | 13 | 3 | 0 | 0 | 0 | 0 | 6 | 1 | 3 | 0 | 3 | 3 |
| plugin:chart-composer | 12 | 2 | 0 | 1 | 0 | 0 | 9 | 0 | 0 | 0 | 0 | 6 |
| plugin:relative-rotation | 11 | 11 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| plugin:revenue-breakdown | 5 | 0 | 0 | 0 | 0 | 0 | 3 | 1 | 1 | 0 | 5 | 0 |
| plugin:correlation | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 6 |
| plugin:iv-history | 3 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 |
| plugin:account-management | 2 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 1 | 0 | 1 | 14 |
| plugin:vol-surface | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 8 |
| plugin:market-valuation | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 2 |
| plugin:credit-documents | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 0 | 2 |
| plugin:executives | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 5 |
| plugin:econ-statistics | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| plugin:shared | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 2 | 5 |
| registry:gloom-polls | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 7 |
| registry:gloom-prediction-markets | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 13 |
| plugin:holders | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3 |
| plugin:treasury-auctions | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3 |
| plugin:market-movers | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5 |
| plugin:company-kpis | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3 |
| plugin:notes | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 4 |
| plugin:bond-calculator | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| plugin:clinical-trials | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| plugin:realized-vol | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| plugin:research | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 11 |
| plugin:earnings-ripple | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 |
| plugin:filing-events | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3 |
| plugin:doe | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| plugin:broker-manager | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 10 |
| plugin:plugin-marketplace | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 15 |
| plugin:volatility | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| plugin:estimate-revisions | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| plugin:docs | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 10 |
| plugin:help | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 11 |
| plugin:news | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 4 |
| plugin:fx-matrix | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| plugin:power | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 7 | 6 |
| plugin:cpi | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| plugin:time-sales | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| plugin:market-heatmap | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| plugin:awards | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3 |
| plugin:mna | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 2 |
| plugin:insider | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| plugin:kelly-sizer | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 4 |
| plugin:pe-band | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 |
| plugin:exposure | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 14 |
| plugin:company-attention | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| plugin:equity-screener | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 9 |
| plugin:portfolio-list | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 |
| plugin:perps | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 7 |
| plugin:connections | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| plugin:rate-path | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| plugin:econ | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 1 |
| plugin:seasonality | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| plugin:sectors | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| plugin:risk-factors | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 4 |
| plugin:options | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 0 |
| plugin:debug | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| plugin:buildout | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 21 |
| plugin:social-mentions | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3 |
| plugin:thirteenf | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| plugin:options-calculator | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 4 |
| plugin:scanner | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| plugin:catalysts | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 |
| plugin:earnings-calls | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 8 |
| plugin:analytics | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5 |
| plugin:jobs | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 13 |
| plugin:crypto-board | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| plugin:options-scenario | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 17 |
| plugin:cloud-tweets | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 4 |
| plugin:fear-greed | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 8 |

Files with the most literals:

| File | Area | Literals | By kind |
|---|---:|---:|---:|
| src/theme/themes.ts | theme | 482 | colour 457, derivedColour 14, border 25 |
| src/renderers/dom/styles.css | dom-renderer | 228 | colour 72, spacing 61, fontSize 12, border 23, radius 18, shadow 25, lineHeight 4, fontWeight 13 |
| src/renderers/share/styles.css | other | 133 | colour 59, spacing 49, fontSize 8, border 13, radius 2, letterSpacing 1, lineHeight 1 |
| src/components/ui/country-flag-art.tsx | kit | 111 | colour 111 |
| src/renderers/dom/desktop/controls.tsx | dom-renderer | 38 | border 6, spacing 15, colour 5, derivedColour 6, lineHeight 5, fontWeight 2, fontSize 4, letterSpacing 1 |
| src/plugins/builtin/ticker-detail/quote-monitor/card.tsx | plugin:ticker-detail | 34 | fontSize 8, lineHeight 8, cellProps 8, spacing 11, border 3, radius 1, shadow 3 |
| src/components/onboarding/onboarding-frame.tsx | shell | 33 | spacing 16, colour 5, derivedColour 4, shadow 2, cellProps 7, border 1, radius 3, fontSize 3, letterSpacing 1, lineHeight 2 |
| src/components/metric-treemap/heat-surface.tsx | shared-components | 29 | radius 3, spacing 6, shadow 2, letterSpacing 3, fontWeight 3, lineHeight 6, colour 2, derivedColour 3, border 1, fontSize 3, cellProps 3 |
| src/plugins/builtin/chat/attachments/desktop.tsx | plugin:chat | 24 | radius 5, border 3, colour 1, derivedColour 5, spacing 12, fontSize 3 |
| src/plugins/builtin/cloud/company-picker.tsx | plugin:cloud | 23 | radius 4, derivedColour 3, spacing 9, colour 4, border 1, fontSize 2, lineHeight 2, shadow 1, cellProps 1 |
| src/theme/series-colors.ts | theme | 23 | colour 23 |
| src/components/reader/reader-text.tsx | shared-components | 21 | fontSize 4, fontWeight 1, lineHeight 6, spacing 9, border 1 |
| src/plugins/builtin/world-venue-map/map.tsx | plugin:world-venue-map | 18 | derivedColour 7, fontWeight 1, spacing 8, border 2, radius 4, fontSize 2, lineHeight 1 |
| src/renderers/dom/host/tabs.tsx | dom-renderer | 17 | colour 2, spacing 6, border 2, radius 3, fontSize 1, lineHeight 2, fontWeight 1 |
| src/renderers/dom/desktop/dialog-actions.tsx | dom-renderer | 17 | derivedColour 4, colour 2, spacing 7, radius 1, fontSize 2, fontWeight 1, lineHeight 2, letterSpacing 1, shadow 1 |
| src/plugins/builtin/supply-chain/flow.tsx | plugin:supply-chain | 14 | derivedColour 15, cellProps 5, border 4, radius 5, shadow 3, spacing 1, colour 1 |
| src/theme/colors.ts | theme | 14 | colour 14, derivedColour 33 |
| src/plugins/builtin/chat/message/pane-chip.tsx | plugin:chat | 11 | derivedColour 5, radius 3, fontWeight 1, fontSize 2, spacing 4, border 1 |
| src/plugins/builtin/relative-rotation/pane.tsx | plugin:relative-rotation | 11 | colour 11 |
| src/components/pane-settings-dialog/desktop.tsx | shared-components | 11 | letterSpacing 1, derivedColour 2, border 2, radius 3, spacing 5, cellProps 1 |
| src/plugins/builtin/gpu/ladder.tsx | plugin:gpu | 10 | cellProps 2, spacing 6, radius 3, derivedColour 3, border 1 |
| src/components/metric-treemap/index.tsx | shared-components | 10 | derivedColour 7, colour 2, spacing 2, radius 1, lineHeight 1, letterSpacing 1, fontWeight 2, fontSize 1, cellProps 6 |
| src/components/reader/article-reader.tsx | shared-components | 10 | spacing 8, cellProps 1, fontSize 1, lineHeight 1 |
| src/renderers/electrobun/bun/desktop/app-icon.ts | other | 9 | colour 9, derivedColour 5 |
| src/renderers/dom/desktop/list-view.tsx | dom-renderer | 9 | spacing 4, border 3, shadow 1, derivedColour 1, radius 1, cellProps 1 |
| src/plugins/builtin/chart-composer/editor/desktop-view.tsx | plugin:chart-composer | 9 | spacing 8, fontWeight 1, cellProps 1 |
| src/renderers/dom/host/surface-3d.tsx | dom-renderer | 8 | colour 4, radius 2, border 1, shadow 1 |
| src/renderers/dom/host/chart-surface.tsx | dom-renderer | 8 | radius 3, border 3, shadow 1, colour 1 |
| src/plugins/builtin/chat/content/handle-prompt.tsx | plugin:chat | 8 | derivedColour 1, spacing 6, border 1, fontWeight 1 |
| src/plugins/builtin/world-venue-map/geo-draw.tsx | plugin:world-venue-map | 8 | colour 8 |
| src/components/chart/composite/toolbar.tsx | shared-components | 8 | spacing 3, radius 3, border 1, cellProps 1, colour 1 |
| src/components/onboarding/onboarding-wizard.tsx | shell | 7 | spacing 7 |
| src/components/onboarding/portfolio-step/positions-panel.tsx | shell | 7 | spacing 6, radius 1, derivedColour 1, cellProps 2 |
| src/components/reader/detail-reader.tsx | shared-components | 7 | spacing 6, lineHeight 1 |
| src/components/layout/header.tsx | shell | 6 | derivedColour 9, border 3, radius 1, cellProps 7, spacing 1, shadow 1 |
| src/plugins/builtin/chat/content/new-dm-dialog.tsx | plugin:chat | 5 | spacing 5, cellProps 1 |
| src/plugins/builtin/revenue-breakdown/bars.tsx | plugin:revenue-breakdown | 5 | derivedColour 4, spacing 3, border 1, radius 1 |
| src/plugins/builtin/supply-chain/disclosure-quote.tsx | plugin:supply-chain | 5 | cellProps 1, border 1, spacing 3, radius 1, derivedColour 1 |
| src/components/form-modal/field-row.tsx | shared-components | 5 | border 2, radius 2, spacing 1 |
| src/components/chart/composite/tools.ts | shared-components | 5 | colour 5 |

Cell spacing props in panes (the terminal's units, drawn as cells on the desktop): paddingX=1 in 111 files, gap=1 in 81 files, paddingY=1 in 29 files, marginTop=1 in 19 files, gap=2 in 18 files, paddingTop=1 in 16 files, paddingLeft=1 in 14 files, paddingRight=1 in 11 files, paddingLeft=2 in 9 files, paddingBottom=1 in 9 files, padding=1 in 4 files, gap=3 in 4 files, paddingX=2 in 4 files, paddingLeft=3 in 3 files, marginRight=1 in 3 files, marginTop=0 in 3 files.

## Families in detail

### Buttons (`button`): 29 variants in 468 views, 14 components, [grid](grids/button.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `h=18 w=20 pad=0 4 0 4 border=0 radius=4 font=none icon fill=none` | 461 | 3021 | IconButton 2856, Tabs 163, DialogFrame 2 | text-dim on none; warning on none |
| 2 | `h=18 w=20 pad=0 0 0 0 border=0 radius=0 font=none icon fill=none` | 457 | 914 | PaneHeader 914 | text on none |
| 3 | `h=18 w=22 pad=0 4 0 4 border=0 radius=4 font=none icon fill=none` | 72 | 138 | IconButton 138 | warning on none |
| 4 | `h=18 w=auto pad=0 8 0 8 border=1 radius=6 shadow=c 0px 1px 2px 0px font=12/600 fill=own` | 51 | 92 | Button 92 | text on derived panelFill() |
| 5 | `h=19 w=auto pad=0 10 0 8 border=0 radius=0 shadow=color(srgb 0.8 0.8 0.8 / 0.14) -1px 0px 0px 0px inset font=12/400 fill=none` | 44 | 86 | PageStackView 84, QueryBar 2 | text on none |
| 6 | `h=18 w=auto pad=0 8 0 8 border=1 radius=6 shadow=c 0px 1px 2px 0px font=12/700 fill=own` | 40 | 68 | Button 68 | bg on text-bright |
| 7 | `h=18 w=auto pad=0 2 0 2 border=1 radius=6 shadow=c 0px 1px 2px 0px font=12/600 fill=own` | 25 | 44 | Button 44 | text on derived panelFill() |
| 8 | `h=14 w=14 pad=0 0 0 0 border=0 radius=3 font=none icon fill=none` | 17 | 34 | QueryBar 24, FilterChip 6, TextField2 4 | text-muted on none |
| 9 | `h=18 w=20 pad=0 4 0 4 border=0 radius=4 font=none icon fill=own` | 16 | 16 | IconButton 10, Tabs 6 | text-bright on mixed (color-mix) |
| 10 | `h=18 w=auto pad=0 0 0 0 border=0 radius=6 font=12/600 fill=none` | 15 | 164 | Button 164 | text-bright on none; text on none |
| 11 | `h=19 w=auto pad=0 10 0 10 border=0 radius=0 shadow=color(srgb 0.8 0.8 0.8 / 0.14) -1px 0px 0px 0px inset font=12/400 fill=none` | 14 | 26 | FilterChip 26 | text on none |
| 12 | `h=14 w=auto pad=0 8 0 8 border=0 radius=3 font=12/700 fill=own` | 8 | 99 | TickerBadge 99 | text-bright on off-palette rgb(46, 46, 46); negative on off-palette rgb(46, 9, 9) |
| 13 | `h=18 w=auto pad=0 2 0 2 border=1 radius=6 font=11.5/600 fill=none` | 8 | 64 | Button 64 | text-dim on none |
| 14 | `h=18 w=13 pad=0 2 0 2 border=1 radius=6 font=11.5/600 icon fill=none` | 8 | 16 | Button 16 | text-dim on none |
| 15 | `h=18 w=auto pad=0 8 0 8 border=1 radius=6 font=11.5/600 fill=none` | 8 | 8 | Button 8 | text-dim on none |

14 more variants in report.json.

### Chips and badges (`chip`): 16 variants in 166 views, 8 components, [grid](grids/chip.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `h=19 w=auto pad=0 0 0 0 border=0 radius=0 font=12/400 fill=none` | 136 | 517 | FilterChip 517 | mixed (color-mix) on none |
| 2 | `h=18 w=auto pad=0 0 0 0 border=0 radius=0 font=12/700 fill=none` | 19 | 419 | Badge 333, TickerBadge 86 | text-bright on none; text-dim on none |
| 3 | `h=18 w=21 pad=0 4 0 4 border=0 radius=4 font=none icon fill=none` | 13 | 110 | ChartToolChip 110 | text on none |
| 4 | `h=18 w=21 pad=0 4 0 4 border=0 radius=4 font=none icon fill=own` | 13 | 26 | ChartToolChip 26 | text on selected |
| 5 | `h=14 w=auto pad=0 8 0 8 border=0 radius=3 font=12/700 fill=own` | 11 | 333 | Badge 333 | text-bright on selected; text-bright on off-palette rgb(71, 71, 71) |
| 6 | `h=18 w=30 pad=0 0 0 0 border=0 radius=0 font=12/700 icon fill=none` | 9 | 64 | Badge 54, TickerBadge 10 | text-bright on none; text-dim on none |
| 7 | `h=18 w=auto pad=0 8 0 0 border=0 radius=0 font=11.5/600 fill=none` | 8 | 48 | StatusBarChip 48 | text-dim on none |
| 8 | `h=14 w=30 pad=0 8 0 8 border=0 radius=3 font=12/700 icon fill=own` | 6 | 54 | Badge 54 | text-bright on selected; text-dim on derived commandBarPanelBg() |
| 9 | `h=18 w=23 pad=0 0 0 0 border=0 radius=0 font=12/700 icon fill=none` | 4 | 46 | Badge 46 | text-bright on none |
| 10 | `h=14 w=23 pad=0 8 0 8 border=0 radius=3 font=12/700 icon fill=own` | 4 | 46 | Badge 46 | text-bright on selected |
| 11 | `h=18 w=auto pad=0 8 0 0 border=0 radius=0 font=12/700 fill=none` | 4 | 13 | TickerBadge 13 | positive on none; text-bright on none |
| 12 | `h=18 w=48 pad=0 0 0 0 border=0 radius=0 font=12/400 icon fill=none` | 2 | 18 | CommandBarRowBadge 18 | off-palette rgb(198, 172, 85) on none; off-palette rgb(210, 210, 210) on none |
| 13 | `h=18 w=38 pad=0 8 0 0 border=0 radius=0 font=12/700 icon fill=none` | 2 | 2 | TickerBadge 2 | text-bright on none |
| 14 | `h=18 w=auto pad=0 0 0 0 border=0 radius=0 font=12/400 fill=none` | 1 | 38 | CommandBarRowBadge 38 | off-palette rgb(210, 210, 210) on none |
| 15 | `h=22 w=auto pad=1 7 1 7 border=1 radius=6 font=12/600 fill=own` | 1 | 2 | DesktopValuePill 2 | text-dim on derived panelFill() |

1 more variants in report.json.

### Toolbars and filter rows (`toolbar`): 16 variants in 312 views, 3 components, [grid](grids/toolbar.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `pad=0 0 0 0 border=0 radius=0 font=12/400 fill=none` | 169 | 322 | QueryBar 322 | mixed (color-mix) on none; text-muted on none |
| 2 | `pad=0 0 1 0 border=0 radius=0 shadow=color(srgb 0.8 0.8 0.8 / 0.14) 0px -1px 0px 0px inset font=12/400 fill=own` | 139 | 268 | QueryBar 268 | mixed (color-mix) on mixed (color-mix); text-muted on mixed (color-mix) |
| 3 | `pad=0 10 0 8 border=0 radius=0 shadow=color(srgb 0.8 0.8 0.8 / 0.14) -1px 0px 0px 0px inset font=10/400 icon fill=none` | 122 | 226 | QueryBar 226 | text-muted on none |
| 4 | `pad=0 0 1 0 border=0 radius=0 shadow=color(srgb 0.8 0.8 0.8 / 0.14) 0px -1px 0px 0px inset font=12/600 fill=own` | 71 | 131 | QueryBar 131 | text-bright on mixed (color-mix) |
| 5 | `pad=0 0 1 0 border=0 radius=0 shadow=color(srgb 0.8 0.8 0.8 / 0.14) 0px -1px 0px 0px inset font=10/400 fill=own` | 66 | 117 | QueryBar 117 | text-muted on mixed (color-mix) |
| 6 | `pad=0 0 1 0 border=0 radius=0 shadow=color(srgb 0.8 0.8 0.8 / 0.14) 0px -1px 0px 0px inset font=10/400 icon fill=own` | 56 | 111 | QueryBar 111 | text-muted on mixed (color-mix) |
| 7 | `pad=0 10 0 10 border=0 radius=0 shadow=color(srgb 0.8 0.8 0.8 / 0.14) -1px 0px 0px 0px inset font=12/400 fill=none` | 13 | 23 | TextField2 23 | mixed (color-mix) on none |
| 8 | `pad=0 10 0 8 border=0 radius=0 shadow=color(srgb 0.8 0.8 0.8 / 0.14) -1px 0px 0px 0px inset font=none icon fill=none` | 12 | 24 | QueryBar 24 | text-muted on none |
| 9 | `pad=1 0 0 0 border=0 radius=0 shadow=color(srgb 0.8 0.8 0.8 / 0.14) 0px 1px 0px 0px inset font=none icon fill=own` | 9 | 18 | InlineQuickAddRow 18 | text on mixed (color-mix) |
| 10 | `pad=0 8 0 8 border=0 radius=0 font=none icon fill=own` | 8 | 16 | InlineQuickAddRow 16 | text on panel |
| 11 | `pad=0 10 0 8 border=0 radius=0 shadow=color(srgb 0.8 0.8 0.8 / 0.14) -1px 0px 0px 0px inset font=12/400 fill=none` | 7 | 13 | TextField2 13 | mixed (color-mix) on none |
| 12 | `pad=0 10 0 10 border=0 radius=0 shadow=color(srgb 0.8 0.8 0.8 / 0.14) -1px 0px 0px 0px inset font=12/400 icon fill=none` | 6 | 11 | TextField2 11 | mixed (color-mix) on none |
| 13 | `pad=0 0 1 0 border=0 radius=0 shadow=color(srgb 0.8 0.8 0.8 / 0.14) 0px -1px 0px 0px inset font=none icon fill=own` | 3 | 5 | QueryBar 5 | text on mixed (color-mix) |
| 14 | `pad=0 10 0 8 border=0 radius=0 shadow=color(srgb 0.8 0.8 0.8 / 0.14) -1px 0px 0px 0px inset font=12/400 icon fill=none` | 2 | 4 | TextField2 4 | mixed (color-mix) on none |
| 15 | `pad=0 0 1 0 border=0 radius=0 shadow=color(srgb 0.8 0.8 0.8 / 0.14) 0px -1px 0px 0px inset font=12/700 fill=own` | 1 | 2 | QueryBar 2 | text-bright on mixed (color-mix) |

1 more variants in report.json.

### Tabs (`tab`): 11 variants in 357 views, 1 components, [grid](grids/tab.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `h=18 w=auto pad=0 10 4 10 border=1/1/0/1 radius=6 6 0 0 font=13/700 fill=own` | 356 | 713 | Tabs 713 | text-bright on off-palette rgb(23, 23, 23); text-bright on derived paneBg(focused) |
| 2 | `h=18 w=auto pad=0 10 4 10 border=1/1/0/1 radius=6 6 0 0 font=13/500 fill=none` | 355 | 2831 | Tabs 2831 | text-dim on none |
| 3 | `h=18 w=auto pad=0 5 2 5 border=1 radius=5 font=12/500 fill=none` | 33 | 89 | Tabs 89 | text-dim on none |
| 4 | `h=18 w=auto pad=0 5 2 5 border=1 radius=5 font=12/700 fill=none` | 33 | 54 | Tabs 54 | text-bright on none; text on none |
| 5 | `h=18 w=38 pad=0 10 4 10 border=1/1/0/1 radius=6 6 0 0 font=13/500 icon fill=none` | 20 | 23 | Tabs 23 | text-dim on none |
| 6 | `h=18 w=auto pad=0 10 4 10 border=1/1/0/1 radius=6 6 0 0 font=13/500 fill=own` | 14 | 25 | Tabs 25 | text on off-palette rgb(68, 68, 68) |
| 7 | `h=14 w=auto pad=0 8 0 8 border=1 radius=6 font=12/500 fill=none` | 12 | 72 | Tabs 72 | text-dim on none |
| 8 | `h=14 w=auto pad=0 8 0 8 border=1 radius=6 font=12/700 fill=none` | 12 | 24 | Tabs 24 | text-bright on none |
| 9 | `h=18 w=38 pad=0 10 4 10 border=1/1/0/1 radius=6 6 0 0 font=13/700 icon fill=own` | 2 | 3 | Tabs 3 | text-bright on off-palette rgb(23, 23, 23) |
| 10 | `h=18 w=auto pad=0 5 0 5 border=1 radius=5 font=12/700 fill=none` | 1 | 2 | Tabs 2 | text-bright on none |
| 11 | `h=18 w=auto pad=0 5 0 5 border=1 radius=5 font=12/500 fill=none` | 1 | 2 | Tabs 2 | text-dim on none |

### Toggles and checkboxes (`toggle`): 9 variants in 151 views, 3 components, [grid](grids/toggle.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `h=19 w=auto pad=0 8 0 8 border=0 radius=0 font=12/400 fill=none` | 147 | 603 | QueryBar 386, InlineChoices 217 | mixed (color-mix) on none; text-muted on none |
| 2 | `h=19 w=auto pad=0 8 0 8 border=0 radius=0 shadow=c 0px -2px 0px 0px inset font=12/600 fill=own` | 142 | 291 | QueryBar 219, InlineChoices 72 | text-bright on mixed (color-mix) |
| 3 | `h=19 w=30 pad=0 8 0 8 border=0 radius=0 font=12/400 icon fill=none` | 20 | 154 | InlineChoices 138, QueryBar 16 | mixed (color-mix) on none |
| 4 | `h=19 w=30 pad=0 8 0 8 border=0 radius=0 shadow=c 0px -2px 0px 0px inset font=12/600 icon fill=own` | 10 | 22 | InlineChoices 18, QueryBar 4 | text-bright on mixed (color-mix) |
| 5 | `h=19 w=23 pad=0 8 0 8 border=0 radius=0 font=12/400 icon fill=none` | 5 | 24 | QueryBar 22, InlineChoices 2 | mixed (color-mix) on none |
| 6 | `h=14 w=14 pad=0 0 0 0 border=1 radius=4 shadow=c 0px 1px 0px 0px inset font=none icon fill=own` | 2 | 4 | Checkbox 4 | text-bright on derived panelFill() |
| 7 | `h=19 w=23 pad=0 8 0 8 border=0 radius=0 shadow=c 0px -2px 0px 0px inset font=12/600 icon fill=own` | 2 | 4 | QueryBar 2, InlineChoices 2 | text-bright on mixed (color-mix) |
| 8 | `h=20 w=auto pad=0 0 0 0 border=0 radius=0 font=12/500 fill=none` | 1 | 2 | Checkbox 2 | text on none |
| 9 | `h=14 w=22 pad=0 0 0 0 border=0 radius=0 font=none icon fill=none` | 1 | 2 | Checkbox 2 | text on none |

### Chart legends (`legend`): 7 variants in 71 views, 3 components, [grid](grids/legend.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `pad=0 0 0 0 border=0 radius=0 font=12/400 fill=none` | 68 | 426 | CompositeLegend 426 | text on none; text-muted on none |
| 2 | `pad=0 0 0 8 border=0 radius=0 font=12/400 fill=none` | 68 | 126 | CompositeLegend 126 | text on none; text-muted on none |
| 3 | `pad=0 0 0 0 border=1 radius=999 font=none icon fill=own` | 38 | 94 | CompositeSeriesSwatch 94 | text on positive; text on warning |
| 4 | `pad=0 0 0 0 border=0 radius=0 font=none icon fill=none` | 36 | 131 | CompositeSeriesSwatch 131 | text on none |
| 5 | `pad=0 0 0 0 border=0 radius=0 font=none icon fill=own` | 36 | 73 | CompositeSeriesSwatch 73 | text on positive; text on warning |
| 6 | `pad=0 0 0 0 border=0 radius=0 font=10.2/400 fill=none` | 2 | 4 | GeoLegend 4 | text-dim on none |
| 7 | `pad=0 0 0 8 border=0 radius=0 font=none icon fill=none` | 1 | 2 | CompositeLegend 2 | text on none |

### Selects (`select`): 6 variants in 141 views, 4 components, [grid](grids/select.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `h=19 w=auto pad=0 10 0 10 border=0 radius=0 shadow=color(srgb 0.8 0.8 0.8 / 0.14) -1px 0px 0px 0px inset font=12/400 fill=none` | 91 | 390 | FilterChip 390 | mixed (color-mix) on none |
| 2 | `h=19 w=auto pad=0 10 0 8 border=0 radius=0 shadow=color(srgb 0.8 0.8 0.8 / 0.14) -1px 0px 0px 0px inset font=12/400 fill=none` | 61 | 121 | FilterChip 121 | mixed (color-mix) on none |
| 3 | `h=18 w=auto pad=0 0 0 0 border=0 radius=0 font=12/400 fill=none` | 5 | 68 | SelectButton 28, SelectField 20, Popover 20 | text on none; text-muted on none |
| 4 | `h=18 w=22 pad=0 0 0 0 border=0 radius=0 font=12/400 icon fill=none` | 4 | 16 | SelectField 8, Popover 8 | text on none |
| 5 | `h=19 w=auto pad=0 10 0 8 border=0 radius=0 shadow=color(srgb 0.8 0.8 0.8 / 0.14) -1px 0px 0px 0px inset, c 0px font=12/400 fill=own` | 2 | 4 | FilterChip 4 | mixed (color-mix) on mixed (color-mix) |
| 6 | `h=19 w=auto pad=0 10 0 10 border=0 radius=0 shadow=color(srgb 0.8 0.8 0.8 / 0.14) -1px 0px 0px 0px inset, c 0px font=12/400 fill=own` | 1 | 2 | FilterChip 2 | mixed (color-mix) on mixed (color-mix) |

### Table header cells (`table-header-cell`): 5 variants in 320 views, 1 components, [grid](grids/table-header-cell.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `h=20 pad=0 0 0 0 border=0 radius=0 font=12/700 fill=own` | 320 | 3652 | DataTable 3652 | text-dim on panel; text on panel |
| 2 | `h=20 pad=0 0 0 0 border=0 radius=0 font=12/700 icon fill=own` | 67 | 203 | DataTable 203 | text-dim on panel; text on panel |
| 3 | `h=20 pad=0 0 0 0 border=0 radius=0 shadow=c -8px 0px 0px 0px, c 8px 0px 0px 0px font=12/700 fill=own` | 57 | 109 | DataTable 109 | text-dim on panel; text on panel |
| 4 | `h=20 pad=0 0 0 0 border=0 radius=0 font=none icon fill=own` | 14 | 14 | DataTable 14 | text on panel |
| 5 | `h=20 pad=0 0 0 0 border=0 radius=0 shadow=c -8px 0px 0px 0px, c 8px 0px 0px 0px font=none icon fill=own` | 1 | 2 | DataTable 2 | text on panel |

### Tab bars (`tab-bar`): 5 variants in 357 views, 2 components, [grid](grids/tab-bar.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `h=20 pad=0 0 0 0 border=0 radius=0 font=13/500 fill=none` | 258 | 1548 | Tabs 1032, PaneHeader 516 | text-dim on none; text on none |
| 2 | `h=20 pad=0 0 0 0 border=0 radius=0 font=13/700 fill=none` | 101 | 600 | Tabs 400, PaneHeader 200 | text-bright on none; text on none |
| 3 | `h=18 pad=0 0 0 0 border=0 radius=0 font=12/700 fill=none` | 32 | 52 | Tabs 52 | text-bright on none; text on none |
| 4 | `h=18 pad=2 4 2 4 border=0 radius=0 font=12/700 fill=none` | 12 | 24 | Tabs 24 | text-bright on none |
| 5 | `h=18 pad=0 0 0 0 border=0 radius=0 font=12/500 fill=none` | 2 | 4 | Tabs 4 | text-dim on none |

### Cards (`card`): 4 variants in 4 views, 4 components, [grid](grids/card.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `pad=0 8 0 8 border=1/1/0/1 radius=8 shadow font=12` | 2 | 4 | HeaderCommandPrompt 4 | text on derived commandBarPanelBg() |
| 2 | `pad=14 14 14 14 border=0/1/1/1 radius=0 shadow font=12` | 2 | 4 | CommandBarPanel 4 | neutral on derived commandBarPanelBg() |
| 3 | `pad=4 0 4 12 border=0/0/0/3 radius=2 font=12` | 1 | 2 | DisclosureQuote 2 | text-dim on off-palette rgb(5, 12, 17) |
| 4 | `pad=0 0 0 0 border=1 radius=6 shadow font=12` | 1 | 2 | FocusCard 2 | text-bright on panel |

### Key-value rows (`kv-row`): 4 variants in 117 views, 6 components, [grid](grids/kv-row.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `pad=0 0 0 0 border=0 radius=0 font=12/400 fill=none` | 116 | 639 | NativeKeyValueRow 374, StatGrid 192, ColumnGrid 41 | text-dim on none |
| 2 | `pad=0 0 0 0 border=0 radius=0 shadow=color(srgb 0.8 0.8 0.8 / 0.12) 0px 1px 0px 0px inset font=12/400 fill=none` | 76 | 262 | StatGrid 225, FieldGrid 37 | text-dim on none |
| 3 | `pad=7 4 8 4 border=0 radius=6 font=12/650 fill=none` | 1 | 4 | DesktopSettingsRow 4 | text on none |
| 4 | `pad=7 4 8 4 border=0 radius=6 font=12/650 fill=own` | 1 | 2 | DesktopSettingsRow 2 | text on derived floatingPaneBg(focused) |

### Key caps (`keycap`): 3 variants in 174 views, 2 components, [grid](grids/keycap.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `h=15 w=15 pad=0 0 0 0 border=0 radius=3 font=10/400 icon fill=own` | 122 | 226 | QueryBar 226 | text-muted on mixed (color-mix) |
| 2 | `h=14 w=16 pad=0 3.8 0 3.8 border=0 radius=3 shadow=c 0px 0px 0px 1px inset font=10.1/500 icon fill=own` | 61 | 104 | Button 104 | off-palette rgb(71, 71, 71) on off-palette rgb(230, 230, 230); off-palette rgb(149, 149, 149) on derived commandBarInputBg() |
| 3 | `h=14 w=auto pad=0 3.8 0 3.8 border=0 radius=3 shadow=c 0px 0px 0px 1px inset font=10.1/500 fill=own` | 8 | 16 | Button 16 | off-palette rgb(149, 149, 149) on derived commandBarInputBg() |

### Inputs and search boxes (`input`): 3 variants in 175 views, 5 components, [grid](grids/input.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `h=18 w=auto pad=0 0 0 0 border=0 radius=0 font=none fill=none` | 169 | 353 | InputSearchBar 303, InlineQuickAddRow 34, TextFieldControl 12 | text on none |
| 2 | `h=18 w=auto pad=0 8 0 8 border=0 radius=6 font=none fill=own` | 5 | 76 | TextFieldControl 76 | text on bg |
| 3 | `h=106 w=auto pad=6 8 6 8 border=0 radius=0 font=none fill=own` | 1 | 2 | DialogFrame 2 | text on panel |

### Pane title bars (`pane-title-bar`): 3 variants in 467 views, 1 components, [grid](grids/pane-title-bar.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `h=20 pad=0 6 1 6 border=0 radius=0 shadow=c 0px -1px 0px 0px inset font=12/700 fill=own` | 453 | 884 | PaneHeader 884 | text-bright on derived paneTitleBg(focused) |
| 2 | `h=20 pad=0 6 1 6 border=0 radius=0 shadow=c 0px -1px 0px 0px inset font=12/600 fill=own` | 36 | 48 | PaneHeader 48 | derived paneTitleText() on derived paneTitleBg() |
| 3 | `h=20 pad=0 6 1 6 border=0 radius=0 shadow=c 0px -1px 0px 0px inset font=12/700 icon fill=own` | 2 | 4 | PaneHeader 4 | text-bright on derived paneTitleBg(focused) |

### Table rows (`table-row`): 3 variants in 254 views, 1 components, [grid](grids/table-row.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `h=18 pad=0 8 0 8 border=0 radius=0 font=12/400 fill=own` | 229 | 8459 | DataTable 8459 | text-dim on bg; text on bg |
| 2 | `h=18 pad=0 8 0 8 border=0 radius=0 font=12/700 fill=own` | 49 | 1863 | DataTable 1863 | text-bright on bg; text-bright on selected |
| 3 | `h=18 pad=0 0 0 0 border=0 radius=0 font=12/700 fill=own` | 1 | 46 | DataTable 46 | text-bright on bg |

### Pane footers (`pane-footer`): 3 variants in 402 views, 1 components, [grid](grids/pane-footer.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `h=20 pad=0 8 0 8 border=1/0/0/0 radius=0 shadow=c 0px 1px 0px 0px inset font=11.5/400 fill=own` | 262 | 508 | PaneFooterBar 508 | text-muted on derived paneBg(focused); warning on derived paneBg(focused) |
| 2 | `h=20 pad=0 8 0 8 border=1/0/0/0 radius=0 shadow=c 0px 1px 0px 0px inset font=11.5/700 fill=own` | 137 | 256 | PaneFooterBar 256 | text-bright on derived paneBg(focused); warning on derived paneBg(focused) |
| 3 | `h=20 pad=0 8 0 8 border=1/0/0/0 radius=0 shadow=c 0px 1px 0px 0px inset font=none icon fill=own` | 17 | 24 | PaneFooterBar 24 | text on derived paneBg(focused) |

### Empty states (`state-empty`): 3 variants in 149 views, 2 components, [grid](grids/state-empty.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `pad=0 0 0 0 border=0 radius=0 font=12/400 fill=none` | 142 | 277 | EmptyStateBody 262, PaneStatusBody 15 | text-dim on none; negative on none |
| 2 | `pad=0 8 0 8 border=0 radius=0 font=12/400 fill=none` | 7 | 14 | PaneStatusBody 14 | text-dim on none |
| 3 | `pad=0 0 0 0 border=0 radius=0 font=12/700 fill=none` | 3 | 6 | PaneStatusBody 6 | text on none |

### Chart axes (`axis`): 3 variants in 100 views, 2 components, [grid](grids/axis.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `pad=0 0 0 0 border=0 radius=0 font=12/400 fill=none` | 100 | 189 | StaticXAxisLabels 189 | text-dim on none |
| 2 | `pad=0 0 0 0 border=0 radius=0 font=12/400 fill=own` | 48 | 205 | SeriesAxisTags 205 | positive on derived paneBg(focused); warning on derived paneBg(focused) |
| 3 | `pad=0 0 0 0 border=0 radius=0 font=12/400 icon fill=own` | 2 | 4 | SeriesAxisTags 4 | negative on derived paneBg(focused) |

### List rows (`list-row`): 3 variants in 2 views, 1 components, [grid](grids/list-row.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `h=18 pad=0 0 0 0 border=0 radius=0 font=12/400 fill=own` | 2 | 28 | PaneSidebarRow 28 | text-dim on panel; text-bright on derived commandBarInputBg() |
| 2 | `h=18 pad=0 0 0 0 border=0 radius=0 font=12/400 icon fill=own` | 1 | 2 | PaneSidebarRow 2 | text-dim on panel |
| 3 | `h=18 pad=0 0 0 0 border=0 radius=0 font=12/400 fill=none` | 1 | 2 | PaneSidebarRow 2 | text-bright on none |

### Links (`link`): 3 variants in 10 views, 2 components, [grid](grids/link.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `pad=0 0 0 0 border=0 radius=0 font=12/400/underline fill=none` | 8 | 33 | ExternalLinkText 33 | text-bright on none; text on none |
| 2 | `pad=0 0 0 0 border=0 radius=0 font=14/400/underline fill=none` | 2 | 12 | SegmentSpan 12 | text-bright on none |
| 3 | `pad=0 0 0 0 border=0 radius=0 font=12/400/underline icon fill=none` | 1 | 2 | ExternalLinkText 2 | text-bright on none |

### Table header rows (`table-header-row`): 2 variants in 320 views, 1 components, [grid](grids/table-header-row.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `h=20 pad=0 8 0 8 border=0 radius=0 font=12/700 fill=own` | 319 | 632 | DataTable 632 | text-dim on panel; text on panel |
| 2 | `h=20 pad=0 0 0 0 border=0 radius=0 font=12/700 fill=own` | 1 | 4 | DataTable 4 | text-dim on panel |

### Table section rows (`table-section-row`): 2 variants in 37 views, 1 components, [grid](grids/table-section-row.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `h=18 pad=0 8 0 8 border=0 radius=0 font=12/700 fill=own` | 36 | 217 | DataTable 217 | text-bright on bg; text-muted on bg |
| 2 | `h=18 pad=0 0 0 0 border=0 radius=0 font=12/700 fill=own` | 1 | 4 | DataTable 4 | text-bright on bg |

### Locked, Pro and sign-in states (`state-locked`): 2 variants in 42 views, 2 components, [grid](grids/state-locked.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `pad=18 8 18 8 border=0 radius=0 font=12/400 fill=none` | 34 | 56 | WallTeaser 56 | text-dim on none |
| 2 | `pad=0 0 0 0 border=0 radius=0 font=12/400 fill=none` | 8 | 14 | UpgradeLabel 14 | text-bright on none |

### Notices (stale, delayed, errors) (`state-notice`): 2 variants in 50 views, 2 components, [grid](grids/state-notice.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `pad=18 8 18 8 border=0 radius=0 font=12/400 fill=none` | 49 | 102 | PaneStatusBody 102 | text-dim on none; negative on none |
| 2 | `pad=0 0 0 0 border=0 radius=0 font=12/400 fill=none` | 1 | 2 | Notice 2 | text-dim on none |

### Detail back rows (`back-row`): 2 variants in 43 views, 1 components, [grid](grids/back-row.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `h=20 pad=0 0 1 0 border=0 radius=0 shadow=color(srgb 0.8 0.8 0.8 / 0.14) 0px -1px 0px 0px inset font=12/400 fill=own` | 43 | 84 | PageStackView 84 | text on mixed (color-mix) |
| 2 | `h=37 pad=0 0 1 0 border=0 radius=0 shadow=color(srgb 0.8 0.8 0.8 / 0.14) 0px -1px 0px 0px inset font=12/400 fill=own` | 2 | 2 | PageStackView 2 | text on mixed (color-mix) |

### Loading states (`state-loading`): 2 variants in 7 views, 2 components, [grid](grids/state-loading.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `pad=0 0 0 0 border=0 radius=0 font=12/400 fill=none` | 7 | 16 | Spinner 16 | text-dim on none |
| 2 | `pad=0 0 0 0 border=0 radius=0 font=12/400 icon fill=none` | 7 | 16 | SpinnerMark 16 | text-dim on none |

### App header (`app-header`): 1 variants in 8 views, 1 components, [grid](grids/app-header.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `h=28 pad=0 12 0 0 border=0 radius=0 shadow=c 0px -1px 0px 0px, c 0px 1px 0px 0px inset font=12/700 fill=own` | 8 | 16 | Header 16 | off-palette rgb(221, 221, 221) on header; text on header |

### Status bar (`status-bar`): 1 variants in 8 views, 1 components, [grid](grids/status-bar.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `h=18 pad=0 8 0 8 border=1/0/0/0 radius=0 shadow=c 0px 1px 0px 0px inset font=11.5/600 fill=own` | 8 | 16 | NativeStatusBar 16 | text-dim on panel |

### Dialogs (`dialog`): 1 variants in 2 views, 1 components, [grid](grids/dialog.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `pad=0 0 0 0 border=1 radius=6 shadow=color(srgb 0 0 0 / 0.46) 0px 18px 48px 0px, color(srgb 1 1 1 font=12/700 fill=own` | 2 | 4 | DomHostProviders 4 | text on panel |

### Footer key hints (`pane-hint`): 1 variants in 306 views, 1 components, [grid](grids/pane-hint.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `h=18 pad=0 0 0 0 border=0 radius=4 font=11.5/700 fill=none` | 306 | 1363 | ShortcutHint 1363 | text-bright on none |

### Sort indicators (`sort-indicator`): 1 variants in 132 views, 1 components, [grid](grids/sort-indicator.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `h=9 pad=0 0 0 0 border=0 radius=0 font=none icon fill=none` | 132 | 250 | DataTable 250 | text on none |

### Section headings (`section-heading`): 1 variants in 13 views, 1 components, [grid](grids/section-heading.png)

| # | Shape | Views | Elements | Drawn by | Colours (text on fill) |
|---|---:|---:|---:|---:|---:|
| 1 | `pad=0 0 0 0 border=0 radius=0 font=12/700 fill=none` | 13 | 60 | SectionHeading 60 | text-bright on none |
