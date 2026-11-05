# Browser app

[Back to README](../README.md) · [User guide](usage.md)

[term.gloom.sh](https://term.gloom.sh) opens a starter workspace with no account. It shares its layout and panes with the desktop app, and keeps your configuration, tickers, layouts and plugin state in the browser.

## Accounts and data

- Many functions open signed out, including 13F funds (`13F`), earnings (`ERN`, `EVTS`), institutional holders (`HDS`), Treasury auctions (`AUCT`), the bond tape (`TRACE`), trading halts (`HALT`), Fear & Greed (`FNG`), comment letters (`CLTR`), prediction markets (`PM`) and polls (`POLL`). Free access has rate limits, higher when signed in.
- Some panes, such as filings and insider transactions, need a free, verified Gloom Cloud account; others need Pro. Chat needs a free account and is read-only until its email is verified.
- Free data is delayed: equity and options quotes by 15 minutes, news by 12 hours. Pro adds real-time data and more datasets.
- Signed out, after a minute in the workspace, Chrome and Edge may offer to sign you in with Google. Picking an account signs you in, or creates a free account, and closing the prompt keeps it away for a week.

## Links

- A function link opens one function, as typing it would: `term.gloom.sh/?fn=ERN&arg=NVDA` opens NVDA's earnings. The argument is one symbol or a comma list. `?ticker=NVDA&tab=news` opens the research pane on a tab.
- A share link opens the shared pane as the sender saw it, with a chart's drawings and zoom or a news pane's open story. Opening one needs no account, though panes served by Gloom Cloud ask the receiver to sign in. Creating one needs a verified account.

## Plugins

Every plugin that runs on the web is compiled into the build, so Polls and Prediction Markets are there on first load. Disable any of them from the plugin directory.

The browser app does not install plugins: a plugin is code that would run with your session and the app's own modules, so there is nothing to sandbox it with. The desktop app and the terminal install them. The plugin directory still lists every plugin and says where each one runs.

## Not in the browser

Brokers and native integrations, filesystem notes, local AI, plugin installation, the updater and debug tools, application menus, native window controls and context menus, pop-out windows, custom RSS feeds and Substack, market movers, and TV.

For local development and deployment, see [Contributing](../CONTRIBUTING.md#browser-development).
