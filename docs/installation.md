# Installation

[Back to README](../README.md)

## macOS

Install the desktop app and the `gloomberb` terminal command:

```bash
brew install --cask vincelwt/tap/gloomberb
# or
curl -fsSL gloom.sh/install | bash
```

Both install `Gloomberb.app` and a `gloomberb` command that runs the TUI through the app bundle, so the bundled runtime is stored once.

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

For the best terminal experience, use a [Kitty](https://sw.kovidgoyal.net/kitty/)-compatible terminal such as Ghostty, Kitty, or WezTerm.
