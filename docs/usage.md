# User guide

[Back to README](../README.md) · [Installation](installation.md) · [Browser app](browser.md)

- [Research data conventions](research-data.md)
- [Financial ratios](financial-ratios.md)
- [Options positioning (OPX)](options-positioning.md)
- [Keyboard shortcuts](#keyboard)
- [Command reference and chart composer](#command-reference)
- [Live prices and refresh cadence](#live-prices-and-refresh-cadence)
- [CLI commands and output formats](#cli)
- [Plugins pane](#plugins-pane)
- [Portfolio currency](#portfolio-currency)
- [Cash, target weights and rebalancing](#cash-target-weights-and-rebalancing)
- [Broker position sync](#broker-position-sync)
- [Gloom Cloud sign-in](#gloom-cloud-sign-in)
- [Debt maturities](#debt-maturities)
- [Theses](#theses)
- [Interface language](#localized-interface)
- [Market and macro plugins](#market-and-macro-plugins)
- [Live TV](#live-tv)
- [Options scenarios](#options-scenarios)
- [Option valuation models](#option-valuation-models)
- [Relative rotation](#relative-rotation)
- [Portfolio risk: PORT and MARS](#portfolio-risk-depth-port-and-mars)
- [Equity criteria screener](#equity-criteria-screener)
- [Backtest](#backtest)

The desktop app and TUI share the command language and plugin system. The [browser app](browser.md) offers a smaller feature set. Use `HELP` in the app or `gloomberb help` in your shell for the commands available in your installation.

## Keyboard

| Key | Action |
|-----|--------|
| `Ctrl+P` | Open command mode |
| `` ` `` | Open ticker search |
| `.` | Open the focused pane's menu (also `Shift+F10` or the Menu key) |
| `Ctrl+,` | Open focused pane settings |
| `Ctrl+W` | Close focused pane (unless it is locked) |
| `Ctrl+Shift+M` | Move focused window (`WIN resize` starts resize mode) |
| `Ctrl+Shift+D` | Dock or float focused pane |
| `Ctrl+Shift+E` | Export focused pane table as CSV |
| `Ctrl+Shift+L` | Layout actions |
| `Ctrl+Shift+G` | Tidy windows |
| `Tab` | Switch panes |
| `j` / `k` | Navigate lists |
| `Home` / `End`, `PageUp` / `PageDown` | Jump through lists and tables |
| `Enter` / `Esc` | Open the selected row / go back |
| `/` | Search in the focused pane |
| `h` / `l` | Switch tabs |
| `Ctrl+Left` / `Ctrl+Right` | Scroll a focused table horizontally |
| `m` | Cycle chart mode |
| `Alt+Enter` | Run the newest notification's action, such as Revert or Review |
| `Alt+Backspace` | Dismiss the newest notification |
| `q` | Quit (terminal) |

Desktop builds also accept `Cmd/Ctrl+K` for the command bar, the matching `Cmd` shortcuts on macOS, `Cmd/Ctrl+Shift+O` to pop out a pane, `Cmd/Ctrl+Shift+C` to copy a focused pane screenshot, and `Cmd/Ctrl+Shift+Enter` / `Cmd/Ctrl+Shift+Backspace` for notifications.

The focused pane's footer shows its actions with their keys, such as `[a]dd`, and every one of them works from the keyboard. The pane menu (`.`, or the `...` button) lists them all, including any a narrow footer cuts off, followed by what the pane's table, filters and tabs offer (sort by a column, change a filter, close a tab), its quick toggles, and the pane and window actions. A retry or sign-in button in an empty pane answers `Enter`. In dialogs, `Enter` confirms and `Esc` closes; on the desktop `Tab` moves between a dialog's controls. A command that needs values or a confirmation (New Portfolio, Add Alert, Delete Watchlist) opens it as a centered dialog once the command bar closes: `Tab` and the arrows move between fields, `Enter` goes to the next field and sends the form from the last one, `Cmd/Ctrl+S` sends it from any field, and `y` or `n` answers a confirm. In pane settings the arrows move between settings, `Left` / `Right` change a choice or a toggle in place, and `Enter` opens a field's editor.

A pane that shows one ticker, such as a price chart (`GP`, `GIP`), `OMON`, `OPX`, `SEAS`, `FA` or company news, can follow a watchlist, portfolio or scanner the way the research pane does: choose **Link to** and the list's name in its pane menu, and it moves with that list's selection, titled for example `OPX NVDA  ⧉ Linked to Watchlist`. It can follow another single-ticker pane the same way (**Link to Ticker Research AAPL**, **Link to OVDV SPY**), so a desk of option panes moves with one research pane; a pane that already follows this one, directly or through others, is not offered. **Unlink from** keeps the ticker it shows, and closing the list does the same; if the list was empty, a linked `OMON`, `CN`, `FA`, `HP`, `SEC`, `INS`, `HDS`, `ANR`, `EVT` or `EE` pane has no ticker to keep and closes with it. Typing `OPX AAPL` while a linked OPX is open opens a separate pane rather than unlinking it. A linked chart saves its spec each time the selection moves, so its range and studies carry over.

Wide tables retain their columns in narrow panes. Use their horizontal scrollbar or horizontal wheel/trackpad scrolling to reach additional fields; `Ctrl+Left` / `Ctrl+Right` moves by half a table viewport. Plain arrows keep their existing navigation behavior, and text-field shortcuts remain with the editor.

### Custom keybindings

Every global and pane management key can be moved, and any command bar text can be put on a key. On a layout where the backtick is a dead key, the command bar already searches symbols for anything you type after `Ctrl+P`; a dedicated ticker search key is one rebind away. Open `HELP`, pick the Shortcuts tab, and press Enter on a row (or double-click it) to capture the next chord; `x` unbinds, `0` restores the default, and `N` starts a command binding. The Functions tab lists every typed prefix the same way, and Enter there opens the command bar on that prefix. Typing a command in the command bar, such as `DES AAPL` or `CN`, offers a `Bind a key` row as well. Capture shows exactly what your terminal delivered for the combination, which matters on terminals that fold `Ctrl+Shift+F` into `Ctrl+F`.

The same table lives in `config.json` under `keybindings` and through the CLI:

```bash
gloomberb config get keybindings
gloomberb config set keybindings.actions.ticker-search "Ctrl+T"
gloomberb config set keybindings.actions.command-bar "Ctrl+Shift+P"
gloomberb config set keybindings.actions.help null
gloomberb config set keybindings.actions.ticker-search default
gloomberb config set keybindings.commands.Alt+1 "DES AAPL"
gloomberb config set keybindings.commands.F5 CN
```

```json
"keybindings": {
  "actions": {
    "ticker-search": "Ctrl+T",
    "command-bar": ["Ctrl+Shift+P", "CmdOrCtrl+K"],
    "help": null
  },
  "commands": {
    "Alt+1": "DES AAPL",
    "F5": "CN"
  }
}
```

Chords use the accelerator grammar: `Ctrl`, `Cmd`, `Alt`, `Shift`, and `CmdOrCtrl` for Control in the terminal and Command on a Mac desktop, followed by a key (`K`, `,`, `` ` ``, `Tab`, `F5`). Action ids are listed by `gloomberb config get keybindings`; plugin shortcuts use `plugin:<shortcut id>`. Command bindings run the text exactly as if typed, so `CN` opens news for the focused ticker, and they need a modifier or a function key so they never fire while you type. Control chords also yield to a focused text field. Bindings are per machine and stay out of cloud sync. Anything that does not parse or lands on a taken key is reported at launch and in Help > Shortcuts.

## Command Reference

Use `HELP` inside Gloomberb for the live shortcut list. The common command-bar prefixes are listed here for quick scanning.

### Searching by asset class

Text that no command claims searches symbols and names, and every result carries its class: `EQ` equity (receipts, preferred shares and partnership units included), `ETF` exchange-traded fund, `FUND` any other fund (mutual, closed-end or money-market), `CUR` currency pair, `CRYP` coin, `FUT` future, `IDX` index, `OPT` option, and `DERIV` for other derivatives. End a search with one of those codes, other than `DERIV`, to keep only that class, the way a market sector key follows a ticker: `ES FUT` finds the E-mini S&P 500 future rather than Eversource, `EURUSD CUR` the currency pair, `BTC CRYP` the coin, `SPY ETF` the fund, `S&P 500 IDX` the index. `CUR` keeps coins as well (`BTC CUR`), and `FUND` keeps exchange-traded funds as well, so a fund's full name (`Technology Select Sector SPDR Fund`) still finds it. For `FUT`, `CUR`, `CRYP` and `IDX` a bare symbol is also looked up in its market spelling (`ES=F`, `EURUSD=X`, `BTC-USD`, `^GSPC`), which symbol search does not return for the bare letters. `AAPL OPT` lists option contracts when a connected broker returns them. A code on its own, or first, is not a filter: `EQ` searches that symbol, and `FUT`, `CRYP` and `ETF SPY` open their panes. The filter works the same in ticker search (`` ` ``) and after `DES`.

### Company Research

| Shortcut | Function |
|----------|----------|
| `DES <ticker>` / `T <ticker>` | Security details for a ticker |
| `FA <ticker>` | Financial statements and [ratio tabs](financial-ratios.md) |
| `SEG <ticker>` | Quarterly revenue by product, segment or region from 10-Q and 10-K filings |
| `G <series>` | Custom chart composer |
| `CAT [query]` | Browse and search chartable series |
| `GP <ticker>` | Price chart |
| `GIP <ticker>` | Intraday price chart |
| `HP <ticker>` | Historical OHLCV prices |
| `GF <tickers>` | Fundamental statement graph |
| `GE <tickers>` | Valuation multiple graph |
| `GR <tickers>` | Security relationship graph |
| `EE <ticker>` | Events view with earnings and revenue estimates |
| `ERN [tickers]` | Earnings history of a ticker (the active one when typed alone) with implied and realized moves; several tickers, their upcoming reports; nothing active, the market's report days |
| `EVTS [ticker]` | The market's report days with implied and average moves; a ticker selects its row |
| `SRCH [query]` | Full-text search across earnings call transcripts, news, and SEC filings |
| `CALLS [ticker]` | Earnings call transcripts; alone, every transcribed call |
| `JOBS [ticker]` | Hiring from the company's careers system; alone, every covered company |
| `QQ <tickers>` | Ticker quote monitor |
| `CMP <tickers>` | Normalized price comparison |
| `CORR <tickers>` | Ticker return correlations; `GEO:<name>` adds a map series, for example `CORR FRO, STNG, GEO:HORMUZ` |
| `ANR <ticker>` | Analyst targets and ratings |
| `DIAG <ticker>` | Equity Diagnostic with cited flags and anomalies |
| `SEC <ticker>` | SEC filings and company disclosures |
| `OMON <ticker>` | Options chain, expected moves, 25-delta skew and adjacent-expiry term slope |
| `OVDV <ticker>` | Rotatable 3D implied-volatility surface by delta or moneyness, smiles, term structure, skew and forwards |
| `OPX [ticker]` / `GEX [ticker]` | Open interest by strike and expiry with max pain, and dealer gamma by strike with its flip level; `GEX` opens on the gamma tab, `MAXPAIN` is `OPX`. SPY with no ticker ([method](options-positioning.md)) |
| `HVG <ticker>` | Realized volatility by estimator and window, price, and current ATM IV |
| `HVT <ticker>` | Volatility cone, current estimates and historical percentiles |
| `SEAS <ticker>` | Seasonality: monthly returns by year, each month's average and hit rate, and year overlays |
| `RIPL [tickers]` | Earnings Ripple: customers and suppliers of your holdings (or the named tickers) that report in the next 30 days, with the disclosed revenue share; Pro adds companies two hops away |
| `RDCF <ticker>` | Reverse DCF: the ten-year free cash flow growth the enterprise value prices in, against past growth, by discount rate |
| `PEB <ticker>` | P/E band: weekly price against round multiples of trailing EPS, today's P/E and its percentile in the stock's own history |
| `MDAY <ticker>` | Macro-day reaction: average absolute and signed move and up share on CPI, jobs and FOMC days against a normal day, and every release day |
| `HIVG <ticker>` | Implied volatility history against realized, with IV rank and percentile |
| `VCA [tickers]` | Rich/cheap implied volatility across a list: IV rank, percentile, term slope, skew, IV/HV |
| `OSA <ticker>` | Multi-leg option positions, scenario P&L, payoff charts and aggregate Greeks |
| `OVME` | Option calculator: European Black-Scholes or American pricing, discrete dividends, Greeks, implied and surface volatility |
| `HDS <ticker>` | Institutional holders, and 13D/13G beneficial owners over 5% |
| `DVD <ticker>` | Dividend yield and history |
| `SI <ticker>` | Short interest |
| `SIV <ticker>` | FINRA daily off-exchange short-volume ratio, history and percentile |
| `SIW [tickers]` | Short squeeze watch: short interest as a share of float, days to cover, change since the prior settlement and the 1M price move across your portfolios and watchlists, crowded names that are rising first |
| `BUZZ <ticker>` | Daily posts on X naming the cashtag, the 30-day median, top posts and their stance |
| `13F [fund/ticker/CIK]` | 13F fund filings and holdings |
| `INS <ticker>` | Insider activity |
| `EVT <ticker>` | Corporate actions, earnings, and estimates |
| `RV <tickers>` | Relative valuation |

Ticker Research shows the tabs that can have data for the instrument. Stocks get the company tabs (analyst coverage, diagnostic, earnings calls, executives, filings, risk factors, hiring, holders, insider and short interest); funds keep events, dividends and congress trades, with options and 13F retained for ETFs, closed-end funds and funds of unknown subtype; coins, currency pairs and indices keep the overview, chart, news and notes, with Options also retained for indices, futures and option contracts. Explicitly classified mutual funds and money-market funds hide Options and 13F; an empty result alone does not hide a tab. Tabs sourced from SEC, FINRA and congressional filings are hidden for listings outside the US. Click the price chart on the Overview tab to open the Chart tab.

The Overview headline is the regular session: after the close it stays at the official close and its move from the previous close, and the After-Hours line under it is the latest extended-hours price and its move from that close, the only figure that changes until the next pre-market. In the pre-market the headline is the last session's close and its move from the session before, held, and the Pre-Market line is the only figure that changes, measured from that close; a quote that does not carry that move keeps the live price and its move from the previous close in the headline. `gloomberb ticker` reports the quote the same way.

Earnings-call data exports and fiscal-quarter lookup inspect at most the latest 200 calls in the requested scope; the interactive list loads 50. The server does not supply a total or a `hasMore` marker. When a response fills its source limit, exports report `sourceLimitReached: true`, `complete: false`, and `truncated: true`: additional calls may exist. `total` counts matching loaded calls; `totalIsExact: false` marks capped, pending, or stale results. A missing quarter in a capped lookup is not proof that the company has no such call. Pending discovery remains pending when reopening or refreshing the pane. Full-text documents can be read and searched without structured turns, but Q&A requires source segmentation.

The ticker research `13F` tab shows fund positions for the ticker, reported value, shares, weight and quarter action; open a row for its fund detail and scroll to page more funds. The `13F` pane's Crowding tab ranks new positions, exits, and weight increases or decreases across the top 25 ranked funds. `m` or the Mine filter limits positions to portfolio and watchlist tickers. CLI equivalents: `gloomberb fn 13F AAPL --view=ticker-holdings --offset=0 --json` (a ticker argument defaults to this view; `--view=by-ticker` lists the holders' whole 13F books) and `gloomberb fn 13F --view=crowding --json`. The text report opens with the quarters compared, the holder, new and exited counts, and, when the list is longer than `--limit`, which funds are shown and the `--offset` that continues it; `--json` carries the same as `shown`, `total`, `truncated` and `nextOffset`. Values are as reported at the period end, not at today's price. With a ticker, `gloomberb fn 13F MU --view=crowding` shows that ticker's rank in the crowding sample, or says it is not in it.

`HDS` has three tabs: Table and Chart show the 13F institutional holders (on a home line abroad such as `BHP:LSE`, values are in the currency the report names and a row held as US depositary receipts carries an `ADR` badge), and 13D/G shows who disclosed more than 5% of the class on Schedule 13D (activists) or 13G (passive holders) in the last four years, one row per filer: the form of its latest report, the percent of class that report gives, the change in points against its previous report, shares, event and filing dates, and its latest 13F move in the ticker (NEW, the share change, EXIT, or a dash when unknown). The latest report is the filer's latest disclosure, not its position today. A stake reported under 5% keeps its percentage, marked `<5%` where the column has room, and sorts after the 5% holders with reports of zero, marked `EXIT`. Enter opens the filing in the SEC pane and `o` opens it on EDGAR. CLI equivalents: `gloomberb holders CAR --form all` (`13d` or `13g` for one kind, `--history` for every report instead of the latest per filer) and `gloomberb fn HDS CAR --form all --json`; `gloomberb filings CAR --form 13G` lists the filings themselves.

In a 13F fund detail, open Overlap, search a second fund by name or CIK, and select it to compare shared positions and weights. Back returns to the fund picker. The Performance list includes three prior-quarter estimates when available. Headless crowding accepts `--rank=new`, `--rank=exits`, `--rank=increases` or `--rank=decreases`. CLI overlap: `gloomberb fn 13F 0001067983 --view=overlap --compare=0001037389 --json`.

### Chart Composer

`G`, `GP`, `GIP`, `CMP`, `GF`, and `GE` all open the same chart composer with different starting presets. `CAT` opens a searchable catalog of those chartable series so you can graph one without typing the expression; its SOURCE column names the provider a plain market request reaches first (Gloom Cloud in the app, a broker where one is registered), while FRED, treasury and valuation rows name their own source. A custom expression can mix unrelated data sources on one synchronized timeline:

```text
G AAPL:price, MSFT:revenue, FRED:CPIAUCSL
```

Open **Series** to add, remove, reorder, or hide series and choose each series' field, chart style, transform, axis, panel, period, and panel scale. Price data supports candles, OHLC, HLC, line, and area; scalar data supports its compatible line, area, step, column, and point modes. Panels can use independent left/right axes and linear or logarithmic scales.

The toolbar controls preset or exact date ranges, intervals from one minute through monthly, the primary chart mode, technical indicators, and pair formulas. Indicators include volume, SMA, EMA, Bollinger Bands, VWAP, anchored VWAP, volume profile, RSI, MACD, ATR, and Realized Volatility; formulas include ratio, spread, and rolling correlation. Realized Volatility has window and estimator controls in pane settings. Auto resolution requests daily bars for that indicator; explicit weekly or intraday bars cannot be annualized as daily sessions. Mixed-frequency values use as-of alignment: fundamentals use filing dates when available, sparse series carry forward only after becoming available, and missing publication dates appear behind the warning indicator in the existing chart footer (click it or press `!`).

Spread calculates the first input minus the second input times its configured multiplier. It requires matching known input dimensions, currencies, and scales; an incompatible formula is unavailable and appears in the existing chart/report errors while usable series remain available. Market prices also require a declared per-unit basis: two bare USD futures quotes do not establish comparable physical quantities. A multiplier does not supply missing units or establish a conversion. No implicit FX conversion occurs. Studies use source values before chart presentation transforms, so selecting a percent or index display does not convert foreign-currency inputs before subtraction. Ratios retain derived units such as USD/EUR or 1/share and have no value at a zero denominator. As-of alignment can combine observations from different dates; the source dates do not establish a synchronized executable price.

When either ratio input has unknown units or a missing price basis, its numeric ratio remains available with unit `unknown`. Currency factors cancel only at the same scale: GBP/GBp remains explicit, while equivalent pence labels GBp/GBX cancel. This does not convert either input's values.

Correlation uses matching observation times when inputs have different frequencies. Chart panes keep units and active failures visible; recurring FX and alignment explanations remain in these docs and export/share metadata.

On intraday charts, bars outside the venue's regular session (pre-market, after-hours, and after an early close) sit on a tinted band; the terminal text renderer marks where the regular session starts and ends with a dotted rule. The session comes from the same calendar VWAP uses, so a venue without known hours has no band. Intraday history for US listings currently covers the regular session, so the band appears where a source sends extended-hours bars.

#### Trader studies

In the Indicators dialog (`i`), the highlighted study's setting sits beside Done: Period (`p`) for SMA, EMA, Bollinger, RSI and ATR, Bands (`b`) for VWAP, Rows (`n`) for the volume profile and Anchors (`a`) for anchored VWAP.

- **VWAP** is the volume-weighted average of the typical price, (high + low + close) / 3, from each session open. It restarts at the open the venue's calendar gives: 09:30 New York for US listings, so a pre-market bar still belongs to the session before; 17:00 Central the evening before for CME Group futures (CME, CBOT, NYMEX, COMEX) and Cboe VIX futures; and each ICE U.S. contract's published open (Coffee 04:15, Sugar 03:30, Cocoa 04:45, Orange Juice 08:00 New York, Cotton 21:00 and the dollar index 20:00 the evening before). Futures holidays are not modelled. A venue without known hours restarts at local midnight, or at midnight UTC for crypto. It needs intraday bars, and a first session that opened before the loaded bars is left out rather than drawn from part of its volume. Bands add and subtract a whole number of volume-weighted standard deviations.
- **Anchored VWAP** runs the same average from bars you pick and never restarts. Turning it on, or `v` while it is on, waits for a click on a bar (or Enter at the keyboard cursor; Esc cancels). Anchors also take a date (`2026-09-30`, the first bar of that session) or an exchange time (`2026-09-30 10:00`), and up to eight can be on one chart. An anchor older than the loaded bars draws nothing until a longer range loads it.
- **Volume profile** spreads each bar's volume evenly over its high-low range into equal price rows across the bars in view, so it follows pan and zoom. The busiest row is the point of control, drawn as a dotted level; the value area grows from it one neighbouring row at a time, taking the busier side, until it holds 70% of the volume. It needs the price in its own values, not a percent or index display.
- **ATR** is Wilder's average true range in its own panel: the mean true range of the first period, then each bar adds 1/period of its true range. A bar's true range is the largest of its high-low range and its distance from the previous close.

#### Price levels

The level tool (`Shift+H`, or `═` in the chart toolbar) draws horizontal price levels that belong to the ticker, not the pane: every chart of that listing shows them, a generic future's under any roll or adjustment, and they sync with your account. With the tool in hand, a click adds a level, dragging one moves it, Enter adds one at the keyboard cursor's price, `[` and `]` pick one, Up and Down move the picked one and Backspace deletes it. `Shift+A` on a level sets an ALRT price alert there: above when the level is over the current quote, below when it is under, crosses when it is on it. Levels with an alert, and active alerts on the ticker set elsewhere, draw in red; an alert's own line is changed in ALRT. Levels draw on the first price series while it shows its own values, not a percent or index display.

`GIP` session loading retains finite zero and negative prices when provider metadata identifies a futures instrument. If another or unknown instrument type reports a nonpositive close in the selected window or its calculation buffer, the result is unavailable; JSON metadata retains the rejected values and dates in `intradayPriceDomainFailures`. Inconsistent OHLC bars still become gaps. Logarithmic scales and transforms retain their positive-value requirement.

### Markets, News, and Macro

| Shortcut | Function |
|----------|----------|
| `TOP` | The 20 top-ranked market stories |
| `HM` | Market heatmap of the 500 largest US stocks by sector and industry, large US ETFs, and the portfolio pane's selected list |
| `MOST` | Top gainers, losers, most active, and trending tickers |
| `HILO` | Session new highs and new lows with 30s/1m/5m momentum |
| `FLOW` | Unusual options activity: sweeps, blocks, and large premium; Vol/OI divides the contract's day volume by its latest reported open interest. Cloud records every print, for options flow alerts and the assistant |
| `PM <query>` | Polymarket and Kalshi prediction data ([Prediction Markets plugin](https://github.com/gloom-sh/gloom-prediction-markets)) |
| `N` | News feed |
| `CN <ticker>` | Ticker news |
| `NI [code]` | News by topic: `MNA`, `CB` (central banks), `ENERGY`, `REG` (regulation), `CRYPTO`, `EARN`, `IPO`, or a sector: `TECH`, `FIN`, `HEALTH`, `INDU`, `CONSD`, `CONSS`, `COMMS`, `MATS`, `UTIL` |
| `SUB` | Authenticated Substack reader feed ([Substack plugin](https://github.com/gloom-sh/gloom-substack)) |
| `FIRST` | Breaking news |
| `TWIT <query>` | Ticker-related market posts |
| `TBO` | TheBuildout infrastructure intelligence |
| `CG` | Congress trading disclosures |
| `WEI` | Global equity indices |
| `MAP` | Live world venue map with local market status and clocks |
| `TAS <ticker>` | Time and sales: trade prints, observed-window VWAP and large prints |
| `QR <ticker>` | Quote recap: NBBO history with sizes, venues and spread (the same pane on its NBBO tab) |
| `EM <ticker>` / `EEO <ticker>` | EPS estimate revisions, current analyst breadth and surprises; `--period YYYY-MM-DD --frequency quarterly` pins a fiscal period |
| `KPIS <ticker>` | Company operating KPI tables, charts, revisions and verbatim evidence (Pro, Free preview) |
| `GUIDE <ticker>` | Structured management ranges, raise/cut tracking and later actual versus guide (Pro, Free preview) |
| `GUID <ticker>` | Company EPS guidance cited from filings and transcripts, against consensus (the same pane on its Guidance tab) |
| `FUT` | Futures quote aliases across index, rates, energy, metals, grains and softs, livestock, and FX |
| `RRG` / `GRR` | Weekly relative rotation of sectors or a watchlist against a benchmark, with dated trails |
| `BT <ticker>` / `BTST <ticker>` | Backtest a long-only indicator rule on daily history against buy-and-hold |
| `EQS` | Equity screener over the stored Cloud universe: valuation, growth, margins, short interest, insider and 13F criteria, saved screens and export |
| `PERP [market]` | Perpetual funding, open interest and premiums: a board, rankings and one asset across venues; a market opens its Pro history and evidence; free preview |
| `CRYP` | Top crypto assets by market cap with live prices, 7D, 30D and 1Y returns, 24h volume and market cap; stablecoins on their own tab |
| `ECO` | Economic events and releases |
| `ECST [statistic]` | Economic statistics: inflation, labour, growth, consumer, housing, rates |
| `GC [curve] [YYYY-MM-DD]` | Government yield curves (UST, TIPS real, breakeven, euro AAA, Bund, Gilt, JGB, Canada) with spreads and percentiles, a compare date, the one-year-forward curve and a World tab; CLI also accepts `--curve`, `--date`, `--compare 1Y` and `--tab world` |
| `WIRP` / `FFIP` | Fed funds futures implied FOMC path, conditional target probabilities, SOFR contracts and Fed projections |
| `BTMM` | Money markets: funding rates, Treasury bill curves and Federal Reserve liquidity |
| `YAS` | Fixed-coupon bond calculator: price/yield, accrued interest, duration, convexity, DV01 and Treasury spread |
| `CBR` / `ECFC` / `CBRT` | G20 central bank policy rates, last observed moves and one-year history |
| `CTM [root]` | Futures contract curve, historical ghosts, roll yield and open interest, including `CTM VX` and CME crypto (`CTM BTC`, which adds each contract's premium to spot and annualised basis) |
| `COT [code or root]` / `CFTC [code or root]` | CFTC positioning extremes, weekly changes and historical percentiles, including CME crypto (`COT BTC`) |
| `AUCT` | Treasury auction results: auction rate, bid-to-cover, indirect share, and size |
| `VIX` | VIX 9D through 1Y cash-tenor curve, FRED history and 3M/30D ratio |
| `VOLS` | Cross-asset volatility indices, daily changes and one-year percentiles |
| `CRD` | Credit spreads |
| `VAL [indicator]` | Whole-market valuation: Buffett, CAPE, excess CAPE yield, Tobin Q, investor equity allocation, dividend yield, margin debt, cap/profits, cap/M2 |
| `CDS [ticker]` | Single-name corporate CDS activity: most-active issuers, or one issuer's 5Y spread history and trades |
| `EVTS` | The market's earnings days, implied against past moves |
| `IPO` | Upcoming and recent IPOs worldwide |
| `HALT` | US trading halts with reason and resumption times |
| `DIST` | Distress records: 8-K bankruptcy, obligation and listing filings, going-concern disclosures, Taiwan listing designations, French and UK insolvency notices (the M&A pane on its Distress tab; [details](distress-monitor.md)) |
| `TV` | Live business news television ([TV plugin](https://github.com/gloom-sh/gloom-tv)) |
| `BI` | S&P 500 sector performance |
| `THEM [theme]` | Thematic baskets with equal-weight returns and breadth, and each theme's members (the Themes tab of `BI`) |
| `MEMB <fund>` | ETF holdings with weights, member returns, daily contributions and index changes |
| `FXC` | FX cross rates: the majors, or up to 45 currencies |
| `FNG` | Fear and greed market gauge |

`HM` sizes each stock by the square root of its market cap, so mid-size names have room next to the largest, and colors it by the day's move in the theme's own colors: from a muted tone near flat to the theme's down color for losses and its up color for gains, at full strength by 3%, with dark or light text, whichever reads better on the tile. A name with no move yet is a quieter grey. Switching themes recolors the map at once. **Size by** in its settings, also the `√` button beside the title on every tab but a portfolio's, switches to plain market cap, where the largest names dominate; either way a sector's block is the sum of its tiles, and the tooltip and footer show the real market cap. ETFs follow the same choice with their net assets. **US Stocks** groups the 500 largest US stocks into sector blocks, largest top left, and each sector into industries; an industry is labeled only where its block has room, and a one-name industry never. Names too small to draw, and the few without a sector, sit together in **Other** at the bottom right. A big tile shows its ticker over the move, a smaller one its ticker, the smallest only its color; on the desktop and the web, hovering a tile shows its name, move, price, market cap and volume, and the footer shows the selected tile's. With **Live streaming** on, colors follow the quote stream: the largest names stream first, as many as the account's connection allows, real-time with Pro and delayed otherwise, and the footer says which (`live`, `mixed` or `polling`). In the pre-market and after hours a streaming name shows that session's move from the regular close, marked `PM` or `AH` after the move where the tile has room and always in the tooltip and footer; once the after-hours session ends it shows the regular session's move again. Names outside the stream follow the snapshot, refreshed each minute, which also brings fresh market caps; outside the regular session the snapshot is the last completed session's close and its move, shown without a mark; in between, a streaming name's tile grows and shrinks with its price. Sizes relayout at most every five seconds and only when a tile would visibly change, and tiles keep their places through small changes. On the desktop and the web colors fade and tiles glide; with reduced motion set in the system, they change at once. **US ETFs** is the same map without sectors.

`gloomberb fn HM` reports the map by sector from the same snapshot the pane starts from: each sector's names, total market cap and share of the board, its day move weighted by market cap, how many names rose and fell, and its best and worst name. `--group industry` breaks it down by industry within each sector, `--universe us-etf` summarizes the ETF board as one group weighted by net assets, and `--json` adds the whole board's figures in `data.metadata.board`. Moves are weighted by market cap, not by the square-root tile area; a name with no move yet counts toward its group's size but not its move or breadth, and is named in a notice above the table and in `data.metadata.noMove`. The report does not include the moves the pane streams on top of the snapshot.

`HM` has a third tab, named for the list open in the portfolio pane (`PF`): the one last focused when there are several, your first portfolio when none is open. It sizes a portfolio's holdings by market value in the portfolio's currency, as `PF` shows it, whatever **Size by** says, and a watchlist's names by the square root of their market cap in your base currency, or plain market cap with **Size by**; tiles are colored by the day's move, or that session's in the pre-market and after hours, and grouped by sector when the list's tickers have one. A name without a position, quote, market cap or exchange rate gets the smallest tile and no figure, and past 160 names the smallest are left out, which the footer says. **Link to portfolio** in its settings switches the heatmap to that tab whenever the portfolio pane changes list. `3` opens the tab, and `[` / `]` step through all three.

An open theme in `THEM` and the Members tab of `MEMB` add two entries to the pane menu (`.`). **Open Members In…** opens the members, in the order the list shows them, in `RRG` (up to 24), `CORR` (2 to 10), `SIW` (up to 60) or `RIPL` (up to 10); a function whose plugin is turned off is not offered. **Save as Watchlist…** asks for a name and saves the first 100 members to a new watchlist. A `MEMB` search narrows both to the holdings it matches.

News rows credit the article's publisher and open its original URL. The managed
news feed includes only articles whose publisher and original link can be
verified. Custom RSS and Atom feeds use each item's source when supplied,
falling back to the name you configured for a direct publisher's feed.

Ticker Research includes a **Congress** tab for House and Senate transactions in
the selected ticker. The **Chamber** filter narrows `CG` and the tab to one chamber. Scroll to append filing windows; `n` or its footer action continues a
window with no matching transactions. After the year's filings, `p` appends the
previous year. Select a trade for its disclosure details; `m`, `t`, and `o` open
the member, ticker, and source filing. Dates include the year when comparing
transactions across years.

The same feed is available through `gloomberb fn CG AAPL --year 2026 --json`.
Use `--filingOffset` and `--offset` with the returned pagination metadata to read
additional windows and trades.

The CG **Tickers** tab groups the loaded trades, including appended years, by
symbol. Enter opens that ticker's disclosures. The filter bar narrows side,
owner, asset category, and the minimum disclosed dollar amount; `f` opens those
filters by keyboard. `i` or **Mine** limits the view to portfolio and watchlist
symbols, which are highlighted in the tables. A `!` beside lag marks disclosures
filed more than 45 days after the transaction. CLI examples:
`gloomberb fn CG --tab tickers --side BUY --minAmount 50001 --json` and
`gloomberb fn CG AAPL --owner spouse --assetType option --json`.

Congress Trades includes returns since the transaction and filing close; Members includes party, median stock return and buy hit rate. Open a member for current committee assignments and the return denominators. Missing prices remain blank. See research data for the close-to-latest-close basis.

`YAS` opens a reactive bond form. Enter settlement, maturity, annual coupon and either yield percent or clean price per 100 face. `e` starts editing at Settlement; Tab and Shift+Tab then move through the fields and leave them past either end, and Escape stops editing. `m`, `f`, `d` and `n` switch the mode, frequency, day count and end-of-month schedule. The Cash flows and Sensitivity tabs retain the same terms. The end-of-month control is an explicit schedule choice and requires a month-end maturity.

`gloomberb fn YAS --settlement 2026-09-22 --maturity 2031-09-15 --coupon 5 --yield 4.25 --json` returns valuation, cash flows and yield shocks. Use `--price 103.333937` instead of `--yield` to solve yield, `--frequency 1|2|4`, `--day-count act-act-icma|30-360-us`, and `--end-of-month` as needed. `gloomberb shot YAS --tab valuation|cashflows|sensitivity` accepts the same inputs. Treasury data is optional; all local calculations still work when it is unavailable.

`FUT` keeps each rolling quote alias as its symbol and displays the provider's contract name when available. Search also matches that name. A month in this label describes the captured quote; the app does not derive an expiry date or establish the roll-adjustment basis of the alias's historical series.

FUT's 1W, 1M and YTD columns are returns on the contract the row names (LEZ26 for "Live Cattle Dec 26"): the live price against that contract's own close a week, a calendar month, or at the end of last year before. The alias's continuous series jumps at every roll (LE=F fell 6.3% on a July roll day), so it is never the baseline. A contract listed after the baseline date shows no return for it; Treasury futures list three quarters ahead, so their YTD is blank in the second half of the year. Dutch TTF gas names no month, so its front contract is the month, among the next three, whose last close is nearest the quoted price. Narrow boards drop volume, previous close and time before the returns.

`BTMM` opens Rates, Bills and Liquidity views. Select a row and press Enter or click it for its dated history, one-year range and source; Back returns to the board. The Bills curve compares common-date discount yields with one week, one month and one year earlier. Liquidity plots the net-liquidity proxy above the component board. `h` and `l` switch views; `o` opens the selected FRED series and `r` refreshes. Reports support `gloomberb fn BTMM --tab rates|bills|liquidity` and `--json`.

`CBR`, `ECFC` and `CBRT` open the same Central Bank Rates board. Each row shows its policy rate or target range, last observed move and date, one-year percentile, history and latest observation date. Select a row and press Enter or click for the source instrument, reporting lag, one-year range and history; Back returns to the board. `o` opens its official source and `r` refreshes. The US detail includes its verified next FOMC meeting; other meeting dates remain unavailable. Reports support `gloomberb fn CBR --json` and its aliases.

`IPO` lists deals on the main US, Asia-Pacific and European exchanges from the last three months and the next six: upcoming soonest first, then priced and listed deals most recent first, then postponed deals. The All, US, APAC and Europe tabs pick the region, and `/` searches company names in either script, tickers, markets, countries and status. DATE is the listing date in the venue's own calendar, dimmed while it is only expected. PRICE is the offer price once set, else the range, in the deal's currency (London in pence); SIZE is the money raised in US dollars at the rate of the day it priced; RETURN is the first session's close against the offer price. Enter or click opens a deal's ticker on its own exchange once it has one. When a market's calendar could not be refreshed, the footer names it. `gloomberb fn IPO --region apac --status upcoming --json` returns the same deals, and `--status filed` or `--status withdrawn` the filings and withdrawn deals the pane leaves out.

`PERP` opens the [perpetuals board](perpetuals.md); `PERP [market]` opens that market's History.

`CRYP` opens the crypto board: the top 100 coins by market cap, with stablecoins on the second tab. Prices refresh every 15 seconds and stream in real time where the plan allows, moving every return and the market cap with them. Enter or click opens the coin in the ticker pane; column headers sort, `r` refreshes, and CSV export keeps every column. `gloomberb fn CRYP --json` returns the board, and `--list stablecoin` the stablecoins.

### Workspace and App Controls

| Shortcut | Function |
|----------|----------|
| `PF` | Portfolio and watchlist workspace |
| `PORT` | Portfolio risk and sector exposure |
| `ALRT` | Price, filing, news, earnings and market event alerts, with delivery history |
| `SA <symbol condition price>` | Create a price alert |
| `AI <prompt>` | AI screener ([BYOK AI plugin](https://github.com/gloom-sh/gloom-byok-ai)) |
| `AGENT` | Local AI research workspace ([BYOK AI plugin](https://github.com/gloom-sh/gloom-byok-ai)) |
| `CHAT [channel]` | Gloom Cloud chat |
| `DM @user [@user...]` | Open or start a direct or group chat |
| `ACM` | Gloom Cloud account settings |
| `NOTE` | Notes |
| `THESIS [tickers]` | Investment theses board (Gloom Cloud) |
| `IBKR` | IBKR trading pane |
| `BR` | Broker connections |
| `CHG` | Changelog |
| `HELP` | Open shortcut and layout help |
| `AW` / `AP <ticker>` | Add a ticker to the active watchlist or portfolio |
| `RW` / `RP <ticker>` | Remove a ticker from the active watchlist or portfolio |
| `PS` | Open focused pane settings |
| `LAY` | Open the layout browser to switch, publish, or add layouts |
| `DESK [desk]` | Add a ready-made desk as a new layout tab: equities, options, futures and commodities, rates and credit, FX and macro, or active trading |
| `LMA <query>` | Layout and pane arrangement actions |
| `WIN move\|resize` | Move or resize the focused window |
| `GL` | Tidy all windows |
| `SB` | Toggle the status bar |
| `VF` | Toggle quote value flashing |
| `TH <theme>` | Change color theme |
| `FONT+` / `FONT-` | Increase or decrease desktop font size |
| `CONN` | Connection health |
| `POLL` | Political polls from VoteHub ([Polls plugin](https://github.com/gloom-sh/gloom-polls)) |
| `UPGRADE` | Account upgrade |
| `CR` | Cycle chart renderer |
| `LANG <locale>` | Change interface language (`auto`, `en`, `es`, `zh-CN`, `zh-TW`, `ja`, or `ko`) |
| `PL <plugin>` | Manage plugins |

In `PF`, `a` adds a ticker to the open manual portfolio or watchlist and `d` removes the selected one after a confirm. Removing it from a portfolio deletes its position there; its notes, alerts and other lists stay. Broker portfolios have no `d`, since the next sync would put the ticker back, and neither do team lists, which everyone on the team shares; `RW` and `RP` still edit a team list.

`gloomberb fn PF <portfolio-or-watchlist> --json` returns a portfolio's positions, broker or manual, valued as `gloomberb portfolio show` values them: quantity, average cost, last price, market value and unrealized P&L in the portfolio's currency, and weight of the total with cash (see [Cash, target weights and rebalancing](#cash-target-weights-and-rebalancing)), largest first, then the cash line. With target weights set, each row adds its target, drift and the trade that reaches it. `--limit` caps the rows (50 by default, at most 200); the totals always cover every position. Name the portfolio or watchlist by its ID or its name; without one it reads your first portfolio. A watchlist returns its tickers with their quotes.

Published layouts preserve portable pane setup and state, including searches, chart viewport, and drawings. Credentials, accounts, portfolios, and pane fields marked private stay local. Publishing copies a durable `term.gloom.sh/l/...` link for social sharing.

The AI screener, the AI research workspace, and the Ask AI research tab come from the [BYOK AI plugin](https://github.com/gloom-sh/gloom-byok-ai), which connects your own provider account. AI screener reasons are generated by the selected model. The app checks each candidate's listing identity; this does not establish that every financial criterion is satisfied. Review the cited fiscal periods, reporting currencies, metric values and sources in company research. Missing data is not evidence that a company meets a criterion; the run summary and lookup warnings describe unverified coverage.

### Filing event alerts

Open `ALRT` and choose **Events** to follow Congress trades for your portfolio and
watchlist, a representative's or senator's first and last name (optionally
`name:district` or `name:state`), or a fund's
numeric SEC CIK. Use **Add Event Alert** in the command bar, or the pane's add
action. Enter or the pause action toggles a rule; delete removes it. Rules sync
with your price alerts. The phone's notification settings have separate Congress
and 13F switches. Cloud sync and a registered mobile device are required for push.

**Add Event Alert** also creates market and research rules for a US-listed symbol:
confirmed earnings date (days before), SEC filing type (8-K, 10-K, 10-Q, S-1,
SC 13D/G, 6-K, 20-F), news keyword (symbol optional), analyst upgrade or
downgrade, new 52-week high or low, unusual volume (multiple of the prior
20-session average), short interest change (percent between FINRA settlements),
open-market insider buy or sell, an option IV spike for one OCC contract
(Pro), and options flow (Pro): a print at or above a premium (default $1M,
typed as `1,000,000`, `$250k` or `1.5m`) on one symbol, or on any name in your
portfolio and watchlists when the symbol is blank, optionally calls or puts only
and sweeps or blocks only. The **Events** tab shows each rule's last checked value with its one-year
percentile and date when the pane is wide enough; a flow rule shows its latest
matching print, or how many of its contracts are being watched. **History** lists the alerts
delivered to your phone over the last 90 days; `r` refreshes it. The phone's
notification settings have one switch for these market and research alerts.

## Live prices and refresh cadence

Prices come from one shared stream: a symbol shown in several panes is subscribed once. Rows on screen and the selected symbol update on every frame (about 10 per second); everything else about once a second. A pane covered by floating windows keeps its subscriptions at that slower rate and its refresh clocks rest until it is uncovered. Minimizing or hiding the app pauses streams and polling; the terminal always counts as visible. Plans that cap streamed symbols spend them on the rows in view.

What moves while you watch:

- Portfolios and watchlists: price, change, volume, market value, P&L and weight. MCAP, P/E, FWD P/E and DIV% are repriced from the live price when the per-share figure behind each (shares outstanding, EPS, forward EPS, dividend per share) is on the quote's currency basis; otherwise they keep the served value. 52W% counts today's range, and TARGET% uses the live price when the target is in the listing's currency. After the regular close, LAST, CHG and CHG% hold the official close and its move from the previous close while EXT% follows the extended-hours print from that close; market value, DAY and P&L keep the live price. In the pre-market the row holds the last session the same way when the quote carries its close and move, with EXT% the pre-market print from that close; otherwise LAST and EXT% are the pre-market print. `DES` uses the same rules. Broker account totals, Net Liq and P&L in the portfolio header and `PORT` move with the positions' quotes from the broker's last snapshot.
- `WEI`, `FUT`, `BI`/`SP`, `FXC`, `EQS` rows, `CRYP`, the header SPY chip and market state, and price alerts, which trigger on the tick that crosses.
- Charts, including the research Chart tab: the forming bar takes each quote's high, low, close and volume, and settles to the source's bar shortly after it closes.
- `OMON`: Last, volume, IV and Greeks stream during the regular session; a real-time chain also reloads every 15 seconds. `OVDV` reloads a real-time surface every 15 seconds in session at the live spot; on desktop and web the 3D surface eases into its new shape. `HVG` re-reads its ATM IV every minute in session. `VOLS` and the `VIX` curve stream index levels; the rest re-read every 15 seconds in session.
- `CTM` and `WIRP` refresh delayed contract quotes every minute while Globex trades.

News panes refresh every two minutes while the app is visible. A hidden browser tab falls back to the configured refresh interval, which still feeds breaking-news notifications; the desktop app keeps two minutes while minimized. `VF` toggles value flashing: a changed price dims for 300 ms, each symbol on its own clock, at most once every 600 ms.

## CLI

Running `gloomberb` with no arguments launches the terminal UI. Normal commands run through a headless CLI path; use `gloomberb launch-ui` when a script should explicitly open the UI.

Human-readable output is the default: tables fit the terminal width, and a single result prints as aligned label and value lines. Piped text output keeps every cell whole. Automation can opt into structured output with `--json`, `--csv`, or `--ndjson`. JSON output favors the richest fetched model available and includes display-column metadata when a command has table columns; CSV and NDJSON use the command's tabular row view. Common global flags include `--limit`, `--refresh`, `--quiet`, `--no-color`, `--dry-run`, and `--yes`.

Headless chart text includes a Unit column when a series supplies one; values keep that unit's scale (for example, `2.7 %` versus `270 bp`). DVD text labels cash growth, CAGR and earnings payout as percentages, while their structured `value` fields remain fractional ratios (`0.03` means 3%).

CLI text prints every time in UTC with the zone named (`2026-10-09 00:08 UTC`); a date alone stays a date. JSON keeps the raw ISO or epoch values.

A symbol that trades in several places takes its exchange after a colon or with `--exchange`, in every command that takes a ticker: `gloomberb ticker SAN:EPA` and `gloomberb ticker SAN --exchange EPA` are Sanofi in Paris, while plain `SAN` is the listing you saved, or Banco Santander in New York. Codes go through the app's exchange aliases, so `SAN:XPAR` is `SAN:EPA`, and an exchange the symbol is not listed on fails with the exchanges it does trade on instead of falling back to another listing: a code the app does not know before any data is requested, a known one when the request for it comes back empty. In a table of several symbols, that symbol's row carries the reason and the others still print. `watchlist` and `portfolio` take the same spelling to add or remove one listing, and say which listing they changed, such as `Added SAN:EPA (Sanofi)`. Reports name the company and exchange they resolved to: `ticker` in its header, table commands in one line above the table, and `--json` as `symbol`, `exchange` and `name` in `metadata`. SEC filings belong to US registrants; for a listing elsewhere, `filings` shows none when the SEC knows the symbol as another company, and says which.

`gloomberb fn PERP --tab history` and `fn CTM` without an argument start with a line saying which market they show, such as `Showing BTC. Try fn PERP ETH.`; `--json` carries it in `data.metadata.notices` and `data.metadata.defaultArgument`. `fn PERP`, `fn COT` and `fn CTM` fail on a name nothing matches and suggest ones that work.

With `--require-bot-safe`, a report or screenshot that is incomplete because part of it needs Gloom Cloud Pro, or a sign-in, says so instead of a generic message.

In short DVD panes, the summary scrolls separately so cash history stays visible. Page Up/Down scroll the summary; arrows or j/k navigate history. The mouse wheel scrolls the region under the pointer.

| Command | Use |
|---------|-----|
| `gloomberb` | Launch the terminal UI |
| `gloomberb launch-ui` | Explicitly launch the terminal UI |
| `gloomberb help` | Show all CLI commands, grouped |
| `gloomberb help <command>` / `<command> --help` | Show a command's usage, options, and examples |
| `gloomberb api list\|get\|invoke\|subscribe` | Inspect and call plugin capabilities directly |
| `gloomberb quote <symbols>` | Fetch current quotes |
| `gloomberb search <query>` / `provider-search <query>` | Search tickers and provider symbols |
| `gloomberb ticker <symbol>` | Show quote, ownership, and financials |
| `gloomberb history\|financials\|fundamentals\|options <symbol>` | Fetch research data |
| `gloomberb news\|filings\|holders\|insider\|13f\|analyst\|events\|valuation <symbol>` | Fetch company research feeds (`13f` is the holders list without insiders; `fn 13F` has 13F filings; `holders --form 13d\|13g\|all` lists 13D/13G beneficial owners; `filings --form <form>` keeps one form) |
| `gloomberb movers\|indices\|sectors\|fx\|fear-greed\|earnings` | Fetch market overview data |
| `gloomberb econ\|fred\|yield-curve` | Fetch macro data |
| `gloomberb compare\|correlation <symbols>` | Compare securities (`relationship` is an alias of `correlation`) |
| `gloomberb portfolio [action]` | Show a portfolio's value, weights, targets and P&L; manage manual portfolios, cash and target weights |
| `gloomberb watchlist [action]` | Manage watchlists |
| `gloomberb notes\|alerts [action]` | Manage local notes and alerts |
| `gloomberb broker list [--type <broker>]` | List connected broker accounts, optionally one kind such as `ibkr` |
| `gloomberb ai providers\|ask` | Use configured AI providers ([BYOK AI plugin](https://github.com/gloom-sh/gloom-byok-ai)) |
| `gloomberb rss fetch <url>` | Fetch an RSS feed |
| `gloomberb provider status` | Inspect enabled data providers |
| `gloomberb config\|cache\|plugin\|layout\|pane\|doctor\|version` | Inspect and manage local app state |
| `gloomberb fn [...]` | Run a pane-backed report command |
| `gloomberb shot [...]` | Capture a pane-backed screenshot |
| `gloomberb predictions [...]` | Launch Prediction Markets ([Prediction Markets plugin](https://github.com/gloom-sh/gloom-prediction-markets)) |
| `gloomberb plugins` | List installed plugins |
| `gloomberb install <user/repo>` | Install a plugin from GitHub, at the commit the registry reviewed when it is listed |
| `gloomberb remove <name>` | Remove an installed plugin |
| `gloomberb update [name]` | Update plugins to the next reviewed commit |
| `gloomberb plugin enable\|disable <id>` | Turn a plugin on or off without removing it |
| `gloomberb plugin link <path>` | Load a plugin from a local checkout while developing it |
| `gloomberb plugin doctor [name]` | Check that a plugin loads, declares its hosts, and compiles for the desktop |

`portfolio` and `watchlist` come with the Portfolio plugin, `notes` with Notes, `alerts` with Alerts, and `rss` with News. Turning one of those plugins off with `gloomberb plugin disable` also removes its commands.

`gloomberb shot TAS AAPL --output tape.png` and `gloomberb shot QR AAPL --output quotes.png` capture a dated trade or NBBO snapshot with the current Cloud session's access delay.

`gloomberb config set telemetry.crashReports false` turns off automatic crash reports, and `gloomberb config set telemetry.usage false` turns off anonymous usage counts and the command bar search log; see [Crash reports and usage counts](../README.md#crash-reports-and-usage-counts) for what each contains.

### CSV and NDJSON from reports

`gloomberb fn <function> --csv` writes the report's table as flat rows a spreadsheet can open: the header is the columns the text report shows (`Index,Name,Last,Change,Change %`), and every cell is a plain value, never a JSON blob. Numbers carry no thousands separators, compact scales or units: `1.20B` is `1200000000`, `+3.45%` is `3.45`, and the unit moves into the header (`Yield (%)`, `Market cap ($)`). A table of metrics, one per row, names each row's unit in its label instead (`Total return (%)`), and a column that mixes units (a rate in % beside a spread in bp) is followed by a `<column> unit` column. Times are ISO 8601 with their zone; a date stays a date. A value the text draws from a fraction exports as drawn, so a 6.15% yield is `6.15`; series values keep their own unit's scale (`Value (%)`, `Value (bp)`).

A report with several tables, such as `WEI` by region or a bundle of sections, writes each as its own block: a `# section: <title>` line, the header, the rows, and a blank line before the next. `--section <title or number>` (any case, numbered from 1) writes only that table, so `gloomberb fn WEI --csv --section europe` is one clean table; an unknown section fails and lists the ones the report has. Key/value sections are two columns, `Metric,Value`. A series report writes one table per series with every point and its date, then its statistics. `CALLS` keeps `--section` as the transcript part it reads, and its report is one table. After the data, CSV ends with `#` lines: the same source, as-of and status line the text prints, then `# incomplete` with what is missing (`# incomplete: 19 of 20 available`), `# error:` and `# note:` lines. `pandas.read_csv(..., comment="#")` skips them, and a spreadsheet shows them below the data.

`--ndjson` writes one JSON object per table row, keyed by the same column names, with a `section` field when the report has several tables; `--section` works the same way. `--json` is unchanged: the full report with every field.

`fundamentals` and `valuation` follow the same rules: `Metric,Value` rows with the unit in each label (`Market Cap (ZAR)`, `Dividend Yield (forward) (%)`), and for `fundamentals` a second `Profile` table. `financials --csv` writes the statement table with plain amounts under its displayed columns. All three end with the source line.

### How current a report is

Every `gloomberb fn` text report ends with one line naming its source, its as-of time in UTC and its status, such as `Source: Gloom Cloud | As of 2026-10-09 00:08 UTC | Delayed 10 min`; `--json` carries the same facts as `data.freshness` (`source`, `asOf`, `status`, `delayMinutes`, `retrievedAt`). The plain commands that print market data end the same way, with the facts in `metadata.freshness` under `--json`: `quote`, `compare`, `ticker`, `history`, `financials`, `fundamentals`, `valuation`, `options`, `news`, `filings`, `analyst`, `events`, `earnings`, `movers`, `indices`, `sectors`, `econ`, `fred`, `yield-curve`, `correlation`, and `portfolio show` / `watchlist show`. `--csv` ends `fn` reports, `financials`, `fundamentals` and `valuation` with the same line as a `#` comment after the rows ([CSV and NDJSON from reports](#csv-and-ndjson-from-reports)); for other commands `--csv` and `--ndjson` stay rows only. `fundamentals` and `valuation` are dated by when their figures were observed and name the newest statement period those figures run through, such as `Not a live feed (reported through 2026-06-30)`. The as-of is the newest observation in the data, with the oldest named when it is more than a day older; when nothing in the data is dated the line says when it was retrieved instead. The status is one of four:

| Status | Meaning |
|---|---|
| Live (`live`) | A real-time feed: the data itself says so, such as a real-time quote or a streaming venue |
| Delayed (`delayed`) | A feed that is not real-time, held back on purpose (with the minutes when the source states them) or a snapshot refreshed on a schedule |
| Stale (`stale`) | The newest observation is older than its kind allows: a quote from an earlier session, a daily series more than a session behind, a release that missed its schedule. The line says how old, or how many rows are stale when only some are |
| Not a live feed (`not-a-feed`) | Data that is not a feed: filings, fundamentals, calendars, published statistics, calculators, your own portfolio. Old data of this kind is not stale unless it missed a scheduled release |

A report that loaded can still carry caveats: what it leaves out, what it assumes, how a value was marked. The text report prints them under `Notes:`, one per line, and keeps `Errors:` for what failed, such as a source that did not answer. `--json` carries both as `data.notes` and `data.errors`; a note never marks a report incomplete.

A rendered-view report (a pane without a structured report) names the pane's source; its status is the one the pane declares for its data or its own footer states, and otherwise reads "Status not reported".

## Plugins pane

Open it with `PL` in the command bar. It lists what you have installed, what the registry offers, and, behind `b`, the built-in modules that can be switched off. Every row has a version and a status: `enabled`, `disabled`, `update` when the registry has something newer, `needs setup` when the plugin is missing a required setting, `errors (n)` when it has logged failures this session, and `failed` when it did not load at all, with the reason in the detail view.

Plugin GitHub star counts are currently hidden. The marketplace keeps its curated ordering.

| Key | Action |
|-----|--------|
| `i` | Install the selected plugin, after a confirmation that names its source and declared hosts |
| `g` | Get its update, or reload one that failed to load |
| `x` | Remove it |
| `e` | Enable or disable it |
| `s` | Open its setup form |
| `p` | Open a pane it provides |
| `d` | Open the debug log filtered to it |
| `h` `l` or arrows | Move between category tabs |
| `b` | Show or hide built-in modules |
| `/` | Search |

A plugin installed or updated from the pane is loaded into the running session: its panes and commands are available immediately. If your app starts with a plugin that failed to load, a notification says so and opens this pane.

You do not need the pane to get an official plugin. Type its code, such as `TV`, `POLL`, `PM`, `HN` or `SUB`, and the command bar offers to install it after the same confirmation, then opens it with whatever you typed after the code.

Official plugins, the ones published under [github.com/gloom-sh](https://github.com/gloom-sh), update on their own in the background: once after Gloomberb itself updates, then at most once a day. A plugin you linked or edited locally is left alone, and when an update needs a restart to finish, one notification says so. Third-party plugins update only when you press `g` or run `gloomberb update`. **Update official plugins automatically** in this pane's settings turns it off.

## Portfolio currency

A portfolio's header totals and its COST, MKT VAL, DAY, P&L and MCAP columns are in the portfolio's currency, as are `PORT` and `gloomberb portfolio show`. A broker portfolio uses its account currency. A manual portfolio uses your base currency (`config set baseCurrency`). With the default USD base, a manual portfolio takes the currency of its first position instead: a portfolio of ASX shares bought in AUD totals in AUD, and holdings added later in other currencies convert into it. Totals lead with the currency symbol, such as A$108.6k, unless both they and the base currency are USD. LAST, AVG COST and TARGET stay in the listing's currency.

## Cash, target weights and rebalancing

A portfolio can hold cash beside its positions and a target weight for each holding. `PF` and `gloomberb portfolio show` then show how far each holding is from its target and the trade that would bring it back.

```bash
gloomberb portfolio cash set Retirement 500000 USD     # or: cash clear Retirement
gloomberb portfolio target set Retirement VTI 30%      # 30 and 30% are the same
gloomberb portfolio target set Retirement CASH 25
gloomberb portfolio target show Retirement             # or: target clear Retirement [VTI]
gloomberb portfolio show Retirement                    # --csv and --json keep raw numbers
```

- **Cash** is one amount in one currency, converted into the portfolio's currency. A broker portfolio whose account reports its cash shows that balance instead of an amount entered by hand, so cash is never counted twice. Bare `CASH` names the cash line: `target set` takes it, while `portfolio add` and `position set` refuse it and point to `cash set`. The stock that trades under that symbol is `CASH:NASDAQ`.
- **Weight** is a holding's net market value as a share of the total: every priced holding plus the cash. A short weighs against the total. A holding without a price is left out of the total and the weights rather than counted at zero, shows `n/a`, and `portfolio show` says how many were left out.
- **Targets** are percents of the same total, kept per ticker symbol on the portfolio, and sync between your devices with the rest of your settings when you are signed in. They need not add up to 100%: `portfolio show` notes the sum and what is unallocated. A target can name a ticker the portfolio does not hold yet; a manual portfolio adds it, at a weight of 0%.
- **Drift** is weight minus target in percentage points: `+2.3pp` is overweight.
- **Trade** is what reaches the target at the current price: the value, and the units at the position's own value per unit (contract multipliers and FX included). A holding kept in whole shares trades in whole shares, rounded; fractional holdings keep four decimals, coins eight. Trades ignore fees, taxes and lot sizes.

In `PF`, a portfolio with targets shows `WEIGHT`, `TGT WT`, `DRIFT` and `TRADE` after `MKT VAL`, unless the pane's columns already include target columns; `TRADE VAL` is in the pane's column settings. (`TARGET` and `TARGET%` are the analysts' price target.) With cash entered by hand the header shows `Total` and `Cash`, with the cash's weight and drift; a broker account keeps its `Net Liq` and `Cash`. `gloomberb fn PF` and `gloomberb portfolio show` report the same figures.

## Broker position sync

Press `a` in the **Brokers** pane (`BR`), or run **Add Broker Account**, to connect a broker; **New Portfolio** can start from one too. Gloomberb can import positions from Interactive Brokers, Public, Robinhood, and SimpleFIN.

Each broker is a plugin with its own repository, installed on first launch and updatable on its own. Manage them from the plugin directory, or with `gloomberb install gloom-sh/gloom-public` and friends.

- Robinhood opens a browser sign-in page. Gloomberb uses only the read-only account and equity-position tools from the Robinhood Trading MCP server.
- Public needs an API secret from Public API settings. Gloomberb creates a short-lived access token and uses only the account and portfolio endpoints.
- SimpleFIN needs a one-time setup token from SimpleFIN Bridge. Gloomberb exchanges the token and imports only accounts that contain holdings.

Gloomberb saves the connection data on the local device. It does not include this data in Gloom Cloud synchronization. A later position sync updates the managed portfolios and removes positions that the broker no longer reports.

### Imported bond price basis

A broker can declare bond cost and mark prices as `percent-of-par`: quantity is nominal face in the position currency, and monetary cost/value are nominal × quoted price ÷ 100. For example, 1,000 USD face at 87.742% par has a cost of 877.42 USD. The supplied contract multiplier remains separate metadata and is not applied again. Position cells use `face` and `% par`; bond ETFs continue to use ordinary share prices.

Source market value and unrealized P&L remain authoritative snapshots. When either is absent, only compatible known cost/mark inputs can derive it. No accrued interest, coupon, clean-to-dirty adjustment or investment yield is inferred. Older BOND holdings without a declared price basis retain their broker totals/P&L but show unavailable price-derived cost, value and percentage until a source resync provides the convention. The host does not guess it from a symbol, price, multiplier or a reconciling profit.

An independent current bond quote must declare its own price basis. A percent-of-par quote must match the holding's nominal currency; currency conversion occurs after valuation. Compatible current prices and broker totals are selected per lot, and totals require every lot to contribute. Price conventions do not establish the units of separate historical series or add a live bond-data source. The IBKR Flex adapter documents its accepted reporting convention and source evidence.

## Gloom Cloud sign-in

Sign in with email and password, or pick `Log In with QR Code` from the command bar and scan the code with the Gloomberb mobile companion app to sign the terminal in without typing. The onboarding wizard offers the same QR option as the recommended path, with email and password as the alternative.

## Chat

`CHAT [channel]` opens a channel. When the pane is too narrow or short for the channel list beside it, the list and the open channel take turns: Back, Esc, Backspace, Left or the mouse back button return to the list, and Enter, Right or a click opens a channel. Pointing at a name or an @mention shows that person's card: their public profile if they made it public, otherwise their name and @username. On the desktop and the web the card opens just below the name, so the pointer can move straight onto it; in the terminal it sits in the chat's top-right corner. It stays open while the pointer is on it. Someone else's card has Message (Open DM when you already share one); a card with only a name says why instead when they take no DM from you. A click on the name keeps the card open until Esc, a click outside it or a second click; `p` shows the card of the selected message's author.

A message can carry up to four images: PNG, JPEG, WebP or GIF, up to 5 MB each. In the desktop app and the web app, paste an image into the message field, drop image files on the chat, or use the image button at the end of the field (also `Attach Image…` in the pane menu). Each image uploads at once and shows above the field with its progress; the x removes it, and one that failed to upload offers Retry. Enter sends once every image is up, with or without text. In the terminal, paste or drop the path of an image file into the message field to attach it; Backspace in an empty field removes the last one. Images in public channels are checked before anyone else sees them: your own message says `Checking image...` meanwhile, and `Could not be checked, only visible to you` if the check could not run. The desktop and web show images in the conversation and open them full size on a click (Left and Right step through a message's images, Esc closes); the terminal lists each image as a row such as `[image 1280x720 179 KB]` that opens in the browser on a click, or with `o` on the selected message. A message that failed to send has Retry, or Enter while it is selected, which sends it again without uploading its images again.

The unread count in the status bar opens Unread Chat (also in the command bar): one row per channel with unread messages, and the count of a channel that mentions you in green. Counts are your account's, the same on every device. A row shows the latest unread message, one that mentions you first, only when the messages after the last one you read are already on this device, so a row can have a count and no message. Opening a row shows that channel in your chat pane; the list itself marks nothing read.

## Debt maturities

`DDIS MSFT` opens the issuer's latest coherent principal maturity schedule. Maturities shows six relative fiscal buckets, including an open-ended Thereafter bucket, alongside the total and the shares due in the next twelve months and three years. Select a bucket for its exact amount and SEC fact. History shows the last ten years of annual filing cohorts; select an observation to inspect its filing. Filing shows currency, source concepts, interest expense, the borrowing-cost proxy when supported, and percentile coverage. `o` opens the selected filing.

Use `gloomberb fn DDIS MSFT --json` for the source amounts, complete filing history, ranks and provenance. `gloomberb shot DDIS MSFT --tab history` captures the historical view; `--tab filing` selects the filing details. Missing facts remain unavailable, and unsupported issuers do not appear to have zero debt.

## Theses

A thesis is why you hold something, written so it can be checked: the instruments it holds, the pillars that must stay true, the kill conditions that would make you sell, and dated catalysts. Every ticker has a Thesis tab next to Notes, and a portfolio or watchlist row's context menu has a Thesis entry; `THESIS` opens the board, sorted by what needs a ruling, with the share of the book sitting on weakening or broken theses and the positions that have no thesis yet, biggest first. `THESIS NVDA AMD` starts one on a basket or a pair; the ticker prompt takes several symbols separated by spaces or commas. On the board, `/` searches by ticker or company, `p` cycles the portfolio in view, and `w` compares conviction with weight.

Theses are stored in Gloom Cloud for any signed-in account, personal or shared with a team; teammates can challenge a pillar. Signals only ever wait for your ruling: accept, dismiss with a reason, or snooze. Resetting a kill condition that fired requires a note on the revision. Drafting a thesis from a sentence, and reviewing it against fundamentals and news (`v`), need Pro.

## Localized interface

Gloomberb includes English, Spanish, Simplified Chinese, Traditional Chinese, Japanese, and Korean UI support. English remains the default fallback language.

- **Automatic detection:** supported `LANG` / `LC_ALL` and desktop system locales select the matching interface automatically.
- **Command switching:** enter `LANG` in the command bar (Ctrl+P) to cycle languages, or use `LANG auto`, `LANG en`, `LANG es`, `LANG zh-CN`, `LANG zh-TW`, `LANG ja`, or `LANG ko`. The choice is persisted in `config.json`.
- **One-run override:** `GLOOMBERB_LANG=ja gloomberb` (or another supported locale) takes highest priority in environments that expose process locale variables.

## Market and macro plugins

Polls lives in its own repository rather than inside the app. It reads one third-party site directly, so the plugin can ship a fix the day that site changes instead of waiting for an app release.

Existing installations restore it once after upgrading, keeping its saved panes: the pane and template ids are unchanged. A deliberate removal is respected. To install it by hand:

```bash
gloomberb install gloom-sh/gloom-polls
```

Fear & Greed, Market Heatmap, Market Halts and the IPO Calendar are built in again, with the same panes, shortcuts and settings. Where Market Overview was switched off, the first three start switched off too, and the IPO Calendar where Macro was, unless its plugin was installed; `PL` turns them on. A copy installed while they were plugins is no longer loaded; `gloomberb plugins` lists it, and `gloomberb remove gloom-fear-greed` (or `gloom-market-heatmap`, `gloom-market-halts`, `gloom-ipo-calendar`) deletes it.

## Live TV

Install [TV](https://github.com/gloom-sh/gloom-tv) with `gloomberb install gloom-sh/gloom-tv`. Existing installations restore it once after upgrading. Live TV in the terminal also requires `mpv` with Kitty video output. Gloomberb resolves the stream in JavaScript and runs `mpv` with its `yt-dlp` integration disabled, so `yt-dlp` is not required.

## Options scenarios

Open `OSA AAPL`, choose **Add leg** to enter a call or put, or **Chain** to select a quoted contract. In OMON, select the call or put cell and use **Add to OSA** (`a`); from the keyboard, `x` switches the cursor row between its call and put, and `[` / `]` step the expiry. Each handoff opens the leg editor in the ticker's existing OSA pane; saving appends the leg to its position. Set buy/sell, contracts, entry premium per unit, annualized IV and units per contract. The default multiplier is 100 and can be changed for a known deliverable.

The Payoff and P&L grid tabs share the scenario-date (`d`) and parallel vol-shift controls. **Inputs** (`i`) edits spot, rate, dividend yield, currency, valuation timestamp and spot range. **Save** (`s`) stores a named snapshot; **Browse saved** (`b`) restores one for the same ticker and listing. The current draft, selected date, vol shift and selected leg also resume with the layout. In Legs, Enter or **Edit** (`e`) edits the selection and **Remove** (`x`) asks before removing it. Named snapshots preserve their original valuation timestamp.

Both `fn` and `shot` accept explicit inputs for reproducible analysis:

```sh
gloomberb fn OSA AAPL --legs 'call,100,2026-12-18,1,5,25;call,110,2026-12-18,-1,2,25' --spot 100 --rate 4 --dividend-yield 1 --currency USD --as-of 2026-09-22 --date 2026-10-22 --vol-shift 3 --json
gloomberb shot OSA AAPL --legs 'call,100,2026-12-18,1,5,25;call,110,2026-12-18,-1,2,25' --spot 100 --rate 4 --dividend-yield 1 --currency USD --as-of 2026-09-22 --date 2026-10-22 --vol-shift 3 --tab payoff --output osa-payoff.png
```

The leg format is `call|put,strike,YYYY-MM-DD,signed contracts,entry price,IV percent[,multiplier]`, separated by semicolons. `--tab` accepts `payoff`, `grid` and `legs`; `--spot-range` is the percentage range either side of spot. Omit market overrides to use current sources, or request `--strategy vertical` or `--strategy straddle` to build an explicit example from complete two-sided quotes. `--expiration` selects that chain's expiry in Unix seconds. Screenshot JSON includes the rendered position and numerical observations, with readiness validated against the shared model. No position is invented when no legs or strategy are supplied.

## Option valuation models

`OVME` starts with the European Black-Scholes model. Choose **American CRR** or use `m` to value early exercise. Set the tree step count and enter cash dividends as `days:amount`, separated by semicolons, for example `30:0.25;90:0.25`. Days are calendar days from valuation and cash is per underlying unit. `d` focuses the dividend schedule; `u` edits the underlying ticker. The model, tree settings and schedule resume with the pane.

Choose **Surface IV** or use `v` to source the strike/tenor volatility from OVDV. The surface is fitted using the current observed underlying quote; changing the calculator's spot changes the scenario price, not the source surface. Its quote dates and fit methods appear in the footer, with source failures and coverage limitations in warnings. Editing the IV field returns to entered volatility. `r` refreshes the source. Switching back to European BS deactivates the American cash schedule while preserving it for later use.

```sh
gloomberb fn OVME --model american --side put --spot 100 --strike 100 --days 365 --volatility 20 --rate 5 --dividend-yield 0 --dividends '30:1;120:1' --steps 800 --json
gloomberb fn OVME --model american --symbol AAPL --spot 340 --strike 340 --days 90 --rate 4 --dividend-yield 0 --vol-source surface --json
gloomberb shot OVME --model american --side put --spot 100 --strike 100 --days 30 --volatility 25 --rate 4 --dividends '10:1;20:1' --width 1080 --height 340 --output ovme-american.png
```

CLI rates and IV are percentages; `--market-price` is a per-unit premium and uses the selected model's IV solver. Explicit input-volatility calculations run without market access. The European closed form rejects an explicit cash schedule in `fn`; the pane and `shot` preserve it with an ignored-schedule notice. Cash dividends are entered by the user; the surface source supplies volatility and does not infer or replace that schedule.

`shot OVME` accepts the same valuation flags and returns the captured inputs, price, Greeks, IV result and source metadata as numerical evidence. It verifies the rendered calculation against the requested inputs. Missing surface data, invalid values or a pane too short to show the metrics do not produce usable evidence. `shot HVG AAPL` and `shot HVT AAPL` also verify their plotted observations; use `--show-iv false` when only realized volatility is wanted.

## Relative rotation

`RRG` or `GRR` opens US sector ETFs versus SPY. `RRG AAPL:NASDAQ,MSFT:NASDAQ`
uses an explicit universe. Pane settings choose the benchmark, a linked watchlist
or portfolio, custom symbols and a 2-12-week trail (six by default). The
maximum is 24 instruments; a larger collection asks for a smaller scope.

Select a coloured table row to locate its trail; open it for dated strength and
momentum history. Click column headers to sort. Missing aligned histories remain
in the table with unavailable values and a footer notice. CSV export uses the
pane menu. `gloomberb fn RRG --benchmark SPY:NYSEARCA --trail 6 --json` returns
metrics, dated trails, rank sample counts and data limitations.

## Portfolio risk depth: PORT and MARS

`PORT` opens portfolio market risk; `MARS` is its alias. Add a local portfolio ID to select it, for example `PORT main`. Views cover Risk, Factors, Holdings, Correlation, Stress, Performance, Attribution and Greeks. Enter opens a metric's evidence and history; Escape returns. Click portfolio tabs or press `p` to switch portfolios. Press `i` to import local account evidence from the clipboard, and `r` to refresh Cloud observations. Tables support sorting and CSV export.

Use pane settings for independent index-percent, 10Y-basis-point and VIX-point stress shifts. Existing saved Analytics panes keep Overview until their View setting changes to Risk depth. Performance, Brinson attribution and imported option Greeks use the versioned local JSON schema in [research data](research-data.md#local-account-evidence); the pane does not derive account cashflows from current holdings. Evidence remains private and must match the portfolio ID and currency.

```sh
gloomberb fn PORT main --json
gloomberb fn MARS main --view factors --json
gloomberb fn PORT main --view stress --equity-shift -15 --rate-shift 100 --vol-shift 10
gloomberb shot PORT main --width 1100 --height 620 --output portfolio-risk.png
```

Risk, Factors, Correlation and Stress model the equity holdings with daily history, up to the 150 largest by value. A listing quoted in another currency is converted to USD at daily FX closes, and the footer counts those holdings. When some holdings are left out (foreign listings without daily FX closes, shorts, options, crypto, holdings without a quote or history), the footer says how much of the account the estimates cover and `!` lists each holding left out and why (`fn PORT` prints the same under Notes); below half of the account's market value the views say so instead of estimating. See [research data](research-data.md#portfolio-risk-depth-port-mars) for the method.

`--evidence` accepts the same JSON text as the clipboard import. Account-return and attribution examples in the methodology are illustrative inputs, not sample market data. A report includes raw values, source dates, percentile coverage, holdings, factor regressions and warnings; screenshots freeze that same local model.

## Equity criteria screener

`EQS` screens the stored Cloud equity universe. It starts with USD companies above
$10 billion in market capitalization. **Criteria** edits typed numeric ranges,
category lists and available/unavailable data conditions. All criteria are ANDed.
Thresholds accept `k`, `M`, `B` and `T` suffixes, so `10B` is ten billion. The
currency selector is required for price and market-cap comparisons.

Besides valuation, growth, margins, short interest, insider and 13F activity and
social attention, fields cover:

- **Returns** 1W, 1M, 3M, YTD and 1Y: price change, without dividends, from the close
  at the window start (the prior year's last close for YTD): a stored daily close on
  or up to a week before the start, else, for 1M and longer, the weekly close
  nearest the start, within four days. 1W needs daily closes.
- **VS 52W HI%**: price against the highest high of the last 52 weeks, 0 at a new high.
- **Beta**: raw beta of two years of weekly returns against SPY, US listings.
- **P/B**, **EV/EBITDA** and **FY ROE%**: market cap over latest balance-sheet equity;
  market cap plus debt minus cash over the last four quarters' EBITDA; annual net
  income over average equity. The same definitions as the FA ratio tabs. Statements
  in another currency than the market cap (most ADRs) leave them unavailable.
- **EPS REV 30D%**: change in the current fiscal year's consensus EPS over 30 days,
  unavailable when the fiscal year rolled in between.
- **UPSIDE%**: mean analyst price target over the price.
- **IV RANK** and **IV/HV**, for optionable US names: 30-day implied volatility
  between its 52-week low (0) and high (100), and over the realized volatility of
  the last 21 daily closes.

Returns, EPS revisions and upside take the sign colour.

**Results** leads with the chosen metric and its covered-universe percentile, then
one column per numeric criterion and context columns (market cap, price, change, P/E,
revenue growth, operating margin, dividend yield) as width allows. Stale values are
amber, and an AS OF column dates the chosen metric on the rows where it is stale.
Click a metric header to sort by it and make it the focus; click again to reverse.
The footer shows matches, covered listings, currency and the snapshot time.
Enter opens a company's dated observations; `o` opens it in Ticker Research.

`s` saves a named screen to your Cloud account; **Saved** restores one. Saving an
existing screen updates its revision; **Save copy** creates another. Conflicting
edits from another device are reported. `x` exports all matches from the displayed
snapshot, up to 5,000 rows. The normal pane CSV menu exports currently loaded rows.
Expired snapshots ask for a refresh before continuing or exporting.

`gloomberb fn EQS --metric trailingPE --json` returns the first 100 matches with the
snapshot, match and coverage counts, and the chosen metric's date and state per row.
A notice says when more rows match; narrow the criteria to reach them. `--definition`
accepts versioned JSON with `criteria`, `currency` and `sort`, for example:

```sh
gloomberb fn EQS --definition '{"version":1,"currency":"USD","criteria":[{"field":"trailingPE","op":"between","value":[0,25]},{"field":"revenueGrowthPercent","op":"gte","value":10}],"sort":{"field":"marketCap","direction":"desc"}}' --json
```

## Backtest

`BT AAPL` (or `BTST AAPL`) tests a long-only rule on the ticker's daily history
against buy-and-hold. **Strategy** (`s`) picks a preset: golden cross (50/200), above
the 200-day average, RSI 30/50 reversion, MACD signal cross, Bollinger
reversion, or a 55/20-day breakout. `e` opens the rules, where **Custom rules**
takes an entry and an exit written as `<operand> <comparison> <operand>`,
joined with `and`:

```
close > sma(200)
sma(50) crosses above sma(200) and rsi(14) < 70
close > highest(55)
```

Operands are `close`, `open`, `high`, `low`, a number, `sma(n)`, `ema(n)`,
`rsi(n)`, `macd(fast,slow,signal)`, `macd_signal(fast,slow,signal)`,
`bb_upper(n,k)`, `bb_lower(n,k)`, `highest(n)` and `lowest(n)`. Comparisons are
`>`, `<`, `>=`, `<=`, `crosses above` and `crosses below`. Settings also choose
the lookback (5 years, 10 years or all history) and the cost per side in basis
points.

**Summary** plots the strategy and buy-and-hold as growth multiples on a log
scale with the strategy's drawdown below, beside return, CAGR, volatility,
Sharpe, drawdown, time in market, the share of rolling one-year windows in which
the rule beat buy-and-hold, and trade statistics. **Trades** lists each trade;
an open position is marked at the last close. `v` switches views and `r`
refreshes history.

```sh
gloomberb fn BT AAPL --json
gloomberb fn BT SPY --preset custom --entry 'close > sma(200)' --exit 'close < sma(200)' --lookback max --cost 2
gloomberb shot BT NVDA --preset breakout-55-20 --output nvda-breakout.png
```

### Credit documents (CRDOC / COVN)

`CRDOC FICO` opens capital structure, covenant headroom, instrument maturity walls and a global risk screen. Select an instrument for its exact terms, filing evidence and amendment history. `COVN` opens the Covenants tab. This Pro dataset includes a free preview. See [credit documents](credit-documents.md) for coverage, calculation limits and CLI options.
