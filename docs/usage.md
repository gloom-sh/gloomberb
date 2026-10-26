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
- [Dividend income and DRIP](#dividend-income-and-drip)
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

The desktop app and TUI share the command language and plugin system. The [browser app](browser.md) offers a smaller feature set. Use `HELP` in the app or `gloom help` in your shell for the commands available in your installation.

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
| `<` / `>` | Narrow or widen a pane's sidebar, such as the list beside the map (the divider also drags) |
| `Ctrl+Left` / `Ctrl+Right` | Scroll a focused table horizontally |
| `m` | Cycle chart mode |
| `Alt+Enter` | Run the newest notification's action, such as Revert or Review |
| `Alt+Backspace` | Dismiss the newest notification |
| `q` | Quit (terminal) |

Desktop builds add the matching `Cmd` shortcuts on macOS and these:

| Key | Action |
|-----|--------|
| `Cmd/Ctrl+K` | Open the command bar |
| `Cmd/Ctrl+Shift+O` | Pop out a pane |
| `Cmd/Ctrl+Shift+C` | Copy a screenshot of the focused pane |
| `Cmd/Ctrl+Shift+A` | Ask Gloom about the focused pane |
| `Cmd/Ctrl+Shift+Enter` / `Cmd/Ctrl+Shift+Backspace` | Run / dismiss the newest notification's action |

### Footer and pane menu

The focused pane's footer shows its actions with their keys, such as `[a]dd`. The pane menu (`.` or the `...` button) lists every action, then the pane's table, filters, tabs and toggles, then the pane and window actions.

### Dialogs and forms

- Dialogs: `Enter` confirms, `Esc` closes (on the desktop `Tab` moves between controls).
- Forms: `Tab` and the arrows move between fields, `Enter` goes to the next field and sends from the last, `Cmd/Ctrl+S` sends from any field, `y` or `n` answers a confirm.
- Pane settings: the arrows move between settings, `Left` / `Right` change a choice in place, `Enter` opens a field's editor.

### Linking a pane to a list

A pane that shows one ticker (`GP`, `GIP`, `OMON`, `OPX`, `SEAS`, `FA`, company news) can follow a watchlist, portfolio or scanner like the research pane. Choose **Link to** and the list's name in its pane menu (`OPX NVDA  ⧉ Linked to Watchlist`).

- It can also follow another single-ticker pane (**Link to Ticker Research AAPL**), so a desk of option panes moves with one research pane.
- **Unlink from** keeps the ticker the pane shows. If the list was empty, a linked `OMON`, `CN`, `FA`, `HP`, `SEC`, `INS`, `HDS`, `ANR`, `EVT` or `EE` pane has no ticker to keep and closes.
- Typing `OPX AAPL` while a linked OPX is open opens a separate pane.

### Move to New Layout

Takes the focused pane out of its layout into a new layout tab named after it (`Chart: NVDA`), where it fills the window. Use `Ctrl+Shift+N` (`Cmd+Shift+N` in the macOS desktop app), the pane menu or the command bar. In the browser `Ctrl+Shift+N` opens a private window, so use the pane menu.

**Move Back to** in the pane menu, or the same shortcut while the pane is alone, returns it to its place and removes the empty layout (if that layout was deleted, the pane docks in the first other tab). The pane keeps its ticker, tab, settings and lock.

### Resizing

Drag the line between docked panes, or a floating pane's bottom-right corner (any edge or corner on the desktop and web).

### Docs inside the app

The `?` beside a pane's `...` opens that pane's entry in `DOCS`: the gloom.sh docs and Academy lessons, with what the function is, an example and the lesson that teaches it. Docs read offline from the copy the app ships.

- `DOCS` alone searches every function, page and lesson. `DOCS OMON` opens one entry.
- `Esc` goes back, `o` opens the page on gloom.sh, `F1` opens the focused pane's help card and `Enter` reads its docs. In a popped-out desktop window the `?` shows the help card.

```bash
gloom fn DOCS OMON   # the whole page, wrapped to the terminal
gloom fn DOCS        # the index, cut at the first screen (it says so)
```

A name with no entry fails with `No docs entry for zzzz.` and points at `gloom fn DOCS`.

Wide tables keep their columns in narrow panes. Use the horizontal scrollbar or wheel, or `Ctrl+Left` / `Ctrl+Right`. In the terminal, a header that ends in `more →` has columns past its right edge, and a click on it moves right. With no room for the words it reads `more` or `→`; it never hides a column.

### Custom keybindings

Every global and pane management key can be moved, and any command bar text can be put on a key.

- `HELP` > Shortcuts: press Enter on a row (or double-click) to capture the next chord. `x` unbinds, `0` restores the default, `N` starts a command binding. Typing a command such as `DES AAPL` in the command bar also offers a `Bind a key` row.
- A chord a built-in action already uses (`Ctrl+P` for the command bar, `Ctrl+W` to close a pane, `Q` to quit) is refused with the action it belongs to (`Ctrl+P is taken: Open the command bar.`), and the capture waits for another key. Unbind or move that action first to free its key. `gloom config set keybindings...` refuses such a chord with the same message and saves nothing; since the table serves the terminal and the desktop app, a key either one's built-in action uses (`Q` quits the terminal) stays taken. A plugin's shortcut is not protected: the capture binds and says `Also bound to` it.
- Where the backtick is a dead key, type after `Ctrl+P` to search symbols, or rebind ticker search.

The table lives in `config.json` and the CLI:

```bash
gloom config get keybindings
gloom config set keybindings.actions.ticker-search "Ctrl+T"
gloom config set keybindings.actions.help null
gloom config set keybindings.actions.ticker-search default
gloom config set keybindings.commands.Alt+1 "DES AAPL"
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

Chords use `Ctrl`, `Cmd`, `Alt`, `Shift` and `CmdOrCtrl` (Control in the terminal, Command on a Mac desktop), then a key (`K`, `,`, `` ` ``, `Tab`, `F5`).

- Action ids are listed by `gloom config get keybindings`. Plugin shortcuts use `plugin:<shortcut id>`.
- A command binding runs its text as typed and needs a modifier or a function key. Control chords yield to a focused text field.
- Bindings are per machine and not synced. A binding that does not parse or lands on a taken key is reported at launch and in Help > Shortcuts.

## Command Reference

Use `HELP` inside Gloom for the live shortcut list. The common command-bar prefixes are listed here. The command bar leads with **Start Here** (common first tasks in plain words, each with its code) for its first ten opens, and Help's Basics tab starts with **Try These** (`DES AAPL`, `GP NVDA`, `CMP AAPL MSFT`).

### Searching by asset class

Text that no command claims searches symbols and names. Every result carries its class:

| Class | Means |
|-------|-------|
| `EQ` | Equity (receipts, preferred shares and partnership units included) |
| `ETF` | Exchange-traded fund |
| `FUND` | Any other fund (mutual, closed-end or money-market) |
| `CUR` | Currency pair |
| `CRYP` | Coin |
| `FUT` | Future |
| `IDX` | Index |
| `OPT` | Option |
| `DERIV` | Other derivatives |

End a search with one of those codes, other than `DERIV`, to keep only that class, in ticker search (`` ` ``) and after `DES`: `ES FUT` finds the E-mini S&P 500 future rather than Eversource, and `EURUSD CUR`, `BTC CRYP`, `SPY ETF`, `S&P 500 IDX` work the same (`AAPL OPT` lists contracts when a connected broker returns them).

- `CUR` keeps coins as well (`BTC CUR`), and `FUND` keeps exchange-traded funds as well.
- For `FUT`, `CUR`, `CRYP` and `IDX`, a bare symbol is also looked up in its market spelling (`ES=F`, `EURUSD=X`, `BTC-USD`, `^GSPC`).
- A code on its own, or first, is not a filter: `EQ` searches that symbol, and `FUT`, `CRYP` and `ETF SPY` open their panes.

A symbol that trades in several places lists its exchanges after a colon. `NET:` shows each one, your saved listing first, and a symbol several companies use lists them all (`CAR:` offers CAR Group on ASX as well as Avis and Carrefour). Letters after the colon narrow the list (`NET:L`), and `NET:XLON` names one listing.

Enter on a typed symbol or ticker command uses the standard listing resolution (`DES HFC` opens the former US listing and shows its move to DINO, as `quote HFC` does). To choose another listing, use the arrow keys or click a search row. A saved symbol keeps its saved listing.

When Gloom Cloud is too busy to search, the list says `Search is busy` rather than `No matches`, and saved tickers that match still show. `gloom search` and any command that looks a symbol up through search (`quote "Eagle Bulk"`, `watchlist add`) fails with `Search is busy, try again in a moment.` and exits 1 (`--json`: `code` `search_busy`, `retryable` `true`).

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
| `HP <ticker>` | Historical OHLCV prices, daily bars over 3M to start. The range sets the bar size (5Y weekly, ALL monthly) and the newest bar reads `DTD`, `WTD` or `MTD` while it runs |
| `GF <tickers>` | Fundamental statement graph |
| `GE <tickers>` | Valuation multiple graph |
| `GR <tickers>` | Ratio, rolling correlation and regression of two tickers (`GR GC=F SI=F`) |
| `EE <ticker>` | Events view with earnings and revenue estimates |
| `ERN [tickers]` | Earnings history with implied and realized moves. Several tickers, their upcoming reports. Nothing active, the market's report days |
| `EVTS [ticker]` | The market's report days with implied and average moves, and each report's actual, surprise and move so far |
| `SRCH [query]` | Full-text search across earnings call transcripts, news, and SEC filings |
| `CALLS [ticker]` | Earnings calls and their transcripts; alone, the calendar of every company's calls |
| `JOBS [ticker]` | Hiring from the company's careers system; alone, every covered company |
| `QQ <tickers>` | Ticker quote monitor |
| `CMP <tickers>` | Normalized price comparison (`fn CMP LMT RTX --range YTD`). A leveraged or inverse fund adds its daily objective and decay, see [Leveraged and inverse funds](#leveraged-and-inverse-funds) |
| `CORR <tickers>` | Return correlations; `GEO:<name>` adds a map series (`CORR FRO, STNG, GEO:HORMUZ`) |
| `ANR <ticker>` | Analyst targets and ratings |
| `DIAG <ticker>` | Equity Diagnostic with cited flags and anomalies |
| `SEC <ticker>` | SEC filings and company disclosures |
| `OMON <ticker>` | Options chain, expected moves, 25-delta skew and term slope. **Strikes** in the bar lists every strike, a count either side of the money, or a delta band ([method](research-data.md#omon-strike-window-and-carry)) |
| `OVDV <ticker>` | Rotatable 3D implied-volatility surface by delta or moneyness, smiles, term structure, skew and forwards |
| `OPX [ticker]` / `GEX [ticker]` | Open interest by strike and expiry with max pain, and dealer gamma with its flip level and walls. `GEX` opens on the gamma tab, `MAXPAIN` is `OPX`. SPY with no ticker ([method](options-positioning.md)) |
| `HVG <ticker>` | Realized volatility by estimator and window, price, and current ATM IV |
| `HVT <ticker>` | Volatility cone, current estimates and historical percentiles |
| `SEAS <ticker>` | Seasonality: monthly returns by year, average and hit rate, year overlays, weekday and turn-of-month returns |
| `RIPL [tickers]` | Earnings Ripple: customers and suppliers of your holdings (or the named tickers) reporting in the next 30 days, with the disclosed revenue share. Pro adds companies two hops away |
| `ADR <ticker>` | A depositary receipt beside its home listing (GGAL and GGAL.BA, TSM and 2330.TW): the ratio, both prices with their times, the implied dollar rate (home × ratio / ADR, the CCL rate for an Argentine pair), spot and the premium or discount. Opens DES on its ADR vs Home tab, which shows for listings with a known pair |
| `RDCF <ticker>` | Reverse DCF: the ten-year free cash flow growth the enterprise value prices in, against past growth, by discount rate |
| `PEB <ticker>` | P/E band: weekly price against round multiples of trailing EPS, today's P/E and its percentile |
| `MDAY <ticker>` | Macro-day reaction: average absolute and signed move and up share on CPI, jobs, FOMC and Brazil IPCA days against a normal day, with each day's actual, forecast and prior |
| `HIVG <ticker>` | Implied volatility history against realized, with IV rank and percentile |
| `VCA [tickers]` | Rich/cheap implied volatility across a list: IV rank, percentile, term slope, skew, IV/HV |
| `OSA <ticker>` | Multi-leg option positions, scenario P&L, payoff charts and aggregate Greeks, with a hedge budget, a collar or a cash-secured put |
| `CSP <tickers>` | Cash-secured puts across a list, ranked by annualised yield at the bid |
| `OVME` | Option calculator: European Black-Scholes or American pricing, discrete dividends, Greeks, implied and surface volatility |
| `HDS <ticker>` | Institutional holders, and 13D/13G beneficial owners over 5% |
| `DVD <ticker>` | Dividend yield and history; several tickers rank in one table by yield |
| `SI <ticker>` | Short interest |
| `SIV <ticker>` | FINRA daily off-exchange short-volume ratio, history and percentile |
| `SIW [tickers]` | Short squeeze watch across your portfolios and watchlists: short interest as a share of float, days to cover, change since the prior settlement and the 1M move |
| `BUZZ <ticker>` | Daily posts on X naming the cashtag, the 30-day median, top posts and their stance |
| `13F [fund/ticker/CIK]` | 13F fund filings and holdings |
| `INS [ticker]` | Insider activity. Alone, the companies whose insiders are buying or selling in the open market |
| `EVT <ticker>` | Corporate actions, earnings, and estimates |
| `RV <tickers>` | Relative valuation |

#### Company function notes

- **`GR`:** beta and alpha regress the first ticker's daily returns on the second's and say so (`EQT on UNG: beta`). Text prints the rolling correlation to three decimals, `--json` and `--csv` keep every digit.
- **`ERN`:** the bar's Range looks back or ahead, as in `EVTS`. Names narrows the reports to Mine, one portfolio or watchlist, a broad sector, or an industry. Sectors and industries are grouped separately, with each fund named beside its group.
- **`EVTS`:** a ticker selects its row and its report says whether it is on the board (`ERN <ticker>` has its own dates). The bar's Range gives a week (`gloom fn EVTS --week last`, `this` or `next`), or one day (`--date 2026-10-15`) whose reports carry their actuals and surprises. The default is today, the next session and the rest of its week.
- **`CALLS`:** with a ticker, the company's calls, the next one on its own line with its start here and in New York. Alone, the calendar of every company's calls today, the next session and the rest of the week. `--view transcripts` lists the latest transcribed calls instead.
- **`DVD`:** `gloom fn DVD KO PEP JNJ` ranks several tickers by yield, with payout, growth, last ex-date and pay date. A bond fund's SEC yield sits beside its distribution yield, and `gloom fn DVD MUB --tax-rate 40.8` adds a muni fund's tax-equivalent yield and muni/Treasury ratio ([research data](research-data.md#bond-funds-sec-yield-tax-equivalent-yield-and-the-munitreasury-ratio)).

**The `ERN` calendar** (desktop and web):

- The bar's Names filter narrows the table and the calendar alike. It offers Mine, each portfolio and watchlist, the sector funds `SECT` charts, and nine industry funds: semiconductors (SOXX), pharmaceuticals (XPH), biotech (XBI), aerospace & defense (ITA), regional banks (KRE), software (IGV), retail (XRT), homebuilders (XHB), and oil & gas exploration (XOP). The terminal offers the same Names choices in its table.
- Calendar shows a week, a column per day, with companies reporting before the open and after the close as logos, largest first (green or red once reported, by surprise). Range picks the week, from last week to three weeks ahead, and `+N more` shows the rest of a busy day.
- Enter or a second click opens a company's reports, and `n` sets an `ALRT` earnings alert on it.

#### Which tabs Ticker Research shows

Ticker Research shows the tabs that can have data for the instrument.

| Instrument | Tabs |
|------------|------|
| Stocks | The company tabs: analyst coverage, diagnostic, earnings calls, executives, filings, risk factors, hiring, holders, insider and short interest |
| Funds | Events, dividends and congress trades. Options and 13F stay for ETFs, closed-end funds and funds of unknown subtype |
| Coins, currency pairs, indices | Overview, chart, news and notes |

- Options also stays for indices, futures and option contracts. Explicitly classified mutual funds and money-market funds hide Options and 13F.
- Tabs sourced from SEC, FINRA and congressional filings are hidden for listings outside the US.

#### Extended hours on the headline

The Overview headline is the regular session, with one extra line for the extended-hours price. After the close the headline stays at the official close and the After-Hours line under it gives the latest extended-hours price and its move from that close. In pre-market the headline is the last session's close, and only the Pre-Market line changes.

`gloom ticker` and the `QQ` cards (`AH` or `PM` where narrow) report it the same way, and `quote`, `compare` and `fn QQ` add an After Hours or Pre-Market column when a row has one. In `--json`, `price`, `change` and `changePercent` are the headline, and `extendedSession` (`PRE` or `POST`), `extendedPrice`, `extendedChange` and `extendedChangePercent` are the extended print, null without one.

#### Overnight session

From 20:00 to 04:00 New York, Sunday night to Friday morning, a US listing still trades on an alternative venue while its exchange is closed. With real-time data the price is that session's last trade, or the midpoint of its bid and ask while nothing has traded. The headline stays the completed regular session, with an Overnight line under it (`Overnight mid` for a midpoint).

The session reads `OVERNIGHT` (`ON` on a narrow `QQ` card or a heat map tile). `quote` and the portfolio and watchlist reports give it an Overnight column (`mid` after a midpoint), and `extendedSession` reads `OVERNIGHT` in `--json`. Delayed data has no overnight session, and the pre-market takes over at 04:00.

#### Stale quotes

A quote whose last print is older than its venue's latest completed regular session reads `STALE` in the warning color, in `quote`, `compare`, the `ticker` header, the Ticker Research overview and the boards' session column.

- **Pre-market with nothing traded yet:** a quote that carries the last session's close reads as that close (`Thu close`), with `Updated` and the report's as-of at that close's time and no Pre-Market figure. The first pre-market trade makes it `PRE-MKT`. A pre-market price of 0 is never shown.
- **No prints in an open session:** when the venue's calendar says a session is open and nothing has printed in it yet, a stalled feed and a closure the calendar does not list (TWSE's typhoon days) read alike. `gloom quote` adds `2330.TW (Taiwan Semiconductor Manufacturing Company Limited): no prints today since Thu 22 Oct 05:30 UTC (20h 50m old)` under the table, and the Ticker Research footer reads `No prints today since 2026-10-22 05:30Z`.
- Exports keep the state: `session` stays `PRE-MKT`, `sessionLabel` is what the Session column shows (`Thu close`), and `updatedAt` is when the price Last shows was observed.

#### What a change is measured from

Every change line says what its move is measured from, in muted words after it: the Overview headline, `ticker`'s Change line, `quote` and `compare` (a Chg Basis column), the portfolio header's Day (a watchlist's Avg Day) and the `Day's move` line of `portfolio show --close`.

- **Listings:** the close of the venue's previous session, dated by its calendar (`vs Fri 16 Oct close`), with a line under it naming the days the venue was shut (`HKEX closed Mon 19 Oct, holiday`). On a venue with no holiday calendar (most of Europe), the close is dated by the listing's own daily closes, on every surface above: the latest one before the move's session, when it is the quote's previous close (`SHEL.L` and `NESTE.HE` read `vs Thu 22 Oct close`). They are read once per listing and session from the data providers (a connected broker is not asked for them), so a refresh asks for nothing more. The app never holds a quote for them: a pane that shows a listing before they arrive reads `vs prev close` until its next update, which a live quote brings at once. The CLI waits up to a few seconds for them, and only in commands that print the basis (`quote`, `compare`, `ticker`, `portfolio show --close`). Where those closes do not settle it, the line reads `vs prev close`, never a guessed date.
- **Futures:** the settlement or last trade their terms name (`vs Thu 15 Oct settle`), otherwise `vs prev close`.
- **Coins:** since 00:00 UTC, the previous UTC day's close. A coin whose close cannot be dated to the last two days reads `24h`, and a perpetual always does.
- **Totals** over moves from different closes (an HKEX listing beside a US one) read `vs mixed closes`.

In exports, `--csv` and `--ndjson` rows add `Chg Basis` and `Chg Basis Note` (`changeBasis`, `changeBasisNote`). In `--json`, `quote` and `compare` add `changeBasis` (`kind`, `date`, the `closed` days, `label`, `note`) to each row, `quote` adds `previousCloseDate`, and `portfolio show --close` adds `dayChangeBasis`. A quote with no comparison shows its price without a change.

#### Market boards

After the close and through a weekend, the boards' Last and change agree with `gloom ticker`.

- `sectors`, `indices` and `movers` (every list), and `fn BI`, `fn WEI` and `fn MOST`, give an extended print an After Hours or Pre-Market column when a row has one, and the four `extended` fields in `--json`. `WEI`, `FUT` and the `GPU` equities board show the regular session and no extended column.
- After the close, Gainers and Losers rank by the regular session's move. `gloom movers gainers --session extended` (or `losers`) ranks by the pre-market or after-hours move from that close instead. The line above the table names the ranking (`Ranked by the regular-session move`, `Ranked by the after-hours move`, `Ranked by volume`), as `metadata.rankedBy` does in `--json`.
- In the `MOST` pane, click the `AFTER-HRS` or `PRE-MKT` header to sort by the extended move. A narrow `BI` pane gives up the move bar and then the extended column before cutting a sector's name, and a narrow `MOST` gives up MCAP and then 52W%.
- The header's SPY is in dollars (`SPY $759.97 -0.52%`), and your base currency follows it under its own label (`base THB`), which a narrow header drops before the market state.
- The header's SPY is the regular close once the market is closed. While the pre-market or after-hours session is open it is that session's price and move beside the `PRE-MKT` or `AFTER-HRS` label. The pre-market countdown says `to regular open` and counts to 09:30 New York time (a narrow header hides it when its full label does not fit).

**Trending quotes that fail to load.** The `MOST` Trending list and `fn MOST --list trending` name symbols whose quotes could not be loaded. If none load, the pane keeps its previous rows marked stale, and JSON reports set `complete: false` and list `unavailableSymbols` and `errors`.

#### THEM

Outside the regular session `THEM` shows each member's last regular close and move, as `ticker` does, and its 1W, 1M, 3M and YTD end at that close (YTD measured from the prior year's last close, `YTD vs 31 Dec close`). A pre-market or after-hours print gets its own column and never enters a return. The footer names the close and the snapshot's age (`Fri 9 Oct close · snapshot 12m ago`).

`--json`: `metadata.asOf` is that close, with `snapshotAssembledAt`, `snapshotAgeMinutes` and `regularSessionDate`, and each member adds the four `extended` fields.

With Pro, `THEM` prices members and themes from real-time quotes: the footer reads `live · snapshot 3m ago` while a session trades, the pane refreshes every 15 seconds, and `fn THEM` reports `live`. Outside the session the footer names the close and `fn THEM` is as of it, with no feed named (`US trading day Fri 23 Oct 2026 close · markets closed until Mon`). Otherwise the board is fifteen minutes delayed. `MOST`'s Gainers, Losers and Most Active, and `movers`, read the real-time lists and say `live`.

#### Valuation figures after the close

From the close until the next open (overnight, weekend, pre-market), every figure measured at the price uses the regular close, so a P/E times its EPS is the close, never an extended print. That covers `RV`, `valuation`, `fundamentals`, `ticker`, `DES`, the `PF` and watchlist MCAP, P/E and yield columns, `ANR`'s upside, `DVD`'s yield, `PEB`, `RDCF` and `GE`. While the session trades, they follow the live price.

- The `RV` pane has a `PRE-MKT`, `AFTER-HRS` or `OVERNIGHT` column after CHG% while a peer has one, and `gloom fn RV` a Pre-Market, After Hours or Overnight column. Its `--json` and `--csv` carry `changePercent` and `marketCap`, in each peer's own currency (`marketCapCurrency`) or the one `--currency` asks for ([research data](research-data.md#relative-valuation-peers-columns-and-currency)).
- `valuation` starts with Last, Change and, when there is one, the extended print. Its `--json` adds `price`, `change`, `changePercent`, the four `extended` fields, `marketCap` and `marketCapCurrency`.
- `fn RV --csv` has one header in every market state: Last as a plain number in each peer's own currency (named per row in `currency_or_unit`, its ticker in `symbol_or_series`), then each session's print and move (`Pre-Market`, `Pre-Market Chg%`, `After Hours`, `After Hours Chg%`, `Overnight`, `Overnight Chg%`), empty for a peer with none, and `Mkt Cap` followed by `Mkt Cap unit`.

#### Portfolio and watchlist reports

`portfolio show` and `watchlist show` read the quote as the `PF` pane does: Last and Chg are the regular close and its move after the close, with an After Hours or Pre-Market column when a holding has one. Value and P&L are priced at the latest print unless you ask for the regular close; see [What a portfolio is priced at](#what-a-portfolio-is-priced-at).

- A portfolio's `--json` puts Last in `quotePrice` and adds the four `extended` fields (`fn PF` reports `price` and `changePercent` the same way).
- `watchlist show --csv` and `--json` print one row per ticker, as raw numbers: `symbol`, `listing`, `name`, `exchange`, `kind`, `currency`, `price`, `change`, `changePercent`, the four `extended` fields, `volume`, `quoteAsOf`, `stale` and `lastTradeDate`. `marketCap` is in your base currency (`marketCapCurrency`), and `fundingRate8h` appears only when the list holds perpetual markets.
- A list holding a stale quote adds a Last Trade column (`STALE 2023-03-09`) and a line naming them. Funds and indices have no Mkt Cap (a note names them). A list holding a perpetual market adds a Fund 8H column.

#### Earnings-call exports

Earnings-call exports and fiscal-quarter lookup inspect at most the latest 200 calls in the requested scope (the interactive list loads 50). When a response fills that limit, exports report `sourceLimitReached: true`, `complete: false` and `truncated: true`: more calls may exist, and a missing quarter is not proof the company had no such call. `totalIsExact: false` marks capped, pending or stale results.

#### 13F

The ticker research `13F` tab shows fund positions for the ticker: reported value, shares, weight and quarter action. Open a row for its fund detail, and scroll to page more funds. `m` or the Mine filter limits positions to portfolio and watchlist tickers. The `13F` pane's Crowding tab ranks new positions, exits, and weight increases or decreases across the top 25 ranked funds.

```bash
gloom fn 13F AAPL --view=ticker-holdings --offset=0 --json   # a ticker argument defaults to this view
gloom fn 13F AAPL --view=by-ticker                           # the holders' whole 13F books
gloom fn 13F --view=crowding --json
gloom fn 13F MU --view=crowding                              # that ticker's rank in the crowding sample, or says it is not in it
```

The text report opens with the quarters compared, the holder, new and exited counts, and, when the list is longer than `--limit`, which funds are shown and the `--offset` that continues it. `--json` carries `shown`, `total`, `truncated` and `nextOffset`. Headless crowding accepts `--rank=new`, `--rank=exits`, `--rank=increases` or `--rank=decreases`.

A ticker reads as one in any case (`fn 13F aapl`, `brk.b` and `BRK-B` list the holders as `AAPL` and `BRK.B` do). A lowercase word that is also in a filer's name, such as `ares`, lists the ticker's holders and adds the command that opens the fund, and a ticker-shaped word with no 13F holders, such as `tiger`, is searched as a fund name.

#### HDS

`HDS` has three tabs:

- **Table** and **Chart** show the 13F institutional holders. On a home line abroad such as `BHP:LSE`, values are in the currency the report names, and a row held as US depositary receipts carries an `ADR` badge.
- **13D/G** shows who disclosed more than 5% of the class on Schedule 13D (activists) or 13G (passive holders) in the last four years, one row per filer (`+N` for others on the report). A row shows the latest report's form, the percent of class as filed, the change in points against the previous report, shares, event and filing dates, and the latest 13F move in the ticker (NEW, the share change, EXIT, or a dash).

The latest report is the filer's latest disclosure, not its position today. A stake reported under 5% keeps its percentage, marked `<5%` where there is room, and sorts after the 5% holders. Reports of zero are marked `EXIT`. Enter opens the filing in the SEC pane and `o` opens it on EDGAR.

```bash
gloom holders CAR --form all      # `13d` or `13g` for one kind; `--history` for every report instead of the latest per filer
gloom fn HDS CAR --form all --json
gloom filings CAR --form 13G      # the filings themselves
```

#### 13F fund detail: Overlap and Performance

**Overlap.** In a 13F fund detail, open Overlap, search a second fund by name or CIK (or an ETF MEMB covers, by ticker, such as `SPY`), and select it to compare shared positions and weights. Against an ETF it shows the overlap and active share.

```bash
gloom fn 13F 0001067983 --compare=0001037389 --json   # --compare implies --view=overlap
gloom fn 13F 0001067983 --compare SPY                 # a fund against an ETF's holdings file
```

- `--compare SPY` compares the manager's latest 13F with the ETF's holdings file (the one `fn MEMB SPY` shows). It prints the overlap and the active share, the quarter compared with its filing date and the holdings file's date, and the manager's positions the ETF does not hold, largest first.
- A word that reads as a ticker (up to five letters, with an optional class such as `BRK.B`) is an ETF when MEMB covers it, otherwise a manager only by its exact name, so `SPY` is not Spyglass Capital. A CIK or a longer name is a manager lookup, and the report says which was used.
- MEMB covers IVV (also read for SPY and SPX), IJH, IJR, IWM and IWB. Any other ticker, such as `VTV`, fails with that list.
- `--view=overlap` without `--compare` asks for it. `--compare` with another view fails.

**Performance.** `gloom fn 13F 0001067983 --view performance` prints that fund's own row, with the `portfolio import --13f` command that copies its basket.

- The return is the ranking's when the ranking gives one, otherwise an estimate from the fund's last two filings (Est P&L of the positions held through the quarter over their value at its start), and the estimate's note says why.
- The ranking holds at most 100 funds (a larger `--limit` is read as 100 and says so).

**Splits.** A line whose shares and value per share moved inversely by about the same ratio between filings (10x the shares at a tenth of the price) is checked against its corporate actions:

- A split between the quarter ends is priced on split-adjusted shares, so a line cut after a 10:1 split reads as a trim, not an add.
- A line with no split is a trade and priced as it is, and one whose actions cannot be read is left out (Est P&L shows `--`).
- A ticker its company has left (BK became BNY) is looked up under the symbol the company trades as now.

**Late filers.** A manager with no 13F for the newest quarter past its deadline (45 days after quarter end) is flagged in a fund search (`fn 13F Pershing`, for the first 10 such funds), in the fund's holdings and filings reports, and under a fund in the 13F pane:

- `No 13F for Q2 2026, due 14 Aug`
- When EDGAR shows a 13F-NT: `13F-NT for Q2 2026, filed 14 Aug; holdings reported by PERSHING SQUARE INC. | open: fn 13F 0002026053`
- When EDGAR could not be asked, the line says only that the loaded filings lack the quarter and that EDGAR was not checked.

### Chart Composer

`G`, `GP`, `GIP`, `CMP`, `GF` and `GE` open the same chart composer with different starting presets.

#### The data catalog

`CAT` opens the data catalog: every series a chart can draw, so you can graph one without typing the expression.

- Tabs group the series: securities and options fields, crypto, futures, rates and government bonds, credit spreads and CDS, economic data, inflation, FX, energy inventories, volatility, Fear & Greed, positioning (COT, short interest), valuation, alternative data and your own files.
- Each row gives the unit, update frequency, publisher and the expression to type. Search matches every word across those columns, and typing a ticker such as `AAPL` fills in every series that takes one.
- `g` charts the selected row, asking for a ticker first when needed. The composer's Series search finds the same entries.
- Series from Pro datasets (research attention, hiring, app attention, GPU rental indexes, government awards, perpetuals) need Pro, and the chart says so in place of the line.

#### Custom expressions

A custom expression can mix unrelated sources on one timeline:

```text
G AAPL:price, MSFT:revenue, FRED:CPIAUCSL
G GAA/VOO
G MSFT:revenue / AAPL:revenue
```

Series are separated by commas, and tickers separated by spaces are a list too: `fn G AAPL MSFT` charts both, as `fn G AAPL,MSFT` does. Words that are one thing, not tickers side by side, are refused with what to write: a Bloomberg code (`AAPL US Equity` reads as `AAPL`), a currency pair (`EUR USD` is `EUR/USD`) and a series whose field has spaces (`MSFT:net income`, one series among commas). `A/B` charts the ratio of two series and `A - B` the spread. A slash that is part of the symbol stays one series (`EUR/USD`, `BTC/USD`).

A formula adds and subtracts series, each times a number, and charts the result in the Formula panel. The number goes on either side of its series (`HO=F*42`), and only the whole formula, in brackets, is divided or multiplied by a number or a series:

```text
G "42*HO=F - CL=F"
G "(2*42*RB=F + 42*HO=F - 3*CL=F)/3"
G "(42*HO=F - BZ=F)/EURUSD=X"
G "7.45*42*HO=F - 7.45*BZ=F"
```

A futures price is in its contract's unit (heating oil and gasoline USD / gallon, crude USD / barrel), and units follow the arithmetic. A 42 turns a per-gallon series into per barrel, so the first two formulas are crack spreads in USD / barrel. A 7.45 (barrels in a tonne of gasoil) or 8.45 (gasoline) turns a per-barrel series into per tonne, so the last one is the crack in USD / tonne. Any other number is a count and keeps the unit. An FX pair is priced in its quote currency per unit of its base (`EURUSD=X` is USD / EUR), so dividing by it turns dollars into euros: the third formula is the crack in EUR / barrel, and `BZ=F / EURUSD=X` is Brent in EUR / barrel. A pair quoted the other way round is multiplied instead: `(42*HO=F - BZ=F)*USDJPY=X` is the crack in JPY / barrel, and dividing by `USDJPY=X` is refused with that fix. A series the formula is divided or multiplied by is drawn in a panel of its own. Series in different units do not add up. On one chart, prices per different physical quantities (per gallon and per barrel), or a price beside an FX rate, read on axes of their own; per-share prices and rates quoted in one currency share one. A formula prints at the precision of its legs, from two to four decimals, and to the cent once it reaches 10.

`catalog crack` lists the heating-oil and 3:2:1 cracks, and so does G's series search (`n`, then `crack`): picking one adds its legs and replaces the chart's formula.

#### Leveraged and inverse funds

`CMP` with a leveraged or inverse fund (TQQQ, SQQQ, SOXL, UVXY) draws the fund's daily objective beside it: its factor (from the sponsor's page, as `fn ETF` shows it) times the index fund's return each session, compounded (`3× daily QQQ` beside TQQQ). The index fund joins the comparison when it is not in it.

The Decay panel measures, in percentage points over the period in view:

- `TQQQ decay vs 3× daily QQQ`: the fund's return minus the daily line's (fees, financing cost and tracking).
- `3× daily QQQ decay vs 3× QQQ`: the daily line's return minus three times QQQ's. This is compounding: a fund that resets daily loses it in a market that swings and gains it in one that trends.

```text
fn CMP TQQQ,QQQ --rangePreset 1M
```

Returns are from closing prices, so they leave out distributions. The line needs daily bars: weekly or monthly bars (`--chartResolution 1wk`) or a single session leave it out, with a warning. A fund that resets monthly, or whose benchmark no fund tracks one for one, gets no line.

#### Your own series

Put a CSV file in the `series` folder of your data folder (`~/.gloomberb/series`, or the directory `gloom version` names). It appears in the catalog's **Your series** tab the next time the catalog opens, chartable against anything else, and each chart rereads the file. The web app has no file access.

- The first column is the date (`2024-03-01`, `2024-03`, `2024` or an ISO date and time). Each further column is a series, and an optional header row names them. Commas, semicolons and tabs all work as separators, and an empty or `.` cell is a missing value.
- Lines starting with `#` above the data set what the catalog shows. Without them the file name names the series, the unit is a plain number and the frequency is read off the dates.

```text
# name: Shipping index
# unit: index
# frequency: weekly
date,value
2024-01-05,1234.5
2024-01-12,1251
```

`unit` takes the values plugin series use (`%`, `bp`, `index`, `USD`, `billion USD`, `thousand barrels/day`).

#### Series and panels

Open **Series** to add, remove, reorder or hide series and choose each one's field, chart style, transform, axis, panel, period and panel scale. Price data supports candles, OHLC, HLC, line and area. Scalar data supports line, area, step, column and point. Panels can use independent left/right axes and linear or logarithmic scales.

#### Financial periods

- `GF` opens on quarterly bars. Set a series' Period to Annual (or `fn GF --period annual`) for fiscal years. A company that reports no quarterly figures, such as a semi-annual filer, says so instead of switching to annual.
- `GE` opens on fiscal years. Set Period to Quarterly (or `--period quarterly`) for the multiple on the trailing twelve months at each quarter end.
- Most US filers report no fourth-quarter EPS and charts do not reconstruct it ([research data](research-data.md#financial-statements-and-valuation)), so quarterly history usually covers only the latest few quarters.
- A saved pane keeps its period, and the legend names the fiscal period as FA's columns do (`Q3 FY26`, `FY2025`, `TTM Q3 FY26`).

#### Toolbar, indicators and alignment

The toolbar controls date ranges (preset or exact), intervals from one minute through monthly, the chart mode, technical indicators and pair formulas.

- Indicators: volume, SMA, EMA, Bollinger Bands, VWAP, anchored VWAP, volume profile, RSI, MACD, ATR and Realized Volatility (window and estimator in pane settings). Formulas: ratio, spread and rolling correlation.
- Mixed-frequency values use as-of alignment: fundamentals use filing dates when available, and sparse series carry forward only after becoming available.
- Missing publication dates show behind the warning indicator in the chart footer (click it or press `!`).

#### Bar sizes

**Bars** (`b`) lists 10m, 2h, 4h, 2D and 3D beside the sizes a source serves, and builds them from shorter bars. **Custom…** takes any count of minutes, hours, days, weeks or months (`90m`, `6h`, `5D`, `2W`, `3mo`). A capital `M` alone is refused, since it could mean minutes or months.

- Each bar takes the first open, highest high, lowest low, last close and summed volume of the bars it holds, so the last bar of a session can be shorter.
- Minute and hour bars start at the listing's session open (09:30 New York for a US stock, 17:00 Chicago for CME futures) and never span two sessions. Day bars count trading days from 1 January, week bars from the year's first Monday, month bars from January.
- A built size is saved with the pane and its share link. `fn G` and `shot G` take the same sizes as `--chartResolution`.

#### Spreads, ratios and correlation

**Spread** is the first input minus the second times its configured multiplier. It needs matching dimensions, currencies and scales, and market prices also need a declared per-unit basis (a future's is its contract's unit). An incompatible formula is unavailable and shows in the chart or report errors. No FX conversion happens, and display transforms (percent, index) are not applied before subtraction.

**Ratio** keeps derived units such as USD/EUR or 1/share and has no value at a zero denominator. When either input has unknown units, the number is still available with unit `unknown`. **Correlation** uses matching observation times when inputs have different frequencies.

#### Crosshair

Moving the crosshair along time, with the pointer or the arrow keys, reads every series at that date. The legend shows every series' value there in its own unit and returns to the latest values when the pointer leaves. A series with no observation at that time shows its last value before it, dimmed with its date.

The time charts in a layout tab share one crosshair, including the research pane's Chart tab and the time charts in other panes (IV history, a macro series, Fear & Greed, the chart above a table). While it is on one chart, the others draw their vertical line at the same time. Esc on any chart clears it everywhere.

Charts with an x axis of their own (curves, smiles, scatter plots), the overview's price chart, and charts in another layout tab or a popped-out window do not follow it.

**Pinning.** `p` on a focused chart, or `pin` in its footer, pins the crosshair where it is, and every chart in the tab holds that moment (the footer then offers `unpin`).

- While pinned, the arrow keys on any chart move the pin a bar at a time. Esc or `p` lifts it. Where `p` does something else (the correlation window in a relationship chart), use the pane menu (`.`).
- The pin belongs to the tab and goes when the last chart you can move it on closes, or the tab does.
- News feeds in the tab (`N`, `CN`, industry news) select the newest story published by the pinned moment and show later ones muted. Time and sales (`TAS`, `QR`) selects the print or quote at or just before it.

#### Pan and zoom

Dragging the plot, the scroll wheel or trackpad, and `a`/`d` or Shift with the arrow keys pan the chart, loading older bars as it moves. Where a listing's bars at the chosen interval run out, the pan stops at the first one and the footer says where they start. Choosing the range already selected, by its number key or a click, returns a panned or zoomed chart to that range, as `0` does.

Ctrl with the scroll wheel and a trackpad pinch on desktop and web zoom time around the pointer. `+`/`-` zoom from the newest bar in view. Dragging the time axis zooms the same way (left in, right out, double-click to fit).

- Each panel's value axis scales on its own: drag it up to stretch the values, down to squeeze them, or scroll over it to zoom. A panel scaled by hand stops fitting its values to the bars in view, and an `Auto` button at the foot of its axis, a double-click on the axis, or `0` fits them again.
- `0` and Reset Zoom in the pane menu fit every axis.

#### Panels, tools and legend

- **Resize:** on desktop and web, drag the line between two panels (a double-click restores the split). On a focused chart, `Shift+Up` and `Shift+Down` make the top panel a row taller or shorter (the terminal too), and the pane menu has Reset Panel Heights.
- **One panel full size:** a double-click on a panel's plot gives it the whole chart (two quick presses in the terminal). A double-click again, or the `All panels` button, shows the rest.
- **Drawing tools:** `Shift+T`, Hide Drawing Tools in the pane menu, or the chevron at the end of the tool bar folds the bar to one button.
- **Legend:** `Shift+L`, Collapse Legend in the pane menu, or the chevron in the legend's left margin folds it to the first series and a count (`+5`). A folded series still draws.

These are kept with the pane.

#### Intraday sessions

On intraday charts, bars outside the venue's regular session (pre-market, after-hours, after an early close) sit on a tinted band, and the terminal marks the regular session's start and end with a dotted rule. A venue without known hours has no band, and US intraday history covers the regular session, so the band appears where a source sends extended-hours bars.

#### Trader studies

In the Indicators dialog (`i`), the highlighted study's setting sits beside Done: Period (`p`) for SMA, EMA, Bollinger, RSI and ATR, Bands (`b`) for VWAP, Rows (`n`) for the volume profile and Anchors (`a`) for anchored VWAP.

- **VWAP** is the volume-weighted average of the typical price, (high + low + close) / 3, from each session open. It needs intraday bars, and Bands add and subtract a whole number of volume-weighted standard deviations.
  - It restarts at the venue's open: 09:30 New York for US listings, 17:00 Central the evening before for CME Group and Cboe VIX futures, and each ICE U.S. contract's published open (Coffee 04:15, Sugar 03:30, Cocoa 04:45, Orange Juice 08:00 New York, Cotton 21:00 and the dollar index 20:00 the evening before).
  - A venue without known hours restarts at local midnight, or at midnight UTC for crypto.
- **Anchored VWAP** runs the same average from bars you pick and never restarts. Turning it on, or `v` while it is on, waits for a click on a bar (or Enter at the keyboard cursor; Esc cancels). Anchors also take a date (`2026-09-30`) or an exchange time (`2026-09-30 10:00`), up to eight per chart.
- **Volume profile** spreads each bar's volume over its high-low range into equal price rows across the bars in view, so it follows pan and zoom. The busiest row is the point of control (a dotted level), and the value area grows from it until it holds 70% of the volume.
- **ATR** is Wilder's average true range in its own panel.

The volume profile and price levels need the price in its own values, not a percent or index display.

#### Price levels

The level tool (`Shift+H`, or `═` in the chart toolbar) draws horizontal price levels that belong to the ticker, not the pane. Every chart of that listing shows them and they sync with your account.

- With the tool in hand, a click adds a level, dragging moves it, and Enter adds one at the keyboard cursor's price. `[` and `]` pick one, Up and Down move it, Backspace or Delete deletes it. With no tool in hand a click on one of yours picks it.
- `Shift+A` on a level sets an ALRT price alert there: above when the level is over the current quote, below when it is under, crosses when it is on it. Levels with an alert, and active alerts on the ticker set elsewhere, draw in red. Change an alert's own line in ALRT.
- With the order ticket beside the chart, its order and draft lines also move with a plain drag, and the level keys move them too. A working order's move opens its change in the ticket for review ([trading](trading.md#trade-from-the-chart)).

#### Session low and high

`gloom fn GIP <ticker>` ends with the session's low and high and the UTC time each traded (`USDT-USD:CCC session low  0.99833 at 2026-10-17 11:30 UTC`; over several sessions they read low and high). `GIP` dates sessions on the listing's exchange clock, read from its exchange or its suffix (`RMS.AX` is the ASX). A bare symbol with no known exchange is dated in UTC.

A US listing's bars are the regular session only, from the 09:30 New York open, and the report says so (in `--csv`, as a `# note:` line): an 08:30 release falls before its first bar. `--csv` writes each price as the decimal it traded at (`85.1`, not the feed's `85.099998`; a sub-penny print such as `86.3775` stays), under `Open,High,Low,Close,Volume` with no `Value` column repeating Close; `--json` keeps `value` beside `close`.

A zero or negative price is kept for a futures instrument. For any other instrument a nonpositive close in the window makes the result unavailable, and JSON metadata keeps the rejected values and dates in `intradayPriceDomainFailures`.

### Markets, News, and Macro

| Shortcut | Function |
|----------|----------|
| `TOP` | The 20 top-ranked market stories |
| `HM` | Market heatmap of the 500 largest US stocks by sector and industry, large US ETFs, and the portfolio pane's selected list |
| `MOST` | Top gainers, losers, most active, and trending tickers |
| `HILO` | Session new highs and new lows with 30s/1m/5m momentum |
| `SCAN` | Your own live intraday scan of US stocks: moves, volume spikes, new highs and lows, VWAP crosses and gaps, with alerts ([Live scanner](#live-scanner)) |
| `FLOW` | Unusual options activity: sweeps, blocks and large premium. Vol/OI divides the contract's day volume by its latest open interest |
| `PM <query>` | Polymarket and Kalshi prediction data ([Prediction Markets plugin](https://github.com/gloom-sh/gloom-prediction-markets)) |
| `N` | News feed |
| `CN <ticker>` | Ticker news |
| `NI [code]` | News by topic: `MNA`, `CB` (central banks), `ENERGY`, `METALS` (metal prices, futures and bullion, not miners' releases), `REG`, `CRYPTO`, `EARN`, `IPO`, or a sector: `TECH`, `FIN`, `HEALTH`, `INDU`, `CONSD`, `CONSS`, `COMMS`, `MATS`, `UTIL`. `LTR` lists public fund and investor letters as links |
| `SUB` | Authenticated Substack reader feed ([Substack plugin](https://github.com/gloom-sh/gloom-substack)) |
| `FIRST` | Breaking news |
| `TWIT <query>` | Ticker-related market posts |
| `TBO` | TheBuildout infrastructure intelligence |
| `CG` | Congress trading disclosures |
| `WEI` | Global equity indices |
| `MAP` | World map with trading venues, country names and layers (`MAP venues` for venues alone) |
| `TAS <ticker>` | Time and sales: trade prints, observed-window VWAP and large prints |
| `QR <ticker>` | Quote recap: NBBO history with sizes, venues and spread (the same pane on its NBBO tab) |
| `EM <ticker>` / `EEO <ticker>` | EPS estimate revisions, analyst breadth and surprises. `--period YYYY-MM-DD --frequency quarterly` pins a fiscal period |
| `KPIS <ticker>` | Company operating KPI tables, charts, revisions and verbatim evidence (Pro, Free preview) |
| `GUIDE <ticker>` | Structured management ranges, raise/cut tracking and later actual versus guide (Pro, Free preview) |
| `GUID <ticker>` | Company EPS guidance cited from filings and transcripts, against consensus (the Guidance tab of `GUIDE`) |
| `FUT` | Futures quote aliases across index, equity sectors, rates, energy, metals, grains and softs, livestock, and FX |
| `RRG` / `GRR` | Weekly relative rotation of sectors or a watchlist against a benchmark, with dated trails |
| `BT <ticker>` / `BTST <ticker>` | Backtest a long-only indicator rule on daily history against buy-and-hold |
| `EQS` | Equity screener over the stored Cloud universe: valuation, growth, margins, short interest, insider and 13F criteria, saved screens and export |
| `PERP [market]` | Perpetual funding, open interest and premiums: a board, rankings and one asset across venues (Pro history; free preview) |
| `CRYP` | Top crypto assets by market cap with live prices, 7D, 30D and 1Y returns, 24h volume and market cap. Stablecoins have their own tab |
| `ETFF` | Daily net flows of the US spot bitcoin and ether ETFs, fund by fund in US$ millions, with the last 5 and 20 days and the running total since launch |
| `ECO` | Economic events and releases, grouped by day and timed in UTC. Opens on high-impact releases until you pick another impact; the footer counts the lower-impact releases left out (most PMIs among them), and `Shift+F` or `fn ECO --impact all` lists them |
| `ECST [statistic]` | Economic statistics: inflation, labour, growth, consumer, housing, rates |
| `GC [curve] [date]` | Government yield curves (UST, TIPS real, breakeven, euro AAA, Bund, Gilt, JGB, Canada) with spreads and percentiles, a compare date, the one-year-forward curve, a World tab and USD SOFR Swaps. CLI: `--curve`, `--date`, `--compare 1D` (or 1W, 1M, 3M, 1Y, or a date), `--tab world`, or `--tab swaps --tenor 10Y` |
| `WIRP` / `FFIP` | Fed funds futures implied FOMC path, conditional target probabilities, SOFR contracts and Fed projections |
| `BTMM` | Money markets: funding rates, Treasury bill curves and Federal Reserve liquidity |
| `YAS` | Fixed-coupon bond calculator: price/yield, accrued interest, duration, convexity, DV01 and Treasury spread |
| `TRACE [issuer, symbol or CUSIP]` | FINRA corporate and agency bond last sales. Alone, the latest prints market-wide |
| `CBR` / `ECFC` / `CBRT` | Policy rates of the G20, SNB, Norges Bank, Riksbank and RBNZ, last observed moves and one-year history |
| `CTM [root]` | Futures contract curve, historical ghosts, roll yield and open interest, including `CTM VX` and CME crypto (`CTM BTC` adds each contract's premium to spot and annualised basis, `(Last / spot - 1) × 365 / days to expiry`) |
| `COT [code or name]` / `CFTC [code or name]` | CFTC positioning extremes, weekly changes and historical percentiles, by root or commodity name (`COT KC`, `COT coffee`), including CME crypto (`COT BTC`) |
| `AUCT [search]` | Treasury auction results: auction rate (a TIPS rate is a real yield and an FRN's a spread in bp), stop-out versus average, bid-to-cover, indirect, direct and dealer takedown, and size |
| `VIX` | VIX 9D through 1Y cash-tenor curve, VIX and VIX 3M history and the 3M/30D ratio |
| `VOLS` | Cross-asset volatility indices, daily changes and one-year percentiles |
| `CRD` | Credit spreads |
| `VAL [indicator]` | Whole-market valuation: Buffett, CAPE, excess CAPE yield, Tobin Q, investor equity allocation, dividend yield, margin debt, cap/profits, cap/M2 |
| `CDS [ticker]` | Single-name corporate CDS: the issuers traded in the last 5 days, or one issuer's 5Y spread, history and trades |
| `IPO` | Upcoming and recent IPOs worldwide |
| `HALT` | US trading halts with reason and resumption times |
| `DIST` | Distress records: 8-K bankruptcy, obligation and listing filings, going-concern disclosures, Taiwan listing designations, French and UK insolvency notices ([details](distress-monitor.md)) |
| `TV` | Live business news television ([TV plugin](https://github.com/gloom-sh/gloom-tv)) |
| `BI` | S&P 500 sector performance |
| `THEM [theme]` | Thematic baskets with equal-weight returns and breadth, and each theme's members (the Themes tab of `BI`) |
| `MEMB <fund>` | ETF holdings with weights, member returns, daily contributions and index changes |
| `FXC` | FX cross rates: the majors, or up to 45 currencies (`gloom fn FXC --currencies USD,ZAR,NGN`; `gloom catalog FXC` lists the codes) |
| `FNG` | Fear and greed market gauge |

#### Market function notes

- **`ECST`:** `fn ECST` prints the 2s10s spread in bp and takes `--range 5Y|20Y|ALL` for the window of its percentiles, highs and lows. A statistic's detail says which period Previous is (`Previous  3.4% (Aug 2026)`); `--csv` and `--ndjson` carry it as `Previous period` and date each row by its release in `as_of`. In a detail's exports each line has the `period` and `released` of its own reading: Previous and 1Y ago name their own period and no release, as only the newest print is dated by the source. The daily rates add their 1D and 1W moves ranked against the series' whole history (`1D move  -1bp · 21 pctl since 1962`), and Treasury yields name their 15:30 ET cut-off ([move ranks and cut-offs](research-data.md#was-it-a-big-day-move-ranks)).
- **`TRACE`:** an issuer name (`TRACE whirlpool`), a TRACE symbol root (`TRACE WHR`, exactly: not `WHRL`) or a 9-character CUSIP asks FINRA for that issuer's bonds, newest sale first (the first 100, and it says so). Matured bonds are left out and perpetuals kept.
  - A stock ticker with no bonds under its own symbol is asked again by the company name its quote gives (`TRACE CMLSQ` shows CUMULUS MEDIA and says so).
  - Nothing found says `No prints for <name> on <date>.`
- **`AUCT`** searches by type, benchmark (`AUCT 10Y` finds the 10-year note and its reopenings), term, CUSIP or date. Windows reach back 10 years (`--historyDays 3650`) or to the first auction on 1979-10-31 (`--historyDays all`).
- **`CDS`:** with no argument, the issuers traded in the last 5 days, most active first, with each one's 5Y spread and its 1W and 1M moves (`fn CDS --sort 1m`, in points upfront past 2,000bp: `57.6 pts`). With a ticker or issuer, its 5Y spread, history and trades. `fn CDS F --csv` carries the same figures, `--csv --section daily` the daily 5Y levels.
- **`TBO`** keeps loaded data when a session, subscription or token check fails and says access is unknown. Retry the initial error with Retry, or press `r` to refresh a loaded table.

#### Heat map (HM)

`HM` sizes each stock by how far it moved today, up or down alike, so the movers are the big tiles whatever their company's size. Tiles are colored by the day's move, from a muted tone near flat to the full down or up color at 3%. A name with no move yet is a quieter grey.

**Size by** (settings, every tab but a portfolio's):

- **Day move** (default on **US Stocks** and **US ETFs**): a +5% and a -5% name get the same area. Names that moved less than 0.25% or have no move yet take the smallest tile.
- **Market cap**: the largest names dominate. **Square root of market cap** gives mid-size names room (the `√` button beside the title switches it with Day move). ETFs use net assets.

**Layout.** **US Stocks** groups the 500 largest US stocks into sector blocks (biggest top left) and industries. Names too small to draw, and the few without a sector, sit in **Other** at the bottom right. Hovering a tile shows its name, move, price, market cap and volume. **US ETFs** is the same map without sectors. **Names** draws the largest 100, 150 or 500 names (default) on US Stocks, and up to 160 on US ETFs.

**Live streaming.** With it on, colors follow the quote stream, largest names first, real-time with Pro and delayed otherwise (the footer says `live`, `mixed` or `polling`).

- In the pre-market and after hours a streaming name shows that session's move from the regular close, marked `PM` or `AH`.
- Names outside the stream follow a snapshot refreshed every 15 seconds with Pro while the regular session trades, otherwise fifteen minutes behind and refreshed each minute.

**Colour by** in the `HM` settings picks the session the tiles show. **Active session**, the default, follows the pre-market and after hours as above. **Regular session** never shows extended trading: once the session is over a tile keeps that session's close and move until the next one opens.

**The footer** says what the board is: `top 500 · Oct 9 session · as of 16:00 ET · checked 2m ago` (names covered, the completed session shown outside the regular session, its close in New York time, and when the app last got it). While the regular session trades it gives when the board's prices printed instead. A refresh that fails says `refresh failed` and keeps the rest.

#### HM in the CLI and the portfolio tab

`gloom fn HM` reports the map by sector from the same snapshot the pane starts from: each sector's names, total market cap and share of the board, its market-cap-weighted day move, how many names rose and fell, and its best and worst name.

- `--group industry` breaks it down by industry, and `--universe us-etf` summarizes the ETF board as one group.
- `--json` adds the board's figures in `data.metadata.board`. A name with no move yet counts toward size but not move or breadth (`data.metadata.noMove`).

`HM` has a third tab, named for the list open in the portfolio pane (your first portfolio when none is open).

- It sizes a portfolio's holdings by market value in the portfolio's currency, whatever **Size by** says, and a watchlist's names by the square root of their market cap in your base currency.
- A name without a position, quote, market cap or exchange rate gets the smallest tile and no figure, and past 160 names the smallest tiles are left out (the footer says so).
- **Link to portfolio** in its settings switches the heatmap to that tab whenever the portfolio pane changes list. `3` opens the tab, and `[` / `]` step through all three.

An open theme in `THEM` and the Members tab of `MEMB` add two entries to the pane menu (`.`): **Open Members In…** opens the members in `RRG` (up to 24), `CORR` (2 to 10), `SIW` (up to 60) or `RIPL` (up to 10), and **Save as Watchlist…** saves the first 100 members to a new watchlist. A `MEMB` search narrows both to the holdings it matches.

#### News, Congress and bond tools

News rows credit the article's publisher and open its original URL. The managed news feed includes only articles whose publisher and original link can be verified, and custom RSS and Atom feeds use each item's source when supplied. If a feed fails, News keeps any available stories and shows the failure in its footer.

A story opened from `SRCH` or a news pane is set for reading: headline, source and time, the tickers it names as chips (click one, or `t`), then the text. A long `SRCH` story shows a **Key facts** list and about a screen of text, with the rest behind **Read more**.

Space and Shift+Space page, `]` and `[` jump between sections, `n` and `p` open the next and previous result, and **Show Original Text** in the pane menu (`.`) shows the text as indexed.

**Congress.** Ticker Research has a **Congress** tab for House and Senate transactions in the ticker, and the **Chamber** filter narrows `CG` and the tab to one chamber.

- Scroll to append filing windows. `n` or its footer action continues a window with no matching transactions, and after the year's filings `p` appends the previous year.
- Select a trade for its disclosure details. `m`, `t` and `o` open the member, ticker and source filing.
- The CG **Tickers** tab groups the loaded trades by symbol (Enter opens that ticker's disclosures). `f` opens the filters (side, owner, asset category, minimum dollar amount). `i` or **Mine** limits the view to portfolio and watchlist symbols. A `!` beside lag marks disclosures filed more than 45 days after the transaction.
- Congress Trades includes returns since the transaction and filing close. Members includes party, median stock return and buy hit rate, and opens to current committee assignments. Missing prices stay blank.

```bash
gloom fn CG AAPL --year 2026 --json      # use --filingOffset and --offset with the returned pagination metadata for more
gloom fn CG --tab tickers --side BUY --minAmount 50001 --json
gloom fn CG AAPL --owner spouse --assetType option --json
```

**`YAS`** opens a bond form: settlement, maturity, annual coupon and either yield percent or clean price per 100 face. `e` starts editing at Settlement, Tab and Shift+Tab move through the fields, Escape stops editing, and `m`, `f`, `d` and `n` switch the mode, frequency, day count and end-of-month schedule. The Cash flows and Sensitivity tabs keep the same terms.

```bash
gloom fn YAS --settlement 2026-09-22 --maturity 2031-09-15 --coupon 5 --yield 4.25 --json
```

That returns valuation, cash flows and yield shocks. Use `--price 103.333937` instead of `--yield` to solve yield, and add `--frequency 1|2|4`, `--day-count act-act-icma|30-360-us` and `--end-of-month` as needed. `gloom shot YAS --tab valuation|cashflows|sensitivity` takes the same inputs. Local calculations work without Treasury data.

#### Futures board (FUT)

`FUT` keeps each rolling quote alias as its symbol and names the contract it quotes, the root's front month. Gloom Cloud rolls an alias (CL=F), like the first generic (CL1), on a stated roll date, which `quote CL=F` prints under Rolls.

- From then until the old month stops trading the row names it: "WTI Crude Oil Dec 2026, rolled (Nov expires 20 Oct)". The most active month is named when it is another month: "WTI Crude Oil Nov 2026, Dec most active".
- `quote` on a deferred contract or a later generic (NGF27.NYM, NG2) prints the front contract and its price, and the quote, chart and `history` follow the same month.
- Watchlist and portfolio tables add a muted front reference beside the ticker (or Name when shown), such as `front NGX26 3.116`. It follows the front quote, leaves Last at the row's own contract price, and hides when the whole note cannot fit.
- Generic tickers take OI for the open interest switch (CL1OI). UNIT says what a price counts, as `quote` does ("USD / barrel", "US cents / bushel").
- Search matches the root's name and code. `FUT TTF` (`gloom fn FUT TTF`, `shot FUT TTF`) opens the board searched for that contract.
- `--tab markets|inventories|positioning|crops` opens the workspace on that board (`gloom fn FUT --tab inventories`). FUT takes no other option and refuses one it does not know.
- FUT and CTM list COMEX metals (HG copper, ALI aluminium), not LME or Shanghai (SHFE) contracts. The IMF's monthly world prices are the nearest public series: `gloom fred PCOPPUSDM` and `gloom fred PALUMUSDM`, in USD per metric ton.

FUT's 1W, 1M and YTD columns are returns on the contract the row names (LEZ26 for "Live Cattle Dec 2026"), not on the alias, whose continuous series jumps at every roll.

- A contract listed after the baseline date shows no return for it (Treasury futures list three quarters ahead, so their YTD is blank in the second half of the year).
- Dutch TTF gas names no month, so its front contract is the one, among the next three months, whose last close is nearest the quoted price.

**`BTMM`** opens Rates, Bills and Liquidity views. Select a row (Enter or click) for its dated history, one-year range and source. `h` and `l` switch views, `o` opens the selected FRED series, `r` refreshes. Reports take `gloom fn BTMM --tab rates|bills|liquidity` and `--json`.

**`CBR`, `ECFC` and `CBRT`** open the Central Bank Rates board: each row's policy rate or target range, last observed move and date, one-year percentile and history.

- Select a row (Enter or click) for the source instrument, reporting lag, one-year range and each bank's next decision from its published calendar. `o` opens the official source, `r` refreshes.
- `gloom fn CBR --json` carries each row's central bank, source series, link, next meeting and a citation line (`--history` adds the one-year history).

**`IPO`** lists deals on the main US, Asia-Pacific and European exchanges from the last three months and the next six (the All, US, APAC and Europe tabs pick the region). The list runs in this order: deals in their offer now (`offering`), upcoming deals, `overdue` ones (listing day passed with no pricing or first session reported), priced and listed deals, then postponed deals.

- `/` searches company names in either script, tickers, markets, countries, status and the region's name. The word `pending` lists deals not priced yet. `IPO japan` opens the pane on that search, as `gloom fn IPO japan` reads it.
- DATE is the listing date in the venue's calendar, dimmed while expected. PRICE is the offer price once set, else the range, in the deal's currency (London in pence). SIZE is the money raised in US dollars. RETURN is the first session's close against the offer price. Enter or click opens a deal's ticker once it has one.
- `gloom fn IPO --region apac --status upcoming --json` returns the same deals. `--status filed` or `--status withdrawn` returns the filings and withdrawn deals the pane leaves out.

`PERP` opens the [perpetuals board](perpetuals.md), and `PERP [market]` that market's History.

**`CRYP`** opens the top 100 coins by market cap, with stablecoins on the second tab. Prices refresh every 15 seconds and stream in real time where the plan allows. Enter or click opens the coin in the ticker pane, column headers sort and `r` refreshes. `gloom fn CRYP --json` returns the board, and `--list stablecoin` the stablecoins with their supply ([stablecoin supply](research-data.md#stablecoin-supply)).

### Workspace and App Controls

| Shortcut | Function |
|----------|----------|
| `PF [portfolio or watchlist]` | Portfolio and watchlist workspace. With a name or id, in any case, it opens that portfolio or watchlist |
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
| `AW` / `AP <ticker>` | Add a ticker to the active watchlist or portfolio. `AW` also takes a pasted list of tickers |
| `RW` / `RP <ticker>` | Remove a ticker from the active watchlist or portfolio |
| `PS` | Open focused pane settings |
| `LAY` | Open the layout browser to switch, publish, or add layouts |
| `DESK [desk]` | Add a ready-made desk as a new layout tab: equities, options, futures and commodities, rates and credit, FX and macro, or active trading |
| `LMA <query>` | Layout and pane arrangement actions |
| `WIN move\|resize` | Move or resize the focused window |
| `GL` | Tidy all windows |
| `SB` | Toggle the status bar |
| `VF` | Toggle quote value flashing |
| `TH <theme>` | Change color theme. The list shows each theme's id, the one `gloom config set theme <id>` takes. `gloom config themes` lists them, `colorblind`, `colorblind-light` and `high-contrast` included |
| `FONT+` / `FONT-` | Increase or decrease desktop font size |
| `CONN` | Connection health |
| `POLL` | Political polls from VoteHub ([Polls plugin](https://github.com/gloom-sh/gloom-polls)) |
| `UPGRADE` | Account upgrade |
| `MCP` | Connect Claude Code, Codex, Cursor or another MCP client to Gloom |
| `CR` | Cycle chart renderer |
| `LANG <locale>` | Change interface language (`auto`, `en`, `es`, `zh-CN`, `zh-TW`, `ja`, or `ko`) |
| `PL <plugin>` | Manage plugins |

**Toggle Presentation Mode** in the command bar hides the header and the status bar until you toggle it again. The pane fullscreen key (`Ctrl+Shift+F`, `Cmd+Shift+F` on a Mac) then fills the window with one pane. The desktop app keeps the header, as it is the title bar. It is saved as `"presentationMode": true` in the config.

In `PF`, `a` adds a ticker to the open manual portfolio or watchlist and `d` removes the selected one after a confirm.

- Removing it from a portfolio deletes its position there. Its notes, alerts and other lists stay.
- Broker portfolios and team lists have no `d` (the next sync would put a broker ticker back, and everyone shares a team list). `RW` and `RP` still edit a team list.
- In the add row, a symbol with a colon (`NET:`) opens that symbol's exchanges, and the one you pick joins the list.

When the `PF` table comes back into sight after two minutes away, LAST is tinted for six seconds on each row whose price moved since you left (green above what LAST showed then, red below). A key or a click clears the tint. **Moves Since Last Seen** in the pane's settings sets the time away (30 seconds, 2 minutes, 10 minutes) or turns it off.

`gloom fn PF <portfolio-or-watchlist> --json` returns a portfolio's positions, broker or manual, valued as `portfolio show` values them.

- Each row has shares, average cost, last price, market value and unrealized P&L in the portfolio's currency, its weight of the total with cash (see [Cash, target weights and rebalancing](#cash-target-weights-and-rebalancing)), and when its price is from. Rows run largest first, then the cash line. With target weights set, each row adds its target, drift and the trade that reaches it.
- `--close` values them at the regular close (see [What a portfolio is priced at](#what-a-portfolio-is-priced-at)).
- `--limit` caps the rows (50 by default, at most 200). The totals always cover every position.
- Name the portfolio or watchlist by its ID or name. Without one it reads your first portfolio. A watchlist returns its tickers with their quotes.

Published layouts keep portable pane setup and state (searches, chart viewport, drawings). Credentials, accounts, portfolios and pane fields marked private stay local. Publishing copies a durable `term.gloom.sh/l/...` link.

The AI screener, the AI research workspace and the Ask AI research tab come from the [BYOK AI plugin](https://github.com/gloom-sh/gloom-byok-ai), which connects your own provider account. The selected model writes the screener's reasons, so review the cited fiscal periods, metric values and sources in company research. Missing data is not evidence that a company meets a criterion.

### Filing event alerts

Open `ALRT` and choose **Events** to follow Congress trades for your portfolio and watchlist, a representative's or senator's first and last name (optionally `name:district` or `name:state`), or a fund's numeric SEC CIK. Use **Add Event Alert** in the command bar, or the pane's add action. Enter or the pause action toggles a rule, delete removes it.

Rules sync with your price alerts. Push needs Cloud sync and a registered mobile device, and the phone's notification settings have separate Congress and 13F switches.

**Add Event Alert** also creates market and research rules for a US-listed symbol:

- confirmed earnings date (days before), SEC filing type (8-K, 10-K, 10-Q, S-1, SC 13D/G, 6-K, 20-F), news keyword (symbol optional), analyst upgrade or downgrade, new 52-week high or low
- unusual volume (multiple of the prior 20-session average), short interest change (percent between FINRA settlements), open-market insider buy or sell
- an option IV spike for one OCC contract (Pro), and an IV level on a symbol
- options flow (Pro): a print at or above a premium (default $1M, typed as `1,000,000`, `$250k` or `1.5m`) on one symbol, or on any name in your portfolio and watchlists when the symbol is blank, optionally calls or puts only and sweeps or blocks only

The **Events** tab shows each rule's last checked value with its one-year percentile and date when the pane is wide enough, and a flow rule its latest matching print. **History** lists the alerts that went off, newest first, with the rule, the figure and the quote behind it (`r` refreshes). The phone's notification settings have one switch for these market and research alerts.

An **IV level** alert follows a symbol's 30-day at-the-money IV (in %) or 30-day 25-delta risk reversal (25D call IV minus 25D put IV, in vol points), above or below a level. Its figure is the **1M** row of `OVDV`'s Table.

- The running app checks it every 15 minutes, signed in or not, and notifies once when the level is passed. The rule then reads **Alerted** until you re-arm it (`m`, or `gloom alerts rearm <id>`). A rule added or re-armed while the reading is already past its level goes off at its first check.
- Readings stay on the device and only a rule going off or changing is synced. Gloom Cloud does not check these, so they reach no phone.

From the shell, `gloom alerts add` takes the same rules:

```bash
gloom alerts add IBIT iv above 50%         # 30-day ATM IV above 50%; the unit is optional
gloom alerts add SPY rr below -5.5 pts     # 30-day 25D risk reversal below -5.5 vol pts
gloom alerts add AAPL271217C00300000 iv spike 5
gloom alerts add AAPL news buyback         # alerts add news "rate cut": any company
gloom alerts add NVDA flow 5m calls sweeps # flow alone: your portfolios and watchlists, $1M and up
```

A symbol is read as `gloom quote` reads it and must be a US listing, as in the dialog.

`v` (view, also in the footer and the pane menu) opens what the selected row follows, on **Prices**, **Events** and **History**:

| Rule | Opens |
|------|-------|
| a security | `DES` |
| a perpetual | `PERP` on its market |
| an earnings date | `ERN` for the company |
| a CPI or FOMC alert | `CPI` or `WIRP` |
| an economic calendar event | `ECO` on its country |
| a catalyst rule | `CATL` (on its company when it names one) |
| a Congress rule | `CG` |
| a 13F rule | `13F` on the fund |
| a news keyword with no symbol | `SRCH` on the keyword |
| options flow on your lists | `FLOW` |
| breaking news with no symbol | `FIRST` |

**Price alerts** are checked by the running app on every price tick, and it notifies you there. Signed in with Cloud sync on, an alert the app has synced also reaches you with the app closed:

- Gloom Cloud pushes it to the phone app when one is registered.
- It emails it (verified email address, once per arming, up to 20 a day) once no app has synced your account for about 15 minutes.
- Signed out, nothing outside the running app notifies you.

- The symbol is read as `quote` reads it, so `USDMXN` and `USD/MXN` are the one pair `USDMXN=X`. A symbol that quotes nothing is refused with the nearest listing (`did you mean AAPL`), and a bare code kept on a listing abroad names it.
- A bare ticker of a top coin (BTC, ETH, SOL, LINK) read as another listing says so as `quote`, `ticker`, `history`, `options`, `news`, `fn` and the portfolio and watchlist adds do. A fund named for the coin, or a stale or delisted listing, gets `SOL is Emeren Group Ltd, not solana. For solana use SOL-USD.`; a live company that shares the letters gets the softer `LINK is Interlink Electronics, Inc. Also a coin: LINK-USD.`. A listing named with its exchange (`ETH:ARCA`, `--exchange`) gets neither.
- A target more than 10 times the last price, or under a tenth of it, is refused, in **Add Alert** too (`alerts add btc above 85000` is bitcoin's price typed on the fund).
- A price reads the same in `alerts add`, the `SA` shortcut and the **Add Alert** form: `81000`, `81,000.50`, `1.350,5` and `81k` or `1.5m` (a thousand and a million). A comma before exactly three digits (`81,000`) could be thousands or a decimal comma, so it names both readings and adds nothing; text that is no number is refused with the format to type (`type 81000 or 81k`).
- If saved price alerts cannot be read, the app and CLI leave the data unchanged and price checks pause until it is repaired. The pane and `gloom alerts list` show the read error, and event alerts stay usable.
- On **Levels**, Enter opens an alert in full: its state, the price and how far it is from the level, and when its quote was checked. An alert that could not get a quote shows that in red on its row, and its detail says why. `m` re-arms an alert that went off.

### Valuation and daily technical alerts

Use **Add Alert** (`SA`, or `a` in ALRT's **Levels** tab) and choose **P/E (TTM)**, **P/S (TTM)**, **RSI**, **MA crossover**, or **Close vs MA**. These share price alerts' list, detail, edit, delete, re-arm and History actions. The CLI accepts the same rules:

```bash
gloom alerts add AAPL pe below 25
gloom alerts add AAPL ps above 8
gloom alerts add NVDA 'rsi(14)' under 30
gloom alerts add SPY 'ma(50)' crosses above 'ma(200)'
gloom alerts add TSLA closes below 'ma(200)'
```

Quote parentheses in shells that interpret them. `rsi 14`, `50-day MA crosses above the 200-day`, and `closes below its 200-day` work too. Periods are whole numbers from 2 to 200; the fast MA must be shorter than the slow MA.

P/E uses the research panes' trailing P/E and regular-session price basis. A zero or negative trailing EPS is not meaningful and never triggers. If EPS is missing, a meaningful served trailing P/E remains usable, as in the research panes; no multiple is invented from missing earnings. P/S divides capitalization on that same regular-session basis by trailing revenue, only when their currencies agree. Missing or stale valuation inputs leave the alert active with the reason in its detail.

Daily technical alerts use the standard one-year daily history. RSI uses Wilder smoothing, seeded with the first period's average gains and losses; flat prices read 50. Moving averages are simple averages of completed daily closes. The published US equity calendar determines completed sessions, including holidays and early closes, with a 30-minute allowance after the close for the closing auction and late prints to settle. Other close calendars are currently unavailable for technical alerts. Missing sessions, insufficient history, and invalid or duplicate bars prevent evaluation. The row shows **Blocked** with **Bar gap** or **US only**, and its detail explains the reason. Settled calculations are reused until the next close; a failed history read retries after five minutes.

Technical rows say **on daily close**. Adding or re-arming a rule waits for the next completed close; intraday bars cannot fire it. A crossover compares the fast and slow averages on two consecutive sessions, firing only on the specified crossing. Like price alerts, each rule fires once until re-armed. Valuation alerts can fire on their first check if their threshold is already met.

Delivery and access follow price alerts: the running app notifies locally; Cloud sync and a verified account enable existing email and registered-phone delivery, with the same cadence, settings and shared delivery limits. No separate technical-alert subscription is needed.

### Alerts before earnings and economic releases

To watch a position through a scheduled event, alert a number of days before it. In `ALRT`, open **Events**, click **add event** (or run **Add Event Alert**) and pick **Earnings date** with a US-listed symbol, or **Macro event** with the CPI release or the FOMC decision, then the days before (1 to 14, 1 by default). Any other release in the economic calendar is added from the shell, by name.

An earnings alert can instead wait for the report: pick **When results are out** under **Alert**, which is what `n` in `ERN` sets. From the shell:

```bash
gloom alerts add CRWV earnings --days 3
gloom alerts add CRWV earnings results
gloom alerts add CPI --days 1
gloom alerts add FOMC
gloom alerts add "NBS PMI"
gloom alerts add CN PMI
gloom alerts add "Industrial Profits" --country CN --days 2
```

The next date comes from `ERN`, the BLS release calendar behind `CPI`, the Fed meeting calendar behind `WIRP` and, for any other release, the economic calendar `ECO` and `econ` list. A symbol with no upcoming earnings date, or an event with no known next date, gets no alert. The **Events** tab and `alerts list` show each alert's next event date and state.

**A release by name.** `alerts add <event> [--country <code>] [--days <n>]` takes any release in the economic calendar, as `econ` names it:

- Some of its words are enough: `NBS PMI` is `NBS Manufacturing PMI`, a word's start (`manuf`) or a name's initials (`NFP`) read too, and `CPI` reads as a country's `Inflation Rate YoY`. Of several releases the words name, the highest impact wins, then the shortest name; the reply says what it read the words as and lists the others.
- A country code first (`CN PMI`) or `--country` (`CN`, `UK`, a region such as `G7`) narrows it. A name listed in several countries without one is refused with the best of each, and a name nothing matches with the nearest names (`Did you mean NBS Manufacturing PMI (CN)?`).
- `CPI` and `FOMC`, alone or in the US, stay the CPI and FOMC alerts above.
- A release the calendar lists only in the past is followed once its next date is listed, about two weeks ahead.

- While the app runs it checks the dates every 15 minutes and notifies once when the lead time is reached ("CRWV earnings in 3 days, Mon, Nov 9", counted in New York calendar days). An app that was closed that day notifies when it next runs, up to the event day.
- A release from the economic calendar counts in UTC days, as the calendar lists it, and gives its time ("NBS Manufacturing PMI (CN) in 21 hours, Sat, Oct 31, 01:30 UTC"); an all-day event (a plenum, an election) gives its day.
- A release, CPI and FOMC included, then notifies once more with its figures when they print ("NBS Manufacturing PMI (CN) 50.3 vs 50.0 expected, prior 50.1"), asking every minute for half an hour after the release time. Figures printed before the alert was set, or more than 12 hours before the app next runs, are not sent. An event with no figures (a plenum) alerts only before it.
- An alert for results goes off once the report's actual EPS is in `ERN`, on the report day or usually that evening for a report after the close ("CRWV reported EPS 0.12 vs 0.10 expected (+20.0%)"). It waits up to 3 days past the date for a late figure, then follows the next report.
- The alert then reads **Alerted** until the event passes and arms itself for the next date. Re-arm (`m`, or `gloom alerts rearm <id>`) sends it again for the same event, and `gloom alerts delete <id>` removes it.
- Earnings alerts also reach the phone app like the other market alerts, once per report and never on the day itself. CPI, FOMC and other economic release alerts notify in the running app only.

`gloom fn ALRT` lists your price alerts, `--tab events` your event alerts with their event date, lead time and state, and `--tab history` the alerts that went off. `gloom shot ALRT --tab events` draws that tab.

**Alert history.** Every alert the app fires (price, IV level, earnings, CPI, FOMC and other economic releases) is kept on this device, the last 1,000, with when it went off, the rule, the figure and the quote time and feed. **History** and `fn ALRT --tab history` list that log with no sign-in.

Signed in, they also merge in the alerts Gloom Cloud delivered to your phone or email over the last 90 days, and the Via column says which sent each: this app, Gloom Cloud or both.

### Live scanner

`SCAN` runs your own intraday scan over US stocks and keeps its matches current through the session. **Matches** lists what matches now, strongest first by the first condition (click a header to sort by another column); **Conditions** holds the conditions, every one of which must hold; **Saved** keeps scans you saved with `s` and opens one with Enter.

- **Universe:** all US listings, the S&P 500, MidCap 400 or SmallCap 600, the Russell 1000 or 2000 (members as their index funds last filed them), a sector, or a watchlist. A watchlist is read when the scan runs, so adding a symbol to it adds it to the scan; rows that are not US stocks are left out and named in the footer warning.
- **Conditions:** a price move of at least a percent over the last 1, 5, 15, 30 or 60 minutes (up, down or either way); volume over one of those windows, or the session so far, against the pace of the 20-session average (a 5-minute window at 3x trades three times an average 5 minutes, the average day spread evenly over the 390-minute session); a new session high or low printed within a window; a cross of the session VWAP within a window, still on the side it crossed to; and the open's gap from the previous close.
- **Floors** in the query bar: price, market cap and the session's volume so far.
- Each condition gets a column with the figure it matched on: the move or gap, the volume multiple, or the time of the high, low or cross.
- **STATUS** speaks for its row: `new` arrived with the last refresh, `alerted` with the time it alerted, and `stale` with the time of its last print when that print is more than 5 minutes older than the scan, as for a halted stock.
- A watched window needs that much of the session watched first: right after the scanner starts (at the open, or after the first scan of a quiet day) conditions over longer windows match nothing until then, and the footer says so. A new high or low is one past the highest or lowest the session has printed since the scanner's first look at it, and a cross counts from that look too.
- Every condition reads today's trading. A stock that has not traded since the open still carries the last session's bar, so it matches no condition, counts no volume against the floor and shows no change, gap or VWAP until its first print.

**How fresh.** Pro scans a market-wide snapshot refreshed every 15 seconds; the pane asks again a second after each refresh, so a match is at most about 17 seconds old. Free and signed-out scans read a snapshot of 15-minute delayed prices refreshed every minute, so a match is 15 to 16 minutes old; the footer shows the delay and the time the scan is as of. When a refresh fails, the last matches stay and the footer says `degraded` until one succeeds. Outside the session the last matches stay, as of the close.

**Alerts.** Turn on **Alerts** in the query bar and each symbol that newly matches alerts once a session. A refresh's new symbols make one notification on this device (it stays in **Unread**, and opening it brings back the scanner) and one line in ALRT's **History**. A scan sounds and reaches the desktop at most once a minute; new symbols in between are still told in the app. Live scans keep at most 100 lines of the history between them, so price and event alerts are never pushed out. What already matched when alerts were turned on, the scan changed or the app started does not alert, nor does the first list after the scanner starts. A scan with alerts on keeps running while its pane is covered or the app is in the background, but only while the pane is in the open layout.

`gloom fn SCAN` runs the default scan once (`--universe sp500` or a sector, `--scan` with conditions and floors as JSON).

## Live prices and refresh cadence

Prices come from one shared stream, and a symbol shown in several panes is subscribed once. Rows on screen and the selected symbol update about 10 times a second, everything else about once a second. Minimizing or hiding the app pauses streams and polling, and plans that cap streamed symbols spend them on the rows in view.

What moves while you watch:

- **Portfolios and watchlists:** price, change, volume, market value, P&L and weight. MCAP, P/E, FWD P/E and DIV% are repriced from the live price when the per-share figure behind each is on the quote's currency basis. 52W% counts today's range, and TARGET% uses the live price when the target is in the listing's currency. Broker account totals, Net Liq and P&L move with the positions' quotes.
  - After the regular close, LAST, CHG and CHG% hold the official close and its move, while EXT% follows the extended-hours print from that close (market value, DAY and P&L keep the live price). In the pre-market the row holds the last session the same way when the quote carries its close and move, otherwise LAST and EXT% are the pre-market print. `DES` uses the same rules.
- `WEI`, `FUT`, `BI`/`SP`, `FXC`, `EQS` rows, `CRYP`, the header SPY chip and market state, and price alerts (which trigger on the tick that crosses). After the close `BI`, `MOST`'s lists and `EQS` hold the regular close and only their extended-hours column moves (see [Company Research](#company-research)).
- **Charts**, including the research Chart tab: the forming bar takes each quote's high, low, close and volume. A daily, weekly or monthly bar is the regular session's: after the close it holds at the official close, the close `gloom history` and `portfolio show --close` give. Intraday bars and the extended-hours view of a US listing keep the extended prints.
- `OMON`: Last, volume, IV and Greeks stream during the regular session, and a real-time chain reloads every 15 seconds. `OVDV` reloads a real-time surface every 15 seconds in session, `HVG` re-reads its ATM IV every minute, `VOLS` and the `VIX` curve stream index levels, and `CTM` and `WIRP` refresh delayed contract quotes every minute while Globex trades.

News panes refresh every two minutes while the app is visible (a hidden browser tab falls back to the configured interval, which still feeds breaking-news notifications). `VF` toggles value flashing: a changed price dims for 300 ms.

## CLI

Running `gloom` with no arguments launches the terminal UI. Normal commands run headless. Use `gloom launch-ui` when a script should explicitly open the UI.

### Output and flags

Human-readable output is the default: tables fit the terminal width, and a single result prints as aligned label and value lines. Piped text keeps every cell whole.

- `--json`, `--csv` and `--ndjson` give structured output, which is how to export anything (`gloom history LMT --csv > lmt.csv`). JSON uses the richest model and includes display-column metadata. CSV and NDJSON use the tabular rows.
- Common global flags: `--limit`, `--tail`, `--width`, `--refresh`, `--quiet`, `--no-color`, `--plain`, `--no-plain`, `--dry-run`, `--yes`.

**Plain output.** `--plain` prints text for a screen reader or very large text. It is on without the flag when `NO_COLOR` is set to a non-empty value (an empty `NO_COLOR` is the same as unset) or the output is not a terminal (piped or redirected). `--no-plain` turns it off, piped or not.

- Tables have no rule under their header and keep the same columns from one query to the next: an empty cell reads `—` (`econ` prints Actual and Forecast before they are out).
- Arrows are words in tables and in the lines the CLI writes itself: a sort mark after a header reads `(sorted descending)` instead of `▼`, and `→` reads `to`. Free text outside a table, such as a note or an answer, prints as it is.
- Colour is off unless `--color` asks for it. `--json`, `--csv` and `--ndjson` are the same with or without it.

Cboe's Treasury yield indices (`^IRX`, `^FVX`, `^TNX`, `^TYX`) print their level in percent (`5.24%`) and their change in basis points (`+1.3bp`) under a `Chg` header. `--json` adds `unit` and `changeBasisPoints` to their rows and keeps the percent change.

### Fitting tables to a width

`--width <n>` fits text tables, help and notes to n columns, in a terminal or piped (`gloom quote AAPL TSLA NVDA MSFT --width 80`). Without it a terminal's own width applies and piped output is not fitted.

- A table gives up its least useful columns first (`compare` drops Cur, Volume and Day Range). `quote` drops none: at 80 or 100 columns it moves Updated, Feed, Cur and Chg Basis onto a labelled line under each row (`Feed delayed  Updated 2026-10-23 15:40 UTC`). No cell is cut short: text wraps, and columns that still do not fit move onto indented lines under each row.
- The function list of `catalog` is the one table that cuts (a description ends in `…`, and `catalog <function>` prints it whole).

`shot` has its own `--width`, in pixels. The layout is 720 to 2400 wide and 360 to 1800 tall (`--height`), and the PNG is drawn at twice that size, so the default 1280 by 720 writes 2560 by 1440.

- A fixed board such as `FUT` grows until every row shows (up to 1800) unless you give `--height`.
- A size outside the limits is drawn at the nearest one, with a warning: `--width 80 is below the 720 minimum, so the capture used 720 and the PNG is 1440 px wide.`

### Typed symbols

**Not a ticker.** A symbol that no listing carries (a typo, or a word that names no company) ends in ``Not a ticker: APPLEX. Try `gloom search Applex`.`` on `quote`, `compare`, `history`, `ticker` and the `fn` reports (an `fn` report of one symbol that finds nothing, such as `fn RDCF Palantir`, fails with that line too).

- A one-word company name is read the way a longer one is: `quote Apple` is AAPL, with `Read "Apple" as AAPL:NASDAQ (Apple Inc.).` A real ticker always wins over a name (`quote GOLD` is GOLD). A word many names share is read only as search's top result or a listing named exactly that word, never as any listing that merely has the word in its name. A coin's name (`bitcoin`) keeps its coin hint (`BTC-USD`), and a subject such as `carbon` or `freight` keeps its search hint.
- `notes show`, `notes set` and `notes delete` pick the same note. A note already saved under the word as typed comes first. Otherwise the symbol is read as `quote` reads it: `notes set Petrobras "…"` saves the note for PBR. `notes set` fails only when the word is definitely not a ticker. Offline, with the data service down, for a symbol with no quote, or with `--dry-run`, the note goes under the symbol as typed.

- A FRED series id points to the command that prints it: ``Not a ticker: DFEDTARU. Try `gloom fred DFEDTARU`.``
- A US Treasury yield typed as a ticker (`US10Y`, `UST10Y`, `US10YR`, `US2Y`, `US30Y`, `10Y`, `TNX`) names the commands that have it: ``Not a ticker: US10Y. Try `gloom quote ^TNX`, `gloom fred DGS10` or `gloom yield-curve` for the US 10-year Treasury yield.`` `search` and `catalog` answer those spellings, or `"10 year yield"`, the same way.

**Pairs and share classes**

- A coin pair written the way crypto exchanges write it, `BTC/USD`, is the coin `BTC-USD`. A currency pair such as `EUR/USD` stays a currency pair.
- Every spelling of a currency pair is one listing: `USD/NGN`, `usd/ngn`, `USDNGN=X` and `USDNGN:CCY` are all `USDNGN=X`, and `JPY=X` is `USDJPY=X`. `USD-NGN` and `USDNGN` read the same unless a security is listed under those letters (`MNT-USD` stays the coin).
- A share class written `BRK.B` or `BRK-B`, the listing named with its exchange (`BRK.B:NYSE`) and the one you saved are one listing.
- A symbol written like a pair that is not a ticker names the nearest listing: ``Not a ticker: USD_NGN. Did you mean USDNGN=X (US Dollar/Nigerian Naira)?``

**Stopped listings.** A listing whose quote stopped more than half a year ago says so under the table: `TWTR: no longer trading since 2022-10-27 (last price $53.86)`.

- `watchlist add` and `portfolio add` refuse it, and `history`, `options`, `fn HIVG` and `fn VCA` say `TWTR stopped trading 2022-10-27; no history or options served`.
- `search TWTR` lists it under No Longer Trading (`--json` adds `lastTraded`, `lastPrice` and `note`).

**A coin ticker that is also a fund.** A bare coin ticker that reads as a fund named for the coin says so on `quote`, `ticker`, `watchlist add`, `portfolio add`, `position set` and `target set`: `ETH is Grayscale Ethereum Staking Mini ETF, not ethereum. For ethereum use ETH-USD.`

- A coin ticker that several companies list ends its list of listings the same way (`SOL is Solvay SA, Washington H. Soul Pattinson and Company Limited or another company, not solana. For solana use SOL-USD.`). A company that only shares the letters (`LINK`, Interlink Electronics) and a listing named on purpose (`ETH:ARCA`, `--exchange ARCA`) get no note.
- `--json` carries the note in `warnings`, in an error's `details`, and in each row's `hint`.

**Names.** A listing goes by the name its own quote gives, in every command, including portfolio and watchlist rows.

### Symbol changes

A US symbol that changed says so in one line.

- **Something else lists there now.** `quote`, `compare`, `history`, `options`, `search`, `fn HIVG`, `fn VCA`, `watchlist add` and `portfolio add` print `FB now lists ProShares S&P 500 Dynamic Daily Buffer ETF; Meta Platforms trades as META (changed 2022-06-09)`. The options functions say that line for a fund with no options, or a listing that stopped (`TWTR: Delisted Oct 27, 2022`), instead of a chain error.
- **Nothing lists there any more.** The line reads `HFC became DINO on 2022-03-15`, and an add that finds no listing ends with it. A company that moved more than once is followed to where it trades now (`TRCH became MMAT on 2021-07-06, then MMATQ on 2024-08-21`).
- **No data of its own.** The old symbol has none: `history`, `options`, `ticker` and one-ticker `fn` functions (`fn HIVG HFC`) end in that line with the command for the new symbol: ``HFC became DINO on 2022-03-15: `gloom history DINO` ``.
  - `quote` and `compare` keep the old line's last price and print ``RDS-A became SHEL on 2022-01-31: `gloom quote SHEL` `` above it.
  - The `--json` error has `code` `ticker_moved`, `tickerChange` and `retry`.
- **The new symbol.** The symbol a company renamed into (`META`, `XYZ`, `METV`) prints nothing extra, but its `history` from before the change says so: `Includes FB-era bars: META was FB until 2022-06-09`.

In `--json`, each row's `tickerChange` carries `kind`, `note`, `changes` and, for a company that moved, `tradesAs`, `issuer` and `listed`. A renamed company's new symbol has `kind` `formerly` and the symbol it had before (`METV was META until 2022-01-31`).

In the app, a pane that shows one ticker (Ticker Research, a one-security chart, HIVG) shows `RDS-A became SHEL on 2022-01-31.` and an Open SHEL button (Enter, or the pane menu). The quote monitor and lists keep the old line's last price, read STALE, and an add row says where a moved company trades now (`Meta Platforms trades as META`). The change history covers US listings from April 2017.

### Perpetuals and futures codes

A perpetual futures market works wherever a symbol is typed, as a listing on its venue: `quote binance:BZUSDT`, `watchlist add Energy hyperliquid:xyz:BRENTOIL`, or the saved forms `BZUSDT:BINANCE` and `XYZ-BRENTOIL:HYPERLIQUID`. `search brent` lists the Brent contracts, and a perpetual row in a watchlist or portfolio opens `PERP`. See [Perpetual markets](perpetuals.md#in-watchlists-quotes-and-search).

The FUT board's codes work wherever a symbol is typed (`quote`, `history`, `ticker`, `alerts`, watchlist and portfolio commands, the command bar).

- A code no listed security uses (TTF, ZN, 6E) is its future: `quote TTF` quotes `TTF=F`.
- A code a security also uses stays the security's (NG is NovaGold, CL Colgate, ZM Zoom). Its future is the `=F` symbol (`quote NG=F`), and `search NG` lists it right after the security.
- `search` and `catalog` say so when no source carries what was asked for, with the nearest listings that do: `search EUA` answers `No EU carbon price (EUA) yet. Proxies: CO2:LSE, KRBN.`

### Limiting rows

`--limit <n>` keeps the first n rows as printed. On a series that runs oldest first, such as `history`, those are the oldest, and text output says `showing the oldest 2 of 252 rows; --tail 2 for the latest`. `--json` carries `metadata.rows` (`shown`, `total`, `kept`).

`--tail <n>` keeps the newest n rows of a dated series (`history`, `fred`, `econ`), in their printed order, and the last n of any other list. The two cannot be combined. `fn` reports fail on either one they do not have.

### The economic calendar (`econ`)

`econ` lists the economic calendar from today (UTC), about two weeks ahead.

**Dates**

- `--from <date>` starts it on another day. An earlier day lists past events with the figures they were released with (`econ --from 2026-10-12 --country US` reaches the previous week's CPI). When the stored calendar starts after that day, text says `The stored calendar starts <date>` and `--json` has `metadata.storedFrom`. The stored calendar reaches back 400 days: an earlier `--from` fails as an input error naming the earliest day (`--from 2024-01-01 is before the earliest day the calendar reaches back to, 2025-09-20`), with `earliest` in `--json`.
- With no network or a server error, `econ` lists the current calendar and warns that the stored one could not be read.
- `--tail <n>` without `--from` keeps the last n events of the whole calendar, the past week's too.
- When the calendar stops less than a week past its first day, text ends with `No events listed after <date>` (`--json` carries the last day as `metadata.listedThrough`, and the ECO pane says it in its footer).

**Times**

- Rows are listed by their UTC day and time, with the weekday in `Day`; a release its publisher times also shows its own clock (`09:00 Sao Paulo`).
- An event that takes the whole day (a plenum, an election) reads `All day` in the time column, as does the ECO pane.
- `--tz <zone>` adds a column on another clock, named by its city, and `Day` moves beside it to give the weekday on that clock: `econ --country BR --tz America/New_York` shows the IPCA at `08:00` under `New York`, and a release at 01:30 UTC on a Wednesday as `Tue` `21:30`. An all-day event keeps its own day. `--json` has `day`, `viewerDate`, `viewerTime` and `metadata.timeZone`; an unknown zone fails with `Unknown time zone`.
- With `config set timezone`, the ECO pane shows the same column for your zone beside `TIME (UTC)` when it is wide enough.

**Countries**

- `--country` takes the ECO pane's regions (`US`, `G7`, `EU`, `all`) or any country by its ISO two-letter code, several comma separated. `UK` reads as `GB`, and `G7,MX` adds Mexico to the G7. `econ --country TR` lists Türkiye's CPI releases, and `ECO MX,BR` and `fn ECO --country MX,BR` open the pane on the same countries.
- `econ --country BR` lists IBGE's IPCA and IPCA-15 as `IPCA CPI m/m` and `IPCA-15 Mid-Month CPI m/m`: the actual and prior from the central bank's SGS series 433 and 7478 once the release time has passed, the forecast where the calendar has a consensus. The series chart as `FRED:BRAIPCAMOM` and `FRED:BRAIPCA15MOM`; `catalog IPCA` finds them.
- A national release in the euro area is its member's: the calendar shows the German Ifo as `DE`. The ECB's and the euro area's own releases stay `EU`, and `EU` still lists the members' releases.
- A country with nothing in the window says `No scheduled releases for MX in this window.` A code that is no country (`TUR`, `XQ`) fails with `Unknown country`.

**Publishers.** A row names who publishes it in the Publisher column (Freddie Mac for the 30-year mortgage rate, the Census Bureau for building permits), and `--json` carries `publisher`, `referencePeriod` (the period it covers: `Sep 2026`, or the week of a weekly figure, `22 Oct 2026`) and `sourceUrl` (the publisher's page). `--csv` has the same as `Publisher`, `period` (see below) and `Link`. A row whose listing names no publisher leaves them empty.

**Exports for scripts.** The text table draws Actual, Forecast and Prior as the calendar prints them (`3%`, `30.3K`, `-4.1M bbl`); `--csv`, `--ndjson` and `--json` carry them as numbers, the same on all three.

- `actual`, `forecast` and `prior` are numbers with the scale multiplied out (`30.3K` is `30300`, `-0.987M bbl` is `-987000`, `3%` is `3`), and null, an empty CSV cell, where the calendar has none or it is not one figure (`<1.25%`, a bound). Every figure the table can read is a number here (`1,250`, `30k`). `unit` says what they count (`%`, `bbl`, `b/d`, `Bcf`; empty for a plain count or an index level) and is shared by the three: a figure drawn in another unit is null. `scale` is the multiplier the row's first figure (actual, else forecast, else prior) was drawn in, `1000` for `K` and `1` for none, so `30.3K` is `actual` 30300 with `scale` 1000. It only says how the row was drawn: each figure is already multiplied out by its own scale, so `950K` beside `1.2M` is 950000 and 1200000 under `scale` 1000. The text as it was drawn stays in `actualText`, `forecastText` and `priorText` (`actual_text`, `forecast_text` and `prior_text` in CSV), so a bound like `<1.25%` that is no number keeps its words. The unit is also the row's `currency_or_unit`, where a percent is `pct` as in the other exports; `unit` keeps the `%`.
- `released` is when the figure came out: the row's time (a day alone for a row that states no time), empty until the row has an actual. A row with no figures at all (a speech, a meeting) has come out once its time has passed, so it carries its own time; one still to come, and a release with a forecast and no actual yet, leave it empty. It is the row's `as_of`. `period` is the reference period as its publisher words it (`Sep 2026`, `Q3 2026`, `22 Oct 2026`), `retrieved` when this export read the calendar. `--json` has `referencePeriod` and `released` on the row, and the retrieval time in `metadata.freshness.retrievedAt`.
- `indicatorId` (`symbol_or_series` in CSV and NDJSON) names the indicator a row is a release of: `us-unemployment-rate`, `gb-services-pmi-flash`. It is the same every month and whichever listing the row comes from; a row's own id changes when it moves from the week's listing to the stored calendar, so it is not kept. It is empty for a row the server sends none for.
- `consensusFeed` and `consensusReadAt` (`consensus_feed` and `consensus_read_at` in CSV) say which feed the forecast was read from, `week-feed` or `release-calendar`, and when that feed was read. They are empty for a row with no forecast and for one kept before the read was recorded.
- A window the default cap of 50 rows cut says so as the last lines of a `--csv` (`# note: showing the oldest 50 of 751 rows; --tail 50 for the latest`), as the text and `--json` do, with `--limit` to raise it; `--ndjson` writes it to stderr, so its stdout stays rows. The lines the text prints under the table (where the stored calendar starts, a bank that gives no time) are `# note:` lines in `--csv` too, and on stderr in `--ndjson`.

**Central banks and CPI dates.** The calendar also lists the rate decisions of the central banks `fn CBR` follows (Banxico, Copom, SARB, CBRT, RBI, BoK and the rest), each with the policy rate before it as Prior, and the CPI release dates INEGI (Mexico) and IBGE (Brazil) publish.

Those rows add a Local column with the publisher's own clock (`06:00 Mexico City` for INEGI's 12:00 UTC release); a calendar with none of them has no Local column, in plain output too, and the viewer's clock has its column only with `--tz`. The exports always carry both. `--json` carries `localTime`, `timeZone`, `timeNote`, `priorAsOf`, `publisher`, `referencePeriod` and `sourceUrl` on them.

**After a release time.** Once a high-impact release's time passes with no actual, the app asks Gloom Cloud for the calendar again (after about 15 seconds, then 30, then once a minute for 20 minutes) while ECO is in view or **Notifications** is on in ECO's settings.

With Notifications on (off by default) the number also shows in a toast when it prints, even while ECO is closed: `CPI m/m 0.3% vs 0.3%`, the forecast after `vs`.

### Dates, units and time zones

**Date options.** A date option takes `2026-10-01`, `1.10.2026` (day first), `Oct 1 2026`, `1 Oct 2026` or `October 1, 2026` (quote it when it has spaces: `econ --from "Oct 1 2026"`). That covers `econ --from`, `fred --start`, `fn CATL --from`, `fn KPIS --as-of`, `fn OVDV --date`, `fn GC --date`, `fn CTM --date`, `fn GIP --session`, `fn EM --period`, `--expiration`, `options --leaps --expiry-from` and a pane's date field.

A slashed date is refused with the formats it takes and the date to type: `type --from 2026-10-14 for 14/10/2026.`

**Units.** Headless chart text includes a Unit column when a series supplies one, and values keep that unit's scale (`2.7 %` versus `270 bp`). DVD text labels cash growth, CAGR and earnings payout as percentages, while their structured `value` fields stay fractional ratios (`0.03` means 3%), as are its yields (`0.045527`, `4.5527` in a CSV percent column).

**Time zones.** CLI text prints every time in UTC with the zone named (`2026-10-09 00:08 UTC`), and a date alone stays a date. JSON and CSV keep the raw ISO or epoch values. `gloom config set timezone Asia/Tokyo` (any IANA zone name) adds your own clock beside every UTC time (`2026-10-09 23:59 UTC (Sat 10 Oct 08:59 Asia/Tokyo)`), and `config set timezone none` goes back to UTC alone.

### Unknown options

A command fails on an option it does not take instead of ignoring it. `gloom history AAPL --since 2020-01-01` ends in `Unknown option --since for history.` with the options `history` does take (`--from` and `--to`), and a close match when you mistyped one.

- `financials` lists fiscal years, so `gloom financials WFC --quarterly` (or `--period`, `--freq`) points at `fn GF WFC --period quarterly --periods 40` (one metric over time) and `fn FA WFC --period quarterly` (the statements).
- A command that takes one symbol or currency fails on a second (`gloom fx NGN ZAR`; write a pair as `fx ZAR/NGN`), and `econ` fails on a country or impact it does not filter by.
- Everything after a bare `--` is an argument, never an option.

### `history`

`gloom history` serves each range in one bar size, listed by `gloom help history`.

**Ranges**

- `--range YTD` (any case) is the year's daily bars from the prior year's last close, the one year-to-date returns are measured from (`history LMT --range YTD` starts at 31 Dec 2025).
- `--range ALL` reaches back up to 50 years. When the source's first bar is well inside that, a warning says where it starts (`ALL starts 2014-09; the source has no earlier bar` for BTC-USD), or why nothing older is served (`Price history starts 1992-12-01; old-shekel quotes before 1992 are not served.`).
- `gloom help history` ends with where long history is. ZAR has daily FRED data from 1980 (`fred DEXSFUS`). NGN, SAR and ILS have no FRED series, daily bars for the last five years (`fn G USDNGN=X --rangePreset 5Y --chartResolution 1d`) and monthly bars only before that (`history USDNGN=X --range ALL`).
- `--interval 1s` says `No second or tick bars; 1-minute bars: fn GIP HYG; for a US listing, each trade: fn TAS HYG (a window: --from 10:30 --to 10:35), each quote: fn QR HYG.` (`fn GIP <ticker> --chartResolution 1s`, `30s` or `tick` and `catalog tick` say the same).

**What the output says**

- The line under the heading names the currency the prices are in (an FX pair reads `ZAR per USD`, an index `Index points`, a sub-unit `ILA (agorot, 1/100 ILS)`, `Currency unknown` when no source states one), the bar size served, the first and last bar and the bar count.
- `--json` carries the same in `metadata` (`currency`, `unit`, `interval`, `firstDate`, `lastDate`, `bars`, `requestedRange`, `asOf`). Every row has `currency`, `unit` (what one price is: `USD`, `index points`, `ZAR per USD`), `interval` and `flag`.
- Every `--csv` has one header, whatever the symbol, range or market state: `Date,Open,High,Low,Close,Volume,Flag,Partial,Filled,Unsettled,Volume unit,Volume note,Venue volume,Volume venue,status`, then the [five fixed columns](#what-every-exported-row-says) every export ends with. Prices are plain numbers, `Partial`, `Filled` and `Unsettled` are `true` or `false` on every bar, and `status` says why a row has no prices (`prices left blank: high<open`). Files of different symbols, or taken before and after the open, line up when joined.
- **Warnings** (stderr for text and CSV, `warnings` in JSON) say when the bars are coarser than the range is served in or start well after the start asked for (`Asked 5Y, data starts 2023-09-11 (first available bar)`), and for a coin name days with no daily bar. A bar whose prices contradict each other (high below the open or close, low above them) is left blank, with a code such as `high<open` in `flag`.

**Breaks.** A break in the series flags the bar after it, which keeps its prices:

- `gap` after any calendar month with no monthly bar, or three whole weeks with no weekly, daily or intraday bar.
- `jump` when its close is over 100 times the close before it or under a hundredth of it.
- A warning names each break, oldest first (`No bars for 2001-07, 2002-09 and 2026-02 to 2026-03 (2 months)`, `Close rises 564x from 0.0049 on 1980-07-01 to 2.763 on 1992-12-01`), and the heading line ends with `unbroken from 1992-12-01` (`metadata.unbrokenFrom`).
- `fn HP` and the `HP` pane name missing bars the same way, and the pane marks a change measured across them with `*` (`+3.42%*`).

**Coin volume.** A coin's volume is traded value in its quote currency, per UTC day on daily bars (`volume in USD per UTC day`, `volumeUnit` on every row). Its intraday volume is the value traded in the bar on major spot venues, so it does not add up to the daily figure, and a coin's 0 is read as no volume (a stock's 0 stays 0). Text prints a missing volume as `—`, with a warning counting the bars.

**Partial bars.** A bar whose period is still running is `partial: true` and marked `partial` in the Flag column.

- While a share's session trades, the day's bar in `history`, `fn HP` and the `HP` pane is read from the quote (`2026-10-16 DTD` in HP's table, `today so far` in its footer), and `HP` and `RETURN` show weekly and monthly bars as `2026-10 MTD` or `2026-10-12 WTD`.
- The closing line then dates the history by the last day it covers (`month to date, through Thu 15 Oct 2026`, `freshness.periodToDate` in `--json`).
- A coin's day rebuilt from hourly bars because the source left it empty is `filled: true`, without volume (`volumeNote` says why).
- A coin, a currency pair, a future or an index keeps the bars as served.

### A window of dates

`gloom history`, `fn HP` and `fn RETURN` also take a window of dates in place of a range: `--from` and `--to`, each a year or a date. `history JPM --from 2007 --to 2009` is every bar from 1 Jan 2007 to 31 Dec 2009. `history` also takes them as `--start` and `--end`.

- `--to` defaults to today and needs a `--from`. A `--range` typed with `--from` (or `--start`) is refused (`--from replaces --range; give one of them.`, naming the option as typed). `--end` alone asks for a `--start`. `shot HP` and `shot RETURN` refuse `--from` and `--to`.
- A window of up to five years comes in daily bars, up to twenty in weekly bars and a longer one in monthly bars. Where the source keeps no bars of the interval so far back it reads daily bars and says so: `1H bars do not cover 2015-03-01 to 2015-03-31; these are 1D bars.`
- `--json` carries the dates asked for as `metadata.requestedWindow` (`from`, `to`). A window that ended before today is not stale: its closing line reads `not a live feed (daily bars, 2007 to 2009)`.

**Max drawdown.** Each of the three prints the largest fall from a close to a later close over the bars shown, with the peak and trough and their dates, and the date a close got back to the peak: `Max drawdown -70.1% (daily closes): peak 53.20 on 2007-05-09, trough 15.90 on 2009-03-09, not back to the peak by 2009-12-31`.

- It is read off closes, so monthly bars can miss a fall that recovered within the month.
- `--json` carries it as `metadata.maxDrawdown` (`peak`, `trough`, `drawdown` as a fraction, `recovered`, `through`), and the CSV of `fn HP` and `fn RETURN` ends with it as a note.

### Several symbols

`gloom history AAPL MSFT 000660.KS`, or `history --file holdings.txt` with one symbol a line (`-` reads standard input), writes every symbol's bars in one long table: `history --file holdings.txt --start 2024-01-01 --end 2024-12-31 --csv > bars.csv`.

- Symbols load eight at a time. A list of more than ten skips the lookups of a bare symbol's other venues, as `quote` does.
- The `--csv` header is a single symbol's. Each row names its symbol, its currency and its own symbol's as-of in `symbol_or_series`, `currency_or_unit` and `as_of`.
- A symbol with no bars is one row with its reason in `status` (`Not a ticker: ZZZZQQ.`) and a warning on stderr. A list answered from a saved copy ends `couldn't refresh; saved copy from <time>` with the oldest copy's time, as one symbol does. The command exits 1 only when no symbol has any. Warnings shared by several symbols are said once, naming them.
- `--tail` and `--limit` apply per symbol. `--json` has the bars as one list, each with its `symbol`, and `metadata.symbols` describes each symbol or gives its `error`.

### `fx`

`gloom fx NGN` prints one unit of a currency in your base currency. A pair reads as markets quote it: `gloom fx USD/NGN` is how many naira one dollar buys, and `gloom fx ZAR/NGN` crosses the two through their dollar rates.

- The line states both directions, such as `1 NGN = 0.000752791 USD  (USD/NGN 1328.39)`. A rate keeps six significant figures, or cents from 1000 up.
- A pair typed without its slash (`gloom fx eurusd`) says to write it as `EUR/USD`.
- A currency's name stands for its code (`gloom fx yen` is JPY, `rand` ZAR, `Swiss franc` CHF) and the answer says which it read. A name several currencies share lists them (`peso`: MXN, ARS, COP, CLP, PHP, UYU, DOP) and you type the code. A code with no rate fails naming that code.
- The answer ends with the source line of [How current a report is](#how-current-a-report-is), dated by the older of the two USD rates: `Source: Gloom Cloud · FX trading day Fri 9 Oct 2026 close · 15 min delayed · markets closed` (`live` with real-time access, `stale` when a rate has not updated in time).

**The peso.** `gloom fx USD/ARS` (or `ARS/USD`) labels its rate the official wholesale one, then lists the market dollar rates Buenos Aires prices imply, pesos per dollar, each with its formula and the time of every price in it: CCL via the GGAL ADR (GGAL.BA × 10 / GGAL), CCL via the BYMA C line (GGAL.BA / GGALC.BA) and MEP via the D line (GGAL.BA / GGALD.BA). A price that did not come back leaves its rate out and says so. `--json` adds `spotKind` and `impliedRates` (`kind`, `rate`, `formula` and each input's `price`, `currency`, `observedAt` and `sessionOpen`). `gloom fn ADR <ticker>` compares any other receipt with its home listing the same way.

**Exports.** `--json`, `--csv` and `--ndjson` carry `currency`, `baseCurrency`, `rate` (base currency per one currency), `asOf`, `stale`, `pair` and `inverse`. `--csv` and `--ndjson` end with the five fixed columns: the pair (`ZAR/USD`), the base currency (`USD`), `spot`, the source and the rate's time. `--json` adds `metadata.freshness`.

**A past day.** `--date 2026-09-02` gives the rate at that day's daily FX close, the one a position's purchase-date cost is converted at. The source line dates it: `Source: Gloom Cloud · Wed 2 Sep 2026 · not a live feed (daily FX close)`. A weekend or holiday reads the trading day before and warns, and today has no close yet.

**Forwards.** `gloom fx USD/MXN --forward 30d` gives the forward implied by covered interest parity, labelled `implied by rates, not a dealer quote`: spot × (1 + quote rate × days/basis) / (1 + base rate × days/basis).

- The answer shows the forward points (pips of 0.0001, 0.01 against JPY), the premium or discount over spot for the period and a year, and both rates with their day and publisher.
- The rates are SOFR (USD), €STR (EUR), SONIA (GBP) and Banxico's TIIE 28d (MXN), so any pair of those works (`fx EUR/USD --forward 3m`). A missing rate says which one.
- Tenors count calendar days from today (`30d`, `2w`, `3m`, `1y`, up to a year). `--forward` with `--date` fails and names the command for that day's close.
- `--json` carries `forward`, `points`, `premiumPercent`, `annualizedPercent`, `baseRate` and `quoteRate`. `catalog forward` points here.

**Amounts.** An amount in front converts it: `gloom fx 1234.5 EUR/USD` and `gloom fx 1234,5 EUR USD` print `1,234.50 EUR = 1,385.06 USD`, then the rate line and the source line. The amount is in the first currency and the answer in the second (`fx 1234.5 EUR` converts to USD).

The amount reads as cash does (below), except that a comma before exactly three digits asks which was meant in every currency, as `alerts add` does: `fx 1.234 EUR/USD` converts 1234 euros, while `fx 1,234 EUR/USD` and `fx 1,234 KWD/USD` name both readings and convert nothing (`type 1234 or 1.234`). `--json`, `--csv` and `--ndjson` add `amount` and `converted`.

### `fred`

`gloom fred <series>` reads the FRED series Gloom Cloud serves, signed in or not. Any other series fails with `Unsupported FRED series DEXSFUS. List supported series with: gloom fred --list` (under `--json`, the `cli_error` code every input error has).

**Listing series.** `gloom fred` alone, like `fred --list`, prints the series with their titles, grouped by topic (Credit, Defense & fiscal, Energy, FX and the rest). Words after `--list` filter it: `fred --list credit`, `fred --list fx`, `fred --list defense`.

Credit has the ICE BofA US corporate (investment grade) index's effective yield in percent, by maturity and rating, beside the option-adjusted spreads, so a corporate bond can be read against the Treasury of its tenor (`fred BAMLC4A0C710YEY` beside `fred DGS7` and `fred DGS10`).

| By maturity | Series |
|-------------|--------|
| 1-3 years | `BAMLC1A0C13YEY` |
| 3-5 | `BAMLC2A0C35YEY` |
| 5-7 | `BAMLC3A0C57YEY` |
| 7-10 | `BAMLC4A0C710YEY` |
| 10-15 | `BAMLC7A0C1015YEY` |
| 15 and over | `BAMLC8A0C15PYEY` |

By rating, AAA to BBB: `BAMLC0A1CAAAEY`, `BAMLC0A2CAAEY`, `BAMLC0A3CAEY`, `BAMLC0A4CBBBEY`.

**Start dates.** Without `--start` it begins at 2021-01-01 and says so under the table. `--start` takes a date as any date option does, or `yyyy` and `yyyy-mm`.

- A series that begins later starts at its first observation (`fred DEXSFUS --start 1975` begins 1980-01-02), and says when, under the table and as a `# note:` line at the end of `--csv`. A day FRED has no value for inside the series (a holiday) stays a row with a blank value.
- A start past the series' last observation names the latest one, and `--csv` and `--ndjson` fail with a `--start` that reaches it.

**What the table prints**

- Every value to the series' own precision (FRED's `5.1` prints as `5.10` beside `5.09`). Exports keep the value as FRED gives it. Spreads (`T10Y2Y`, `T10Y3M`, `MORTGAGE30US10Y`, the ICE BofA option-adjusted spreads) print in basis points.
- A monthly or quarterly series is dated by its period in the closing line (`Aug 2026 (monthly)`), and by the day its newest figure was released when Gloom Cloud sends it (`Sep 2026, released Tue 20 Oct`). A flow at a seasonally adjusted annual rate says so in its value header (`Value (Billions of Dollars, annual rate)`). A series FRED publishes late (`UMCSENT`) carries a note saying where the newer reading is.
- A Treasury yield whose newest session Gloom Cloud read from the Treasury before FRED listed it says `Source: U.S. Treasury via FRED, published 2026-10-09`, and the row carries `publisher` and `publishedAt` in every export. Values FRED lists stay `Source: FRED`.
- Exports date each row three ways beyond `date`, which is the period it covers (`2026-09-01` for September): `period` (the same date), `released` (the day or time FRED's source released it, where Gloom Cloud sends it, which is the newest figure of a weekly to annual series; empty otherwise) and `retrieved`. `as_of` is the release. A figure with none stated is as of its own day only when the series says it is daily or weekly, and is empty for any other series (monthly, quarterly, a frequency it does not name, or none stated), never the first day of its period. `--json` rows carry `released` where it is known.

**Türkiye's CPI.** FRED does not carry it, so it is served as `TURCPIYOY` (percent change from a year earlier) and `TURCPIMOM` (from the month before), under Inflation, with TurkStat's figures as the Central Bank of the Republic of Türkiye publishes them (`Source: TurkStat via the CBRT`). The data catalog charts them as `FRED:TURCPIYOY` and `FRED:TURCPIMOM`.

**Housing.** Under Housing beside starts, permits and home sales: Freddie Mac's weekly mortgage rates (`MORTGAGE30US`, `MORTGAGE15US`, the PMMS survey, dated its Thursday release) and two series FRED does not have. `MORTGAGE30US10Y` is the 30-year rate less the 10-year Treasury yield (`DGS10`) on each survey date, the session before when the Treasury market is closed that day; it prints in basis points and says how it is computed under the table. `NAHBHMI` is NAHB's builder sentiment index (the Housing Market Index), each month as first released, read from the economic calendar's actuals: a month is dated its first day, every value carries its release time (`Source: NAHB via the economic calendar, published 2026-10-19`), and its history starts with the calendar's in January 2026. `fn ECST` lists the 30-year rate and the spread under Housing; `catalog mortgage`, `catalog PMMS`, `catalog NAHB` and `catalog homebuilder` find them, and the data catalog charts each as `FRED:<id>`.

**Exports.** Every export calls the observation `value`. Its unit is the row's `currency_or_unit` (`metadata.unit` in `--json`): `bp` for a spread (`315` for 3.15 percentage points), `pct` for a percent series, FRED's own units for any other (`Index 1982-1984=100`, `Billions of Dollars, annual rate`). `interval` is FRED's frequency (`daily`, `monthly`). `metadata.notes` and `metadata.latestObservation` carry the notes and the latest observation.

**Changes.** `--change 1D` or `--change 1W` adds each observation's change in the series' own unit: basis points for a spread (`1D chg (bp)`), percentage points for a percent series such as `DGS10` (`1D chg (pp)`), FRED's units otherwise.

- 1D is from the previous observation and 1W from the last one on or before the same day a week earlier, each within ten days, so a Monday reads against Friday.
- Every export adds `change` and `changeFrom` (the date it is measured from), and `metadata.change` names the horizon.
- It takes a daily series, or a weekly one with `1W` (`fred UNRATE --change 1W` fails and says why). How big a move was against the series' history is in `fn ECST` and `fn GC` ([move ranks](research-data.md#was-it-a-big-day-move-ranks)).

`gloom yield-curve` adds each tenor's move since the previous observation in basis points. Its yields export as `value` and `previousValue` in percent, with `pct` in `currency_or_unit`.

### Listings and exchanges

A symbol that trades in several places takes its exchange after a colon or with `--exchange`, in every command that takes a ticker:

```bash
gloom ticker SAN:EPA
gloom ticker SAN --exchange EPA   # both are Sanofi in Paris
gloom ticker SAN                  # the listing you saved, or Banco Santander in New York
```

Ticker, news and alert links (`gloomberb://ticker/7203:TSE`, `term.gloom.sh/?ticker=7203&exchange=TSE`) and a cashtag naming a listing in chat or a story (`$7203:TSE`, `$SAN:EPA`) read the same way.

#### Terminal codes and exchange aliases

A terminal's code is the listing it names, and a line such as `Read WFC.N as WFC:NYSE.` says how it was read.

| Typed | Read as |
|-------|---------|
| Reuters' `WFC.N` | `WFC:NYSE` |
| `AAPL.O` or `AAPL.OQ` | `AAPL:NASDAQ` |
| Bloomberg's `"JPM US Equity"` | `JPM` |
| `"JPM UN Equity"` | `JPM:NYSE` |
| `BRKb.N` | `BRK.B:NYSE` |
| `"BRK/B US Equity"`, `BRK/B` | `BRK-B` |
| `"MC FP"`, `"VOD LN Equity"`, `"7203 JP"`, one per line in a `--file` | `MC:EPA`, `VOD:LSE`, `7203:JPX` (`"SAP SE"` and other names before a legal form are the company; an unknown market code such as `AAPL GP` is refused with a suggestion) |

- Suffixes of listings abroad (`VOD.L`, `7203.T`, `RY.TO`, `0700.HK`) work as written. `fn` reads them as the listing their quote names: `fn INS RY.TO` is `RY:TSX`, with `Read RY.TO as RY:TSX.`
- Exchange aliases work: `SAN:XPAR` is `SAN:EPA`, `7203:TYO` and `7203:XTKS` are `7203:JPX`, `600519:SHA` is `600519:SSE`, `SAP:FRA` is `SAP:FWB2`.
- A code that names more than one exchange is read as the one the symbol trades on. `TSE` is Tokyo or Toronto, so `events 7203:TSE` is Toyota in Tokyo (`Read 7203:TSE as 7203:JPX: ...`), while `RY:TSE` is Royal Bank of Canada in Toronto. `KRX` is KOSPI or KOSDAQ, and `EURONEXT` any of the Euronext exchanges.
- A row saved under `KRX` for a KOSDAQ company is quoted from KOSDAQ: its Exchange column shows KOSDAQ, `quote` adds `Read 247540:KRX on KOSDAQ, where 247540 trades.`, and its `--json` quote names the board as `tradingExchangeName`.

#### When the exchange does not fit

- A symbol that trades on more than one exchange asks which, naming each (`Name one: X:TSX or X:JPX.`).
- An exchange the symbol is not listed on fails with the exchanges it does trade on, rather than falling back to another listing.
- Every command takes the same exchanges `quote` does. A listing that search leaves out but that has a quote of its own (`CAR:ASX`, CAR Group in Sydney) is a listing, so `filings CAR:ASX` answers for CAR Group.
- In a table of several symbols, the failing symbol's row carries the reason and the others still print.

#### Saving and labelling listings

- `watchlist` and `portfolio` take the same spelling to add or remove one listing, and `portfolio` to set a position or a target. Each changes only the row of the listing named, never another listing saved under the bare symbol.
- They say which listing they changed (`Added SAN:EPA (Sanofi)`), and `--json` carries `listing`, `symbol`, `exchange` and `name`.
- `portfolio show`, `watchlist show` and `fn PF` label each row's Ticker the same way, so two listings of one symbol read `SAN:EPA` and `SAN:NYSE`. Their `--json` and `--csv` keep the saved key in `symbol`.
- Reports name the company and exchange they resolved to: `ticker` in its header, table commands in a line above the table, and `--json` as `symbol`, `exchange` and `name` in `metadata`.

#### A bare symbol

- **With no US listing,** whose listings all belong to one company or fund, a bare symbol is its home listing: the first one `search` shows on an exchange of its own rather than a German regional or OTC line. `SXR8` is `SXR8:XETRA` and `CSPX` is `CSPX:LSE`, and `quote` and `compare` add a line such as `SXR8 -> XETRA`.
- **That no source serves** ends naming the listing it went to and the symbol's others, each with the command to retry: `gloom history SXR8` reads `SXR8 resolved to iShares Core S&P 500 UCITS ETF USD (Acc) (XETRA), which has no history.` and lists `SXR8:BUD ... (try: gloom history SXR8:BUD)`. `quote` and `compare` instead ask again on the symbol's other listings, and the first with a quote prints.
- `watchlist add` and `portfolio add` store a bare symbol on the listing `quote` reads it as (any US exchange is the symbol's one US listing, else the first listing with a quote). With several listings they say so: `IEO -> BATS (other listings: IEX, BMV)`.
- **A listing abroad saved first** never takes the bare symbol from its US listing. With `SHEL.L` saved under `SHEL`, `SHEL` is still `SHEL:NYSE` in the CLI, the command bar and a list's quick-add, saved as a row of its own beside `SHEL:LSE`; `watchlist remove` takes the US row first unless only the London one is on the list. The saved listing abroad answers for the bare symbol only when the symbol has no US listing (`GARAN`).
- **One slip from a US ticker.** A bare symbol read abroad that is one slip from a US ticker you are likely to mean says so under the table: `quote APPL` (Aptus Pharma on BSE) adds `APPL is not a US ticker: it is Aptus Pharma Limited on BSE (INR). Did you mean AAPL (Apple Inc.)?` (`usSuggestion` in `--json`). A named venue (`APPL:BSE`), a code with its suffix (`7203.T`) and a symbol you saved say nothing.
- **A currency code.** A three-letter currency code read on a listing abroad (`quote MXN` is mixi Inc on a German exchange) still prints that listing and adds `MXN is also a currency: fx MXN, quote USD/MXN`.
- **That several companies list** and that has a quote of its own goes where it always did, and the commands that read it say which company: `CAR = Avis Budget Group, NASDAQ (also XETRA, ASX, JSE, LSE, WSE)`. A search by name (`search lufthansa`) makes the company's own line the primary listing.
  - A company's primary listing is its common stock on its home exchange, whatever matched the query: `search Toyota` leads with 7203 on JPX, `search LVMH` with MC on EPA and `search Sony` with 6758 on JPX. Its depositary receipts follow, typed as receipts, so TM on NYSE and the LVMH receipt on TSX are under Other. A named venue (`SONY:NYSE`) is still read as written.
  - Each result is named by its own listing: `028050` on KRX is Samsung E&A even when a data source files it under Samsung Electronics.
- **A code several different companies list,** such as `2222` (Kotobuki Spirits in Tokyo, Saudi Arabian Oil in Riyadh), is not guessed. Every command asks which one, with `Choose an exchange for 2222.` and each listing with its retry command (`2222:TADAWUL Saudi Arabian Oil Co. (try: gloom history 2222:TADAWUL)`). `quote` and `compare` fail only that symbol's row, and so does `history`, whether it was given a range or a window of dates (`history FP --start 2024`): in a list the symbol is one row with its reason in `status`, and the others are still served.
- **What counts as one company.** Listings count as one company when, ignoring case, punctuation, legal forms (`Co.`, `Ltd.`, `S.A.`, `plc`), share wording (`Common Stock`) and depositary-receipt wording (`ADR`, `CEDEAR`, `CDR`), one name's words are all in the other's.

#### Index roots

An index typed with the venue search files it under (`^VIX:CXI`) is the index itself, as the bare `^VIX` is. A bare index root such as `VIX`, `SPX` or `MOVE` points at the index: `quote VIX` fails with `^VIX  Cboe Volatility Index (try: gloom quote ^VIX)`, and `quote MOVE` (Corvex) adds `also ^MOVE ICE BofA MOVE Index`.

A broker's code for an index is the index: `VIX.X` and `$VIX.X` (thinkorswim) and `$VIX` (Schwab) are `^VIX` in `quote`, `ticker`, `fn` and `search`, which says `Read VIX.X as ^VIX (Cboe Volatility Index).` Only the index roots the app knows are read this way. A `$` is otherwise a cashtag: `$AAPL` is AAPL, and `$MOVE` is Corvex.

#### Company filings and calendars for a listing abroad

SEC filings belong to US registrants. For a listing elsewhere, `filings` shows none when the SEC knows the symbol as another company, and says which. A company the SEC has nothing from says so (`CAR Group (ASX) files no SEC reports.`), as do `holders --form`, `insider` and INS. `RISK`, `EXEC`, `EK`, `DDIS`, `SEG` and `HDS` read the same way: `SAN:EPA` reads Sanofi's filings and never Banco Santander's.

**Earnings dates.** `earnings` labels each date `est`, `confirmed` or `reported` in its Status column, as `events`, `EE`, `ERN` and `OSA` do (see [research data](research-data.md)).

A listing outside the US reads its own exchange's calendar (`earnings SAN:MCE` is Banco Santander's Madrid date). One with no date of its own says so, with the same company's US line as an estimate when there is one: `BHP:ASX: no calendar for this listing; ADR date 2026-11-17 (estimate)`.

#### US-only data

Data that covers US listings only says so for a listing elsewhere and names the company's US listing, rather than showing another company's numbers under the same symbol:

- past reports, surprises and implied moves in `ERN` (`fn ERN SAN:EPA` shows Sanofi's next report and `Sanofi's US listing is SNY: ERN SNY has them.`)
- options (`GEX`, `OPX`, `OVDV`, `OSA`, `HIVG`, `VCA` and the current IV in `HVG` and `HVT`)
- time and sales (`TAS`, `QR`), FINRA short interest and volume (`SI`, `SIV`, `SIW`), macro release days (`MDAY`)

`fn TAS SAN:EPA` answers `Time and sales covers US listings only, and SAN:EPA is Sanofi on Euronext Paris (EPA).` with `Sanofi's US listing: SNY (try: gloom fn TAS SNY)`. A list such as `fn SIW SAN:EPA AAPL` leaves the listing out with the same line.

#### Functions with a symbol of their own

`MA` asks for a listing elsewhere by the quote symbol its deals are filed under: `fn MA ATH.TO` is `ATH:TSX`, the deals where `ATH.TO` is the target or the buyer, while plain `ATH` is Athene in New York. A function that takes several tickers (`ERN`, `SIW`, `CMP`, `GE`) reads each the way `quote` does.

### `fn` reports: arguments and errors

**Company functions asked about a non-company.** A function that reads company data (`INS`, `HIRE`, `APPS`, `CALLS`, `EXEC`, `RISK`, `CATL`, `KPIS` and the other filings and research functions) answers an index, fund or currency pair with what it is and a command that reads it: `gloom fn INS ^VIX` fails with `INS covers companies only, and ^VIX is an index.` and `Try: gloom fn VIX`.

A list leaves such a ticker out and says so. `LITI` takes funds too, and `FA` shows whatever statements a listing has.

**Defaults and arguments**

- `gloom fn PERP --tab history` and `fn CTM` without an argument start with a line saying which market they show (`Showing BTC. Try fn PERP ETH.`). `--json` carries it in `data.metadata.notices` and `data.metadata.defaultArgument`.
- `fn PERP`, `fn COT` and `fn CTM` fail on a name nothing matches and suggest ones that work.
- `fn EVTS SAN` opens with a line saying whether SAN reports on the board and when, and that `gloom fn ERN SAN` has SAN's own dates (`data.metadata.highlight` in `--json`).
- A function with no data report, such as `fn CAT santander`, fails pointing to `gloom shot CAT santander`.
- A function that takes no argument and is given one fails with its options and a command to run. A word that is one of an option's values runs as that option: `fn JODI gas` answers `JODI does not accept an argument. Options: --commodity <oil|gas>. Run: gloom fn JODI --commodity gas`. That holds for every function `catalog` lists with no argument, a rendered pane such as `HALT` as much as a report such as `CBR`.
- With `--require-bot-safe`, a report or screenshot that is incomplete because part of it needs Gloom Cloud Pro, or a sign-in, says so.

**Unknown functions**

- A name nothing opens (`fn volsurf SPY`) fails with the five closest functions and `Search the catalog: gloom catalog volsurf`.
- A code one slip from a function's code names it and the command that runs it: `fn RCDF PLTR` says `Unknown function or pane "RCDF". Did you mean RDCF (Reverse DCF)?` and `Run: gloom fn RDCF PLTR`. A name near no code says `No function code is close to ZZQX. List every function: gloom catalog`.
- A function code typed as a command (`gloom OVDV KO`, `gloom help OVDV`) answers `OVDV is a function: gloom fn OVDV KO`. Any other unknown command says `Unknown command` and the closest command.
- A word written as a ticker (`gloom PLTR`, `gloom BRK.B`) adds `To quote it: gloom quote PLTR` and `Find the ticker: gloom search PLTR`.

### Exit codes

A command exits 0 when it worked and 1 when it failed (bad input, no data found, a failed check). `gloom help` ends with the list.

**`fn` reports** fail when they have no data for what was asked: an empty report (`fn OVDV TWTR`: `A current underlying price is required`), rows with no value in them, or a list function (`fn SIW`) that finds nothing for any name. `--json` then says `ok: false` with an `error` (`code` `no_data`), so `ok` and the exit status always agree.

- Data for some of what was asked, with warnings about the rest, is a result and exits 0: a loss-maker's `PEB` or `RDCF` without a P/E or implied growth, `HIVG` with realized volatility but no IV, a pane beside `Quote unavailable.`, or one listing of several.
- A function that compares tickers fails before loading when given one: `fn CMP SPY` says `CMP needs two or more tickers: fn CMP SPY,QQQ`.
- A name that means implied volatility (`IVOL`, `OVOL`, `IV`) suggests `HIVG` and `OVDV`.

**`quote` and `compare`** exit 1 when none of the symbols given has a quote and 0 when at least one does. The others are named in the table, on standard error and in `--json`'s `warnings`: a symbol with no quote, one that names no listing (`EQT:NYSE:US`), and an entry that is not a symbol (`N/A`, `$$$`).

- Their `--csv` writes Last, Chg%, Prev Close and each extended print as plain numbers (`55.06`, `209500`), the currency in `Cur` and `currency_or_unit`. An extended print's move is in `Pre-Market Chg%`, `After Hours Chg%` or `Overnight Chg%`, and `compare` adds `Day Low` and `Day High`, all after the columns the export already had. A cell is never `NaN`: a row with no figure says why in its `status` column (`Not a ticker: ZZZZQQ.`, `Chg%: no previous close`), and the failures are on stderr with `--csv` and `--ndjson` too. `--ndjson` rows carry the reason as `status` too (`value_status` beside a field of that name), with a figure that is no number as `null`.

**`shot`** saves its PNG, prints the Reason line and exits 0 even when the pane drew an error, was empty, was still loading or was behind an access gate. `shot --strict` exits 2 in those cases, with the PNG still saved (`--json` carries `usable` and `unusableReason`). `fn` fails on `--strict`.

- `shot` takes a function's options as `fn` reads them: `shot 13F 0001067983 --compare SPY` opens the fund's Overlap against SPY's holdings, and a filter the pane keeps opens it filtered (`shot MA --status completed`, `shot INS AAPL --name "COOK TIMOTHY D"`, `shot CG --chamber senate --side BUY`, `shot HDS AAPL --sort change`, `shot RISK AAPL --year 2024`).
- An option only the report reads (`--limit`, `--offset`, `--explain`, `--section`, or a report filter like `--availability` on `CALLS`) fails with exit 1 and names the `fn` command that reads it. So do `--limit` or `--tail` on a function with no such option (`shot HP AAPL --tail 5`) and a slip of an option's name (`--veiw`).
- `gloom shot G palantir` stops with `Not a ticker: PALANTIR` and suggests `gloom search palantir`, before rendering or saving a pane. Resolve a company name to its ticker first.

In short DVD panes, Page Up/Down scroll the summary, arrows or j/k navigate history, and the mouse wheel scrolls the region under the pointer.

| Command | Use |
|---------|-----|
| `gloom` | Launch the terminal UI |
| `gloom launch-ui` | Explicitly launch the terminal UI |
| `gloom help` | Show all CLI commands, grouped, under a short Start here list |
| `gloom help <command>` / `<command> --help` | Show a command's usage, options, and examples |
| `gloom api list\|get\|invoke\|subscribe` | Inspect and call plugin capabilities directly |
| `gloom quote <symbols>` | Fetch current quotes |
| `gloom search <query>` / `provider-search <query>` | Search tickers and provider symbols. A sector word such as `defense` lists the large US-listed funds that track it first, then the companies named for it. `defense etf` or `gold miners etf` lists the funds alone, largest first |
| `gloom ticker <symbol>` | Show quote, ownership, and financials. Out of the regular session, Bid / Ask says whose book it is: `(pre-market book)`, `(after-hours book)`, or `(last quote, Fri 9 Oct)` |
| `gloom history\|financials\|fundamentals\|options <symbol>` | Fetch research data |
| `gloom news\|filings\|holders\|insider\|13f\|analyst\|events\|valuation <symbol>` | Fetch company research feeds |
| `gloom movers\|indices\|sectors\|fx\|fear-greed\|earnings` | Fetch market-wide data |
| `gloom econ\|fred\|yield-curve` | Fetch macro data |
| `gloom compare\|correlation <symbols>` | Compare securities (`relationship` is an alias of `correlation`) |
| `gloom portfolio [action]` | Show a portfolio's value, weights, targets and P&L. Manage manual portfolios, cash and target weights |
| `gloom watchlist [action]` | Manage watchlists |
| `gloom notes\|alerts [action]` | Manage local notes and alerts: price alerts, alerts days before earnings or any economic calendar release, CPI and FOMC included (`alerts add CRWV earnings --days 3`, `alerts add CN PMI`), and news, options flow and IV alerts (`alerts add IBIT iv above 50`) |
| `gloom broker list [--type <broker>]` | List connected broker accounts, optionally one kind such as `ibkr` |
| `gloom ai providers\|ask` | Use configured AI providers ([BYOK AI plugin](https://github.com/gloom-sh/gloom-byok-ai)) |
| `gloom rss fetch <url>` | Fetch an RSS feed |
| `gloom provider status` | Inspect enabled data providers |
| `gloom config\|cache\|plugin\|layout\|pane\|doctor\|version` | Inspect and manage local app state |
| `gloom fn [...]` | Run a pane-backed report command |
| `gloom shot [...]` | Capture a pane-backed screenshot |
| `gloom predictions [...]` | Launch Prediction Markets ([Prediction Markets plugin](https://github.com/gloom-sh/gloom-prediction-markets)) |
| `gloom plugins` | List installed plugins |
| `gloom install <user/repo>` | Install a plugin from GitHub, at the commit the registry reviewed when it is listed |
| `gloom remove <name>` | Remove an installed plugin |
| `gloom update [name]` | Update plugins to the next reviewed commit |
| `gloom plugin enable\|disable <id>` | Turn a plugin on or off without removing it |
| `gloom plugin link <path>` | Load a plugin from a local checkout while developing it |
| `gloom plugin doctor [name]` | Check that a plugin loads, declares its hosts, and compiles for the desktop |

### `news`, `13f`, `holders` and `filings`

**`news`** takes a ticker or text.

- A real ticker such as `news AAPL` lists its own news. In capitals it keeps its company news: `news GOLD` is Gold.com Inc., while `news gold` names the metal under the stories.
- Text (`news "european gas"`), a single word no listing answers to, or a futures board code such as `news TTF` lists the stories that have every word of it as a whole word (`price` and `prices` alike, never Arabia for arabica), those with every word in the headline first.
- A commodity name (`coffee`, `arabica`, `sugar`, `wheat`, `crude oil`, `natural gas`) also lists the stories filed under its future, and a commodity's future (`news KC=F`) lists the stories of its commodity. A metal's future, name or board code (`news GC=F`, `news SI=F`, `news gold`, `news GC`) lists that metal's market news (stories tagged `METALS`).
- Text that matches no story says `No stories match "<text>"`, with the commodity's future (`gloom news SB=F`) when the text names one whose news has stories.

**The others.** `13f` is the holders list without insiders (`fn 13F` has 13F filings). `holders --form 13d|13g|all` lists 13D/13G beneficial owners. `filings --form <form>` keeps one form, with an Items column naming each 8-K's items (`2.02 Results of operations`). `--json` and `--csv` keep the codes in `items` (`Items`) and add the names as `itemsLabel` (`Item names`).

### `options`

`gloom options AAPL` prints the nearest expiry's contracts and lists every expiry above them (the nearest 40 when a chain has more). `--expiration` takes a date (`2028-01-21`) or Unix seconds, and a date the chain does not list fails with the nearest listed dates.

IV is solved from quote midpoints (not the provider's own implied volatility), and delta from that IV, the underlying's current price, its dividend yield and a 4% risk-free rate. A contract with no two-sided quote, no current underlying price or no time left shows a dash. A chain still quoting the last close is valued at that close.

The line under the table names the spot and time they are valued at and the open interest's date: `Greeks at spot 89.79 (close Mon 12 Oct), dividend yield 2.34%, rate 4% · OI as of Fri 9 Oct` (`OI date not published` when it cannot be established; [method](research-data.md#greeks-spot-and-time)).

- `--csv` writes IV and delta as decimals under `IV (annualized decimal)` and `Delta (decimal)`. Every row carries `Spot`, `Spot basis` (`close`, `last`, `pre-market`, `after hours`), `Spot as of`, `OI as of` and the five fixed columns, with `interval` reading `snapshot`.
- `--json` and `--ndjson` carry `iv` (a fraction) and `delta` on each contract. `metadata.model` has `spot`, `spotBasis`, `spotAsOf`, `valuationTime`, dividend yield and rate, with `metadata.openInterest.asOf`, `metadata.currency`, `metadata.interval` and `metadata.units`.
  - `metadata.fields` says `iv` is the one solved from the quote midpoint (which delta and GEX use) and `impliedVolatility` the provider's own figure.

#### Long-dated contracts (`--leaps`)

`gloom options AAPL MSFT NVDA GOOGL AMZN META --leaps` ranks long-dated contracts across the symbols, for a stock replacement: those more than a year out unless a window says otherwise.

- It keeps calls (`--side puts` for puts) whose absolute delta is in `--delta` (default `0.70-0.90`), with a two-sided quote at most `--max-spread` percent of the midpoint wide (default 5) and open interest of at least `--min-oi` (default 100).
- It sorts by extrinsic per year, lowest first. `--sort` takes `carry`, `spread`, `oi`, `delta`, `expiry` or `symbol`.
- Each row has the expiry, days to it, strike, delta, bid, ask, spread %, open interest, extrinsic and extrinsic per year. `--csv` and `--json` add the contract symbol, spot, currency, the chain's as-of time and whether its quotes are delayed. Text shows the best 40 rows unless `--limit` or `--tail` says otherwise, and the exports carry every row.
- A symbol with no chain, no expiry in the window or no current quote is named in a warning and the others still rank. The run fails only when no chain loads.

**The expiry window** starts a year out. `--min-days` and `--max-days` bound it in calendar days (`--min-days 180` reaches six months out, `--min-days 365 --max-days 730` is 12 to 24 months), and `--expiry-from` and `--expiry-to` by date (`--expiry-from 2027-10-15 --expiry-to 2028-10-13`). A lower bound of either kind replaces the one-year start, and `--expiration 2028-01-21` ranks that one expiry.

- A window no expiry can fall in fails before anything is read, naming the option to change (`--max-days 300 is under the 365 days --leaps starts from. Add a lower bound, such as --min-days 180 --max-days 300.`). A decimal comma is answered with the number to type (`--delta 0,80-0,90` gets `use a dot: 0.80-0.90`).
- Each symbol reads up to 8 expiries in the window, the 8 nearest its start, and a warning names the later ones left out (`read the 8 expiries nearest the window's start, through 2028-12-15; 1 later not read (2029-01-19)`). Raising `--min-days` or `--expiry-from` reaches them.

**Extra columns.** `--columns iv,ivr,cost,breakeven,next-earnings,ex-dividend,carry-net` (any, comma-separated) adds what the contract costs and what is ahead of it:

| Column | Adds |
|--------|------|
| `iv` | The contract's IV |
| `ivr` | The underlying's IV rank |
| `cost` | The cash per contract at the midpoint |
| `breakeven` | The break-even at that midpoint and its distance from spot |
| `next-earnings` | The next earnings date as `earnings` resolves it |
| `ex-dividend` | The latest ex-dividend date |
| `carry-net` | Extrinsic per year net of the interest on the strike and the dividends |

- `--csv` and `--json` carry each as a column on every row (`IV %`, `IV Rank` and `IV Rank As Of`, `Cost/Contract (mid x 100)`, `Breakeven (at mid)` and `Breakeven vs Spot %`, `Next Earnings`, `Ex-Dividend`, `Carry Net/yr %`).
- In text, IV goes beside delta, and `Net/yr`, `Cost`, `B/E` and `B/E%` after `Extr/yr`. The underlying's IV rank, next earnings and ex-dividend date go in a table above the contracts, one row per symbol. To fit 100 columns the table drops the break-even price first, then bid and ask, then extrinsic per share.
- A figure a symbol lacks is a blank and one warning line, never an error. The figures are defined under [OMON strike window and carry](research-data.md#omon-strike-window-and-carry).

#### `fn OMON`

`gloom fn OMON META --expiration 2028-01-21` reports every strike the chain lists for that expiry and says how many those are (`data.metadata.strikes` in `--json`). Without `--expiration` the chain opens at the nearest expiry.

- `--strikes 10` keeps 10 either side of the money. `--strikes 0.70-0.90` (or `--delta 0.70-0.90`) keeps the strikes whose call or put delta is in the band. `--strikes all`, the default, keeps every strike.
- `--columns bid,ask,spread,delta,openInterest,extrinsicPerYear` picks the fields mirrored around the strike. `costOfSpot` adds the put's midpoint as a percent of spot on the put side ([method](research-data.md#omon-strike-window-and-carry)).
- `gloom shot OMON` takes the same options, and its result names the rows cut above or below the view.
- The report and the image name the expiry with its days left (`Expiry 2028-01-21 (469d)`, `data.metadata.expiry` in `--json`), and the report ends with the chain's as-of and delay in the same words as `options`.

### Adding and removing symbols

`gloom watchlist add <list> <symbols...>` and `portfolio add`, and `remove` for both, take any number of symbols split by spaces, commas or newlines:

```bash
gloom watchlist add Growth "AAPL, msft" NVDA
pbpaste | gloom watchlist add Growth      # or `-` for standard input
gloom watchlist add Growth --file holdings.csv
gloom watchlist add Growth NVDA 'philip morris intl' --dry-run
```

The first argument names the list (quote a name with spaces). A list nothing names fails with the lists there are, and a pasted list of symbols with no name in front says so (`did you mean watchlist add <name> <list>`).

#### How an entry is read

In an argument with commas, semicolons, tabs or newlines, an entry with spaces in it can be a company's name (`watchlist add Growth "WHR, Whirlpool Corporation, BRK.B"`). An argument without those separators is split on spaces.

- When search finds a company whose name has every word of the entry, it is that company's primary listing, the one `search` lists first, and a line says which it was read as: `Read "Whirlpool Corporation" as WHR:NYSE (Whirlpool Corp).` A line on another venue or a depositary receipt comes only after it (`SAP SE` is SAP:XETRA, `VOLVO AB` VOLV.B:SFB), so a receipt is read only for a company listed by receipts alone (`PDD Holdings` is PDD:NASDAQ). When that listing has no quote, the company's next listing with one is read instead. A word may be a short form (`philip morris intl` is PM).
- A listing's vendor suffix is read as its venue, so `GARAN.IS`, `GARAN:BIST` and `GARAN` are one row, `GARAN:BIST`, whether added, pasted, imported or given to `position set`. A one-letter suffix can also be a US share class (`MKC.V` is McCormick's voting class on NYSE), so `7203.T` or `VOD.L` is read as its venue only when the listing's quote, or a row saved there, names that venue. `remove` takes the venue's row, else a row still saved under the suffixed key (a broker's). A symbol whose own quote names its listing (as `quote` reads it) is added without a search, so a busy search never blocks it.
- Rows a portfolio or watchlist holds under a suffix (`GARAN.IS:BIST`, from before) merge into their listing's row when the app launches, after a sync pull, and before a `portfolio` or `watchlist` command changes a list (never on `--dry-run`, and never for a command that only reads). Lots are added once each, and lists, tags and target weights move over; a custom field keeps the listing's value where it has one, and the suffixed row keeps a value it differed on. A merge saves under the venue's key (`SHOP.TO` becomes `SHOP:TSX`), so a bare `SHOP` still means the US listing. A broker's rows stay as the broker keys them.
- When search finds none, the entry is the symbols its words are when each is written as a symbol or has a quote: `BRK.B BF-B, NVDA` is three symbols and `aapl msft` two. Otherwise it stays one name that is not found.

`quote`, `compare`, `earnings` and functions that take several tickers read their arguments the same way. `quote` and `compare` given one quoted argument with spaces read it as a company's name when search finds it (`quote "Apple Inc"`), as symbols when none of the words is known to be no ticker (`quote "AAPL MSFT"`), and otherwise as a phrase, answered with what `search` finds (`quote "10 year yield"` never quotes YEAR and YIELD).

`remove` splits every entry on its spaces.

**Files and standard input.** `--file holdings.csv` or piped input (`pbpaste | gloom watchlist add Growth`, or `-`) supplies symbols. `quote` and `compare` read a list the same way (`pbpaste | gloom quote -`), and only when asked.

- Each line is an entry of a typed list: `Altria Group`, `philip morris intl` and `Lockheed Martin` on three lines are MO, PM and LMT, and `AAPL MSFT NVDA` on one line is three symbols.
- A byte order mark, Windows line ends, blank lines, lines starting with `#` and repeated symbols are skipped. A separator stuck to a symbol (`UPST;`) is dropped with a warning (`Ignored the stray ";" after UPST.`), and quote marks around a symbol are dropped silently.

**Reading a CSV.** A CSV is read from its Symbol, Ticker or Code column, else from its Name or Company column as names. Without that header every cell is a symbol.

- Names, prices or weights beside the symbols of the first column (`AAPL,Apple Inc.,336.64`, `AAPL 150.00`) are left out, and a warning names the cells (`Read the first column as symbols; ignored the 2 cells beside it: Apple Inc., 336.64.`). Each line is split by its own tab, semicolon, comma or spaces.
- A comma inside a number that can only be a number (`2.582,52`, `1,899.21`) is a decimal comma. A comma between plain digits (`0700,25`) is a decimal comma only on a line with a tab, semicolon or spaces between its cells (`ED 116,26`), otherwise it splits the line (`quote 9988,5` quotes 9988 and 5).

**Numbers and things that are not symbols.**

- A number is never a symbol, however written (`2.582,52`, `1,899.21`, `-2,5%`, `€12,50`). Beside a symbol it is a value. On a line of its own it is left out and named in one warning (`Ignored 2 numbers, not symbols: 1.899; 2.582,52.`).
- A whole number is a code when it is the symbol (`7203`, `2330:TWSE`) and a value beside a symbol of letters (`ED 2582`).
- An entry that names nothing (`N/A`, `#N/A`, `$$$`, `--`, `-`) fails at once with `Not a symbol: $$$`.

#### What it prints

Each symbol gets a line (`Added AAPL:NASDAQ (Apple Inc.)`, `Already in the list: ...`, `Not found: XXXXX`), then a summary such as `Watchlist "Growth": 251 added, 5 already in the list, 43 not found: XXXXX, FAKE123.`

- One symbol that fails never stops the others, and the list is written once at the end. The command exits 0 when at least one symbol was added (or removed) or already was, and 1 when none resolved.
- `--json` and `--csv` give a row per symbol with its `status` (`added`, `already_listed`, `removed`, `not_listed`, `not_found`, `needs_choice`, `failed`, `not_a_symbol` or `not_looked_up`), the listing and the reason. Counts and summary are in the JSON metadata and on standard error beside CSV.
- `add --dry-run` looks every symbol up and prints the same lines and summary without saving. `create`, `delete` and `remove` refuse `--dry-run` and change nothing.

#### Near matches and choices

- A symbol that search finds nothing for but has a real near match (same punctuation or one slip) is not added: `Not found: USD_NGN; did you mean USDNGN=X (US Dollar/Nigerian Naira)?` The row carries `suggestion`.
- A code several companies list is not added either. Its line names the listings to choose from and, when the company that held the symbol moved, where it went: `Not added: NEP (Choose an exchange for NEP: NEP:SET, NEP:XHAM; NEP became XIFR on 2025-02-03)`. The row carries `choices` (`key`, `name`), `listingCount` and `successor`.

**A bare US-style symbol that needs a choice.** It is not stored as it matched when the listing found stopped trading (`NYCB`), is abroad while the symbol also names a US listing (`DFS`, Discover's until 2025, which lists DFS Furniture in London now), or was taken by another company in the last two years (`BRKL`, Brookline Bancorp's until 2025, a fund's now).

- It goes under `Needs a choice, not added`, with what became of the company that had it (`DFS was Discover Financial Services until 2025, now Capital One Financial: COF; DFS matched DFS:LSE (DFS Furniture plc), a listing abroad`).
- Two commands follow: one adds what those companies trade as now, the other keeps each match by naming its listing.

- A symbol taken over longer ago is added, with a line saying who had it. Coins, perpetual markets and currency pairs are added.
- A symbol that only ever listed abroad is added on that listing, with a line naming its venue and currency: `GARAN has no US listing; it trades on BIST, in TRY.` (`abroad` in a `--json` row, a warning for one symbol). One more likely typed for something else stays a choice: `APPL` is one slip from AAPL, and `MXN` is also a currency.
- The summary counts them (`3 need a choice: DFS, NYCB, BRKL`), and `--json` puts the company's symbol now in each row's `tradesAs` and the count in `metadata.needsChoice`.

**Batches and retries.** Symbols are looked up in batches. If Gloom Cloud refuses requests meanwhile (signed out, it limits how many a minute), the symbols that may have failed for that are listed together, not as "not found", with one command that adds them again: `Try again in a minute: gloom watchlist add Growth NVDA 'philip morris intl'`.

#### In the app

`AW` takes the same lists, split the same way (spaces alone are a list unless search knows the words as one company's name, such as `palo alto`). Every symbol that resolves joins the watchlist, and one notice gives the summary and names each symbol left out with its reason. `AW` or `AP` on one typed symbol that would need a choice says why and what to add instead.

### Which lists hold a company

`gloom ticker` names the portfolios and watchlists that hold the company by any of its listings, and which listing when it is another: on a watchlist `R` that holds `RCI.B:TSX`, `ticker RCI` reads `Watchlists R (as RCI.B:TSX)`.

A company's listings are the ones Gloom Cloud groups under one issuer (share classes, a US receipt and its home line, dual listings). `--json` carries them as `memberships` (`portfolios` and `watchlists`, each `name` and `via`).

`portfolio` and `watchlist` come with the Portfolio plugin, `notes` with Notes, `alerts` with Alerts, and `rss` with News. Turning one of those plugins off with `gloom plugin disable` also removes its commands.

`gloom notes export [dir]` writes readable notes as Markdown and warns about each note or source it could not read (quick-note bodies are still exported under `quick/<id>.md`). Export Notes in the app reports the same warnings.

`gloom shot TAS AAPL --output tape.png` and `gloom shot QR AAPL --output quotes.png` capture a dated trade or NBBO snapshot with the current Cloud session's access delay.

### Time and sales windows

`gloom fn TAS HYG --from 10:30 --to 10:35` lists the trades and quotes of a window of the session the tape serves, oldest first. Times are New York's clock (`14:30Z` for UTC), and either bound alone runs the window to that end of the session. A bound outside what is served is refused with the window that is. See [Time and sales](research-data.md#time-and-sales-tas-qr) for the limits.

`gloom fn CDX` dates each index by its own trade date. While today's New York date still trades, it marks the index `so far` with its prints and last print. HY and EM add a spread equivalent of their price. `fn CDX --explain` defines the columns, and [Index and sovereign CDS](credit-reference.md) explains points, upfront, the roll and the conversion.

### Glossary

`gloom catalog glossary` lists the terms the functions show, under the function that shows each (rates, auction, credit and bond yield, energy, perpetual-futures, portfolio, fund, short interest, quote-board, futures and economic-calendar terms, for AUCT, GC, BTMM, WIRP, CBR, CRD, CAT, TRACE, DVD, FUT, CTM, EPWR, PERP, PF, ETF, SI, SIW, SIV, QQ and ECO).

`gloom catalog glossary stop-out` or `gloom catalog explain B/C` prints what one term means in a sentence or two, found by its name, abbreviation or another name for it. `catalog explain premium` prints both meanings: a perpetual's premium over the price it tracks, and an ETF's premium or discount to its NAV.

**Searching the catalog**

- A plain `gloom catalog <query>` names the terms it matches under the functions. Beside a term the query names, the related ones hold its words whole: `catalog float` relates no floating rate note. A multi-word query lists the functions that carry every word in their name or description, or the few closest when none does (`--all` lists every match).
- A topic no function covers, such as `catalog "defense budget"`, says so and names the nearest functions. `catalog "borrow fee"`, `catalog utilization` and `catalog locate` say that borrow data is not available and name `SI`, `SIW` and `SIV`.
- A `search` that finds no ticker lists the functions that carry every word of the query instead (`search "target weights rebalance"` names `PF`).

**Explaining a report.** `gloom fn AUCT --explain` follows the report with the meaning of each term it shows (`data.glossary` with `term`, `short`, `definition` in `--json`; `--csv` and `--ndjson` keep the rows only). `gloom portfolio show <name> --explain` does the same for the rebalance table (`metadata.glossary`). Another command given `--explain` points at the glossary.

**Central banks.** A search naming a central bank on the CBR board (`search "Swiss National Bank"`, `search SNB`) lists the bank's policy-rate series to chart. A FRED series id (`search DFEDTARU`) or a chart id (`search CAP:policy-rate:ch`) finds its series.

`events ECB` (or another bank's name or acronym, with no exchange) answers `ECB meetings are not listed; CBR shows the rate and the next decision (gloom fn CBR).` The listing that shares the acronym is `events ECB:WSE`.

**Funds.** A US-listed fund's facts (fee, NAV, premium, net assets) are in `fn ETF <symbol>`, which `ticker` and `fundamentals` point to for a fund. A fund listed elsewhere has none yet.

- A fund's filings are its own: a trust that files for many funds (ProShares Trust, iShares Trust) lists only those filed under the fund's series, as EDGAR does, and `fn SEC <symbol>` keeps the trust's whole list.
- `fn ETF` for a fund that files none of the fund forms it lists (a grantor trust such as `IBIT` or `GLD` files 10-Qs) says so and points at `fn SEC <symbol>`.

**Functions behind the sign-in wall.** A pane behind the wall, such as `fn DIAG MSTR` signed out, says `Requires a free Gloom sign-in`, and `catalog DIAG` lists it under Requires (`gloom catalog` lists each with what it Requires).

- A report that read nothing because a wall covered the whole pane cites no source and says `the pane is locked, so no values were read` (`--json` marks it `locked`).
- A function a wall covers whole says what a free account can still read instead and names the app's Log In and UPGRADE commands, in the same three lines as text, as the `reason` of `--json` and as the `# incomplete` line of `--csv`. An account whose email is not verified yet is told to resend the verification email.
- `fn EM`, `fn GUID` and `fn BUZZ` need only a free sign-in (`needs a free Gloom sign-in` instead of Pro). EM and GUID point at `earnings` and `fn GUIDE`, and BUZZ has no free route.

The free routes the wall names, only when they have data for the ticker:

| Function | Points at |
|----------|-----------|
| `fn EK NEM` | `fn SEC NEM`, whose rows list the same 8-Ks with their filing dates and items |
| `fn RISK NEM` | `filings NEM --form 10-K`, the 10-Ks it reads with each filing's date and a link (not the analysis). `fn RISK ASML` points at the 20-F |
| `fn CALLS NEM` | `events NEM`, the earnings dates with the EPS reported at each |
| `fn JOBS NEM` | `fn HIRE NEM`, the free preview of the same hiring data |
| `fn FLOW` | `options <ticker>`, a chain with each contract's volume and open interest |

`gloom config set telemetry.crashReports false` turns off automatic crash reports, and `gloom config set telemetry.usage false` turns off anonymous usage counts and the command bar search log; see [Crash reports and usage counts](telemetry.md) for what each contains.

On the third day you open the terminal app, after a minute on screen, the status bar asks once to star Gloom on GitHub. `Alt+Enter` opens the repository, `Alt+Backspace` or the × hides the line, and it never comes back either way. `gloom config set starPrompt.enabled false` turns it off before it ever shows.

### CSV and NDJSON from reports

`gloom fn <function> --csv` writes the report's table as flat rows a spreadsheet can open. The header is the columns the text report shows (`Index,Name,Last,Change,Change %`), and every cell is a plain value.

**Values**

- Numbers carry no thousands separators, compact scales or units: `1.20B` is `1200000000`, `+3.45%` is `3.45`, and the unit moves into the header (`Yield (%)`, `Market cap ($)`). A table of metrics, one per row, names each row's unit in its label instead, and a column that mixes units is followed by a `<column> unit` column.
- Times are ISO 8601 with their zone. A date stays a date.
- A series keeps its own unit's scale under bare `Value`, `Open`, `High`, `Low`, `Close` headers, and names the unit in each row's `currency_or_unit` (`%`, `bp`, `ZAR`).
- A function's header is the same for every symbol: a column with no figures keeps its unit (`IV30 (%)` for `SCHD` as for `SPY`).
- A cell the text fills with why a figure is missing (`not quoted`, `no 25D quotes`, `under 7d`) is empty, with the reason in a `status` column after the data (`RR, BF: no 25D quotes`; `value_status` in a table with a Status column of its own). Text such as a range `2.0-3.0`, `N/M` or `ATM` stays in its column.

**Several tables.** A report with several tables, such as `WEI` by region, writes each as its own block: a `# section: <title>` line, the header, the rows, and a blank line.

- `--section <title or number>` (any case, numbered from 1) writes only that table (`gloom fn WEI --csv --section europe`). The start of a title is enough when no other starts the same way (`fn OPX IBIT --csv --section strikes`), and an unknown section fails and lists the report's.
- `CALLS` keeps `--section` as the transcript part it reads.

**Empty reports.** A series report with no rows fails `--csv` and `--ndjson` (exit 1) instead of writing a header alone, saying what was asked and what to try. Other reports, such as a list a filter leaves empty, still write their header.

A FRED series ID given where a ticker goes says to chart it as `fn G fred:DEXSFUS` (one the data catalog lists charts as that series once no listing answers to it: `fn G DFII10` is `fn G FRED:DFII10`, while `fn G IR` still charts the ticker).

**Bars the source does not serve.** A chart asked for bars the source does not serve for the range (`fn G USDZAR=X --rangePreset ALL --chartResolution 1d`) says so on stderr and in `--json` (`warnings`, `data.metadata.resolution`): `1d is not available for ALL on USDZAR=X (1d bars go back 5Y at most); returning 1mo bars.` Each row's `interval` is the bars returned.

**Trailing lines.** After the data, CSV ends with `#` lines: the source, as-of and status line the text prints, the [export source lines](#how-current-a-report-is), `# incomplete` with what is missing (`# incomplete: 19 of 20 available`), and `# error:` and `# note:` lines, among them what a `--limit` or a command's default cap left out (`# note: showing the oldest 50 of 751 rows; --tail 50 for the latest`). `--ndjson` says that on stderr. `pandas.read_csv(..., comment="#")` skips them.

#### What every exported row says

Exports end each row with five fixed columns, so a row still says what it is after `head`, a filter or joining files. They are on every `--csv` export that ends with the source lines and every `--ndjson` row of the same commands (`history`, `fred`, `fx`, `yield-curve`, `quote`, `fn` reports and the rest listed under [How current a report is](#how-current-a-report-is)).

| Column | What it holds |
| --- | --- |
| `symbol_or_series` | The symbol or series ID asked for: `USDZAR=X`, `SAN:EPA`, `DEXSFUS`; each row's own ticker in a table of several (`fn DVD MUB VTEB`); blank for a report about no one symbol |
| `currency_or_unit` | The currency or unit of the values: `ZAR`, `USD`, `bp`, `pct`, `index points`; blank when the values mix units (their headers name them) |
| `interval` | The bar interval or observation frequency actually returned: `1d`, `1mo`, `daily`, `monthly`, `spot` for an FX rate, `snapshot` for an options chain |
| `source` | The source the `# Source:` line names: `Gloom Cloud`, `FRED` |
| `as_of` | The `# Observation date:` of the export in ISO 8601, the same on every row; blank when it reads `not published`. Rows dated apart carry their own (a `fn DVD` ranking dates each ticker's row by the price its yields are over). In a statistic's export (below) it is the day or time the figure was released |

`econ`, `fred` and `fn ECST` also end each row with three more columns, after the five: `period` (the period the figure covers), `released` (when it came out, empty where the data does not say) and `retrieved` (when the export read it, an ISO time in UTC). Their `as_of` is the release, never the retrieval time or the first day of the period. In `fn ECST` the table's own `period` and `released` columns stand in for them, and `Previous period` says which period `Previous` is. `history` and the other market data keep `as_of` as the time of their last bar or quote.

A row's own `symbol` and `currency` fill the first two when a command does not state them. A `fn` report whose rows are of different symbols says which fields name them, as `fn RV NESN:SWX AAPL` does for each peer's ticker and currency. `--ndjson` writes one JSON object per table row, keyed by the same column names, with a `section` field when the report has several tables. `--json` is the full report with every field, plus the export `source` object.

`fundamentals` and `valuation` follow the same rules: `Metric,Value` rows with the unit in each label (`Market Cap (ZAR)`, `Dividend Yield (forward) (%)`), and for `fundamentals` a second `Profile` table. `financials --csv` writes the statement table with plain amounts under its displayed columns. All three end with the source line.

**How far back.** `financials` and `fn FA` close with how far back their periods go (`annual history from 2021; older years not served`, and for `--period quarterly` the oldest quarter), and the route to more: `gloom fn GF KO --period annual --periods 40` reads one metric over every period it holds.

**An old latest period.** A latest period over 15 months old is said first (`Latest period 2024-06-30 is 27 months old.`), and a newer column with only some figures (an EPS alone) is named instead of read as current. FA's ratio tabs say it too, and it is a `# note:` in `--csv` and `notes` in `--json`.

**ASX listings whose statements lag.** Gloom Cloud fills the newer years from ASX's key statistics (revenue and net income, and the newest year's total assets and liabilities for a company reporting in AUD), never a year the statements already have. The next line names them (`From ASX key statistics (read 2026-10-22): 2026-06-30 revenue, net income; ...`), and each row carries `filledFrom` in `--json`.

### How current a report is

Every `gloom fn` text report ends with one line naming its source and saying how current its data is: when it is from, how far it is held back, and where its markets stand, such as `Source: Gloom Cloud · US trading day Fri 9 Oct 2026 close · 15 min delayed · markets closed until Mon`.

The plain commands that print market data end the same way: `quote`, `compare`, `ticker`, `history`, `financials`, `fundamentals`, `valuation`, `options`, `news`, `filings`, `holders`, `insider`, `13f`, `analyst`, `events`, `earnings`, `movers`, `indices`, `sectors`, `econ`, `fx`, `fred`, `yield-curve`, `correlation`, and `portfolio show` / `watchlist show`.

**In `--json`** the facts are `data.freshness` for `fn` and `metadata.freshness` for the plain commands: `source`, `asOf`, `status`, `delayMinutes`, `retrievedAt`, and `asOfClose`, `tradingDayMarket`, `market`, `minDelayMinutes`, `oldest`, `lagDays`, `observation`, `sources`, `oldestAgeMinutes`, `note` when they apply.

A top-level `source` object has `name`, `publisher`, `observationDate`, `publicationTime`, `retrievalTime`.

**In `--csv`,** the line ends the export as a `#` comment after the rows, followed by `# Publisher:`, `# Observation date:` (with `# Oldest observation:` for a portfolio whose rows are dated apart, see [What a portfolio is priced at](#what-a-portfolio-is-priced-at)), `# Publication time:` and `# Retrieval time:` (UTC).

`--ndjson` stays rows only, each ending with the [five fixed fields](#what-every-exported-row-says). A field the data does not state reads `not published` in CSV and `null` in JSON, never a guess.

The line has up to three parts after the source:

- **When.** The newest observation, in UTC with the zone named (`Sat 10 Oct 2026 00:15 UTC`), or a date for daily data (`Fri 9 Oct 2026`). With `config set timezone` the time is followed by yours.
  - Quotes whose markets have closed read as that session's close and say whose trading day it was (`US trading day Fri 9 Oct 2026 close`, `ASX trading day Fri 9 Oct 2026 close`). Currency pairs trade from Sunday 17:00 to Friday 17:00 New York time, so over a weekend they read as Friday's close (`FX trading day Fri 9 Oct 2026 close`).
  - A statistic dated by the period it covers names the period and, when the source says, the day it was released: `Sep 2026, released Tue 20 Oct` (`ECST`, `fred`, a chart of FRED series), or the time when the publisher states it (`CPI`: `Sep 2026, released Wed 14 Oct 12:30 UTC`; `DOE`: `Fri 16 Oct 2026, released Thu 22 Oct 14:30 UTC`). The report is as of that release; `--json` keeps the period as `referencePeriod` and the release as `asOf`, and an export's `as_of` column is that release. Without a release the period stands alone (`Sep 2026 (monthly)`), never its first day.
  - Daily bars (`CMP`, `G`, `HP`, `history`) are dated by the session's day once it has closed (`Fri 23 Oct 2026`), and by the latest quote while it trades (`Fri 23 Oct 2026 15:42 UTC`). A chart of prices beside a monthly series (`G DHI:price, FRED:PERMIT`) is dated the same way and names the series' newest period as the oldest: `Fri 23 Oct 2026 (oldest Sep 2026)`. The series' newest figure is drawn at its period like the others, not at the day it was released.
  - The oldest is named when it is more than a day older (`(oldest Thu 8 Oct 2026)`). When nothing in the data is dated the line says when it was retrieved (`events`, `earnings` and `EE` are dated that way).
  - `fundamentals` names the newest statement period (`not a live feed (reported through 2026-06-30)`), and `valuation` adds it after the quote's date (`... markets closed until 13:30 UTC · reported through 2026-06-30`).
- **How current.** One of the four states below, with a delay in minutes or hours. A delayed quote says how far its venue's feed runs behind (15 min, 20 min for ASX, KRX, KOSDAQ, TWSE, TPEX, SGX and NZX). News says its 12-hour hold-back after the newest story's time (`newest story Tue 29 Sep 2026 20:17 UTC · 12 h delayed`).
- **Markets.** For quotes, where their venues stand now, from the exchange calendars: `markets open`, `pre-market open · regular session opens 13:30 UTC`, `after hours`, `markets closed · regular session opens 13:30 UTC`, or `markets closed until Mon`. Futures venues (CME Group, ICE Futures U.S.) read closed from the Friday 16:00 Central close to the Sunday 17:00 Central open, whatever state a quote stamped earlier, and name the reopen as `markets closed · reopens 22:00 UTC` (`markets closed until Sun` on Saturday). Crypto never reads closed, and a board whose venues disagree, such as Tokyo open and New York closed, leaves this part out.

An index level is points, never dollars, in `quote`, `ticker` (header `Index points`), `fn QQ`, `history`, charts and every pane. In `quote` and `compare` an index row's Cur is blank and its `--csv` row reads `index points` (`pct` for a yield index such as ^TNX) in `currency_or_unit`, while `--json` keeps each quote as the source sent it.

The status is one of four:

| Status | Meaning |
|---|---|
| Live (`live`) | A real-time feed: a real-time quote or a streaming venue |
| Delayed (`delayed`) | A feed held back on purpose (with its length when the data states it) or a snapshot refreshed on a schedule |
| Stale (`stale`) | The newest observation is older than its kind allows: a quote from an earlier session, a daily series more than a session behind, a release that missed its schedule. The line says how old, or how many rows are stale when only some are |
| Not a live feed (`not-a-feed`) | Data that is not a feed: filings, fundamentals, calendars, published statistics, calculators, your own portfolio. Old data of this kind is not stale unless it missed a scheduled release |

A command that shows a copy saved earlier because it could not refresh says `couldn't refresh; saved copy from 21:49 UTC` in place of the status (`freshness.savedAt`). A request that reaches nothing, refused or with no answer within about 10 seconds (4 for a search), fails with `Gloom couldn't reach its data service` (`service_unreachable` in `--json`), and the command exits 1; a search says so rather than `No matches`. In the app, a pane whose quotes are such copies says `saved copy from 15:31` in its footer until a refresh answers.

**Venues polled apart.** A report over such venues dates each by its own newest observation and says how old its oldest price is: `fn PERP` ends `Sun 11 Oct 2026 · Binance 02:15 · Bybit 02:24 UTC · oldest 9 min · funding = current estimate, pays 08:00 UTC`.

The venues publish in real time and Gloom Cloud reads each about once a minute, so the line names no feed and its age says how far behind it is. The `PERP` footer reads the same over the rows on screen, with `live` after the age only while every one of them streams from its venue's socket. `stale` replaces it when a venue has stopped answering. `--json` carries each venue's time as `sources`, the age as `oldestAgeMinutes`, `status: "unreported"` (or `live`) and the funding part as `note`.

`fn CRYP` and the `CRYP` footer say when the newest price is from and how old the oldest is (`22:48 UTC · oldest 4 min`), with no feed status:

- A coin the live stream does not carry, and every coin without real-time access, is priced from the board Gloom Cloud renews every 15 seconds, which is neither real-time nor held back.
- `live` appears only when every price in the view is streamed, and `15 min delayed` only for a quote from a delayed feed.
- In `--json` its `status` reads `unreported`, with `oldestAgeMinutes`.

**Notes, errors and Pro lines.** The text report prints caveats under `Notes:`, one per line, and keeps `Errors:` for what failed, such as a source that did not answer.

- What Gloom Pro would unlock is not a failure: the report says it once, on one `Pro:` line ending with where to get it (`· gloom.sh/cloud`), and leaves out the tables the free view held back.
- `--json` carries `data.notes` and `data.errors` (the Pro lines among the errors), and a note never marks a report incomplete.

**In `shot` images.** `gloom shot` draws the same line in the pane footer. A pane whose report says what its data is ends as its `fn` report does, source first (`shot COT BTC` reads `Source: CFTC · Tue 6 Oct 2026 · not a live feed (weekly report)`).

A pane of quotes (`QQ`, a price chart, `HP`, `DES`) shows the market line without the source. In a narrow image the line keeps the date and the delay and shortens the rest first.

**Dataset panes.** A pane whose data is observed and published days later (`CHOKE`, `POWER`, `HIRE`, `APPS`, `GPU`) has no market part. Its line names the source, the newest observation's date and its age in days (`Source: IMF PortWatch · observed Sun 4 Oct · lag 6d` for `CHOKE`; `freshness.lagDays` in `--json`).

A monthly, quarterly or annual figure counts from the last day of its period (`observed Sep 2026 (monthly) · lag 10d` on 10 Oct). `CDS` is dated by its rows: `Source: DTCC · last trade 2026-10-09 · lag 2 days`.

**Verification output.** The shot's verification output prints the line as `Status line` (`render.statusLine` in `--json`, with the facts as `freshness`). Its `Status` is `complete` only when the pane's `fn` report is. A report that says `complete: false` makes the capture `partial`, with what it leaves out (`partial: 2 stale` for `CBR`, `partial: locked` for a Pro limit). `--no-status` leaves the line out.

## Plugins pane

Open it with `PL` in the command bar. It lists Gloom Cloud first, then plugins from Gloom's sponsors, what you have installed and what the registry offers, then the [built-in plugins](#built-in-plugins) that can be switched off. A row shows how many panes the plugin adds, three of its codes, and how many of its functions need Pro or give Free a preview. Enter opens the detail.

The status reads `on`, `off`, `core` for Ticker Research, `update` when the registry has something newer, `needs setup` when a required setting is missing, `errors (n)` after failures this session, or `failed` when it did not load.

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

**Starter packs** are built-in templates for the research and markets plugins: Everything, Equity research, Options desk, Macro & rates, Credit & bonds, and Alt data & quant.

- The Research and markets heading names the pack your plugins match (`Options desk pack`, or `Custom set` once you switch one by hand). Click it or press `a` to apply another.
- Each pack shows what it would switch from here (`8 off`, `1 on, 2 off`). A pack keeps Ticker Research on and never touches other plugins.
- Panes of plugins it turns off are hidden, not closed, and Undo on the toast brings them back.

A plugin installed or updated from the pane loads into the running session at once. If your app starts with a plugin that failed to load, a notification says so and opens this pane.

You do not need the pane to get an official plugin. Type its code, such as `TV`, `POLL`, `PM`, `HN` or `SUB`, and the command bar offers to install it after the same confirmation, then opens it with whatever you typed after the code.

**Updates.** Official plugins, the ones published under [github.com/gloom-sh](https://github.com/gloom-sh), update in the background once after Gloom itself updates, then at most once a day. A plugin you linked or edited locally is left alone. Third-party plugins update only when you press `g` or run `gloom update`. **Update official plugins automatically** in this pane's settings turns it off.

## What a portfolio is priced at

Value, P&L, weights and the total are priced at each holding's latest print, pre-market and after hours included, as brokers value a book. `portfolio show` says so under the title (`Priced at the latest print, extended hours included`), and its `As of (UTC)` column gives the time of the price each row uses (`Fri 9 Oct 23:59`).

### Pricing at the regular close

`gloom portfolio show <name> --close` prices the book at the regular close instead: Value is Last times the shares, and P&L, weights, trades and the total follow.

- `As of` is the venue's close (`Fri 9 Oct 20:00` for a US listing). `Day's move: +$1,165.49 (+0.51%)` under the table is the holdings' move from the close before.
- `fn PF <portfolio> --close` does the same, with the day's move above its table. Both end their source line with the basis (`priced at the regular close`).
- In the `PF` pane the header reads `Val 231.3k (latest print)` or `(regular close)`. **Value at Regular Close** in the pane's settings switches it, and `shot PF <portfolio> --close` captures it that way.

### Futures

A future has no regular close. At the close it is priced at its exchange settlement, the `Settle` `quote` shows, dated by its session (`Fri 16 Oct settle` in `As of`), never at the Globex print after it. A future with no confirmed settlement yet is not valued, and a line under the table says so.

### In exports

The `--json` and `--csv` rows of `portfolio show` and `fn PF` end with `valuationBasis` (`latest-print` or `regular-close`), `valuationPrice` (the price Value uses, in the quote's currency) and `valuationAsOf` (an ISO time in UTC, or a date for a close whose hour the venue's calendar does not give), followed in `--csv` by the [five fixed columns](#what-every-exported-row-says). `quoteAsOf` keeps the quote's own time.

- `portfolio show --json` adds `metadata.valuationBasis`, and with `--close` `dayChange` and `dayChangePercent` (in `metadata.totals` for `fn PF`). A future valued at its settlement adds `valuationPriceKind: "settle"`.
- `# Observation date:` is the newest of those prices and `# Oldest observation:` the oldest when the rows differ (`source.oldestObservationDate` in JSON).

## Shorts and futures

### Shorts

A position's size is signed: a negative size is a short. `gloom portfolio position set Hedge GC=F -10 4216.30` holds ten gold contracts short (`position set` with `0` is refused, `portfolio remove` drops a holding). A short's value, cost and P&L are negative wherever they show.

### Futures held in contracts

A future is held in contracts. Its value is the contracts times the contract size times the price, the size read from the contract terms `quote` shows (`Size 100 troy oz`, `Point Value $100`): 1,000 GC contracts at $4,198 are worth $419.8 million.

- Qty reads `1,000 × 100 oz` in `portfolio show`, `fn PF` and the pane, and their `--json` and `--csv` rows add `contractMultiplier` and `contractSize`.
- A future whose contract size cannot be read is never valued at one unit a contract: its value, cost and P&L are left out, and a line under the table (a notice in the pane) names it. Portfolio Analytics leaves it out too.
- A future quoted in US cents (corn, `US cents / bushel`) takes its cost as quoted: `position set Grains ZC=F 2 430` is two corn contracts bought at 430 cents, held in `USX`.

### Exposure

Under the table `portfolio show` prints the book's exposure, the priced holdings without the cash: `Exposure: long $456,756, short -$420,300,000, net -$419,843,244, gross $420,756,756`.

- `--json` carries it as `metadata.exposure` (`long`, `short`, `net`, `gross`), and `fn PF` as a notice and as `longMarketValue`, `shortMarketValue` and `grossMarketValue` in `metadata.totals`.
- The `PF` header of a book with shorts reads `Gross`, `Net`, `Long` and `Short`.

### Weights on a book with a short

A book that holds a short is weighed against its gross exposure, not its total: each weight is the position's signed value over the longs plus the shorts at their absolute value. A short's weight is negative, and the absolute values add up to 100%.

- Cash has no weight there, and the TOTAL row shows none. `portfolio show` says so under the table (`Weights are shares of gross exposure ($6,950,000), longs plus shorts at their absolute value, as the book holds a short; cash has no weight.`), and the `PF` pane heads the column `GROSS WT`. `--json` adds `metadata.weightBasis: "gross"` and `metadata.weightBase`.
- Targets on such a book are shares of the same gross exposure, so a short's share takes no target. A book without a short keeps its weights of the total, cash included.

## Portfolio currency

A portfolio's header totals and its COST, MKT VAL, DAY, P&L and MCAP columns are in the portfolio's currency, as are `PORT` and `portfolio show`. LAST, AVG COST and TARGET stay in the listing's currency, and a row priced in another currency than the totals gets a CCY column after LAST.

- A broker portfolio uses its account currency.
- A manual portfolio uses your base currency (`config set baseCurrency CAD`, an ISO 4217 code in any case). With the default USD base it takes the currency of its first position instead: a portfolio of ASX shares bought in AUD totals in AUD, and later holdings in other currencies convert into it.
- `portfolio create Baht --currency THB` makes a manual portfolio that totals in THB whatever the base currency, and its first position does not change that. An ISO code in capitals ending the name is read the same way: `portfolio create Baht THB` creates "Baht" in THB and says so. Quote the name as one argument (`portfolio create "Baht THB"`) to keep the code in it.
- Totals lead with the currency symbol (A$108.6k) unless both they and the base currency are USD.

### A holding in another currency

A holding in another currency than the portfolio's (a US stock in a TRY portfolio) can be entered at its cost in either currency.

- **In the portfolio's currency:** `portfolio position set Lira BRK-B 10 20310 TRY`. The value converts at today's rate, so P&L carries the currency's move.
- **In its own currency:** `portfolio position set Lira BRK-B 10 410 USD`. Without a purchase date or rate the cost converts at today's rate, leaving the lira's fall since purchase out of the P&L, and the command and `portfolio show` say so.

**Fixing the rate**

| Option | What it is |
|--------|------------|
| `--date 2024-03-01` | The purchase date, stored on the lot. Its daily USD/TRY close is used (the last one on or before it, at most a week back), from any pair `history` serves: the dollar pair either way round (USD/THB or THB/USD), and for two currencies neither of which is the dollar, crossed through it or their own pair |
| `--cost-fx 31.37` | The rate paid, in the portfolio's currency per unit of the holding's. With both options, `--cost-fx` is the rate |

- A typed rate is checked against today's. A rate that looks inverted (0.0319 when today's is 41.37 TRY per USD), a rate per pound for a holding in pence (`GBX`), or one more than 100 times off today's is refused, and the purchase date is the way around it. If the daily closes cannot be read (offline or signed out), the command suggests `--cost-fx`.
- The command prints `Cost FX  31.3694 TRY per USD (2024-03-01 close)`; cost, P&L and the COST column use that rate. Valued in another currency (`config set baseCurrency JPY`), a dated holding uses that date's close in it.
- The `--json` and `--csv` rows of `portfolio show` add `costFxRate` and `costFxCurrency` on a holding entered by hand in another currency (null at today's rate).
- A position set again in the same currency keeps its purchase date and rate unless new ones are given.

### In the forms

The AP and Set Portfolio Position forms take the same two: Purchase Date (`2024-03-01`, `1.3.2024` or `Mar 1 2024`) and Cost FX, the portfolio's currency per unit of the holding's. A new date on a holding in another currency reads that day's close unless Cost FX is filled in, and emptying a field clears it.

A cost in pence typed as `GBp` (or `GBX`) stays in pence: 1,000 VOD at `70 GBp` cost £700. `gbp` is pounds, and a blank currency on a London listing saves `GBP`.

### Several lots as one position

Several lots of a ticker set as one position (`position set`, the form, or a team portfolio's new count) keep a purchase date (the earliest of the lots', what the PF ACQ and HELD columns read) and a rate (the lots' rates weighted by their cost).

- Lots that cannot keep one rate honestly are refused: some at the rate they were bought at and some at today's, lots in different currencies, or rates into different currencies.
- Giving the position's own rate (`--cost-fx`, `--date`, or the form's Cost FX and Purchase Date) sets it.

### Team portfolios

A team portfolio shares each holding's purchase date and cost rate, with the holding's currency, alongside its quantity. Emptying Purchase Date or Cost FX in the form clears it for the team too, and a teammate changing the count keeps such lots as they are.

### Broker portfolios

A broker portfolio's header leads with `Net Liq` (the account's equity), then `Gross` (the market value of its positions) and `Cash` (negative while the account borrows on margin). `Lev` (gross over Net Liq) appears once the account is levered, and the day's percentage is a return on the equity.

The broker's last account snapshot is kept across restarts, and the footer gives its sync time and, when the last call failed, why. `PORT` shows the same figures and `KELLY` bets the same equity.

## Dividend income and DRIP

`gloom portfolio show <name>` adds Income and Yield for a portfolio of shares or funds. **Income** is a year of trailing dividends on the shares held, in the portfolio's currency, and **Yield** is that over the holding's value (on TOTAL, over the whole portfolio, cash included). A short owes the dividend, so its income is negative.

A holding whose income is unknown shows `—`, and so does the total, never $0. One line under the table names the cause (no dividend history, no exchange rate, or not read: signed out, offline or past the four-second deadline).

Income paid in another currency converts into the portfolio's at the latest rate, as its value does. A holding with no rate into it keeps the Income and Yield columns, with `—` and the note under the table.

```bash
gloom portfolio show Income                                  # Income and Yield columns
gloom portfolio show Income --drip --years 3 --withholding 20 # reinvested shares and income per year
gloom fn DVD KO PEP JNJ SBK.JO                              # rank payers by yield
gloom fundamentals MUB --tax-rate 40.8                      # a muni fund's tax-equivalent yield
```

`--drip` projects what reinvesting the dividends adds, year by year for `--years` (1 to 5, default 5), net of `--withholding` percent (default 0): each holding's shares after the last year and its net income each year. Today's dividends, prices and exchange rates are held flat and reinvested once a year.

`catalog drip`, `catalog reinvest` and `catalog dividend income` point here. How the figures are measured: [research data](research-data.md#portfolio-income-and-drip).

## Importing a manager's 13F as a portfolio

`gloom portfolio import --13f <CIK|fund name>` makes a manual portfolio from a manager's latest 13F, to follow it in `PF` and `PORT`:

```bash
gloom portfolio import --13f 0001067983 --top 10                 # "BERKSHIRE HATHAWAY INC 13F"
gloom portfolio import --13f 0001067983 --name "Buffett 25" --top 25 --notional 250000
gloom portfolio import --13f 0001067983 --top 10 --replace       # refill the portfolio of that name
```

- It takes the `--top` largest common-stock lines by reported value (10 by default, at most 100) whose ticker resolves to a listing. Options, principal amounts, preferred stock, warrants, rights, debt and CUSIPs without a ticker are skipped, each listed with the reason.
- Weights are each line's reported value over the imported lines' total. Shares are a notional, `--notional` dollars in total (100,000 by default), at the price the filing implies, which is each position's cost. They are the manager's weights, not your holdings, and the output, `portfolio show` and `fn PF` say so with the quarter and filing date.
- The portfolio is named after the manager unless `--name` says otherwise. An existing portfolio of that name is filled only when it holds nothing. One that holds tickers needs `--replace`, which removes them and their targets first. A broker portfolio is never imported into.
- The filing date and the 13F's weights are kept on the portfolio, so `fn PORT <id> --since filed` can measure a copier's basket from that day's close.

## Cash, target weights and rebalancing

A portfolio can hold cash beside its positions and a target weight for each holding. `PF` and `gloom portfolio show` then show how far each holding is from its target and the trade that would bring it back.

```bash
gloom portfolio cash set Retirement 500000 USD     # or: cash clear Retirement
gloom portfolio target set Retirement VTI 30%      # 30 and 30% are the same
gloom portfolio target set Retirement CASH 25
gloom portfolio target show Retirement             # or: target clear Retirement [VTI]
gloom portfolio show Retirement                    # --csv and --json keep raw numbers
```

**Amounts** (cash, `position set` shares and cost, `target set`, `--notional`) read with either decimal mark: `1.234,5`, `1234,5` and `1,234.5` are 1234.5, `18,50` is 18.5, and a space (in quotes) or `_` may group thousands. A comma or a dot before exactly three digits goes by what the number counts:

- **Cash and `--notional`** are amounts of a currency (cash in the portfolio's currency unless you name one, `--notional` in USD), so `500,000` and `1.234` are thousands. In a currency with three decimals (KWD, BHD, OMR, JOD, TND) both readings are amounts, so the command names them and stores nothing (`type 1234 or 1.2340`).
- **`position set` shares and contracts** ask which a dot or a comma before exactly three digits meant (`1.000`, `1.250`, `1,234`): thousands, as cash reads `1.000`, or a decimal. The command names both readings and stores nothing (`Shares 1.000 could be 1000 (thousands) or 1 (decimal point); type 1000 or 1`). A listing held in whole lots (shares outside the US such as `THYAO:BIST`, futures and option contracts) adds that it trades in whole units.
- **`position set` average cost** reads a lone dot as a decimal point (`123.456`) and refuses a lone comma before three digits (`1,234`), naming both readings.
- **A target weight** is never in the thousands, so `12,500` there is 12.5%.

The terms in the table:

- **Cash** is one amount in one currency, converted into the portfolio's currency. A broker portfolio whose account reports its cash shows that balance instead. Bare `CASH` names the cash line: `target set` takes it, while `portfolio add` and `position set` refuse it and point to `cash set` (the stock under that symbol is `CASH:NASDAQ`).
- **Weight** is a holding's net market value as a share of the total (every priced holding plus the cash). A holding without a price is left out of the total and the weights, shows `n/a`, and `portfolio show` says how many were left out.
- **Targets** are percents of the same total, kept per ticker symbol and synced between your devices when signed in. They need not add up to 100% (`portfolio show` notes the sum and what is unallocated), and a target can name a ticker the portfolio does not hold yet (a manual portfolio adds it at 0%).
- **Drift** is weight minus target in percentage points: `+2.3pp` is overweight.
- **Trade** is what reaches the target at the current price: the value, and the units at the position's own value per unit (contract multipliers and FX included). A holding kept in whole shares trades in whole shares. `--json`, `--csv` and a `shot`'s JSON keep the full-precision figure. Trades ignore fees, taxes and lot sizes.
- **Several lots** of one ticker (AAPL held as 10 @ 150 and 5 @ 170) each show their own weight, and the target, drift and trade belong to the whole position, on a line under the lots (`AAPL:NASDAQ (2 lots)`). `--json` and `--csv` keep one row per lot, with the position's weight, target, drift and trade on its first lot.

`portfolio show <name> --explain` follows the table with what each term means. [gloom.sh/docs/portfolio](https://gloom.sh/docs/portfolio) walks through a small rebalance.

In `PF`, a portfolio with targets shows `WEIGHT`, `TGT WT`, `DRIFT` and `TRADE` after `MKT VAL`, unless the pane's columns already include target columns (`TRADE VAL` is in the column settings; `TARGET` and `TARGET%` are the analysts' price target). With cash entered by hand the header shows `Total` and `Cash`, with the cash's weight and drift.

## Broker position sync

Press `a` in the **Brokers** pane (`BR`), or run **Add Broker Account**, to connect a broker (**New Portfolio** can start from one too). Gloom imports positions from Interactive Brokers, Public, Robinhood and SimpleFIN. Each broker is a plugin with its own repository, installed on first launch and updatable on its own, from the plugin directory or `gloom install gloom-sh/gloom-public` and friends.

- **Interactive Brokers** opens a browser sign-in page through Gloom and ends that sign-in seven days after you approve it, however often it syncs. A day before, the profile's status in `BR` shows when it ends. `c` signs in again and the seven days start over.
- **Robinhood** opens a browser sign-in page and uses only the read-only account and equity-position tools of the Robinhood Trading MCP server.
- **Public** needs an API secret from Public API settings, and only the account and portfolio endpoints are used.
- **SimpleFIN** needs a one-time setup token from SimpleFIN Bridge and imports only accounts that contain holdings.

The connection data is saved on the local device and is not included in Gloom Cloud synchronization. A later position sync updates the managed portfolios and removes positions the broker no longer reports.

Each profile's row in `BR` shows its `STATUS`: `Sign-in needed`, `Sync failed` or `Connect failed` when the last action did not work (`Enter` shows the reason in full), and what is running (`Syncing…`). A `Disabled` profile is never connected or synced: press `b` to enable it, which also syncs it.

**When a broker is offline.** While a broker is disconnected, failing, or missing its plugin, its portfolio in `PF` keeps the positions from its last sync, and the footer says when and why (`as of Oct 17 14:02  IBKR disconnected`).

- Press `b` there to reconnect (Interactive Brokers asks you to sign in again, as `c` does in `BR`).
- A disabled broker says so and `b` enables it, and a broker whose plugin is missing has no `b`: install the plugin first.

With Gloom Cloud on, a broker's portfolios, account values and positions sync like your other portfolios, so daily roundups, the weekly brief, position alerts, the mobile app and Ask Gloom include them. Hand-entered lots in a broker portfolio sync separately from imported positions, so a newer broker snapshot does not overwrite a local lot edit.

To keep one connection's account data on this device only, set **Account data** to **Keep on this device** when you connect it, or later with Edit in Brokers. Its profile, portfolios and positions then stay out of Cloud sync, and the Cloud features above go without that account.

### Imported bond price basis

A broker can declare bond cost and mark prices as `percent-of-par`: quantity is nominal face in the position currency, and cost and value are nominal × quoted price ÷ 100 (1,000 USD face at 87.742% par has a cost of 877.42 USD). Position cells use `face` and `% par`, and bond ETFs keep ordinary share prices.

- Source market value and unrealized P&L stay authoritative. No accrued interest, coupon, clean-to-dirty adjustment or yield is inferred.
- Older BOND holdings without a declared price basis keep their broker totals and P&L but show unavailable price-derived cost, value and percentage until a source resync provides the convention.
- An independent current bond quote must declare its own price basis, and a percent-of-par quote must match the holding's nominal currency.

## Gloom Cloud sign-in

Sign in with email and password, or pick `Log In with QR Code` from the command bar and scan the code with the Gloom mobile companion app (the onboarding wizard recommends it).

Signed in, your layouts, settings, portfolios and watchlists sync between your devices. What each pane is showing (cursor, open detail, scroll position) and which floating pane is on top stay on each device. If two devices change the layouts before either has synced, the later change wins.

Signing out pauses sync and keeps unsynced edits for your next sign-in to the same account, including after restarting the app. Signing into a different account starts by merging its cloud workspace. If a sign-in is interrupted, sync stays paused while the app automatically retries session validation; uploads resume only after the account is confirmed.

## Connect an AI assistant (MCP)

`MCP` opens a short setup for the [Gloom MCP server](https://gloom.sh/docs/mcp) (typing mcp, claude, codex or cursor in the command bar, or `ACM` > Advanced > Assistants (MCP), finds it too). Pick the client and copy its one command or config with `c` or Copy.

Claude Code, Cursor and most recent clients sign in through your browser on first use, so they need no key. Codex, and clients without a browser, use a key: `k` creates one through your Gloom Cloud account (Pro) and fills it into every snippet.

The key is shown once and saved nowhere, so copy it before you close the dialog. Keys made here get Read access (to choose another level or revoke a key, use Cloud settings, Agents on gloom.sh).

## Remote control from an assistant

An assistant connected to the Gloom Cloud MCP with Terminal control (Cloud settings, Agents) can drive this app while it is open and signed in: read what is on screen, open and arrange panes, navigate tickers and switch layouts. It needs no setup in the app. The first time an assistant asks, a prompt names it: `s` allows it for this session, `a` always, `n` or Esc denies.

- Plugin actions, button presses, commands and anything that reaches an outside service (an order, a transfer, a message) ask on every call, with what the call will do: `y` allows that one call, and one left unanswered for 60 seconds is denied. Deleting a layout and adding or removing a watchlist ticker (naming the list, ticker and exchange) ask too.
- While an assistant works, its name shows in the status bar. A click opens Account Management on the Agents tab, where `r` revokes it so its next call asks again. The `MCP` dialog says how many assistants are allowed, and `m` opens the same tab.
- Credentials in the configuration never leave the app.

`gloom remote` drives the open app the same way from this machine. A watchlist change through it, such as `gloom remote call watchlist.add '{"symbol":"MSFT","watchlist":"Tech"}'`, opens a confirmation in the app. Enter or `y` makes the change, `n` or Esc leaves the list alone, and the call answers with what happened.

## Chat

### Mentions

Type `@` in a channel's composer to suggest up to five people (usernames or words in display names, recent activity first). Team and group channels offer their members, public channels known authors and your DM contacts. Direct-message composers have no mention menu.

### Channels and people

`CHAT [channel]` opens a channel. In a narrow pane the channel list and the open channel take turns: Back, Esc, Backspace, Left or the mouse back button return to the list, and Enter, Right or a click opens a channel. The DMs section puts the newest conversation first.

**Profile cards.** Pointing at a name or an @mention shows that person's card: their public profile if they made it public, otherwise their name and @username. A click keeps it open, and `p` shows the card of the selected message's author. Someone else's card has Message (Open DM when you already share one), or says why not.

### Your handle

An account made on gloom.sh, or with Google or GitHub, starts with a handle such as `gloom_3fa91c0d5e7b2a48`. Until you pick your own, chat shows **Choose a handle** above the message field: type one and press Enter or **Save**, or press `@` to reach the field. A handle that is taken or not allowed says why. **Not now** stops asking on this device, and you can change your handle any time in ACM, on the Profile tab.

### Names, icons and profile details

- **Bots** Gloom runs (Gloombot, Gloom Wire, the AI desk personas) have their name in their own colour and a robot's face beside it (`⍠` in the terminal).
- **Staff and Pro.** Gloom staff carry the Gloom mark (`◉`) and an account with Pro a gem (`◊`), shown after the time on the message you point at or select. In the terminal the person's card says what the icons are (`Bot run by Gloom`, `Gloom team`, `Pro`).

The card also shows the person's local time and what they trade, when they chose to show it. Set both in ACM, on the Profile tab: **Local Time** is on unless you turn it off, and **What I Trade** is off until you turn it on.

### Announcements

An announcement from the Gloom team stands apart: a faint band in your theme's accent with an **Announcement** mark after the name. It notifies only someone it @mentions, and is copied to the #announcements channel of the Gloom Discord.

### Chat in the command bar

Type part of a channel's name (`gen` for #general) or of a person's username or name in the command bar to find the conversation. Channels are tagged `CHAT`, team channels `TEAM`, DMs `DM` and group chats `GROUP`, and unread ones show a count. The empty command bar lists a few conversations, unread first. `chat` or `messages` alone lists them all, and `DM` lists your DMs and group chats, each ending with New DM.

### Writing messages

Messages read basic markdown, the same in the terminal, the desktop and the web:

| You type | You get |
|----------|---------|
| `**bold**` | bold |
| `*italic*` or `_italic_` | italic |
| `~~strike~~` | strikethrough |
| `` `code` `` and fenced code blocks | code |
| `[label](https://...)` and bare addresses | links |
| `- ` and `1. ` | lists |
| `> ` | quotes |
| `#` heading | a bold line |

A link opens only http or https. A marker that is never closed, such as a lone `*`, shows as typed, and `snake_case` is not italic. Copy Message Text in the pane menu copies the selected message as written.

### Functions in messages

On the desktop and the web, a function written in backticks, such as `` `NI CRYPTO` ``, `` `DES AAPL` `` or `` `CRYP` ``, is a chip in its line. A click on it, or `o` on the selected message, runs it in the command bar, so it opens as typing it there would. The code counts written in capitals, and a one-letter code only with its argument (`T AAPL`). What follows the code counts only as a ticker or tickers in capitals, a function's code after `HELP`, or one of the values the function lists (the topics of `NI`): free text such as a question after `ASKG` stays code, so a click never asks or starts anything for you. A command that changes your settings or lists, such as `AW` or `TH`, stays code, as do a switched-off plugin's functions, other code and code blocks. The terminal shows them all as code.

After a backtick, the message field suggests functions by code or name, as `@` suggests people. Enter or Tab writes the one chosen with its closing backtick, leaving the cursor inside for a function that takes a ticker or a topic.

### Discord

Public channels are mirrored to the Gloom Discord, and messages written there carry a dim `Discord` tag. Someone on Discord who has not linked a Gloom account has no card and cannot be messaged, and a message written on Discord can only be edited there.

| Type in the message field | What it does |
|---------------------------|--------------|
| `/discord` | Connects your Discord account (it opens gloom.sh in your browser, which signs you in and then asks Discord to approve) |
| `/discord mirror off` | Stops your own messages going to Discord |
| `/discord mirror on` | Turns it back on |
| `/discord unlink` | Disconnects the account |

### Reactions

React beside Reply on the message the pointer is on (in the terminal, the selected message, or `+`). It offers 👍 🔥 😂 👀 ❤️ 🚀 and any other emoji already on the message. A click adds or takes back yours, and pointing at one names who reacted. Reactions notify no one, and in public channels they also show on the Discord copy.

### Scrolling and message buttons

At the bottom, the message list follows each new message. Scroll back and it stays, with a `N new messages` button that scrolls to the newest. The Reply, React and Edit buttons show only on the message the pointer is on (in the terminal, the selected one).

### Images

A message can carry up to four images (PNG, JPEG, WebP or GIF, up to 5 MB each). Enter sends once every image is up, with or without text.

- **Desktop and web:** paste an image, drop files on the chat, or use the image button (also `Attach Image…` in the pane menu). The x removes one, and a failed upload offers Retry.
- **Terminal:** paste or drop the path of an image file into the message field. Backspace in an empty field removes the last one.
- Images in public channels are checked before anyone else sees them. Your own message says `Checking image...` meanwhile, and `Could not be checked, only visible to you` if the check could not run.
- The desktop and web open images full size on a click (Left and Right step through, Esc closes). The terminal lists each as a row such as `[image 1280x720 179 KB]` that opens in the browser on a click, or with `o` on the selected message.
- A message that failed to send has Retry, or Enter while it is selected.

### Share

**Share** is the one action for the focused pane, in its menu (`.`, the `...` button, or a right-click on the header on the desktop), in the command bar (`share pane`, `share link`, `copy link`), and on `Cmd/Ctrl+Shift+S`. Copy Screenshot (`Cmd/Ctrl+Shift+C`) and Export CSV are separate actions.

### What a share link holds

Share copies a public Gloom link to the pane at once and says `Link copied`. The link opens the same view in the recipient's terminal or on the web. It carries the pane's function and settings, without the fields the pane keeps private, and no picture. A portfolio pane opens on the recipient's own portfolios.

- Sharing needs a signed-in account with a verified email. Signed out, Share says so with Sign in and copies the link once you are in.
- A pane with no public view, or a link the service could not make, says so in the toast and copies nothing.

### Panes that show your own data

A pane that shows your own data asks once before Share makes its link, `Copy a public link?`. Enter and Esc cancel, `y` or Copy link copies it.

| The pane says | Panes |
|---------------|-------|
| `This shows your holdings.` | Your portfolios (not watchlists), Portfolio Analytics, the position sizer, Earnings Ripple on your holdings, a heat map of a portfolio, Relative Rotation and `VCA` linked to a portfolio, Ticker Research and `OMON` on a ticker you hold |
| `This shows your account details.` | Brokers, ACM and Team |
| `This shows private messages.` | A DM, group or team chat, Unread Chat, Quick Notes, Ticker Research on its Notes tab and Ask Gloom |

To show a picture of a pane in chat, copy it with Copy Screenshot and paste it into the message field on the desktop or the web.

### Share links in chat

In chat, a Gloom share link is a chip instead of an address: the share's title and the pane it holds, with the picture it was posted with as a preview on the desktop and the web.

- A share link pasted on its own at the end of the message field, or into an empty one, becomes a chip above the field (a link pasted inside your text stays text). The chip's x, or Backspace in an empty field, takes one back out.
- A click on the chip, or `o` on its message, opens that pane in your own terminal. A share that cannot be reached from the app, or that holds a snapshot, opens its web page instead, and an expired one says so.
- The Gloom Wire's news and calendar posts in the topic channels end in a chip too: a headline opens its story in the reader, and a calendar post opens ECO, EVTS, IPO or DOE.

### Report a Bug

**Report a Bug** in a pane's menu posts that pane's picture to the public #bugs channel as your own message. With Gloom Cloud turned off there is no chat to post to, and the menu has no Report a Bug.

- The form shows the picture, the pane and the app version, and asks for one line on what went wrong (up to 300 characters). The message carries the line, the pane by its function and what it shows, the app version and which app it came from: `Pane: GP AAPL · v0.17.3 · desktop`.
- Everyone in #bugs sees it, so a pane that shows your own data asks first, with the same lines Share asks with and `Post it?`. Enter in the line does not send it: press Send.
- Signed out, it asks you to sign in and opens the form once you have. Posting needs a verified email, as Share does. A send that fails keeps the form and your line.

### Chat notifications

A reply, a mention, a direct or group message, or a message in a channel whose notifications you turned on shows a toast while the app is in front, and a desktop notification when it is not. A message you have already read, on this device or another, never notifies again, on your phone or by email either.

- **Phone:** a push about 15 seconds after the message unless you read it in that time.
- **Email:** with chat emails on, the email for a message nothing else reached goes about two minutes after it, only when you have not read it.
- Reading a channel on one device clears its unread count and the Dock badge on the others.

### Unread

The unread count in the status bar opens Unread (also in the command bar): one row per channel with unread messages, the count of a channel that mentions you in green. Counts are your account's, the same on every device. Opening a row shows that channel in your chat pane, and `m` marks everything read.

Unread also keeps the price alerts, catalyst alerts, economic release prints and team notices whose toast you may have missed, newest first, the last 300. Opening one selects the price rule in ALRT, opens the catalyst or ECO, or goes where the team card's toast goes. This list is kept on this device only.

**The Dock badge.** In the macOS desktop app the Dock icon counts people, not messages: each person who sent you an unread DM or group message, each person with an unread channel message that mentions you (`@username`), plus every missed notice not yet read. It reads `99+` above 99 and shows nothing at zero, signed out or with Gloom Cloud off.

## Ask Gloom

`ASKG` opens Ask Gloom, and `ASKG <question>` asks straight away. The question field has the keyboard as soon as the pane opens: Enter asks, Shift+Enter starts a new line. An empty pane offers three questions written for what your profile holds (a click, or Up then Enter, asks one).

Under each question, every source Gloom used is one line: what it read, for which portfolio or symbol, how many rows came back and how long it took. A result with gaps says the main one below (`3 of 94 positions had no price`). A click or `x` opens a row with everything it reported, and `o` opens the pane it came from.

**Watchlist changes.** Ask Gloom can add a ticker to one of your own watchlists (the one you name, else your first) or take one off. Team watchlists and portfolios it leaves alone. It asks first, naming the list, the ticker and its exchange: `y` or Approve makes the change, `n` or Decline leaves it. Unanswered for about a minute, it closes and nothing changes.

**Keys.** Esc leaves the question field for the answer, Enter goes back to the field.

| Key | Action |
|-----|--------|
| `j` / `k` | Walk the sources |
| `t` | List the tickers in the answer |
| `c` | Stop an answer that is still coming |
| `r` | Ask a failed or stopped question again |
| `n` | Start a new conversation |
| Left (or Left in an empty field) | List earlier conversations |

Closing the pane keeps the conversation (opening it with a question starts a new one). The remaining daily questions show in the footer once 20 or fewer are left.

### Asking about a pane

Every pane can be asked about: the spark beside the `?` in its header on the desktop and the web, **Ask Gloom** in its pane menu, or `Alt+A` (`Cmd+Shift+A` or `Ctrl+Shift+A` on the desktop). Where a browser keeps `Ctrl+Shift+A` for itself (Chrome's tab search), use `Alt+A`.

Ask Gloom opens with a new conversation, the pane attached above the question field (the x takes it off), and the field holds `What does this pane show?` to edit or send. Nothing is asked until you press Enter. What goes with the pane is its function and how it is set (`DES AAPL` on its Financials tab, a chart's range) and a short summary of the text it shows.

A pane that shows your own data asks first, the same panes that ask before Share (see Share): `y` or Attach sends what it shows, `n` or Leave out sends only which function it is.

Rate an answer with the thumbs under it (`+1` and `-1` in the terminal), or `g` and `b` once Esc has left the question field. A thumbs down offers why (`1` wrong, `2` too slow, `3` missing data, `4` other) and `Send this answer to Gloom` (`s`), which sends your question, the answer as written (it can mention your holdings) and which tools ran. Without it only the thumb and the reason are kept.

## Debt maturities

`DDIS MSFT` opens the issuer's latest coherent principal maturity schedule, in three tabs.

- **Maturities** shows six relative fiscal buckets, including an open-ended Thereafter bucket, with the total and the shares due in the next twelve months and three years. Select a bucket for its exact amount and SEC fact. A **Latest 10-Q** row adds its current and non-current debt when a 10-Q is newer than the annual schedule.
- **History** shows the last ten years of annual filing cohorts. Select an observation to inspect its filing.
- **Filing** shows currency, source concepts, interest expense, the borrowing-cost proxy when supported, and percentile coverage. `o` opens the selected filing.

`gloom fn DDIS MSFT --json` gives the source amounts, complete filing history, ranks and provenance. `gloom shot DDIS MSFT --tab history` (or `--tab filing`) captures a tab. Missing facts stay unavailable, and unsupported issuers do not appear to have zero debt.

## Statement filings and bank figures

`ticker` names the filing behind each latest period: `Latest Quarter (2026-06-30, 10-Q filed 2026-08-06)` and `Latest Annual (2025-12-31, 10-K filed 2026-02-13)`. `fundamentals` says the same under its figures. Both commands' `--json` carry `statementFilings` with `latestQuarter`, `latestAnnual` (`date`, `form`, `filed`, `accessionNumber`), `resultsRelease` and `annualReportForm` (the newest 10-K, 20-F or 40-F).

### Results released before the statements

A company releases a quarter's results in an 8-K (Item 2.02) weeks before the 10-Q or 10-K with its statements. When such an 8-K was filed after the next quarter ended, both commands add one line: `Q3 (Sep 2026) results released 2026-10-13 (8-K); statements arrive with the 10-Q.`

- The quarter is counted on the company's own fiscal year, so a September quarter is Apple's Q4 and arrives with the 10-K.
- When the 10-Q or 10-K was filed after the release but the statements do not have it yet, the line says when it was filed instead.
- An amended 8-K, an 8-K without Item 2.02, and a release of the latest period's own results add nothing.

### Bank figures

For a US bank holding company, `fundamentals` adds a Bank section:

- **Lead Bank**: the largest insured bank the company holds, by total assets, with its FDIC certificate number. For a foreign group that files a 20-F or 40-F (Royal Bank of Canada, TD, HSBC, UBS), it is the group's US bank subsidiary only, and a note says its figures are not the group's.
- **Deposits**: total deposits from the company's own 10-Q or 10-K, with the balance-sheet date, form and filed date, and the change from the quarter before. A company that tags only interest-bearing and noninterest-bearing deposits shows their sum and says so.
- **Uninsured Deposits**: the lead bank's estimated uninsured deposits over its estimated insured plus uninsured deposits, from its latest FDIC call report, as a share of domestic deposits with both amounts. Banks under $1 billion in assets do not report the estimate.
  - A bank with deposits in foreign offices, which FDIC insurance does not cover, gets a note with their amount (JPMorgan Chase Bank: 60.9%, 1.39T of 2.29T USD in domestic offices; total deposits are 2.82T USD).
- **CRE / Capital**: the lead bank's commercial real estate loans (construction and land development, multifamily, nonfarm nonresidential not occupied by the owner) over its total risk-based capital, from the same call report.

Each line names its quarter and the date its filing was filed or the FDIC data was built. The FDIC figures are the lead bank's, not the holding company's consolidated ones. A part that cannot be read becomes one line saying so, never an error. A company outside banking has no Bank section.

- Net interest margin is a Pro figure in EQS: the section's last line gives the `gloom fn EQS --metric kpiNimPercent` command for the ticker.
- `--json` carries the figures as `bank`, with each one's SEC filing or FDIC source URL, retrieval time and hash. `--csv` adds a `Bank` table.
- `catalog NIM`, `catalog deposits`, `catalog CRE` and `catalog bank`, and `fn NIM <ticker>`, point here.

## Theses

A thesis is why you hold something, written so it can be checked: the instruments it holds, the pillars that must stay true, the kill conditions that would make you sell, and dated catalysts.

- Every ticker has a Thesis tab next to Notes, and a portfolio or watchlist row's context menu has a Thesis entry.
- `THESIS` opens the board, sorted by what needs a ruling, with the share of the book sitting on weakening or broken theses and the positions with no thesis yet. `THESIS NVDA AMD` starts one on a basket or a pair. On the board, `/` searches by ticker or company, `p` cycles the portfolio in view, and `w` compares conviction with weight.
- Theses are stored in Gloom Cloud for any signed-in account, personal or shared with a team (teammates can challenge a pillar). Signals only ever wait for your ruling: accept, dismiss with a reason, or snooze. Resetting a kill condition that fired requires a note on the revision.
- Drafting a thesis from a sentence, and reviewing it against fundamentals and news (`v`), need Pro.

## Localized interface

Gloom includes English, Spanish, Simplified Chinese, Traditional Chinese, Japanese and Korean, with English as the fallback.

- Supported `LANG` / `LC_ALL` and desktop system locales select the matching interface automatically.
- `LANG` in the command bar (Ctrl+P) cycles languages, or use `LANG auto`, `LANG en`, `LANG es`, `LANG zh-CN`, `LANG zh-TW`, `LANG ja`, `LANG ko`. The choice is saved in `config.json`.
- `GLOOMBERB_LANG=ja gloomberb` overrides it for one run.

## Built-in plugins

Each built-in plugin can be switched on or off in `PL`. The Commodities & Energy workspace groups related market and energy views into tabs, and the typed commodities shortcuts open their tabs.

| Plugin | Functions |
|--------|-----------|
| Ticker Research | The research pane, DES, FA, QQ, HP, RETURN, the G charts, CAT, ANR, DIAG, EVT, RV, EE, EM, GUID, KPIS, GUIDE, SEG, DVD, RDCF, PEB, EXEC, TAS |
| Options & Volatility | OMON, OPX, GEX, OVME, OSA, CSP, OVDV, HVG, HVT, HIVG, VCA |
| Ownership & Insiders | HDS, 13F, INS, SI, SIW, SIV, the Congress tab |
| Filings & Events | SEC, ETF, RISK, EK, CATL, LITI, MA, DIST |
| Credit & Bonds | CDS, CDX, SOVR, CRD, AUCT, YAS, CRDOC, COVN, DDIS |
| Earnings | ERN, EVTS, CALLS, RIPL |
| Supply Chain & Alt Data | SPLC, EXPO, AWARDS, HIRE, APPS, JOBS, BUZZ, ATTN, the Gloom Trending pane, GPU, POWER, EPWR |
| Quant | CORR, GR, BT, SEAS, MDAY |
| Rates & Macro | ECO, ECST, CPI, GC, WIRP, BTMM, CBR, VIX, VOLS, VAL |
| Global Markets | WEI, MAP, CHOKE, BI, THEM, FXC, RRG |
| Screeners & Movers | EQS, MOST, HILO, SCAN, FLOW |
| Commodities & Energy | FUT, CTM, COT, DOE, NGS, PSD, JODI |
| Crypto & Perps | CRYP, ETFF, PERP |

A research tab belongs to the plugin of its function: switching off Ownership & Insiders removes the Holders, 13F, Insider, Short Interest and Congress tabs. Switching a plugin off hides its panes without closing them, and they come back with their state when it is switched on. Typing one of its codes in the command bar offers **Turn on**.

The old ids `ticker-research`, `macro` and `market-overview` still switch a whole group (`gloom plugin disable macro` turns off every successor). Credit & Bonds and Earnings belong to both Ticker Research and Macro, and Supply Chain & Alt Data and Quant to both Ticker Research and Market Overview.

Polls lives in its own repository, so it can ship a fix the day the third-party site it reads changes. Existing installations restore it once after upgrading with their saved panes, and a deliberate removal is respected. To install it by hand: `gloom install gloom-sh/gloom-polls`.

Fear & Greed, Market Heatmap, Market Halts and the IPO Calendar are built in, with the same panes, shortcuts and settings. A copy installed earlier as a plugin is no longer loaded: `gloom plugins` lists it, and `gloom remove gloom-fear-greed` (or `gloom-market-heatmap`, `gloom-market-halts`, `gloom-ipo-calendar`) deletes it.

## Live TV

Install [TV](https://github.com/gloom-sh/gloom-tv) with `gloom install gloom-sh/gloom-tv`. Live TV in the terminal also requires `mpv` with Kitty video output. Gloom resolves the stream in JavaScript and runs `mpv` with its `yt-dlp` integration disabled, so `yt-dlp` is not required.

## Options scenarios

### Adding legs

Open `OSA AAPL`, choose **Add leg** to enter a call or put, or **Chain** to select a quoted contract. From OMON, select the call or put cell and use **Add to OSA** (`a`); `x` switches the cursor row between its call and put and `[` / `]` step the expiry. The leg editor opens in the ticker's existing OSA pane, and saving appends the leg to its position.

In the editor, set buy/sell, contracts, entry premium per unit, annualized IV and units per contract (default multiplier 100, changeable for a known deliverable). With a broker profile that trades options, **Trade** (`t`) sends the position to the broker as one order: see [Spreads](trading.md#spreads).

### Scenario controls

The Payoff and P&L grid tabs share the scenario-date (`d`) and parallel vol-shift controls.

| Control | What it does |
|---------|--------------|
| **Inputs** (`i`) | Edits spot, rate, dividend yield, currency, valuation timestamp and spot range |
| **Save** (`s`) | Stores a named snapshot, which keeps its original valuation timestamp |
| **Browse saved** (`b`) | Restores one for the same ticker and listing |
| **Edit** (`e`) in Legs | Edits the selection (Enter does too) |
| **Remove** (`x`) in Legs | Asks before removing it |

The current draft, selected date, vol shift and selected leg resume with the layout.

Both `fn` and `shot` accept explicit inputs for reproducible analysis:

```sh
gloom fn OSA AAPL --legs 'call,100,2026-12-18,1,5,25;call,110,2026-12-18,-1,2,25' --spot 100 --rate 4 --dividend-yield 1 --currency USD --as-of 2026-09-22 --date 2026-10-22 --vol-shift 3 --json
gloom shot OSA AAPL --legs 'call,100,2026-12-18,1,5,25;call,110,2026-12-18,-1,2,25' --spot 100 --rate 4 --dividend-yield 1 --currency USD --as-of 2026-09-22 --date 2026-10-22 --vol-shift 3 --tab payoff --output osa-payoff.png
```

The leg format is `call|put,strike,YYYY-MM-DD,signed contracts,entry price,IV percent[,multiplier]`, separated by semicolons. `--tab` accepts `payoff`, `grid` and `legs`, and `--spot-range` is the percentage range either side of spot.

Omit market overrides to use current sources. Without `--currency` the position is in the underlying's currency. Entry prices and spot are per share, and value, P&L and the grid are for the whole position. No position is invented when no legs or strategy are supplied.

**Strategies.** `--strategy` builds an explicit example from complete two-sided quotes, at `--strike` or the strike nearest the money: `vertical`, `straddle`, `put` (one long put), `csp` (one short put, a cash-secured put) and `collar` (a long put and a short call with the shares they cover, at `--put-strike` and `--call-strike`). `--expiration` selects the chain's expiry as a date (`2027-01-15`) or Unix seconds.

`--shares` adds shares of the underlying to any position (negative for short), so a typed put and the stock it protects value together. A dividend yield the underlying's sources do not know asks for `--dividend-yield`, and a fund whose distribution history shows none paid, such as GLD, is valued at 0% and the report says so.

To size a protective put against a budget, add `--nav` and `--budget-bps`, and `--sleeve` for coverage:

```sh
gloom fn OSA SPY --strategy put --strike 700 --expiration 2027-01-15 --nav 100m --budget-bps 50 --sleeve 100m
```

The **Hedge budget** block gives how many contracts the budget buys (whole contracts, rounded down), the price it sized at, the premium spent and its bps of NAV, the notional protected and its share of NAV, and the coverage of the sleeve. A seeded put is bought at the ask, a typed leg at its entry price. The sizing is defined under [Options scenario analysis](research-data.md#hedge-budget).

To sell a cash-secured put, `--strategy csp` seeds one short put at its quote midpoint, at `--strike` or, with `--delta 0.30`, the put whose delta is nearest -0.30:

```sh
gloom fn OSA KO --strategy csp --strike 85 --expiration 2026-11-20
```

The **Cash-secured put** block gives the cash secured, the premium received, yield on cash and annualised, the put's bid, ask and spread with the premium and annualised yield at the bid (what a sell order fills at), how far the strike is below spot, the break-even, days to expiry, and whether the next earnings report falls before expiry.

GS's November 820 put at 5.40/6.75 yields 9.01% a year at the 6.075 mid and 8.01% at the bid. Each figure is defined under [Cash-secured put](research-data.md#cash-secured-put).

To rank puts across several names, `CSP` sells the same put on each: the one nearest `--delta` (0.30) on the listed expiry nearest `--days` out (30) or `--expiration`, highest annualised yield at the bid first:

```sh
gloom fn CSP JPM GS KO AAPL XOM
gloom fn CSP JPM GS KO --delta 0.20 --days 45 --max-spread 15
```

Each row has the expiry, days to it, strike, bid, ask, spread as a percent of the mid, delta, how far out of the money, annualised yield at the mid and at the bid, the 30-day IV rank and the earnings flag. A spread over `--max-spread` (10% of the mid by default) is marked `wide` and still ranked, and a name with no chain is listed last with why. A name with no IV rank is listed under the table with the reason when there is one, or as `No IV rank for DAL yet.` when none of its IV history is being collected. `--days` takes whole days: `--days 30,5` is told `30 or 31`.

- In the pane, type the names in Symbols and pick the delta and the expiry from the bar. Enter opens the selected name's put in OSA.
- The pane ranks the first 20 names typed, and `fn CSP` refuses more than 20.
- Each figure is defined under [Cash-secured put screen](research-data.md#cash-secured-put-screen).

To collar shares, `--strategy collar` buys the put at `--put-strike` and sells the call at `--call-strike` on the `--expiration` chain, each at its quote midpoint (the strikes nearest 10% below and above spot when omitted), and holds the 100 shares per contract they cover:

```sh
gloom fn OSA GLD --strategy collar --put-strike 345 --call-strike 420 --expiration 2027-09-30
```

The **Collar** block gives the put bought, the call sold, the net premium (a credit or a debit), and the floor and the cap per share and how far each is from spot, and expiry risk gives the hedged position's breakevens, maximum profit and maximum loss. `--shares 0` values the options alone. Each figure is defined under [Collar](research-data.md#collar).

**Exports.** `--csv` writes every figure as a number with its unit (`USD`, `USD per share`, `%`, `days`) in the label and in `currency_or_unit`. `--json` carries the same figures, where a percent is a percent (`4.1` for a 4.1% rate), while `metadata.csp`, `metadata.hedge` and `metadata.collar` keep the model's own figures, in which rates, yields, spreads and coverage are fractions (`0.041`).

## Option valuation models

`OVME` starts with the European Black-Scholes model.

- **American model:** choose **American CRR** or press `m` to value early exercise. Set the tree step count and enter cash dividends as `days:amount`, separated by semicolons (`30:0.25;90:0.25`), days being calendar days from valuation and cash per underlying unit. `d` focuses the dividend schedule and `u` edits the underlying ticker.
- **Surface IV:** choose **Surface IV** or press `v` to source the strike/tenor volatility from OVDV, fitted on the current observed underlying quote (changing the calculator's spot changes the scenario price, not the source surface). Quote dates and fit methods appear in the footer, and source failures in warnings. Editing the IV field returns to entered volatility, `r` refreshes the source.
- Switching back to European BS deactivates the American cash schedule but keeps it for later. The model, tree settings and schedule resume with the pane.

```sh
gloom fn OVME --model american --side put --spot 100 --strike 100 --days 365 --volatility 20 --rate 5 --dividend-yield 0 --dividends '30:1;120:1' --steps 800 --json
gloom fn OVME --model american --symbol AAPL --spot 340 --strike 340 --days 90 --rate 4 --dividend-yield 0 --vol-source surface --json
gloom shot OVME --model american --side put --spot 100 --strike 100 --days 30 --volatility 25 --rate 4 --dividends '10:1;20:1' --width 1080 --height 360 --output ovme-american.png
```

- CLI rates and IV are percentages. `--market-price` is a per-unit premium and uses the selected model's IV solver. Explicit input-volatility calculations run without market access.
- The European closed form rejects an explicit cash schedule in `fn`, while the pane and `shot` keep it with an ignored-schedule notice. Cash dividends are always entered by you: the surface supplies volatility only.

`shot OVME` accepts the same flags and returns the captured inputs, price, Greeks, IV result and source metadata as numerical evidence. Missing surface data, invalid values or a pane too short to show the metrics give no usable evidence. `shot HVG AAPL` and `shot HVT AAPL` also verify their plotted observations (`--show-iv false` when only realized volatility is wanted).

## Relative rotation

`RRG` or `GRR` opens US sector ETFs versus SPY. `RRG AAPL:NASDAQ,MSFT:NASDAQ` uses an explicit universe. Pane settings choose the benchmark, a linked watchlist or portfolio, custom symbols and a 2-12-week trail (six by default). The maximum is 24 instruments.

Select a coloured table row to locate its trail, and open it for dated strength and momentum history. Click column headers to sort. CSV export is in the pane menu. `gloom fn RRG --benchmark SPY:NYSEARCA --trail 6 --json` returns metrics, dated trails, rank sample counts and data limitations.

## Position sizing: KELLY

`KELLY <ticker>` sizes a position with the Kelly criterion:

- **Binary, Scenario, Risk, Market and Asym** take your own probabilities and payoffs.
- **History** reads them off the ticker's own daily closes: the share of up months, the mean gain of the up months and the mean loss of the down months, over non-overlapping 21-session returns for the last five years (`Years` sets one to five). It is sized as a binary bet, so full Kelly maximizes expected log growth. Past months are not a forecast, and fewer than six of them give no inputs.

`gloom fn KELLY LIT` prints History's inputs (window, win rate, average gain and loss, payoff ratio, edge a month) and full, half and quarter Kelly as a share of bankroll. `--bankroll 250000` (or `250k`, `1.5m`) sizes each in your base currency, and `--years 1` shortens the window. `gloom shot KELLY LIT --bankroll 250000` opens the pane on History with that bankroll.

## Portfolio risk depth: PORT and MARS

`PORT` opens portfolio market risk. `MARS` is its alias. Add a local portfolio's ID or name, in any case, to select it (`PORT main`, `PORT Family`). Every command and function that takes a portfolio or watchlist reads it that way, and in the command bar a name no portfolio has (`PORT Nope`, `PF Nope`, `EXPO PORT:Nope`) shows a row listing the ones there are instead of opening the first.

- Views: Risk, Factors, Holdings, Correlation, Stress, Performance, Attribution and Greeks. Enter opens a metric's evidence and history, Escape returns.
- Click portfolio tabs or press `p` to switch portfolios. `i` imports local account evidence from the clipboard and `r` refreshes Cloud observations. Tables support sorting and CSV export.

### Benchmark and stress

The return rows and tracking error are measured against SPY (`60D benchmark return (SPY)`) over the trailing 60 sessions.

- For a portfolio made with `portfolio import --13f`, the pane's **Risk window** setting or `--since filed` measures them from the 13F's filing date instead (a portfolio without one keeps the trailing 60 and says so). The basket is then the 13F's own weights bought at the filing-date close and held, and the report's first line says so.
- `--weights current` (the pane's **Since-filing weights** setting) holds today's weights fixed over the same sessions instead.
- Pane settings give independent index-percent, 10Y-basis-point and VIX-point stress shifts, each a share of the basket.
- `--fx-shift TRY -20` (the lira 20% weaker against USD) and `--asset-shift BTC-USD -30` reprice every holding and the cash at once, through each line's currency and price; the Stress view lists each line they move and the book total, cash included. Several go in one flag, separated by commas (`--fx-shift TRY -20, EUR 5`). The pane's FX shift and Asset shift settings take the same text.

### Performance and attribution evidence

Performance, Brinson attribution and imported option Greeks use the versioned local JSON schema in [research data](research-data.md#local-account-evidence). The pane does not derive account cashflows from current holdings. Evidence stays private and must match the portfolio ID and currency.

```sh
gloom fn PORT main --json
gloom fn MARS main --view factors --json
gloom fn PORT main --view stress --equity-shift -15 --rate-shift 100 --vol-shift 10
gloom fn MARS main --view stress --fx-shift TRY -20 --asset-shift BTC-USD -30
gloom fn PORT berkshire-hathaway-inc-13f --view risk --since filed
gloom shot PORT main --width 1100 --height 620 --output portfolio-risk.png
```

Risk, Factors, Correlation and Stress model the equity holdings with daily history, up to the 150 largest by value. A listing quoted in another currency is converted to USD at daily FX closes. In a portfolio whose currency is not USD, money returns, values and tail losses are in that currency (`Returns in TRY at daily USD/TRY closes.`).

Holdings left out (foreign listings without daily FX closes, shorts, options, crypto, holdings without a quote or history) and the cash, one row per currency, are listed under `!` with the reason (`fn PORT` prints the same under Notes), and the footer says what the basket is worth and how much of the book it covers, cash included (`basket 48,286 USD = 72% of book; left out: TRY cash 18%, BTC-USD 10%`). VaR and expected shortfall name their method in their evidence and the Risk view's footer (`historical, 1-day, 95%, 60 daily returns`).

Below half of the holdings' value, cash aside, the views say so instead of estimating. See [research data](research-data.md#portfolio-risk-depth-port-mars) for the method.

`fn PORT` prints every view, or the one `--view` names. A stress shift given with another view, or `--since` with a view other than risk, is named as not applying. `--evidence` accepts the same JSON text as the clipboard import. A report includes raw values, source dates, percentile coverage, holdings, factor regressions and warnings.

## Equity criteria screener

`EQS` screens the stored Cloud equity universe, starting with USD companies above $10 billion in market capitalization. **Criteria** edits typed numeric ranges, category lists and available/unavailable data conditions, all ANDed. Thresholds accept `k`, `M`, `B` and `T` (`10B` is ten billion). The currency selector is required for price and market-cap comparisons.

Besides valuation, growth, margins, short interest, insider and 13F activity and social attention, fields cover:

- **Returns** 1W, 1M, 3M, YTD and 1Y: price change, without dividends, from the last close on or before the window start (YTD in 2026 runs from the 31 Dec 2025 close, `YTD% vs 31 Dec`). For 1M and longer, the last weekly close up to a week early can stand in, marked `partial`. 1W needs daily closes.
- **VS 52W HI%**: price against the highest high of the last 52 weeks, 0 at a new high.
- **Beta**: raw beta of two years of weekly returns against SPY, US listings.
- **ATR%**: the 14-session average true range (Wilder's, as in the chart's ATR study) as a percent of the last close, US listings. A gap counts. Unavailable with fewer than 15 completed sessions. Pair it with Beta and IV RANK to screen volatility.
- **P/B**, **EV/EBITDA** and **FY ROE%**: market cap over latest balance-sheet equity; the enterprise value the valuation view shows over the last four quarters' EBITDA, unavailable where that EV is withdrawn (under 0.7x or over 1.5x market cap plus debt minus cash); annual net income over average equity. Statements in another currency than the market cap (most ADRs) leave them unavailable.
- **EPS REV 30D%**: change in the current fiscal year's consensus EPS over 30 days, unavailable when the fiscal year rolled in between.
- **UPSIDE%**: mean analyst price target over the price.
- **IV RANK** and **IV/HV**, for optionable US names: 30-day implied volatility between its 52-week low (0) and high (100), and over the realized volatility of the last 21 daily closes. IV rank is a rank, not an IV percentile.
- **FY PAYOUT%** (`payoutRatioPercent`): common dividends paid in the latest fiscal year over net income attributable to the parent, from SEC filings, so US filers only; unavailable when the income is zero or negative.
- **DIV GR 1Y%** and **DIV CAGR 3Y%** (`dividendGrowth1YPercent`, `dividendGrowth3YPercent`): trailing twelve-month cash per share against one and three years before, the growth `DVD` shows, compounded yearly for 3Y. A payer that stopped reads -100%; a company with too short a history or none paid in the base year has none. Distribution history is stored for most large USD payers and fewer elsewhere.

Returns, EPS revisions, upside and dividend growth take the sign colour.

### Results

Results lead with the chosen metric and its covered-universe percentile, then one column per numeric criterion and context columns (market cap, price, change, P/E, revenue growth, operating margin, dividend yield) as width allows. Stale values are amber, and an AS OF column dates the chosen metric where it is stale.

- Price, change and market cap follow the live quote while the regular session trades. Otherwise they are the last regular close and its move, as `quote` shows them, and a PRE-MKT, AFTER-HRS or OVERNIGHT column beside CHG% carries the extended print's move while a row has one. The screen filters, sorts and ranks by the close.
- Click a metric header to sort by it and make it the focus, again to reverse. The footer shows matches, covered listings, currency and the snapshot time.
- Enter opens a company's dated observations, `o` opens it in Ticker Research.

`s` saves a named screen to your Cloud account, **Saved** restores one, and **Save copy** creates another (saving an existing screen updates its revision). Conflicting edits from another device are reported. `x` exports all matches from the displayed snapshot, up to 5,000 rows, and the pane CSV menu exports the loaded rows. Expired snapshots ask for a refresh first.

### Why a ticker is missing

Choose **Check ticker** (`t`) in Results or Criteria, enter a ticker such as `NVDA`, then press Enter or click **Check**. The check lists every criterion with its stored value, Pass or Fail, and the observation's date and state. The currency restriction is a criterion too: it filters listings by quote currency and does not convert values. Open a saved screen first to check against it.

- Plain tickers prefer listings in the screen's currency, then the primary or home listing. When the remaining listings belong to different companies, the check asks for an exchange: enter a qualified ticker such as `2454:JPX`. An explicit exchange is always respected, even when its currency fails the currency criterion.
- The decision uses the stored screening values, even when Results shows a more recent quote. Missing values are not zero: ordinary comparisons fail on them, while an explicit `missing` condition passes.
- A ticker outside the covered universe reads **Not covered**, with its criteria **Not evaluated**. Stale and partial values keep their state beside the decision.
- Passing every criterion means the ticker qualifies, though sort order and pagination can still put it beyond the rows loaded.

The same check runs without a pane:

```sh
gloom fn EQS --check NVDA
gloom fn EQS --check NVDA --saved "Growth" --json
gloom fn EQS --check NVDA --definition '{"version":1,"currency":"USD","criteria":[{"field":"trailingPE","op":"lte","value":25}],"sort":{"field":"marketCap","direction":"desc"}}'
```

`--saved` takes a saved screen's ID or exact name and cannot be combined with `--definition`. With neither, the check uses the default screen. JSON includes the raw criterion values and verdicts, overall match status, definition and snapshot. Saving and opening screens need an account, and checking Pro criteria needs Gloom Pro.

### Screening from the command line

`gloom fn EQS --metric trailingPE --json` returns the first 100 matches with the snapshot, match and coverage counts, and the chosen metric's date and state per row. A notice says when more rows match (narrow the criteria to reach them). An extended-hours print has its own column (`extendedPrice`, `extendedChangePercent` in JSON). `--definition` accepts versioned JSON with `criteria`, `currency` and `sort`:

```sh
gloom fn EQS --definition '{"version":1,"currency":"USD","criteria":[{"field":"trailingPE","op":"between","value":[0,25]},{"field":"revenueGrowthPercent","op":"gte","value":10}],"sort":{"field":"marketCap","direction":"desc"}}' --json
```

Company KPIs and guidance (`kpiBacklog`, `kpiNimPercent`, ...) and hiring and app attention are Pro. On Free their rows read `locked` and the report says so once (`The free screener shows no KPI values; Gloom Pro shows each company's Backlog`). With Pro, a KPI column with gaps says how many rows have none, and missing data is not zero.

## Backtest

`BT AAPL` (or `BTST AAPL`) tests a long-only rule on the ticker's daily history against buy-and-hold. **Strategy** (`s`) picks a preset: golden cross (50/200), above the 200-day average, RSI 30/50 reversion, MACD signal cross, Bollinger reversion, or a 55/20-day breakout. `e` opens the rules, where **Custom rules** takes an entry and an exit written as `<operand> <comparison> <operand>`, joined with `and`:

```
close > sma(200)
sma(50) crosses above sma(200) and rsi(14) < 70
close > highest(55)
```

- **Operands:** `close`, `open`, `high`, `low`, a number, `weekday` (1 Monday to 7 Sunday), `day_of_month` (1 to 31), `sma(n)`, `ema(n)`, `rsi(n)`, `macd(fast,slow,signal)`, `macd_signal(fast,slow,signal)`, `bb_upper(n,k)`, `bb_lower(n,k)`, `highest(n)` and `lowest(n)`.
- **Comparisons:** `>`, `<`, `>=`, `<=`, `==`, `!=`, `crosses above` and `crosses below`.
- `weekday` and `day_of_month` are the session's UTC calendar date. Like any rule, it fills at the next session's open, so `--entry 'weekday == 3' --exit 'weekday == 4'` holds from Thursday's open to Friday's.
- A rule that cannot be read lists every operand and comparison, and `gloom fn BT --help` does too.

Settings also choose the lookback (5 years, 10 years or all history) and the cost per side in basis points.

### Reading the result

**Summary** plots the strategy and buy-and-hold as growth multiples on a log scale with the strategy's drawdown below, beside the price return, CAGR, volatility, Sharpe, drawdown, time in market, the share of rolling one-year windows in which the rule beat buy-and-hold, and trade statistics. **Trades** lists each trade. `v` switches views and `r` refreshes history.

- Closes are not adjusted for dividends or fund payouts, so an income fund returns more in total than BT shows. The footer says `price return: distributions not included`, and `fn BT` labels the row `Price return (distributions not included)`.
- A session still forming, and any session without a positive close (CL=F on 2020-04-20), is left out and named under the pane's data warnings (`!`), which also say when the ticker is a rolled futures continuation such as `CL=F`.
- **Export CSV** writes the daily curve, as `--csv --equity` prints it, and says where the file went.

### From the command line

- `--end YYYY-MM-DD` stops the run at that session, so the same command gives the same curve, trades and statistics later. An end after the newest complete session is warned: the run ends at that session and changes until the end date has passed.
- `--include-partial` keeps a session still forming, whose close moves until the day ends.
- `--equity` reports the daily curve instead of the summary: each session's close in the listing's currency, the position (1 long, 0 flat), the strategy's and buy-and-hold's growth of 1 on the price alone (the CSV headers say `price return, distributions not included`) and the drawdown in percent, every digit in `--csv` and `--json`.
- In `--csv` each summary row names its own unit (`%`, `ratio`, `trades`, `sessions`), trade prices are in the listing's currency, and the file closes with the run's warnings and notes.
- `--entry` and `--exit` without `--preset` test the typed rules (the same as `--preset custom`). Beside another preset they are refused, since the preset tests its own.
- `gloom fn BT --help` lists every option.

```sh
gloom fn BT AAPL --json
gloom fn BT SPY --entry 'close > sma(200)' --exit 'close < sma(200)' --lookback max --cost 2
gloom fn BT BTC-USD --preset trend-200 --end 2026-10-16 --csv --equity > btc-trend.csv
gloom shot BT NVDA --preset breakout-55-20 --output nvda-breakout.png
```

### Credit documents (CRDOC / COVN)

`CRDOC FICO` opens capital structure, covenant headroom, instrument maturity walls and a global risk screen. Select an instrument for its exact terms, filing evidence and amendment history. `COVN` opens the Covenants tab. This Pro dataset includes a free preview. See [credit documents](credit-documents.md) for coverage, calculation limits and CLI options.
