# Personalized upgrade copy experiment

`upgrade_personalized` compares the generic upgrade copy (`control`) with copy
that names the account's own tickers (`personalized`). One line changes on each
surface. Access, prices, trial rules and every action stay the same. Pro walls
are not part of it.

| Surface | Control | Personalized |
| --- | --- | --- |
| Upgrade sheet, Real-time data row | Free runs 15 min behind on quotes, 12 h on news | NVDA, AAPL and MSFT quotes, not 15 min behind |
| Onboarding Pro step, first feature | Real-time market data | Real-time quotes for NVDA, AAPL and MSFT |
| gloom.sh/cloud hero lead (platform repo) | Pro makes it real-time, with the feeds professionals trade on. | Pro gives you real-time quotes for NVDA, AAPL and MSFT. |

## Who is in it

Signed-in Free accounts with at least one usable ticker, decided the same way
before the arm is known, so both arms have the same eligibility. The platform
registry assigns the arm by account id and starts with `running: false`; the
switch takes effect without an app release. Do Not Track, Global Privacy
Control, browser automation and bots get the generic copy and no exposure.
Signed-out users, Pro and trialing accounts, and accounts without a usable
ticker are never asked and always see the generic copy.

## Which tickers

`src/plugins/builtin/cloud/upgrade-tickers.ts` reads this device's portfolios
and watchlists, and makes no quote request of its own:

- Up to three holdings across every portfolio. Holdings the device can value
  (a quote it already has, or the broker's own value) come first, by market
  value; any it cannot value yet follow, by what was paid.
- With nothing held, the first watchlist tickers in list order: lists in their
  order, each sorted by ticker as the pane shows it. Team lists and the names
  the app seeds on first run are skipped, since nobody here picked them. The
  copy never calls these positions.
- Plain US stocks and exchange-traded funds only: one to five letters and an
  optional class letter (`BRK.B`) on a US listing exchange. Cash, options,
  futures, crypto pairs, mutual funds, OTC and foreign listings are skipped.

The tickers never leave the device. gloom.sh/cloud reads the same selection
from the account's synced snapshot through an authenticated `no-store` route
and renders it in the browser; the static page is the same for everyone.

## Measurement

| Event | Properties | When |
| --- | --- | --- |
| `experiment_exposed` | `experiment: "upgrade_personalized"`, `variant`, `placement` of the surface that asked first (`upgrade-sheet`, `onboarding-pro` or `cloud-hero`), `exp_upgrade_personalized` | Once per eligible account and app or browser session, when a surface is shown, in both arms. |
| `checkout_created` | `exp_upgrade_personalized` from the account | Unchanged. |
| `upgrade_intent` | Existing `placement`; `exp_upgrade_personalized` from the account once assigned | Unchanged. |

No event carries tickers, position counts, values or weights. The primary
metric is `checkout_created` per exposed eligible account, counted after its
first exposure, over all exposed accounts. `upgrade_intent` is secondary and
never filters the primary, since the copy may change intent itself. The
upgrade sheet records `upgrade_intent` before it opens, so join on the exposed
account rather than filtering events by `exp_upgrade_personalized`.
