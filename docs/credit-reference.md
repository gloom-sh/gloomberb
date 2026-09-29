# Index and sovereign CDS reference

[Research data conventions](research-data.md) · [User guide](usage.md)

`CDX` shows the on-the-run 5Y CDX IG, CDX HY, CDX EM, iTraxx Main and iTraxx Crossover. `SOVR` (also `WCDS`) shows sovereign 5Y CDS ranked by the month's move, beside the local currency's month against the dollar. Both are daily levels built from the trades DTCC publicly disseminates: the CFTC credit files for indexes and the SEC credit files for sovereigns. Intraday files update the current day as they land, so today's level is partial until the day's file closes it. History starts with the oldest daily file DTCC still serves (about two years).

## Which prints count

A new trade counts only as an execution. Swaption exercises (which print at the strike), novations and clearing legs repeat an earlier trade's terms and are left out. A correction replaces the print it corrects, and an error record removes it. Later modifications and terminations do not change the price a trade was struck at, so they are ignored.

## Quotes and units

CDX IG, iTraxx Main and Crossover trade on spread and show in basis points. CDX HY and CDX EM trade on price and show as the price, as quoted. Moves and ranges stay in the same unit: basis points for the spread indexes, points of price for HY and EM. Wider spreads and lower prices are the adverse direction and show in red.

Reporters disagree on the unit of the same field. Percentage notation is mostly written as a decimal fraction (0.0058 for 58bp, 0.0107 for a price of 107) and sometimes as a true percentage (0.58, or 1.07 for 107); basis-point notation is read as basis points and monetary notation as a price. A print whose value fits no unit (a spread outside 0.5bp to 5,000bp, a price outside 20 to 200) is dropped.

## On the run

Indexes roll on a calendar: a new series starts on Mar 20 and Sep 20, five years and three months out (the Jun 20 or Dec 20 maturity). Not every family moves on the day. On roll day the old series still prints about as often as the new one, and CDX HY launches about a week later. So the new series becomes the one shown on the first day, on or after its scheduled roll, that it prints at least half as often as the old series. It stays until the next roll. Within a series, the version with the most prints that day (the index factor) is the one priced, so a version created by a default does not mix with the one before it.

Sovereign CDS follows the same Mar 20 and Sep 20 calendar, on the day.

## Daily level

An index's level is the median of the day's prints on the on-the-run contract and version, after dropping prints far from that median: more than the larger of 3bp and 15% for spreads, or of 1.5 points and 3% for prices. The band holds a stressed day's range and still drops a spread booked as a price, a coupon or a value off by a unit. A day with fewer than three prints stands only when a busier day on the same contract within two weeks agrees with it.

Sovereign levels start from the single-name CDS method (see [Single-name CDS](research-data.md#single-name-cds)): the upfront converted with the ISDA standard model, its side taken from reported spreads or from prints that allow only one reading. Sovereign prints that report a spread leave the upfront blank, so those spreads count as reported when they fall between 10bp and 1,000bp; outside that range the field holds something else, such as the upfront in points. Most sovereigns seldom report a spread, so a settled day also vouches for its neighbours within two weeks, one day after another, and a new contract starts from the levels of the one before it. Such a chained level picks an upfront's side only while it sits at least 20bp (or 20%) from the coupon: near the coupon the two readings are too close to tell apart, and a wrong guess would mirror the whole stretch. Each contract is followed on its own across a roll. A CDX EM trade booked leg by leg shows as the same upfront on five or more sovereigns the same day and is dropped. A day more than 15bp (or 25%) from the median of its contract's levels within a week either side rests on a mispriced print and is dropped. So is a stretch that meets the levels either side of it in a mirror image, where the two levels at each handover sum to about twice the coupon: it took its side from a bad print. Names trading close to their coupon that seldom report a spread can miss days; names without a level in the past month are left off the board.

## Moves and rank

The 1D, 1W and 1M moves are measured on one contract. In the weeks after a roll, when the new contract has no level back then, the move is chained through the previous contract from the first day both traded. When neither gives a baseline within a week of the start date, the move is left empty rather than mixing contracts.

The chart and the 1Y percentile follow the contract that was on the run each day, so the line steps at each roll by the difference between the two contracts (about 6bp for CDX IG and 38bp for Crossover on the Sep 2026 roll). The percentile is the midrank of the latest level among the year's daily levels, of the price for HY and EM.

## Sovereigns and currencies

DTCC reports a sovereign by a reference bond, often under a generic description, so the country is read from the bond's CUSIP issuer prefix, its Markit RED entity code, its LEI or, failing those, the full sovereign name. A table of about thirty sovereigns maps them; state-owned companies filed under the sovereign category (Petrobras, Aramco, Bancolombia) stay out, and rows whose identifiers name different countries are dropped.

The currency move is the local currency against the dollar over the month to its latest completed daily close, positive when the local currency strengthened. Each end is the median of three daily closes, so one stray print on the feed makes no move, and the day still trading is left out. Currencies pegged to the dollar show their move too; Panama uses the dollar and shows none.
