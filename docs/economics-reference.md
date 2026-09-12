# Economic statistics reference

[Research data conventions](research-data.md) · [User guide](usage.md)

ECST shows FRED observations transformed into the measures below. The pane keeps the source series ID and link, observation dates, units, historical comparisons and current data failures beside the values. Its filter also searches the statistic descriptions.

## Measurement conventions

`y/y` compares with the corresponding period one year earlier. `m/m` is the percentage change from the preceding month; payrolls use the absolute change instead. `q/q annualized` compounds the quarterly ratio to the fourth power, then expresses the change as a percentage. Monthly and quarterly transforms require the matching calendar period; missing observations are not replaced with a different period.

NSA means not seasonally adjusted. An annual-rate housing count is a flow stated at an annual rate. Effective fed funds is the monthly average effective overnight rate, while the FOMC sets a separate target range. The curve spread is 10Y minus 2Y; its zero reference marks inversion. The core-PCE 2% line is a reference: the Fed target applies to overall PCE inflation.

The latest observation date identifies the source period, not necessarily its release date. The previous value is the preceding available print. The 1Y comparison uses the matching calendar period for monthly and quarterly data and a nearby prior business observation for daily data.

## Series catalog

| Statistic | FRED series | Transform | Description |
| --- | --- | --- | --- |
| CPI | [CPIAUCNS](https://fred.stlouisfed.org/series/CPIAUCNS) | yoy | Headline consumer prices against a year earlier, not seasonally adjusted, including food and energy. |
| Core CPI | [CPILFENS](https://fred.stlouisfed.org/series/CPILFENS) | yoy | Consumer prices excluding food and energy against a year earlier, not seasonally adjusted. |
| PCE Prices | [PCEPI](https://fred.stlouisfed.org/series/PCEPI) | yoy | The price index for personal consumption, broader in scope than CPI. |
| Core PCE Prices | [PCEPILFE](https://fred.stlouisfed.org/series/PCEPILFE) | yoy | Excludes food and energy to track underlying PCE inflation. The Fed target applies to overall PCE inflation. |
| Producer Prices | [PPIFID](https://fred.stlouisfed.org/series/PPIFID) | yoy | Final-demand producer prices against a year earlier, not seasonally adjusted. |
| Unemployment Rate | [UNRATE](https://fred.stlouisfed.org/series/UNRATE) | level | Share of the labour force without work and looking for it. |
| Nonfarm Payrolls | [PAYEMS](https://fred.stlouisfed.org/series/PAYEMS) | change | Jobs added or lost last month. |
| Initial Jobless Claims | [ICSA](https://fred.stlouisfed.org/series/ICSA) | level | Weekly filings for unemployment benefits. |
| Job Openings | [JTSJOL](https://fred.stlouisfed.org/series/JTSJOL) | level | Unfilled positions employers report, a measure of labour demand. |
| Real GDP | [GDPC1](https://fred.stlouisfed.org/series/GDPC1) | qoq-annualized | Inflation-adjusted output, stated at the annual rate the quarter implies. |
| Industrial Production | [INDPRO](https://fred.stlouisfed.org/series/INDPRO) | yoy | Output of factories, mines and utilities against a year earlier. |
| Capacity Utilization | [TCU](https://fred.stlouisfed.org/series/TCU) | level | The share of industry's capacity in use, used as a gauge of slack. |
| Durable Goods Orders | [DGORDER](https://fred.stlouisfed.org/series/DGORDER) | mom | New orders for goods meant to last, used as an indicator of investment. |
| Factory Orders | [AMTMNO](https://fred.stlouisfed.org/series/AMTMNO) | mom | New orders across manufacturing, durable and not. |
| Retail Sales | [RSAFS](https://fred.stlouisfed.org/series/RSAFS) | yoy | Household spending at retailers, not adjusted for prices. |
| Core Retail Sales | [RSFSXMV](https://fred.stlouisfed.org/series/RSFSXMV) | yoy | Retail sales excluding motor vehicles. |
| Consumer Sentiment | [UMCSENT](https://fred.stlouisfed.org/series/UMCSENT) | level | Michigan's survey of households' views of their finances. |
| Personal Income | [PI](https://fred.stlouisfed.org/series/PI) | mom | What households received before tax, month on month. |
| Personal Spending | [PCE](https://fred.stlouisfed.org/series/PCE) | mom | Household spending, a component of GDP. |
| Housing Starts | [HOUST](https://fred.stlouisfed.org/series/HOUST) | level | Homes broken ground on, at an annual rate. |
| Building Permits | [PERMIT](https://fred.stlouisfed.org/series/PERMIT) | level | Permits issued for new housing. |
| New Home Sales | [HSN1F](https://fred.stlouisfed.org/series/HSN1F) | level | Newly built homes sold, at an annual rate. |
| Effective Federal Funds Rate | [FEDFUNDS](https://fred.stlouisfed.org/series/FEDFUNDS) | level | Monthly average effective overnight rate; the FOMC sets a separate target range. |
| 10-Year Treasury | [DGS10](https://fred.stlouisfed.org/series/DGS10) | level | The benchmark long rate that discounts almost everything else. |
| 2-Year Treasury | [DGS2](https://fred.stlouisfed.org/series/DGS2) | level | The short end, which tracks where policy is expected to go. |
| 10Y minus 2Y Spread | [T10Y2Y](https://fred.stlouisfed.org/series/T10Y2Y) | level | The 10-year yield minus the 2-year yield. Negative values indicate an inverted curve. |
| 10-Year Real Yield | [DFII10](https://fred.stlouisfed.org/series/DFII10) | level | The inflation-protected long rate. |
| M2 Money Stock | [M2SL](https://fred.stlouisfed.org/series/M2SL) | yoy | Growth in the M2 money stock. |
| Trade Balance | [BOPGSTB](https://fred.stlouisfed.org/series/BOPGSTB) | level | Goods and services exported less imported. |
| Nonfarm Productivity | [OPHNFB](https://fred.stlouisfed.org/series/OPHNFB) | qoq-annualized | Output per hour worked. |
| Unit Labor Costs | [ULCNFB](https://fred.stlouisfed.org/series/ULCNFB) | qoq-annualized | Labour cost per unit of output; pay growth relative to productivity. |
