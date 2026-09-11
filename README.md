<div align="center">

<img src="https://gloom.sh/gloomberb-logo-grayscale.svg" alt="Gloomberb logo" width="76" />

# Gloomberb

**Open-source finance terminal. Fast, keyboard-driven, and extensible.**

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

</div>

- **Research companies:** quotes, charts, financials, filings, options, and analyst ratings.
- **Follow markets:** news, global indices, FX, economic events, and market scanners.
- **Manage your workspace:** portfolios, watchlists, broker connections, alerts, notes, and AI tools.

The desktop app and TUI share the command language and plugin system. The [browser app](https://term.gloom.sh) offers a smaller feature set and requires a free Gloom Cloud account: free market data is rate-limited and delayed by 15 minutes; Pro provides realtime data. See [browser features and limits](docs/browser.md).

## Install

### Desktop

On **macOS (Apple Silicon)**:

```bash
brew install --cask vincelwt/tap/gloomberb
```

On **Windows 11**, [download the installer](https://github.com/gloom-sh/gloomberb/releases/latest/download/stable-win-x64-GloomberbSetup.exe). It supports x64, and ARM64 through x64 emulation.

Both desktop installers include the `gloomberb` terminal command.

### Terminal

On **macOS or Linux**:

```bash
curl -fsSL gloom.sh/install | bash
```

On Apple Silicon Macs, this installs the desktop app and TUI. On Intel Macs and Linux, it installs the standalone TUI.

Or install with [Bun](https://bun.sh) on macOS, Linux, or Windows x64:

```bash
bun install -g gloomberb
```

Run `gloomberb` to launch. For graphics, use a Kitty-compatible terminal such as Ghostty, Kitty, or WezTerm. See the [installation guide](docs/installation.md) for direct downloads, install locations, and updates.

## Start

Press `Ctrl+P` to open the command bar, or press `` ` `` to search for a ticker. Desktop also supports `Cmd/Ctrl+K`.

| Try | Opens |
|-----|-------|
| `DES AAPL` | Company details |
| `GP NVDA` | Price chart |
| `TOP` | Market stories |
| `PF` | Portfolios and watchlists |
| `HELP` | Commands and keyboard shortcuts |

Use `Tab` to switch panes and `j` / `k` to navigate lists. The [user guide](docs/usage.md) covers charts, broker setup, keyboard shortcuts, and the full command reference. See [research data conventions](docs/research-data.md) for return definitions, financial sources, and model assumptions.

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
gloomberb install gloom-sh/gloomberb-tv
```

See the [plugin development guide](PLUGINS.md), [TV setup](docs/usage.md#live-tv), or [contributing guide](CONTRIBUTING.md) to get started.

Available in English, Spanish, Simplified Chinese, Traditional Chinese, Japanese, and Korean. Use `LANG` in the command bar to switch; see [language settings](docs/usage.md#localized-interface).

[MIT licensed](LICENSE). Built with [OpenTUI](https://opentui.com/).
