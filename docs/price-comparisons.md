# Price comparisons

Normalized closing-price comparisons use the earliest and latest observations shared by every visible leg in the selected window. Daily, weekly, and monthly bars align on calendar dates: date-only provider bars retain their dates, timestamped market bars use the exchange calendar, and crypto uses UTC. Intraday bars require exact shared timestamps. Each leg retains its original source timestamps. A valid start requires a finite, nonzero price for every leg; a finite zero endpoint remains valid. There must be two shared dates. Missing observations are not carried, interpolated or rounded between exchanges.

This applies to two or more visible closing-price/OHLCV series on one panel, with the same percent/index-100 transform and requested period. Raw values, economic/capability series, mixed transformations/periods and observation-count-limited charts retain their existing meaning. Studies continue to calculate from raw buffered data; price studies use the comparison baseline for presentation.

Compared curves and legends stop at the shared endpoint. Streamed or financial-snapshot quotes supply metadata but cannot append to or rewrite a comparison's historical bars. This also prevents a one-leg quote from changing a weekly bar while the other leg remains historical. The source history cache is unchanged.

Headless reports and share metadata disclose the source dates and price-return basis. The chart shows an active warning when there is no usable comparison, without repeating the methodology above every plot. Each leg stays in its own listing currency; cash distributions and investor-currency conversion are not added. Source bar dates are not a claim that different exchanges close simultaneously, nor proof of complete corporate-action coverage. Weekly/monthly dates identify the provider's bars, which can represent a partial period.

Example: recorded JEPQ/QQQ daily history through September 10, 2026 starts in May 2022 versus September 2021. Their first shared observation is May 4, 2022. Using that date gives closing-price changes of 16.06% and 115.02%; independently starting QQQ in 2021 gives 88.32% over a different period. JEPQ's issuer reports separately calculated reinvested total returns in its [factsheet](https://am.jpmorgan.com/content/dam/jpm-am-aem/americas/us/en/literature/fact-sheet/etfs/FS-JEPQ.PDF).

`CMP --total-return` (the Total return toggle) reinvests each cash distribution at the close of its ex-date bar, at the bar holding the ex-date for weekly and monthly bars; none is reinvested before a leg's first bar or after its last.
The notice names the basis, on the price axis too. A leg whose distribution history is unreadable or in another currency stays a price return and says so.
It is a calculation from closes: no taxes, withholding or FX, and not an issuer's reported total return.

Explicit date-only windows include the final calendar day. Interval support is checked against the selected calendar dates, so September 15 to September 15 of the following year remains a one-year daily window when the provider supports one year. Timestamp windows retain their exact bounds. Replaying captured prices uses the same range rules.
