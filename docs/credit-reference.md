# Index and sovereign CDS reference

[Research data conventions](research-data.md) · [User guide](usage.md)

`CDX`, `SOVR` and `WCDS` open one CDS Boards pane. `CDX` opens Index, the on-the-run 5Y CDX IG, CDX HY, CDX EM, iTraxx Main and iTraxx Crossover. `SOVR` and `WCDS` open Sovereign, sovereign 5Y CDS ranked by the month's move, beside the local currency's month against the dollar. Both are daily levels built from the trades DTCC publicly disseminates: the CFTC credit files for indexes and the SEC credit files for sovereigns. Intraday files update the current day as they land, so today's level is partial until the day's file closes it (see [Today so far](#today-so-far)). History starts with the oldest daily file DTCC still serves (about two years).

## Which prints count

A new trade counts only as an execution. Swaption exercises (which print at the strike), novations and clearing legs repeat an earlier trade's terms and are left out. A correction replaces the print it corrects, and an error record removes it. Later modifications and terminations do not change the price a trade was struck at, so they are ignored.

## Quotes and units

CDX IG, iTraxx Main and Crossover trade on spread and show in basis points. CDX HY and CDX EM trade on price and show as the price, as quoted. Moves and ranges stay in the same unit: basis points for the spread indexes, points of price for HY and EM. Wider spreads and lower prices are the adverse direction and show in red.

`gloom fn CDX --json` gives each level and move as a number with its unit beside it: `level` with `unit` (`bp` or `price`) and `change1D`, `change1W` with `changeUnit` (`bp` or `pts`). `--csv` writes the numbers with a `5Y unit`, `1D unit` and `1W unit` column. `fn SOVR` does the same, every row in `bp`; `fn SOVR Brazil` lists that country's row alone, named by its name or code (`BR`), and `SOVR Brazil` in the app opens the board on it.

Every exported row says what it is and when it is from, in the [five fixed columns](usage.md#what-every-exported-row-says): `symbol_or_series` is the series (`cdx:hy`, `sovereign-cds:br`, the IDs `history` and the data catalog take), `currency_or_unit` the row's unit (`bp` or `price`), `interval` `daily`, and `as_of` the row's own day, never the day of the export: a sovereign whose last print was two weeks ago is dated two weeks ago. A named index's history dates each day's row by that day. The 1Y rank is a whole number, as the board draws it. `fn CDS` dates each issuer by its 5Y level's day (by its last trade when it has none), each trade by its own time, and a name's 5Y figures by their level's day.

### Points and upfront

CDX HY and EM trade in points of par: the price is 100 less the upfront, the share of the notional that changes hands when the trade is struck. Every contract pays a standard running coupon (100bp, or 500bp for HY and Crossover) rather than its own spread, and the upfront makes up the difference: at a price of 106.00 the protection buyer receives 6 points and pays the 500bp coupon. The cash a trade settles for also returns the coupon accrued since the last quarterly date (Mar, Jun, Sep, Dec 20): DTCC's CDX EM print at 97.295 on 2026-10-01 settled for 2.705 points less 11 days of 100bp.

### Spread equivalent

Spread eq restates HY's and EM's price as the spread a 5Y contract would quote, so it can be read against a spread such as HY OAS. It is the market's conversion, the ISDA standard model the single-name CDS levels use: a flat hazard rate, the index's coupon (HY 500bp, EM 100bp) and standard recovery (HY 30%, EM 25%), the contract's maturity and quarterly IMM schedule, accrual on default, and that day's flat USD rate (the mean of the 2- and 5-year Treasury yields less 25bp, 4% when FRED does not answer). The price converts as the cash it settles for. A price of 100 is the coupon; each point above par takes roughly 20 to 25bp off it, so HY at 106.00 is about 357bp. It is a model figure, not a traded spread, and spread-quoted indexes leave it blank. `--json` gives it as `spreadBp` on the board and on each day of a named index's history.

Reporters disagree on the unit of the same field. Percentage notation is mostly written as a decimal fraction (0.0058 for 58bp, 0.0107 for a price of 107) and sometimes as a true percentage (0.58, or 1.07 for 107); basis-point notation is read as basis points and monetary notation as a price. A print whose value fits no unit (a spread outside 0.5bp to 5,000bp, a price outside 20 to 200) is dropped.

## On the run

Indexes roll on a calendar: a new series starts on Mar 20 and Sep 20, five years and three months out (the Jun 20 or Dec 20 maturity). Not every family moves on the day. On roll day the old series still prints about as often as the new one, and CDX HY launches about a week later. So the new series becomes the one shown on the first day, on or after its scheduled roll, that it prints at least half as often as the old series. It stays until the next roll. Within a series, the version with the most prints that day (the index factor) is the one priced, so a version created by a default does not mix with the one before it.

Sovereign CDS follows the same Mar 20 and Sep 20 calendar, on the day.

## Daily level

An index's level is the median of the day's prints on the on-the-run contract and version, after dropping prints far from that median: more than the larger of 3bp and 15% for spreads, or of 1.5 points and 3% for prices. The band holds a stressed day's range and still drops a spread booked as a price, a coupon or a value off by a unit. A day with fewer than three prints stands only when a busier day on the same contract within two weeks agrees with it.

Sovereign levels start from the single-name CDS method (see [Single-name CDS](research-data.md#single-name-cds)): the upfront converted with the ISDA standard model, its side taken from reported spreads or from prints that allow only one reading. Sovereign prints that report a spread leave the upfront blank, so those spreads count as reported when they fall between 10bp and 1,000bp; outside that range the field holds something else, such as the upfront in points. Most sovereigns seldom report a spread, so a settled day also vouches for its neighbours within two weeks, one day after another, and a new contract starts from the levels of the one before it. Such a chained level picks an upfront's side only while it sits at least 20bp (or 20%) from the coupon: near the coupon the two readings are too close to tell apart, and a wrong guess would mirror the whole stretch. Each contract is followed on its own across a roll. A CDX EM trade booked leg by leg shows as the same upfront on five or more sovereigns the same day and is dropped. A day more than 15bp (or 25%) from the median of its contract's levels within a week either side rests on a mispriced print and is dropped. So is a stretch that meets the levels either side of it in a mirror image, where the two levels at each handover sum to about twice the coupon: it took its side from a bad print. Names trading close to their coupon that seldom report a spread can miss days; names without a level in the past month are left off the board.

## Moves and rank

The 1D, 1W and 1M moves compare complete days (see [Today so far](#today-so-far)) and are measured on one contract. In the weeks after a roll, when the new contract has no level back then, the move is chained through the previous contract from the first day both traded. When neither gives a baseline within a week of the start date, the move is left empty rather than mixing contracts.

The chart and the 1Y percentile follow the contract that was on the run each day, so the line steps at each roll by the difference between the two contracts (about 6bp for CDX IG and 38bp for Crossover on the Sep 2026 roll). The percentile is the midrank of the latest level among the year's daily levels, of the price for HY and EM.

## Today so far

Index prints are dated by their New York trade date, so a day is complete once New York's date has turned (midnight there, 04:00 or 05:00 UTC). Asia-session prints take their local day, so from New York's evening (about 00:00 UTC, and from Sunday evening) the latest day can be New York's tomorrow; it is so far too, and the day before it is complete. Until then the day's level rests on the prints so far: the board marks it `so far` beside its date, and `fn CDX` adds a Day column, such as `so far, 38 prints, last 08:09 UTC`, with the time of the latest print on the contract. iTraxx starts trading in London hours, so most of the day one index or another is still trading. While it does, 1D compares the last complete day with the one before it, and 1W and 1M run to that complete day too, never to the morning's few prints; the level and the 1Y rank stay today's. The app, `fn CDX`, its exports and `--json` (`partial`, `lastPrintAt`, `changeDate`) all say the same.

## History export

`gloom fn CDX XOVER` adds an index's daily levels, newest first, under the board: the date, the level, HY's and EM's spread equivalent, the prints behind it and the contract on the run that day, with today's row flagged `so far` while it trades. Name an index by its code (IG, HY, EM, MAIN, XOVER) or name; `CDX XOVER` in the app opens the board on that index. `--days` reaches back up to 1,100 days, as far as DTCC's files go, and `--csv --section 2` writes the history alone.

## Sovereigns and currencies

DTCC reports a sovereign by a reference bond, often under a generic description, so the country is read from the bond's CUSIP issuer prefix, its Markit RED entity code, its LEI or, failing those, the full sovereign name. A table of about thirty sovereigns maps them; state-owned companies filed under the sovereign category (Petrobras, Aramco, Bancolombia) stay out, and rows whose identifiers name different countries are dropped.

The currency move is the local currency against the dollar over the month to its latest completed daily close, positive when the local currency strengthened. Each end is the median of three daily closes, so one stray print on the feed makes no move, and the day still trading is left out. Currencies pegged to the dollar show their move too; Panama uses the dollar and shows none.
