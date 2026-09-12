# Browser app

[Back to README](../README.md) · [User guide](usage.md)

Open [term.gloom.sh](https://term.gloom.sh) and sign in with a free Gloom Cloud account. The browser app uses the same DOM renderer and layout as the desktop app, with a reviewed browser plugin catalog.

## Accounts and data

- A Gloom Cloud session is required to open the workspace.
- Free accounts receive rate-limited, 15-minute-delayed Gloom Cloud market data. Pro accounts receive realtime data.
- Chat is read-only until the account's email is verified.
- Configuration, tickers, layouts, session state, and plugin state are stored in the browser.
- Public share pages require no account. Creating a share or deleting one you own requires sign-in.

## Plugins

Every web-capable plugin is compiled into the build, so Fear & Greed, the IPO calendar, Market Halts, Market Heatmap, and Polls are there on first load with nothing to install. Disable any of them from the plugin directory as you would a built-in.

The browser app does not install plugins. Code you pick would run on the origin holding your session, and a plugin is a React component sharing the app's own modules, so there is nothing to sandbox it with. Installing belongs to the desktop app and the terminal, which run on your machine. The plugin directory still lists everything and says where each plugin runs.

## Feature limits

The browser build omits brokers and native integrations, filesystem notes, local AI, plugin installation, updater/debug tools, application menus, native window controls, pop-out native windows, and native context menus.

Modules whose feeds the build has no path to are also unavailable: RSS/Substack, prediction markets, market movers, dividend/ownership/SEC panes, earnings, and TV.

For local development, validation, and deployment details, see [Contributing](../CONTRIBUTING.md#browser-development).
