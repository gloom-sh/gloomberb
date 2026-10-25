The standard browser catalog omits the functions below. Their actual desktop pane components were captured separately on both revisions at 640 and 1280 pixels in dark and light themes. Captures use in-memory fixtures or the same offline replay; they do not verify native service integration.

| Function | Pane | Desktop coverage |
|---|---|---|
| 13F | thirteenf-funds | Root, offline data state |
| ALRT | alerts | Root, empty state |
| BR | brokers | Root, no profiles |
| debug-log | debug | Root, fresh session log |
| ERN | earnings-calendar | Root, Names menus, selected industry result |
| EVTS | earnings-calendar | Shares the Earnings component covered above |
| HDS | holders | Root, no ticker selected |
| MOST | market-movers | Root, offline data state |
| NOTE | quick-notes | Root, in-memory research note |
| ORD | broker-orders | Root, no broker selected |
| PL | plugin-marketplace | Root, offline data state |
| TBO | buildout | Root, offline data state |
| twitter-feed-pane | twitter-feed | Root, empty query |
| VIEW | custom-view | Root, no saved view |

All 96 additional desktop captures showed the expected pane and no runtime exceptions. Across the 48 before/after pairs, 45 were pixel-identical; three X Feed images differed only by the 14-pixel blinking search caret. No pair exceeded the standard benchmark movement threshold (0.05% of pixels).

This extends the browser sweep's coverage to every omitted pane component’s root state. It does not claim a full interaction sweep of these native-oriented panes.
