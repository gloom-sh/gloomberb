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
| `OVDV <ticker>` | Rotatable implied-volatility surface, smiles, term structure, skew and forwards |
| `HVG <ticker>` | Realized volatility by estimator and window, price, and current ATM IV |
| `HVT <ticker>` | Volatility cone, current estimates and historical percentiles |
| `OVME` | Black-Scholes option calculator with Greeks and implied volatility |
| `HDS <ticker>` | Institutional holders |
| `DVD <ticker>` | Dividend yield and history |
| `SI <ticker>` | Short interest |
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
| `FLOW` | Unusual options activity: sweeps, blocks, and large premium |
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
| `FUT` | Futures quote aliases across index, rates, energy, metals, grains, and FX |
| `ECO` | Economic events and releases |
| `ECST [statistic]` | Economic statistics: inflation, labour, growth, consumer, housing, rates |
| `GC [YYYY-MM-DD]` | Treasury yield curve for the latest session or a historical date; CLI also accepts `--date YYYY-MM-DD` |
| `WIRP` / `FFIP` | Fed funds futures implied FOMC path, conditional target probabilities, SOFR contracts and Fed projections |
| `BTMM` | Money markets: funding rates, Treasury bill curves and Federal Reserve liquidity |
| `AUCT` | Treasury auction results: high rate, bid-to-cover, indirect share, and size |
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

`FUT` keeps each rolling quote alias as its symbol and displays the provider's contract name when available. Search also matches that name. A month in this label describes the captured quote; the app does not derive an expiry date or establish the roll-adjustment basis of the alias's historical series.

`BTMM` opens Rates, Bills and Liquidity views. Select a row and press Enter or click it for its dated history, one-year range and source; Back returns to the board. The Bills curve compares common-date discount yields with one week, one month and one year earlier. Liquidity plots the net-liquidity proxy above the component board. `h` and `l` switch views; `o` opens the selected FRED series and `r` refreshes. Reports support `gloomberb fn BTMM --tab rates|bills|liquidity` and `--json`.

### Workspace and App Controls

| Shortcut | Function |
|----------|----------|
| `PF` | Portfolio and watchlist workspace |
| `PORT` | Portfolio risk and sector exposure |
| `ALRT` | Price alerts |
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

## CLI

Running `gloomberb` with no arguments launches the terminal UI. Normal commands run through a headless CLI path; use `gloomberb launch-ui` when a script should explicitly open the UI.

Human-readable output is the default. Automation can opt into structured output with `--json`, `--csv`, or `--ndjson`. JSON output favors the richest fetched model available and includes display-column metadata when a command has table columns; CSV and NDJSON use the command's tabular row view. Common global flags include `--limit`, `--refresh`, `--quiet`, `--no-color`, `--dry-run`, and `--yes`.

Headless chart text includes a Unit column when a series supplies one; values keep that unit's scale (for example, `2.7 %` versus `270 bp`). DVD text labels cash growth, CAGR and earnings payout as percentages, while their structured `value` fields remain fractional ratios (`0.03` means 3%). `fn --csv` preserves the report fields and encodes nested sections or series as JSON cells, retaining raw numeric values alongside any separate display strings; it does not flatten or rescale those observations.

In short DVD panes, the summary scrolls separately so cash history stays visible. Page Up/Down scroll the summary; arrows or j/k navigate history. The mouse wheel scrolls the region under the pointer.

| Command | Use |
|---------|-----|
| `gloomberb` | Launch the terminal UI |
| `gloomberb launch-ui` | Explicitly launch the terminal UI |
| `gloomberb help` | Show all CLI commands |
| `gloomberb api list\|get\|invoke\|subscribe` | Inspect and call plugin capabilities directly |
| `gloomberb quote <symbols>` | Fetch current quotes |
| `gloomberb search <query>` / `provider-search <query>` | Search tickers and provider symbols |
| `gloomberb ticker <symbol>` | Show quote, ownership, and financials |
| `gloomberb history\|financials\|fundamentals\|options <symbol>` | Fetch research data |
| `gloomberb news\|filings\|holders\|insider\|13f\|analyst\|events\|valuation <symbol>` | Fetch company research feeds |
| `gloomberb movers\|indices\|sectors\|fx\|earnings` | Fetch market overview data |
| `gloomberb econ\|fred\|yield-curve` | Fetch macro data |
| `gloomberb compare\|correlation\|relationship <symbols>` | Compare securities |
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
