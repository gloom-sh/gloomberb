<div align="center">

<img src="https://gloom.sh/gloomberb-logo-grayscale.svg" alt="Gloomberb logo" width="76" />

# Gloomberb

**Open-source finance terminal. Fast, keyboard-driven, and extensible.**

Desktop app for macOS and Windows. Terminal UI for macOS, Linux, and Windows.

<a href="https://gloom.sh/download/desktop"><strong>Download desktop</strong></a>
&nbsp;&middot;&nbsp;
<a href="#install"><strong>Install the TUI</strong></a>
&nbsp;&middot;&nbsp;
<a href="README.zh-CN.md">简体中文</a>

<br />
<br />

<img src="https://gloom.sh/landing-terminal.png" alt="Gloomberb terminal showing portfolio, watchlists, market data, and chart panels." width="720" />

</div>

## Desktop App or TUI?

Gloomberb has two ways in:

| Surface | Best for | How it runs |
|---------|----------|-------------|
| Desktop app | A polished app window, pop-out panes, OS shortcuts, and built-in updates | Published for macOS and Windows. It also installs a `gloomberb` terminal command for the TUI. |
| Terminal UI | Fast keyboard workflows inside your terminal, SSH/dev boxes, Linux machines, and script-friendly setups | Runs with `gloomberb` on macOS, Linux, and Windows. |
| Browser app | The shared DOM interface without an install | Open [term.gloom.sh](https://term.gloom.sh). |

The desktop app and TUI share the full command language and plugin system. The browser app uses the same official DOM renderer and layout with a reviewed browser plugin catalog.

## Browser App

[term.gloom.sh](https://term.gloom.sh) works anonymously with configuration, tickers, layouts, session state, and plugin state stored in the browser. Anonymous sessions receive rate-limited, 15-minute-delayed Gloom Cloud market data and read-only chat. Login remains optional and enables sync and chat posting; Pro accounts receive realtime market data. Cloud REST and WebSocket traffic uses the same-origin `/api` path, which the Worker forwards only to `https://api.gloom.sh`; it is not an arbitrary network proxy.

The browser build intentionally omits brokers and native integrations, filesystem notes, local AI, external plugins, updater/debug tools, application menus, native window controls, pop-out native windows, and native context menus. Modules that still depend on desktop-only or CORS-blocked feeds are also absent for now: RSS/Substack, prediction markets and polls, market halts/heatmap/movers, dividend/ownership/SEC panes, earnings/IPO, and TV. Public shares open under `/s/:id` in a separate slim bundle. Share creation and owner deletion use the signed-in Gloom Cloud session through the same fixed API path; public reads require no account.

Local browser development:

```bash
bun run web:build
bunx wrangler dev
```

Validate the public artifacts with `bun run web:audit` and `bun run cloudflare:dry-run`. `wrangler.jsonc` is intentionally generic and contains no account, route, domain, namespace, or secret. Production routing and the private Gloom Cloud API deployment are configured separately.

## Install

### macOS

Install the desktop app and the `gloomberb` terminal command:

```bash
brew install --cask vincelwt/tap/gloomberb
# or
curl -fsSL gloom.sh/install | bash
```

Both install `Gloomberb.app` and a `gloomberb` command that runs the TUI through the app bundle, so the bundled runtime is stored once.

Prefer a direct download?

- [Download Gloomberb for Mac](https://gloom.sh/download/desktop)

### Linux

Install the standalone TUI binary:

```bash
curl -fsSL gloom.sh/install | bash
```

This installs `gloomberb` to `~/.local/bin` by default. A Linux desktop package is not published yet.

### Windows

Install the desktop app:

- [Download GloomberbSetup.exe for Windows](https://github.com/gloom-sh/gloomberb/releases/latest/download/stable-win-x64-GloomberbSetup.exe)

The installer supports Windows 11 on x64 and ARM64. On ARM64, the desktop app and its bundled `gloomberb` terminal command use Windows' built-in x64 emulation.

For a terminal-only setup on x64, install Bun and use the package:

```powershell
bun install -g gloomberb
```

### Terminal Package

Already have Bun installed on any supported OS?

```bash
bun install -g gloomberb
```

Then run:

```bash
gloomberb
```

On macOS and Windows, desktop updates replace the installed app in place and keep the terminal command pointing at the updated runtime. Homebrew users can also update through `brew upgrade --cask gloomberb`.

For the best terminal experience, use a [Kitty](https://sw.kovidgoyal.net/kitty/)-compatible terminal such as Ghostty, Kitty, or WezTerm.

Live TV in the terminal also requires `mpv` with Kitty video output. Gloomberb resolves the stream in JavaScript and runs `mpv` with its `yt-dlp` integration disabled, so `yt-dlp` is not required.

## Start

Open command mode with `Ctrl+P`, then type a command. Press `` ` `` to open ticker search directly.

| Try | Opens |
|-----|-------|
| `DES AAPL` | Security details |
| `GP NVDA` | Price chart |
| `G AAPL:price, MSFT:revenue` | Mixed-series chart |
| `TOP` | Ranked market stories |
| `HM` | Market heatmap |
| `MOST` | Market movers |
| `HILO` | New highs and new lows |
| `PF` | Portfolios and watchlists |
| `KELLY AAPL` | Position sizing |
| `HELP` | Full in-app shortcut list |

## What It Does

- Research companies with quotes, charts, financials, filings, holders, insiders, options, analyst ratings, events, and relative valuation.
- Follow markets with top stories, breaking news, sector feeds, Substack subscriptions, global indices, futures, FX, macro events, yield curves, Treasury auctions, market movers, new-high/new-low and options-flow scanners, and fear/greed.
- Track portfolios and watchlists, connect brokers, set alerts, keep notes, run AI screens, browse prediction markets, and use Gloom Cloud chat.

### Broker position sync

Use **New Portfolio** or **Add Broker Account** to connect a broker. Gloomberb can import positions from Interactive Brokers, Public, Robinhood, and SimpleFIN.

- Robinhood opens a browser sign-in page. Gloomberb uses only the read-only account and equity-position tools from the Robinhood Trading MCP server.
- Public needs an API secret from Public API settings. Gloomberb creates a short-lived access token and uses only the account and portfolio endpoints.
- SimpleFIN needs a one-time setup token from SimpleFIN Bridge. Gloomberb exchanges the token and imports only accounts that contain holdings.

Gloomberb saves the connection data on the local device. It does not include this data in Gloom Cloud synchronization. A later position sync updates the managed portfolios and removes positions that the broker no longer reports.

## CLI

Running `gloomberb` with no arguments launches the terminal UI. Normal commands run through a headless CLI path; use `gloomberb launch-ui` when a script should explicitly open the UI.

Human-readable output is the default. Automation can opt into structured output with `--json`, `--csv`, or `--ndjson`. JSON output favors the richest fetched model available and includes display-column metadata when a command has table columns; CSV and NDJSON use the command's tabular row view. Common global flags include `--limit`, `--refresh`, `--quiet`, `--no-color`, `--dry-run`, and `--yes`.

| Command | Use |
|---------|-----|
| `gloomberb` | Launch the terminal UI |
| `gloomberb launch-ui` | Explicitly launch the terminal UI |
| `gloomberb help` | Show all CLI commands |
| `gloomberb api list|get|invoke|subscribe` | Inspect and call plugin capabilities directly |
| `gloomberb quote <symbols>` | Fetch current quotes |
| `gloomberb search <query>` / `provider-search <query>` | Search tickers and provider symbols |
| `gloomberb ticker <symbol>` | Show quote, ownership, and financials |
| `gloomberb history|financials|fundamentals|options <symbol>` | Fetch research data |
| `gloomberb news|filings|holders|insider|13f|analyst|events|valuation <symbol>` | Fetch company research feeds |
| `gloomberb movers|indices|sectors|fx|fear-greed|earnings` | Fetch market overview data |
| `gloomberb econ|fred|yield-curve` | Fetch macro data |
| `gloomberb compare|correlation|relationship <symbols>` | Compare securities |
| `gloomberb portfolio [action]` | Manage manual portfolios |
| `gloomberb watchlist [action]` | Manage watchlists |
| `gloomberb notes|alerts [action]` | Manage local notes and alerts |
| `gloomberb broker|ibkr [action]` | Inspect broker integrations; trading actions require explicit account/profile and `--yes` |
| `gloomberb ai providers|ask|screen` | Use configured AI providers and screeners |
| `gloomberb rss fetch <url>` | Fetch an RSS feed |
| `gloomberb buildout|congress|substack|x-feed|tweets` | Access cloud and social data sources when an existing session is available |
| `gloomberb provider status` | Inspect enabled data providers |
| `gloomberb config|cache|plugin|layout|pane|debug|doctor|version|changelog` | Inspect and manage local app state |
| `gloomberb fn [...]` | Run a pane-backed report command |
| `gloomberb shot [...]` | Capture a pane-backed screenshot |
| `gloomberb predictions [...]` | Launch Prediction Markets |
| `gloomberb plugins` | List installed plugins |
| `gloomberb install <user/repo>` | Install a plugin from GitHub |
| `gloomberb remove <name>` | Remove an installed plugin |
| `gloomberb update [name]` | Update plugins |

Commands that need a signed-in cloud session may return `auth_required`; sign-in, account management, and chat workflows are still handled in the app UI for now.

## Plugins

Everything from the portfolio list to broker integrations is a plugin. Plugins can add panes, tabs, columns, command bar commands, CLI commands, status bar widgets, and data providers.

Core plugin areas include:

- Portfolios, watchlists, manual entry, and broker connections
- Ticker details, quotes, charts, options, filings, holders, insiders, and research
- News, Substack reader feeds, market movers, global indices, sectors, FX, earnings, macro data, and yield curves
- Prediction markets, alerts, notes, chat, AI screeners, and external plugins

See [PLUGINS.md](PLUGINS.md) for the plugin API and the shared UI surface available through `gloomberb/components`.

## Keyboard

| Key | Action |
|-----|--------|
| `Ctrl+P` | Open command mode |
| `` ` `` | Open ticker search |
| `Ctrl+,` | Open focused pane settings |
| `Ctrl+W` | Close focused pane |
| `Ctrl+Shift+M` | Move focused window (`WIN resize` starts resize mode) |
| `Ctrl+Shift+D` | Dock or float focused pane |
| `Ctrl+Shift+L` | Layout actions |
| `Ctrl+Shift+G` | Tidy windows |
| `Tab` | Switch panes |
| `j` / `k` | Navigate lists |
| `h` / `l` | Switch tabs |
| `m` | Cycle chart mode |
| `q` | Quit |

Desktop builds also accept `Cmd/Ctrl+K` for the command bar, the matching `Cmd` shortcuts on macOS, `Cmd/Ctrl+Shift+O` to pop out a pane, and `Cmd/Ctrl+Shift+C` to copy a focused pane screenshot.

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
| `EM [tickers]` | Earnings monitor |
| `SRCH <query>` | Provider symbol search |
| `QQ <tickers>` | Ticker quote monitor |
| `CMP <tickers>` | Normalized price comparison |
| `CORR <tickers>` | Ticker return correlations |
| `ANR <ticker>` | Analyst targets and ratings |
| `DIAG <ticker>` | Equity Diagnostic with cited flags and anomalies |
| `SEC <ticker>` | SEC filings and company disclosures |
| `OMON <ticker>` | Options monitor |
| `OVME` | Black-Scholes option calculator with Greeks and implied volatility |
| `HDS <ticker>` | Institutional holders |
| `DVD <ticker>` | Dividend yield and history |
| `SI <ticker>` | Short interest |
| `13F [fund/ticker/CIK]` | 13F fund filings and holdings |
| `INS <ticker>` | Insider activity |
| `EVT <ticker>` | Corporate actions, earnings, and estimates |
| `RV <tickers>` | Relative valuation |

### Chart Composer

`G`, `GP`, `GIP`, `CMP`, `GF`, and `GE` all open the same chart composer with different starting presets. `CAT` opens a searchable catalog of those chartable series so you can graph one without typing the expression. A custom expression can mix unrelated data sources on one synchronized timeline:

```text
G AAPL:price, MSFT:revenue, FRED:CPIAUCSL
```

Open **Series** to add, remove, reorder, or hide series and choose each series' field, chart style, transform, axis, panel, period, and panel scale. Price data supports candles, OHLC, HLC, line, and area; scalar data supports its compatible line, area, step, column, and point modes. Panels can use independent left/right axes and linear or logarithmic scales.

The toolbar controls preset or exact date ranges, intervals from one minute through monthly, the primary chart mode, technical indicators, and pair formulas. Indicators include volume, SMA, EMA, Bollinger Bands, RSI, and MACD; formulas include ratio, spread, and rolling correlation. Mixed-frequency values use as-of alignment: fundamentals use filing dates when available, sparse series carry forward only after becoming available, and missing publication dates are called out in the chart status.

### Markets, News, and Macro

| Shortcut | Function |
|----------|----------|
| `TOP` | Ranked market stories |
| `HM` | Market heatmap for large US stocks and ETFs |
| `MOST` | Top gainers, losers, most active, and trending tickers |
| `HILO` | Session new highs and new lows with 30s/1m/5m momentum |
| `FLOW` | Unusual options activity: sweeps, blocks, and large premium |
| `PM <query>` | Polymarket and Kalshi prediction data |
| `N` | News feed |
| `CN <ticker>` | Ticker news |
| `NI` | Sector news |
| `SUB` | Authenticated Substack reader feed |
| `FIRST` | Breaking news |
| `TWIT <query>` | Ticker-related market posts |
| `TBO` | TheBuildout infrastructure intelligence |
| `CG` | Congress trading disclosures |
| `WEI` | Global equity indices |
| `FUT` | Front-month futures across index, rates, energy, metals, grains, and FX |
| `ECON` | Economic events and releases |
| `GC` | Yield curve |
| `AUCT` | Treasury auction results: high rate, bid-to-cover, indirect share, and size |
| `VIX` | VIX 30-day/3-month implied-volatility curve |
| `CRD` | Credit spreads |
| `CDS [ticker]` | Single-name corporate CDS activity: most-active issuers, or one issuer's trades |
| `ERN` | Earnings calendar |
| `IPO` | Upcoming and recent IPOs |
| `HALT` | US trading halts with reason and resumption times |
| `TV` | Live Bloomberg, CNBC, and Yahoo Finance television |
| `BI` / `SP` | S&P 500 sector performance |
| `FXC` | Major FX cross rates |
| `FNG` | Fear and greed market gauge |

### Workspace and App Controls

| Shortcut | Function |
|----------|----------|
| `PF` | Portfolio and watchlist workspace |
| `PORT` | Portfolio risk and sector exposure |
| `ALRT` | Price alerts |
| `SA <symbol condition price>` | Create a price alert |
| `AI <prompt>` | AI screener |
| `AGENT` | Local AI research workspace |
| `CHAT [channel]` | Gloom Cloud chat |
| `DM @user [@user...]` | Open or start a direct or group chat |
| `ACM` | Gloom Cloud account settings |
| `NOTE` | Notes |
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
| `POLL` | Prediction-market polls |
| `ART` | Loaded article lookup |
| `UPGRADE` | Account upgrade |
| `CR` | Cycle chart renderer |
| `LANG <locale>` | Change interface language (`auto`, `en`, `es`, `zh-CN`, `zh-TW`, `ja`, or `ko`) |
| `PL <plugin>` | Manage plugins |

Published layouts preserve portable pane setup and state, including searches, chart viewport, and drawings. Credentials, accounts, portfolios, and pane fields marked private stay local. Publishing copies a durable `term.gloom.sh/l/...` link for social sharing.

## Gloom Cloud sign-in

Sign in with email and password, or pick `Log In with QR Code` from the command bar and scan the code with the Gloomberb mobile companion app to sign the terminal in without typing. The onboarding wizard offers the same QR option as the recommended path, with email and password as the alternative.

## Localized interface

Gloomberb includes English, Spanish, Simplified Chinese, Traditional Chinese, Japanese, and Korean UI support. English remains the default fallback language.

- **Automatic detection:** supported `LANG` / `LC_ALL` and desktop system locales select the matching interface automatically.
- **Command switching:** enter `LANG` in the command bar (Ctrl+P) to cycle languages, or use `LANG auto`, `LANG en`, `LANG es`, `LANG zh-CN`, `LANG zh-TW`, `LANG ja`, or `LANG ko`. The choice is persisted in `config.json`.
- **One-run override:** `GLOOMBERB_LANG=ja gloomberb` (or another supported locale) takes highest priority in environments that expose process locale variables.

Implementation notes:

- Locale dictionaries live in [src/i18n](src/i18n), keyed by the original English UI text. Missing entries safely fall back to English.
- Shared render sinks call `t()` / `tf()` / `tc()` for pane titles, the command bar, menus, settings, tabs, help, and onboarding.
- Finance abbreviations such as BID, ASK, and CHG% intentionally remain in English for terminal conventions and fixed-width alignment.
- CJK wide characters and grapheme clusters are measured by [src/utils/format.ts](src/utils/format.ts) using terminal display-cell widths.

## License

MIT

## Credits

- [OpenTUI](https://opentui.com/) for the layout engine
