# Installation

[Back to README](../README.md)

The command is `gloom`. `gloomberb`, its name before 0.18.4, runs the same program.

## macOS

```bash
curl -fsSL gloom.sh/install | bash
```

On Apple Silicon this installs the desktop app as `/Applications/Gloom.app` and links `gloom` into `~/.local/bin`. On an Intel Mac it installs the standalone terminal binary instead, because the desktop app is Apple Silicon only.

With Homebrew (Apple Silicon):

```bash
brew install --cask gloomberb
```

The cask still installs the app as `Gloomberb.app` with the `gloomberb` command, and the app adds `gloom` beside it the first time it opens. You can also [download the disk image](https://gloom.sh/download/desktop).

An install from before 0.18.4 renames itself to `Gloom.app` on its first start after updating, and moves its `gloom` and `gloomberb` links with it. A Homebrew install keeps its name until the cask changes it. Your data stays where it is.

## Linux

```bash
curl -fsSL gloom.sh/install | bash
```

This installs the standalone binary as `~/.local/bin/gloom`. There is no Linux desktop app yet. On Alpine and other musl distributions the script picks the musl build, which needs `libstdc++` (`apk add libstdc++`).

To install by hand, download the [x64](https://github.com/gloom-sh/gloomberb/releases/latest/download/gloomberb-linux-x64.gz) or [ARM64](https://github.com/gloom-sh/gloomberb/releases/latest/download/gloomberb-linux-arm64.gz) binary (musl: [x64](https://github.com/gloom-sh/gloomberb/releases/latest/download/gloomberb-linux-x64-musl.gz), [ARM64](https://github.com/gloom-sh/gloomberb/releases/latest/download/gloomberb-linux-arm64-musl.gz)), unpack it with `gunzip`, make it executable and put it on your `PATH` as `gloom`.

## Windows

For the terminal command, run this in PowerShell (no admin rights needed):

```powershell
irm https://gloom.sh/install.ps1 | iex
```

It installs `gloom.exe` in `%USERPROFILE%\.local\bin` (`GLOOM_INSTALL_DIR` picks another folder) and adds that folder to your user PATH, so open a new terminal afterwards. Running it again updates it. Under Git Bash, the `curl` line stops and points here.

For the desktop app, [download the installer](https://github.com/gloom-sh/gloomberb/releases/latest/download/stable-win-x64-GloomSetup.exe). It is not code-signed yet: if Windows says "Windows protected your PC", click **More info**, then **Run anyway**. It installs to `%LOCALAPPDATA%\com.vincelwt.gloomberb\stable\app`, adds `gloom` to your PATH, and uninstalls from **Settings > Apps**. An install from an earlier installer, in `%LOCALAPPDATA%\Programs\Gloom` or a folder you picked, moves there when it updates.

- **Charts:** Windows Terminal has no Kitty graphics, so terminal charts draw as text. The desktop app draws them in full.
- **Git:** [some official plugins](../PLUGINS.md#official-plugins-that-need-git) install from GitHub and need [Git for Windows](https://git-scm.com/download/win). Without it Gloom starts without them, and `gloom doctor` names them.
- **Versions:** Windows 11 on x64 is tested. ARM PCs run the x64 build through Windows' emulation, which CI only checks opens and stays open. Windows 10 is untested.

## Bun or npm

On macOS, Linux or Windows with [Bun](https://bun.sh) installed:

```bash
bun install -g @gloom-sh/terminal
```

`npm install -g @gloom-sh/terminal` works too, but the command still runs on Bun, so Bun must be on your `PATH`. An install of the older `gloomberb` package keeps working.

## What the install script does

The [install script](../scripts/install.sh) (and [its PowerShell twin](../scripts/install.ps1)) downloads the latest release from [GitHub Releases](https://github.com/gloom-sh/gloomberb/releases/latest) and checks its SHA-256 against the `.sha256` file published beside it. If that file cannot be read or does not match, it installs nothing. This catches a corrupt download; it does not prove who published the release.

The shell script needs `curl` or `wget`, `gzip`, and `sha256sum` or `shasum`, and asks for `sudo` only when a destination is not writable. `GLOOM_INSTALL_DIR` changes where the command goes and `GLOOM_APP_DIR` where the Mac app goes. A `gloom` or `Gloom.app` that belongs to another program is left alone, and Gloom installs as `gloomberb` or `Gloomberb.app` instead.

On first start, Gloom clones a few official plugins from GitHub, which needs Git ([which ones](../PLUGINS.md#official-plugins-that-need-git)).

## Updates

The desktop app and the standalone binary download updates in the background, then show **Update ready**. Nothing restarts on its own: the desktop app installs the update when you press **Restart** (or `U`), and the terminal binary runs it the next time you start it. Homebrew installs update with `brew upgrade --cask gloomberb`, and Bun and npm installs by running their install command again.

**Release Channel** in the command bar (or `gloom config set updates.channel nightly`) switches the desktop app and the standalone binary to nightly builds of `main`, which get fixes first and can break. Switching back never installs an older version.

## Uninstall

Run `brew uninstall --cask gloomberb` or `bun remove -g @gloom-sh/terminal`, or remove the desktop app from **Settings > Apps** on Windows. For a script install, delete `~/.local/bin/gloom`, `~/.local/bin/gloomberb` and `/Applications/Gloom.app`, or `%USERPROFILE%\.local\bin\gloom.exe` on Windows. Your [data](#where-your-data-lives) stays on disk.

## Where your data lives

Settings, the database, plugins and logs live in `~/.gloomberb` (`%USERPROFILE%\.gloomberb` on Windows). `gloom version` prints the folder in use.

To keep it somewhere else, move the folder and set `GLOOMBERB_HOME` to the new path in your shell profile, or wherever the desktop app is launched from, so every launch finds it.

A new Linux install with no `~/.gloomberb` follows the XDG folders instead: `~/.config/gloomberb`, `~/.local/share/gloomberb` and `~/.cache/gloomberb`. On macOS and Linux the folder and `config.json`, which holds broker credentials, are readable by your account alone.
