# Trading through a broker

A trading-capable broker adds a **Trade** tab to ticker research and **Buy** and **Sell** ticker actions. **Orders** (`ORD`) shows open orders and recent activity for one account. Broker plugins must explicitly declare support for the shared ticket.

1. Add a profile in **Brokers**. Trading starts off; choose **Enable trading** and read the risk prompt before enabling it.
2. Choose the broker profile and account. Only a sole simulation account can be selected automatically. Multiple accounts and LIVE accounts require a choice.
3. Check the SIMULATION or LIVE badge and the broker's own bid, ask, last and source age. Cloud prices never supply an order field.
4. Enter side, quantity, order type and time in force. Price defaults come from the broker's ask for buys or bid for sells, with last price as a fallback. Edit them freely. Unsupported choices are unavailable.
5. Select **Review order** for a fresh broker quote and preview. Check cost, fees, buying power and warnings. Missing estimates are shown as unreported.
6. Confirm the exact order. A LIVE or unknown-mode account also requires typing the symbol. Editing any field, account, profile or connection invalidates the review. A review expires after a minute.
7. Follow the result. Open orders refresh every 10 seconds while visible. An absent order does not prove a fill or cancellation. UNKNOWN outcomes require reconciliation and never trigger an automatic retry.
8. Open **Orders** to modify price or quantity through a new review, or cancel with one confirmation. Some brokers report cumulative order summaries rather than individual fills; the activity view says which.

Turning trading off in Brokers blocks preview, placement, replacement and cancellation in the shared ticket. Reads remain available. Broker plugins must enforce the same permission at their transport boundary. The ticket does not replace a broker's execution or risk controls.

For a read-only report, use `gloomberb fn broker-orders --profile 1 --account 1`. Profile and account numbers select the current broker list; they are not account identifiers. Omit an ordinal only when one choice exists. The report does not place, modify or cancel orders.

The shared request currently represents one contract and BUY or SELL, with numeric session order handles plus optional native broker identifiers. It does not express option legs, explicit opening/closing intent or sell-short/buy-to-cover intent. Broker plugins must reject unsupported requests. The ticket does not infer final status from disappearance from open orders, and individual-fill reconciliation depends on what the adapter supplies.
