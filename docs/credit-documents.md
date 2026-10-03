# Credit documents

`CRDOC FICO` opens an issuer's documented capital structure. `COVN FICO` opens the same workspace on Covenants. Credit documents is a Pro dataset. Free accounts see up to three rows per section, together with every fact supporting those rows; Pro includes all stored instruments, terms and amendment history.

Capital shows outstanding drawn or principal balances, currency, maturity, coupon or margin, commitments, drawn balances, ranking and change-of-control puts. Select an instrument to inspect its current terms. Select a term to read the verbatim quote, source filing, reporting period, confidence, language and character span. **O** opens the selected filing. The instrument's **Amendment history** view retains superseded observations and shows the fact each revision replaced.

Covenants shows contractual thresholds, matching reported values, test dates and headroom. Select a row for the exact rule and calculation status. Missing headroom means the calculation could not be supported; it does not mean zero headroom or compliance. The source may state compliance without disclosing a value from which headroom can be calculated.

Maturities shows calendar-year final maturities, one native currency at a time. The chart and instrument table share selection. Amounts from different currencies are never added. **M** opens `DDIS` for the issuer's separately reported debt-maturity schedule; its fiscal buckets can differ from contractual calendar maturities. **C** opens `CDS`, and **D**, **F**, and **G** open description, financial analysis and the price chart.

Screen is a global query over stored, supported instrument evidence. Change **Headroom below** and **Springing within** to inspect low headroom or conditional maturities approaching within the selected number of months. A springing maturity is conditional: read its quoted trigger before treating it as an expected payment. Empty results can reflect limited current evidence, not an absence of credit risk. Screen rows open the instrument's evidence. This is an on-demand risk screen, not a background notification subscription.

## Coverage and interpretation

The initial live ingestion path reads SEC debt notes, credit-agreement exhibits, indentures, amendments and new-issue prospectuses. The schema preserves global identifiers, ISO currencies, source language and local dates. OpenDART, EDINET and ESEF adapters depend on available access and document support; an unsupported venue has no implied coverage. Filing evidence is dated and may be older than current market conditions.

Every contractual fact has a literal quote matched to its source text after Unicode and whitespace normalization. Offsets refer to UTF-16 positions in that fetched document. Normalization does not turn a paraphrase into evidence. Source confidence describes extraction support, not a probability of default. A correction or amendment creates a new observation and retains the superseded one.

Original issuance amounts are separate from current outstanding principal. The maturity wall uses supported drawn or principal balances and final maturity dates. Instruments without comparable currency, amount or maturity are omitted, and retired instruments are excluded. Where an instrument amortizes, its final-maturity allocation is a coarse view; consult the amortization evidence and `DDIS` for scheduled payments. Do not read a missing instrument as zero debt.

Headroom is `(maximum − reported) / maximum` for maximum tests and `(reported − minimum) / minimum` for minimum tests, expressed as a percentage of the positive threshold. The reported financial metric must match the covenant's definition, borrower scope and test date exactly. Generic EBITDA does not substitute for adjusted covenant EBITDA. Applicable step-downs retain their original evidence. Unobservable add-backs, conditional activation, mismatched dates, and financial observations more than 190 days old withhold current headroom. Negative supported headroom is labeled a breach of the numerical test; waivers and legal interpretation still require reviewing the documents.

Preview calculations contain only evidence visible in that preview. Preview totals are not company-wide totals. The footer records the disclosure date and stale/error state; warnings are available from the warning indicator.

## CLI

```sh
gloomberb fn CRDOC FICO --json
gloomberb fn COVN FICO --tab covenants --json
gloomberb fn CRDOC FICO --tab screen --headroom 20 --months 12 --json
gloomberb fn CRDOC FICO --instrument '<instrument-id>' --view history --json
gloomberb shot CRDOC FICO --tab maturities --width 1280 --height 540 --output credit-maturities.png
```

JSON preserves fact identifiers, source links, quotes, offsets, confidence, currencies, calculation reasons and every derived row's supporting evidence identifiers. `complete` is false for a partial dataset, truncated screen or locked remainder. Screenshot capture freezes the payload before rendering and verifies it against the pane's semantic evidence.
