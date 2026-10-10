<div align="center">

<img src="src/assets/gloomberb-logo.svg" alt="Gloomberb logo" width="76" />

# Gloomberb

**Open-source finance terminal.**

Desktop app for macOS and Windows. Terminal UI for macOS, Linux, and Windows.

<a href="https://gloom.sh/download/desktop"><strong>Download desktop</strong></a>
&nbsp;&middot;&nbsp;
<a href="#install"><strong>Install the TUI</strong></a>
&nbsp;&middot;&nbsp;
<a href="https://term.gloom.sh"><strong>Open in browser</strong></a>
&nbsp;&middot;&nbsp;
<a href="README.zh-CN.md">简体中文</a>

<br />
<br />

<img src="https://gloom.sh/landing-terminal.png" alt="Gloomberb terminal showing portfolio, watchlists, market data, and chart panels." width="720" />

<sub>Backed by <a href="https://adjacent.markets/?ref=gloomberb"><img src="docs/assets/adjacent.svg" alt="" width="12" height="12" /> Adjacent</a></sub>

</div>

- **Research companies:** quotes, charts, financials, filings, options, and analyst ratings.
- **Follow markets:** news, global indices, FX, economic events, and market scanners.
- **Manage your workspace:** portfolios, watchlists, broker connections, alerts, notes, and AI tools.

The desktop app and TUI share the command language and plugin system. The [browser app](https://term.gloom.sh) opens a six-pane research workspace without an account. Some panes require a free, verified Gloom Cloud account; others require Pro. See [browser features and limits](docs/browser.md).

## What is open and what is not

The app, including the TUI, desktop app, web client and plugin API, is [MIT licensed](LICENSE). It talks to the Gloom Cloud API by default for market data, news, filings and AI. Gloom Cloud is a hosted service and is not open source. Plugins can bring other data providers.

The free tier works without paying, with rate limits, equity and options quotes delayed by 15 minutes, and news delayed by 12 hours. Real-time data and more datasets are part of the paid Gloom Cloud Pro plan, which funds the project.

## What it is not

Gloomberb is not a Bloomberg replacement: it has no Bloomberg chat network, fixed-income reference database or direct exchange feeds.

## Install

### Desktop

The desktop app is built with Electrobun. On **macOS (Apple Silicon only)**, install with [Homebrew](https://brew.sh):

```bash
brew install --cask gloomberb
```

On **Windows 11**, [download the installer](https://github.com/gloom-sh/gloomberb/releases/latest/download/stable-win-x64-GloomberbSetup.exe). It supports x64, and ARM64 through x64 emulation.

Both desktop installers include the `gloomberb` terminal command and its runtime.

### Terminal

The standalone TUI is a Bun-compiled single binary and uses [OpenTUI](https://opentui.com/). It does not need a separate Bun installation. On **macOS or Linux**, with `curl`, `gzip` and `sha256sum` or `shasum` available:

```bash
curl -fsSL gloom.sh/install | bash
```

The [install script](scripts/install.sh) downloads a binary or app archive from [GitHub Releases](https://github.com/gloom-sh/gloomberb/releases/latest), checks its SHA-256 against the release asset digest when available, and warns if no checksum is available. It uses `sudo` only if an install directory is not writable.

On Apple Silicon Macs, it installs the desktop app in `/Applications` and links the TUI into `~/.local/bin`. On Intel Macs and Linux, it installs the standalone TUI in `~/.local/bin`. `GLOOMBERB_INSTALL_DIR` changes the command's destination; `GLOOMBERB_APP_DIR` changes the Mac app's destination.

For a manual **Linux** install, download the [x64](https://github.com/gloom-sh/gloomberb/releases/latest/download/gloomberb-linux-x64.gz) or [ARM64](https://github.com/gloom-sh/gloomberb/releases/latest/download/gloomberb-linux-arm64.gz) binary, unpack it with `gzip`, mark it executable and put it on your `PATH` as `gloomberb`.

Or, with [Bun](https://bun.sh) installed on macOS, Linux or Windows x64, run once or install globally:

```bash
bunx gloomberb
# or
bun install -g gloomberb
```

On startup, the app clones missing official plugins from GitHub once a local profile exists. This needs Git and network access. Packaged apps use their bundled Bun runtime to install plugin dependencies. See [plugin installation](PLUGINS.md).

Run `gloomberb` to launch. For graphics, use a Kitty-compatible terminal such as Ghostty, Kitty, or WezTerm. See the [installation guide](docs/installation.md) for direct downloads, install locations, and updates.

Uninstall with `brew uninstall --cask gloomberb`, `bun remove -g gloomberb`, or Windows Installed apps. For script or manual installs, remove `~/.local/bin/gloomberb` (or your chosen command path) and `/Applications/Gloomberb.app` if installed. Your [profile data](docs/installation.md#where-your-data-lives) stays on disk.

## Start

Press `Ctrl+P` to open the command bar, or press `` ` `` to search for a ticker. Desktop also supports `Cmd/Ctrl+K`.

| Try | Opens |
|-----|-------|
| `DES AAPL` | Company details |
| `GP NVDA` | Price chart |
| `OVDV AAPL` | Implied-volatility surface and options term structure |
| `OPX SPY` / `GEX SPY` | Open interest by strike and expiry, max pain and dealer gamma ([method](docs/options-positioning.md)) |
| `HVG AAPL` / `HVT AAPL` | Realized volatility and volatility cones |
| `SEAS AAPL` | Seasonality: monthly returns by year and year overlays |
| `RDCF AAPL` | Reverse DCF: the cash flow growth the price assumes |
| `PEB AAPL` | P/E band: price against multiples of trailing EPS, and today's P/E in its own history |
| `SIW` | Short squeeze watch: crowded shorts in your portfolios and watchlists that are moving up |
| `RIPL` | Earnings Ripple: customers and suppliers of your holdings that report soon |
| `MDAY SPY` | Macro-day reaction: how a name moves on CPI, jobs and FOMC days against a normal day |
| `COT [code or root]` | CFTC positioning and cross-market extremes |
| `DOE` / `NGS` | EIA weekly oil stocks and gas storage, with builds, draws and five-year ranges |
| `CPI [component]` / `ECAN` | US consumer prices by component, with weights, contributions to the headline and the next release |
| `TOP` | Market stories |
| `WIRP` / `FFIP` | US rate path and conditional FOMC probabilities |
| `BTMM` | Funding rates, bill curves and Federal Reserve liquidity |
| `CTM [root]` | Futures contract curve, historical ghosts, roll yield and open interest, including `CTM VX` and CME crypto (`CTM BTC`) |
| `MAP ships` / `CHOKE` | Ships, ports, energy and airports on one map, and chokepoint transits as chart series ([guide](docs/world-map.md)) |
| `PF` | Portfolios and watchlists |
| `HELP` | Commands and keyboard shortcuts |

Use `Tab` to switch panes and `j` / `k` to navigate lists. The [user guide](docs/usage.md) covers charts, broker setup, keyboard shortcuts, and the full command reference. See [research data conventions](docs/research-data.md) for return definitions, financial sources, and model assumptions. [Supply chain evidence](docs/supply-chain.md) explains Pro SPLC trust tiers, source evidence, reverse relationships, flow diagrams and multi-hop graphs and path searches. [Credit documents](docs/credit-documents.md) covers CRDOC/COVN capital structure, covenant headroom and amendment evidence. [Research attention](docs/research-attention.md) covers the Pro ATTN dataset, privacy-qualified counts and Gloom Trending. [Hiring and app attention](docs/hiring-app-attention.md) covers HIRE/APPS observations, evidence and Pro previews.  [Government awards](docs/government-awards.md) covers AWARDS, procurement history and source coverage. [Distress records](docs/distress-monitor.md) covers DIST: 8-K filings, going-concern disclosures, listing designations and insolvency notices, with their dates and licences. [Power and grid capacity](docs/power-grid.md) covers POWER queues, large loads, utility exposure and source history. [Perpetual markets](docs/perpetuals.md) covers funding, open interest, premiums and Pro access.  [Exposure analysis](docs/exposure.md) covers EXPO scenario estimates, portfolio weights and evidence paths.

## CLI

Run commands directly from your shell:

```bash
gloomberb quote AAPL
gloomberb quote AAPL --json
gloomberb help
```

Output is human-readable by default; use `--json`, `--csv`, or `--ndjson` for scripts. See the [CLI reference](docs/usage.md#cli) for commands and flags.

## Plugins and contributing

Plugins add panes, data providers, broker connections, and commands. Install one from GitHub:

```bash
gloomberb install gloom-sh/gloom-tv
```

See the [plugin development guide](PLUGINS.md), [TV setup](docs/usage.md#live-tv), or [contributing guide](CONTRIBUTING.md) to get started.

Available in English, Spanish, Simplified Chinese, Traditional Chinese, Japanese, and Korean. Use `LANG` in the command bar to switch; see [language settings](docs/usage.md#localized-interface).

## How it is built

One Bun and React codebase runs the OpenTUI terminal app, Electrobun desktop app and browser client. Terminal releases cover macOS and Linux on x64 and ARM64, and Windows on x64. Desktop releases cover macOS on Apple Silicon and Windows x64, including Windows ARM64 through emulation.

As of 10 October 2026, the suite contains 6,956 test cases across 1,088 test files.

Six [CI workflows](.github/workflows) cover verification, Windows builds, terminal performance, pane pointer interactions, Homebrew packaging and releases. Pull requests run typechecks, unused-code checks, tests, builds and plugin compatibility checks; see [Contributing](CONTRIBUTING.md#checks). Eight releases were published from 1 to 9 October 2026; see the [release history](https://github.com/gloom-sh/gloomberb/releases).

AI coding tools are used, and every change goes through review and the test suite.

## Crash reports and usage counts

When the app hits an uncaught error, a render crash, or a plugin that fails to load, it sends a crash report to Gloom's API (`api.gloom.sh`), which forwards it to error tracking. A report contains the error type, message and stack trace, the app version, the operating system, and which surface it came from (terminal, desktop or web); when a plugin failed, its id. Your home directory is replaced with `~` before sending. Reports are tied to your account only when you are signed in.

The app also counts how often you open each function, from the command bar, a menu or a link in another pane, and which functions are on screen when a workspace is restored at launch. It sends each function's mnemonic (such as `DES` or `GP`) with those two counts, the surface, the app version and the operating system, a minute after the first count, then every 15 minutes, and when you quit. Functions from plugins other than the official gloom-sh ones are sent as `plugin`, so their names never leave your machine. The server adds your plan (signed out, Free or Pro); the counts are never tied to your account.

Neither contains anything from your workspace: no tickers, arguments, portfolios, watchlists, layouts, settings or queries. Both carry a random install id stored in `install-id` in the data folder, `~/.gloomberb` by default (in the browser, in local storage).

The usage setting also covers command bar searches. When you are signed in, a search you finish in the command bar (you pause typing or run something, never each keystroke) is stored with your account to improve search: its text, the AI suggestions it got and the result you picked. Searches are deleted with your account.

The usage setting also covers research milestones, such as opening research, viewing a tab, saving a ticker, onboarding steps and upgrade actions. Signed-in activity is linked to your account. The browser uses an anonymous visitor ID; the desktop app can continue an ID passed by the website. Events include feature, tab and onboarding desk IDs, prompt interactions, campaign attribution, referrer URLs and experiment assignments, but not the ticker you saved or the contents of your research.

To turn either off, run `Crash Reports` or `Usage Counts` from the command bar, or:

```bash
gloomberb config set telemetry.crashReports false
gloomberb config set telemetry.usage false
```

Setting `GLOOMBERB_NO_TELEMETRY=1` or `DO_NOT_TRACK=1` in the environment turns all of it off. The browser app also honours Do Not Track and Global Privacy Control.

**Attention Counts are separate and off by default.** Run `Attention Counts` in the command bar and review the consent dialog to share ticker research counts for Gloom Trending. This sends ticker symbols and the kind of explicit research action only while signed in with a verified account. It does not send holdings, watchlist names, queries or an install id. Consent stays on this device; cloud sync cannot enable it elsewhere. Turn the setting off to discard unsent counts, or run `gloomberb config set telemetry.attention false`. The environment and browser opt-outs above also disable Attention Counts. See the [attention privacy review](docs/attention-privacy.md) for the authenticated collection boundary, retention, aggregation and remaining risks.

## Sponsors

<a href="https://adjacent.markets/?ref=gloomberb"><img src="docs/assets/adjacent.svg" alt="Adjacent" width="56" /></a>

[Adjacent](https://adjacent.markets/?ref=gloomberb) builds prediction-market indices, reference rates, and data. Thank you for backing Gloomberb's open-source work.

To sponsor Gloomberb, see [gloom.sh/sponsor](https://gloom.sh/sponsor).
