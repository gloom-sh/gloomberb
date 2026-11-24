# Financial ratios

[User guide](usage.md) · [Research data conventions](research-data.md)

`FA` has ratio tabs beside the Income, Cash Flow and Balance Sheet statements, behind the **Ratios** segment of the Statement bar: Profitability, Leverage, Liquidity, Efficiency and Valuation. Keys `1` to `8` open the statements and then each ratio tab in that order. `gloom fn FA <ticker> --statement valuation` prints the same table with every input.

Each ratio opens (Enter, a click, or `e` for all) onto the inputs behind it. The second input starts with the operator that joins it, so the rows read as the formula: `Net Income`, then `÷ Avg Equity`. Inputs show the values as reported for the period, or the trailing year where marked `TTM`; the ratio applies any annualization.

## Periods

The ratio tabs use the Income statement's columns: the latest fiscal years, with a TTM column when the last four quarters run past the latest year, or the latest quarters. Headers are the same fiscal labels (`FY2026`, `Q4 FY26`, `TTM Q3 FY26`).

- **Averages.** Inputs marked `Avg` are the mean of the opening and closing balance. The opening balance is the prior fiscal year end for a year, the prior quarter end for a quarter, and the quarter end a year earlier for TTM. Both ends must come from the same line (total equity at both ends, or common equity at both), never one of each. A period with no opening balance sheet on file reads `needs prior period` for its averaged ratios: the oldest column on screen, a year whose prior year is missing from the statements, or a TTM column without the quarter a year earlier. `gloom fn GF <ticker> --period annual --periods 40` reads further back, one metric at a time.
- **Quarters.** A quarterly column reads a flow one of two ways:
  - **Trailing year.** Net debt / EBITDA, interest coverage, FCF / debt and, on Valuation, P/E, EV / EBITDA, P/S and FCF yield read the year, never one quarter times four. The input label says `TTM` (`÷ EBITDA TTM`) and shows the fiscal year when one ends with the quarter, otherwise the four quarters to it, summed.
  - **One quarter × 4.** ROE, ROA, ROIC and asset turnover annualize, and the label says `× 4` (`Net Income × 4`). Day counts spread a quarter's flow over 91.25 days and a year's over 365. Margins, a ratio of two flows over the same period, need no annualization.
  - **Example.** Newmont's quarter to June 2026 reads 94.98bn of enterprise value ÷ 16.04bn of EBITDA TTM = 5.92x, not one quarter's 3.64bn × 4 (6.53x).

## Missing and meaningless values

- `needs prior period`: an average whose opening balance sheet (the period before the column's) is not on file: the oldest column's, a year's whose prior year is missing, a TTM column's without the quarter a year earlier.
- `not reported`: an input line is not in the statements for that period. Apple, for example, has not tagged interest expense since FY2023, so its interest coverage reads `not reported` from FY2024. A missing line is never read as zero; a reported zero stays a value.
- `< 4 quarters`: a quarterly ratio on the trailing year has none to read, because fewer than four consecutive quarters are on file and no fiscal year ends with the quarter. A short history is never annualized.
- `no burn`: a [cash runway](#cash-runway) whose operating cash flow after capital expenditure is zero or positive.
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
| | ROIC ex Cash | NOPAT ÷ average (invested capital − cash and short-term investments) |
| | Gross, operating and net margin | Gross profit, operating income or net income ÷ revenue |
| Leverage | Net debt / EBITDA | (Total debt + lease liabilities − cash and short-term investments) ÷ EBITDA; leases as in [Leases](#leases) |
| | Debt / equity | Total debt ÷ equity, at the period end |
| | Interest coverage | EBIT (operating income) ÷ interest expense |
| | FCF / debt | Free cash flow ÷ total debt |
| Liquidity | Current ratio | Current assets ÷ current liabilities |
| | Quick ratio | (Cash and short-term investments + receivables) ÷ current liabilities |
| | Cash ratio | Cash and short-term investments ÷ current liabilities |
| | Runway, quarter burn | Cash and short-term investments ÷ (the quarter's operating cash outflow ÷ 3), in months; quarterly view only |
| | Runway, TTM burn | Cash and short-term investments ÷ (the trailing year's operating cash outflow ÷ 12), in months |
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
- **Equity** is stockholders' equity excluding minority interests; common equity stands in where the filer reports no total. A reported total of exactly zero beside non-zero common equity, as with some partnerships, is treated as not reported, so common equity stands in.
- **Total debt** is borrowings (current and long-term debt, commercial paper and other short-term borrowings) plus finance lease liabilities. Operating lease liabilities are never debt. For US filers the total is derived from the company's filings. Other listings keep the data vendor's total less its lease line, and only when that total is exactly long-term debt plus current debt plus the lease line; a total built any other way is kept as reported, so some non-US totals still include leases.
- **NOPAT** is operating income × (1 − tax provision ÷ pretax income). The rate is held between 0% and 100%, and is 0% when pretax income is not positive.
- **Invested capital** is equity plus total debt, finance leases included: the same equity and total debt the Leverage rows use, so ROIC and the Balance Sheet's Invested Capital row agree with them. Where either is missing, the data vendor's figure stands. Microsoft's FY2026 is 549.3bn: 442.4bn of equity plus 106.9bn of total debt, 66.6bn of it finance leases. Negative equity puts invested capital below total debt, and ROIC reads `N/M` when average invested capital is zero or negative.
- **ROIC ex Cash** takes cash and short-term investments out of invested capital at both ends, so a company that holds its cash in its equity and has no debt (Copart) reads the return on the capital its operations use: Copart's FY2026 is 14.6% on 9.14bn of average equity and 29.6% on 4.50bn without its cash. ROIC itself nets no cash. Both are GAAP: NOPAT is from operating income as reported, never an adjusted figure, and so are the margins.
- **Cash and short-term investments** falls back to cash alone when the filer does not report the total.
- **Receivables** are trade accounts receivable, or total receivables where trade is not reported; **payables** likewise. Apple's total receivables include vendor non-trade receivables, which is why DSO uses the trade line.
- **Free cash flow** is the reported figure, or operating cash flow plus (negative) capital expenditure.
- **EBITDA** is the statements' line; in SEC-derived periods it is operating income plus depreciation and amortization.
- **Enterprise value** is market cap + net debt: total debt, lease liabilities as in [Leases](#leases), less cash and short-term investments. Minority interest and preferred equity are not added.

## Cash flow

The Cash Flow statement is in one unit, the one most of its lines take (`USD bn` in its header), a line a thousandth of the rest to three decimals (`0.001`); no row names a unit of its own. A line that repeats one above it in every period is shown once: operating cash flow is the Operating line, and Purchase PPE goes when it equals CapEx in every year (it stays where they differ). Under Free Cash Flow, beside CapEx:

| Line | Formula |
|---|---|
| CapEx / Revenue | Capital expenditure ÷ revenue |
| Reinvestment Rate | (Capital expenditure + acquisitions − D&A) ÷ NOPAT; acquisitions count where the statement reports them, and NOPAT at or below zero reads `N/M` |

Visa's FY2026 reads 3.6% and 4.1%: 1.671bn of capex on 45.90bn of revenue, and 1.671bn plus 0.705bn of acquisitions less 1.403bn of D&A over 23.52bn of NOPAT.

## Leases

Net debt, and the enterprise value built on it, adds the balance sheet's lease liabilities to total debt when the company reports under IFRS or a similar standard. IFRS 16 puts every lessee lease on the balance sheet and reports EBITDA before lease costs, so net debt / EBITDA with the leases in is like for like. The row under Net Debt says so: `incl. leases` with the amount added. IAG's June 2026 balance sheet holds 6.96bn of borrowings, 6.91bn of leases and 9.18bn of cash: 4.69bn of net debt, where total debt alone gave -2.21bn.

- **US GAAP.** A company reporting under US GAAP keeps its operating leases out, whatever form it files: a 10-K, or a 20-F as Alibaba, PDD and JD do. Its finance leases are already in total debt, and its operating lease cost is in EBITDA. The row reads `excl. op. leases`, with the amount left out (Delta's 5.98bn in September 2026). The standard is the one Gloom Cloud reads from the company's latest annual report to the SEC; a company that files none with the SEC is read as IFRS.
- **A missing lease line.** When a listing's balance sheets report lease liabilities, a period without that line reads `not reported` for net debt and EV. It is not computed without leases beside periods that have them.
- **Totals that hold leases.** A data vendor's total that already holds the lease line (long-term debt + current debt + leases) is read as the borrowings beside it, so the leases count once.
- **No lease line anywhere.** Net debt is total debt less cash, with no row about leases.

Gloom Cloud's check of the provider's enterprise value (`EV (provider) vs … computed`, and `EV unavailable` beside a figure far from it) bridges the same way and says `market cap + total debt + leases - cash` when it added them. Debt / equity and FCF / debt keep total debt alone.

## Cash runway

Liquidity's two runway rows say how many months available cash and short-term investments last at the rate the business used cash. Burn is the negative of operating cash flow after capital expenditure, using reported free cash flow when the component lines are missing. The quarter covers 3 months and the trailing year covers 12 (the fiscal year ending with the quarter, otherwise the four consecutive quarters ending there). The inputs show the monthly burn, so the rows read as the formula.

- **Both periods.** A quarter with a large payment can differ sharply from the trailing year. Neither estimate is a forecast. Values over 120 months display as `> 120 mo`; exports retain the underlying number.
- **What it leaves out.** Net income, debt repayments and financing do not determine burn. Cash flow after capital expenditure at or above zero reads `no burn` in Liquidity.
- **Missing lines.** Liquidity falls back to cash alone when no period reports a combined cash and short-term investments total. A period missing that total when the company reports it elsewhere reads `not reported`. The same applies when neither the components nor reported free cash flow are available.
- **An offering since.** The latest USD runway can add issuer net proceeds disclosed in definitive offering prospectuses (424B4 or 424B5) filed after the balance-sheet date. This is a pro forma estimate: it does not change reported cash or earlier-period runway. If the filing does not disclose issuer net proceeds, it adds nothing.
- **Elsewhere.** `ticker` and `DES` show runway only when the trailing year shows burn, or when that measure is unavailable and the latest quarter shows burn. An incomplete year does not establish trailing burn. Financial firms have no runway on any surface: their operating cash flow is not operating burn.

## Valuation at the period end

The Valuation tab prices each period at its own period end, not today:

- **Price** is the last daily close on or up to seven days before the period end; for TTM, the end of its last quarter. Weekly or monthly bars are never used, because their close can fall after the period end.
- **Market cap** is that close × period-end shares outstanding from the balance sheet, never weighted-average shares.
- **EPS.** A quarterly column's P/E divides by the trailing year's diluted EPS, the same figure the annual view's TTM column shows for that quarter end. It reads `not reported` when any of the four quarters has no EPS or an unresolved share basis.
- **Splits.** Closes are split-adjusted and statement EPS and share counts are on the current share basis, so a split since the period does not distort the multiple (NVIDIA's FY2023 reads 20.37 ÷ 0.174 = 117.0x).
- **Currency.** The close is converted to the reporting currency at the daily FX close on or before the period end. GBp converts to GBP without an FX rate. A period without a comparable close or a nearby FX rate reads `no price`.

Current multiples at today's price are in `DES` and `RV`; once the regular session is over they are measured at its close, never at an after-hours print.

`gloom shot FA <ticker> --statement valuation` captures the same daily closes back to the oldest column. It stops with the reason when they are missing, fail to load or end more than a week before the latest period end. The shot's JSON reports `usable: false` while any column reads `no price`, and for any ratio tab when every ratio is `not reported` or `N/M`, or when the rendered cells differ from the table the captured data gives.
