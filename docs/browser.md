# Browser app

[Back to README](../README.md) · [User guide](usage.md)

Open [term.gloom.sh](https://term.gloom.sh) and sign in with a free Gloom Cloud account. The browser app uses the same DOM renderer and layout as the desktop app, with a reviewed browser plugin catalog.

## Accounts and data

- A Gloom Cloud session is required to open the workspace.
- Free accounts receive rate-limited, 15-minute-delayed Gloom Cloud market data. Pro accounts receive realtime data.
- Chat is read-only until the account's email is verified.
- Configuration, tickers, layouts, session state, and plugin state are stored in the browser.
- A share link opens the hosted terminal on the shared pane, in the state the sender was looking at: a chart keeps its drawings and zoom, a news pane its open story, a filings pane its open document. Opening one requires no account; panes served by Gloom Cloud (SEC filings, insider transactions) ask the receiver to sign in. Creating a share requires a verified Gloom Cloud account.

## Plugins

Every web-capable plugin is compiled into the build, so the IPO calendar, Polls, and Prediction Markets are there on first load with nothing to install. Disable any of them from the plugin directory as you would a built-in.

The browser app does not install plugins. Code you pick would run on the origin holding your session, and a plugin is a React component sharing the app's own modules, so there is nothing to sandbox it with. Installing belongs to the desktop app and the terminal, which run on your machine. The plugin directory still lists everything and says where each plugin runs, and typing the code of one that is not in the build, such as `TV`, says where to get it.

## Feature limits

The browser build omits brokers and native integrations, filesystem notes, local AI, plugin installation, updater/debug tools, application menus, native window controls, pop-out native windows, and native context menus.

Modules whose feeds the build has no path to are also unavailable: custom RSS feeds and Substack, market movers, ownership (13F, holders, short interest), earnings, and TV.

For local development, validation, and deployment details, see [Contributing](../CONTRIBUTING.md#browser-development).
