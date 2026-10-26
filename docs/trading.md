# Trading

Research's Trade tab is the chart with the ticket beside it. Chart is the chart alone, and Overview never carries the ticket: it lists the security's working orders and latest fills under Positions, and choosing a working order opens Trade with it ready to change. Buy/Sell in the pane menu, or `b`/`s` on Chart or Overview, opens Trade; the chart footer shows `b` when a trading-capable broker profile is enabled. Review, results and Open orders stay inside the panel. Escape from outside a field or review, or the × beside the account, returns to Chart. Drag the line between chart and ticket to resize them, or press `<` and `>`; the width is kept for the pane. At less than 100 terminal columns or about 900 desktop pixels, Trade is the ticket alone and the Chart tab is one step away; a 90x30 terminal does not squeeze a chart beside the ticket.

The docked quote reads like a broker's: the last price and change, then bid in green and ask in red with their sizes. A delayed quote shows a clock; hover it for the source and its age. A placed order, and every fill seen later, also shows a toast, and a desktop notification when the app is in the background. A fill or partial fill also syncs the profile's positions into its portfolio a couple of seconds later, once for a burst of fills, so the Portfolio pane shows a new position, or drops one a sell closed, without a manual sync.

The ticket uses the selected broker's quote, account, capabilities, and order preview. Trading must be enabled for the broker profile. When several accounts are available, choose one explicitly. An instrument opened from another broker (a search result or position from it) trades by its symbol through the broker you trade with. SIM and LIVE appear beside the account name. The panel uses a neutral split border.

Open the command bar with **Ctrl+P**. `BUY AAPL 10` or `SELL AAPL 10` opens Research with its trade panel (or the narrow Trade fallback), with the side and quantity filled in. An optional fourth argument supplies a limit price, for example `BUY AAPL 10 150`. The ticket focuses the primary Buy or Sell action; the command does not request a preview or submit an order. Without an explicit price, editable price defaults come from the broker's quote.

For a small terminal, run **Fullscreen Pane** from the command bar to give the focused ticket the available window. The same command restores its previous size.

## Spreads

A spread of two to four option legs on one underlying trades as one order, filled whole or not at all, where the broker takes spreads. Build it in OSA: add legs from the chain or OMON (`a`), then press **Trade** (`t`). OSA opens the underlying's Trade tab with the legs, at the common contract count: 2 long 345 calls and 2 short 350 calls are 2 of the 1x1 vertical. One leg opens that contract's own ticket instead. **Trade** appears only when an enabled broker profile can trade the position, so OSA reads the same without one.

The ticket lists each leg with its side, ratio times the spread quantity, contract and mid. Quantity counts spreads. Buy pays a net debit and Sell receives a net credit; the price is always the positive net per spread, and switching side turns every leg over. The spread's bid and ask come from its legs' broker quotes: buying it pays the long legs' asks and receives the short legs' bids, and the bid is the reverse. Review names the strategy, such as `AAPL call vertical`, lists the legs and warns when the quotes net the other way from the side chosen. Spread orders appear in Open orders and on Overview for the underlying, with the strategy's name, and change and cancel like any other order; a change keeps the legs and their ratios. Spreads take market or limit orders, DAY or GTC, with no extended hours. Whether each leg opens or closes a position is the broker's to decide from the account's holdings.

## Brackets, OCO and trailing stops

Where the broker places them itself, the ticket offers three kinds of orders that work without the app open. A broker that takes none of a kind does not show it. Each is one order to review and confirm, and the broker holds and runs its parts.

- **Take profit / stop loss** (a bracket): tick it under the price, then enter a take profit, a stop loss or both. They are placed with the entry, on the other side for the same quantity: a limit at the take profit and a stop at the stop loss. They work once the entry fills, and one filling cancels the other. A buy's take profit is above its limit or stop and its stop loss below; a sell's the other way round.
- **OCO**, in Type: a limit and a stop on the same side for the same quantity, where one filling cancels the other, such as selling a holding at a target above the market or a stop below it.
- **Trailing stop**, in Type: a stop that follows the market by a price distance or a percent, as the broker allows. Switching between price and percent clears the distance.

Brackets, OCO pairs and trailing stops are only ever the broker's own: the ticket never imitates one with separate orders, which would protect a position only while the app is open. Review lists the take profit and stop loss. An exit on the wrong side of the entry's price is refused. For an entry that trades now, review also warns when an exit is already through the market. An entry resting away from the market fills at its own price, so its exits are measured from that price alone. Open orders list a bracket's orders together, the entry first and its exits under it, and an OCO pair together; when one of them fills or is cancelled, the others update as the broker reports them. Each order of a bracket or pair changes and cancels on its own.

## Review and confirmation

1. Choose the account and check its SIM or LIVE mode.
2. Check the broker quote, its age, and any delayed or stale warning.
3. Enter the side, quantity, type, price, and time in force. A new limit starts at the side of the quote it takes (the ask to buy, the bid to sell) until you change it, from a current quote only. A quote older than a minute, such as the last session's bid and ask before the open, shows its age beside it and leaves the limit empty until a current one arrives (a broker's stream brings it within seconds); Bid, Mid, Ask and Last still set it from the quote on screen. A stop starts empty: at the touch it would trigger at once, and review warns about a buy stop at or below the ask or a sell stop at or above the bid. A market order's estimate uses the same side of the quote.
4. Press the primary **Buy** or **Sell** action to review the exact order and the broker's preview, fees, account impact, and warnings. The side buttons only select a side.
5. On simulation review, press **Tab** to focus the confirmation button, then **Enter** to submit.
6. On LIVE review, focus the symbol field, type the required symbol, then press **Enter** to focus confirmation and **Enter** again to submit.
7. Read the result. An unknown outcome requires refresh and reconciliation; it is never retried automatically.
8. Open Orders to inspect activity, modify through another review, or cancel through a confirmation.

Review initially focuses **Edit order**. Repeating Enter after opening review therefore cannot accidentally place an order. Every edit invalidates the old preview. A replacement also requires a new preview and review. Cancellation may remain pending because the order can still fill until the broker confirms it.

### Optional one-click simulation orders

**Confirm orders** is on by default. Only explicitly classified simulation accounts can turn it off, for the current account and ticket session. Switching accounts or profiles, changing account mode, or changing connection/configuration resets it. It never enables trading. LIVE and unknown accounts always retain typed-symbol confirmation; replacements always open review.

With confirmation off, the primary Buy/Sell action still validates the exact draft, loads a fresh broker quote, requests a fresh broker preview, and submits that same immutable request at most once. Any warning (including delayed/stale quotes) or preview error opens review instead. Changes during these asynchronous steps invalidate submission. Uncertain outcomes remain reconciliation-only, with no automatic retry.

### Numeric fields

Quantity, limit and stop prices support **minus/plus**, **Up/Down**, and the **mouse wheel over the control**. Wheel input elsewhere scrolls normally. Busy fields cannot change. The controls use broker-reported quantity increments and price increments when supplied. Without a price increment, they use the reported decimal precision, or 0.01 when precision is unknown, purely as an editing step, not a claim about exchange tick size. The broker preview still validates the price. Quantity stepping respects minimums, whole-quantity requirements and known sell holdings.

## Keyboard

The footer shows at most three ticket actions relevant to the current screen. The pane menu keeps the remaining keyboard actions, including F6. Tab and Shift+Tab walk the controls. Arrow keys change the selected option or move through lists. Character shortcuts do not intercept text typed into a field; move focus out of the field first. Disabled actions stay disabled when invoked by a key.

| Screen | Key | Action |
|---|---|---|
| Chart or Overview with trading available | `t` | Open Trade, without submitting; choose Buy or Sell in the ticket |
| Options chain with trading available | `t` | Open the selected contract's Trade on a Buy ticket; choose the side in it |
| Options chain | Enter | Open the selected contract's quote, chart and Trade |
| Docked Research | F6 | Move focus between chart and ticket, including from a text field |
| Docked Research | `<`, `>` | Widen or narrow the ticket beside the chart |
| Ticket editing | `b`, `s` | Buy, Sell |
| Ticket editing | `r` | Open review, even when SIM one-click is enabled |
| Numeric field | Up/Down | Increase/decrease by one editing step |
| Numeric field | Enter | Focus the primary action, without submitting |
| Numeric field | Escape | Leave the field and return focus to the account control |
| Ticket outside a text field | `h`, `l` | Switch research tabs |
| Buy/Sell side control | Left/Right | Change side, without submitting |
| Confirm orders checkbox (SIM only) | Tab/Shift+Tab, then Space or Enter | Focus and toggle confirmation |
| Primary Buy/Sell action | Enter | Preview, then open confirmation or submit an opted-in SIM order |
| Ticket editing | `a` | Choose account |
| Trade with multiple brokers, or standalone Orders | `d` | Choose broker or broker profile |
| Ticket editing | `t` | Choose time in force |
| Ticket editing | `x` | Toggle extended hours, where supported |
| Ticket editing | `1`, `2`, `3`, `4` | Market, Limit, Stop, Stop limit, where supported; Trailing stop and OCO from Type |
| Take profit / stop loss checkbox | Tab/Shift+Tab, then Space or Enter | Add or remove a bracket's exits, where the broker takes brackets |
| Ticket editing | `5`, `6`, `7` | 25%, 50%, Max quantity |
| Ticket editing | `8`, `9`, `0`, `p` | Broker bid, mid, ask, last price |
| Docked ticket editing | `c` | Pick the price being edited, or the entry's, on the chart beside the ticket |
| Chart picking a ticket price | Enter, Escape | Set the price at the cursor, or keep the ticket's |
| Chart with the level tool (`Shift+H`) beside the ticket | `[`/`]`, then Up/Down | Choose an order or draft line and move it; a working order's move opens its change for review |
| Trading off | `e` | Open the trading consent screen |
| Trading consent | Enter, Escape | Enable trading with consent, or return to read-only |
| Ticket or result | `o` | Open Orders |
| Review | `e`, Escape | Return to editing and invalidate review |
| Review | Enter | Activate the focused control; submit only when confirmation is focused and allowed |
| Result | `r` | Refresh and reconcile status |
| Rejected result | `e` | Edit the rejected order |
| Result, except unknown or rejected | `n` | Start a new order |
| Full-screen Orders | Up/Down or `k`/`j` | Select an order |
| Docked ticket | `o`, then `o` again | Show and focus Open orders, then hide them. Without open orders for the ticker they stay hidden until asked for, and a review hides them until it is placed or edited. Each order is one line, with edit and cancel icons |
| Docked ticket outside a text field | `+`, `-`, Left/Right and other chart keys the ticket does not use | Act on the chart beside the ticket |
| Docked Open orders | `k`/`j` | Select an order |
| Docked Open orders | Up/Down, then Enter | Step its price, then request a replacement review, never submit directly |
| Orders | `m` | Modify the selected order |
| Orders | `c` | Request cancellation confirmation |
| Orders | `a` | Choose account |
| Orders | `v` | Toggle Open orders and Activity |
| Orders | `r` | Refresh orders and executions |
| Orders opened from Trade | Escape | Return to the ticket |
| Confirmation or picker | Enter | Activate the focused confirmation or selected choice |
| Confirmation or picker | Escape | Go back without confirming |

`r` is a deliberate Trade-tab exception to the usual refresh shortcut: it opens review while editing and refreshes status on the result screen. The footer identifies the current action. LIVE confirmation and broker capability checks apply equally to keyboard and pointer input.

## Price context

Average position cost, working/partially filled orders and the edited limit/stop prices appear as labelled horizontal chart levels for the ticket's ticker. Buy is green and Sell is red in the default theme; draft levels are dashed. Compact labels sit at the right end of their lines without reserving a gutter. Desktop tags are text-sized, centred on the line, with a one-pixel line-colour border and chart-background fill. Exact price tags use the instrument precision, independent of the grid formatter, and yield to grid labels when crowded. A label repeats the exact price only when its axis tag cannot be shown. Levels outside the visible price range are clipped.

### Trade from the chart

With the ticket docked beside the Chart tab, the chart sets and changes its prices. Nothing reaches the broker from the chart: every change goes through the ticket's review and confirm.

- **Pick a price.** Choose **Chart** beside the price presets, or press `c` in the ticket, and the chart takes the pointer and the keys. A click on the plot sets the ticket's price to the price under the pointer. Enter sets it to the price at the chart's cursor, which Left and Right move from bar to bar. Escape keeps the price as it was, and so does leaving the pane. `c` in a price field, such as take profit or stop loss, picks that price. The price is rounded to the broker's tick, never below one tick, and the ticket takes the keys back, on Review.
- **Drag a draft line.** The dashed limit, stop, take profit and stop loss lines move with a plain drag and change the draft.
- **Drag a working order.** The line of a working limit or stop order, or of one order of a bracket or OCO pair, opens that order's change in the ticket at the new price. The change shows as a dashed line, and the order's own line stays where the broker holds it until the change is reviewed and confirmed. If the ticket holds an order or change you have not sent, the ticket asks before replacing it. Lines that stay where they are: an order the broker cannot change, one it is still acknowledging or replacing, a trailing stop and a spread.
- **From the keyboard.** In the chart, `Shift+H` puts the level tool in hand. `[` and `]` step through the lines, top to bottom, and Up and Down move the chosen one half a row at a time. F6 goes to the ticket, where Enter on Review opens the review. Backspace never cancels an order from the chart: cancel it from Open orders.

Results retain the exact submitted preview as a receipt. The “Estimates from order preview” section shows saved cost, fees, commission and buying power after, not settled charges or a current account balance. Missing preview figures say Not reported. After a lost placement acknowledgement, Filled and Remaining say Not confirmed. After an uncertain replacement or cancellation, retained quantities are labelled Last known until a matching broker response confirms them. Closing or resizing the panel does not discard a pending submission or an unknown-outcome lock.

## Accessibility

Buy and Sell, account mode, delayed data, and order status are written as words. Colour adds emphasis but does not carry those meanings alone. The terminal marks the focused field with `>` and a brighter label; focused actions use a selected surface. Desktop controls retain visible focus rings or selected surfaces; quiet numeric wells use a focus underline.

Desktop inputs have accessible names even when their visible labels sit in a separate column. Side uses a named radio group with selected state. Order type and TIF use named selection buttons; numeric minus/plus buttons name their field. Account selection exposes a named button and a list of account choices, including the account mode. Callout warnings use a status role; negative callouts use an alert role. These semantics support assistive technology, but a DOM audit is not a substitute for testing with a particular browser and screen reader.

The terminal draws a cell grid. It does not expose the desktop DOM roles or a native accessibility tree. Terminal screen-reader behaviour depends on the terminal and assistive software, and cursor movement or screen repainting may interrupt reading. No claim of terminal screen-reader compatibility or accessibility certification is made from a screenshot or keyboard smoke test.

Palette checks for the flat panel give label contrast of 4.96:1 in White Phosphor and 5.20:1 in Monokai against the theme background. Callout text remains above 4.5:1. Account-mode text is contrast-adjusted against that background to at least 4.5:1, including Monokai LIVE. Field-focus underlines exceed 3:1 against the well in both themes. These checks do not cover OS forced-colour modes, every surrounding surface, or certify all application chrome.

The keyboard flow is verified at 90 columns by 30 rows with a disposable, synthetic broker profile. It includes command entry, editing, review, deliberate confirmation, result, Orders, replacement review, and cancellation confirmation. The synthetic broker acknowledges cancellation as Pending cancel; this proves the request flow, not completed cancellation. No pointer input is needed for those steps. This verification does not establish that every broker supports every order type or that an order will execute at the displayed quote.
