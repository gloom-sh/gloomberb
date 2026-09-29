# Quote boards and source validation

Futures and world-index boards read quotes through the market-data router. A
source response must match the requested symbol. When a source names an
exchange, its listing must also match; recognized exact-listing suffixes use the
same normalizer as quote metadata. Older providers may omit the exchange, which
leaves that part of the identity unverified. The router does not invent it.

Rejected responses can fall through to another source. If a refresh cannot
supply a valid quote, the board retains its previous value and reports stale
status in the existing footer. An initial failure leaves the value unavailable.
Source stale flags and invalid observation times remain ineligible.

A finite futures price can be zero or negative. The router requires explicit
source instrument type `FUT`, `FUTURE` or `FUTURES` to accept that price domain;
a ticker suffix alone is insufficient. Equity, fund and option quotes retain
their existing positive-price validation. See [CME Clearing Advisory 20-160](https://www.cmegroup.com/notices/clearing/2020/04/Chadv20-160.html)
for CME's support of zero and negative energy futures prices.

The futures board uses provider continuous/front-month aliases. These do not
establish an explicit expiry curve, contract quantity, physical-unit conversion,
or roll-adjusted investment return. Quote validation does not add those
capabilities.

Contract prices in Overview, quote reports and quote-monitor text retain up to
eight decimal places; contract changes use the same price precision instead of
rounding to currency cents. This ceiling preserves the supplied price, without
declaring a minimum tick or converting the quote's currency. The futures board
continues to use its existing catalog tick precision. Dollar prices print bare;
source `USX` prices and changes carry a `c`, and other currencies their symbol
(Dutch TTF gas in `€`). Quantity and cost formatting are separate from quote-price formatting.

Historical Prices uses numeric observation formatting for its OHLC table and
reports, including when history carries no instrument type. It retains up to
eight decimal places, subject to the table's column width; tiny nonzero values
can use scientific notation. Raw JSON observations remain unchanged. This
formatting does not establish the history's units or a continuous future's roll
convention.

## Market movers

Gainers, Losers and Most Active use the provider's returned universe and rank;
Trending hydrates quotes for the supplied symbol order. Live quotes update those
rows without claiming a newly screened global ranking. Header sorting and CSV
export use the current displayed values. Volume/average-volume ratios are
recomputed from the current volume and the reported average; an absent average
is unavailable, and a reported zero volume with a positive average is zero.

Missing price, change, volume and currency fields remain unknown. Canonical
quotes can calculate a day change from a supported explicit prior close; an
absent change does not itself mean zero. Quote snapshots replace unavailable
dynamic fields instead of borrowing those fields from the older screener row.
Source list refresh and live quote delivery are separate freshness signals.
A failed list switch cannot display the previous list as the newly selected one.
A failed same-list refresh retains validated rows with current failure/stale
status. Malformed list envelopes are failures; a valid empty quote array is an
empty list. Old cached rows that encoded missing fields as zero are invalidated.

Declared GBp/GBX, ILA and ZAc price units normalize to their major currency for
display; raw headless values retain their original amount and currency code.
GBP itself is not scaled merely because a row names London. Live quotes may
supply a different explicit subdivision of the same currency; retained price
range endpoints are converted to that subdivision. Unknown or different
currencies cannot support a retained range. No foreign-exchange conversion is
performed. Listing keys are preserved when a row opens ticker research, and the
opened source supplies its own security type.
