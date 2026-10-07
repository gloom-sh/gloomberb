# Company KPIs and management guidance

`KPIS <ticker>` opens company operating metrics. `GUIDE <ticker>` opens structured management guidance. Both follow exchange-qualified tickers and linked ticker panes. These are Pro datasets; Free has a fixed latest preview, including evidence, with remaining observations and history locked.

KPIS has a latest-value Table, a Chart with a selector for each definition, basis, currency, scope and fiscal frequency, and an Evidence ledger that retains superseded or conflicting observations. Changes compare previous disclosed observations with the same period kind. Percentage metrics change in percentage points; other metrics show percentage change with an absolute prior denominator. Bounded and approximate values keep their qualification and are excluded from exact growth arithmetic and trend lines. A missing calendar date remains missing. Series with known fiscal year and quarter use a categorical fiscal axis; they do not invent calendar dates. Changes can compare those fiscal periods within the same series.

Each value carries its unit in the same cell. On a wide pane the Table adds a Trend sparkline for a series with at least three comparable observations that have calendar period ends. Prior changes are coloured by the metric's favourable direction, so a lower cost reads green. Basis and Scope appear only when a row is not the reported, consolidated figure. In GUIDE, a raise reads green, a cut red and a withdrawal amber.

GUIDE has a Tracker of current ranges, a Chart of dated guidance for one metric and target period, a History of later actuals against guidance, and Evidence. A numeric raise or cut describes the range's direction, while Beat and Miss reflect the metric's economic preference. Lower costs can therefore be a beat. Open-ended, approximate, qualitative and withdrawn guidance keep the source wording and conditions. A later actual is shown only when the backend can reconcile its definition, period, currency, basis and scope.

Select a row and press **Enter** or **E** for its evidence stack. **O** opens its primary source. **C** opens the other company disclosure function. The pane menu opens description (`DES`), financial analysis (`FA`) and the price chart (`G`). Existing `GUID`, `EM`, `EE` and `ERN` retain their own estimates and earnings views; their pane menus link to KPIS and GUIDE. Charts require two comparable observations. Smaller panes keep their tables and reduce the chart through the shared chart layout.

## Definitions and provenance

The canonical dictionary covers SaaS, consumer, retail, industrial, semiconductor, energy, banking, insurance, property, pharmaceutical and transport disclosures. Each observation retains its native unit and currency, fiscal and calendar period, accounting basis, segment or product dimensions, disclosure time and confidence. Evidence includes the document URL, publication date, original language, literal quote and match offsets. Press releases and transcripts can support the same observation without duplicating it. Corrections supersede earlier records and remain inspectable in Evidence; unresolved conflicts do not enter comparable trends.

Sources can include stored US releases, annual and quarterly filings and earnings call transcripts, Korean corporate filings through OpenDART, and company IR releases. The schema also accommodates ESEF and EDINET. Adapter availability and observed company coverage are separate: an empty company or period is not proof of zero activity. EDINET requires a pending key. Extraction is controlled independently by the backend and defaults off until enabled by the operator. Methodology, source coverage and audit results are documented in the platform PR; this app does not imply those pipelines are active in production.

## Data coverage

| Function | Free | Pro | Coverage and time |
| --- | --- | --- | --- |
| KPIS | Fixed latest preview with evidence | All stored series, history, revisions and provenance | Available company disclosures, native currencies and fiscal calendars |
| GUIDE | Fixed latest preview with evidence | Ranges, guidance history, actual matches and provenance | As issued; later actuals only when comparable |

EQS exposes selected consolidated latest KPI values and revenue/EPS guide changes when these are available. Missing or ambiguous dimensions, currency mismatches and unresolved conflicts are not silently converted into screening values. Monetary KPI thresholds use the screen's native currency, with no inferred FX conversion.

## CLI and point-in-time reads

```sh
gloomberb fn KPIS CRM --json
gloomberb fn KPIS CRM --metric arr --basis reported --asOf 2026-09-30 --json
gloomberb fn GUIDE DAL --from 2025-01-01 --to 2026-12-31 --json
gloomberb shot KPIS CRM --tab chart --width 1280 --height 540 --output kpis.png
gloomberb shot GUIDE DAL --tab evidence --width 720 --height 360 --output guidance.png
```

JSON includes structured observations, the metric dictionary, complete evidence, revision identifiers, coverage and access metadata. `asOf` applies a publication cutoff so later corrections and actuals cannot leak into earlier research. Date, basis and metric REST filters require Pro; the Free preview remains fixed. The app takes authenticated snapshots before screenshots and verifies that the rendered rows match those inputs.
