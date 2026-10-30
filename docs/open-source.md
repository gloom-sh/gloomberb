# Open source and Gloom Cloud

[Back to README](../README.md)

## What is open and what is not

The app, including the TUI, desktop app, web client and plugin API, is [MIT licensed](../LICENSE). It talks to the Gloom Cloud API by default for market data, news, filings and AI. Gloom Cloud is a hosted service and is not open source. Plugins can bring other data providers.

The free tier works without paying, with rate limits, equity and options quotes delayed by 15 minutes, and news delayed by 12 hours. Real-time data and more datasets are part of the paid Gloom Cloud Pro plan, which funds the project.

## What it is not

Gloom is not a Bloomberg replacement: it has no Bloomberg chat network, fixed-income reference database or direct exchange feeds.

## How it is built

One Bun and React codebase runs the OpenTUI terminal app, Electrobun desktop app and browser client. Terminal releases cover macOS and Linux on x64 and ARM64, and Windows on x64. Desktop releases cover macOS on Apple Silicon and Windows x64. Windows on ARM runs the x64 build through Windows' built-in emulation; CI checks that the desktop app opens and stays open there, and [installation](installation.md#windows) lists what else is tested.
