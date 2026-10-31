# Validation

Implementation: `425a893ae2920b8b64e97b80072124d428e72dc5`.
Baseline: `11689928330b46831b657730e46538a26a5ab1bb`, fetched from public main before editing.

On the baseline, the shared price-basis helper returned `thirty-seconds` for `TY1` and no basis for `ZN=F`, `ZNZ26.CBT`, `ZB=F`, and `ZBZ26.CBT`. The before captures reproduce the resulting decimal notation.

## Checks

- Bun 1.3.11: 40 focused tests pass, including all five Treasury roots, normalized quote formatting, security collisions, chart axes/cursors, and compact Overview chart labels.
- All five typecheck targets pass. The new Overview fixture was corrected to use Date objects; its typecheck and tests were rerun successfully.
- Knip passes, with an existing unused-tag hint in desktop-pane-shot-view.ts.
- Full suite: 11,107 pass, 5 skip, 4 failures. All four reproduce on unmodified main on this machine: ImageMagick's normalized pixel-count output, a timezone-sensitive daily-history expectation, and two GNU tar fixtures unsupported by the system tar. The daily-history suite passes with TZ=UTC (33 tests).
- Public-reference scan and git diff whitespace check pass.

## Terminal smoke

The real terminal app was driven in tmux at 160×44 and 80×44 using invented Treasury quotes and history through the shared REST transport, with sockets stubbed. Watchlist prices/changes, Overview headline and embedded axes, the full chart legend/axis/keyboard crosshair, and the listed-contract quick-add preview all show 32nds. Search rows show identity and venue without a price.

[Wide Overview/watchlist](terminal/terminal-watchlist-overview-after.txt), [narrow view](terminal/terminal-narrow.txt), [chart crosshair](terminal/terminal-chart-crosshair-after.txt), [quick-add](terminal/terminal-quick-add.txt), [search](terminal/terminal-search.txt), [runtime health](terminal/terminal-health.json).

No React hook, update-depth, or listener warnings occurred. The fixture did not supply contract terms and produced one corresponding warning. All smoke sessions and profiles were removed. Live market data and kitty pixels were not verified.

## Browser captures

The before/after sheets use the real web bundle with identical invented market responses through the shared quote adapter. They cover 640 and 1280 px, chart pointer crosshairs, Overview, quote cards, watchlists, quick-add, search selection, and the realized-volatility price chart. The all-pane sweep uses its separate kept data snapshot and tests unrelated panes as well.

## Performance

The terminal memory benchmark visited all 120 tickers on Bun 1.3.11 and passed: collected heap 121.01 to 169.44 MiB, with a late slope of -0.01 MiB/ticker against the +0.30 limit. Profiles were isolated on disk and removed afterward.

The five-pair terminal navigation comparison passed on a repeat run with Bun 1.3.11: median typical keypress 3.32 ms on main versus 3.50 ms on the change; slow keypress 15.53 versus 14.31 ms; 92 cells redrawn on both; peak memory 655.0 versus 651.2 MiB. The first pinned run exceeded the timing gate amid variable host load (4.73 versus 5.95 ms); the repeat used the same workload and limits.
