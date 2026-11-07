# Changelog

The biggest things in each version of Gloom. Every update's full notes are on the [releases page](https://github.com/gloom-sh/gloomberb/releases), and both are at [gloom.sh/changelog](https://gloom.sh/changelog) and in the app's Changelog.

<!--
How to edit this file (update it in the release commit):

- One section per minor version, newest first: "## 0.21: Title". The title
  names the version's two or three biggest things, as "A, B, and C".
- Under it, three to five highlights, biggest first:
  "- **Claim.** One short line. (0.21.0)"
  End each one with the update(s) it shipped in, as "(0.21.0)" or
  "(0.21.0, 0.21.2)", and say nothing the release notes do not.
- A picture from the release notes goes on its own line, indented, under its
  highlight: "  ![SCAN](https://gloom.sh/screenshots/fn/SCAN.png)".
- A version with no section here shows its updates' own top highlights, so
  a new minor version reads fine before its section is written.
-->

## 0.20: A faster desktop app, broker CSV imports, and your own header market

- **A faster, lighter desktop app.** It starts about a third faster on Mac and uses less memory. (0.20.0)
- **Import positions from your broker's CSV.** For brokers Gloom does not sync, in the app or the CLI. (0.20.2)
- **Pick the market in the header.** Follow any index or ticker, with its exchange's own hours. (0.20.3)
- **Ask Gloom shows its sources and asks before it acts.** Every figure links to the data behind it, and it asks before it presses a button. (0.20.2, 0.20.4)
- **Hong Kong listings read correctly.** `ERN` shows HK reports in their own period and currency, and HK crypto ETFs get their fund facts. (0.20.1, 0.20.2)

## 0.19: Option strategy screens, a deeper EQS, and panes that stack as tabs

- **Screen option strategies.** `CSP` adds covered calls, verticals, iron condors, straddles, strangles and calendars. (0.19.0)
- **A deeper `EQS`.** Technicals, volatility, float, quality screens, sector grades and classic scores. (0.19.0, 0.19.3, 0.19.6)
- **Stack panes as tabs.** Drop a pane on a docked pane's title bar and the two share its spot. (0.19.4)
- **A Windows app that behaves like one.** A resizable frame, edge snapping, and it stays open on Arm PCs. (0.19.1, 0.19.2)
- **New chart tools.** Hollow and Heikin Ashi candles, Fib, box and ray drawings, and kinetic pan. (0.19.0)

## 0.18: Trade from Gloom, a live scanner, and one design system

- **Trade from Gloom.** One order ticket places, changes and cancels orders, spreads included, with prices set from the chart. (0.18.2, 0.18.4)
- **A live scanner.** `SCAN` watches intraday conditions you set and can alert you on a new match. (0.18.5)
  ![SCAN](https://gloom.sh/screenshots/fn/SCAN.png)
- **One design system.** Every pane and plugin shares the same type, spacing, colours and tables. (0.18.0)
- **BTC and ETH options.** `options BTC-USD`, `OPX` and `OVDV` cover bitcoin and ether options, with the DVOL index. (0.18.5)
- **The command is now `gloom`.** `gloomberb` keeps working, and the desktop app is called Gloom. (0.18.4, 0.18.5)

## 0.17: Fixed income and commodities workspaces, honest ratios, and CME futures

- **Fixed Income in one place.** Credit, issuer debt, bonds and Treasury open together from `FI`. (0.17.0)
- **Commodities and energy together.** Futures, curves, positioning, inventories and crops are tabs of one workspace. (0.17.0)
- **Honest valuation ratios.** P/E, EV/EBITDA and P/S read over the trailing year, not one quarter times four. (0.17.1)
- **CME futures.** `FUT`, `CTM` and `COT` cover CME sector, industry, equity index and energy futures. (0.17.4)
- **Insider buying across the market.** `INS` ranks the companies whose insiders buy in the open market. (0.17.6)

## 0.16: Supply chain maps, a live heat map, and assistants that drive the terminal

- **`SPLC` supply chain.** Who a company sells to and buys from, with each link's share of revenue. (0.16.0)
  ![SPLC](https://gloom.sh/screenshots/fn/SPLC.png)
- **A heat map that moves.** `HM` groups the 500 largest US stocks and recolours with live prices. (0.16.1)
  ![HM](https://gloom.sh/screenshots/fn/HM.png)
- **`GPU` rental prices.** By model and provider, with history, price changes and related stocks. (0.16.0)
  ![GPU](https://gloom.sh/screenshots/fn/GPU.png)
- **Assistants can drive the terminal.** Connect one with `MCP`, and with Terminal control it can operate the open terminal or desktop app. (0.16.4)
- **Share any pane, or ask about it.** Post a pane to chat as a picture, or open Ask Gloom with it attached. (0.16.6)
