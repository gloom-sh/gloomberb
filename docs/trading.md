# Trading

The Trade tab uses the selected broker's quote, account, capabilities, and order preview. Trading must be enabled for the broker profile. When several accounts are available, choose one explicitly. Simulation and LIVE accounts are named in text as well as marked with a badge.

Open the command bar with **Ctrl+P**. `BUY AAPL 10` or `SELL AAPL 10` opens the shared Trade tab with the side and quantity filled in. An optional fourth argument supplies a limit price, for example `BUY AAPL 10 150`. The ticket focuses Review; the command does not request a preview or submit an order. Without an explicit price, editable price defaults come from the broker's quote.

For a small terminal, run **Fullscreen Pane** from the command bar to give the focused ticket the available window. The same command restores its previous size.

## Review and confirmation

1. Choose the account and check its SIMULATION or LIVE badge.
2. Check the broker quote, its age, and any delayed or stale warning.
3. Enter the side, quantity, type, price, and time in force.
4. Review the exact order and the broker's preview, fees, account impact, and warnings.
5. On simulation review, press **Tab** to focus the confirmation button, then **Enter** to submit.
6. On LIVE review, focus the symbol field, type the required symbol, then press **Enter** to focus confirmation and **Enter** again to submit.
7. Read the result. An unknown outcome requires refresh and reconciliation; it is never retried automatically.
8. Open Orders to inspect activity, modify through another review, or cancel through a confirmation.

Review initially focuses **Edit order**. Repeating Enter after opening review therefore cannot accidentally place an order. Every edit invalidates the old preview. A replacement also requires a new preview and review. Cancellation may remain pending because the order can still fill until the broker confirms it.

## Keyboard

The footer shows actions relevant to the current screen. Tab and Shift+Tab walk the controls. Arrow keys change the selected option or move through lists. Character shortcuts do not intercept text typed into a field; move focus out of the field first. Disabled actions stay disabled when invoked by a key.

| Screen | Key | Action |
|---|---|---|
| Ticket editing | `b`, `s` | Buy, Sell |
| Ticket editing | `r` | Review the valid order |
| Ticket editing | `a` | Choose account |
| Ticket editing | `t` | Choose time in force |
| Ticket editing | `x` | Toggle extended hours, where supported |
| Ticket editing | `1`, `2`, `3`, `4` | Market, Limit, Stop, Stop limit, where supported |
| Ticket editing | `5`, `6`, `7` | 25%, 50%, Max quantity |
| Ticket editing | `8`, `9`, `0`, `p` | Broker bid, mid, ask, last price |
| Trading off | `e` | Open the trading consent screen |
| Trading consent | Enter, Escape | Enable trading with consent, or return to read-only |
| Ticket or result | `o` | Open Orders |
| Review | `e`, Escape | Return to editing and invalidate review |
| Review | Enter | Activate the focused control; submit only when confirmation is focused and allowed |
| Result | `r` | Refresh and reconcile status |
| Rejected result | `e` | Edit the rejected order |
| Result, except unknown or rejected | `n` | Start a new order |
| Orders | Up/Down or `k`/`j` | Select an order |
| Orders | `m` | Modify the selected order |
| Orders | `c` | Request cancellation confirmation |
| Orders | `a`, `v` | Choose account or view |
| Orders | `r` | Refresh orders and executions |
| Orders opened from Trade | Escape | Return to the ticket |
| Confirmation or picker | Enter | Activate the focused confirmation or selected choice |
| Confirmation or picker | Escape | Go back without confirming |

`r` is a deliberate Trade-tab exception to the usual refresh shortcut: it opens review while editing and refreshes status on the result screen. The footer identifies the current action. LIVE confirmation and broker capability checks apply equally to keyboard and pointer input.

## Accessibility

Buy and Sell, account mode, delayed data, and order status are written as words. Colour adds emphasis but does not carry those meanings alone. The terminal marks the focused field with `>` and a brighter label; focused actions use a selected surface. Desktop fields and controls have visible focus borders.

Desktop inputs have accessible names even when their visible labels sit in a separate column. Side and order type use named radio groups with selected state. Account selection exposes a named button and a list of account choices, including the account mode. Callout warnings use a status role; negative callouts use an alert role. These semantics support assistive technology, but a DOM audit is not a substitute for testing with a particular browser and screen reader.

The terminal draws a cell grid. It does not expose the desktop DOM roles or a native accessibility tree. Terminal screen-reader behaviour depends on the terminal and assistive software, and cursor movement or screen repainting may interrupt reading. No claim of terminal screen-reader compatibility or accessibility certification is made from a screenshot or keyboard smoke test.

Contrast was measured using the rendered theme colours. White Phosphor has 4.79:1 for muted form-card labels, 9.26:1 for amber callouts, 5.44:1 for red callouts, and 5.77:1 for LIVE badge text. Monokai, the built-in theme described as high contrast, has 5.53:1 for form-card labels, 11.63:1 for amber callouts, 4.63:1 for red callouts, and 4.62:1 for LIVE badge text. Terminal and desktop cards use the same explicit fill, so labels retain these ratios inside focused floating panes. Callouts and badges adjust their text colour to meet the 4.5:1 normal-text target while preserving their semantic border or fill. The measured desktop field-focus borders exceed 3:1 in both themes. These checks do not cover OS forced-colour modes or certify all application chrome.

The keyboard flow is verified at 90 columns by 30 rows with a disposable, synthetic broker profile. It includes command entry, editing, review, deliberate confirmation, result, Orders, replacement review, and cancellation confirmation. The synthetic broker acknowledges cancellation as Pending cancel; this proves the request flow, not completed cancellation. No pointer input is needed for those steps. This verification does not establish that every broker supports every order type or that an order will execute at the displayed quote.
