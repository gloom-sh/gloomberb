The command prompt and its sheet now keep main’s geometry. The longer pre-market countdown uses only spare header space after the prompt and update status have their room.

Compared main `23ee2cf78a94c40aa0b81f5d58e6159a44eb858e` with fixed `f3cb85fc5970b7918d3542eccf4278a90d602811`.

The earlier change enlarged the widest market reservation from 42 to 58 columns to fit “to regular open”. That reservation also sized the command prompt, even when the market was closed. At a 1280px browser width, it reduced the sheet from 102 columns (816px) to 87 columns (696px). The left edge stayed at 8px; the right edge moved from 824px to 704px. The theme picker and command search use the same sheet and inherited the change. At 640px, the unchanged 21-column reservation explained why those captures did not move.

At 120 terminal columns, the opposite happened: the 58-column reservation could not fit, so selection fell to the 31-column tier instead of 42. That widened the prompt from 63 to 74 columns. Changing the test expectation had accepted the regression; the expected width is restored to 63.

The fix retains `[42, 31, 21]` for prompt sizing. Only after that width is fixed can the market cluster expand to 58 columns, using spare space. An active update status keeps its previous space. At 1280px the sheet is again 816px wide with right edge at 824px.

The geometry sweep covered 35,088 cases from 46 through 320 cells in eighth-cell steps, including terminal, browser, desktop titlebar insets, fullscreen and active update states. It found zero prompt position/width changes and zero active-update geometry changes against main. See [the geometry summary](geometry-parity-summary.json).

The browser comparisons below place main on the left and the fix on the right. All three sheets retain the same left and right edges, selected-row width, text columns and vertical extent at both window sizes. These crops cover the shell views; the complete pane/plugin benchmark and its coverage limits are in [the benchmark report](benchmark.md).

| View | 640px | 1280px |
|---|---|---|
| Command bar | [Comparison](command-bar-640-main-fixed.png) | [Comparison](command-bar-1280-main-fixed.png) |
| Theme picker | [Comparison](theme-picker-640-main-fixed.png) | [Comparison](theme-picker-1280-main-fixed.png) |
| Command search | [Comparison](command-bar-search-640-main-fixed.png) | [Comparison](command-bar-search-1280-main-fixed.png) |

The terminal captures render the actual Header in tmux with a fixed pre-market clock and local quote fixture. At 120 and 160 columns the whole timer gives way; the state, quote and currency remain intact. At 200 columns the header shows “PRE-MKT · 4h 33m to regular open”. No clipping, wrapping, overlap or runtime warnings were observed. PNGs reproduce the captured terminal cells; they are not emulator screenshots.

| Terminal width | Main | Fixed |
|---|---|---|
| 120 columns | [Before](header-before-120.png) | [After](header-after-120.png) |
| 160 columns | [Before](header-before-160.png) | [After](header-after-160.png) |
| 200 columns | [Before](header-before-200.png) | [After](header-after-200.png) |
