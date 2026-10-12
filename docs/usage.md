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
- [Importing a manager's 13F as a portfolio](#importing-a-managers-13f-as-a-portfolio)
- [Cash, target weights and rebalancing](#cash-target-weights-and-rebalancing)
- [Broker position sync](#broker-position-sync)
- [Gloom Cloud sign-in](#gloom-cloud-sign-in)
- [Connect an AI assistant (MCP)](#connect-an-ai-assistant-mcp)
- [Debt maturities](#debt-maturities)
- [Theses](#theses)
- [Interface language](#localized-interface)
- [Built-in plugins](#built-in-plugins)
- [Live TV](#live-tv)
- [Options scenarios](#options-scenarios)
- [Option valuation models](#option-valuation-models)
- [Relative rotation](#relative-rotation)
- [Position sizing: KELLY](#position-sizing-kelly)
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
| `Ctrl+Shift+N` | Move the focused pane to a new layout of its own; again to move it back |
| `Ctrl+Shift+E` | Export focused pane table as CSV |
| `Cmd/Ctrl+Shift+S` | Share the focused pane: post to chat or copy link |
| `Ctrl+Shift+L` | Layout actions |
| `Ctrl+Shift+G` | Tidy windows |
| `Alt+A` | Ask Gloom about the focused pane, in a new conversation with the pane attached |
| `Tab` | Switch panes |
| `j` / `k` | Navigate lists |
| `Home` / `End`, `PageUp` / `PageDown` | Jump through lists and tables |
| `Enter` / `Esc` | Open the selected row / go back |
| `/` | Search in the focused pane |
| `h` / `l` | Switch tabs |
| `<` / `>` | Narrow or widen a pane's sidebar, such as the list beside the map (the footer names them; the divider also drags) |
| `Ctrl+Left` / `Ctrl+Right` | Scroll a focused table horizontally |
| `m` | Cycle chart mode |
| `Alt+Enter` | Run the newest notification's action, such as Revert or Review |
| `Alt+Backspace` | Dismiss the newest notification |
| `q` | Quit (terminal) |

Desktop builds also accept `Cmd/Ctrl+K` for the command bar, the matching `Cmd` shortcuts on macOS, `Cmd/Ctrl+Shift+O` to pop out a pane, `Cmd/Ctrl+Shift+C` to copy a focused pane screenshot, `Cmd/Ctrl+Shift+A` to ask Gloom about the focused pane, and `Cmd/Ctrl+Shift+Enter` / `Cmd/Ctrl+Shift+Backspace` for notifications.

The focused pane's footer shows its actions with their keys, such as `[a]dd`, and every one of them works from the keyboard. The pane menu (`.`, or the `...` button) lists them all, including any a narrow footer cuts off, followed by what the pane's table, filters and tabs offer (sort by a column, change a filter, close a tab), its quick toggles, and the pane and window actions. A retry or sign-in button in an empty pane answers `Enter`. In dialogs, `Enter` confirms and `Esc` closes; on the desktop `Tab` moves between a dialog's controls. A command that needs values or a confirmation (New Portfolio, Add Alert, Delete Watchlist) opens it as a centered dialog once the command bar closes: `Tab` and the arrows move between fields, `Enter` goes to the next field and sends the form from the last one, `Cmd/Ctrl+S` sends it from any field, and `y` or `n` answers a confirm. In pane settings the arrows move between settings, `Left` / `Right` change a choice or a toggle in place, and `Enter` opens a field's editor.

A pane that shows one ticker, such as a price chart (`GP`, `GIP`), `OMON`, `OPX`, `SEAS`, `FA` or company news, can follow a watchlist, portfolio or scanner the way the research pane does: choose **Link to** and the list's name in its pane menu, and it moves with that list's selection, titled for example `OPX NVDA  ⧉ Linked to Watchlist`. It can follow another single-ticker pane the same way (**Link to Ticker Research AAPL**, **Link to OVDV SPY**), so a desk of option panes moves with one research pane; a pane that already follows this one, directly or through others, is not offered. **Unlink from** keeps the ticker it shows, and closing the list does the same; if the list was empty, a linked `OMON`, `CN`, `FA`, `HP`, `SEC`, `INS`, `HDS`, `ANR`, `EVT` or `EE` pane has no ticker to keep and closes with it. Typing `OPX AAPL` while a linked OPX is open opens a separate pane rather than unlinking it. A linked chart saves its spec each time the selection moves, so its range and studies carry over.

**Move to New Layout** (`Ctrl+Shift+N`, `Cmd+Shift+N` in the desktop app on macOS, also in the pane menu and the command bar) takes the focused pane, docked or floating, out of its layout into a new layout tab named after it, such as `Chart: NVDA`, where it fills the window, and switches to it. The pane moves as it is, with its ticker, tab, settings and lock. The layout it left closes the gap. A pane that followed a list keeps the ticker it showed, and panes that followed the moved one keep theirs. **Move Back to** and the layout's name in the pane menu, or the same shortcut while the pane is alone, returns it to its place in that layout, links it again and removes the layout it leaves empty; if that layout was deleted, it docks in the first other tab. A layout's only pane has nothing to move out of. In the browser, `Ctrl+Shift+N` opens a private window instead, so use the pane menu there.

Drag the line between docked panes to resize them, and a floating pane's bottom-right corner to resize it; on the desktop and the web, any edge or corner of a floating pane works too. There the panes and what they show follow the pointer as you drag: tables and heat maps lay out at the new size, and a chart stretches with its pane and redraws sharp a few times a second and when you let go.

### Docs inside the app

The `?` beside a pane's `...` opens that pane's entry in `DOCS`, the gloom.sh docs and Academy lessons read in a pane: what the function is, an example, and the lesson that teaches it. Links between pages stay in the reader and `Esc` goes back. `DOCS` alone searches every function, page and lesson; `DOCS OMON` opens one entry. From the keyboard, `F1` opens the focused pane's help card and `Enter` reads its docs; **Docs** in the pane menu does the same. `o` opens the page on gloom.sh in your browser. The app ships a copy of the docs and keeps the last one it read, so they read offline; a lesson is kept once it has been opened. A popped-out desktop window cannot open a pane, so there the `?` shows the help card.

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

A symbol that trades in several places lists its exchanges after a colon: `NET:` shows each one, your saved listing first and the rest in search order. The list reads as many search rows as the CLI does, so a symbol several companies use lists them all: `CAR:` offers CAR Group on ASX as well as Avis and Carrefour. Letters after the colon narrow the list (`NET:L` keeps exchanges whose name or code starts with L), and `NET:XLON` names one listing.

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
| `EVTS [ticker]` | The market's report days with implied and average moves; a ticker selects its row, and its report says whether the ticker is on the board and points to `ERN <ticker>` for its own dates |
| `SRCH [query]` | Full-text search across earnings call transcripts, news, and SEC filings |
| `CALLS [ticker]` | Earnings call transcripts; alone, every transcribed call |
| `JOBS [ticker]` | Hiring from the company's careers system; alone, every covered company |
| `QQ <tickers>` | Ticker quote monitor |
| `CMP <tickers>` | Normalized price comparison |
| `CORR <tickers>` | Ticker return correlations; `GEO:<name>` adds a map series, for example `CORR FRO, STNG, GEO:HORMUZ` |
| `ANR <ticker>` | Analyst targets and ratings |
| `DIAG <ticker>` | Equity Diagnostic with cited flags and anomalies |
| `SEC <ticker>` | SEC filings and company disclosures |
| `OMON <ticker>` | Options chain, expected moves, 25-delta skew and adjacent-expiry term slope. **Strikes** in the bar lists every strike, a count either side of the money, or a call or put delta band ([method](research-data.md#omon-strike-window-and-carry)) |
| `OVDV <ticker>` | Rotatable 3D implied-volatility surface by delta or moneyness, smiles, term structure, skew and forwards |
| `OPX [ticker]` / `GEX [ticker]` | Open interest by strike and expiry with max pain, and dealer gamma by strike with its flip level; `GEX` opens on the gamma tab, `MAXPAIN` is `OPX`. SPY with no ticker ([method](options-positioning.md)) |
| `HVG <ticker>` | Realized volatility by estimator and window, price, and current ATM IV |
| `HVT <ticker>` | Volatility cone, current estimates and historical percentiles |
| `SEAS <ticker>` | Seasonality: monthly returns by year, each month's average and hit rate, year overlays, and returns by weekday and around the turn of the month |
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

The Overview headline is the regular session: after the close it stays at the official close and its move from the previous close, and the After-Hours line under it is the latest extended-hours price and its move from that close, the only figure that changes until the next pre-market. In the pre-market the headline is the last session's close and its move from the session before, held, and the Pre-Market line is the only figure that changes, measured from that close; a quote that does not carry that move keeps the live price and its move from the previous close in the headline. `gloomberb ticker` reports the quote the same way, and so do the `QQ` cards, whose extended line under the symbol reads `AH` or `PM` where the card is narrow. `gloomberb quote`, `gloomberb compare` and `gloomberb fn QQ` give the extended print an After Hours or Pre-Market column when a row has one, and `compare`'s Prev Close is the close the headline's move is measured from. In their `--json`, `price`, `change` and `changePercent` are the headline and `extendedSession` (`PRE` or `POST`), `extendedPrice`, `extendedChange` and `extendedChangePercent` the extended print, null without one; `quote` and `compare` put them beside each quote as the source sent it, and `ticker` in its `quote`.

The market boards follow the same rule, so after the close and through a weekend their Last and change agree with `gloomberb ticker`. `gloomberb sectors`, `indices` and `movers` (every list), and `fn BI`, `fn WEI` and `fn MOST`, give an extended print an After Hours or Pre-Market column (price and move from the close) when a row has one, and add the four `extended` fields to each row of their `--json`. Gainers, Losers and Most Active still pick and order their names by the latest print, extended hours included. The `BI` and `MOST` panes show that move in an `AFTER-HRS` or `PRE-MKT` column after 1D or CHG% while a row has one; a narrow `BI` pane gives up the move bar and then that column before it cuts a sector's name, and a narrow `MOST` pane gives up MCAP and then 52W% first. In `BI` and on `MOST`'s lists a tick after the close moves only that column, and a pre-market tick leaves `BI` on the completed session it ranks. `MOST`'s Pre-market, After hours and Gaps lists are the session's own movers and keep that session's print as Last. `WEI`, `FUT` and the `GPU` equities board show the regular session and no extended column. The header's SPY is the regular close and its move once the market is closed; while the pre-market or after-hours session is open it is that session's price and its move from the close, beside the `PRE-MKT` or `AFTER-HRS` label.

`THEM` reads its members the same way. Outside the regular session a member's Price and 1D are the last regular close and its move, as `gloomberb ticker` gives them, its 1W, 1M, 3M and YTD end at that close, and each theme's returns, breadth and best and worst 1D are taken from those figures. A pre-market or after-hours print and its move from the close get a `PRE-MKT` or `AFTER-HRS` column after 1D in an open theme, and a Pre-Market or After Hours column (price and move) in `gloomberb fn THEM <theme>`, and never enter a return or a theme figure; a narrow pane gives up 3M, YTD, 1M and 1W before that column. The footer then names the close and how old the snapshot is, `Fri 9 Oct close · snapshot 12m ago`, and the report is as of that close. In `--json` the report's `metadata.asOf` is that close, `snapshotAssembledAt` and `snapshotAgeMinutes` give the snapshot's time and age, `regularSessionDate` the session, and each member adds `extendedSession`, `extendedPrice`, `extendedChange` and `extendedChangePercent`. While the session trades the board reads as before.

`gloomberb portfolio show` and `watchlist show` read the quote as the `PF` pane does: Last and Chg are the regular close and its move after the close, with an After Hours or Pre-Market column (price and move from that close) when a holding has one. The portfolio's `--json` puts that Last in `quotePrice` and adds `extendedSession`, `extendedPrice`, `extendedChange` and `extendedChangePercent`; `fn PF` reports `price` and `changePercent` the same way, for a portfolio or a watchlist. Value and P&L are priced at the latest print unless you ask for the regular close; see [What a portfolio is priced at](#what-a-portfolio-is-priced-at). In a narrow terminal `portfolio show` drops Avg Cost, then the extended column, before Chg.

`watchlist show --csv` and `--json` print one row per ticker instead of the table: `symbol`, `listing`, `name`, `exchange`, `kind`, `currency`, `price`, `change`, `changePercent`, the four `extended` fields, `volume`, `fundingRate8h` (only when the list holds perpetual markets), `marketCap` (in your base currency, named in `marketCapCurrency`) and `quoteAsOf`, as raw numbers. A portfolio's rows carry `listing`, `name`, `quoteChange`, `quoteChangePercent` and `volume` as well. Mkt Cap is the figure the watchlist pane's MCAP column shows: the quote's when it has one, else the listing's fundamentals, repriced at the live price. Funds and indices have none, a quote that reports a market cap of 0 (a price on a crypto venue, such as Brent) reads as none, and a note under the table names them and any company whose figure is unavailable. A list that holds a perpetual market adds a Fund 8H column, its funding per eight hours as `quote` prints it; a row that is not a perpetual, or whose market cannot be read, shows a dash. A list without one has no such column. An option saved from search has no name of its own in `--json`: it is named by its terms, such as `AAPL Dec 18 '26 $300 Call`.

Earnings-call data exports and fiscal-quarter lookup inspect at most the latest 200 calls in the requested scope; the interactive list loads 50. The server does not supply a total or a `hasMore` marker. When a response fills its source limit, exports report `sourceLimitReached: true`, `complete: false`, and `truncated: true`: additional calls may exist. `total` counts matching loaded calls; `totalIsExact: false` marks capped, pending, or stale results. A missing quarter in a capped lookup is not proof that the company has no such call. Pending discovery remains pending when reopening or refreshing the pane. Full-text documents can be read and searched without structured turns, but Q&A requires source segmentation.

The ticker research `13F` tab shows fund positions for the ticker, reported value, shares, weight and quarter action; open a row for its fund detail and scroll to page more funds. The `13F` pane's Crowding tab ranks new positions, exits, and weight increases or decreases across the top 25 ranked funds. `m` or the Mine filter limits positions to portfolio and watchlist tickers. CLI equivalents: `gloomberb fn 13F AAPL --view=ticker-holdings --offset=0 --json` (a ticker argument defaults to this view; `--view=by-ticker` lists the holders' whole 13F books) and `gloomberb fn 13F --view=crowding --json`. The text report opens with the quarters compared, the holder, new and exited counts, and, when the list is longer than `--limit`, which funds are shown and the `--offset` that continues it; `--json` carries the same as `shown`, `total`, `truncated` and `nextOffset`. Values are as reported at the period end, not at today's price. With a ticker, `gloomberb fn 13F MU --view=crowding` shows that ticker's rank in the crowding sample, or says it is not in it.

`HDS` has three tabs: Table and Chart show the 13F institutional holders (on a home line abroad such as `BHP:LSE`, values are in the currency the report names and a row held as US depositary receipts carries an `ADR` badge), and 13D/G shows who disclosed more than 5% of the class on Schedule 13D (activists) or 13G (passive holders) in the last four years, one row per filer, named by the reporting person whose stake it shows with `+N` for the other reporting persons on the report: the form of its latest report, the percent of class as that report filed it (with `about 49.4% on 35.26M sh today` beneath when the company's share count has moved since), the change in points against its previous report, shares, event and filing dates, and its latest 13F move in the ticker (NEW, the share change, EXIT, or a dash when unknown). The latest report is the filer's latest disclosure, not its position today. A stake reported under 5% keeps its percentage, marked `<5%` where the column has room, and sorts after the 5% holders with reports of zero, marked `EXIT`. Enter opens the filing in the SEC pane and `o` opens it on EDGAR. CLI equivalents: `gloomberb holders CAR --form all` (`13d` or `13g` for one kind, `--history` for every report instead of the latest per filer) and `gloomberb fn HDS CAR --form all --json`; `gloomberb filings CAR --form 13G` lists the filings themselves.

In a 13F fund detail, open Overlap, search a second fund by name or CIK, and select it to compare shared positions and weights. Back returns to the fund picker. The Performance list includes three prior-quarter estimates when available. Headless crowding accepts `--rank=new`, `--rank=exits`, `--rank=increases` or `--rank=decreases`. CLI overlap: `gloomberb fn 13F 0001067983 --compare=0001037389 --json` (`--compare` implies `--view=overlap`, and says so).

`--compare` also takes an ETF ticker: `gloomberb fn 13F 0001067983 --compare SPY` compares the manager's latest 13F with the ETF's holdings file, the one `fn MEMB SPY` shows, and prints the overlap, the active share, the quarter compared with its filing date, the holdings file's date, and the manager's positions the ETF does not hold, largest first. A word that reads as a ticker (up to five letters, with an optional class such as `BRK.B`) is an ETF when MEMB covers it, otherwise a manager only by its exact name; it is never matched to a manager by part of a name, so `SPY` is not Spyglass Capital. MEMB covers IVV (also read for SPY and SPX), IJH, IJR, IWM and IWB; any other ticker, such as `VTV`, fails with that list. A CIK or a longer name is a manager lookup as before, and the report says which was used. `--view=overlap` without `--compare` asks for it; `--compare` with another view fails, and `--rank` or `--offset` with a view that does not use them is named as ignored.

### Chart Composer

`G`, `GP`, `GIP`, `CMP`, `GF`, and `GE` all open the same chart composer with different starting presets. `CAT` opens the data catalog: every series a chart can draw, so you can graph one without typing the expression. Its tabs group the series (securities and options fields, crypto, futures, rates and government bonds, credit spreads and CDS, economic data, inflation, FX, energy inventories, volatility, Fear & Greed, positioning such as COT and short interest, valuation, alternative data, and your own files), and each row gives the unit, how often the series updates, the official publisher for public data, and the expression to type. Search matches every word across those columns; typing a ticker such as `AAPL` fills in every series that takes one (its price and fields, implied volatility, short interest, CDS spread, debt maturities). `g` charts the selected row, asking for a ticker first when the series needs one. The composer's Series search finds the same entries, so any of them can be drawn against any other. Series from Pro datasets (research attention, hiring, app attention, GPU rental indexes, government awards, perpetuals) need Pro; without it the chart says so in place of the line. A custom expression can mix unrelated data sources on one synchronized timeline:

```text
G AAPL:price, MSFT:revenue, FRED:CPIAUCSL
```

#### Your own series

Put a CSV file in the `series` folder of your data folder (`~/.gloomberb/series`, or wherever `gloomberb version` says the data directory is) and it appears in the catalog's **Your series** tab the next time the catalog opens, chartable against anything else. The first column is the date (`2024-03-01`, `2024-03`, `2024` or an ISO date and time), each further column is a series, and an optional header row names them. Lines starting with `#` above the data set what the catalog shows:

```text
# name: Shipping index
# unit: index
# frequency: weekly
date,value
2024-01-05,1234.5
2024-01-12,1251
```

Without them the file name names the series, the unit is a plain number and the frequency is read off the dates. `unit` takes the same values plugin series use (`%`, `bp`, `index`, `USD`, `billion USD`, `thousand barrels/day` and so on). Commas, semicolons and tabs all work as separators, and an empty or `.` cell is a missing value. Each chart reads the file again, so an edit shows on the next load. Files are read by the terminal and by the desktop app; the web app has no file access.

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
| `MAP` | World map with trading venues, country names and layers (`MAP venues` for venues alone) |
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
| `ECO` | Economic events and releases, grouped by day and timed in UTC |
| `ECST [statistic]` | Economic statistics: inflation, labour, growth, consumer, housing, rates; `fn ECST` prints the 2s10s spread in bp and takes `--range 5Y|20Y|ALL` for the window of its percentiles, highs and lows |
| `GC [curve] [YYYY-MM-DD]` | Government yield curves (UST, TIPS real, breakeven, euro AAA, Bund, Gilt, JGB, Canada) with spreads and percentiles, a compare date, the one-year-forward curve and a World tab; CLI also accepts `--curve`, `--date`, `--compare 1D` (or 1W, 1M, 3M, 1Y, or a date) and `--tab world`; the table carries each tenor's 1D move in bp, and with `--compare` both curves and the difference in bp |
| `WIRP` / `FFIP` | Fed funds futures implied FOMC path, conditional target probabilities, SOFR contracts and Fed projections |
| `BTMM` | Money markets: funding rates, Treasury bill curves and Federal Reserve liquidity |
| `YAS` | Fixed-coupon bond calculator: price/yield, accrued interest, duration, convexity, DV01 and Treasury spread |
| `CBR` / `ECFC` / `CBRT` | G20 central bank policy rates, last observed moves and one-year history |
| `CTM [root]` | Futures contract curve, historical ghosts, roll yield and open interest, including `CTM VX` and CME crypto (`CTM BTC`, which adds each contract's premium to spot and annualised basis) |
| `COT [code or root]` / `CFTC [code or root]` | CFTC positioning extremes, weekly changes and historical percentiles, including CME crypto (`COT BTC`) |
| `AUCT [search]` | Treasury auction results: auction rate (a TIPS rate is a real yield and an FRN's a spread in bp, marked in the CLI text), stop-out versus average, bid-to-cover, indirect, direct and dealer takedown, and size. Search by type, benchmark (`AUCT 10Y` finds the 10-year note and its reopenings), term, CUSIP or date; windows reach back 10 years (`--historyDays 3650`) |
| `VIX` | VIX 9D through 1Y cash-tenor curve, FRED history and 3M/30D ratio |
| `VOLS` | Cross-asset volatility indices, daily changes and one-year percentiles |
| `CRD` | Credit spreads |
| `VAL [indicator]` | Whole-market valuation: Buffett, CAPE, excess CAPE yield, Tobin Q, investor equity allocation, dividend yield, margin debt, cap/profits, cap/M2 |
| `CDS [ticker]` | Single-name corporate CDS. With no argument, the issuers traded in the last 5 days, most active first, with each one's 5Y spread to rank them by; with a ticker or issuer, its 5Y spread (level, date, 1M change, range), history and trades. `fn CDS F --csv` carries the same figures |
| `EVTS` | The market's earnings days, implied against past moves |
| `IPO` | Upcoming and recent IPOs worldwide |
| `HALT` | US trading halts with reason and resumption times |
| `DIST` | Distress records: 8-K bankruptcy, obligation and listing filings, going-concern disclosures, Taiwan listing designations, French and UK insolvency notices (the M&A pane on its Distress tab; [details](distress-monitor.md)) |
| `TV` | Live business news television ([TV plugin](https://github.com/gloom-sh/gloom-tv)) |
| `BI` | S&P 500 sector performance |
| `THEM [theme]` | Thematic baskets with equal-weight returns and breadth, and each theme's members (the Themes tab of `BI`) |
| `MEMB <fund>` | ETF holdings with weights, member returns, daily contributions and index changes |
| `FXC` | FX cross rates: the majors, or up to 45 currencies (`gloomberb fn FXC --currencies USD,ZAR,NGN`; `gloomberb catalog FXC` lists the codes) |
| `FNG` | Fear and greed market gauge |

`HM` sizes each stock by the square root of its market cap, so mid-size names have room next to the largest, and colors it by the day's move in the theme's own colors: from a muted tone near flat to the theme's down color for losses and its up color for gains, at full strength by 3%, with dark or light text, whichever reads better on the tile. A name with no move yet is a quieter grey. Switching themes recolors the map at once. **Size by** in its settings, also the `√` button beside the title on every tab but a portfolio's, switches to plain market cap, where the largest names dominate; either way a sector's block is the sum of its tiles, and the tooltip and footer show the real market cap. ETFs follow the same choice with their net assets. **US Stocks** groups the 500 largest US stocks into sector blocks, largest top left, and each sector into industries; an industry is labeled only where its block has room, and a one-name industry never. Names too small to draw, and the few without a sector, sit together in **Other** at the bottom right. A big tile shows its ticker over the move, a smaller one its ticker, the smallest only its color; on the desktop and the web, a tall tile too narrow for its ticker runs it up the tile, and hovering a tile shows its name, move, price, market cap and volume, and the footer shows the selected tile's. With **Live streaming** on, colors follow the quote stream: the largest names stream first, as many as the account's connection allows, real-time with Pro and delayed otherwise, and the footer says which (`live`, `mixed` or `polling`). In the pre-market and after hours a streaming name shows that session's move from the regular close, marked `PM` or `AH` after the move where the tile has room and always in the tooltip and footer; a name that has not traded in that session yet keeps the regular session's close and move, unmarked, so `0.0% AH` is a real trade at the close. Once the after-hours session ends every name shows the regular session's move again. Names outside the stream follow the snapshot, refreshed each minute, which also brings fresh market caps; outside the regular session the snapshot is the last completed session's close and its move, shown without a mark; in between, a streaming name's tile grows and shrinks with its price. Sizes relayout at most every five seconds and only when a tile would visibly change, and tiles keep their places through small changes. On the desktop and the web colors fade and tiles glide; with reduced motion set in the system, they change at once. **US ETFs** is the same map without sectors.

**Colour by** in the `HM` settings picks the session the tiles show. **Active session**, the default, follows the pre-market and after hours as above. **Regular session** never shows extended trading: while the regular session trades a tile follows its quote, and once it is over it keeps that session's close and move, with or without streaming, until the next session opens. A name whose quote cannot say which session's close it has keeps the snapshot's, and a name the snapshot has no dated close for shows no move rather than an after-hours print or a flat one. **Names** draws the largest 100, 150 or 500 names (the default) on US Stocks, and up to 160 on US ETFs; at 500 a terminal-sized pane leaves most of them in **Other**. The footer says what the board on screen is: `top 500 · Oct 9 session · as of 16:00 ET · checked 2m ago` is how many names it covers, the completed session it shows outside the regular session, that session's close in New York time (13:00 on an early close), and when the app last got it. While the regular session trades the footer gives when the server put the snapshot together instead, `top 500 · snapshot 11:06 ET`, dated when that is another day; that time does not move while the server hands back the same snapshot, and the check time does. A refresh that fails says `refresh failed` and keeps the rest, and the count stays the board's own until a board for a new **Names** arrives.

`gloomberb fn HM` reports the map by sector from the same snapshot the pane starts from: each sector's names, total market cap and share of the board, its day move weighted by market cap, how many names rose and fell, and its best and worst name. `--group industry` breaks it down by industry within each sector, `--universe us-etf` summarizes the ETF board as one group weighted by net assets, and `--json` adds the whole board's figures in `data.metadata.board`. Moves are weighted by market cap, not by the square-root tile area; a name with no move yet counts toward its group's size but not its move or breadth, and is named in a notice above the table and in `data.metadata.noMove`. The report does not include the moves the pane streams on top of the snapshot.

`HM` has a third tab, named for the list open in the portfolio pane (`PF`): the one last focused when there are several, your first portfolio when none is open. It sizes a portfolio's holdings by market value in the portfolio's currency, as `PF` shows it, whatever **Size by** says, and a watchlist's names by the square root of their market cap in your base currency, or plain market cap with **Size by**; tiles are colored by the day's move, or, with **Colour by** on the active session, that session's in the pre-market and after hours, and grouped by sector when the list's tickers have one. A name without a position, quote, market cap or exchange rate gets the smallest tile and no figure, and past 160 names the smallest are left out, which the footer says. **Link to portfolio** in its settings switches the heatmap to that tab whenever the portfolio pane changes list. `3` opens the tab, and `[` / `]` step through all three.

An open theme in `THEM` and the Members tab of `MEMB` add two entries to the pane menu (`.`). **Open Members In…** opens the members, in the order the list shows them, in `RRG` (up to 24), `CORR` (2 to 10), `SIW` (up to 60) or `RIPL` (up to 10); a function whose plugin is turned off is not offered. **Save as Watchlist…** asks for a name and saves the first 100 members to a new watchlist. A `MEMB` search narrows both to the holdings it matches.

News rows credit the article's publisher and open its original URL. The managed
news feed includes only articles whose publisher and original link can be
verified. Custom RSS and Atom feeds use each item's source when supplied,
falling back to the name you configured for a direct publisher's feed.

A story opened from `SRCH` or a news pane is set for reading: the headline,
its source and time, the tickers it names as chips (click one, or `t`), then
the opening paragraph a size up. A `SRCH` story leaves out the page it was
taken from (share buttons, "News provided by", cookie and newsletter lines,
the headline and date printed again, the wire's dateline), breaks a long
block into paragraphs between sentences, and sets rows of figures as a
table. A long story lists up to three of its own sentences that carry a
figure and a move under **Key facts**, and shows about a screen with the
rest behind **Read more**. Nothing is reworded: every line is the story's
own. Space and Shift+Space page, `]` and `[` jump between sections (or
paragraphs), `n` and `p` open the next and previous result, and **Show
Original Text** in the pane menu (`.`) shows the text as it was indexed.
Calls and filings keep their text as written, under each speaker or
section, and still open where the search matched.

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

`FUT` keeps each rolling quote alias as its symbol and displays the provider's contract name when available. Search also matches that name. `FUT TTF` (`gloomberb fn FUT TTF`, `shot FUT TTF`) opens the board searched for that contract; any other text searches the board as typed. A month in this label describes the captured quote; the app does not derive an expiry date or establish the roll-adjustment basis of the alias's historical series.

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
| `AW` / `AP <ticker>` | Add a ticker to the active watchlist or portfolio; `AW` also takes a pasted list of tickers |
| `RW` / `RP <ticker>` | Remove a ticker from the active watchlist or portfolio |
| `PS` | Open focused pane settings |
| `LAY` | Open the layout browser to switch, publish, or add layouts |
| `DESK [desk]` | Add a ready-made desk as a new layout tab: equities, options, futures and commodities, rates and credit, FX and macro, or active trading |
| `LMA <query>` | Layout and pane arrangement actions |
| `WIN move\|resize` | Move or resize the focused window |
| `GL` | Tidy all windows |
| `SB` | Toggle the status bar |
| `VF` | Toggle quote value flashing |
| `TH <theme>` | Change color theme. The list shows each theme's id, the one `gloomberb config set theme <id>` takes; `gloomberb config themes` lists them, `colorblind`, `colorblind-light` and `high-contrast` included |
| `FONT+` / `FONT-` | Increase or decrease desktop font size |
| `CONN` | Connection health |
| `POLL` | Political polls from VoteHub ([Polls plugin](https://github.com/gloom-sh/gloom-polls)) |
| `UPGRADE` | Account upgrade |
| `MCP` | Connect Claude Code, Codex, Cursor or another MCP client to Gloom |
| `CR` | Cycle chart renderer |
| `LANG <locale>` | Change interface language (`auto`, `en`, `es`, `zh-CN`, `zh-TW`, `ja`, or `ko`) |
| `PL <plugin>` | Manage plugins |

**Toggle Presentation Mode** in the command bar leaves the window to the panes, for a screen that is shown rather than worked at: the header (command prompt and market summary) and the status bar (layout tabs, version, account and feedback) stay hidden until you toggle it again, and the pane fullscreen key (`Ctrl+Shift+F`, `Cmd+Shift+F` on a Mac) then fills the window with one pane. The command bar still opens on its shortcut and brings the header back while it is open. In the desktop app the header stays, since it is the window's title bar. It is saved as `"presentationMode": true` in the config.

In `PF`, `a` adds a ticker to the open manual portfolio or watchlist and `d` removes the selected one after a confirm. Removing it from a portfolio deletes its position there; its notes, alerts and other lists stay. Broker portfolios have no `d`, since the next sync would put the ticker back, and neither do team lists, which everyone on the team shares; `RW` and `RP` still edit a team list. In the add row, a symbol with a colon (`NET:`) opens that symbol's exchanges, and the one you pick joins the open portfolio or watchlist.

`gloomberb fn PF <portfolio-or-watchlist> --json` returns a portfolio's positions, broker or manual, valued as `gloomberb portfolio show` values them: shares, average cost, last price, market value and unrealized P&L in the portfolio's currency, weight of the total with cash (see [Cash, target weights and rebalancing](#cash-target-weights-and-rebalancing)) and when each row's price is from, largest first, then the cash line. `--close` values them at the regular close (see [What a portfolio is priced at](#what-a-portfolio-is-priced-at)). With target weights set, each row adds its target, drift and the trade that reaches it. `--limit` caps the rows (50 by default, at most 200); the totals always cover every position. Name the portfolio or watchlist by its ID or its name; without one it reads your first portfolio. A watchlist returns its tickers with their quotes.

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

`v` (view, also in the footer and the pane menu) opens what the selected row
follows, the same way on **Prices**, **Events** and **History**: a rule on a
security opens its `DES` (the one already open, if any), a perpetual rule
`PERP` on its market, an earnings date `ERN` for the company, a CPI or FOMC
alert `CPI` or `WIRP`, a catalyst rule `CATL` (on its company when it names
one), a Congress rule `CG`, a 13F rule `13F` on the fund, a news keyword with
no symbol `SRCH` on the keyword, options flow on your lists `FLOW`, and
breaking news with no symbol `FIRST`.

### Alerts before earnings, CPI and FOMC

To watch a position through a scheduled event, alert a number of days before
it. In `ALRT`, open **Events**, click **add event** (or run **Add Event Alert**)
and pick **Earnings date** with a US-listed symbol, or **Macro event** with the
CPI release or the FOMC decision, then the days before: 1 to 14, 1 by default.
From the shell:

```bash
gloomberb alerts add CRWV earnings --days 3
gloomberb alerts add CPI --days 1
gloomberb alerts add FOMC
```

The next date comes from what the app already shows: the earnings calendar
(`ERN`), the BLS release calendar behind `CPI` and the Fed meeting calendar
behind `WIRP`. A symbol with no upcoming earnings date, or an event with no
known next date, gets no alert. The **Events** tab and `gloomberb alerts list`
show each alert's next event date and its state. While the app runs it looks
the dates up every 15 minutes and notifies once when the lead time is reached
("CRWV earnings in 3 days, Mon, Nov 9"), counting calendar days in New York;
an app that was closed on that day notifies when it next runs, up to the event
day. The alert then reads **Alerted** until the event passes and arms itself
for the next date. Re-arm (`m`, or `gloomberb alerts rearm <id>`) sends it again
for the same event, and `gloomberb alerts delete <id>` removes it. Earnings
alerts also reach the phone app like the other market alerts; CPI and FOMC
alerts notify in the running app only.

## Live prices and refresh cadence

Prices come from one shared stream: a symbol shown in several panes is subscribed once. Rows on screen and the selected symbol update on every frame (about 10 per second); everything else about once a second. A pane covered by floating windows keeps its subscriptions at that slower rate and its refresh clocks rest until it is uncovered. Minimizing or hiding the app pauses streams and polling; the terminal always counts as visible. Plans that cap streamed symbols spend them on the rows in view.

What moves while you watch:

- Portfolios and watchlists: price, change, volume, market value, P&L and weight. MCAP, P/E, FWD P/E and DIV% are repriced from the live price when the per-share figure behind each (shares outstanding, EPS, forward EPS, dividend per share) is on the quote's currency basis; otherwise they keep the served value. 52W% counts today's range, and TARGET% uses the live price when the target is in the listing's currency. After the regular close, LAST, CHG and CHG% hold the official close and its move from the previous close while EXT% follows the extended-hours print from that close; market value, DAY and P&L keep the live price. In the pre-market the row holds the last session the same way when the quote carries its close and move, with EXT% the pre-market print from that close; otherwise LAST and EXT% are the pre-market print. `DES` uses the same rules. Broker account totals, Net Liq and P&L in the portfolio header and `PORT` move with the positions' quotes from the broker's last snapshot.
- `WEI`, `FUT`, `BI`/`SP`, `FXC`, `EQS` rows, `CRYP`, the header SPY chip and market state, and price alerts, which trigger on the tick that crosses. After the close `BI` and `MOST`'s lists hold the regular close as the portfolio does and only their extended-hours column moves; the header SPY follows an open pre-market or after-hours session, then holds the close (see [Company Research](#company-research)).
- Charts, including the research Chart tab: the forming bar takes each quote's high, low, close and volume, and settles to the source's bar shortly after it closes.
- `OMON`: Last, volume, IV and Greeks stream during the regular session; a real-time chain also reloads every 15 seconds. `OVDV` reloads a real-time surface every 15 seconds in session at the live spot; on desktop and web the 3D surface eases into its new shape. `HVG` re-reads its ATM IV every minute in session. `VOLS` and the `VIX` curve stream index levels; the rest re-read every 15 seconds in session.
- `CTM` and `WIRP` refresh delayed contract quotes every minute while Globex trades.

News panes refresh every two minutes while the app is visible. A hidden browser tab falls back to the configured refresh interval, which still feeds breaking-news notifications; the desktop app keeps two minutes while minimized. `VF` toggles value flashing: a changed price dims for 300 ms, each symbol on its own clock, at most once every 600 ms.

## CLI

Running `gloomberb` with no arguments launches the terminal UI. Normal commands run through a headless CLI path; use `gloomberb launch-ui` when a script should explicitly open the UI.

Human-readable output is the default: tables fit the terminal width, and a single result prints as aligned label and value lines. Piped text output keeps every cell whole. Automation can opt into structured output with `--json`, `--csv`, or `--ndjson`. JSON output favors the richest fetched model available and includes display-column metadata when a command has table columns; CSV and NDJSON use the command's tabular row view. Common global flags include `--limit`, `--tail`, `--width`, `--refresh`, `--quiet`, `--no-color`, `--dry-run`, and `--yes`.

Cboe's Treasury yield indices (`^IRX`, `^FVX`, `^TNX`, `^TYX`) are yields, so `quote` and `compare` print their level in percent (`5.24%`) and their change in basis points from the previous close (`+1.3bp`), under a `Chg` header; `--json` adds `unit` and `changeBasisPoints` to their rows and keeps the percent change.

`--width <n>` fits text tables, help and notes to n columns, in a terminal or piped (`gloomberb quote AAPL TSLA NVDA MSFT --width 80`). A table gives up its least useful columns first, then cuts long text: `quote` drops Updated, Feed and Cur, in that order, and `compare` drops Cur, Volume and Day Range, before either cuts a Name short; an `fn` report cuts its long text columns. Times, ids and numbers stay whole, and a table that still cannot fit prints whole instead of losing figures. Without `--width` a terminal's own width applies and piped output is not fitted. `shot` is the one command with its own `--width`, in pixels: the layout is 720 to 2400 wide and 360 to 1800 tall (`--height`), and the PNG is drawn at twice that size, so the default 1280 by 720 writes a 2560 by 1440 image. A fixed board that would not fit that height, such as `FUT`, grows without `--height` until every row shows (up to the 1800 limit); with `--height` it keeps the size asked for. A size outside those limits is drawn at the nearest one, and a warning (on stderr for text, under `warnings` in JSON) names the size asked for, the size used and the PNG it wrote: `--width 80 is below the 720 minimum, so the capture used 720 and the PNG is 1440 px wide.`

A symbol that no listing carries (a company name or a typo) ends in ``Not a ticker: APPLE. Try `gloomberb search Apple`.``, with your own spelling in the hint, on `quote`, `compare`, `history`, `ticker` and the `fn` reports. A timeout or outage keeps its own wording. A coin pair written the way crypto exchanges write it, `BTC/USD`, is the coin `BTC-USD`; a currency pair such as `EUR/USD` stays a currency pair. A listing whose quote stopped more than half a year ago says so under the table, with the date and the last price it shows: `TWTR: no longer trading since 2022-10-27 (last price $53.86)`. `watchlist add` and `portfolio add` refuse a symbol search no longer lists with the same line instead of `No ticker match`. `history`, `options`, `fn HIVG` and `fn VCA` (in the symbol's row) say `TWTR stopped trading 2022-10-27; no history or options served` instead of `Not a ticker`, and `search TWTR` lists it under No Longer Trading with its last date and price (`--json` adds `lastTraded`, `lastPrice` and `note` to that row).

A bare coin ticker that reads as a fund named for the coin says so on `quote`, `ticker`, `watchlist add`, `portfolio add`, `position set` and `target set`: `ETH is Grayscale Ethereum Staking Mini ETF, not ethereum. For ethereum use ETH-USD.` A coin ticker that several companies list, none of them the coin, ends its list of listings the same way (`SOL is Solvay SA, Washington H. Soul Pattinson and Company Limited or another company, not solana. For solana use SOL-USD.`). A company that only shares the letters (`LINK`, Interlink Electronics) and a listing named on purpose (`ETH:ARCA`, `--exchange ARCA`) get no note. `--json` carries it in `warnings`, in an error's `details`, and in each row's `hint` when an add takes several symbols.

A listing goes by the name its own quote gives, in every command: `quote`, `history`, `ticker`, `search` (for the symbol searched), `portfolio add`, `portfolio show`, `fn PF` and the PF pane. A portfolio or watchlist row shows its quote's name rather than the one saved when it was added, and an add, position or target change saves the quote's name on the row.

A US symbol that changed says so in one line. When the company that traded under it moved to another symbol and something else lists there now, `quote`, `compare`, `history`, `options`, `search`, `fn HIVG`, `fn VCA` (in the symbol's row), `watchlist add` and `portfolio add` print `FB now lists ProShares S&P 500 Dynamic Daily Buffer ETF; Meta Platforms trades as META (changed 2022-06-09)`, so FB's bars and figures read as the fund's; when nothing lists there any more, `FB changed to META on 2022-06-09`, and an add that finds no listing ends with that line too. A company that moved more than once is followed to where it trades now (`TRCH changed to MMAT on 2021-07-06, then to MMATQ on 2024-08-21`). The symbol a company renamed into (`META`, `XYZ`, `METV`) prints nothing extra: you got what you typed. Its `history` from before the change carries the company's bars under the old symbol and says so: `Includes FB-era bars: META was FB until 2022-06-09`. Neither does a symbol with no change on record, or a lookup Gloom Cloud does not answer quickly: the quote never waits for it. `--json` carries the change in each row's `tickerChange` (`kind`, `note`, `changes`, and for a company that moved `tradesAs`, `issuer` and `listed`), a renamed company's new symbol included, with `kind` `formerly` and the symbol it had before (`METV was META until 2022-01-31`). Lists of more than ten symbols skip the lookup. In the app, a watchlist or portfolio's add row says where a moved company trades now before you add its old symbol (`Meta Platforms trades as META`), and the notice after adding it, there or from the command bar, prints the whole line. The change history covers US listings from April 2017; earlier changes are not known.

A perpetual futures market works wherever a symbol is typed too, as a listing on its venue: `quote binance:BZUSDT`, `watchlist add Energy hyperliquid:xyz:BRENTOIL`, or the saved forms `BZUSDT:BINANCE` and `XYZ-BRENTOIL:HYPERLIQUID`. `search brent` lists the Brent contracts, and a perpetual row in a watchlist or portfolio opens `PERP` on its market. See [Perpetual markets](perpetuals.md#in-watchlists-quotes-and-search).

The FUT board's codes work wherever a symbol is typed: in `quote`, `history`, `ticker`, `alerts`, the watchlist and portfolio commands, and the command bar. A code no listed security uses (TTF, ZN, 6E) is its future, so `quote TTF` quotes `TTF=F`. A code a security also uses stays the security's (NG is NovaGold, CL Colgate, ZM Zoom); its future is the `=F` symbol (`quote NG=F`), `search NG` lists it right after the security, and when the security has no data the answer names the future to try. `search` and `catalog` say plainly when no source carries what was asked for, with the nearest listings that do: `search EUA` and `catalog carbon` answer `No EU carbon price (EUA) yet. Proxies: CO2:LSE, KRBN.`

`--limit <n>` keeps the first n rows as printed. On a series that runs oldest first, such as `history`, those are the oldest, so text output says `showing the oldest 2 of 252 rows; --tail 2 for the latest` under the table and `--json` carries `metadata.rows` (`shown`, `total`, `kept`). `--tail <n>` keeps the newest n rows of a dated series whichever way it runs (`history`, `fred` with either `--sort`, `econ`), in their printed order, and the last n of any other list. The two cannot be combined. `fn` reports take `--limit` and `--tail` as options of their own, and fail on one they do not have.

`econ` lists the economic calendar from today (UTC) on, about two weeks ahead. `--from <yyyy-mm-dd>` starts it on another day, an earlier one included, and `--tail <n>` without `--from` keeps the last n events of the whole calendar, the past week's too. When the calendar stops less than a week past its first day, text output ends with `No events listed after <date>` (an empty result says the same), `--json` carries the last day listed as `metadata.listedThrough`, and the ECO pane says it in its footer.

Headless chart text includes a Unit column when a series supplies one; values keep that unit's scale (for example, `2.7 %` versus `270 bp`). DVD text labels cash growth, CAGR and earnings payout as percentages, while their structured `value` fields remain fractional ratios (`0.03` means 3%).

CLI text prints every time in UTC with the zone named (`2026-10-09 00:08 UTC`); a date alone stays a date. JSON and CSV keep the raw ISO or epoch values. `gloomberb config set timezone Asia/Tokyo` (any IANA zone name, Region/City) adds your own clock beside every UTC time in CLI text and report lines: `2026-10-09 23:59 UTC (Sat 10 Oct 08:59 Asia/Tokyo)`, with the local weekday and date because the two can fall on different days. A trading day stays its market's date in every zone. `gloomberb config set timezone none` goes back to UTC alone.

A command fails on an option it does not take instead of answering as if it were not there: `gloomberb history AAPL --from 2020-01-01` ends in `Unknown option --from for history.` with the options `history` does take, and a close match when you mistyped one. A command that takes one symbol or currency fails on a second rather than dropping it (`gloomberb fx NGN ZAR`; write a pair as `fx ZAR/NGN`), and `econ` fails on a country or impact it does not filter by. Everything after a bare `--` is an argument, never an option. Plugin commands from outside the app read their own options.

`gloomberb history` serves each range in one bar size, listed by `gloomberb help history`. There are no second or tick bars, and spread series are daily: asked for a bar size (`--interval 1s`), `history` points at `fn GIP <ticker> --chartResolution 1m` for 1-minute bars and `fn QR <ticker>` for each trade with its millisecond timestamp, and `gloomberb catalog tick` says the same. The line under its heading names the currency the prices are in (an FX pair reads `ZAR per USD`, an index `Index points`, a sub-unit `ILA (agorot, 1/100 ILS)`, and `Currency unknown` when no source states one), the bar size actually served, the first and last bar and the bar count. `--json` carries the same in `metadata` (`currency`, `unit`, `interval`, `firstDate`, `lastDate`, `bars`, `requestedRange`, `asOf`), and every exported row has `currency`, `unit` (what one price is: `USD`, `index points`, `ZAR per USD`), `interval` and `flag` columns after the prices. A warning, on stderr for text and CSV and under `warnings` in JSON, says when the bars are coarser than the range is served in or start well after the start asked for, such as `Asked 5Y, data starts 2023-09-11 (first available bar)`, and, for a coin, which trades every day, which days between its first and last bar have no daily bar, such as `No bar for 2026-10-10`. Weekends and holidays of a market that closes, and days before a listing's first bar, are not flagged. A bar whose prices contradict each other (high below the open or close, low above them) is left blank as `HP` leaves it, with a code such as `high<open` in `flag` and the count in a warning. A coin's volume is traded value in its quote currency, per UTC day on daily bars: the closing line says `volume in USD per UTC day`, every row carries `volumeUnit` and `metadata` carries `volumeUnit` and `volumePeriod`. The day still forming is `partial: true`, with no volume until the day closes (the quote's volume counts that day so far), and a day Gloom Cloud rebuilt from hourly bars because the source left it empty is `filled: true`, without volume; text marks them `partial` and `filled` in the Flag column, a warning names them, and a coin's bar without volume says why in `volumeNote` (`day in progress`, `rebuilt from hourly bars` or `not reported`).

`gloomberb fx NGN` prints one unit of a currency in your base currency, and a pair reads as markets quote it: `gloomberb fx USD/NGN` is how many naira one dollar buys, and `gloomberb fx ZAR/NGN` crosses the two through their dollar rates. The line states both directions, such as `1 NGN = 0.000752791 USD  (USD/NGN 1328.39)`, and ends with the source line of [How current a report is](#how-current-a-report-is), the same one `fn FXC` ends with: dated by the older of the two USD rates and held back as long as the more delayed (`Source: Gloom Cloud · FX trading day Fri 9 Oct 2026 close · 15 min delayed · markets closed`, `live` with real-time access), and `stale` there when a rate has not updated in time. A code priced in itself has no rate to date and no line. A rate keeps six significant figures, or cents from 1000 up. `--json`, `--csv` and `--ndjson` carry `currency`, `baseCurrency`, `rate` (base currency per one currency), `asOf`, `stale`, `pair` and `inverse`; `--json` adds the line's facts as `metadata.freshness`. A code with no rate fails naming that code.

`gloomberb fred <series>` reads the FRED series Gloom Cloud serves, signed in or not; `gloomberb fred --list` prints them with their titles and groups, and words after it filter the list (`fred --list fx`, `fred --list defense` for defense spending, defense capital goods orders and federal outlays). Any other series fails with `Unsupported FRED series DEXSFUS. List supported series with: gloomberb fred --list`, and under `--json` with the `cli_error` code every input error has. Without `--start` it begins at 2021-01-01 and says so under the table with how to go earlier; `--start` takes `yyyy-mm-dd`, or `yyyy` and `yyyy-mm` for the first of that year or month, and a series that begins later than that says when it begins. A start past the series' last observation names the latest one. Spreads (`T10Y2Y`, `T10Y3M` and the ICE BofA option-adjusted spreads) print in basis points, a monthly or quarterly series is dated by its month or quarter in the closing line (`Aug 2026 (monthly)`), a flow FRED states at a seasonally adjusted annual rate says so in its value header (`Value (Billions of Dollars, annual rate)` for `GDP` or the national defense spending series `FDEFX`), and a series FRED publishes late (`UMCSENT`) carries a note saying where the newer reading is. A Treasury yield whose newest session Gloom Cloud read from the Treasury before FRED listed it names that publisher in the closing line, `Source: U.S. Treasury via FRED, published 2026-10-09`, and the row carries `publisher` and `publishedAt` (when it was first read from the Treasury) in every export; values FRED lists stay `Source: FRED`. `--json`, `--csv` and `--ndjson` name the unit in the value field: a spread exports `value_bp` in basis points, as the text prints it (`315` for 3.15 percentage points), a percent series `value_pct`, and any other series its FRED units as a slug (`value_index_1982_1984_100`, or `value_unit_unknown` when FRED's metadata does not come back). This replaced the bare `value` field in FRED's own units: a script that read `value` reads the named field now, and a spread's number is 100 times what it was. The notes are under `metadata.notes` and the latest observation, in the same field, under `metadata.latestObservation`. `gloomberb yield-curve` adds each tenor's move since the previous observation in basis points; its yields export as `value_pct` and `previousValue_pct` (formerly `value` and `previousValue`).

A symbol that trades in several places takes its exchange after a colon or with `--exchange`, in every command that takes a ticker: `gloomberb ticker SAN:EPA` and `gloomberb ticker SAN --exchange EPA` are Sanofi in Paris, while plain `SAN` is the listing you saved, or Banco Santander in New York. Codes go through the app's exchange aliases, so `SAN:XPAR` is `SAN:EPA`, `7203:TYO` and `7203:XTKS` are `7203:JPX`, `600519:SHA` is `600519:SSE` and `SAP:FRA` is `SAP:FWB2`. A code that names more than one exchange is read as the one the symbol trades on. Every command, `fn` report and the command bar read it the same way and say so, and so do ticker, news and alert links (`gloomberb://ticker/7203:TSE`, `term.gloom.sh/?ticker=7203&exchange=TSE`) and a cashtag naming a listing in chat or a story (`$7203:TSE`, `$SAN:EPA`): `TSE` is Tokyo or Toronto, so `events 7203:TSE` is Toyota in Tokyo with `Read 7203:TSE as 7203:JPX: TSE is Toronto Stock Exchange (TSX) or Tokyo Stock Exchange (JPX), and 7203 trades on JPX.`, while `RY:TSE` is Royal Bank of Canada in Toronto; `KRX` is KOSPI or KOSDAQ, and `EURONEXT` any of the Euronext exchanges. A watchlist or portfolio row saved under `KRX` for a KOSDAQ company before the app read the code this way keeps its key and is quoted from KOSDAQ: its Exchange column shows KOSDAQ, `quote` adds `Read 247540:KRX on KOSDAQ, where 247540 trades.`, and its `--json` quote names the board as `tradingExchangeName`. A symbol that trades on more than one of them asks which, naming each (`Name one: X:TSX or X:JPX.`). An exchange the symbol is not listed on fails with the exchanges it does trade on instead of falling back to another listing: a code the app does not know before any data is requested, a known one when the request for it comes back empty. Every command takes the same exchanges `quote` does: a listing outside the US that search leaves out but that has a quote of its own (`CAR:ASX`, CAR Group in Sydney) is a listing, so `filings CAR:ASX` answers for CAR Group rather than saying CAR does not trade there. In a table of several symbols, that symbol's row carries the reason and the others still print. `watchlist` and `portfolio` take the same spelling to add or remove one listing, and `portfolio` to set a position or a target (`target set`, `target clear`, `position set`), each changing only the row of the listing named, never another listing saved under the bare symbol. They say which listing they changed, such as `Added SAN:EPA (Sanofi)`, and `--json` carries it as `listing`, `symbol`, `exchange` and `name`. `portfolio show`, `portfolio target show`, `watchlist show` and `fn PF` label each row's Ticker the same way, so two listings of one symbol read `SAN:EPA` and `SAN:NYSE`; their `--json` and `--csv` keep the key the row is saved under in `symbol`. A bare symbol with no US listing, whose listings all belong to one company or fund, is its home listing: the first one `search` shows on an exchange of its own rather than a German regional or OTC line. `SXR8` is `SXR8:XETRA` and `CSPX` is `CSPX:LSE` in every command, with the same data and currency; reports name the exchange as for a named listing, and `quote` and `compare` add a line such as `SXR8 -> XETRA`. A bare symbol whose listing no source serves ends naming the listing it went to and the symbol's others, each with the command to retry: `gloomberb history SXR8` reads `SXR8 resolved to iShares Core S&P 500 UCITS ETF USD (Acc) (XETRA), which has no history.` and lists `SXR8:BUD iShares Core S&P 500 UCITS ETF USD (Acc) (try: gloomberb history SXR8:BUD)`. `quote` and `compare` go one step further: such a symbol is asked again on the listing it resolved to, by its own key, and then on its other listings in search order, and the first with a quote prints, its exchange named in a line such as `SXR8 -> XETRA`. `watchlist add` and `portfolio add` store a bare symbol on the listing `quote` reads it as: the one its own quote is on, where a quote from any US exchange is the symbol's one US listing, else the first of its listings with a quote; with several listings they name it in a line such as `IEO -> BATS (other listings: IEX, BMV)`. A bare symbol that several companies list and that has a quote of its own goes where it always did, and the commands that read it (`quote`, `compare`, `ticker`, `history`, `financials`, `holders`, `insider`, `analyst`, `events`, `earnings`, `filings`, `options`, and `fn` for a function that takes one ticker) say which company that is in one line: `CAR = Avis Budget Group, NASDAQ (also XETRA, ASX, JSE, LSE, WSE)`, naming each other company once by the exchange search lists it on first. `news` names the listing in the line above its stories instead. `search CAR` lists that listing first as the primary listing, then each other company's first listing, then their other exchanges. A code that several different companies list, such as `2222` (Kotobuki Spirits in Tokyo, Saudi Arabian Oil in Riyadh), is not guessed: every command asks which one, as `2222:` does, with `Choose an exchange for 2222.` and each listing with its retry command (`2222:TADAWUL Saudi Arabian Oil Co. (try: gloomberb history 2222:TADAWUL)`). `quote` and `compare` fail only that symbol's row and print the others. Listings count as one company when, once case, punctuation, legal forms (`Co.`, `Ltd.`, `S.A.`, `plc`), share wording (`Common Stock`) and depositary-receipt wording (`ADR`, `CEDEAR`, `CDR`) are ignored, one name's words are all in the other's (`SPDR S&P 500 ETF Trust` is `State Street SPDR S&P 500 ETF Trust`), and a symbol you saved keeps going to the exchange you saved it on. A symbol whose exchange you named is never switched to another listing. An index typed with the venue search files it under (`^VIX:CXI`) is the index itself, as the bare `^VIX` is; another code fails with the venue it is listed on. A bare index root such as `VIX`, `SPX` or `MOVE` points at the index, which is quoted as `^VIX`: `quote VIX` fails with `^VIX  Cboe Volatility Index (try: gloomberb quote ^VIX)`, `quote MOVE` (Corvex) adds `also ^MOVE ICE BofA MOVE Index`, and `search VIX` names the index above the funds named after it. Reports name the company and exchange they resolved to: `ticker` in its header, table commands in one line above the table, and `--json` as `symbol`, `exchange` and `name` in `metadata`. SEC filings belong to US registrants; for a listing elsewhere, `filings` shows none when the SEC knows the symbol as another company, and says which, and a company the SEC has nothing from says so plainly: `CAR Group (ASX) files no SEC reports.`, as do `holders --form`, `insider` and INS (`fn INS CAR:ASX` and the pane). `insider` points at Form 4 transactions as `gloomberb fn INS CAR:ASX`, the spelling every command takes. `earnings` labels each date `est`, `confirmed` or `reported` in its Status column. A listing outside the US reads its own exchange's calendar (`earnings SAN:MCE` is Banco Santander's Madrid date), and `events` and `fn ERN` list the same next report, and one with no date of its own says so, with the date of the same company's US line as an estimate when there is one: `BHP:ASX: no calendar for this listing; ADR date 2026-11-17 (estimate)`. Another company's US line under the same symbol lends nothing, so `SAN:EPA` never takes Banco Santander's date. Risk factors (`RISK`), executive pay (`EXEC`), 8-Ks (`EK`), debt maturities (`DDIS`), the revenue breakdown (`SEG`) and 13D/13G owners (`HDS`, `holders --form`) read the same way: a listing elsewhere gets its own company's filings, so `SAN:EPA` reads Sanofi's and never Banco Santander's, and shows none when the SEC does not know that company. Data that covers US listings only says so for a listing elsewhere and names the company's US listing, rather than showing another company's numbers under the same symbol: the past reports, surprises and implied moves in `ERN` (`fn ERN SAN:EPA` shows Sanofi's next report and `Sanofi's US listing is SNY: ERN SNY has them.`), options (`GEX`, `OPX`, `OVDV`, `OSA`, `HIVG`, `VCA` and the current IV in `HVG` and `HVT`), time and sales (`TAS`, `QR`), FINRA short interest and short volume (`SI`, `SIV`, `SIW`) and macro release days (`MDAY`). `fn TAS SAN:EPA` answers `Time and sales covers US listings only, and SAN:EPA is Sanofi on Euronext Paris (EPA).` with `Sanofi's US listing: SNY (try: gloomberb fn TAS SNY)`, and a list such as `fn SIW SAN:EPA AAPL` leaves the listing out with the same line. `MA` looks a listing elsewhere up by its company's name. A function that takes several tickers (`ERN`, `SIW`, `CMP`, `GE`) reads each the way `quote` does.

`gloomberb fn PERP --tab history` and `fn CTM` without an argument start with a line saying which market they show, such as `Showing BTC. Try fn PERP ETH.`; `--json` carries it in `data.metadata.notices` and `data.metadata.defaultArgument`. `fn PERP`, `fn COT` and `fn CTM` fail on a name nothing matches and suggest ones that work. `fn EVTS SAN` opens with a line saying the board is the market's for its dates, whether SAN reports on it and when, and that `gloomberb fn ERN SAN` has SAN's own report dates (`data.metadata.highlight` in `--json`). A function with no data report, such as `fn CAT santander`, fails pointing to the screenshot that draws it, `gloomberb shot CAT santander`.

With `--require-bot-safe`, a report or screenshot that is incomplete because part of it needs Gloom Cloud Pro, or a sign-in, says so instead of a generic message.

A function name nothing opens (`fn volsurf SPY`) fails with the functions closest to it by name, keyword and description, at most five, and `Search the catalog: gloomberb catalog volsurf`; a name that matches nothing gets only that line.

A command exits 0 when it worked and 1 when it failed (bad input, no data found, a failed check); `gloomberb help` ends with the list. `shot` saves its PNG, prints the Reason line and still exits 0 when the pane drew an error, was empty, was still loading or was behind an access gate, so a script cannot tell that from a good capture. `shot --strict` exits 2 in those cases instead, with the PNG still saved and the Reason still printed (`--json` carries `usable` and `unusableReason`); `fn` fails on `--strict`.

In short DVD panes, the summary scrolls separately so cash history stays visible. Page Up/Down scroll the summary; arrows or j/k navigate history. The mouse wheel scrolls the region under the pointer.

| Command | Use |
|---------|-----|
| `gloomberb` | Launch the terminal UI |
| `gloomberb launch-ui` | Explicitly launch the terminal UI |
| `gloomberb help` | Show all CLI commands, grouped, under a short Start here list |
| `gloomberb help <command>` / `<command> --help` | Show a command's usage, options, and examples |
| `gloomberb api list\|get\|invoke\|subscribe` | Inspect and call plugin capabilities directly |
| `gloomberb quote <symbols>` | Fetch current quotes |
| `gloomberb search <query>` / `provider-search <query>` | Search tickers and provider symbols (a sector word such as `defense` lists the large US-listed funds that track it first, then the companies named for it) |
| `gloomberb ticker <symbol>` | Show quote, ownership, and financials (with the market closed, Bid / Ask is the session's last quote and says so, with its day) |
| `gloomberb history\|financials\|fundamentals\|options <symbol>` | Fetch research data |
| `gloomberb news\|filings\|holders\|insider\|13f\|analyst\|events\|valuation <symbol>` | Fetch company research feeds (`news` also takes text: `news "european gas"`, a single word no listing answers to, or a futures board code such as `news TTF`, lists the stories that mention it, the best matches newest first, while a real ticker such as `news AAPL` lists its own news; `13f` is the holders list without insiders; `fn 13F` has 13F filings; `holders --form 13d\|13g\|all` lists 13D/13G beneficial owners; `filings --form <form>` keeps one form) |
| `gloomberb movers\|indices\|sectors\|fx\|fear-greed\|earnings` | Fetch market-wide data |
| `gloomberb econ\|fred\|yield-curve` | Fetch macro data |
| `gloomberb compare\|correlation <symbols>` | Compare securities (`relationship` is an alias of `correlation`) |
| `gloomberb portfolio [action]` | Show a portfolio's value, weights, targets and P&L; manage manual portfolios, cash and target weights |
| `gloomberb watchlist [action]` | Manage watchlists |
| `gloomberb notes\|alerts [action]` | Manage local notes and alerts: price alerts, and alerts days before earnings, CPI or FOMC (`alerts add CRWV earnings --days 3`) |
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

`gloomberb options AAPL` prints the nearest expiry's contracts and lists every expiry above them (the nearest 40 when a chain has more). `--expiration` takes a date (`2028-01-21`, the expiry's calendar date) or Unix seconds; a date the chain does not list fails with the nearest listed dates. The IV and Delta columns are valued as the options pane values them: IV is solved from quote midpoints (the provider's own implied volatility is not used), delta from that IV, the underlying's current price, its dividend yield and a 4% risk-free rate. A contract with no two-sided quote, no current underlying price or no time left shows a dash. `--json` and `--ndjson` carry the same figures as `iv` (a fraction) and `delta` on each contract, and `metadata.model` names the spot, dividend yield and rate behind them.

`gloomberb options AAPL MSFT NVDA GOOGL AMZN META --leaps` ranks contracts more than a year out across the symbols, for a stock replacement. It keeps calls (`--side puts` for puts) whose absolute delta is in `--delta` (default `0.70-0.90`), whose quote is two-sided and at most `--max-spread` percent of the midpoint wide (default 5), and whose open interest is at least `--min-oi` (default 100), and sorts them by extrinsic per year, lowest first; `--sort` takes `carry`, `spread`, `oi`, `delta`, `expiry` or `symbol`. Each row has the expiry, days to it, strike, delta, bid, ask, spread %, open interest, extrinsic and extrinsic per year; `--csv` and `--json` add the contract symbol, spot, currency, the chain's as-of time and whether its quotes are delayed. Text output shows the best 40 rows unless `--limit` or `--tail` says otherwise; the exports carry every row. A symbol with no chain, no expiry more than a year out or no current quote is named in a warning and the others still rank; the run fails only when no chain loads. Each symbol reads its catalogue and up to 8 LEAPS expiries through the same chain cache as `options`, four requests at a time. The figures are defined under [OMON strike window and carry](research-data.md#omon-strike-window-and-carry).

`gloomberb fn OMON META --expiration 2028-01-21` reports every strike the chain lists for that expiry, whatever fits the rendered view, and says how many of the expiry's strikes those are (`data.metadata.strikes` in `--json`). `--strikes 10` keeps 10 either side of the money, `--strikes 0.70-0.90` (or `--delta 0.70-0.90`) the strikes whose call or put delta is in the band, and `--strikes all` every strike, the default. `--columns bid,ask,spread,delta,openInterest,extrinsicPerYear` picks the fields mirrored around the strike, as the Columns setting does; `costOfSpot` adds the put's midpoint as a percent of spot on the put side alone ([method](research-data.md#omon-strike-window-and-carry)). `gloomberb shot OMON` takes the same options; its image shows what fits, and the result names the rows cut above or below the view.

`--expiration` takes a date (`2028-01-21`) or Unix seconds, as `options` does; without it the chain opens at the nearest expiry. The report and the image name the expiry with its days left from the chain's as-of (`Expiry 2028-01-21 (469d)`, `data.metadata.expiry` in `--json`), and the report ends with the chain's as-of and delay in the same words as `options`. An expiry the chain does not list shows the nearest listed dates instead of a chain.

`gloomberb watchlist add <list> <symbols...>` and `portfolio add`, and `remove` for both, take any number of symbols split by spaces, commas or newlines (`watchlist add Growth "AAPL, msft" NVDA`), a file with `--file holdings.csv`, or piped input (`pbpaste | gloomberb watchlist add Growth`, or `-`). A CSV is read from its Symbol, Ticker or Code column, else its first column; a byte order mark, Windows line ends, blank lines, lines starting with `#` and repeated symbols are skipped. The first argument names the list; quote a name with spaces, though an unquoted one still works when the leading words name a list, and a list nothing names fails with the lists there are. Each symbol gets a line naming the listing stored (`Added AAPL:NASDAQ (Apple Inc.)`, `Already in the list: ...`, `Not found: XXXXX`), then a summary such as `Watchlist "Growth": 251 added, 5 already in the list, 43 not found: XXXXX, FAKE123.` One symbol that fails never stops the others, and the list is written once at the end. `--json` and `--csv` give a row per symbol with its `status` (`added`, `already_listed`, `removed`, `not_listed`, `not_found` or `failed`), the listing and the reason; the counts and summary are in the JSON metadata and on standard error beside CSV. The command exits 0 when at least one symbol was added (or removed) or already was, and 1 when none resolved. Symbols are looked up several at a time; if Gloom Cloud refuses requests meanwhile (signed out, it limits how many a minute), the symbols that may have failed for that are looked up again after a pause, and any it still did not answer for say so rather than "not found". One symbol typed alone prints the single line it always did. In the app, `AW` takes the same lists, split by commas, semicolons, spaces, tabs or lines (spaces alone are a list unless search knows the words as one company's name, such as `palo alto`): every symbol that resolves joins the watchlist, resolved the way `watchlist add` resolves it, and one notice gives the same summary and names each symbol left out with its reason, such as a code several listings carry, which is not added to the first one and is left for `AW` on its own to ask which. A pasted column of symbols joins into one line in the terminal's command bar.

`portfolio` and `watchlist` come with the Portfolio plugin, `notes` with Notes, `alerts` with Alerts, and `rss` with News. Turning one of those plugins off with `gloomberb plugin disable` also removes its commands.

`gloomberb shot TAS AAPL --output tape.png` and `gloomberb shot QR AAPL --output quotes.png` capture a dated trade or NBBO snapshot with the current Cloud session's access delay.

### Glossary

`gloomberb catalog glossary` lists the rates, auction, energy, perpetual-futures, portfolio and fund terms the AUCT, GC, BTMM, WIRP, CBR, FUT, PERP, PF and ETF functions show, under the function that shows each; `gloomberb catalog glossary stop-out` or `gloomberb catalog explain B/C` prints what one means in a sentence or two, found by its name, its abbreviation or another name for it. A plain `gloomberb catalog <query>` names the terms it matches under the functions. A multi-word query lists the functions that carry every word in their name or description, or the few closest when none does, and counts the rest (`--all` lists every match); a word found only in a function's flag descriptions is no match. A topic no function covers, such as `catalog "defense budget"`, says so and names the nearest functions. `gloomberb fn AUCT --explain` follows the report with the meaning of each term it shows; `--json` lists them as `data.glossary` (`term`, `short`, `definition`), and `--csv` and `--ndjson` keep the rows only. `gloomberb portfolio show <name> --explain` does the same for the rebalance table (Weight, Target, Drift, Trade and pp), with `--json` listing them as `metadata.glossary`; another command given `--explain` points at the glossary. `premium` has two meanings, and `catalog explain premium` prints both: a perpetual's premium over the price it tracks, and an ETF's premium or discount to its NAV. A `search` that finds no ticker lists the functions that carry every word of the query instead, so `search "target weights rebalance"` names `PF`.

A fund's facts (fee, NAV, premium) are not in the terminal yet. `ticker` and `fundamentals` say so for a fund, and `fn ETF` for a fund that files none of the fund forms it lists (a grantor trust such as `IBIT` or `GLD` files 10-Qs instead), each pointing at `fn SEC <symbol>` for a US listing. The rendered report of a pane behind the sign-in wall, such as `fn DIAG MSTR` signed out, says `Requires a free Gloom sign-in` in place of the wall's buttons, and `catalog DIAG` lists it under Requires.

`gloomberb config set telemetry.crashReports false` turns off automatic crash reports, and `gloomberb config set telemetry.usage false` turns off anonymous usage counts and the command bar search log; see [Crash reports and usage counts](telemetry.md) for what each contains.

On the third day you open the terminal app, after a minute on screen, the status bar asks once to star Gloomberb on GitHub. The notification key (`Alt+Enter`) opens the repository in your browser, the dismiss key (`Alt+Backspace`) or the × hides the line, and it goes away by itself after five minutes. Whichever happens, it never comes back. It never shows in the desktop or web app, in CI, or when the app's input or output is not a terminal. `gloomberb config set starPrompt.enabled false` turns it off before it ever shows.

### CSV and NDJSON from reports

`gloomberb fn <function> --csv` writes the report's table as flat rows a spreadsheet can open: the header is the columns the text report shows (`Index,Name,Last,Change,Change %`), and every cell is a plain value, never a JSON blob. Numbers carry no thousands separators, compact scales or units: `1.20B` is `1200000000`, `+3.45%` is `3.45`, and the unit moves into the header (`Yield (%)`, `Market cap ($)`). A table of metrics, one per row, names each row's unit in its label instead (`Total return (%)`), and a column that mixes units (a rate in % beside a spread in bp) is followed by a `<column> unit` column. Times are ISO 8601 with their zone; a date stays a date. A value the text draws from a fraction exports as drawn, so a 6.15% yield is `6.15`; series values keep their own unit's scale (`Value (%)`, `Value (bp)`).

A report with several tables, such as `WEI` by region or a bundle of sections, writes each as its own block: a `# section: <title>` line, the header, the rows, and a blank line before the next. `--section <title or number>` (any case, numbered from 1) writes only that table, so `gloomberb fn WEI --csv --section europe` is one clean table; an unknown section fails and lists the ones the report has. Key/value sections are two columns, `Metric,Value`. A series report writes one table per series with every point and its date, then its statistics. `CALLS` keeps `--section` as the transcript part it reads, and its report is one table. After the data, CSV ends with `#` lines: the same source, as-of and status line the text prints, the [export source lines](#how-current-a-report-is) (publisher, observation date, publication time, retrieval time), then `# incomplete` with what is missing (`# incomplete: 19 of 20 available`), `# error:` and `# note:` lines. `pandas.read_csv(..., comment="#")` skips them, and a spreadsheet shows them below the data.

`--ndjson` writes one JSON object per table row, keyed by the same column names, with a `section` field when the report has several tables; `--section` works the same way. `--json` is the full report with every field, plus the export `source` object.

`fundamentals` and `valuation` follow the same rules: `Metric,Value` rows with the unit in each label (`Market Cap (ZAR)`, `Dividend Yield (forward) (%)`), and for `fundamentals` a second `Profile` table. `financials --csv` writes the statement table with plain amounts under its displayed columns. All three end with the source line.

### How current a report is

Every `gloomberb fn` text report ends with one line naming its source and saying, in words, how current its data is: when it is from, how far it is held back, and where its markets stand, such as `Source: Gloom Cloud · US trading day Fri 9 Oct 2026 close · 15 min delayed · markets closed until Mon`. The plain commands that print market data end the same way: `quote`, `compare`, `ticker`, `history`, `financials`, `fundamentals`, `valuation`, `options`, `news`, `filings`, `holders`, `insider`, `13f`, `analyst`, `events`, `earnings`, `movers`, `indices`, `sectors`, `econ`, `fx`, `fred`, `yield-curve`, `correlation`, and `portfolio show` / `watchlist show`. `--json` carries the same facts as `data.freshness` for `fn` and `metadata.freshness` for the plain commands (`source`, `asOf`, `status`, `delayMinutes`, `retrievedAt`, and `asOfClose`, `tradingDayMarket`, `market`, `minDelayMinutes`, `oldest`, `lagDays`, `observation`, `sources`, `oldestAgeMinutes`, `note` when they apply). Every command that writes one of these lines ends `--csv` with it as a `#` comment after the rows ([CSV and NDJSON from reports](#csv-and-ndjson-from-reports)), followed by four more, so an export can go in an audit file as it is: `# Publisher:`, `# Observation date:` (the newest observation, followed by `# Oldest observation:` for a portfolio whose rows are dated apart, see [What a portfolio is priced at](#what-a-portfolio-is-priced-at)), `# Publication time:` and `# Retrieval time:` (when the export was made, in UTC). `--json` carries the same in a top-level `source` object (`name`, `publisher`, `observationDate`, `publicationTime`, `retrievalTime`). A field the data does not state reads `not published` in CSV and `null` in JSON, never a guess: the publisher is named when the source names it (`DTCC Public Price Dissemination` for `fn CDX` and `fn SOVR`), and the publication time is FRED's last update for `fred` and `yield-curve` when that update covers the newest observation shown, or the time a Treasury yield FRED does not list yet was read from the Treasury. `--ndjson` stays rows only.

The line has up to three parts after the source:

- **When.** The newest observation, in UTC with the zone named (`Sat 10 Oct 2026 00:15 UTC`), or a date for daily data (`Fri 9 Oct 2026`), always with its year. With `config set timezone` the time is followed by yours (`Sat 10 Oct 2026 16:56 UTC (Sun 11 Oct 01:56 Asia/Tokyo)`). Quotes whose markets have closed since read as that session's close and say whose trading day it was (`US trading day Fri 9 Oct 2026 close`, `ASX trading day Fri 9 Oct 2026 close`), after-hours prints included; a report dated by one market's days says so too (`US trading day Thu 8 Oct 2026` for Treasury auctions), and that date is never moved to your zone. Currency pairs trade from Sunday 17:00 to Friday 17:00 New York time, so over a weekend their last prints, a quiet Saturday tick included, read as Friday's close (`FX trading day Fri 9 Oct 2026 close`). The oldest is named when it is more than a day older (`(oldest Thu 8 Oct 2026)`); when nothing in the data is dated the line says when it was retrieved instead. `fundamentals` and `valuation` are dated by when their figures were observed and name the newest statement period those figures run through, such as `not a live feed (reported through 2026-06-30)`.
- **How current.** One of the four states below. A delay says its length in minutes or hours, from the data: a delayed quote by how far its venue's delayed feed runs behind (15 min, 20 min for ASX, KRX, KOSDAQ, TWSE, TPEX, SGX and NZX), a range when the rows differ (`15-20 min delayed`), news by the 12 hours it is held back without real-time access (`12 h delayed`), and a feed that states its own delay by that. Real-time data says `live`.
- **Markets.** For quotes, where their venues stand now, from the exchange calendars (weekends and published holidays): `markets open`, `pre-market, opens 13:30 UTC`, `after hours`, or `markets closed until Mon`, the reopening as a UTC time when it is later the same day and as the venue's weekday otherwise. Crypto trades around the clock and never reads closed; a board whose venues disagree, such as Tokyo open and New York closed, leaves this part out, as does a venue whose reopening is not known.

The status is one of four:

| Status | Meaning |
|---|---|
| Live (`live`) | A real-time feed: the data itself says so, such as a real-time quote or a streaming venue |
| Delayed (`delayed`) | A feed that is not real-time, held back on purpose (with its length when the data states it) or a snapshot refreshed on a schedule |
| Stale (`stale`) | The newest observation is older than its kind allows: a quote from an earlier session, a daily series more than a session behind, a release that missed its schedule. The line says how old, or how many rows are stale when only some are |
| Not a live feed (`not-a-feed`) | Data that is not a feed: filings, fundamentals, calendars, published statistics, calculators, your own portfolio. Old data of this kind is not stale unless it missed a scheduled release |

A report over venues polled apart dates each venue by its own newest observation, and says how old the oldest of them is, since that is how far behind the view can be: `fn PERP` ends `Sun 11 Oct 2026 · Binance 02:15 · Bybit 02:24 UTC · oldest 9 min · delayed · funding = current estimate, pays 08:00 UTC`. The venues are its sources, so the line names them once, with their times, instead of after `Source:`; a venue observed on another day carries its own date. `delayed` means the venues are polled, not streamed; it reads `stale` when a venue has stopped answering. When the view shows funding, the last part says what the rate is: a venue's current estimate, with when it pays (and which venues pay then, when they differ), its last paid rate, or a continuous rate. `--json` carries each venue's time as `sources` (`[{ "source": "Binance", "asOf": "…" }]`), the age as `oldestAgeMinutes` and the funding part as `note`. `fn CRYP` says how old its oldest price is the same way (`oldest 3 min`).

A report that loaded can still carry caveats: what it leaves out, what it assumes, how a value was marked. The text report prints them under `Notes:`, one per line, and keeps `Errors:` for what failed, such as a source that did not answer. What Gloom Pro would unlock is not a failure: the text report prints it under `Pro:`, and a table the free view leaves empty says `Locked: Gloom Pro` in place of `No data.`. `--json` carries notes and errors as `data.notes` and `data.errors`, with the Pro lines among the errors; a note never marks a report incomplete.

A rendered-view report (a pane without a structured report) names the pane's source; its status is the one the pane declares for its data or its own footer states, and otherwise reads "status not reported". `FXC`'s report is dated by the USD rates its crosses come from, as its matrix is: the newest rate's time, how far the feed is held back, how many rates are stale, and where the FX market stands.

`gloomberb shot` draws the same line in the pane footer of the image. It sits inside the requested size (the pane's body gives up its last row for it). A pane whose report says how current its data is ends as its `fn` report does, source first, with the same `freshness` in `--json`: `shot COT BTC` reads `Source: CFTC · Tue 6 Oct 2026 · not a live feed (weekly report)`. Quotes on screen keep their market line, without the source: `US trading day Fri 9 Oct 2026 close · 15 min delayed · markets closed until Mon`. A pane that dates its own view says what it shows (a news pane's delay, `FXC`'s rates), and one with no report says what its rendered view carries. In a narrow image the line keeps the date and the delay and shortens the rest first (`reopens Mon`), then leaves out your local time, the oldest observation, the stale total and the market part, then the source, and as a last resort cuts the middle. A line that dates each venue keeps every venue's time and the oldest age to the last: its leading date goes first, then the funding part. `PERP` and `CRYP` show the same line in their pane footer, without the date when the data is from today.

A dataset pane, whose data is observed and published days later rather than quoted (`CHOKE`, `POWER`, `HIRE`, `APPS`, `GPU`), has no market part: its line comes from the same data as its `fn` report and names the source, the newest observation's date and how many days old it is, such as `Source: Gloom Cloud · observed Sun 4 Oct · lag 6d`, with the oldest observation beside the date when the report names one. The date has its year when it is not the year of the capture. The lag counts whole days in UTC; a monthly, quarterly or annual figure counts from the last day of its period (`observed Sep 2026 (monthly) · lag 10d` on 10 Oct). `--json` carries it as `freshness.lagDays`. A narrow image drops the oldest observation, then the stale total, then the source. The line dates the data, so the pane's own `as of` footer text is left out of the image; its Pro or Free preview badge and any warning stay. Quotes on such a pane, such as `GPU`'s Equities tab, keep the market line. `CDS` names what its date is and dates it as its rows are: `Source: DTCC · last trade 2026-10-09 · lag 2 days`, from the newest trade in view (never when the tape was fetched), and its `fn` report and pane footer end with the same line; `--json` carries `freshness.observation`. The shot's verification output prints it as `Status line`, and `--json` carries it as `render.statusLine` with the facts as `freshness`. Its `Status` is `complete` only when the pane's `fn` report is: a report that says `complete: false` makes the capture `partial`, with what it leaves out after it (`partial: 2 stale` for `CBR`, `partial: locked` for a Pro limit), and `--json` carries that as `complete: false` and `gaps`. `--no-status` leaves it out and renders the image exactly as before.

## Plugins pane

Open it with `PL` in the command bar. It lists the [built-in plugins](#built-in-plugins) that can be switched off, research and markets first, then what you have installed and what the registry offers. A row shows how many panes the plugin adds, three of its codes, and how many of its functions need Pro or give Free a preview.

The status reads `on`, `off`, `core` for Ticker Research, `update` when the registry has something newer, `needs setup` when a required setting is missing, `errors (n)` after failures this session, or `failed` when it did not load. Enter opens the detail: every function, Pro ones marked, and the panes.

Starter packs are built-in templates for the research and markets plugins: Everything, Equity research, Options desk, Macro & rates, Credit & bonds, and Alt data & quant. The Research and markets heading names the pack your plugins match, such as `Options desk pack`, or `Custom set` once you switch one by hand. Click it or press `a` to apply another. Each pack shows what it would switch from here (`8 off`, `1 on, 2 off`), and a confirmation names the plugins before anything changes. A pack keeps Ticker Research on and never touches other plugins. Panes of plugins it turns off are hidden, not closed; Undo on the toast brings them back.

Plugin GitHub star counts are currently hidden. The marketplace keeps its curated ordering.

| Key | Action |
|-----|--------|
| `i` | Install the selected plugin, after a confirmation that names its source and declared hosts |
| `g` | Get its update, or reload one that failed to load |
| `x` | Remove it |
| `e` | Switch it on or off; Ticker Research asks first |
| `a` | Apply a starter pack |
| `o` | See a built-in on gloom.sh, or open a plugin's page |
| `s` | Open its setup form |
| `p` | Open a pane it provides |
| `d` | Open the debug log filtered to it |
| `b` | Show or hide the built-in plugins |
| `/` | Search |

A plugin installed or updated from the pane is loaded into the running session: its panes and commands are available immediately. If your app starts with a plugin that failed to load, a notification says so and opens this pane.

You do not need the pane to get an official plugin. Type its code, such as `TV`, `POLL`, `PM`, `HN` or `SUB`, and the command bar offers to install it after the same confirmation, then opens it with whatever you typed after the code.

Official plugins, the ones published under [github.com/gloom-sh](https://github.com/gloom-sh), update on their own in the background: once after Gloomberb itself updates, then at most once a day. A plugin you linked or edited locally is left alone, and when an update needs a restart to finish, one notification says so. Third-party plugins update only when you press `g` or run `gloomberb update`. **Update official plugins automatically** in this pane's settings turns it off.

## What a portfolio is priced at

Value, P&L, weights and the total are priced at each holding's latest print, pre-market and after hours included, as brokers value a book, so after the close a holding with an after-hours trade is worth its shares at that print, not at Last. `portfolio show` says so on the line under the title (`Priced at the latest print, extended hours included`), and its `As of (UTC)` column gives the time of the price each row uses (`Fri 9 Oct 23:59`), so a Friday price never hides behind a newer row. `gloomberb portfolio show <name> --close` prices the book at the regular close instead: Value is Last times the shares, P&L, weights, trades and the total follow, `As of` is the venue's close (`Fri 9 Oct 20:00` for a US listing; a venue without extended hours keeps its last print's time), and `Day's move: +$1,165.49 (+0.51%)` under the table is the holdings' move from the close before. `fn PF <portfolio> --close` does the same, with the day's move above its table, and both end their source line with the basis (`priced at the regular close`). In the `PF` pane the header reads `Val 231.3k (latest print)` or `(regular close)`, **Value at Regular Close** in the pane's settings switches it (`shot PF <portfolio> --close` captures it that way), and the `AS OF UTC` column gives each row's price time. It took AGE's place in the default columns; a pane still on the old defaults moves over once on update, and a column list you changed keeps AGE (both are in the pane's column settings).

The `--json` and `--csv` rows of `portfolio show` and `fn PF` end with `valuationBasis` (`latest-print` or `regular-close`), `valuationPrice` (the price Value uses, in the quote's currency) and `valuationAsOf` (when it is from, an ISO time in UTC, or a date for a close whose hour the venue's calendar does not give); `quoteAsOf` keeps the quote's own time and `priceBasis` stays the position's per-unit or percent-of-par basis. `portfolio show --json` adds `metadata.valuationBasis`, and with `--close` `dayChange` and `dayChangePercent` (in `metadata.totals` for `fn PF`). Their exports are dated by those prices: `# Observation date:` is the newest and `# Oldest observation:` the oldest when the rows differ (`source.oldestObservationDate` in JSON).

## Portfolio currency

A portfolio's header totals and its COST, MKT VAL, DAY, P&L and MCAP columns are in the portfolio's currency, as are `PORT` and `gloomberb portfolio show`. A broker portfolio uses its account currency. A manual portfolio uses your base currency (`config set baseCurrency`). With the default USD base, a manual portfolio takes the currency of its first position instead: a portfolio of ASX shares bought in AUD totals in AUD, and holdings added later in other currencies convert into it. Totals lead with the currency symbol, such as A$108.6k, unless both they and the base currency are USD. LAST, AVG COST and TARGET stay in the listing's currency.

A broker portfolio's header leads with `Net Liq`, the account's equity, then `Gross`, the market value of its positions, and `Cash`, which is negative while the account borrows on margin. `Lev` (gross over Net Liq) appears once the account is levered, and the day's percentage is a return on the equity. The broker's last account snapshot is kept across restarts in the terminal, desktop and web apps, and the footer gives its sync time. Until there is one, `Net Liq` and `Cash` read `—`, because the positions alone are not what the account is worth, and when the broker's last call failed (a sign-in that lapsed, say) the footer says why. `PORT` shows the same figures and `KELLY` bets the same equity.

## Importing a manager's 13F as a portfolio

`gloomberb portfolio import --13f <CIK|fund name>` makes a manual portfolio from a manager's latest 13F, to follow it in `PF` and `PORT`:

```bash
gloomberb portfolio import --13f 0001067983 --top 10                 # "BERKSHIRE HATHAWAY INC 13F"
gloomberb portfolio import --13f 0001067983 --name "Buffett 25" --top 25 --notional 250000
gloomberb portfolio import --13f 0001067983 --top 10 --replace       # refill the portfolio of that name
```

- It takes the `--top` largest common-stock lines by reported value (10 when left out, at most 100) whose ticker resolves to a listing. Options, principal amounts, preferred stock, warrants, rights, debt and CUSIPs without a ticker are skipped, and the command lists each with the reason; the next line takes its place.
- Weights are each line's reported value over the imported lines' total. Shares are a notional, `--notional` dollars in total (100,000 when left out), at the price the filing implies (reported value over shares), which is each position's cost. They are the manager's weights, not your holdings, and the output, `portfolio show` and `fn PF` say so with the quarter and filing date.
- The portfolio is named after the manager unless `--name` says otherwise. An existing portfolio of that name is filled only when it holds nothing; one that holds tickers needs `--replace`, which removes them and their targets first. A broker portfolio is never imported into.
- The filing date is kept on the portfolio, so `fn PORT <id> --since filed` can measure from it.

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
- **Trade** is what reaches the target at the current price: the value, and the units at the position's own value per unit (contract multipliers and FX included). A holding kept in whole shares trades in whole shares, rounded; a fractional holding shows its trade to at most two decimals and a coin to at most four. `--json`, `--csv` and a `shot`'s JSON (its cell `value`) keep the full-precision figure. Trades ignore fees, taxes and lot sizes.

`portfolio show <name> --explain` follows the table with what each of these terms means. [gloom.sh/docs/portfolio](https://gloom.sh/docs/portfolio) walks through a small rebalance.

In `PF`, a portfolio with targets shows `WEIGHT`, `TGT WT`, `DRIFT` and `TRADE` after `MKT VAL`, unless the pane's columns already include target columns; `TRADE VAL` is in the pane's column settings. (`TARGET` and `TARGET%` are the analysts' price target.) With cash entered by hand the header shows `Total` and `Cash`, with the cash's weight and drift; a broker account keeps its `Net Liq` and `Cash`. `gloomberb fn PF` and `gloomberb portfolio show` report the same figures.

## Broker position sync

Press `a` in the **Brokers** pane (`BR`), or run **Add Broker Account**, to connect a broker; **New Portfolio** can start from one too. Gloomberb can import positions from Interactive Brokers, Public, Robinhood, and SimpleFIN.

Each broker is a plugin with its own repository, installed on first launch and updatable on its own. Manage them from the plugin directory, or with `gloomberb install gloom-sh/gloom-public` and friends.

- Interactive Brokers opens a browser sign-in page through Gloom, and ends that sign-in seven days after you approve it, however often it syncs. A day before, the profile's status in `BR` shows when it ends; press `c` to sign in again and the seven days start over. A sign-in that has ended shows Interactive Brokers' own reason.
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

## Connect an AI assistant (MCP)

`MCP` opens a short setup for the [Gloom MCP server](https://gloom.sh/docs/mcp); typing mcp, claude, codex or cursor in the command bar finds it too, and so does `ACM` > Advanced > Assistants (MCP). Pick the client and copy its one command or config with `c` or Copy.

Claude Code, Cursor and most recent clients sign in through your browser on first use, so they need no key. Codex, and clients without a browser, use a key: `k` creates one through your Gloom Cloud account (Pro) and fills it into every snippet. The key is shown once and saved nowhere, so copy it before you close the dialog. Keys made here get Read access; to choose another level or revoke a key, use Cloud settings, Agents on gloom.sh.

## Remote control from an assistant

An assistant connected to the Gloom Cloud MCP with Terminal control (Cloud settings, Agents) can drive this app while it is open and signed in: read what is on screen, open and arrange panes, navigate tickers, switch layouts, everything the local remote API offers. It needs no setup in the app.

The first time an assistant asks, a prompt names it: `s` allows it for this session, `a` always, `n` or Esc denies. Plugin actions, button presses, commands and anything that reaches an outside service (an order, a transfer, a message) then ask on every call, with what the call will do and its key arguments; `y` allows that one call, and one left unanswered for 60 seconds is denied. Deleting a layout asks too, since it cannot be undone, and so does adding a ticker to a watchlist or taking one off, naming the list, the ticker and its exchange. While an assistant works, its name shows in the status bar; a click opens Account Management on the Agents tab, where `r` revokes it so its next call asks again. The `MCP` dialog says how many assistants are allowed, and `m` opens the same tab. Revoking its key or disconnecting it in Cloud settings does the same. Credentials in the configuration never leave the app.

On this machine, `gloomberb remote` drives the open app the same way. A watchlist change through it, such as `gloomberb remote call watchlist.add '{"symbol":"MSFT","watchlist":"Tech"}'`, opens a confirmation in the app naming the list, the ticker and its exchange; Enter or `y` makes the change, `n` or Esc leaves the list alone, and the call answers with what happened.

## Chat

`CHAT [channel]` opens a channel. When the pane is too narrow or short for the channel list beside it, the list and the open channel take turns: Back, Esc, Backspace, Left or the mouse back button return to the list, and Enter, Right or a click opens a channel. Pointing at a name or an @mention shows that person's card: their public profile if they made it public, otherwise their name and @username. On the desktop and the web the card opens just below the name, so the pointer can move straight onto it; in the terminal it sits in the chat's top-right corner. It stays open while the pointer is on it. Someone else's card has Message (Open DM when you already share one); a card with only a name says why instead when they take no DM from you. A click on the name keeps the card open until Esc, a click outside it or a second click; `p` shows the card of the selected message's author.

Your channels and DMs are in the command bar too. Type part of a channel's name (`gen` for #general) or of a person's username or name to find the conversation: channels are tagged `CHAT`, team channels `TEAM`, DMs `DM` and group chats `GROUP`, and a conversation with unread messages shows how many. Picking one shows it in the Chat pane that is open, or opens one, with the message field ready to type in. The empty command bar lists a few conversations, unread ones first and then your latest DMs; `chat` or `messages` alone lists them all and `DM` your DMs and group chats, each ending with New DM, which opens the Chat pane's New DM dialog. `CHAT gen` opens the conversation listed first for `gen` when no channel is called that. The rows come from what the chat already holds, so signed out there are none.

Public channels are mirrored to the Gloom Discord, and messages written there appear with a dim `Discord` tag after the author's name. Someone on Discord who has not linked a Gloom account has no card and cannot be messaged. Type `/discord` in the message field to connect your Discord account (it opens gloom.sh in your browser, which signs you in and then asks Discord to approve), and `/discord mirror off` to stop your own messages going to Discord (`/discord mirror on` turns it back on, `/discord unlink` disconnects the account). A message written on Discord can only be edited there.

React to a message in any channel, DM or group: React beside Reply on the message the pointer is on (in the terminal, the selected or pointed-at message), or `+` on the selected message, offers 👍 🔥 😂 👀 ❤️ 🚀 and any other emoji already on the message, each with who reacted. Reactions show under the message with their counts, yours highlighted; a click on one adds or takes back yours, and pointing at one names who reacted (in the terminal, in a line just above it). Reactions in public channels also show on the Discord copy: Discord people's own reactions come back into the app, a custom Discord emoji shows as its `:name:`, and the app's reactions appear there as one reaction from the Gloom bot per emoji, with the app's reactors named in small print under a message written in the app (members who turned mirroring off are left out). Reactions notify no one.

The message list stays where you are reading. At the bottom, or a few pixels from it, it follows each new message; scroll back and it does not move: messages that arrive meanwhile show as a small `N new messages` button over the bottom of the list, which scrolls to the newest message and goes when you reach the bottom by any means. A channel opens at the bottom and your own message always scrolls to it. Older messages that load above, an edit or reaction above the view and a resized pane keep the message you are reading where it is. A message a notification or a quoted reply takes you to is scrolled into view and marked for about two seconds, or until you scroll, click, press a key or a new message arrives. The Reply, React and Edit buttons and the band on a message show only on the message the pointer is on (in the terminal, the selected one, and the one pointed at), and go when the pointer leaves it, the list scrolls or a message arrives under it, a key is pressed or the window loses focus; the first move after that shows them again.

A message can carry up to four images: PNG, JPEG, WebP or GIF, up to 5 MB each. In the desktop app and the web app, paste an image into the message field, drop image files on the chat, or use the image button at the end of the field (also `Attach Image…` in the pane menu). Each image uploads at once and shows above the field with its progress; the x removes it, and one that failed to upload offers Retry. Enter sends once every image is up, with or without text. In the terminal, paste or drop the path of an image file into the message field to attach it; Backspace in an empty field removes the last one. Images in public channels are checked before anyone else sees them: your own message says `Checking image...` meanwhile, and `Could not be checked, only visible to you` if the check could not run. The desktop and web show images in the conversation and open them full size on a click (Left and Right step through a message's images, Esc closes); the terminal lists each image as a row such as `[image 1280x720 179 KB]` that opens in the browser on a click, or with `o` on the selected message. A message that failed to send has Retry, or Enter while it is selected, which sends it again without uploading its images again.

### Share

**Share** is the one action for the focused pane, in its menu (`.`, the `...` button, or a right-click on the header on the desktop), in the command bar, and on `Cmd/Ctrl+Shift+S`. Help lists it under Pane Management; existing `pane-share` rebindings keep working. Searching `share pane` or `share to chat` finds the same command. Popped-out windows use the same menu and key. Chart and news footers no longer have a separate share action; Copy Screenshot (`Cmd/Ctrl+Shift+C`) and Export CSV are unchanged.

The dialog previews the pane's picture, then offers **Post to chat** and **Copy link**. Posting picks a channel (the last one used in chat, else #everyone) and an optional caption. **Include link** starts on and remembers your choice: when a public link is available, the message includes it below the caption so the recipient can open the same view in their terminal, including a DES option chain's selected tab and ticker. Otherwise the message is picture-only. Copy link copies that same public Gloom link and shows a toast. Public link rules, private-state filtering and expiry are unchanged; no link is created until you copy or post with Include link on.

The picture's footer shows the pane's data status, such as `15m delayed`, and its capture time in UTC, without action keys. Posting needs a signed-in account with a verified email. Public-channel pictures are checked and mirrored to Discord like other images.

A pane that shows your own data asks first, under the picture: your portfolios (not watchlists), Portfolio Analytics, the position sizer, Earnings Ripple on your holdings, Ticker Research and `OMON` on a ticker you hold say `This shows your holdings. Post it?`; Brokers, ACM and Team say `This shows your account details. Post it?`; a DM, group or team chat, Unread Chat and Ask Gloom say `This shows private messages. Post it?`. Enter in the caption does not post such a picture: press Post.

The desktop app and the web app draw the pane's picture from the window. The terminal draws it from the characters on screen in a bundled monospace font, with box drawing, block and braille characters drawn exactly so borders and text charts join up, and kitty charts placed back where they sit; a character outside the bundled font shows as an empty box. Its dialog previews the pane as its own characters when they fit, or as a thumbnail of the picture when they do not or when the pane holds kitty charts. A pane covered by a floating window or a notification is pictured with what covers it.

The unread count in the status bar opens Unread (also in the command bar): one row per channel with unread messages, and the count of a channel that mentions you in green. Counts are your account's, the same on every device. A row shows the latest unread message, one that mentions you first, only when the messages after the last one you read are already on this device, so a row can have a count and no message. Opening a row shows that channel in your chat pane; listing reads nothing.

Below the chat, Unread keeps the price alerts, catalyst alerts and team notices whose toast you may have missed, newest first, the last 300 of them. One counts in the status bar until you open it, use its toast's button, or mark all read; then it stays in the list, dimmed. Opening one selects the price rule in ALRT, opens the catalyst, or goes where the team card's toast goes. This list is kept on this device only and is not part of synced settings; other toasts, such as errors, are not kept. `m` marks everything read: the notices, and each unread channel as if you had opened it. Pending team invites stay pending until you answer them in TEAM.

## Ask Gloom

`ASKG` opens Ask Gloom, and `ASKG <question>` asks straight away. The question field has the keyboard as soon as the pane opens or is focused, so you can type at once; Enter asks, Shift+Enter starts a new line, and the field grows with the question. An empty pane offers three questions written for what your profile holds; a click, or Up then Enter, asks one.

Under each question, every source Gloom used is one line: what it read, the portfolio or symbol it read it for, how many rows came back and how long it took. A result with gaps says the main one in a line below (`3 of 94 positions had no price`); a click or `x` opens the row with everything it reported and its rows at the bottom of the pane, and `o` opens the pane it came from. A failed source says why in one line. An answer that used more than three sources folds them into one line that a click or `x` opens.

Ask Gloom can add a ticker to one of your own watchlists or take one off: the one you name, or else your first watchlist. Team watchlists and portfolios it leaves alone. It asks first in the pane, naming the list, the ticker and its exchange: `y` or Approve makes the change, `n` or Decline leaves the list as it was. The question stays open for about a minute; unanswered by then, it closes and nothing changes.

Esc leaves the question field for the answer: `j`/`k` walk the sources, `t` lists the tickers in the answer, `c` stops an answer that is still coming, and `r` asks a failed or stopped question again. Enter goes back to the field. `n` starts a new conversation and Left (or Left in an empty field) lists earlier ones, beside the answer when the pane is wide enough and in its place when it is not. Closing the pane keeps the conversation: opening Ask Gloom again in the same session shows it, unless you open it with a question, which starts a new one. The remaining daily questions show in the footer once 20 or fewer are left.

### Asking about a pane

Every pane can be asked about the same way: the spark beside the `?` in its header on the desktop and the web, **Ask Gloom** in its pane menu, or `Alt+A` (`Cmd+Shift+A` or `Ctrl+Shift+A` on the desktop). Ask Gloom opens, or comes to the front, with a new conversation: the conversation already on screen stays in the list, and an answer still coming finishes first. The pane is attached above the question field (the x takes it off), and the field holds `What does this pane show?` to edit or send; nothing is asked until you press Enter. With the pane goes its function and how it is set (`DES AAPL` on its Financials tab, a chart's range) and the text it shows on screen at that moment, cut to a short summary, never data scrolled out of it or another pane drawn over it. A pane with your holdings, balances or account details (a portfolio, a broker or account pane, or research on a ticker you hold) asks first: `y` or Attach sends what it shows, `n` or Leave out sends only which function it is. A header too narrow for the spark leaves it out; the menu and the key still ask. While a text field has the keyboard, the key stays with the field (on the desktop `Cmd+Shift+A` still asks). In a browser that keeps `Ctrl+Shift+A` or `Cmd+Shift+A` for itself (Chrome's tab search), use `Alt+A`, the spark or the pane menu.

Rate an answer with the thumbs under it (`+1` and `-1` in the terminal), or, once Esc has left the question field, `g` and `b` for the answer the keyboard is on: the newest, or the one `j`/`k` moved to. A thumbs down offers why (`1` wrong, `2` too slow, `3` missing data, `4` other) and `Send this answer to Gloom` (`s`), which sends your question, the answer as written (it can mention your holdings) and which tools ran, not the data the tools returned; without it only the thumb and the reason are kept. Esc closes the reasons, and your rating shows again when you reopen the conversation.

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

## Built-in plugins

Each built-in plugin can be switched on or off in `PL`. Ticker Research, Market Overview and Macro were split into the plugins below; panes, shortcuts, settings and saved state are unchanged.

| Plugin | Functions |
|--------|-----------|
| Ticker Research | The research pane, DES, FA, QQ, HP, RETURN, the G charts, CAT, ANR, DIAG, EVT, RV, EE, EM, GUID, KPIS, GUIDE, SEG, DVD, RDCF, PEB, EXEC, TAS |
| Options & Volatility | OMON, OPX, GEX, OVME, OSA, OVDV, HVG, HVT, HIVG, VCA |
| Ownership & Insiders | HDS, 13F, INS, SI, SIW, SIV, the Congress tab |
| Filings & Events | SEC, ETF, RISK, EK, CATL, LITI, MA, DIST |
| Credit & Bonds | CDS, CDX, SOVR, CRD, AUCT, YAS, CRDOC, COVN, DDIS |
| Earnings | ERN, EVTS, CALLS, RIPL |
| Supply Chain & Alt Data | SPLC, EXPO, AWARDS, HIRE, APPS, JOBS, BUZZ, ATTN, the Gloom Trending pane, GPU, POWER, EPWR |
| Quant | CORR, GR, BT, SEAS, MDAY |
| Rates & Macro | ECO, ECST, CPI, GC, WIRP, BTMM, CBR, VIX, VOLS, VAL |
| Global Markets | WEI, MAP, CHOKE, BI, THEM, FXC, RRG |
| Screeners & Movers | EQS, MOST, HILO, FLOW |
| Futures & Commodities | FUT, CTM, COT, DOE, NGS |
| Crypto & Perps | CRYP, PERP |

A research tab belongs to the plugin of its function: switching off Ownership & Insiders removes the Holders, 13F, Insider, Short Interest and Congress tabs.

Switching a plugin off hides its panes without closing them. They stay in every layout, even as you close or move other panes, and come back where they were, with their state, when it is switched on. Typing one of its codes in the command bar offers **Turn on** the plugin, which then runs what you typed.

The old ids still switch a whole group: `gloomberb plugin disable ticker-research` (or `macro`, `market-overview`) turns off every successor. Credit & Bonds and Earnings belong to both Ticker Research and Macro, and Supply Chain & Alt Data and Quant to both Ticker Research and Market Overview. An older Gloomberb on the same account shows an old plugin off only while all of its successors are off.

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

The leg format is `call|put,strike,YYYY-MM-DD,signed contracts,entry price,IV percent[,multiplier]`, separated by semicolons. `--tab` accepts `payoff`, `grid` and `legs`; `--spot-range` is the percentage range either side of spot. Omit market overrides to use current sources, or request `--strategy vertical`, `--strategy straddle` or `--strategy put` (one long put) to build an explicit example from complete two-sided quotes, at `--strike` or the strike nearest the money. `--expiration` selects that chain's expiry for `--strategy`, as a date (`2027-01-15`) or Unix seconds, matched to the listed expiry of that calendar day as OMON matches it; a date the chain does not list names the nearest listed ones. Without `--currency` the position is in the underlying's currency (USD for a US listing). Entry prices and spot are per share; value, P&L and the grid are for the whole position, labelled `per contract` or `for N contracts`. Screenshot JSON includes the rendered position and numerical observations, with readiness validated against the shared model. No position is invented when no legs or strategy are supplied.

To size a protective put against a budget, add `--nav` and `--budget-bps`, and `--sleeve` for coverage:

```sh
gloomberb fn OSA SPY --strategy put --strike 700 --expiration 2027-01-15 --nav 100m --budget-bps 50 --sleeve 100m
```

The **Hedge budget** block says how many contracts the budget buys (whole contracts, rounded down), the price it sized at and what one contract costs, the premium spent and its actual bps of NAV, the notional protected and its share of NAV, and the coverage of the sleeve. A seeded put is bought at the ask; a typed leg at its entry price. In the pane, the same figures sit under the scenario's when the Hedge NAV and Hedge budget settings are set. The sizing is defined under [Options scenario analysis](research-data.md#hedge-budget).

## Option valuation models

`OVME` starts with the European Black-Scholes model. Choose **American CRR** or use `m` to value early exercise. Set the tree step count and enter cash dividends as `days:amount`, separated by semicolons, for example `30:0.25;90:0.25`. Days are calendar days from valuation and cash is per underlying unit. `d` focuses the dividend schedule; `u` edits the underlying ticker. The model, tree settings and schedule resume with the pane.

Choose **Surface IV** or use `v` to source the strike/tenor volatility from OVDV. The surface is fitted using the current observed underlying quote; changing the calculator's spot changes the scenario price, not the source surface. Its quote dates and fit methods appear in the footer, with source failures and coverage limitations in warnings. Editing the IV field returns to entered volatility. `r` refreshes the source. Switching back to European BS deactivates the American cash schedule while preserving it for later use.

```sh
gloomberb fn OVME --model american --side put --spot 100 --strike 100 --days 365 --volatility 20 --rate 5 --dividend-yield 0 --dividends '30:1;120:1' --steps 800 --json
gloomberb fn OVME --model american --symbol AAPL --spot 340 --strike 340 --days 90 --rate 4 --dividend-yield 0 --vol-source surface --json
gloomberb shot OVME --model american --side put --spot 100 --strike 100 --days 30 --volatility 25 --rate 4 --dividends '10:1;20:1' --width 1080 --height 360 --output ovme-american.png
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

## Position sizing: KELLY

`KELLY <ticker>` sizes a position with the Kelly criterion. Binary, Scenario, Risk, Market and Asym take your own probabilities and payoffs; History reads them off the ticker's own daily closes: the share of up months, the mean gain of the up months and the mean loss of the down months, over non-overlapping 21-session returns counted back from the last close, for the last five years (`Years` sets one to five). Those are sized as a binary bet, so full Kelly is the fraction of bankroll that maximizes expected log growth for that win rate and payoff. Past months are not a forecast, and fewer than six of them give no inputs.

`gloomberb fn KELLY LIT` prints History's inputs (window and its dates, win rate, average gain and loss, payoff ratio, edge a month) and full, half and quarter Kelly as a share of bankroll. `--bankroll 250000` (or `250k`, `1.5m`) sizes each in your base currency, with whole shares when the quote is in that currency, and `--years 1` shortens the window. `gloomberb shot KELLY LIT --bankroll 250000` opens the pane on History with that bankroll.

## Portfolio risk depth: PORT and MARS

`PORT` opens portfolio market risk; `MARS` is its alias. Add a local portfolio's ID or name, in any case, to select it, for example `PORT main` or `PORT Family`; every command and function that takes a portfolio or watchlist reads it that way. Views cover Risk, Factors, Holdings, Correlation, Stress, Performance, Attribution and Greeks. Enter opens a metric's evidence and history; Escape returns. Click portfolio tabs or press `p` to switch portfolios. Press `i` to import local account evidence from the clipboard, and `r` to refresh Cloud observations. Tables support sorting and CSV export.

The return rows and tracking error are measured against SPY, which the benchmark row names: `60D benchmark return (SPY)`. They cover the trailing 60 sessions; for a portfolio made with `portfolio import --13f`, the pane's **Risk window** setting or `--since filed` measures them from the 13F's filing date instead (a portfolio without one keeps the trailing 60 and says so). Use pane settings for independent index-percent, 10Y-basis-point and VIX-point stress shifts. Existing saved Analytics panes keep Overview until their View setting changes to Risk depth. Performance, Brinson attribution and imported option Greeks use the versioned local JSON schema in [research data](research-data.md#local-account-evidence); the pane does not derive account cashflows from current holdings. Evidence remains private and must match the portfolio ID and currency.

```sh
gloomberb fn PORT main --json
gloomberb fn MARS main --view factors --json
gloomberb fn PORT main --view stress --equity-shift -15 --rate-shift 100 --vol-shift 10
gloomberb fn PORT berkshire-hathaway-inc-13f --view risk --since filed
gloomberb shot PORT main --width 1100 --height 620 --output portfolio-risk.png
```

Risk, Factors, Correlation and Stress model the equity holdings with daily history, up to the 150 largest by value. A listing quoted in another currency is converted to USD at daily FX closes, and the footer counts those holdings. When some holdings are left out (foreign listings without daily FX closes, shorts, options, crypto, holdings without a quote or history), the footer says how much of the account the estimates cover and `!` lists each holding left out and why (`fn PORT` prints the same under Notes); below half of the account's market value the views say so instead of estimating. See [research data](research-data.md#portfolio-risk-depth-port-mars) for the method.

`fn PORT` prints every view, or the one `--view` names. A stress shift given with another view, or `--since` with a view other than risk, is named as not applying rather than dropped without a word. `--evidence` accepts the same JSON text as the clipboard import. Account-return and attribution examples in the methodology are illustrative inputs, not sample market data. A report includes raw values, source dates, percentile coverage, holdings, factor regressions and warnings; screenshots freeze that same local model.

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
