# Market valuation reference

`VAL` compares broad valuation and allocation measures with their loaded histories. Each detail retains its formula or input basis, available dollar levels, comparison dates, source link and current data status. The table's valuation zones are fixed application thresholds, not investment recommendations or forecasts.

## Source coverage and units

| Measure | Configured inputs and calculation | Interpretation and limits |
| --- | --- | --- |
| Buffett indicator | Intended dollar market capitalization / nominal GDP × 100. GDP is a quarterly, seasonally adjusted annual rate in USD billions. | Currently unavailable: the configured market history supplies index points, not monetary capitalization. [GDP metadata](https://fred.stlouisfed.org/series/GDP). |
| Tobin's Q | `NCBEILQ027S` / `TNWMVBSNNCB`: nonfinancial corporate equity liabilities divided by net worth. Both quarterly, end-of-period Z.1 series are in USD millions and are scaled to billions before calculation. | This implementation is an equity-to-net-worth proxy. Its line at 1 means equal equity and net-worth levels; it does not separately measure replacement cost. These sector aggregates should not be described as a listed-stock portfolio. [Equity metadata](https://fred.stlouisfed.org/series/NCBEILQ027S), [net-worth metadata](https://fred.stlouisfed.org/series/TNWMVBSNNCB). |
| Shiller CAPE | The source's monthly `cape` column, based on price and ten-year average real earnings. | Loaded directly; the app does not recompute earnings or substitute total-return CAPE. Changes in payout policy can affect historical comparability. [Shiller data](https://shillerdata.com/). |
| Excess CAPE yield | The source's monthly `excessCapeYield` column, multiplied by 100 to display percentage points. | The definition is inverse CAPE minus the real ten-year yield. A larger spread has the cheaper direction in the table. The app does not reconstruct the real yield or equate it to a quoted TIPS yield. [Shiller data](https://shillerdata.com/), [authors' ECY definition, page 4](https://storage.googleapis.com/ni_library_storage/Research/CAPE_and_the_COVID_19_Pandemic_Effect.pdf). |
| S&P 500 dividend yield | Shiller annual dividends / price × 100, using the monthly dataset's `dividend` and `price` columns. | Annual dividend totals are interpolated to monthly observations in the source; this is not a forward declared-dividend yield. No dollar market-cap levels are shown. [Shiller data conventions](https://shillerdata.com/). |
| Household equity allocation | `BOGZ1FL153064486Q`, already expressed as a percentage. | Includes households and nonprofit organizations, and both direct and indirect corporate-equity holdings as a share of financial assets. It measures allocation, not a company's earnings multiple. [Source metadata](https://fred.stlouisfed.org/series/BOGZ1FL153064486Q). |
| Margin debt / GDP | `BOGZ1FL663067003Q` / nominal GDP × 100. The numerator is scaled from USD millions to billions. | The numerator includes broker/dealer customer margin loans **and other receivables**; it is not a pure margin-loan total. GDP is an annual rate, while receivables are a quarterly balance. [Receivables metadata](https://fred.stlouisfed.org/series/BOGZ1FL663067003Q). |
| Market cap / corporate profits | Intended dollar capitalization / `CPROFIT`, a quarterly series in USD billions at a seasonally adjusted annual rate. | Currently unavailable because monetary capitalization is missing. `CPROFIT` includes inventory valuation and capital consumption adjustments (IVA/CCAdj); the previous after-tax label did not match this series' metadata. [Profits metadata](https://fred.stlouisfed.org/series/CPROFIT). |
| Market cap / M2 | Intended dollar capitalization / `M2SL` × 100. M2 is a monthly, seasonally adjusted money-stock level in USD billions. | Currently unavailable because monetary capitalization is missing. This denominator is a stock, unlike annualized GDP or profits. [M2 metadata](https://fred.stlouisfed.org/series/M2SL). |

## Why three market-cap ratios are unavailable

The configured `^W5000` history contains Wilshire index closing levels. A quote currency of USD does not make an index level a dollar market capitalization. Wilshire's rule book explains that divisor adjustments change the conversion between index points and capitalization over time; a fixed one-billion-dollar multiplier is invalid. [Wilshire Index Rule Book, sections 2.2.1 and 6.2](https://assets-global.website-files.com/60f8038183eb84c40e8c14e9/612f894c20ad970151859d9d_FT%20Wilshire%205000%20Index%20Series.pdf).

VAL therefore leaves Buffett, cap/profits and cap/M2 unavailable, including when old cached index observations exist. Their charts, dollar levels, valuation zones and derived statistics are not produced. The six independent measures retain their own source coverage. Restoring these ratios requires a verified monetary-capitalization history with the intended universe, or a matching historical divisor series. An unrelated equity aggregate or a constant estimated conversion would change the measure.

## Dates and historical comparisons

Ratio histories align on numerator observation dates. The denominator is interpolated between observations and held flat after its latest observation; numerator dates before the first denominator observation are omitted. This is a historical alignment convention, not a reconstruction of what was publicly available on each past date. FRED data can be revised, and interpolated values can use later observations.

For monetary ratios, the `as of …Q…` label beside the denominator identifies its latest observation quarter. It is not a publication date or an unrevised data vintage. The pane footer identifies the selected measure's latest observation and flags data that exceed that measure's age threshold. Refresh time alone does not establish that the underlying observation is current.

`1Y ago` uses the last available observation on or before 365 days before the latest value. Mean, high, low, percentile and trend statistics use the entire loaded history. The selected range changes the displayed chart window; it does not redefine those statistics. “All-time” extrema refer to the available input history and retain their observation dates.

## Zones, yields and trends

The color bands use fixed thresholds for each measure. The `RICH` percentile and trend deviation orient values so a larger number means more expensive: lower yields and excess yields reverse the direction used by price ratios. This normalization supports comparison; the underlying measures retain different economic meanings.

Trend fits are log-linear for positive level measures and linear for excess CAPE yield, which can be zero or negative. The deviation is measured against the fitted history, not against an independently estimated fair value. Economic regimes, interest rates, sector composition, revisions and source coverage can all affect historical comparisons. Allocation and receivables measures describe investor positioning and balance sheets rather than directly pricing future cash flows.
