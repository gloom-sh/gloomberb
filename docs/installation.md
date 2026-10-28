# Installation

[Back to README](../README.md)

## macOS

Install the desktop app and the `gloom` terminal command:

```bash
brew install --cask gloomberb
# or
curl -fsSL gloom.sh/install | bash
```

The cask is in Homebrew itself; `vincelwt/tap/gloomberb`, the older tap, installs the same app. Both routes install `Gloom.app` and a `gloom` command that runs the TUI through the app bundle, so the bundled runtime is stored once.

The app was called `Gloomberb.app` up to 0.18.4. An install from then updates as usual, and the first time the new version starts it renames itself to `Gloom.app` and opens again, moving the `gloom` and `gloomberb` links the install script made in `~/.local/bin` (or `~/bin`, `/opt/homebrew/bin`, `/usr/local/bin`) along with it. A link it cannot rewrite, in a folder you cannot write to, keeps the old name until you can. A Homebrew install keeps the old name until `brew upgrade --cask gloomberb` installs `Gloom.app` in its place. Your settings and data stay where they are.

The command was called `gloomberb` before 0.18.4. That name keeps working everywhere, and an install from before 0.18.4 gets `gloom` beside it when it updates: the terminal binary adds it next to itself the first time the new version runs, and the desktop app adds it next to the `gloomberb` link the installer or Homebrew made when it starts.

`Gloom.app` is Apple Silicon (arm64) only. On an Intel Mac the install script installs the standalone `gloom` terminal app instead, and the Homebrew cask refuses to install rather than leaving an app that cannot launch.

Prefer a direct download?

- [Download Gloom for Mac](https://gloom.sh/download/desktop)

## Linux

Install the standalone TUI binary:

```bash
curl -fsSL gloom.sh/install | bash
```

This installs `gloom` to `~/.local/bin` by default. A Linux desktop package is not published yet.

On Alpine and other musl distributions the script installs the musl build, which needs `libstdc++` (`apk add libstdc++`). `bun install -g gloomberb` works there too.

## Windows

Install the desktop app:

- [Download the installer for Windows](https://github.com/gloom-sh/gloomberb/releases/latest/download/stable-win-x64-GloomberbSetup.exe)

The installer is not code-signed yet, so Windows SmartScreen may stop it. Click **More info** on the "Windows protected your PC" screen, then **Run anyway**. To check the file first, compare `Get-FileHash` on it with the SHA-256 on the [release page](https://github.com/gloom-sh/gloomberb/releases/latest).

- **Folder:** `%LOCALAPPDATA%\Programs\Gloom`, where updates from inside the app install too. Installers up to 0.18.4 used `Programs\Gloomberb`; running a new installer over such an install moves it, with its PATH entry. Earlier versions installed an update from inside the app in `%LOCALAPPDATA%\com.vincelwt.gloomberb\stable\app` instead, and the Start menu kept opening the version before it. The first time a current version starts from there, it moves itself into the installer's folder and opens again.
- **Terminal:** the installer adds `gloom` to your PATH, so open a new terminal window. PowerShell works.
- **Charts:** Windows Terminal does not support Kitty graphics, so terminal charts draw as text. The desktop app draws them in full.
- **Data:** `%USERPROFILE%\.gloomberb`, which `gloom version` prints. `GLOOMBERB_HOME` moves it.
- **Git:** Bun ships with the app; Git does not. [Some official plugins](../PLUGINS.md#official-plugins-that-need-git) install from GitHub and need [Git for Windows](https://git-scm.com/download/win). Without it the app starts without them and says so, and `gloom doctor` names them.
- **Versions:** Windows 11 on x64 is the tested setup. Windows 10, and ARM PCs running the x64 build through Windows' built-in emulation, are untested.

For a terminal-only setup on x64, install Bun and use the package:

```powershell
bun install -g gloomberb
```

## Terminal Package

Already have Bun installed on any supported OS?

```bash
bun install -g gloomberb
```

`npm install -g gloomberb` works too. The package installs the `gloom` command, and `gloomberb`, its name before 0.18.4, which runs the same program. An install from before 0.18.4 gets `gloom` when it updates with `bun install -g gloomberb@latest` (or `npm install -g gloomberb@latest`).

Then run:

```bash
gloom
```

On macOS and Windows, desktop updates replace the installed app in place and keep the terminal command pointing at the updated runtime. Homebrew users can also update through `brew upgrade --cask gloomberb`.

Updates never restart the app by themselves. The desktop app downloads a new version in the background and then shows **Update ready** in the header with a **Restart** button (`U` does the same, and so does the **Update ready, restart to apply** entry that replaces **Check for Updates** in the command bar). The new version is installed only when you press it, and the app relaunches into it. If you quit without restarting, the installed version stays as it was and the update is offered again at the next launch. The terminal binary downloads and swaps itself in the background the same way, shows **Update ready, restart to apply**, and runs the new version the next time you start it.

### Release channels

The app updates from **stable** releases. **Release Channel** in the command bar (desktop: **Release Channel...** in the app menu, terminal: `gloom config set updates.channel nightly`) switches to **nightly**, a daily build of main that gets fixes first and can break; stable releases still arrive when they are newer. Switching back to stable never installs an older version: a nightly build stays until a newer stable release is out. `GLOOMBERB_UPDATE_CHANNEL=nightly` overrides the setting for one run. npm and Bun installs, Homebrew and the install script always follow stable. Nightly builds are GitHub prereleases named `vX.Y.Z-nightly.<date>.<run>.g<sha>`, published by the Nightly workflow only for a main commit that passed Verify and Verify Windows.

For the best terminal experience, use a [Kitty](https://sw.kovidgoyal.net/kitty/)-compatible terminal such as Ghostty, Kitty, or WezTerm.

## What the install script does

The [install script](../scripts/install.sh) downloads a binary or app archive from [GitHub Releases](https://github.com/gloom-sh/gloomberb/releases/latest). It checks the SHA-256 of the download against the digest GitHub lists for the release asset, aborts on a mismatch, and warns if no checksum is available. That catches a corrupt or truncated download; it does not prove who published the release. The script needs `curl` or `wget`, `gzip`, and `sha256sum` or `shasum`, and does not run until the whole file has downloaded.

On Apple Silicon Macs it installs the desktop app as `/Applications/Gloom.app`. A `Gloom.app` that belongs to another program stays, and the app goes in as `Gloomberb.app` instead. A `Gloomberb.app` from before the rename is removed once the `gloom` and `gloomberb` links into it point at `Gloom.app`, unless Homebrew installed it or one of those links is in a folder you cannot write. The script links the `gloom` command into `~/.local/bin`. On Intel Macs and Linux it installs the standalone terminal binary, a single Bun-compiled executable that needs no separate Bun installation, in `~/.local/bin`. `GLOOM_INSTALL_DIR` (or `GLOOMBERB_INSTALL_DIR`) changes the command's destination and `GLOOM_APP_DIR` (or `GLOOMBERB_APP_DIR`) the Mac app's. It also links `gloomberb`, the command's name before 0.18.4, to the same program. A `gloom` that belongs to another program is left as it is, and Gloom is installed as `gloomberb` only. It uses `sudo` only when a destination directory is not writable.

To install by hand on Linux, download the [x64](https://github.com/gloom-sh/gloomberb/releases/latest/download/gloomberb-linux-x64.gz) or [ARM64](https://github.com/gloom-sh/gloomberb/releases/latest/download/gloomberb-linux-arm64.gz) binary (on musl, [x64](https://github.com/gloom-sh/gloomberb/releases/latest/download/gloomberb-linux-x64-musl.gz) or [ARM64](https://github.com/gloom-sh/gloomberb/releases/latest/download/gloomberb-linux-arm64-musl.gz)), unpack it with `gzip`, mark it executable and put it on your `PATH` as `gloom`.

The standalone binary unpacks its render library into the temp folder (`TMPDIR`, `/tmp` by default) when it starts. If that folder is full, read-only or mounted `noexec`, it copies the library once to `native-cache` beside the plugin cache (`~/.gloomberb/native-cache`, or `~/.cache/gloomberb/native-cache` on a new Linux install) and loads it from there. If that fails too, it says so and exits; start it with `TMPDIR` set to a writable folder that allows running programs.

On first start, the app clones its missing official plugins from GitHub once a local profile exists. That needs Git and network access ([which plugins](../PLUGINS.md#official-plugins-that-need-git)). Packaged apps use their bundled Bun runtime to install plugin dependencies. See [plugin installation](../PLUGINS.md).

## Uninstall

Run `brew uninstall --cask gloomberb`, `bun remove -g gloomberb`, or remove the app from Windows Installed apps. For a script or manual install, delete `~/.local/bin/gloom` and `~/.local/bin/gloomberb` (or the path you chose) and `/Applications/Gloom.app` (`Gloomberb.app` up to 0.18.4) if it was installed. Your [profile data](#where-your-data-lives) stays on disk.

## Where your data lives

Gloom keeps its configuration, database, installed plugins, and plugin cache in `~/.gloomberb`. To keep that folder somewhere else, point `GLOOMBERB_HOME` at the location before launching the terminal or the desktop app:

```bash
mv ~/.gloomberb ~/Documents/gloomberb
export GLOOMBERB_HOME=~/Documents/gloomberb
gloom
```

The variable moves the whole folder. A `config.json` carried along that still names the old `~/.gloomberb` as its `dataDir` is corrected to the new home on the next launch, so nothing is recreated in your home directory. Set it in your shell profile, or in the environment of whatever launches the desktop app, so every launch finds the same folder.

On Linux, a new install with no `~/.gloomberb` and no `GLOOMBERB_HOME` follows the XDG Base Directory spec instead: `config.json` in `~/.config/gloomberb`, the database and installed plugins in `~/.local/share/gloomberb`, and the plugin cache in `~/.cache/gloomberb` (or wherever `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_CACHE_HOME` point). An existing `~/.gloomberb` keeps being used and is never moved, and once the XDG `config.json` exists it stays in use even if a `~/.gloomberb` appears later.

`gloom version` prints the data directory in use.
