# Open source and Gloom Cloud

[Back to README](../README.md)

## What is open and what is not

The app is [MIT licensed](../LICENSE): the terminal app, the desktop app, the web client and the plugin API. By default it gets market data, news, filings and Ask Gloom from Gloom Cloud, a hosted service that is not open source. Plugins can bring other data sources.

The free tier needs no payment. It has rate limits, delays equity and options quotes by 15 minutes and news by 12 hours. Gloom Cloud Pro adds real-time data and more datasets, and funds the project.

## How it is built

One Bun and React codebase runs all three apps: the terminal app on [OpenTUI](https://opentui.com/), the desktop app on Electrobun, and the browser client. Terminal builds cover macOS and Linux on x64 and ARM64, and Windows on x64. The desktop app covers macOS on Apple Silicon and Windows on x64. [Installation](installation.md#windows) lists what is tested on Windows.
