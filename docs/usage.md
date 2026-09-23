# User guide

[Back to README](../README.md) · [Installation](installation.md) · [Browser app](browser.md)

- [Research data conventions](research-data.md)
- [Keyboard shortcuts](#keyboard)
- [Command reference and chart composer](#command-reference)
- [CLI commands and output formats](#cli)
- [Broker position sync](#broker-position-sync)
- [Gloom Cloud sign-in](#gloom-cloud-sign-in)
- [Interface language](#localized-interface)
- [Live TV](#live-tv)

The desktop app and TUI share the command language and plugin system. The [browser app](browser.md) offers a smaller feature set. Use `HELP` in the app or `gloomberb help` in your shell for the commands available in your installation.

## Keyboard

| Key | Action |
|-----|--------|
| `Ctrl+P` | Open command mode |
| `` ` `` | Open ticker search |
| `Ctrl+,` | Open focused pane settings |
| `Ctrl+W` | Close focused pane (unless it is locked) |
| `Ctrl+Shift+M` | Move focused window (`WIN resize` starts resize mode) |
| `Ctrl+Shift+D` | Dock or float focused pane |
| `Ctrl+Shift+E` | Export focused pane table as CSV |
| `Ctrl+Shift+L` | Layout actions |
| `Ctrl+Shift+G` | Tidy windows |
| `Tab` | Switch panes |
| `j` / `k` | Navigate lists |
| `h` / `l` | Switch tabs |
| `Ctrl+Left` / `Ctrl+Right` | Scroll a focused table horizontally |
| `m` | Cycle chart mode |
| `q` | Quit |

Desktop builds also accept `Cmd/Ctrl+K` for the command bar, the matching `Cmd` shortcuts on macOS, `Cmd/Ctrl+Shift+O` to pop out a pane, and `Cmd/Ctrl+Shift+C` to copy a focused pane screenshot.

Wide tables retain their columns in narrow panes. Use their horizontal scrollbar or horizontal wheel/trackpad scrolling to reach additional fields; `Ctrl+Left` / `Ctrl+Right` moves by half a table viewport. Plain arrows keep their existing navigation behavior, and text-field shortcuts remain with the editor.

### Custom keybindings

Every global and pane management key can be moved, and any command bar text can be put on a key. On a layout where the backtick is a dead key, the command bar already searches symbols for anything you type after `Ctrl+P`; a dedicated ticker search key is one rebind away. Open `HELP`, pick the Shortcuts tab, and press Enter on a row (or double-click it) to capture the next chord; Backspace unbinds, `0` restores the default, and `N` starts a command binding. The Functions tab lists every typed prefix the same way, and Enter there opens the command bar on that prefix. Typing a command in the command bar, such as `DES AAPL` or `CN`, offers a `Bind a key` row as well. Capture shows exactly what your terminal delivered for the combination, which matters on terminals that fold `Ctrl+Shift+F` into `Ctrl+F`.

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

### Company Research

| Shortcut | Function |
|----------|----------|
| `DES <ticker>` / `T <ticker>` | Security details for a ticker |
| `FA <ticker>` | Financial statement view |
| `G <series>` | Custom chart composer |
| `CAT [query]` | Browse and search chartable series |
| `GP <ticker>` | Price chart |
| `GIP <ticker>` | Intraday price chart |
| `HP <ticker>` | Historical OHLCV prices |
| `GF <tickers>` | Fundamental statement graph |
| `GE <tickers>` | Valuation multiple graph |
| `GR <tickers>` | Security relationship graph |
| `EE <ticker>` | Events view with earnings and revenue estimates |
| `ERN [tickers]` | Earnings calendar; alone, your portfolio and watchlists |
| `SRCH [query]` | Full-text search across earnings call transcripts, news, and SEC filings |
| `CALLS [ticker]` | Earnings call transcripts; alone, every transcribed call |
| `JOBS [ticker]` | Hiring from the company's careers system; alone, every covered company |
| `QQ <tickers>` | Ticker quote monitor |
| `CMP <tickers>` | Normalized price comparison |
| `CORR <tickers>` | Ticker return correlations |
| `ANR <ticker>` | Analyst targets and ratings |
| `DIAG <ticker>` | Equity Diagnostic with cited flags and anomalies |
| `SEC <ticker>` | SEC filings and company disclosures |
| `OMON <ticker>` | Options chain, expected moves, 25-delta skew and adjacent-expiry term slope |
| `OVDV <ticker>` | Rotatable 3D implied-volatility surface by delta or moneyness, smiles, term structure, skew and forwards |
| `HVG <ticker>` | Realized volatility by estimator and window, price, and current ATM IV |
| `HVT <ticker>` | Volatility cone, current estimates and historical percentiles |
| `HIVG <ticker>` | Implied volatility history against realized, with IV rank and percentile |
| `VCA [tickers]` | Rich/cheap implied volatility across a list: IV rank, percentile, term slope, skew, IV/HV |
| `OSA <ticker>` | Multi-leg option positions, scenario P&L, payoff charts and aggregate Greeks |
| `OVME` | Black-Scholes option calculator with Greeks and implied volatility |

| `OVME` | European or American option pricing, discrete dividends, Greeks and surface volatility |
| `HDS <ticker>` | Institutional holders |
| `DVD <ticker>` | Dividend yield and history |
| `SI <ticker>` | Short interest |
| `SIV <ticker>` | FINRA daily off-exchange short-volume ratio, history and percentile |
| `13F [fund/ticker/CIK]` | 13F fund filings and holdings |
| `INS <ticker>` | Insider activity |
| `EVT <ticker>` | Corporate actions, earnings, and estimates |
| `RV <tickers>` | Relative valuation |

Earnings-call data exports and fiscal-quarter lookup inspect at most the latest 200 calls in the requested scope; the interactive list loads 50. The server does not supply a total or a `hasMore` marker. When a response fills its source limit, exports report `sourceLimitReached: true`, `complete: false`, and `truncated: true`: additional calls may exist. `total` counts matching loaded calls; `totalIsExact: false` marks capped, pending, or stale results. A missing quarter in a capped lookup is not proof that the company has no such call. Pending discovery remains pending when reopening or refreshing the pane. Full-text documents can be read and searched without structured turns, but Q&A requires source segmentation.

### Chart Composer

`G`, `GP`, `GIP`, `CMP`, `GF`, and `GE` all open the same chart composer with different starting presets. `CAT` opens a searchable catalog of those chartable series so you can graph one without typing the expression; its SOURCE column names the provider a plain market request reaches first (Gloom Cloud in the app, a broker or the Yahoo fallback where those are what is registered), while FRED, treasury and valuation rows name their own source. A custom expression can mix unrelated data sources on one synchronized timeline:

```text
G AAPL:price, MSFT:revenue, FRED:CPIAUCSL
```

Open **Series** to add, remove, reorder, or hide series and choose each series' field, chart style, transform, axis, panel, period, and panel scale. Price data supports candles, OHLC, HLC, line, and area; scalar data supports its compatible line, area, step, column, and point modes. Panels can use independent left/right axes and linear or logarithmic scales.

The toolbar controls preset or exact date ranges, intervals from one minute through monthly, the primary chart mode, technical indicators, and pair formulas. Indicators include volume, SMA, EMA, Bollinger Bands, RSI, MACD, and Realized Volatility; formulas include ratio, spread, and rolling correlation. Realized Volatility has window and estimator controls in pane settings. Auto resolution requests daily bars for that indicator; explicit weekly or intraday bars cannot be annualized as daily sessions. Mixed-frequency values use as-of alignment: fundamentals use filing dates when available, sparse series carry forward only after becoming available, and missing publication dates appear behind the warning indicator in the existing chart footer (click it or press `!`).

Spread calculates the first input minus the second input times its configured multiplier. It requires matching known input dimensions, currencies, and scales; an incompatible formula is unavailable and appears in the existing chart/report errors while usable series remain available. Market prices also require a declared per-unit basis: two bare USD futures quotes do not establish comparable physical quantities. A multiplier does not supply missing units or establish a conversion. No implicit FX conversion occurs. Studies use source values before chart presentation transforms, so selecting a percent or index display does not convert foreign-currency inputs before subtraction. Ratios retain derived units such as USD/EUR or 1/share and have no value at a zero denominator. As-of alignment can combine observations from different dates; the source dates do not establish a synchronized executable price.

When either ratio input has unknown units or a missing price basis, its numeric ratio remains available with unit `unknown`. Currency factors cancel only at the same scale: GBP/GBp remains explicit, while equivalent pence labels GBp/GBX cancel. This does not convert either input's values.

Correlation uses matching observation times when inputs have different frequencies. Chart panes keep units and active failures visible; recurring FX and alignment explanations remain in these docs and export/share metadata.

`GIP` session loading retains finite zero and negative prices when provider metadata identifies a futures instrument. If another or unknown instrument type reports a nonpositive close in the selected window or its calculation buffer, the result is unavailable; JSON metadata retains the rejected values and dates in `intradayPriceDomainFailures`. Inconsistent OHLC bars still become gaps. Logarithmic scales and transforms retain their positive-value requirement.

### Markets, News, and Macro

| Shortcut | Function |
|----------|----------|
| `TOP` | Ranked market stories |
| `HM` | Market heatmap for large US stocks and ETFs ([Market Heatmap plugin](https://github.com/gloom-sh/gloom-market-heatmap)) |
| `MOST` | Top gainers, losers, most active, and trending tickers |
| `HILO` | Session new highs and new lows with 30s/1m/5m momentum |
| `FLOW` | Unusual options activity: sweeps, blocks, and large premium; Vol/OI divides the contract's day volume by its latest reported open interest. Cloud records every print, for options flow alerts and the assistant |
| `PM <query>` | Polymarket and Kalshi prediction data ([Prediction Markets plugin](https://github.com/gloom-sh/gloom-prediction-markets)) |
| `N` | News feed |
| `CN <ticker>` | Ticker news |
| `NI` | Sector news |
| `SUB` | Authenticated Substack reader feed |
| `FIRST` | Breaking news |
| `TWIT <query>` | Ticker-related market posts |
| `TBO` | TheBuildout infrastructure intelligence |
| `CG` | Congress trading disclosures |
| `WEI` | Global equity indices |
| `MAP` | Live world venue map with local market status and clocks |
| `TAS <ticker>` | Time and sales: trade prints, observed-window VWAP and large prints |
| `QR <ticker>` | Quote recap: NBBO history with sizes, venues and spread (the same pane on its NBBO tab) |
| `EM <ticker>` / `EEO <ticker>` | EPS estimate revisions, current analyst breadth and surprises; `--period YYYY-MM-DD --frequency quarterly` pins a fiscal period |
| `GUID <ticker>` | Company EPS guidance cited from filings and transcripts, against consensus (the same pane on its Guidance tab) |
| `FUT` | Futures quote aliases across index, rates, energy, metals, grains, and FX |
| `RRG` / `GRR` | Weekly relative rotation of sectors or a watchlist against a benchmark, with dated trails |
| `BT <ticker>` / `BTST <ticker>` | Backtest a long-only indicator rule on daily history against buy-and-hold |
| `EQS` | Equity screener over the stored Cloud universe: valuation, growth, margins, short interest, insider and 13F criteria, saved screens and export |
| `CRYP` | Top crypto assets by market cap with live prices, 7D, 30D and 1Y returns, 24h volume and market cap; stablecoins on their own tab |
| `ECO` | Economic events and releases |
| `ECST [statistic]` | Economic statistics: inflation, labour, growth, consumer, housing, rates |
| `GC [YYYY-MM-DD]` | Treasury yield curve for the latest session or a historical date; CLI also accepts `--date YYYY-MM-DD` |
| `WIRP` / `FFIP` | Fed funds futures implied FOMC path, conditional target probabilities, SOFR contracts and Fed projections |
| `BTMM` | Money markets: funding rates, Treasury bill curves and Federal Reserve liquidity |
| `YAS` | Fixed-coupon bond calculator: price/yield, accrued interest, duration, convexity, DV01 and Treasury spread |
| `CBR` / `ECFC` / `CBRT` | G20 central bank policy rates, last observed moves and one-year history |
| `CTM [root]` | Futures contract curve, historical ghosts, roll yield and open interest, including `CTM VX` |
| `COT [code or root]` / `CFTC [code or root]` | CFTC positioning extremes, weekly changes and historical percentiles |
| `AUCT` | Treasury auction results: auction rate, bid-to-cover, indirect share, and size |
| `VIX` | VIX 9D through 1Y cash-tenor curve, FRED history and 3M/30D ratio |
| `VOLS` | Cross-asset volatility indices, daily changes and one-year percentiles |
| `CRD` | Credit spreads |
| `VAL [indicator]` | Whole-market valuation: Buffett, CAPE, excess CAPE yield, Tobin Q, investor equity allocation, dividend yield, margin debt, cap/profits, cap/M2 |
| `CDS [ticker]` | Single-name corporate CDS activity: most-active issuers, or one issuer's trades |
| `ERN` | Earnings calendar |
| `IPO` | Upcoming and recent IPOs ([IPO Calendar plugin](https://github.com/gloom-sh/gloom-ipo-calendar)) |
| `HALT` | US trading halts with reason and resumption times ([Market Halts plugin](https://github.com/gloom-sh/gloom-market-halts)) |
| `TV` | Live Bloomberg, CNBC, and Yahoo Finance television ([TV plugin](https://github.com/gloom-sh/gloom-tv)) |
| `BI` / `SP` | S&P 500 sector performance |
| `FXC` | Major FX cross rates |
| `FNG` | Fear and greed market gauge ([Fear & Greed plugin](https://github.com/gloom-sh/gloom-fear-greed)) |

Ticker Research includes a **Congress** tab for House and Senate transactions in
the selected ticker. The **Chamber** filter narrows `CG` and the tab to one chamber. Scroll to append filing windows; `n` or its footer action continues a
window with no matching transactions. After the year's filings, `p` appends the
previous year. Select a trade for its disclosure details; `m`, `t`, and `o` open
the member, ticker, and source filing. Dates include the year when comparing
transactions across years.

The same feed is available through `gloomberb fn CG AAPL --year 2026 --json`.
Use `--filingOffset` and `--offset` with the returned pagination metadata to read
additional windows and trades.

`YAS` opens a reactive bond form. Enter settlement, maturity, annual coupon and either yield percent or clean price per 100 face. Tab and Shift+Tab move through fields; Enter opens a selected convention or frequency, and Escape leaves editing. The Cash flows and Sensitivity tabs retain the same terms. The end-of-month control is an explicit schedule choice and requires a month-end maturity.

`gloomberb fn YAS --settlement 2026-09-22 --maturity 2031-09-15 --coupon 5 --yield 4.25 --json` returns valuation, cash flows and yield shocks. Use `--price 103.333937` instead of `--yield` to solve yield, `--frequency 1|2|4`, `--day-count act-act-icma|30-360-us`, and `--end-of-month` as needed. `gloomberb shot YAS --tab valuation|cashflows|sensitivity` accepts the same inputs. Treasury data is optional; all local calculations still work when it is unavailable.

`FUT` keeps each rolling quote alias as its symbol and displays the provider's contract name when available. Search also matches that name. A month in this label describes the captured quote; the app does not derive an expiry date or establish the roll-adjustment basis of the alias's historical series.

`BTMM` opens Rates, Bills and Liquidity views. Select a row and press Enter or click it for its dated history, one-year range and source; Back returns to the board. The Bills curve compares common-date discount yields with one week, one month and one year earlier. Liquidity plots the net-liquidity proxy above the component board. `h` and `l` switch views; `o` opens the selected FRED series and `r` refreshes. Reports support `gloomberb fn BTMM --tab rates|bills|liquidity` and `--json`.

`CBR`, `ECFC` and `CBRT` open the same Central Bank Rates board. Each row shows its policy rate or target range, last observed move and date, one-year percentile, history and latest observation date. Select a row and press Enter or click for the source instrument, reporting lag, one-year range and history; Back returns to the board. `o` opens its official source and `r` refreshes. The US detail includes its verified next FOMC meeting; other meeting dates remain unavailable. Reports support `gloomberb fn CBR --json` and its aliases.

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

## CLI

Running `gloomberb` with no arguments launches the terminal UI. Normal commands run through a headless CLI path; use `gloomberb launch-ui` when a script should explicitly open the UI.

Human-readable output is the default: tables fit the terminal width, and a single result prints as aligned label and value lines. Piped text output keeps every cell whole. Automation can opt into structured output with `--json`, `--csv`, or `--ndjson`. JSON output favors the richest fetched model available and includes display-column metadata when a command has table columns; CSV and NDJSON use the command's tabular row view. Common global flags include `--limit`, `--refresh`, `--quiet`, `--no-color`, `--dry-run`, and `--yes`.

Headless chart text includes a Unit column when a series supplies one; values keep that unit's scale (for example, `2.7 %` versus `270 bp`). DVD text labels cash growth, CAGR and earnings payout as percentages, while their structured `value` fields remain fractional ratios (`0.03` means 3%). `fn --csv` preserves the report fields and encodes nested sections or series as JSON cells, retaining raw numeric values alongside any separate display strings; it does not flatten or rescale those observations.

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
| `gloomberb news\|filings\|holders\|insider\|13f\|analyst\|events\|valuation <symbol>` | Fetch company research feeds |
| `gloomberb movers\|indices\|sectors\|fx\|earnings` | Fetch market overview data |
| `gloomberb econ\|fred\|yield-curve` | Fetch macro data |
| `gloomberb compare\|correlation <symbols>` | Compare securities (`relationship` is an alias of `correlation`) |
| `gloomberb portfolio [action]` | Manage manual portfolios |
| `gloomberb watchlist [action]` | Manage watchlists |
| `gloomberb notes\|alerts [action]` | Manage local notes and alerts |
| `gloomberb broker\|ibkr [action]` | Inspect broker profiles |
| `gloomberb ai providers\|ask` | Use configured AI providers ([BYOK AI plugin](https://github.com/gloom-sh/gloom-byok-ai)) |
| `gloomberb rss fetch <url>` | Fetch an RSS feed |
| `gloomberb provider status` | Inspect enabled data providers |
| `gloomberb config\|cache\|plugin\|layout\|pane\|debug\|doctor\|version\|changelog` | Inspect and manage local app state |
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

`gloomberb shot TAS AAPL --output tape.png` and `gloomberb shot QR AAPL --output quotes.png` capture a dated trade or NBBO snapshot with the current Cloud session's access delay.

## Plugins pane

Open it with `PL` in the command bar. It lists what you have installed, what the registry offers, and, behind `b`, the built-in modules that can be switched off. Every row has a version and a status: `enabled`, `disabled`, `update` when the registry has something newer, `needs setup` when the plugin is missing a required setting, `errors (n)` when it has logged failures this session, and `failed` when it did not load at all, with the reason in the detail view.

| Key | Action |
|-----|--------|
| `i` | Install the selected plugin, after a confirmation that names its source and declared hosts |
| `u` | Update it, or reload one that failed to load |
| `x` | Remove it |
| `e` | Enable or disable it |
| `s` | Open its setup form |
| `p` | Open a pane it provides |
| `d` | Open the debug log filtered to it |
| `h` `l` or arrows | Move between category tabs |
| `b` | Show or hide built-in modules |
| `/` | Search |

A plugin installed or updated from the pane is loaded into the running session: its panes and commands are available immediately. If your app starts with a plugin that failed to load, a notification says so and opens this pane.

## Broker position sync

Use **New Portfolio** or **Add Broker Account** to connect a broker. Gloomberb can import positions from Interactive Brokers, Public, Robinhood, and SimpleFIN.

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

## Debt maturities

`DDIS MSFT` opens the issuer's latest coherent principal maturity schedule. Maturities shows six relative fiscal buckets, including an open-ended Thereafter bucket, alongside the total and the shares due in the next twelve months and three years. Select a bucket for its exact amount and SEC fact. History shows the last ten years of annual filing cohorts; select an observation to inspect its filing. Filing shows currency, source concepts, interest expense, the borrowing-cost proxy when supported, and percentile coverage. `o` opens the selected filing.

Use `gloomberb fn DDIS MSFT --json` for the source amounts, complete filing history, ranks and provenance. `gloomberb shot DDIS MSFT --tab history` captures the historical view; `--tab filing` selects the filing details. Missing facts remain unavailable, and unsupported issuers do not appear to have zero debt.

## Theses

A thesis is why you hold something, written so it can be checked: the instruments it holds, the pillars that must stay true, the kill conditions that would make you sell, and dated catalysts. Every ticker has a Thesis tab next to Notes, and a portfolio or watchlist row's context menu has a Thesis entry; `THESIS` opens the board, sorted by what needs a ruling, with the share of the book sitting on weakening or broken theses and the positions that have no thesis yet, biggest first. `THESIS NVDA AMD` starts one on a basket or a pair; the ticker prompt takes several symbols separated by spaces or commas. On the board, `/` searches by ticker or company, `p` cycles the portfolio in view, and `w` compares conviction with weight.

Theses are stored in Gloom Cloud for any signed-in account, personal or shared with a team; teammates can challenge a pillar. Signals only ever wait for your ruling: accept, dismiss with a reason, or snooze. Resetting a kill condition that fired requires a note on the revision. Drafting a thesis from a sentence, and reviewing it against fundamentals and news (`r`), need Pro.

## Localized interface

Gloomberb includes English, Spanish, Simplified Chinese, Traditional Chinese, Japanese, and Korean UI support. English remains the default fallback language.

- **Automatic detection:** supported `LANG` / `LC_ALL` and desktop system locales select the matching interface automatically.
- **Command switching:** enter `LANG` in the command bar (Ctrl+P) to cycle languages, or use `LANG auto`, `LANG en`, `LANG es`, `LANG zh-CN`, `LANG zh-TW`, `LANG ja`, or `LANG ko`. The choice is persisted in `config.json`.
- **One-run override:** `GLOOMBERB_LANG=ja gloomberb` (or another supported locale) takes highest priority in environments that expose process locale variables.

## Market and macro plugins

Fear & Greed, Market Halts, Market Heatmap, the IPO Calendar, and Polls each live in their own repository rather than inside the app. Each reads one third-party site directly, so a plugin can ship a fix the day that site changes instead of waiting for an app release.

Existing installations restore all five once after upgrading, keeping their saved panes: the pane and template ids are unchanged. A plugin whose Market Overview or Macro owner was switched off stays off, and a deliberate removal is respected. To install one by hand:

```bash
gloomberb install gloom-sh/gloom-fear-greed
```

## Live TV

Install [TV](https://github.com/gloom-sh/gloom-tv) with `gloomberb install gloom-sh/gloom-tv`. Existing installations restore it once after upgrading. Live TV in the terminal also requires `mpv` with Kitty video output. Gloomberb resolves the stream in JavaScript and runs `mpv` with its `yt-dlp` integration disabled, so `yt-dlp` is not required.

The ticker research `13F` tab shows fund positions for the ticker, reported value, shares, weight and quarter action; open a row for its fund detail and scroll to page more funds. The `13F` pane's Crowding tab ranks new positions, exits, and weight increases or decreases across the top 25 ranked funds. `m` or the Mine filter limits positions to portfolio and watchlist tickers. CLI equivalents: `gloomberb fn 13F AAPL --view=ticker-holdings --offset=0 --json` (a ticker argument defaults to this view; `--view=by-ticker` lists the holders' whole 13F books) and `gloomberb fn 13F --view=crowding --json`.

In a 13F fund detail, open Overlap, search a second fund by name or CIK, and select it to compare shared positions and weights. Back returns to the fund picker. The Performance list includes three prior-quarter estimates when available. Headless crowding accepts `--rank=new`, `--rank=exits`, `--rank=increases` or `--rank=decreases`. CLI overlap: `gloomberb fn 13F 0001067983 --view=overlap --compare=0001037389 --json`.

The CG **Tickers** tab groups the loaded trades, including appended years, by
symbol. Enter opens that ticker's disclosures. The filter bar narrows side,
owner, asset category, and the minimum disclosed dollar amount; `f` opens those
filters by keyboard. `i` or **Mine** limits the view to portfolio and watchlist
symbols, which are highlighted in the tables. A `!` beside lag marks disclosures
filed more than 45 days after the transaction. CLI examples:
`gloomberb fn CG --tab tickers --side BUY --minAmount 50001 --json` and
`gloomberb fn CG AAPL --owner spouse --assetType option --json`.

Congress Trades includes returns since the transaction and filing close; Members includes party, median stock return and buy hit rate. Open a member for current committee assignments and the return denominators. Missing prices remain blank. See research data for the close-to-latest-close basis.

## Options scenarios

Open `OSA AAPL`, choose **Add leg** to enter a call or put, or **Chain** to select a quoted contract. In OMON, select the call or put cell and use **Add to OSA** (`a`). Each handoff opens the leg editor in the ticker's existing OSA pane; saving appends the leg to its position. Set buy/sell, contracts, entry premium per unit, annualized IV and units per contract. The default multiplier is 100 and can be changed for a known deliverable.

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

### Relative rotation

`RRG` or `GRR` opens US sector ETFs versus SPY. `RRG AAPL:NASDAQ,MSFT:NASDAQ`
uses an explicit universe. Pane settings choose the benchmark, a linked watchlist
or portfolio, custom symbols and a 2-12-week trail (six by default). The
maximum is 24 instruments; a larger collection asks for a smaller scope.

Select a coloured table row to locate its trail; open it for dated strength and
momentum history. Click column headers to sort. Missing aligned histories remain
in the table with unavailable values and a footer notice. CSV export uses the
pane menu. `gloomberb fn RRG --benchmark SPY:NYSEARCA --trail 6 --json` returns
metrics, dated trails, rank sample counts and data limitations.
### Portfolio risk depth: PORT and MARS

`PORT` opens portfolio market risk; `MARS` is its alias. Add a local portfolio ID to select it, for example `PORT main`. Views cover Risk, Factors, Holdings, Correlation, Stress, Performance, Attribution and Greeks. Enter opens a metric's evidence and history; Escape returns. Click portfolio tabs or press `p` to switch portfolios. Press `i` to import local account evidence from the clipboard, and `r` to refresh Cloud observations. Tables support sorting and CSV export.

Use pane settings for independent index-percent, 10Y-basis-point and VIX-point stress shifts. Existing saved Analytics panes keep Overview until their View setting changes to Risk depth. Performance, Brinson attribution and imported option Greeks use the versioned local JSON schema in [research data](research-data.md#local-account-evidence); the pane does not derive account cashflows from current holdings. Evidence remains private and must match the portfolio ID and currency.

```sh
gloomberb fn PORT main --json
gloomberb fn MARS main --view factors --json
gloomberb fn PORT main --view stress --equity-shift -15 --rate-shift 100 --vol-shift 10
gloomberb shot PORT main --width 1100 --height 620 --output portfolio-risk.png
```

`--evidence` accepts the same JSON text as the clipboard import. Account-return and attribution examples in the methodology are illustrative inputs, not sample market data. A report includes raw values, source dates, percentile coverage, holdings, factor regressions and warnings; screenshots freeze that same local model.

## Equity criteria screener

`EQS` screens the stored Cloud equity universe. It starts with USD companies above
$10 billion in market capitalization. **Criteria** edits typed numeric ranges,
category lists and available/unavailable data conditions. All criteria are ANDed.
Thresholds accept `k`, `M`, `B` and `T` suffixes, so `10B` is ten billion. The
currency selector is required for price and market-cap comparisons.

**Results** leads with the chosen metric, its covered-universe percentile and its
date, then one column per numeric criterion and context columns (market cap, price,
change, P/E, revenue growth, operating margin, dividend yield) as width allows. Click
a metric header to sort by it and make it the focus; click again to reverse. Dates in
the muted colour are collection dates for provider values that carry no observation
date. The footer shows matches, covered listings, currency and the snapshot time.
Enter opens a company's dated observations; `o` opens it in Ticker Research.

`s` saves a named screen to your Cloud account; **Saved** restores one. Saving an
existing screen updates its revision; **Save copy** creates another. Conflicting
edits from another device are reported. `x` exports all matches from the displayed
snapshot, up to 5,000 rows. The normal pane CSV menu exports currently loaded rows.
Expired snapshots ask for a refresh before continuing or exporting.

`gloomberb fn EQS --metric trailingPE --json` returns the first page with its
snapshot, coverage, per-field dates and pagination cursor. `--definition` accepts
versioned JSON with `criteria`, `currency` and `sort`, for example:

```sh
gloomberb fn EQS --definition '{"version":1,"currency":"USD","criteria":[{"field":"trailingPE","op":"between","value":[0,25]},{"field":"revenueGrowthPercent","op":"gte","value":10}],"sort":{"field":"marketCap","direction":"desc"}}' --json
```

## Backtest

`BT AAPL` (or `BTST AAPL`) tests a long-only rule on the ticker's daily history
against buy-and-hold. **Strategy** picks a preset: golden cross (50/200), above
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
