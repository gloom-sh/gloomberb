# Installation

[Back to README](../README.md)

## macOS

Install the desktop app and the `gloomberb` terminal command:

```bash
brew install --cask gloomberb
# or
curl -fsSL gloom.sh/install | bash
```

The cask is in Homebrew itself; `vincelwt/tap/gloomberb`, the older tap, installs the same app. Both routes install `Gloomberb.app` and a `gloomberb` command that runs the TUI through the app bundle, so the bundled runtime is stored once.

`Gloomberb.app` is Apple Silicon (arm64) only. On an Intel Mac the install script installs the standalone `gloomberb` terminal app instead, and the Homebrew cask refuses to install rather than leaving an app that cannot launch.

Prefer a direct download?

- [Download Gloomberb for Mac](https://gloom.sh/download/desktop)

## Linux

Install the standalone TUI binary:

```bash
curl -fsSL gloom.sh/install | bash
```

This installs `gloomberb` to `~/.local/bin` by default. A Linux desktop package is not published yet.

## Windows

Install the desktop app:

- [Download GloomberbSetup.exe for Windows](https://github.com/gloom-sh/gloomberb/releases/latest/download/stable-win-x64-GloomberbSetup.exe)

The installer supports Windows 11 on x64 and ARM64. On ARM64, the desktop app and its bundled `gloomberb` terminal command use Windows' built-in x64 emulation.

For a terminal-only setup on x64, install Bun and use the package:

```powershell
bun install -g gloomberb
```

## Terminal Package

Already have Bun installed on any supported OS?

```bash
bun install -g gloomberb
```

Then run:

```bash
gloomberb
```

On macOS and Windows, desktop updates replace the installed app in place and keep the terminal command pointing at the updated runtime. Homebrew users can also update through `brew upgrade --cask gloomberb`.

Updates never restart the app by themselves. The desktop app downloads a new version in the background and then shows **Update ready** in the header with a **Restart** button (`U` does the same, and so does the **Update ready, restart to apply** entry that replaces **Check for Updates** in the command bar). The new version is installed only when you press it, and the app relaunches into it. If you quit without restarting, the installed version stays as it was and the update is offered again at the next launch. The terminal binary downloads and swaps itself in the background the same way, shows **Update ready, restart to apply**, and runs the new version the next time you start it.

For the best terminal experience, use a [Kitty](https://sw.kovidgoyal.net/kitty/)-compatible terminal such as Ghostty, Kitty, or WezTerm.

## What the install script does

The [install script](../scripts/install.sh) downloads a binary or app archive from [GitHub Releases](https://github.com/gloom-sh/gloomberb/releases/latest). It checks the SHA-256 of the download against the digest GitHub lists for the release asset, aborts on a mismatch, and warns if no checksum is available. That catches a corrupt or truncated download; it does not prove who published the release. The script needs `curl` or `wget`, `gzip`, and `sha256sum` or `shasum`, and does not run until the whole file has downloaded.

On Apple Silicon Macs it installs the desktop app in `/Applications` and links the `gloomberb` command into `~/.local/bin`. On Intel Macs and Linux it installs the standalone terminal binary, a single Bun-compiled executable that needs no separate Bun installation, in `~/.local/bin`. `GLOOMBERB_INSTALL_DIR` changes the command's destination and `GLOOMBERB_APP_DIR` the Mac app's. It uses `sudo` only when a destination directory is not writable.

To install by hand on Linux, download the [x64](https://github.com/gloom-sh/gloomberb/releases/latest/download/gloomberb-linux-x64.gz) or [ARM64](https://github.com/gloom-sh/gloomberb/releases/latest/download/gloomberb-linux-arm64.gz) binary, unpack it with `gzip`, mark it executable and put it on your `PATH` as `gloomberb`.

On first start, the app clones its missing official plugins from GitHub once a local profile exists. That needs Git and network access. Packaged apps use their bundled Bun runtime to install plugin dependencies. See [plugin installation](../PLUGINS.md).

## Uninstall

Run `brew uninstall --cask gloomberb`, `bun remove -g gloomberb`, or remove the app from Windows Installed apps. For a script or manual install, delete `~/.local/bin/gloomberb` (or the path you chose) and `/Applications/Gloomberb.app` if it was installed. Your [profile data](#where-your-data-lives) stays on disk.

## Where your data lives

Gloomberb keeps its configuration, database, installed plugins, and plugin cache in `~/.gloomberb`. To keep that folder somewhere else, point `GLOOMBERB_HOME` at the location before launching the terminal or the desktop app:

```bash
mv ~/.gloomberb ~/Documents/gloomberb
export GLOOMBERB_HOME=~/Documents/gloomberb
gloomberb
```

The variable moves the whole folder. A `config.json` carried along that still names the old `~/.gloomberb` as its `dataDir` is corrected to the new home on the next launch, so nothing is recreated in your home directory. Set it in your shell profile, or in the environment of whatever launches the desktop app, so every launch finds the same folder.

On Linux, a new install with no `~/.gloomberb` and no `GLOOMBERB_HOME` follows the XDG Base Directory spec instead: `config.json` in `~/.config/gloomberb`, the database and installed plugins in `~/.local/share/gloomberb`, and the plugin cache in `~/.cache/gloomberb` (or wherever `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_CACHE_HOME` point). An existing `~/.gloomberb` keeps being used and is never moved, and once the XDG `config.json` exists it stays in use even if a `~/.gloomberb` appears later.

`gloomberb version` prints the data directory in use.
