# Browser app

[Back to README](../README.md) · [User guide](usage.md)

Open [term.gloom.sh](https://term.gloom.sh) and sign in with a free Gloom Cloud account. The browser app uses the same DOM renderer and layout as the desktop app, with a reviewed browser plugin catalog.

## Accounts and data

- A Gloom Cloud session is required to open the workspace.
- Free accounts receive rate-limited, 15-minute-delayed Gloom Cloud market data. Pro accounts receive realtime data.
- Chat is read-only until the account's email is verified.
- Configuration, tickers, layouts, session state, and plugin state are stored in the browser.
- Public share pages require no account. Creating a share or deleting one you own requires sign-in.

## Feature limits

The browser build omits brokers and native integrations, filesystem notes, local AI, external plugins, updater/debug tools, application menus, native window controls, pop-out native windows, and native context menus.

Modules that depend on desktop-only or CORS-blocked feeds are also unavailable: RSS/Substack, prediction markets and polls, market halts/heatmap/movers, dividend/ownership/SEC panes, earnings/IPO, and TV.

For local development, validation, and deployment details, see [Contributing](../CONTRIBUTING.md#browser-development).
