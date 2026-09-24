# Research data conventions

Historical-price table CSVs retain the selected listing, requested range, UTC date convention, loading or refresh-failure status, and active integrity warnings. Their numeric values use the provider history units. This table's history contract does not supply general currency or price-basis metadata; the export does not borrow those units from a current quote or a saved holding. Use a chart report when independently sourced listing metadata is needed.

Preset research ranges and return cutoffs use UTC dates and times. Changing the computer's timezone does not change the selected observations or correlation samples; source request timestamps still use the source's required exchange timezone.

Finite month/year ranges preserve the UTC time and clamp dates absent from the target month: March 31 minus one month reaches February 28, or February 29 in a leap year. Price returns use the latest observation on or before that cutoff; history beginning after it cannot supply the requested return.

[User guide](usage.md) · [Price comparisons](price-comparisons.md) · [Economic statistics](economics-reference.md) · [Market valuation](valuation-reference.md)

This reference describes how the terminal calculates and labels research data. Pane bodies show data, units, source dates and blocking failures; recurring methodology belongs here. Active data limitations appear as an amber warning indicator in the existing pane footer. Click it or press `!` in the focused pane to read the details; Escape or Close returns to the research view. The indicator disappears when its warnings clear. Headless reports and shared chart metadata retain source details and limitations.

Instrument search keeps broker contract definitions distinct when an underlying symbol represents several expiries, strikes or deliverables. A contract selected from search is retained in that research pane, its followers and saved layout; opening another contract does not reorder the shared ticker's broker definitions. Symbol-only lookups that match several saved contracts require a search selection. Contract-specific prices must come from that contract's data context, rather than the app's symbol-only cache. Broker contract panes and charts are retained in local layouts and exports; public symbol-only sharing is unavailable for them because a recipient's market source cannot be assumed to identify the same contract or broker account.

An explicitly selected public listing remains public even when the saved symbol also has broker contracts. The pane retains the selected result's name, venue, currency and instrument type separately from the shared ticker record. Public research shares identify the selected venue in the symbol; the recipient resolves public market data for that listing. A local layout can retain broker routing context, while a public URL does not carry it.

A quote needs a finite, positive observation timestamp that is no later than the current clock. Missing, invalid or future source times cannot establish a current price, chart update or quote-derived valuation. Receipt time does not replace source time. Retained observations keep their values and existing stale/error status until valid data arrives; historical statement-price observations remain separate.

Earnings estimates, corporate actions, analyst research and historical prices retain the last successful response when a refresh fails, with the failure shown in the footer. A failed refresh does not advance the retrieval time. Changing the ticker, venue or request range clears the previous response; explicit account or access rejection clears denied research. A successful empty response also replaces old data.

## Charts, comparisons, and correlations

See [chart history, retention and cadence](data-quality/chart-history.md) for source limits, calculation lookback, interval fallbacks and snapshot replay.

Standalone charts bound to follow a research pane retain their range, studies and comparison series when the selected instrument changes. Followed source series keep their identity across saved layouts, even when the selection temporarily matches a comparison. Deleting those followed sources leaves the remaining comparisons independent; it does not make a comparison follow instead. Fixed charts retain their authored instruments. An unresolved contract selection withholds the followed chart until a contract is selected, while preserving its saved settings.

Financial series use their selected date basis. When publication dates are missing, affected observations may use period-end dates; the chart warning identifies that fallback. A period-end date does not establish when the value became public. This limitation stays in shared chart metadata and headless output.

Bond history currently has no source-declared price convention. Charts retain its raw observations with unknown price units and do not append a current bond quote: that quote's per-unit or percent-of-par declaration does not establish the basis of a separate historical series. Overview price returns also use the historical observations without appending that quote. A numeric ratio between a quote and an old close cannot establish compatible units. Historical values and current source quotes remain separate; this does not add bond historical coverage or reconstruct yield.

Local chart snapshots retain the full selected instrument with its captured quote and history, including multiple contracts that share one public symbol. Reconstruction uses only observations captured for that exact contract; older public-symbol snapshots remain usable for public listings. A missing contract capture may be loaded from the corresponding market source, but another contract’s capture does not supply it.

Intraday chart captures retain the earlier observations used to calculate studies separately from the visible session. Replaying an authored chart window uses that captured calculation history without adding later prices. Older captures without this buffer can leave studies unavailable when they lack enough observations.

Historical price charts retain explicit listing currency and instrument type independently of a current quote. A rejected stale quote can supply those static facts, with its original source timestamp and stale flag in exported `quoteMetadata`; it cannot add a price observation or daily change. Snapshot reloads retain those facts without a live lookup. When optional enrichment supplies a missing field, `fieldSources` preserves that field's separate provenance. Missing or mismatched metadata remains unknown; no currency, FX conversion, or share/contract basis is inferred from a price's magnitude.

Market series build their forming bar from streamed quotes: each quote extends the bar's high, low and close, a new bar opens at its boundary stamped at the bar open like source bars, and volume adds the change in the session's cumulative volume, which starts from zero at a new session. Extended-hours prints do not form intraday bars. Shortly after each boundary the recent window is requested so formed bars settle to the source's version; a request that changes nothing waits twice as long before the next, up to ten minutes, and broker-linked instruments ask at most every two minutes. A chart covered by other windows stops building bars and catches up from the stored quotes when it is uncovered.

Normalized price charts show closing-price returns in each listing's currency. They exclude cash distributions, reinvestment, and FX conversion. They are not total-return or investor-currency performance charts.

Overview, ticker reports and AI ticker context require dated prices covering each fixed return horizon. A newly listed fund's since-inception change cannot stand in for a one-year or three-year return. These outputs recalculate from available observations rather than trusting undated summary percentages in an older cache. A covered, unchanged price has a zero return; insufficient history remains unavailable. Year boundaries use calendar years, including leap years.

Fund overview does not currently model expense ratios, NAV premiums or discounts, fund domicile, or distribution and hedging share-class policies. Listing currency is not fund base currency or hedge policy. Dividend cash yield is separate from SEC yield and total return; see [Dividends](#dividends-and-sectors).

Daily, weekly, and monthly comparisons use shared calendar dates, with each market retaining its source timestamps. Intraday comparisons require exact shared timestamps. Exchange closing times may differ; weekly and monthly bars can cover a partial period. See [comparison alignment and baselines](price-comparisons.md).

Correlation and relationship views calculate close-to-close returns between shared observations. They request daily bars regardless of chart preset resolution and clip buffered history to the selected range. Missing dates are not filled to manufacture a sample. Returns use local prices without cash distributions or currency conversion; different exchanges can close at different times. Correlation requires enough shared returns and nonzero variance.

Relationship graph controls stay in the footer: `t` cycles the time range, `p` cycles the rolling observation window, `c` toggles correlation, and `f` toggles the fit line. Each action is clickable and shows its current state. In both correlation views, `r` refreshes the selected histories. A failed refresh retains the last complete result with its original retrieval time behind the existing warning indicator; a new relationship pair or range cannot inherit that result. A rolling correlation requires the entire selected observation window and nonzero variance in that window; an older valid correlation does not replace a missing latest value. Headless results retain these limitations and the price-return basis. In narrow panes, `+` means enabled and `−` means disabled.

Dated missing closing prices remain gaps through history caching and chart extraction, including responses with no usable prices. An alternate source can recover a gap at the same reported timestamp; unresolved dates remain gaps. Missing prices do not establish usable coverage or advance price freshness. An explicit finite zero or negative source price is retained as reported; individual calculations apply their own eligibility rules.

Contradictory OHLC bars are unavailable rather than silently repaired. Charts leave gaps and dependent risk calculations can be unavailable. These are current data problems and remain visible in the terminal.

Chart controls: select ranges and intervals above the plot; click a legend entry to hide or restore a series; use **+ add series** to add one. In a narrow legend, scroll over the row or use `[` / `]` to reveal each series; Space toggles the selected series. The existing footer offers **Series**, **Indicators**, **Formulas**, and **Share**, also available with `s`, `i`, `f`, and `y`. `t` opens the interval picker. Sharing publishes a chart snapshot; pane sharing is available from the pane menu.

## Financial statements and valuation

Statements are the latest available source snapshots and may include restatements. Historical as-of values are not reconstructed. A period end identifies the reporting period, not necessarily when every metric became public.

Extended SEC history includes filed basic and diluted weighted-average share counts, distinct from shares outstanding at a point in time. Quarterly counts use reported quarters, not year-to-date averages. Counts requiring an unresolved or converted split basis are withheld from the SEC projection, as are issuer-wide denominators for ambiguous share-class listings; they are not inferred from EPS or multiplied by a split ratio.

The SEC projection also carries cash, cash plus short-term investments, depreciation and amortization, long-term and current debt, and short-term borrowings. EBITDA is operating income plus D&A, not a normalized figure. Total debt adds the current leg to the noncurrent one, except when a filer only tags the bare `LongTermDebt` concept, which already includes current maturities; commercial paper is added only beside the narrower current-maturities concept, never beside `DebtCurrent`. Cash-flow style concepts (operating cash flow, capital expenditure, D&A) are filed year-to-date in 10-Qs, so consecutive spans sharing a fiscal-year start are differenced into discrete quarters: Q2 is six months minus Q1, Q4 is the full year minus nine months. A directly tagged quarter always wins, a differenced quarter becomes available with the later of its two filings, and a restatement between those filings lands in the residual quarter. Income statement fields are not differenced.

Financial charts do not reconstruct missing Q4 EPS or weighted-average shares from annual and earlier-quarter values. Annual EPS is calculated independently, and weighted share counts depend on period lengths, share changes and dilution rules. Subtracting reported quarterly EPS or treating four quarters as equal weights can disagree with the issuer's Q4 disclosure. Reported Q4 values retain their own amounts and dates; missing per-share fields remain unavailable while other eligible flow and closing-balance fields can still be shown.

Common-stockholder income is also kept as reported: annual participating-security allocations can differ from the sum of quarterly allocations, so annual-minus-quarter subtraction cannot establish a missing Q4 common-income amount. TTM sums four reported common-income amounts; it does not force that sum to equal the separately reported annual figure. Incomplete common-income coverage keeps the earnings-per-share fallback unavailable even when parent income is complete.

Financial table headers retain reporting currencies and date-source markers: **P** means a provider period date, which may be approximate; **S** means a SEC-corroborated fiscal date. Filing evidence identifies the period without establishing a publication date for every metric. Mixed or missing reporting currencies are not silently converted.

The table's TTM column identifies the ending quarter, including when quarterly coverage lags the latest annual report. Its JSON export retains the four source periods and their date evidence. Derived field availability requires every input used for that field; opening cash follows the first quarter and closing balances follow the last. Filing dates do not fill missing publication dates for unrelated fields.

Monetary growth requires matching known reporting currencies. A source-wide reporting currency can fill missing row metadata only when the statement history does not contradict it; headers and exports use the same qualification, including periods outside the selected table. Each row's own reported currency takes precedence. Share-count growth remains comparable across a reporting-currency change; monetary values remain visible without a growth estimate when units are unknown or incompatible. `FA --period annual` and `FA --period quarterly` reports keep the requested coverage and report it unavailable instead of substituting the other period. Interactive tabs select and visibly identify the available period.

Overview and ticker-report monetary fundamentals show **(ccy?)** when their aggregate currency is missing. The reported amounts remain unchanged; neither the listing currency nor statement currency establishes their units. Explicit minor units such as GBp remain attached to the original amounts, including EPS. Ticker reports also label statement amounts with each row's reporting currency. Source-wide statement currency fills missing row units only when the annual and quarterly histories do not contradict it. Share counts remain unitless counts; report JSON preserves the original numbers and currency metadata.

Reported EPS keeps two decimal places for ordinary amounts and up to four significant digits below one reported currency unit. Values smaller than 0.0001 use scientific notation so small profits and losses remain visible in narrow financial cells. Overview, financial tables, their exports and ticker reports share this precision; raw structured values remain unchanged. This is display precision, not an estimate of the source's measurement accuracy.

Chart-derived P/E, price/sales, EV/sales, EV/EBITDA and price/free-cash-flow require compatible price and statement currencies. A statement's own currency takes precedence; aggregate reporting currency fills missing row metadata only when the other statements do not contradict it. Explicit minor units such as GBp/GBX convert to GBP without an FX assumption. Foreign or unknown currency pairs remain unavailable with a chart and export warning. Separately converted summary fundamentals do not establish historical statement units, and this conversion does not change provider share or depositary-receipt bases.

These derived multiples omit the Current observation when its quote is explicitly stale or has an invalid price or timestamp; valid historical ratios remain available. Historical calculations select the latest source price at or before the statement's availability date, then validate it. An invalid selected price leaves a gap instead of borrowing an older close. Contradictory OHLC values and rejected quote inputs remain in export diagnostics, and affected exports are marked incomplete. A quote's regular-session high/low does not constrain a valid after-hours price.

Current multiples use the latest available reporting period before evaluating the ratio. A loss, missing denominator, or incompatible currency cannot substitute an older profitable period. Automatic period selection uses TTM input coverage rather than whether the resulting ratio is meaningful; known nonpositive TTM earnings do not trigger an annual fallback. Valid historical ratios retain their original reporting dates.

Financial charts retain known reporting periods as gaps when a metric is missing or a ratio is unavailable. An incomplete TTM window also leaves a gap until four compatible quarters are available again. Lines break across these gaps, and observation limits count usable values while retaining intervening and trailing gaps. A real zero remains a value. Entirely absent fiscal periods are not reconstructed. An explicit latest gap leaves the idle legend unavailable; selecting an earlier observation still shows its value. Price markers likewise cannot replace a missing latest bar with an older close.

SEC EPS uses corroborated split-adjusted share bases. Unverified bases are unavailable. Nonpositive P/E values display as **N/M** and are excluded from meaningful P/E rankings.

Portfolio columns and the `DES` overview reprice market cap, trailing P/E, forward P/E and dividend yield from the live price, using the per-share figure served beside each statistic: shares outstanding, EPS, forward EPS and the annual dividend per share, in the listing's major currency unit. A figure is used only when the statistics block is in the quote's currency and the stored value implies a price within a factor of 1.5 of the current one; a share count must reproduce the stored market cap at a price the listing traded at, within 0.5%. Otherwise, and for zero or negative EPS, the stored value is shown. A per-share figure stays paired with the multiple or yield it was served with, so one withdrawn by the server is never taken from an older cached response.

### Forward P/E history

No source serves the consensus as it stood on an arbitrary past day. The `forwardPE` chart field assembles its history from three legs, each named in the point's period label. At each earnings report date, the price is divided by the sum of the next four quarters' pre-report consensus (the estimate each quarter carried at its own report). This is a final-vintage next-twelve-months figure: later revisions are already in it, so it is not what analysts expected on that day. Once the cloud has observed a listing, its daily consensus observations continue the series: the current and next fiscal-year EPS blended by the fraction of the current year still ahead. Today's consensus, blended the same way against the live quote, is the Current point. The provider's own forward P/E is shown only when no estimate history exists. PEG remains a single provider snapshot.

`realizedNtmPE` divides the same report-date prices by the EPS actually reported in the following four quarters. It ends four quarters before the latest report and is hindsight, kept apart from the forward series. Both fields require the estimate and price currencies to match, and an NTM sum at or below zero leaves a gap.

Chart-derived P/E preserves finite reported diluted EPS, including zero. When it is absent or unusable, the fallback divides reported common-shareholder income by the first positive share count available: diluted average shares, basic average shares, ordinary shares, then issued shares. Aggregate net income is used only when common income is unavailable. This is a derived income-per-selected-share estimate, not reconstructed reported diluted EPS: the source may omit convertible-claim numerator adjustments or a compatible depositary-receipt basis. The app does not guess those adjustments or deduct preferred/minority claims a second time. Reported EPS and the financial-statement rows remain unchanged.

TTM fallback income requires four complete quarters of one numerator field; partial common-income coverage withholds the fallback even if aggregate income is complete. When quarters report weighted-average share counts, the fallback also needs one such share field across all four quarters: a missing Q4 denominator cannot become a year-end ordinary or issued-share snapshot. Those snapshots remain available for capitalization estimates. Complete reported EPS still takes precedence. TTM EPS sums four reported quarterly values, while TTM average shares use the arithmetic mean of four reported quarterly averages; these approximations do not reconstruct independently calculated annual EPS or a daily weighted annual denominator. Availability follows the selected income and share fields, including every quarterly input used in a derived value.

Market capitalization can come from a financial snapshot when a current quote does not supply it. Its retrieval time is not its valuation date. Source and freshness details remain attached to the affected value; market-cap comparisons require a valid currency conversion.

Relative Valuation excludes explicitly stale quote prices, changes, and quote market caps from comparisons. Its exports retain the original quote, source timestamp and stale status, and identify incomplete output. Separately reported fundamentals and fallback market caps retain their own source and retrieval time; these are not dated by the rejected quote.

Bank capital metrics and REIT FFO/AFFO depend on source coverage. Operating cash flow is not a substitute for FFO/AFFO. Missing measures are available through the financial view’s warning indicator.

Relative valuation retains stale fundamentals for inspection and marks them through the existing warning indicator, independently of quote freshness. Its CSV export includes quote observation time and fundamentals source, retrieval time, and stale status. Structured reports preserve the same provenance and report incomplete freshness until the source recovers. Retrieval time does not establish a ratio's valuation date.

The current overview and peer table do not provide P/B, P/tangible book, CET1, or FFO/AFFO multiples. Financial-statement common equity and ordinary shares are dated balance-sheet inputs; weighted-average EPS shares belong to an earnings period and cannot replace period-end shares in a book-value calculation. A provider's tangible-book amount may differ from the bank's reported tangible common equity because of its adjustment policy. Compare issuer definitions and periods before combining these values. REIT GAAP P/E and generic cash-flow yield do not establish FFO/AFFO valuation or distribution coverage.

Confirmed quarterly observations that conflict with issuer filings are withdrawn through caches, statement merges and chart completion. Structured reports retain the withdrawal identifiers; a corrected observation can restore the field. See [the source comparison and limits](data-quality/quarterly-statement-revisions.md).

### SEC income attribution

SEC `NetIncomeLoss` supplies parent-attributable net income. `ProfitLoss` is shown separately as **Income incl. NCI**, and `NetIncomeLossAvailableToCommonStockholdersBasic` supplies **Income Common**. These measures are not interchangeable. A period with SEC income coverage retains its concept, unit, accession, start/end dates and filing date per field in structured financial exports.

Missing income concepts in those periods remain unavailable through provider/cache merges and derived fourth quarters. Consolidated income is not substituted for parent income. When common income is explicitly unavailable, parent income is not used to estimate earnings per common share or P/E; independently reported EPS remains usable. Income revisions use their own filing evidence, separately from other fields on the same row. Undated or generic vendor income does not establish an SEC attribution basis.

This separation does not resolve cross-filing accounting revisions or justify annual-minus-quarter arithmetic for other fields. Latest source data can include restatements; historical publication-time vintages are not reconstructed.

## Insider filings

INS retains Form 4 and Form 4/A disclosures separately, with their filing accession, source filing date, transaction dates, reporting owners and explanations. An amendment is labeled in the list; opening it retains its declared original filing date, footnotes and remarks. The existing filing action opens the SEC source. Reports preserve those fields and the transaction's footnote references.

[SEC Form 4, General Instruction 9](https://www.sec.gov/files/form4.pdf) permits amendments that add lines, correct particular lines or explain other changes. Unchanged original lines need not be repeated. The original filing date and owner CIKs can narrow the potentially affected filings, but do not identify transaction lines to replace. INS therefore keeps the disclosures as filed without inventing replacement or additive transactions. Affected security/side totals are unavailable; independent filings remain usable. Missing amendment identity broadens the uncertain scope. Unknown prices remain unknown, and the 90-day summary still covers only loaded non-derivative purchases and sales.

Amendment status uses the existing footer. Headless reports retain the candidate original accessions and mark affected output incomplete, including an amendment that contains explanations without transaction lines. Owner filtering preserves amendment context for the selected owner's original filings. The loaded window is limited; this is disclosure history, not a reconstructed position ledger or a guarantee that every later amendment has been loaded.

## Institutional holdings

HDS lists each holder's shares as of its reporting period. Mkt value is those shares at the latest price, so it differs from the value reported in the 13F filing, which is priced at the period end. The 13F pane shows the reported value.

For 13F option positions, reported values and shares refer to the underlying security. The 13F percentage is the share of reported value, not an option premium or portfolio delta. The position type remains identified in the holdings table, and exports retain this value basis.

Congress research uses House Clerk and Senate eFD periodic transaction reports,
merged into one index ordered by filing date. Ticker searches
filter the trades extracted from each filing window, not the filing index itself.
An empty window therefore does not mean that the ticker has no disclosures in
that year. The Congress tab and `CG` keep the next window available, and earlier
years are requested explicitly. Pending document processing and failed source
reads are reported in the footer warning and in structured pagination metadata.

Incomplete filing coverage and unreconciled amendments appear in the pane’s warning indicator; open it to inspect the affected reporting periods and filings.

## Treasury auctions

AUCT dates are auction dates, not issue or maturity dates. Term sorting uses every component of the published term, including reopening months; nominal day equivalents only order those labels and do not calculate remaining maturity or settlement cash flows. Unavailable metrics and unrecognized terms sort after known values in either direction. A published zero remains zero.

The rate column currently exposes bill investment rates and note/bond/TIPS high yields in percentage points. Bill investment rates differ from bill discount rates; TIPS yields are real yields. FRN auction discount margins, fixed spreads, and issue/maturity dates are not currently loaded, so AUCT does not provide an FRN coupon or a settlement cash-flow forecast. Treasury distinguishes these fields in its [auction overview](https://treasurydirect.gov/auctions/) and [FRN description](https://treasurydirect.gov/marketable-securities/floating-rate-notes/). Prices are quoted per $100 principal. Indirect percentage is accepted indirect dollars divided by total accepted dollars, not the share of competitive awards alone.

All response pages must declare the same positive integer page count and load successfully before the board replaces cached history. Missing, invalid, or changing page counts, malformed or missing pages, invalid records, or more than five declared pages fail the refresh; the last validated board retains its original retrieval time and the active failure appears in the footer and headless errors. A headless report with a failed refresh is incomplete even when retained rows remain usable. A successful refresh clears that failure. Previously cached boards are invalidated once because their pagination completeness cannot be established. This cache validation does not certify that the provider reported every auction or support future rate forecasts.

## Treasury curve

`WIRP` and `FFIP` open the same US rate-path pane. Gloom Cloud assembles dated Yahoo Fed funds (`ZQ`) and quarterly SOFR (`SR3`) futures with FRED effective Fed funds and target bounds. The app makes one Cloud request. A missing endpoint or unavailable contract leaves an explicit unavailable state; a failed refresh retains the last response with its original source dates and a stale warning.

The Fed funds quote implies the month's average EFFR as `100 - price`. The first complete following month without another scheduled decision establishes a post-meeting rate; otherwise calendar-day weighting isolates the rate after the meeting. A current-month decision requires the realized EFFR observations before it. Missing anchor contracts or inconsistent dates leave that meeting unavailable. SOFR futures describe a quarterly compounded rate and do not supply FOMC probabilities. Rates are percentages; changes are basis points. Futures prices include risk premia and do not establish a forecast.

The probability heatmap is a two-outcome model on adjacent 25bp target midpoints, conditional on a constant spread between EFFR and the target midpoint. It is not CME FedWatch or a distribution reconstructed from options. Row probabilities sum to one only where the model is available. Missing probabilities remain unknown. The table's changes compare the implied EFFR with today's EFFR, not the previous meeting. Select a meeting to inspect its source availability through the footer warning.

One-year percentiles use the dated history of the same contract or rate, with midpoint ranks for ties and explicit sample counts. A contract with insufficient history has no one-year percentile. Ghost paths use the same future meeting dates with contract observations available at the requested earlier date; they do not fabricate expired contract histories. Missing nodes break the curve. The chart draws the one-week and one-month ghosts; the one-year path belongs to a different rate regime and would compress the current curve and target band, so its context is carried by the one-year percentiles and the slope readout instead. Year-end SEP medians are plotted as points on the meeting axis at December 31. The current target bounds retain their own FRED dates. Fed Summary of Economic Projections medians are annual target-rate projections published on the displayed date, not market-implied probabilities. The longer-run median has no maturity and appears only in Projections.

Checks on September 22, 2026 found dated daily histories for Yahoo monthly `ZQ` contracts. Quarterly `SR3` contracts resolved but supplied only one observation, so historical comparisons and one-year ranks are unavailable. The FOMC calendar and SEP are maintained source snapshots with their source URLs, verification date and coverage in structured reports. Tentative future meeting dates may change; schedule coverage is never extended by guessing. These limitations appear in the pane's existing warning disclosure and exported metadata.

GC plots constant-maturity Treasury yields against elapsed maturity, with month/year axis and cursor labels. The table retains each tenor's published observation date. The 10Y−2Y spread is measured in basis points; a negative value indicates inversion. Missing tenors remain unavailable, and a curve requires matching dates.

Use the existing Date footer action (`d`) to enter an as-of date, then Enter or View to submit. Current (`c`) returns to the latest published curve. A holiday or weekend request uses the latest preceding published session within the lookup window; the requested date and observation date remain distinct. Refresh time is not the observation date. Historical series metadata, when available, must identify the requested DGS tenor in daily percent units. A metadata outage may retain observations under the fixed requested-series contract, but contradictory or unidentified returned metadata cannot establish that tenor. Invalid calendar dates never establish an observation or a spread; independently valid observations remain usable. Source failures stay distinct from a successful response with no observations in the ten-day window, using the existing error status and headless errors. Zero and negative yields remain numeric. The latest curve can retain a reported yield with an invalid source date only as undated, with a source error; it cannot establish the curve date or a dated spread.

## Money markets

`BTMM` makes one Gloom Cloud request for FRED funding rates, Treasury bills and liquidity. SOFR, EFFR, IORB and OBFR are published daily rates. The bill tenors are DTB4WK, DTB3, DTB6 and DTB1YR, all secondary-market discount yields, not investment yields or the constant-maturity yields in `GC`. Bill curves require a shared observation date across all four tenors. The 1Y minus 4W slope is in basis points. One-week, one-month and one-year comparisons use the latest shared date at or before the requested date, within seven days, and retain their actual source dates. Missing tenors cannot borrow a different date to complete a curve.

Liquidity values use USD billions. WALCL and WDTGAL are Wednesday levels; WRESBAL is a weekly average ending Wednesday and is not a Wednesday closing balance. RRPONTSYD is daily overnight reverse-repurchase usage. Net liquidity is the proxy `WALCL - WDTGAL - RRPONTSYD`, requiring identical observation dates for all three components. It is not bank reserves or an asset-return forecast. The Treasury account uses the Wednesday WDTGAL series, not the weekly-average WTREGEN series.

Each board shows the latest available value, source date, one-year percentile and sparkline. Change is versus the previous published observation, identified in the detail, not necessarily the preceding calendar day. One-year ranks use finite observations in the trailing twelve calendar months ending on that row's latest observation; ties receive midpoint ranks and fewer than twenty observations leave the percentile unavailable. These ranks compare that instrument with itself, and a thin sample does not establish a full year of coverage. The detail preserves sample count, range and exact window. Missing observations stay gaps in the history chart. The compact sparkline connects reported observations. Published histories can include revisions and do not reconstruct release-time vintages.

Cloud verifies series identity, units, frequency and seasonal adjustment before aggregating. Unknown or contradictory metadata leaves the source unavailable. Daily sources older than seven days and weekly sources older than twenty-one days are stale. The app caches for one hour, retains last good data after a refresh failure, and displays source failures through the existing warning disclosure. An absent endpoint has an explicit unavailable state. All twelve source series resolved during the September 22, 2026 source check; observations retain their individual publication cadence and dates. No database migration is required.

BTMM plots the latest bills curve with one-week and one-month comparisons. The one-year curve remains in tenor cursor values and the shared table fallback with its observation date; it does not set the chart axes. Current, weekly and monthly series have explicit theme colours. The board reserves space for its actual rows and gives remaining space to the chart.
## Bond calculator

YAS prices regular fixed-coupon bullet bonds per 100 face, redeemed at 100. Coupon dates are unadjusted and anchored backward from maturity. Annual, semiannual and quarterly frequencies use equal coupons of annual coupon percent divided by frequency. End-of-month scheduling is explicit; otherwise the maturity day is retained and clipped in short months. Payments on settlement are excluded. Odd first/last coupons, business-day adjustment, ex-coupon periods, call/put options, default recovery and inflation indexation are outside this calculator.

ACT/ACT ICMA uses actual elapsed days divided by the actual coupon-period days for accrual and the remaining first discount period. US 30/360 uses its February and day-31 adjustments, with a regular period of 360 divided by frequency; it is distinct from European 30E/360. On a coupon date, accrued interest is zero and the first future payment discounts by one full coupon period. Coupons discount at the periodic yield using fractional first periods. Clean price equals present value minus accrued interest; dirty price includes accrued interest. Yield is solved by a bracketed bisection and may be negative while its compounding base stays positive.

Macaulay duration is present-value-weighted payment time; modified duration divides it by one plus yield per coupon period. Convexity is the analytic second price derivative divided by dirty price. DV01 is dirty price times modified duration divided by 10,000, in price points per 100 face. Yield-shock rows reprice every payment exactly at each shifted yield; return is clean-price change divided by initial dirty price. These are parallel yield shifts at the same settlement, without carry or roll. Cash-flow present values sum to dirty price. Manual hypothetical bonds have no historical percentile sample, so no rank is invented; JSON reports the missing percentile and reason. Settlement is the valuation date on every view.

The optional Treasury comparison reuses GC's Gloom Cloud endpoint and its existing cache. It linearly interpolates Treasury par yields at the bond's remaining calendar maturity (actual days divided by 365.25), only between matching dated tenors, without extrapolation. Its observation date is shown separately from settlement. This is a nominal yield spread, not an option-adjusted or zero-curve Z-spread. Missing endpoint, malformed points, mixed bracketing dates and maturity outside the curve leave spread unavailable while retaining local calculations. A failed refresh retains the prior dated benchmark with the error visible. Observations can precede a manually entered settlement date; this does not represent a historical matched-settlement spread. Public production GC returned all ten dated tenors on September 22, 2026, with observations from September 18.

Math checks include the published Excel PRICE example (94.63436162), independent QuantLib 1.43 ACT/ACT ICMA references across leap-year and month-end schedules, price/yield round trips including negative yields, and finite-difference sensitivity checks. The reference package is not an application dependency.

## Central bank rates

`CBR`, `ECFC` and `CBRT` use one Gloom Cloud request for G20 policy observations. FRED supplies the US target bounds (DFEDTARL/DFEDTARU) and the ECB deposit facility rate (ECBDFR); official BIS central-bank policy-rate data supplies the other covered jurisdictions in one batch. The older OECD/FRED policy-rate series were discontinued and are not current inputs. BIS publishes daily observations weekly, so each row retains its actual date and calendar-day lag. US bounds must share a date and form a valid range. The board shows the range; its history and percentile use the midpoint, distinct from the effective Fed funds rate.

Policy instruments differ. China is the BIS one-year loan prime rate, not its seven-day reverse repo rate. The euro-area row covers France, Germany and Italy and represents euro-area policy within the EU; non-euro EU countries have separate policies. Argentina has had no adopted policy rate since July 10, 2025 according to BIS metadata, so its last historical 29% value is not carried forward. The African Union has no unified policy rate. These jurisdictions keep unavailable rows in exports rather than invented values; the board and its warning leave them out, and they do not make a report incomplete.

Last move compares the latest level with the preceding distinct observed rate, not yesterday's unchanged observation. Its date is the first source observation at the new level and need not be the announcement or effective date. A missing change within fetched history remains unknown. The one-year percentile uses daily observations in the twelve calendar months ending on that row's own latest date, midpoint ranks for ties, and a minimum of twenty observations. This measures time spent at historical levels, not a distribution of policy decisions. The detail retains sample count, range and window. Source gaps break the history chart; the compact sparkline connects reported observations. Published histories may contain revisions and do not reconstruct release-time vintages.

Cloud caches BIS for six hours and FRED for one hour with shared in-flight requests and independent stale fallback. BIS observations more than fourteen days old and FRED observations more than seven days old are stale; expired fallback data remains stale regardless of observation date. A refresh failure preserves the last usable response and its source dates with a warning. An absent endpoint is explicitly unavailable. The source check on September 22, 2026 found delayed India, Indonesia and South Korea observations; the board displays their real dates. Only the maintained, source-verified US FOMC schedule supplies next-meeting dates. Missing dates elsewhere do not mean that no meeting is scheduled. No migration is required.

## Debt maturities (DDIS)

DDIS uses Gloom Cloud's cached SEC EDGAR company facts. The backend selects annual 10-K or 20-F principal-maturity facts from one accession, fiscal period end and native currency. The chart represents relative fiscal buckets: the next twelve months, years two through five, and Thereafter. These are not calendar-year dates. Thereafter is open ended and supplies neither a maturity date nor a duration. No weighted average maturity or weighted coupon is inferred.

Principal total requires all six buckets. Reported zero amounts are retained; absent, negative or contradictory facts are unavailable. The next-three-years amount requires its first three buckets. Concentration ratios require a complete, positive total; they remain unavailable for incomplete or zero totals. These amounts describe reported principal obligations, not balance-sheet carrying debt or a forecast of refinancing needs. Schedule scope may include short-term borrowing and foreign-currency hedges. Native currencies are never converted or mixed.

Headline ranks use a ten-year window ending on the latest source period, with at least five comparable annual cohorts and at most one cohort per period end. Interest expense ranks require the same interest concept; cost ranks also require the same debt concepts. History displays this bounded window, while the headless response retains all source history. Each value's as-of is the fiscal period end. The filing date identifies when that observation became public; later collection does not make it current. Amendments can change historical facts, so this is not a point-in-time trading dataset.

Annual interest expense can include non-debt expenses depending on the reported concept, which the Filing tab exposes. A borrowing-cost accounting proxy is shown only when debt-only annual interest and explicit, matching opening and closing long-term and short-term balances are available. It is annual debt interest divided by average reported debt, multiplied by 100. It is not a weighted coupon, yield to maturity or a current refinancing rate. A missing proxy remains unavailable even when general annual interest expense exists.

Company facts do not cover every maturity disclosure: custom tags and unmapped IFRS statements can leave a partial schedule or no schedule. Current verified examples include USD schedules for MSFT and AAPL and a native EUR principal schedule for ASML. TSM's IFRS reporting is unsupported. Verified examples currently lack the evidence needed for the debt-only cost proxy. Source refresh failures preserve the last dated result with a warning; a missing Cloud endpoint has an explicit unavailable state.

## Portfolio analytics

P&L for manual portfolios covers current holdings. Manual portfolios have no cash-flow performance history; reconcile corporate actions through **PF → Set position**. Distributions are not automatically credited.

Enter the current quantity in **Shares** and the cost per share in **Avg Cost**, using the position's currency. Update quantity and cost yourself after splits or other corporate actions; these values are not automatically adjusted. **AP** can add a ticker to a portfolio without recording a position: leave Shares blank. **Set Portfolio Position** requires a quantity and cost.

Broker contracts without a canonical contract ID use their supplied definition, including local symbol, security type, currency, venue, expiry, right, strike, multiplier and trading class. Changing that definition requires its own quotes and history; an older symbol-only cache cannot establish their identity. Broker resync preserves the supplied definition for each position. Older positions without that identity retain a broker route only when their stored declarations match uniquely; resync establishes missing ownership. Independent issuer fields can still use public-symbol enrichment.

A missing position cost stays unavailable; it is not zero. Portfolio and ticker views use each lot’s known cost and usable current quote before falling back to that lot’s broker-reported snapshot. Mixed results retain both bases, and one unknown lot prevents a complete P&L total. A Broker P&L column uses snapshots; a Mixed P&L column includes both current calculations and snapshots. Broker snapshot profit does not acquire the live quote’s timestamp; position feeds without a profit timestamp leave it unknown. Missing cost or a zero total cost prevents a percentage return, even when absolute P&L is available. JSON/CSV exports retain the selected P&L basis and cost availability. Older stored zero costs cannot be distinguished from explicit zero: resync the broker position or correct a manual position to establish the intended cost.

Sector weights use gross position values and exclude cash. Fund constituents and ETF overlap are not available; funds are grouped separately. Missing position prices or FX prevent complete weights.

Sharpe and beta are estimates for a basket of current holdings and weights, rather than a reconstruction of historical account performance. They use price returns and exclude cash, fees, distributions and historical trades. Sharpe assumes a fixed 5% annual risk-free rate and 252 trading sessions per year; beta uses SPY as the benchmark. They require usable price histories for every nonzero holding. Each sample uses the same start and end dates for all holdings at fixed current weights; a newer listing shortens the common window instead of reallocating its missing weight. Dated missing or nonpositive closes break adjacent returns. Beta matches both interval endpoints with SPY, so a multi-session return is not paired with a one-session return sharing only its end date. The displayed dates and count identify the actual samples; absent dates across every source cannot establish an exchange calendar. A contradictory holding history suppresses the basket estimates. An invalid benchmark history suppresses beta independently of Sharpe.

Sharpe qualifies the whole sample against published sessions for every holding's requested listing venue. Both endpoints must be sessions with one source observation per date, and no trading session may lie between them. Source timestamps must consistently use midnight-UTC date labels, the same declared-venue wall-clock time on the labelled session date, or verified actual session-close times. This preserves exchange-open labels through DST and the verified regular 16:00/early 13:00 New York close convention, while rejecting sparse cross-midnight intraday observations. Mixed or unverified timestamp conventions remain unavailable. Actual-close schedule coverage is NYSE venues in 2025–2028 and Nasdaq in 2026; other timestamp conventions do not borrow those early-close dates. Legitimate weekend, holiday-reopening and early-close sessions remain in the sample; returns are never filtered to calendar weekdays or rescaled to guess a daily rate. Missing sessions and unsupported calendar coverage withhold Sharpe. Beta checks timestamp eligibility independently for both holdings and SPY, retaining valid endpoint-matched multi-session returns and unknown calendar years when their timestamp conventions are established. Nonmidnight SPY timestamps with no declared venue remain unverified. Routing venues such as SMART do not establish the listing calendar.

Published calendar coverage is NYSE/NYSE American/NYSE Arca and named NYSE National/Chicago/Texas venues for 2025–2028, and Nasdaq for 2025–2026, checked September 12, 2026. Sources are the [NYSE 2025–2027 announcement](https://ir.theice.com/press/news-details/2024/NYSE-Group-Announces-2025-2026-and-2027-Holiday-and-Early-Closings-Calendar/default.aspx), [NYSE 2026–2028 schedule](https://www.nyse.com/trade/hours-calendars), [NYSE Carter closure](https://ir.theice.com/press/news-details/2024/The-New-York-Stock-Exchange-Will-Close-Markets-on-January-9-to-Honor-the-Passing-of-Former-President-Jimmy-Carter-on-National-Day-of-Mourning/default.aspx), [Nasdaq 2025 table](https://www.nasdaq.com/docs/2025/01/06/2025holidayandtradinghours.pdf), [Nasdaq 2026 table](https://www.nasdaqtrader.com/Trader.aspx?id=Calendar), and [Nasdaq Carter closure](https://www.nasdaqtrader.com/TraderNews.aspx?id=ETA2024-87). The model retains this source basis and any rejected interval. Coverage includes the January 9, 2025 closure and does not invent a December 31, 2027 closure. It is a bounded published schedule, without a live exceptional-closure feed or inferred coverage for other venues and years.

The benchmark request explicitly identifies SPY on NYSE Arca in USD, ISIN US78462F1030, following the [issuer's listing table](https://www.ssga.com/us/en/individual/etfs/state-street-spdr-sp-500-etf-trust-spy) checked September 12, 2026. Beta qualifies timestamps on its actual matching sample only; an unrelated older observation outside that sample cannot invalidate an otherwise valid comparison. The model retains the benchmark identity, source timestamps, matching sample, and qualification results.

Broker account-value history includes deposits and withdrawals. Investment returns require cash-flow adjustments. Broker-reported return series may not specify their calculation method. Currency values and percentage returns retain distinct axis labels. Account-value currency comes only from the history source; portfolio/display currency settings do not convert that history or establish its currency. The chart preserves elapsed calendar time and known missing dates. A later row at the same timestamp replaces the earlier row, including withdrawn values; missing values break the line instead of joining observations across the gap. Missing observations and cached data remain identified in the UI.

Account summaries and Cash & Margin convert monetary totals only from the broker account's declared currency. Missing source currency or FX leaves those totals unavailable; missing cash is not a zero balance. PORT retains available account summaries and broker history after the last security position is sold. It does not derive a return from changes in account value or add cash-flow-adjusted return methods that the broker has not supplied.

## Dividends and sectors

Dividend cash yield excludes taxes and reinvestment. SEC yield, tax components, and future payments are not modeled. Forward yield is an estimate rather than a guaranteed distribution. Dividend amounts and reference prices must use compatible listing currencies and units.

`DVD` is a cash-history view, not a next-quarter cash-flow calendar. History rows use ex-dates, not the dates cash reaches an account. Recent cadence is inferred from those ex-dates; it does not establish an announced schedule. The ex-date row shows the next announced ex-date when the source reports one, and otherwise the last ex-date that has passed. A declared distribution whose amount the source has not published is not added to history. A source-reported upcoming payment date can appear as Next Pay, but is not linked to a projected amount. The provider-backed history supplies ex-dates only. Missing payment dates remain unavailable. Forward/share is a provider-indicated annual rate, not a forecast of the next distribution. No FX conversion, withholding, or net account income is calculated.

Dividend summary failures are reported independently of cash-history coverage. A failed summary request or invalid reported summary date leaves that information unavailable while preserving valid cash totals and independently reported summary fields. Invalid dates cannot become payment projections or break the report; their failure appears in the existing footer and structured report errors.

Cash events require their source's currency and units; a quote or separate summary cannot supply missing history units. Invalid or missing records make cash totals, growth, cadence, and the TTM chart unavailable while valid history rows remain visible with a failure status. A confirmed empty history still has zero trailing cash. An unavailable source does not establish zero cash. A separately reported forward rate can remain available when its own currency is known and compatible, even when chart history is unusable; an unknown chart-price denomination cannot supply its yield denominator. On an integrity failure during refresh, retained history rows keep their own units and retrieval time while current cash totals stay unavailable. A confirmed empty response clears those retained rows.

Dividend reference prices retain their own source timestamp, including Yahoo's regular-session price when a separate quote is unavailable. The footer prioritizes that timestamp and shows the separate history retrieval time when space permits; exports retain both. Stale prices and missing price timestamps remain explicit. Fetching cash history does not refresh the time of its reference price.

TTM cash/share sums reported cash with ex-dates within the trailing calendar year, counting one payment per period for a regular monthly, quarterly, semi-annual or annual cadence. When an ex-date falls a few days earlier in the year than its counterpart a year before, the older payment leaves the total on the new ex-date instead of being counted twice. When it falls later, the older payment stays in the total until the new one goes ex, for at most half a period and never more than 30 days past one year. Irregular cash uses the plain trailing-year window. The chart applies the same rule at each date using only payments known by then, holding each level between changes. Cash growth compares complete trailing-year windows; a positive baseline followed by no cash gives −100%, while a zero or incomplete baseline has no defined growth rate. Special distributions remain part of reported cash.

Sector and industry ETF returns are price returns in the listing currency, without reinvested distributions. Rankings use a shared ending session and calendar-month/year boundaries, using a prior close for holidays. Missing or inconsistent endpoints remain unavailable. A reported baseline still establishes the shared starting session when that ETF lacks an ending price; another ETF cannot use an older start because its peer becomes unavailable. A successful refresh does not make an old quote current. Live prices overlay the stored snapshot and rescale the 1M and 1Y returns from their baselines; before the open the board stays ranked on the completed session, and a fund the stream is not carrying falls back to a one-minute background reload.

## FX matrix

`r` refreshes the selected currencies, and automatic refresh follows the configured interval. `FXC` streams the USD legs and derives every cross from them; a streamed leg replaces the loaded rate only while its own observation is newer, and the reload relaxes only for legs the stream keeps current. Ordinary renders reuse cached rates. A refresh can still return the provider's cached observation; its source date and any stale or failure status remain visible.

One unit of the row currency buys the amount in the column currency. Indicative cross rates are calculated through USD legs, whose observation times can differ. Missing, stale, or unknown observation times appear as current status.

The base-currency axis remains visible during horizontal scrolling; partially covered values are shortened with an ellipsis. CSV export retains the full matrix and appends each currency's raw USD leg, observation time, retrieval time, source, and current status. Each cross uses its row's leg divided by its column's leg; same-currency cells are identity. Exported provenance belongs to the displayed rates, and unknown observation times remain blank rather than being replaced by retrieval time.

## Short interest

Short interest is outstanding short positions at each settlement date, not daily short-sale trading volume. FINRA supplies settlement history, average daily volume and days to cover. Yahoo is a fallback with current and prior settlement shares; its supplied current days-to-cover ratio and percentage of float remain attached to the current record.

An undated float cannot establish a historical settlement's denominator. Missing float percentages stay unavailable, including the prior settlement. Average daily volume is not reconstructed from Yahoo's reported ratio; FINRA's independently supplied volume remains available. Known zero values remain zero. The date column stays visible during horizontal scrolling, and exports retain every configured financial column.

## Credit spreads

CRD shows daily closing option-adjusted spreads for the ICE BofA US Corporate (US IG), US High Yield (US HY), and AAA, AA, A, and BBB US Corporate indices from FRED. Source percentages are converted to basis points; 1D is the change from the previous available observation. These are spreads, not bond yields.

Each series keeps its own observation date. A shared date appears in the footer when all displayed observations agree; otherwise an AS OF column identifies each row's date. Refresh time does not change an observation date. Headless reports retain each FRED series identifier, title, units, frequency, and date.

Responses must identify the requested FRED series and daily percentage OAS metadata. An incompatible refresh leaves a usable prior observation in place with its original date and the current failure status; it does not replace the series with another index or erase valid cached history.

Credit charts check declared FRED coverage against the returned observations. If usable observations fall outside those dates, the coverage notice withholds the contradictory dates while preserving the observations and any source-declared retention limit. The first and last returned rows do not establish replacement coverage bounds because the request may include a limited window or calculation buffer.

## Single-name CDS

CDS displays reported trade activity, with coupon and spread in basis points. Spread notation code 3 is decimal and code 4 is already basis points; explicit percentage notation is converted once. Unlabelled values are assumed decimal for compatibility with the legacy feed. Monetary notation (code 1) and unknown explicit units leave the bp spread unavailable. Trade-level headless rows retain the source spread and notation. Coupon and upfront amounts never establish an unreported spread.

See the [CFTC spread notation specification](https://www.cftc.gov/media/6576/Part43_45TechnicalSpecification093021CLEAN/download) (elements 73–75) and [ICE SEC SBSDR field validations](https://www.theice.com/publicdocs/data/ICE_Trade_Vault_SEC_SBSDR_Field_List_Validations.pdf) (elements 68–70). These define reporting units, not executable quotes or a comparable constant-maturity issuer spread history.

## Options

### Shared volatility calculations

The volatility library uses decimal annualized volatility (0.20 means 20%), calendar-year fractions for options and 252 sessions for realized volatility. Close-to-close uses the sample variance of log returns. Parkinson uses the squared log high/low range divided by `4 ln(2)`. Garman-Klass subtracts `(2 ln(2) - 1)` times the squared open/close log return from half the squared range. Rogers-Satchell uses `ln(H/O) ln(H/C) + ln(L/O) ln(L/C)`. Yang-Zhang combines sample overnight variance, sample open/close variance and Rogers-Satchell, with `k = 0.34 / (1.34 + (n+1)/(n-1))`. Range estimators assume coherent OHLC prices; daily jumps, splits and missing sessions can affect comparisons. No synthetic missing session is inserted. Dated invalid observations remain gaps and are never skipped to join returns. Repeated timestamps use the last correction.

Rolling windows are 10, 20, 30, 60, 90, 180 and 260 sessions. Cone statistics use valid rolling estimates whose ending observations lie within the chosen one- or two-calendar-year lookback. They report the current estimate separately from the historical sample, plus minimum, maximum, mean, median and the current empirical percentile. Percentiles use midpoint ranks for ties, so a constant sample has percentile 50. Missing current volatility stays unavailable even if an older estimate exists.

`HVG <ticker>` displays selected rolling windows above a separate price panel; `HVT <ticker>` opens the cone table and chart for all seven windows. The shared pane supports close-to-close, Parkinson, Garman-Klass, Rogers-Satchell and Yang-Zhang estimators, with a one- or two-year lookback. It requests daily five-year history so the longest rolling windows have warmup before the displayed lookback. Available sample counts remain in the cone table. An incomplete listing history cannot supply a full historical distribution. Settings and the active view persist per pane, and table CSV exports include percentage values with estimator and source metadata. Headless JSON preserves decimal volatility values.

The optional IV overlay reuses the OVDV chain loader and its quote cleaning. It is a single dated current ATM observation with an explicit option tenor, never a historical implied-volatility line. On screen in the regular session it re-reads the chosen expiry's chain once a minute at the live price; if that slice cannot price an ATM level, the dated reference already shown stays. Its caveats are the chosen expiry's own plus any catalogue or Treasury failure; other loaded expiries' warnings do not apply, except that the pane says so when nearer expiries had no usable ATM quotes and the reference fell back to a farther tenor. When the sources have no option chain for the underlying, as for many non-US listings, crypto and FX, the IV line is simply absent. Missing or stale option data do not prevent realized-volatility analysis. Historical IV, IV rank and IV percentile come from the stored history in `HIVG` (see [Implied volatility history](#implied-volatility-history)). The chart composer's Realized vol indicator uses the same estimators, with persisted window and estimator settings and 252-session annualization on source daily price observations. A synthetic live quote appended to the price chart does not become an extra daily observation for volatility. Invalid windows remain gaps through their complete warmup; intraday bars are not treated as daily sessions. OMON HV30 uses this same close-to-close implementation.

Put-call parity estimates the forward as `K + exp(rT) (Cmid - Pmid)` from paired two-sided quotes on the nearest two strikes on each side of spot. The median reduces sensitivity to an inconsistent pair. A pair whose forward is more than 5% plus 100% a year of carry (in log terms) away from spot grown at the Treasury rate is discarded: stale quotes left on far strikes, such as contracts listed before a split, otherwise imply forwards several times spot. When every pair is discarded the forward is unavailable. The bound can also reject a genuine forward far from spot, such as a hard-to-borrow name or a short-dated chain around a special dividend. Volatility indices such as ^VIX are exempt, since their options settle on a future that can trade far from the spot index. The result preserves the contributing contracts, warns when the strikes do not bracket spot or quote intervals disagree, and is unavailable if no pair exists. Implied continuous dividend yield is `r - ln(F/S)/T`; it can include borrow effects and American-exercise differences. An unpaired quote does not establish a forward. Delta and strike inversion use the existing European pricer and signed spot delta, including continuous dividend carry. Forward pricing through that pricer sets its underlying to F and its dividend yield equal to r, so discounting is applied exactly once.

Smiles fit raw SVI total variance, `w(k) = a + b [rho (k-m) + sqrt((k-m)^2 + sigma^2)]`, with `k = ln(K/F)`. A failed or poorly identified fit falls back to shape-preserving monotone cubic interpolation in log-moneyness. The fit retains its method, fallback reason and volatility residual. Tenor interpolation is linear in total variance `IV^2 T`; outside available tenors it retains the nearest IV and explicitly marks extrapolation. Calendar warnings identify decreasing total variance at fixed forward moneyness; butterfly warnings identify non-convex call prices on an ordered strike grid. Checks report problems without repairing the observed surface or guaranteeing arbitrage freedom between sampled points.

25-delta skew is put IV minus call IV; risk reversal uses call IV minus put IV. Butterfly is the average of those wing IVs minus ATM IV. The 90/110 skew subtracts the 110%-of-spot IV from the 90% IV. Term slope is decimal IV change per calendar year. Expected move reports the nearest paired ATM straddle midpoint and `spot * ATM IV * sqrt(T)` separately, both in price and percentage points of spot. A straddle more than 5% from spot is withheld. Neither measure is a forecast or a confidence guarantee.

### Volatility source coverage

Live checks at 13:37 UTC on 2026-09-22 distinguished symbol publication from actual app routing:

| Source | Verified coverage and limitation |
|---|---|
| Yahoo index quotes | `^VIX` resolved through the market-data router. `^VIX9D`, `^VIX3M`, `^VIX6M`, `^VIX1Y`, `^VVIX`, `^SKEW`, `^MOVE`, `^VXN`, `^OVX` and `^GVZ` resolved directly but their previous-day timestamps were rejected by the normal quote freshness rules. Index requests omit equity exchange hints. |
| Yahoo daily histories | The history router returned roughly one year through September 21 for the main VIX family above, except `^VIX1Y`, which returned one observation. `^VXEEM`, `^VXEWZ`, `^VXAPL`, `^VXAZN`, `^VXGOG`, `^VXGS` and `^VXIBM` also returned only one close. One observation supports neither a daily change nor a one-year percentile. `^RVX` and `^EVZ` were unavailable; EVZ has since left the board (see below). `^MOVE` returned inconsistent provider name metadata, so its identity requires caution. |
| Cloud FRED | Only `VIXCLS` and `VXVCLS` resolved, with observations through September 18. `VXNCLS`, `RVXCLS`, `OVXCLS`, `GVZCLS`, `EVZCLS`, `VXDCLS`, `VXEEMCLS`, `VXEWZCLS`, `VXAPLCLS`, `VXAZNCLS`, `VXGOGCLS`, `VXGSCLS` and `VXIBMCLS` returned `Unsupported FRED series`. |
| Public FRED publication | The requested series were published through September 21 except [EVZCLS](https://fred.stlouisfed.org/series/EVZCLS), explicitly discontinued on March 11, 2025. Cboe stopped publishing EVZ itself that day, and its own history ends there too, so the board no longer lists EVZ. An unsupported Cloud route does not imply a discontinued series. Actual observation dates take precedence over lagging series metadata. |
| Options chains | AAPL, SPY, NVDA and TSLA returned 22, 30, 22 and 21 expiries respectively, with delayed Yahoo snapshots dated September 21. Every front-expiry bid/ask was zero. Three sampled later expiries per ticker also lacked usable ordinary near-ATM markets after cleaning. Nonzero last trades and provider IV placeholders cannot replace a missing midpoint surface. |
| Treasury curve | Ten nodes resolved from 1M through 30Y, dated September 18, in percentage units. Divide yields by 100 for decimal rate inputs; short option tenors have no separate 1W Treasury node. |
| VIX futures | `FUT` has no VX alias or monthly VX catalogue. Yahoo `VX=F` returned 404. The cash volatility tenor curve is not a futures curve. |

By 14:08 UTC on the same date, new chain snapshots contained usable two-sided markets. Subsequent captures of AAPL, SPY, NVDA and TSLA each loaded 18 fitted expiry slices, including near-ATM smiles. Availability is time-dependent; the earlier zero-quote responses remain relevant partial/empty-state cases.

Dated daily-close histories can support a volatility board without bypassing quote freshness. Missing chain quotes remain unavailable in both recomputed and provider-IV comparison modes. These checks establish observed coverage at the stated time, not future availability. Implied-volatility and surface history come from the stored daily snapshots described under [Implied volatility history](#implied-volatility-history), not from these live sources.

### Option monitor and calculator

`OVDV <ticker>` loads up to 18 unexpired listed expiries with four concurrent requests. Listings with daily or weekly expiries are thinned so each requested expiry is at least 35% further out than the previous one; this spans the term structure instead of the front month, and a short catalogue is still requested completely. Loading more expiries adds the skipped ones from the longest tenor inward. Its catalogue and per-expiry requests use the same options coordinator as OMON. Scrolling the table near its end or choosing the footer's more-expiries action extends the request by 12 expiries. Each expiry publishes independently; an error in one slice remains visible beside successful slices. A refresh retains the prior view while new requests start. On screen in the regular session, a real-time surface reloads every 15 seconds past the local chain cache and is refitted at the underlying's streamed price; a reload replaces the surface only once complete and keeps the selection and camera. A delayed surface keeps the configured refresh interval. On desktop and web, a reload on the same grid eases the 3D surface into its new shape; a different grid or reduced motion swaps directly. A removed explicitly selected expiry stays unavailable until another is chosen, preventing a calculator from silently switching contracts.

The default surface recomputes European IV from quoted midpoints using the shared solver. Cleaning excludes zero bids, crossed markets, spreads greater than 50% of midpoint, missing or zero open interest, mismatched expirations, and stale duplicate contracts when a fresher observation exists at the same strike. The default stale threshold is five weekdays, a session proxy that does not infer exchange holidays. Bid/ask price choice, spread threshold, stale threshold and provider-IV comparison are pane settings. Provider comparison applies the same quote cleaning and requires a measured parity forward; unavailable markets do not become provider-IV surfaces. Puts below the measured forward and calls above it form a single OTM smile.

Rates linearly interpolate available Treasury maturity yields, divided by 100 and used as a continuous-rate approximation. This is a proxy curve, not a bootstrapped zero-coupon curve. Expiries shorter than the 1M bill hold the 1M rate flat, the usual convention; a hold beyond the longest published tenor, or on a curve missing its 1M point, is flagged. Unavailable rates are never silently replaced with a fixed default. Parity-derived forward and dividend carry, contributing contracts, source dates, fit residuals and rejected-quote counts remain in exports. Equity and ETF options can have American exercise effects that this European IV convention does not remove.

The 3D view uses listed expiries as evenly spaced rows, labelled with their tenor. By default its columns are spot delta from the 10-delta put through ATM (the spot strike) to the 10-delta call in 5-delta steps; each cell is the fitted smile at the strike with that delta, found only inside the expiry's quoted strike range, so every row spans the same probability range without extrapolation and the surface is a full sheet. The alternative forward-moneyness axis (80% to 120%, `d` in the pane or the 3D surface axis setting) draws each row only within 2.5 ATM standard deviations of its forward (`2.5 x ATM IV x sqrt(T)`); a quoted one-day 90% put has an IV, but that strike carries no probability mass. Adjacent rows of different widths join along their supported endpoints with boundary triangles on existing nodes; internal quote gaps and unavailable expiries stay open. Between grid nodes the drawn surface follows a bounded Catmull-Rom spline through the nodes (it passes exactly through every fitted value and never leaves the range of its neighbours); the wireframe marks the nodes themselves. Colour is the Turbo scale over the 2nd to 98th percentile of plotted cells, shared by the vertical axis and the colour bar; a few wild short-dated wing cells extend above the box rather than flattening the rest. The floor carries a translucent projection of the same colours. Desktop draws the surface on the GPU (WebGL) with per-pixel lighting; dragging rotates with inertia, the wheel or a pinch zooms, and a double click resets the view. Terminals with Kitty graphics use a software renderer over the same geometry, at half resolution while the camera moves. Arrow keys or h/j/k/l rotate, + and - zoom and 0 resets in both. Without bitmap support the shaded table remains keyboard- and mouse-selectable. The table, smile and skew views keep every cleaned quote. The term chart spaces expiries on a log tenor axis. The default selected expiry is the first at least four weeks out. The table and smile axis can show spot %, forward %, signed delta wings or strikes. Fixed table tenors interpolate total variance at fixed forward moneyness and show I; time extrapolation shows E. Strike extrapolation is withheld in every view, including ATM and delta-wing metrics, so a few far-wing quotes cannot manufacture a near-ATM surface.

Use the tabs or the footer's view action to switch surface, table, smile, term, skew and forwards. The expiry selector and [ / ] select an expiry. Smile overlays identify nearby expiries on the same chosen coordinate axis. Term structure shows ATM at spot (distinct from the forward-ATM ridge) and 25-delta wings with each expiry's straddle and one-sigma move below. The forwards table shows the parity forward, its basis to spot, and the implied dividend yield only for expiries at least 30 days out, since annualising a few days of carry is not meaningful. The price action seeds OVME with the selected fitted strike, tenor, rate and carry; a nearby contract's premium is not borrowed for an off-strike cell. The chain action opens OMON at the same expiry. CSV exports from tables include method, filters, rates, source dates and warnings; `gloomberb fn OVDV AAPL --json` preserves the complete model metadata. Pane sharing uses the standard pane menu.

OVME offers European Black-Scholes and American CRR models. The American tree models early exercise and an explicit cash-dividend schedule; the European closed form retains continuous dividend yield. Theta is per day; vega is per volatility percentage point; rho is per rate percentage point. The UI keeps these units beside their values. In the European closed form, a positive input exactly at the discounted zero-volatility payoff has a 0% boundary solution. Nearby prices within the cumulative-normal approximation’s price-error bound cannot resolve IV and remain unavailable; this is not an estimate of quote precision or realized volatility. The asymptotic maximum has no finite IV, and the solver retains its 500% ceiling. Submitted calculator inputs retain their entered precision while editing.

OMON HV30 is the annualized sample standard deviation of 30 daily log returns from 31 distinct reported observations, using 252 trading days per year. A later correction replaces the same timestamp. Missing or nonpositive closes and contradictory OHLC inside that window make HV30 and IV/HV unavailable; they are not skipped to bridge a return. A quote explicitly marked stale cannot seed underlying-dependent Greeks, ATM selection, or the calculator. Contract quotes remain visible with their own timestamps.

OVME values are per underlying unit, not a position or contract total. Rates and continuous dividend yield are entered in percent; time uses calendar days, retaining fractional days. A chain expiry date is seeded at 16:00 New York with historical daylight-saving offsets. Verify and edit the time for other settlement schedules or early closes, especially index options. The calculator does not resolve adjusted deliverables or contract multipliers, model multi-leg payoffs, or compute assignment outcomes. American exercise is a theoretical optimal stopping decision, not a forecast of actual assignment.

OMON retains the selected expiration date when a refreshed catalogue reorders or removes other dates. If that selected date is unavailable, its table and calculator remain unavailable until the date recovers or another date is selected.

An explicit OMON row/cell selection retains its strike, side and contract symbol within the selected underlying and expiration. Adding other strikes cannot move that choice. If the chosen contract disappears, its calculator action remains unavailable until that contract returns or another contract is explicitly selected. Strike labels and table exports preserve fractional precision; wide values can still require horizontal scrolling.

Invalid option volume/open interest is unknown, not zero, and so is missing open interest. A reported zero remains zero. Yahoo omits volume for contracts that have not traded, so a missing Yahoo volume is zero. Yahoo implied volatility is unavailable for a contract with neither bid nor ask, and at Yahoo's 1e-5 solver floor: Yahoo derives it from the quote midpoint, so after the close it returns bisection placeholders rather than a measured value. Expiration volume and each put/call ratio require complete inputs for that metric across the returned contracts; missing open interest does not suppress complete volume or IV. These totals describe the supplied selected-expiration rows, not verified whole-market coverage. The existing `options` CLI retains the same source activity availability; `--refresh` bypasses its local chain cache, and a failed refresh that falls back to a stored chain prints a warning with the stored time; OMON itself has no registered headless pane report.

A calculator opened from a chain uses a saved contract observation. Its quote and last-trade timestamps are separate; neither makes a saved quote executable. The market reference identifies midpoint, last, or manual input. Crossed or one-sided quotes do not supply a valid midpoint.

## Earnings and corporate actions

Event EPS and consensus can use an unspecified accounting basis, while TTM values come from statements. Fiscal period ends are not announcement dates. Open an event row for its source inputs and dates.

Consensus estimates are forecasts for the stated fiscal period. The provider's prior-year input can itself be an estimate; it does not establish a reported result. Fetched timestamps identify retrieval, not when consensus was revised. Filing evidence corroborates a fiscal period without verifying every reported metric.

Split-feed factors may include spinoff price adjustments. Merger terms, spinoff distributions, and security conversions are not covered. Source failures and unavailable event data remain visible rather than appearing as an empty event calendar.

IPO offering prices are distinct from exchange trades. The Cloud CRCL US history captured on September 16, 2026 inserted the [June 4, 2025 $31 offering](https://www.circle.com/pressroom/circle-announces-pricing-of-upsized-initial-public-offering) before NYSE trading began June 5, carried that open/low into its inception aggregates, and inserted the offer into the first trading day’s intraday bars before the opening auction. Requests containing that exact source defect use another available history provider or remain unavailable; the app does not remove the first bar and silently shorten the window or invent replacement OHLC. A corrected source response is accepted. Valid zero-volume observations, other listings, and partial inception buckets with traded prices remain unchanged. Older embedded financial snapshots lose the affected price history while their statements and quotes remain available. Their fixed-horizon returns become unavailable; that snapshot contract does not retain a separate history-rejection reason. Direct history/chart requests retain the source failure when no valid fallback is available. This targeted check does not establish complete IPO or corporate-action coverage.

## Earnings estimate comparisons

ERN groups and displays announcement dates on the same UTC calendar day. Exact call times, when supplied without a market-session label, use your local time. EPS 30D is the current estimate minus the estimate from thirty days earlier; a seven-day observation cannot fill a missing thirty-day value. REV 30D shows upward/downward revision counts over that same thirty-day window. An unknown count remains unavailable rather than becoming zero, and a directional color requires both counts. The CLI retains separately named seven-day and thirty-day source fields.

EPS and revenue retain their own explicit forecast currencies; neither inherits the listing currency or the other's currency. A `?` currency is unknown. Explicit minor-unit codes such as GBp/GBX normalize once to GBP; no exchange-rate or ADR conversion is inferred. EPS 30D requires both values to have the same known currency and forecast period. EST END is the provider's fiscal-period end when the available estimates agree, distinct from the announcement date; an unspecified or mixed period remains unavailable. Scroll horizontally to reach the remaining estimate columns in a narrow pane.

Calendar fallback values keep their own unknown currency and fiscal period. Trend-only ranges, growth, counts, and revisions are withheld from the displayed fallback's context; range endpoints from incompatible sources are not combined. The CLI's `estimateBasis` records each selected field's source, period, explicit currency code, and original `sourceValue`. `sourceEstimates` preserves all source-selected values after minor-unit normalization, including values withheld from the comparable top-level fields.

## AI research context

Ask AI and ticker attachments in the AI workspace come from the [BYOK AI plugin](https://github.com/gloom-sh/gloom-byok-ai) and use the available quote, summary fundamentals, and latest annual statement. Monetary amounts retain their original values and explicit source currency, including minor units such as GBp. The configured base currency is a preference; these inputs are not converted. Listing, summary, and statement currencies remain independent, and unknown units remain unknown. Zero values and numeric precision are preserved; margins, yields, and returns from fundamentals are identified as fractions.

The context includes available source, observation, retrieval, stale-state, and statement-history failure information. Retrieval time does not establish a valuation date. Annual period identity, whole-row availability, and individual field availability remain distinct. This attachment is a snapshot of those inputs, not a complete filing or a guarantee that a provider's data is current.

### Filing alert timing

Filing event alerts observe House and Senate disclosures and followed funds' 13F submissions,
using the existing mobile daily cap, cooldowns, and delivery ledger. A filing that
matches several rules notifies once. Rules begin on their creation day; resuming
a paused rule starts a new observation window. The evaluator looks back at most
14 days and handles up to 40 event rules per user.

House alerts depend on successful PDF parsing and the daily OCR budget; Senate
alerts cover electronic reports only. Each chamber scans up to 240 recent
filings per source year. Fund filing checks share the 24-hour
forms13f cache. Delivery therefore follows source availability and parsing, not
the transaction date or a guaranteed real-time schedule. Price alerts continue
to use their existing price conditions.

Market and research rules come in two families. Event rules (earnings date,
filing type, news keyword, analyst change, insider trade) fire once per dated
source event inside the 14-day window: a confirmed, non-estimated earnings date,
an SEC acceptance instant with an explicit timezone, a story first seen by the
news pipeline, an explicit upgrade or downgrade action, or an open-market P or
S Form 4 row. Free accounts receive a news keyword match once the story passes
the delayed-news cutoff. Observed rules (52-week, unusual volume, short interest
change, IV spike) keep one dated reading per rule. A new, edited or resumed rule
records a baseline and cannot fire on it; an alert needs a strictly newer
observation whose condition is true after one that was false. A crossing held by
the cooldown or daily cap waits up to a day. The 52-week test compares a
completed session's high or low with the prior 252 completed sessions; unusual
volume divides a completed session's share volume by the prior 20 sessions'
mean; short interest change compares consecutive FINRA settlements; IV spike
compares OPRA implied volatility for one contract and requires Pro. Readings
carry their unit, date and a percentile of the same statistic over up to one
year of readings, shown once at least 20 readings exist. Delivery history records what the push service
accepted, not what the phone displayed.

Options flow rules (Pro) match the prints the FLOW scanner records: aggregated
fills of $50K or more on the contracts it streams. Cloud checks new prints about
every 10 seconds and pushes the largest match of each pass, at most one flow
alert every five minutes, within the shared daily cap. Prints older than ten
minutes are never pushed, and a rule never fires on prints from before it was
created. The scanner streams 500 contracts ranked by premium; names with an
active flow rule are always fetched and get part of that budget (up to 100
contracts, 3 to 10 of each name's busiest), so a rule on a quieter name watches
its most active contracts, not every strike. A portfolio-and-watchlist rule
covers up to 20 of your names, held names first.

## Annual risk-factor reports (RISK)

Risk reports use the filing year of a company's Form 10-K, rather than an assumed fiscal year. The filing date identifies the source document; “Report updated” identifies the derived risk report. Risk headings and source excerpts come from the filing, while the overview and notes are analysis. The available comparison is the report's supplied change analysis; a missing annual filing is not synthesized. Foreign issuers filing Form 20-F are not covered by this 10-K report service.

Opening RISK follows the newest discovered report. Selecting a year keeps that filing selected when the standard `r` command refreshes discovery. New ticker/year requests clear the preceding report before loading, so its filing action cannot point to another selection. Source dates remain unchanged during refresh. Historical reports can be cached for rereading; a failed refresh can retain the same report with its original retrieval time and an active footer failure. Missing or denied report responses clear that report. The discovery list has a six-hour freshness window; failed forced refreshes are retried on reopening within the same runtime.

`gloomberb fn RISK AAPL --year 2025` reads that specific filing without requiring latest discovery. Omit `--year` (or use `latest`) for the newest discovered report; `--refresh` bypasses the corresponding caches. JSON and text export preserve source dates, the filing URL, source excerpts and separate analysis. A cached latest list after a discovery failure makes the report incomplete and discloses the failure; an independently available explicit historical report does not depend on the discovery list. Retrieval timestamps describe cache freshness and do not move the filing or report-update dates forward.

## SEC filings and 8-K research

SEC keeps original and amended filings as separate accession records. Opening an amendment does not replace or reconcile the original filing's contents. Filing calendar dates and SEC-reported acceptance timestamps are distinct; acceptance is not verified public availability or an announcement time. Source timestamps without a timezone remain unconverted, and a filing date does not establish a report-period end. The SEC report export retains the source accession, issuer, document link and available acceptance provenance.

The 8-K feed groups model-read headlines and points separately from unread filings. Those summaries are a model's reading of the linked filing, and names are checked against its text; an unread filing is not evidence that no material event occurred. The feed is bounded by the loaded source response. Its Open action always belongs to the selected company's filing.

The existing `r` shortcut refreshes 8-K discovery and SEC filing lists. Same-company transient failures retain usable research with the failure in the existing footer. Changing or clearing the company removes the previous company's content and source action. SEC document-index failures remain distinct from successful empty indexes. Refresh retries failed or unreadable selected content and failed/empty document indexes, while successful as-filed content stays cached. Pending SEC requests are joined; refresh after completion makes a new discovery request. The 8-K feed has no independent structured headless report; SEC's existing report exports filing records, not a full document archive or reconciled amendment model.

## Fund profiles and ticker reports

Overview, ticker reports and AI context identify the security using its reported quote type, then retained quote metadata, then the saved asset category. Blank type fields do not stop that fallback. A broker's generic `STK` category remains part of the stored holding; it does not replace an explicit provider `ETF` classification in the research view. This classification does not establish domicile, fees, fund base currency, hedge policy, distribution policy or total return.

A missing current quote does not discard independently available profile details, reported fundamentals or supported dated return summaries from `gloomberb ticker`. Text retains the quote-unavailable status; structured output has a null quote, a warning and any separately available quote metadata with its source information. Unknown and nonfinite values are not supplied zero, and cached undated return fields alone do not establish usable research coverage.

Ticker text uses the same source-qualified market capitalization as Overview and AI context. It converts to the preferred base currency when an exchange rate is available; otherwise it retains the reported value and currency. Missing capitalization currency is not supplied from the listing. A fundamental snapshot retains its retrieval/stale provenance, separate from the unavailable valuation date.

Ticker text and JSON select their latest annual and quarterly rows by the reported calendar period, independently of provider ordering. Yahoo's latest metric snapshots follow the same rule. Unusable period strings do not become dates; a known zero or partial latest row does not borrow an older value. Equal periods retain the source's last supplied entry, without reconciling amendments or treating publication dates as period ends. Selecting the CLI report does not reorder or rewrite supplied statement rows or change their counts.

Analyst price targets retain their declared denomination. A missing denomination is shown as `(ccy?)`, with a null currency in the headless report; the app does not infer USD, convert targets into the account currency, or infer a share-class ratio. Explicit minor currency codes are scaled once for display. The upside calculation compares the average and reference supplied in the same target response; its retrieval time is not an independent target publication date.

The analyst recommendation summary selects an explicitly current-month row when provided, otherwise preserving the source's first row and period label. A complete analyst count requires all five reported nonnegative integer buckets. Missing categories and unavailable totals remain unknown, while reported zero counts remain zero. The combined sell count requires both sell buckets. Relative periods remain relative; the app does not invent a dated consensus snapshot. Only a mix taken from an older period is labelled with that period. The reported target range, recommendation mix, rating, upside reference price, and retrieval age are pane status rather than body content. Headless analyst research resolves the same remembered venue as ticker-bound research before loading a symbol.

The analyst target chart is rebuilt from the dated targets in the ratings history, never from a provider consensus for a past day, which no source serves. On each day a firm publishes, it plots the mean of every covered firm's most recent target; a firm leaves that mean once its target is more than a year old, and the undated prior attached to a rating is never plotted. Only the most recent two years of those days are drawn, and a firm's first entry on a day stands for that day. A source that never dated a firm's target cannot put that firm in the mean, so the chart is labelled with the firms it covers and usually ends away from the reported average. Fewer than three covered firms, or fewer than three plottable days, leaves the chart out rather than drawing a consensus out of one or two desks.

Yahoo keeps an explicitly dated but unavailable metric in its reporting period. A null, omitted, or nonfinite value does not promote an older observation to the latest period, and does not become zero. Malformed or impossible calendar dates are excluded from dated Yahoo statements and latest-metric selection. Annual summary values and margins use one latest annual reporting row, including when an individual metric wholly omits that period. Older values remain in their dated history. Trailing provider measures retain their own source observations; this does not establish common publication dates or a complete current filing.

## Financial growth display

Financial tables abbreviate large growth percentages (for example, `+163k%`) so the sign and percent unit fit beside the reported value. Extreme finite values that cannot fit use an explicit bound; an unrepresentable growth rate is unavailable. Structured JSON retains finite numeric growth; formatted text and CSV use the compact display.

## Executive compensation

`EXEC` reads compensation from covered annual DEF 14A proxy statements. The year selector identifies the proxy filing year; the statement separately identifies the fiscal year of compensation. Stock and option awards use the filing’s grant-date valuation, which is not the amount eventually realized. Open the source filing through the existing footer action (`o`). No covered proxy means this view has no compensation data for that company; it does not establish that the company pays no executives.

Refresh (`r`) reloads the covered years and selected statement. A temporary failure retains available data; the footer warning gives the failed request and original retrieval time. Missing or denied statements are cleared. A successful refresh removes the warning without changing the filing’s reported dates.

13F research rechecks stale source responses when opened. If both hosted and public reads fail, retained cached rows carry the original retrieval time in the existing warning disclosure; filing and reporting dates are unchanged. A failed refresh is retried on reopening, even inside the normal cache lifetime. Filing reports preserve these warnings in their structured output.

### OMON expiry analytics

HV30 in OMON requests a separate daily one-year history buffer from the shared coordinator and rejects detectable weekly or intraday cadence. It does not annualize the generic financial snapshot, which can contain weekly bars.

The options monitor reuses its selected cached chain and OVDV cleaning, Treasury interpolation, put-call parity and smile fitting. The straddle move is the nearest clean call-plus-put midpoint at the same strike within 5% of spot, shown in quote currency and as a percentage of the underlying mark. It is a premium measure, not a probability interval. The separate one-sigma move is spot times fitted ATM IV times the square root of time to expiry. A rates or parity failure can leave the quoted straddle available while model-based metrics remain unavailable.

The 25-delta P-C skew is put IV minus call IV, displayed in volatility percentage points. Term slope compares fitted ATM IV at the selected expiry and the immediately later listed expiry. When the later expiry is less than 30 calendar days away, it shows the raw IV difference in volatility points with both expiry dates. At 30 days or more, it divides that difference by the year fraction between the expiries and displays percentage points per year with the destination date. A missing or stale adjacent chain leaves a gap; the monitor never substitutes a farther tenor. Selected-chain, adjacent-chain, spot and rate observation dates remain in the model; source-date differences and cleaning limitations appear through the pane warning disclosure.

In the regular session, streamed trades move Last and volume, and each applied quote batch re-solves IV and the Greeks from the live midpoint and the live underlying. The summary strip, expected move, 25-delta skew and term slope follow the stream at most once a second, refitting only the selected smile, and stay dated by the chain snapshot they rest on. A real-time chain on screen reloads its snapshot every 15 seconds in session, past the local chain cache; the previous analytics stay until the new ones are ready. Outside the session the calculation changes only when a new chain response is accepted. Failed, stale, undated, removed or mismatched expiry snapshots cannot provide current enrichment. There is no historical IV rank or percentile.

The OMON surface shortcut and OVDV chain shortcut preserve ticker scope and selected expiry. A selected listed expiry is pinned in addition to OVDV's representative geometric sample, so daily listings omitted from the default sample still open at the requested date. Removed catalogue dates remain unavailable.

### VIX curve and cross-asset volatility board

`VIX` combines three views: a dated cash-index tenor curve, FRED VIX/3M history with its ratio, and the cross-asset board. `VOLS` opens the board directly. The views persist independently per pane. These are published index levels and daily closes; the cash-tenor curve is not a VIX futures curve.

The history router supplies the cash curve at 9, 30, 93, 184 and 366 calendar days, following [CBOE's constant-maturity definitions](https://cdn-api.cboe.com/api/global/us_indices/governance/Volatility_Index_Methodology_Selected_SPX_Target_Expected_Volatility_Term_Indices.pdf). Histories are requested at daily resolution with bounded concurrency and shared coordinator caching. Source clocks are normalized to their UTC observation date, duplicate dates retain the last correction, and invalid dates or nonpositive levels are excluded. The latest common VIX/3M date anchors the curve. Other tenors must have an observation on that date; missing nodes remain gaps. An old single-observation 1Y index cannot pull the entire curve back in time. If the Yahoo core is unavailable, the existing aligned two-node FRED curve can appear as an explicitly named fallback. FRED and market-history nodes are never spliced into a single curve.

Contango/backwardation describes the 3M index level relative to the 30-day index at the same observation date, not futures roll yield. The spread is in index points and the ratio is 3M divided by 30D. The History view uses only the supported Cloud FRED series VIXCLS and VXVCLS. Dates FRED publishes without a value, such as exchange holidays, stay gaps. Ratio history uses matching dates with no forward fill. Its source date can lag the separate cash curve, and that date remains visible. Metadata publication dates do not replace observation dates.

The board displays each index's own latest level and observation date. The S&P 500 implied correlation rows (COR1M, COR3M) use CBOE's published daily closes through Cloud, because the Yahoo route returns a single print; they measure index option IV against its top 50 constituents, not a volatility level. An isolated Yahoo observation is not labelled a daily close; its source timestamp appears when selected. Daily change requires two consecutive available daily observations; one-row histories have no change. A one-year percentile requires at least 200 positive observations spanning at least 300 calendar days within the trailing calendar year. Empirical ranks use midpoint treatment of ties. Thin coverage retains the observed level while leaving the percentile unavailable. Different volatility indices have different definitions and underlying assets; their levels are not interchangeable. The selected history and source details remain available alongside the table.

While visible, the curve and the board stream their index levels. A streamed level becomes that index's observation for today, so the level, the change against the previous close, the curve ratio and the one-year percentile follow it, rebuilt at most once a second and labelled intraday with its time. Indices that do not stream are re-read every 15 seconds in the regular session. The correlation rows keep their published daily closes.

The September 22, 2026 audit reached daily histories for VIX9D, VIX, VIX3M, VIX6M, VVIX, SKEW, MOVE, VXN, OVX and GVZ. Exact daily-resolution routes returned no data for VIX1Y, VXEEM, VXEWZ and the Apple, Amazon, Google, Goldman Sachs and IBM indices; RVX and EVZ routes were not found. With the standard Yahoo fallback enabled, VIX1Y, VXEEM, VXEWZ and the five single-name indices resolve to isolated intraday observations, while RVX and EVZ remain unavailable. These sparse values cannot establish daily changes or annual percentiles and do not fill the prior-day cash curve. Public FRED CSVs confirmed that VXNCLS, RVXCLS, OVXCLS, GVZCLS, VXDCLS, VXEEMCLS, VXEWZCLS and all five single-name series continued through September 21, 2026, but the Cloud FRED allowlist supports only VIXCLS and VXVCLS. These are app-route coverage gaps, not discontinued publications. EVZ is the exception: Cboe stopped publishing it after March 11, 2025, where both its Cboe history and FRED EVZCLS end, so it is no longer on the board. MOVE's provider name metadata was inconsistent with its symbol and is flagged. No VX futures alias, monthly contract catalogue or valid Yahoo VX=F route was found. The pane does not substitute a cash-index curve or fabricate missing histories.

### Implied volatility history

`HIVG <ticker>` charts 30 and 90 calendar-day ATM implied volatility against close-to-close realized volatility (20 or 30 sessions), with the IV minus HV spread in a lower panel. `VCA [tickers]` ranks a list from rich to cheap. Both read the stored daily history behind `/cloud/iv`, which covers US option underlyings from February 2024.

Two methods produce the stored readings, and a statistic never mixes them:

| Method | Source | Timing |
| --- | --- | --- |
| Trade close | OPRA daily trade closes for listed monthly and weekly contracts, with raw stock closes | Every completed session since 2024-02, caught up each evening |
| Live (quote mid) | The OVDV pipeline on the live chain: quote cleaning, parity forward, IV solve, SVI fit | 15:40 to 15:58 New York on full trading days |

The trade-close forward is the median put-call parity forward over the three strikes nearest spot where both sides traded. IV is solved on the out-of-the-money side and interpolated to the forward in log-moneyness. Constant maturities interpolate total variance between listed expiries and never extrapolate. A session where no call and put at the same strike both traded is a gap. SPY's 2025 trade-close IV30 correlated 0.990 with VIX and averaged 15.7% against VIX 19.0%; VIX includes skew, so a lower ATM reading is expected.

The statistics table ranks each measure's latest value against the prior 52 weeks of the same measure: 52-week low and high, rank `(value - low) / (high - low)` and midrank percentile. Rank and percentile need 120 prior sessions. IV rank and percentile use trade-close readings only. A newer same-day live reading appears on its own unranked row, so a method change cannot move the rank. HV is the shared close-to-close estimator on adjusted daily closes; IV minus HV pairs each trade-close IV30 with HV on the same session. The 30d/90d ratio above 1 is an inverted term structure.

`VCA` shows each symbol's latest IV30 with its session and method, IV rank and percentile of the latest close, the 30d minus 90d slope, 25-delta put minus call skew from the latest live capture, HV20 and IV/HV. Rich means an IV percentile of 80 or more against the symbol's own year; cheap means 20 or less. This is relative to the symbol's own history, not a fair-value model. The universe is a preset (index and sector ETFs, US mega caps), a linked watchlist or portfolio, or custom symbols, up to 60. Non-US listings are left out rather than queued.

About 110 liquid ETFs and stocks are covered from the start. Any other US underlying is queued on its first request and backfills within minutes; the pane reports "queued" or "backfilling" until the history is complete. Accounts without realtime entitlement see a live reading fifteen minutes after capture. The platform's [data-quality note](https://github.com/vincelwt/gloomberb-platform/blob/main/docs/data-quality/implied-volatility-history.md) lists the known limits: last trades are not synchronous with the stock close, contracts adjusted for corporate actions are not addressed, and 25-delta skew starts with the first live capture.

### 13F ticker comparisons and crowding

Ticker Research's 13F tab compares current holders and prior-quarter exits. Holder/new/exit counts cover the source indexes; the USD total covers loaded fund pages and grows as the list scrolls. Fund weight is share of reported 13F value. Equity, puts and calls remain separate, and incomplete reports leave changes unknown. On September 22, 2026, the upstream `/holders` index returned HTTP 400 for current periods and its official example; the tab reports that source failure until the provider restores the index.

Crowding uses the latest broadly available quarter and the top 25 funds ranked by forms13f.com estimated performance. It is a sample, not the whole market. New and exit counts count distinct funds; DELTA PP sums changes in reported fund weight in percentage points, and COMP counts funds with a valid weight comparison. Options use underlying notional and remain separate from shares. Complete aggregates cache for 24 hours and partial results for five minutes. Mine marks and filters existing portfolio or watchlist tickers without changing the source sample or aggregate denominators.

The Performance list shows the provider's estimated quarterly return and the prior three quarters when that fund appeared among each quarter's top 100. Missing ranks and failed or mismatched periods stay blank. This is a survivor-biased ranking history, not a verified fund track record; the provider's opaque `pnl` estimate is not realized fund performance.

Fund Overlap matches current disclosed positions by CUSIP, option side and share type, then shows each fund's reported weight. It requires matching latest quarter ends, excludes exits, preserves unknown weights for incomplete reports, and does not combine puts or calls with equity. It is overlap of public 13F disclosures, not the managers' complete portfolios.

## Daily short volume (SIV)

`SIV AAPL` opens daily FINRA short-sale volume; the existing `SI` pane also has a lazy Daily volume tab beside twice-monthly outstanding short interest. NMS covers consolidated off-exchange regular-hours activity reported to FINRA. OTC Reporting Facility data is a separate scope selected in settings. Neither is total-market volume, and daily short volume cannot be summed into outstanding short interest or days to cover. A high ratio does not establish bearish intent or new short positions.

The ratio is 100 times ShortVolume divided by the same file's TotalVolume. ShortExemptVolume is already included in ShortVolume. CNMS already consolidates its facilities, so constituent files are never added again. Exchange volumes and ORF are never added to the denominator. Modern FINRA quantities contain up to six fractional decimal places; Cloud stores exact numeric quantities and sends decimal strings. The table abbreviates quantities, while row detail and structured output retain exact shares.

The backend discovers published file links from FINRA monthly indexes, including corrected URLs, before ingestion. Files generally publish by 18:00 Eastern on the trade date; later corrections are possible. Source dates and retrieved times remain distinct. A corrected file atomically replaces its dated scope, including withdrawn rows. A missing file, unreported symbol or zero denominator stays an explicit gap. Daily changes require adjacent published files and discovery of every intervening month.

Percentiles use midrank ties and at least 20 finite daily ratios within the latest discovered source date's one-year window. Actual sample count and first/last dates are shown. Incomplete discovery or short symbol history is labelled sample rather than a full one-year rank. Opening the pane reads Cloud aggregation tables and does not fan out to FINRA. Migration 088 and catchup ingestion must be available; otherwise the pane shows a recoverable unavailable state. Refresh failures retain dated observations with a warning.

Source symbols preserve case and punctuation. BRK/B and BF/B class aliases are mapped explicitly. Preferred shares such as ABRpD require their exact FINRA symbol in settings or `gloomberb fn SIV AAPL --finra-symbol ABRpD`. No heuristic collapses preferred or class shares into common shares. `--scope otc` selects ORF. The report includes exact quantities, coverage, gaps, source URLs and dated percentile statistics.

## Congress summaries and filters

Congress pane summaries count distinct loaded transactions, across each filing
window and year the reader appends. The API, CLI, and chat aggregates cover all
parsed trades in the requested filtered filing window, before its trade-row
pagination. Counts and dollar ranges describe disclosures, not current holdings
or trade execution sizes. An open-ended or unknown upper bound stays unknown.
The amount filter uses the disclosed lower bound, so a range is included only
when its minimum meets the threshold. A lag above 45 days is flagged from the
transaction and filing dates; it is not a determination of a legal violation.
Stock, option, and other categories use the disclosed asset code and description.
**Mine** reads existing portfolio/watchlist membership; it does not add a holding.

### Congress returns and member context

TX RET% and FILE RET% compare the first available daily close on or within seven days after the transaction or filing date with the latest completed daily close. Current-day prices enter after 5 p.m. New York time. These are hindsight stock-price changes, excluding dividends, fees, execution prices, and option-contract performance. Missing prices and non-stock disclosures stay unknown. The server caches ticker/date results for one hour and retries unavailable prices sooner.

The Members median uses priced transaction-date stock returns across all sides. Buy hit rate uses priced buys with a positive return, with the priced trade and buy denominators available in detail and structured output. These are not realized returns or portfolio performance. Pane summaries use the loaded trades, including appended years; headless summaries retain the server's filtered filing-window scope.

Party and current committee assignments come from the public unitedstates/congress-legislators YAML, cached server-side for 24 hours. Matching requires name, state/district and a House term covering the filing date. Party follows that term; committees are the current source snapshot. Ambiguous matches remain unknown.

Senate reports come from the Senate eFD site, which serves US addresses only and is read through a US egress server. An eFD amendment restates its whole report, so the newest electronic amendment replaces the original; its rows keep the original filing date, which the 45-day late flag uses. Paper reports are scanned images: they are counted in the scan notice (`filingsPaper` in structured output) and not read. Senators are matched to the member directory by last name among sitting senators, with first names deciding shared last names; the directory supplies their state, party and committees. When the Senate source is unreachable, the merged feed serves House filings and reports `senateUnavailable`.

## Futures curves (CTM)

`CTM CL`, `CTM ES`, `CTM ZN` and `CTM VX` open a focused curve for an existing FUT root or VIX. With no argument, CTM uses the active futures root when recognized, otherwise ES. The pane settings select another root. Gloom Cloud batches catalogue discovery, quotes and history in one endpoint; the app does not contact an exchange or Yahoo directly. Curves use actual expiration dates, preserving quote units such as US cents (`USX`) for grains and some soft commodities. Equity index futures quote index points, Treasury futures quote percent of par, and VX quotes volatility points. Provider currency remains separate in structured output. Contract rows expose dated prices, volume and open interest; zero counts remain zero, missing counts remain unavailable.

The main curve and 1W/1M/1Y ghosts follow the same currently listed contracts. A historical ghost is not the strip that was front-month at that past date. Each curve and node retains its actual source date, and missing history stays a gap. Price and front-pair percentiles use the available matching daily observations within a one-year lookback, with the actual sample count and start/end dates shown. Newly listed contracts can have much shorter coverage; one observation is not displayed as a historical rank.

Contango means the second expiry is priced above the first; backwardation means below. The spread is M2 minus M1 in the provider's quote units. Indicative annualized roll yield is `(M1 / M2 - 1) * 365 / daysBetweenExpiries * 100`. It requires positive prices and increasing expirations, and is curve carry rather than a realized strategy return. Missing front prices never cause the calculation to silently substitute later contracts. Stale observations are marked in the footer.

Yahoo quotes retain their provider delay and timestamps. Some roots have no complete provider catalogue; their validated search horizon is disclosed in the warning details, so the curve cannot claim exhaustive exchange coverage. Yahoo also drops some expired symbols. Official Cboe monthly VX contract files provide daily settlements and open interest, generally published around 10am Central Time on the next trading day. They are neither cash VIX nor intraday futures quotes. Cboe settlement is used instead of Close, which can be zero in early file rows. A currently listed VIX contract generally has no one-year history; its missing comparison is left empty. An absent cloud endpoint or source failure shows an unavailable state; a failed refresh retains dated cached observations with a warning.

CTM charts the contracts expiring within the pane's horizon setting (36 months by default; 12, 24 or every listed contract are available). A crude strip lists a decade of months, and drawn end to end the liquid front two years collapse into a sliver while contracts last quoted years ago shape the curve; the contract table always lists every contract. The legend and footer date the strip by its freshest quote and count the contracts whose quote is more than four days old; the structured payload's `asOf` remains the oldest quote. CTM plots the latest strip with one-week and one-month ghosts using explicit theme colours. A one-year comparison remains available in the tenor cursor and shared table fallback with its source date, while it cannot compress the current chart axes. The contract table is capped at the space its rows need; the curve uses the remaining height.

## CFTC positioning (COT)

`COT` opens an extremes board of the latest stored CFTC futures-only report, initially ranked by distance from the median one-year net position. The board scope defaults to the major markets (equity index, VIX, Treasury and rate futures, G10 currencies and the dollar index, bitcoin and ether, energy, metals, grains, softs and livestock, 46 verified codes) because ranking all 371 markets by extremeness puts ICE basis and Nodal power contracts ahead of everything a reader is looking for; switch the scope to all markets, or type a search, to reach any market. Search by market name or exact CFTC code and open a row for history. `COT 088691` or `COT GC` opens standard COMEX gold directly; `CFTC` is an alias. Verified root aliases cover ES, ZN, ZQ, CL, GC, SI, SR3 and VX/VIX. Codes preserve leading zeros, letters and a trailing plus used for consolidated markets. A consolidated index market does not borrow an individual contract's front-price mapping. Micros, standard contracts and similar products on different exchanges remain separate markets.

Legacy reports classify noncommercial, commercial and nonreportable traders. Disaggregated reports cover physical commodities and classify producer/merchant, swap dealers, managed money, other reportables and nonreportable traders. Financial and VIX contracts use legacy data; noncommercial is not renamed managed money. The tabs select report family, and the class selector or detail table selects a trader class. Net positioning is long minus short; spreading is separately reported and is never added to either side. CFTC quantities aggregate all maturities, so neither positions nor open interest are front-month counts.

One- and three-year percentiles compare a trader class with its own corrected stored history in the same report family. Missing or suppressed values remain null, never zero. Ranks require at least 20 usable observations for 1Y and 52 for 3Y. New markets with short coverage carry their actual sample count and partial-window status. A complete window starts within seven days of the requested lookback boundary. Weekly change requires the previous week's dated observation; a gap does not become a multiweek change labelled one week. Charts preserve missing weeks as gaps. All headline dates are the CFTC observation dates, usually Tuesday. Friday's scheduled release time is not an independently established publication timestamp, and download time is separate.

The backend ingests current files and annual archives, with idempotent corrections and a catchup ledger. It requires migration 087 and populated history. Until the endpoint or table is present, the pane shows an unavailable state. Failed refreshes retain readable dated observations with a warning. Where an exact product mapping is verified, the detail chart adds continuous front-futures prices from the existing Gloom Cloud history endpoint above net positioning, with a separate price date. This is visual market context, not a backtest or an investable continuous return. Mappings cover the major markets except the dollar index, SOFR and VIX futures; the verified cloud SR3 continuous-price request returns no data. Those and other unmapped products show positioning without a price panel; cash VIX and the cash dollar index are not substituted. History can start after a product's inception and source coverage limits still apply.

## Time and sales (TAS, QR)

`TAS AAPL` opens recent trade prints and `QR AAPL` uses the same pane for its NBBO tab. Trades retain source nanosecond timestamps, exact trade IDs, exchange codes, tape and condition codes. Quotes retain separate bid/ask venues and source sizes in round lots, not shares. NBBO is best-quote history, not Level 2 depth. Locked, crossed and one-sided observations stay visible without forcing a positive spread or inferring an aggressor side. Conditions are raw Alpaca SIP codes and can differ by tape.

The pane uses one Cloud HTTP bootstrap and the existing shared Cloud socket, backed by the existing Alpaca connection. Pro entitlement provides SIP in real time; delayed access uses delayed SIP with a fifteen-minute cutoff. Historical REST does not accept `delayed_sip`, so Cloud requests SIP observations with that cutoff enforced on the server. An absent endpoint has a clean unavailable state. Failed refreshes and disconnects preserve dated observations with a warning; changing account/feed clears both live and paused copies.

The observed buffer contains at most 1,000 trades and 500 quotes. Observed VWAP is sum(price times shares) divided by observed shares after corrections and cancellations. It is not full-session VWAP. Observed high/low and the last-price percentile use only retained prints; percentile needs at least 20 observations and uses midrank for ties. Date/window, source gaps and evictions remain explicit. Large-print highlighting means at least 10,000 shares; it does not claim institutional activity. Session high/low is separately calculated from completed regular-session minute bars, bounded to the same entitlement cutoff, with its own source timestamp. It can lag the live tape.

Space pauses/resumes the display while the bounded subscription continues. Opening a row freezes its details; leaving that detail preserves the paused window until resumed. The structured report exposes observations, session range, capacity, dropped counts, corrections/cancels and source dates. `gloomberb fn TAS AAPL --limit 100 --json` returns the latest Cloud snapshot. Quote venue/condition dictionaries and Level 2 order-book depth are not inferred.

`gloomberb shot TAS AAPL` and `shot QR AAPL` capture one dated tape bootstrap in the Bun process using the same session as the report. The desktop screenshot consumes that captured snapshot through its tape client without opening a browser-owned live socket. Source IDs, exact timestamps and access delays are unchanged; the footer marks the still image as a snapshot.

### Options scenario analysis

OSA sums the existing European Black-Scholes-Merton value and Greeks for each signed option leg. All premiums are per underlying unit; position values and sensitivities multiply each leg by its signed contract count and user-specified contract multiplier. P&L is marked position value less nominal entry cash flow. Theta is currency per calendar day, vega per volatility percentage point, rho per rate percentage point, delta underlying units and gamma delta change per one-unit spot change. Entry financing, transaction costs, exercise, assignment and adjusted deliverables are not inferred.

The scenario grid samples eleven spot levels and five evenly spaced dates from the valuation timestamp through the first option expiry. Dates use the shared 16:00 America/New_York expiry convention, including daylight saving, and retain fractional-day time value. The selected date is bounded to that interval. A parallel additive vol shift applies to every leg, with negative resulting volatility floored to zero and reported. The chart plots the selected-date P&L and the first-expiry P&L, including exact strike kinks in addition to the spot grid. Colors distinguish the selected date from expiry consistently. For different expiries, surviving legs retain their model time value at the first expiry; no path or historical settlement is invented for dates after it.

For a common expiry, breakevens and maximum profit/loss are solved on the exact piecewise-linear terminal payoff for all nonnegative spot prices. The solver includes spot zero, every strike and the right-hand tail. Unbounded profit and loss are explicit; finite maximum loss is a nonnegative loss magnitude. Boundaries of a flat zero-P&L interval are included among breakevens. Different-expiry positions have no reported exact terminal maximum or breakevens, since their future settlement paths have not been specified. Already-expired legs require removing the leg or restoring an earlier valuation timestamp.

Market inputs reuse the options coordinator used by OMON. The underlying quote must match the ticker/listing and be current; chain-expiry mismatches and stale inputs stay explicit. Treasury rates use the shared surface-tenor interpolation; dividend yield comes from fundamentals. Missing market assumptions require input rather than silently becoming zero. The chain builder copies a valid midpoint, falling back to the dated last trade when no midpoint exists; every premium and IV remains editable. Headless example strategies require valid two-sided quotes and provider IV for both legs. Fully specified typed positions are calculated without market fetches, and their screenshots preserve the same immutable inputs. Unknown currency is labeled UNKNOWN. Historical IV and assignment outcomes are unavailable.

Drafts use standard per-pane layout persistence. Named strategies use versioned local plugin state and restore independent copies, including original valuation timestamp, inputs and controls. Corrupt saved entries are skipped with a warning. These are analysis snapshots and do not create broker orders.

## Options valuation models

The American model uses a Cox-Ross-Rubinstein recombining log-spot lattice. Between dividend events, risk-neutral up/down expectations are discounted at the entered continuous rate, with continuous dividend yield retained as a separate carry input. Before each scheduled cash jump, the continuation value at `max(spot - cash, 0)` is interpolated linearly in spot on the after-dividend value grid. The intrinsic payoff competes with continuation at each exercise node, including immediately before a cash jump. This models an explicit stock-price jump rather than a spot-minus-present-value approximation. Same-time dividends are summed.

The requested default is 400 steps, with 1 to 2,000 accepted and bounded refinement up to 4,096 when carry requires it. Cash dates are mapped to the nearest tree time; spot interpolation and time discretization introduce numerical error, particularly around early-exercise boundaries. Increase the step count to assess convergence. Invalid risk-neutral probabilities trigger bounded step refinement, never probability clipping. Inputs that exceed the supported grid or numerical range return an error. Zero-volatility states use the deterministic carry path, cash jumps and exercise opportunities. At expiry, zero spot and zero strike, boundary payoffs avoid log/division failures.

Greeks use numerical repricing in the same model and schedule. Spatial bumps span the lattice spacing to reduce strike-alignment noise; sensitivities remain numerical approximations near exercise and dividend boundaries. Theta advances both time to expiry and the remaining cash-dividend dates. The selected-model IV solver uses the same exercise rule and dividends; premiums outside its identifiable price range remain unavailable. Values and Greeks are per underlying unit with the existing calendar-day, one-volatility-point and one-rate-point units.

Surface volatility reuses OVDV's cleaned midpoint fits and Treasury/parity carry. It explicitly loads the actual listed expiries bracketing the requested tenor, interpolates total variance at fixed forward log-moneyness, and rejects stale brackets or requests outside covered strikes/tenors. A fresh underlying quote anchors the observed surface; the calculator's hypothetical spot never moves that anchor. Source quote dates, actual source spot, fit methods, Treasury dates and failures remain in report metadata. Warnings cover the bracketing expiries and surface-wide failures, not the other expiries loaded alongside them. Brackets quoted in different New York sessions are flagged; seconds apart within one session are not. OVDV supplies a European-implied volatility assumption to either pricer; it does not calibrate an American cash-dividend model or discover future ex-dividend payments.

Future cash dividends must be entered. Continuous yield remains independent of the schedule: use zero continuous yield when the explicit schedule represents all intended distributions, so the same cash is not counted twice. Discrete dividends are active only in American CRR; European BS uses continuous yield. These models do not predict assignment, settlement fees or broker exercise decisions.

OVME screenshots freeze the entered assumptions and any resolved OVDV surface observation before rendering. The pane calculates from that snapshot, and screenshot verification independently reprices the selected model, all five Greeks and implied volatility from the captured inputs. It also checks the effective tree resolution, surface result, warnings and requested assumptions. Zero-valued outputs remain valid observations. An unavailable surface cannot be replaced with entered IV to certify a capture. This verifies that the screenshot represents the specified model; it does not establish the accuracy of the assumptions or market calibration.

## Estimate revisions (EM, EEO, GUID)

`EM AAPL` and `EEO AAPL` open consensus estimates by fiscal end and quarterly/annual frequency. Open a period to inspect its current EPS, dated change, high-low analyst range, current up/down revision counts and history. `GUID AAPL` opens cited qualitative guidance. The Surprises tab retains whether each source date means an announcement or fiscal period end. All new data is assembled by one Gloom Cloud endpoint, with independently partial sources and a five-minute cache.

Actual Cloud collection days and historical lookbacks supplied by Yahoo appear as distinct series. Provider backfills never count toward the 20 actual observation days required for a percentile. Current September 2026 coverage commonly has only five real collection dates, so percentiles are unavailable until enough daily snapshots accrue. A fiscal roll never joins current-quarter labels across different fiscal ends. Currency is part of the period identity; EPS units come from each period rather than listing currency.

Consensus change compares the same fiscal period and currency with the previous actual collection date. Percentage change divides by the absolute prior mean; zero has no percentage change. Analyst dispersion is the reported high-low range, not standard deviation. Up/down counts are current provider revision events over seven or thirty days, not distinct analyst votes or inferred direction from a changing average. No historical breadth percentile is invented. Historical revenue units were not stored separately, so only dated current revenue with its explicit currency is available. Legacy stored currencies and EPS accounting/ADR share basis remain unverified.

The guidance text is a dated public transcript summary linked to its source. A numeric guidance-versus-consensus gap requires matched metric, fiscal period, currency and accounting basis; without them it remains unavailable. A quote in a summary is not normalized into a forecast. Surprise is reported actual minus consensus estimate in their declared currency, and its percent divides by the absolute nonzero estimate. Surprise ranks compare matching currency and date type only.

History is bounded to the latest 4,000 stored rows within one year, with truncation and source failures disclosed. Missing periods stay missing; an absent endpoint has a recoverable state. Failed refreshes retain dated data. `gloomberb fn EM AAPL --json` exposes periods, actual snapshots, lookbacks, current revision counts, surprises, guidance sources and coverage separately. `--period YYYY-MM-DD --frequency quarterly|annual` pins a fiscal period in the pane and filters the consensus, revision history and breadth sections in headless reports. Invalid dates and uncovered fiscal periods produce an explicit error.

## Crypto

`CRYP` lists the largest crypto assets by market cap: up to 100 coins, with stablecoins on their own tab. Wrapped, staked and bridged copies of a larger coin, and pairs with under $1M of 24h volume, are left out so each market appears once. The universe, prices, 24h volume, supply, 52-week range and the last 30 completed daily closes come from one Gloom Cloud payload that the pane refreshes every 15 seconds.

On top of that, the rows on screen subscribe to the shared market socket like any watchlist. A real-time quote moves the price, day change, market cap, 7D, 30D and 1Y returns and the end of the sparkline as it arrives; a streamed quote older than the board's own price is ignored, so a delayed plan's 15-minute-old crypto quotes never replace a current price. The footer shows the time of the newest price. Streaming runs in the background whether or not the window has focus, and pauses only while it is hidden or minimized.

CHG% is the change since the 00:00 UTC open. 7D% and 30D% compare the price with the close 7 and 30 UTC days earlier, the same basis, so a 7D move includes today's. 1Y% uses the price a year ago implied by the source's 52-week change. VOL 24H is aggregate USD volume across venues. A missing close shows as a dash rather than a zero return.

Enter or click opens the coin in the ticker pane for its chart, quote and news. Column headers sort (numbers largest first), `r` refreshes, and narrow panes drop 1Y, the sparkline, 30D, volume and the name in that order. `gloomberb fn CRYP --json` returns the board; `--list stablecoin` returns the stablecoin tab.

### Relative rotation (RRG / GRR)

The default universe is the eleven US sector ETFs versus SPY. All prices come
through Gloom Cloud daily history and listing currency endpoints. History requests
are bounded to four concurrent calls; the app caches the assembled result for
30 minutes. Three years of daily closes support the warmup and one-year ranks.

This is a transparent relative-strength model, not the proprietary JdK indices.
At each completed week, let R be the asset close divided by the benchmark close.
Strength is `100 * R / SMA13(R)`; momentum is `100 * strength / strength[4 weeks ago]`.
The 100/100 intersection defines Leading (both above), Weakening (strength above,
momentum below), Lagging (both below) and Improving (strength below, momentum
above). Values on an axis are Neutral. Trails default to six completed weeks;
longer histories never expand the plotted axes. Each path retains its chronological
edges even when strength reverses direction.

The latest eligible benchmark daily observation in each completed Friday-ending
week defines the required date for peers. The current week is excluded. The final session must match the existing published NYSE/Nasdaq closure calendar;
a Thursday is accepted only for a verified Friday closure. Unknown venues and years
are unavailable, and a missing expected weekly close is flagged. Earlier history
outside the published calendar does not enter the model. Missing or contradictory closes break continuity; no forward-fill,
zero price or cross-currency comparison is allowed. Seventeen consecutive matched
weekly closes are needed for momentum. Returned history identity and currency are
checked against the requested listing and quote metadata. Stale histories keep
explicit source warnings and observation dates.

Percentiles use the shared midrank helper over the preceding 365 days through the
metric date, require 20 valid weekly values and report sample counts; fewer than
52 are flagged. Identical observations rank at 50, and future observations cannot
enter a rank. Provider closes are price observations; dividend reinvestment is not
assumed, so this is not a total-return ranking. Delisted instruments, long gaps,
calendar mismatches and missing listing currency remain unavailable.

Live source verification on September 22, 2026 returned USD identities for SPY and
all eleven sector ETFs and 765 daily observations per instrument, September 1,
2023 through September 21, 2026. The last completed rotation week was September 18.
## Portfolio risk depth (PORT, MARS)

`PORT` and `MARS` open risk depth for a local portfolio. Previously saved Analytics panes retain their overview; switch the pane's View setting to Risk depth. Current holdings and imported evidence stay local. Cloud receives listing symbols for batch quotes and daily histories, plus the existing FRED requests. The market cache refreshes after two minutes and retains dated data for up to one day after a failed refresh. An absent Cloud endpoint preserves explicit unavailable states. Screenshots freeze the same model used by the report.

The default market analysis is a daily rebalanced basket at fixed current equity weights, denominated in USD. It is a price-return estimate of the current composition, not the account's historical performance. Every holding must have a USD listing mark and complete, calendar-qualified daily prices. The mark is the current quote; when no current quote arrives or the quote is stale, it is the latest completed daily close, and the holding's evidence says so (`at 2026-09-21 close`). A US listing venue (NASDAQ, NYSE, NYSE American, Arca, Cboe) establishes USD when no quote confirms it. Factor proxies use their own listing venues; MTUM lists on Cboe BZX. Missing prices do not disappear from concentration weights; missing history blocks basket estimates without renormalizing surviving positions. Shorts, derivatives, foreign currency and leveraged financing are outside this basket model. Cash balances and dated account leverage are not inferred from current lots. Current concentration covers held equities, using absolute gross marked exposure for HHI, effective holdings and largest-one/five shares; signed net values remain available in the report.

Daily returns match both interval endpoints. Published exchange-session calendars reject missing trading days, unsupported years/venues and ambiguous timestamps. The loader requests an eighteen-month buffer, omits today's incomplete observation and requires a recent completed day. Current market inputs were verified through Gloom Cloud on September 22, 2026: SPY, IWM, IWD, IWF, MTUM, IEF and HYG each returned 265 dated closes through September 21. The quoted listing and currency must match any metadata returned with history. Daily prices do not establish total returns including distributions or corporate-action reinvestment.

Risk uses 60 consecutive matched sessions: compounded basket/SPY returns, their arithmetic difference, maximum drawdown from a unit wealth of one, sample annualized volatility and tracking error using square root of 252, one-day historical VaR 95%, and expected shortfall. VaR is the nonnegative loss at the nearest-rank fifth percentile of daily returns; expected shortfall averages the worst ceiling(5% times sample size) observations. Neither is scaled to another horizon or fitted to a normal distribution. One-year percentiles compare the latest statistic with same-horizon rolling estimates using the shared midrank helper, requiring at least 20 valid rolling observations. Overlapping samples are not independent. Current-composition concentration, pair correlations, user scenarios, imported account periods and Greeks have no comparable stored history, so their percentiles remain unavailable.

Factor regressions independently estimate an intercept and beta against these ETF price-return proxies: market SPY, size IWM minus SPY, value IWD minus IWF, momentum MTUM minus SPY, rates IEF and credit HYG minus IEF. They are not academic factor portfolios or a joint explanatory model. Beta uses 60 matched daily returns and reports sample count and R-squared. Holdings correlation also matches daily interval endpoints. Independent stress scenarios multiply empirical beta by an index return, a DGS10 change in percentage points (100 basis points equals one point), or a VIXCLS point change. Stress regressions use up to 126 equity sessions, require 60 matched observations and preserve the last matching source date. They are linear scenarios, not forecasts, and cannot be added together as a joint stress. FRED DGS10 and VIXCLS were verified with latest usable dates September 18 and September 21 respectively.

### Local account evidence

Current lots, broker fills and generic broker cumulative-return fields cannot establish complete deposits, withdrawals, dated sector weights or an unambiguous TWR/MWR series. Import explicit version 1 JSON through the pane's `i` action (clipboard), its Local evidence JSON setting, or the CLI `--evidence` option. Evidence is private pane configuration and must match the selected portfolio ID and currency. All amounts use that currency; returns and weights are fractions, not percentages. A minimal illustrative ledger and attribution book are:

```json
{
  "version": 1,
  "portfolioId": "main",
  "currency": "USD",
  "source": "Dated account statement",
  "performance": {
    "flowTiming": "end-of-day",
    "externalFlowsComplete": true,
    "observations": [
      {"date": "2025-01-02", "value": 100, "externalFlow": 0},
      {"date": "2025-07-01", "value": 160, "externalFlow": 50},
      {"date": "2026-01-02", "value": 180, "externalFlow": 0}
    ]
  },
  "attribution": {
    "method": "brinson-fachler",
    "startDate": "2025-01-02",
    "endDate": "2026-01-02",
    "benchmark": "Declared sector benchmark",
    "sectors": [
      {"sector": "Technology", "portfolioWeight": 0.6, "benchmarkWeight": 0.4, "portfolioReturn": 0.15, "benchmarkReturn": 0.10},
      {"sector": "Industrials", "portfolioWeight": 0.4, "benchmarkWeight": 0.6, "portfolioReturn": -0.05, "benchmarkReturn": -0.02}
    ]
  }
}
```

Positive external flow means a deposit and negative means a withdrawal. Opening NAV is the starting investment and has zero flow. Include every flow with its after-flow valuation, using the declared end-of-day convention; an omitted or intraperiod unvalued flow invalidates that evidence. TWR links `(closing NAV - closing flow) / previous NAV`; drawdown uses its unitized wealth, so deposits cannot manufacture performance. Annualized MWR solves dated investor cashflows on actual/365, including starting NAV and terminal liquidation. Only a conventional single sign change is accepted, with a unique root in the supported -99.99% to 10,000% range; ambiguous roots leave MWR unavailable without discarding TWR. Dates must increase, NAV/pre-flow NAV must be positive, and input is bounded to 10,000 valuations, twenty years and one MB.

Single-period Brinson-Fachler attribution uses declared beginning sector weights and matching period returns for both books, including cash and unclassified sectors so each weight sum is one. Allocation is `(portfolio weight - benchmark weight) * (sector benchmark return - total benchmark return)`; selection is `benchmark weight * (portfolio sector return - benchmark sector return)`; interaction is the product of weight and return differences. Effects reconcile to arithmetic active return. This is the declared benchmark book; no SPY sector holdings or historical account weights are invented.

### Option exposure

PORT reuses OSA's European pricing and Greeks. Broker-held options require one exact broker conId, local option symbol, expiry, strike, side, multiplier and currency, plus matching dated Cloud spot, option contract/IV, Treasury rate and dividend yield. Missing or ambiguous contract inputs remain unavailable and prevent a complete option-book total. Requests are confined to the Cloud provider; no app-side third-party fallback is introduced.

Alternatively, add `options: {"scope":"imported","positions":[...]}` to local evidence, with fully specified OSA `ScenarioPosition` snapshots (`symbol`, optional `exchange`, `currency`, `spot`, decimal `rate`/`dividendYield`, millisecond `asOf`, and `legs` containing `id`, `side`, signed integer `quantity`, `strike`, Unix-second `expiration`, `price`, decimal `volatility`, and explicit `multiplier`). The imported option book remains separate from broker holdings. Snapshots older than four calendar days or with future timestamps/mismatched currency are unavailable. Dollar delta multiplies share delta by spot; gamma P&L is one half gamma times a uniform one-percent spot move squared; vega is currency per volatility point, theta currency per calendar day and rho currency per rate point. Share deltas are not added across different underlyings. Exercise, assignment, American exercise premium and adjusted deliverables are not inferred. Imported snapshots are assumptions, not current market quotes.
## Equity criteria screener (EQS)

EQS queries an indexed snapshot of the Cloud's covered, stored financial listings.
It does not claim to enumerate every listed security. The backend projects existing
financial, statement, FINRA, insider and 13F observations in bounded batches;
a screen query does not fan out to upstream providers. Snapshots refresh every
15 minutes and expire after two hours. Cursors bind the exact query, sort and
snapshot; rows from different generations cannot be combined. Saved definitions
are account-owned and use revision checks for concurrent edits.

Every numerical observation retains native unit, source date, collection date,
known filing availability date, source and availability state. The displayed
percentile is cross-sectional within the covered universe, never a historical
percentile. Observation dates vary between metrics and issuers. Monetary fields
require a single currency for filtering and ordering; no implied FX conversion
is performed. Missing values fail numeric comparisons. `Unavailable` means the
field lacks evidence; it does not mean the financial quantity is zero. Provider
multiples, market capitalization and dividend yield carry no observation date; the
pane shows their collection date in the muted colour instead of inventing a source
date.

US primary listings are named by their SEC conformed name; other listings keep the
provider name. Symbols differing only by share-class separator are one listing, and
OTC or foreign order-book lines of an issuer with a US primary line in the same
currency are omitted. Sector and industry come from stored provider profiles and
are missing for many smaller listings, so a sector criterion covers only listings
with a stored profile.

Growth compares matching annual periods with compatible currency and a positive
base. Margins use reported revenue and their corresponding profit measure.
Insider purchase/sale counts reflect observed filings and are lower bounds;
partial cache coverage cannot establish zero activity. Therefore these counts
support positive lower-bound or availability conditions, not equality or upper
bounds. FINRA quantities and changes retain the source's reporting period, and
13F activity retains its filing period and coverage limitations.

Results can remain dated after a failed refresh. Changing the query or account
clears the previous result immediately, aborts pending pagination and rejects its
late response. Export pins the displayed snapshot and is capped at 5,000 matches;
refine a broader screen before exporting. An absent endpoint or migration has an
explicit unavailable state.

## Backtests (BT)

BT runs on the ticker's daily history from the market data coordinator (all
available sessions, one bar per UTC date). Indicators use the chart studies'
formulas: simple and exponential moving averages seeded by a simple average,
Wilder RSI, MACD as the fast minus slow EMA with an EMA signal line, and
Bollinger bands from the simple average plus or minus k population standard
deviations. `highest(n)` and `lowest(n)` use the n sessions before the current
one, so a close can break out of its own range. An undefined value (warmup)
never satisfies a comparison, and a cross needs both sessions defined.

Evaluation starts after the longest indicator warmup and within the chosen
lookback. The strategy is long or flat and fully invested when long. A rule
true at a session's close fills at the next session's open, or its close when
no open is recorded, so no signal trades on the bar that produced it. Entry is
checked when flat and exit when long. Each fill pays the cost per side on its
price. Cash earns nothing. Buy-and-hold buys at the same first fill with the
same entry cost and is never sold. An open position is marked at the last
close, net of an exit cost, in the trade list and at the last close in equity.

Returns are price returns: dividends, splits beyond the provider's adjusted
history, borrow, taxes and slippage beyond the stated cost are not modelled.
CAGR needs at least half a year. Volatility and Sharpe use daily returns
annualised with 252 sessions and a zero cash rate. The rolling comparison
counts 252-session windows ending on each session after the first year and
needs 20 windows. Fewer than ten closed trades are flagged as too few to judge
a hit rate. Presets use states (`>`, `<`), so a test that begins inside a
regime is invested from the first fill; `crosses` waits for a fresh signal.

## Known coverage gaps

These Bloomberg functions have no Gloomberb pane yet because the free or
licensed sources behind the platform cannot support them honestly:

- Corporate bond monitor: FINRA TRACE prints are public, but mapping issuers to
  CUSIPs needs a security master the platform does not hold.
- Swap curve: DTCC SDR publishes swap trades, not a dated par curve; building one
  needs curve fitting and instrument conventions that are not in place.
- World government bond monitor: FRED carries other sovereigns' long rates only
  monthly (OECD), too coarse for a daily monitor. `GC` covers US Treasuries.
- ETF holdings and flows: issuers publish holdings in per-issuer files with no
  common format; creation and redemption flows are not published freely.
- Supply chain and M&A databases: no free structured source.
- Level 2 order book: the market data plan supplies trades and NBBO only; `TAS`
  and `QR` show what is available.
