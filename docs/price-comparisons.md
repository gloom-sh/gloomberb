# Price comparisons

Normalized closing-price comparisons use the earliest and latest exact source timestamps shared by every visible leg in the selected window. A valid start requires a finite, nonzero price for every leg; a finite zero endpoint remains valid. There must be two shared dates. Missing observations are not carried, interpolated or rounded between exchanges.

This applies to two or more visible closing-price/OHLCV series on one panel, with the same percent/index-100 transform and requested period. Raw values, economic/capability series, mixed transformations/periods and observation-count-limited charts retain their existing meaning. Studies continue to calculate from raw buffered data; price studies use the comparison baseline for presentation.

Compared curves and legends stop at the shared endpoint. Streamed or financial-snapshot quotes supply metadata but cannot append to or rewrite a comparison's historical bars. This also prevents a one-leg quote from changing a weekly bar while the other leg remains historical. The source history cache is unchanged.

The chart body, headless report and share warnings disclose the source dates and price-return basis. Each leg stays in its own listing currency; cash distributions and investor-currency conversion are not added. Source bar dates are not a claim that different exchanges close simultaneously, nor proof of complete corporate-action coverage. Weekly/monthly dates identify the provider's bars, which can represent a partial period.

Example: recorded JEPQ/QQQ daily history through September 10, 2026 starts in May 2022 versus September 2021. Their first shared observation is May 4, 2022. Using that date gives closing-price changes of 16.06% and 115.02%; independently starting QQQ in 2021 gives 88.32% over a different period. JEPQ's issuer reports separately calculated reinvested total returns in its [factsheet](https://am.jpmorgan.com/content/dam/jpm-am-aem/americas/us/en/literature/fact-sheet/etfs/FS-JEPQ.PDF).
