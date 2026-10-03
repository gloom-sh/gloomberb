# Financial ratios

[User guide](usage.md) · [Research data conventions](research-data.md)

`FA` has ratio tabs beside the Income, Cash Flow and Balance Sheet statements, behind the **Ratios** segment of the Statement bar: Profitability, Leverage, Liquidity, Efficiency and Valuation. Keys `1` to `8` open the statements and then each ratio tab in that order. `gloomberb fn FA <ticker> --statement valuation` prints the same table with every input.

Each ratio opens (Enter, a click, or `e` for all) onto the inputs behind it. The second input starts with the operator that joins it, so the rows read as the formula: `Net Income`, then `÷ Avg Equity`. Inputs show the values as reported for the period; the ratio applies any annualization.

## Periods

The ratio tabs use the Income statement's columns: the latest fiscal years, with a TTM column when the last four quarters run past the latest year, or the latest quarters. Headers are the same fiscal labels (`FY2026`, `Q4 FY26`, `TTM Q3 FY26`).

- **Averages.** Inputs marked `Avg` are the mean of the opening and closing balance. The opening balance is the prior fiscal year end for a year, the prior quarter end for a quarter, and the quarter end a year earlier for TTM. Both ends must come from the same line (total equity at both ends, or common equity at both), never one of each. The oldest column on screen usually has no opening balance loaded, so its averaged ratios read `not reported`.
- **Quarters.** A quarterly column annualizes flows: the input label says `× 4` (`Net Income × 4`). Day counts spread a quarter's flow over 91.25 days and a year's over 365. Ratios of two flows over the same period (margins, interest coverage) need no annualization.

## Missing and meaningless values

- `not reported`: an input line is not in the statements for that period. Apple, for example, has not tagged interest expense since FY2023, so its interest coverage reads `not reported` from FY2024. A missing line is never read as zero; a reported zero stays a value.
- `N/M`: the denominator is zero or negative, where the ratio means nothing: negative equity under ROE or P/B, a loss under P/E, negative EBITDA or enterprise value under EV/EBITDA, no interest expense under coverage. ROE is also `N/M` on [near-zero equity](#roe-on-near-zero-equity).
- `no price`: there is no daily close in the week before the period end, or the quote currency differs from the reporting currency (the footer warning names both).

Returns, margins, FCF/debt and FCF yield take the sign colour; other ratios are neutral, since a negative net debt or cash conversion cycle is not bad news.

## ROE on near-zero equity

ROE reads `N/M` when its average equity says nothing about the capital behind the return:

- **Equity is zero or negative at either end of the year.** An average across a sign change can land anywhere near zero: AbbVie's equity went from 3.33bn to -3.27bn in FY2025, averaged 0.03bn, and the year read 15,367%. Boeing's FY2025 (from -3.91bn to 5.45bn, 289%) and Seagate's FY2026 (from -0.45bn to 2.17bn, 372%) are the same case.
- **ROE is beyond ±500%**, so average equity is under a fifth of the year's net income or loss: Colgate-Palmolive's FY2025, 2.13bn on 0.13bn, 1,603%. A quarterly column compares its annualized return.

The expanded rows still show Net Income and Avg Equity, and the Balance Sheet's Equity row shows both ends. The screener's FY ROE% uses the same rule: those names are empty and sort last.

The cap is on the return, not on equity as a share of total assets. Insurers, brokers and the mortgage agencies run equity of 1% to 4% of assets and earn ordinary returns (Freddie Mac FY2023 24.9% on equity of 1.3% of assets, MetLife FY2025 12.1% on 3.9%, Interactive Brokers FY2025 20.4% on 2.7%), while Home Depot's FY2023 1,162% sat on 1.7%. Checked against 145 US companies' statements in October 2026:

| | Examples |
|---|---|
| Now `N/M` | AbbVie FY2025 15,367%, Colgate FY2025 1,603% and FY2024 704%, Home Depot FY2023 1,162%, Seagate FY2026 372%, Boeing FY2025 289%, Coca-Cola Consolidated FY2025 168% (equity turned negative) |
| Keep their ROE | Home Depot FY2025 146% and FY2024 385%, Mastercard 211%, Apple 171%, Kimberly-Clark 173%, Clorox 286%, Cencora 144%, Microsoft 34%, banks, insurers, brokers, Fannie Mae and Freddie Mac |
| Already `N/M`, negative equity | Philip Morris, McDonald's, Starbucks, HP, Lowe's, Altria, AutoZone, Booking, Hilton |

## Definitions

| Tab | Ratio | Formula |
|---|---|---|
| Profitability | ROE | Net income ÷ average equity |
| | ROA | Net income ÷ average total assets |
| | ROIC | NOPAT ÷ average invested capital |
| | Gross, operating and net margin | Gross profit, operating income or net income ÷ revenue |
| Leverage | Net debt / EBITDA | (Total debt − cash and short-term investments) ÷ EBITDA |
| | Debt / equity | Total debt ÷ equity, at the period end |
| | Interest coverage | EBIT (operating income) ÷ interest expense |
| | FCF / debt | Free cash flow ÷ total debt |
| Liquidity | Current ratio | Current assets ÷ current liabilities |
| | Quick ratio | (Cash and short-term investments + receivables) ÷ current liabilities |
| | Cash ratio | Cash and short-term investments ÷ current liabilities |
| Efficiency | DSO | Average receivables ÷ revenue per day |
| | DIO | Average inventory ÷ cost of revenue (COGS) per day |
| | DPO | Average payables ÷ cost of revenue per day |
| | Cash conversion | DSO + DIO − DPO |
| | Asset turnover | Revenue ÷ average total assets |
| Valuation | P/E | Period-end close ÷ diluted EPS |
| | EV / EBITDA | Enterprise value ÷ EBITDA |
| | P/S | Market cap ÷ revenue |
| | P/B | Market cap ÷ equity |
| | FCF yield | Free cash flow ÷ market cap |

- **Net income** is attributable to the parent, the Income statement's Net Income line.
- **Equity** is stockholders' equity excluding minority interests; common equity stands in where the filer reports no total.
- **Total debt** is borrowings (current and long-term debt, commercial paper and other short-term borrowings) plus finance lease liabilities. Operating lease liabilities are never debt. For US filers the total is derived from the company's filings. Other listings keep the data vendor's total less its lease line, and only when that total is exactly long-term debt plus current debt plus the lease line; a total built any other way is kept as reported, so some non-US totals still include leases.
- **NOPAT** is operating income × (1 − tax provision ÷ pretax income). The rate is held between 0% and 100%, and is 0% when pretax income is not positive.
- **Invested capital** is the statements' figure (equity plus borrowings, without finance leases), or equity plus total debt where it is missing. With large finance leases the two differ: Microsoft's FY2026 total debt includes 66.6bn of finance leases beside 40.3bn of borrowings, and its invested capital leaves them out.
- **Cash and short-term investments** falls back to cash alone when the filer does not report the total.
- **Receivables** are trade accounts receivable, or total receivables where trade is not reported; **payables** likewise. Apple's total receivables include vendor non-trade receivables, which is why DSO uses the trade line.
- **Free cash flow** is the reported figure, or operating cash flow plus (negative) capital expenditure.
- **EBITDA** is the statements' line; in SEC-derived periods it is operating income plus depreciation and amortization.
- **Enterprise value** is market cap + total debt − cash and short-term investments. Minority interest and preferred equity are not added.

## Valuation at the period end

The Valuation tab prices each period at its own period end, not today:

- **Price** is the last daily close on or up to seven days before the period end; for TTM, the end of its last quarter. Weekly or monthly bars are never used, because their close can fall after the period end.
- **Market cap** is that close × period-end shares outstanding from the balance sheet, never weighted-average shares.
- **Splits.** Closes are split-adjusted and statement EPS and share counts are on the current share basis, so a split since the period does not distort the multiple (NVIDIA's FY2023 reads 20.37 ÷ 0.174 = 117.0x).
- **Currency.** The close must be in the reporting currency; GBp converts to GBP without an FX rate. A foreign listing of a company reporting in another currency reads `no price`.

Current multiples at today's price are in `DES` and `RV`.
