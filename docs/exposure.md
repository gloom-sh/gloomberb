# Exposure engine

`EXPO` analyzes operating exposure to a scenario across a typed holding list, a local watchlist, or a local PORT portfolio. Gloom Pro includes all requested holdings and paths up to four hops. The free preview keeps the first holding at depth one, with its original weight.

- `EXPO AAPL NVDA TSM` creates an equal-weight basket.
- `EXPO AAPL=60% NVDA=50% TSM=-10%` uses signed fractions of NAV. `AAPL=0.6` and `AAPL=60%` mean the same thing. Every weight must be explicit when any weight is explicit. Shorts, leverage, cash and residual financing are preserved; weights are never normalized.
- `EXPO PORT:portfolio-id` selects local positions. Press **S** to enter the account NAV in the portfolio's configured currency. Positions use available quotes, or independent broker market values when quotes are missing, converted using available FX. An unavailable valuation blocks calculation rather than dropping or reweighting a holding. Derivatives need explicit underlying exposure weights; their notional is not inferred from the contract price.
- `EXPO WATCH:watchlist-id` creates an equal-weight basket from that local watchlist. This is a hypothetical basket, not the account's actual weights.

**S** opens the scenario and holdings form. The library covers Taiwan disruption, China/Europe demand, a China semiconductor export restriction, China tariffs, oil, rates, USD, TSMC supply and Microsoft capex. Choose a preset in the query bar; the form edits its kind, target, shock size, product restriction and depth. Rate shocks use basis points; other shocks use percent. Positive and negative shocks are supported. Enter submits; Escape cancels. Advanced JSON supports multiple shocks and explicit transmission assumptions.

**Table** shows each holding's estimated operating exposure range and scenario stress, with the denominator, reporting period and disclosed (`dsc`), estimated (`est`) or unknown status. Multiple reporting periods, denominator bases and shocks remain separate rows. An asterisk marks an incomplete bound. Select a row and press **E** or Enter for its source evidence and missing information. **Paths** traces matching relationships and preserves each hop's percentage denominator, quote, source tier, confidence, as-of and reporting period. **Portfolio** shows signed holding-weighted operating stress and gross concentration by country, supplier or customer. Its percentages are NAV-weighted operating percentage points, not a stock-return or portfolio-P&L forecast. Concentrations may overlap and must not be summed. The chart compares only the selected row's denominator and reporting period.

**Drivers** lists current KPIs, active guidance, credit balances, rates, maturities and covenant headroom. Values retain their reported currency, units, fiscal period, qualifiers and conditions. Commitments remain separate from drawn debt, and unavailable headroom stays unknown. **E** opens the original evidence; **A** opens KPIS, GUIDE or CRDOC for the selected driver. Each source applies its own preview limits. These disclosures provide context for the scenario; they do not supply an inferred shock sensitivity.

**V** opens what we could not see; **O** opens the selected source. **C**, **D**, **F** and **G** open the holding's supply chain, description, financial analysis and chart. Every row is keyboard- and mouse-accessible, and tables export through the pane menu. Holding lists and scenario state are marked private in portable shares.

## Reading the estimates

The engine combines the current stored geographic and product revenue disclosures, the SPLC relationship graph, and available company profile metadata. Entities and filing counterparties can be global. Actual coverage is limited to stored, source-supported disclosures; listing country and company domicile are location associations, not a substitute for revenue, production, import-origin or invoicing-currency evidence. No source match does not mean zero exposure. The evidence details retain the actual source dates; the footer explicitly labels the analysis date. Portfolio stress covered weight includes only holdings with complete bounds; unknown gross weight also includes partially quantified holdings.

Disclosed direct percentages keep that classification at the component level. Scenario impacts, regional allocations, product/geography intersections and multi-hop products are estimates. A Greater China revenue share gives Taiwan a bounded share from zero to that regional total when the filing does not disclose Taiwan separately. A two-hop proportional estimate is shown separately from its conservative overlap bound. Ranges describe disclosure overlap and assumptions, not statistical confidence intervals. Different shocks must not be added without a joint model.

The Evidence column says whether each exposure is disclosed, estimated or unknown, and marks a partial bound where the result covers only part of what the scenario touches. The range chart above the table puts the holdings that share the selected row's shock, basis and period on one scale; a disclosed point is a tick, an estimated interval a band.

Country and counterparty scenarios apply a proportional change to supported operating shares. Commodity, tariff, rates and FX scenarios require a sourced sensitivity or an explicit user assumption before they can produce a quantitative operating stress. Missing sensitivity, unknown hedging, substitution, production geography, anonymous counterparties, graph limits and unquantified links stay in the unknowns. KPI, guidance and credit observations come from current stored disclosures. Conflicting actuals, withdrawn guidance and closed credit instruments are excluded; missing or failed sources remain visible. Latest available figures are not a historical point-in-time backtest, and corrections follow the underlying sources.

## Custom scenarios and headless output

```sh
gloomberb fn EXPO 'AAPL=60% NVDA=50% TSM=-10%' --scenario taiwan-disruption --depth 2 --json
gloomberb fn EXPO 'PORT:portfolio-id' --nav 250000 --cash 0.1 --scenario oil-up --json
gloomberb fn EXPO 'WATCH:watchlist-id' --scenario china-demand --json
gloomberb shot EXPO 'AAPL NVDA' --tab paths --width 1280 --height 540 --output exposure-paths.png
```

An explicit transmission assumption is user evidence, never a filing disclosure. For example, this assumes 20–40% of the interest-expense denominator is rate-sensitive, with a factor between 0.5 and 1 per percentage-point rate change:

```sh
gloomberb fn EXPO AAPL --custom '{"label":"Rate stress","shocks":[{"id":"rates","kind":"rate","target":"interest rates","changeBps":100,"transmission":{"basis":"interest_expense","exposurePct":{"low":20,"high":40},"factor":{"low":0.5,"high":1},"direction":1}}]}' --json
```

JSON returns all holding measures, per-hop evidence and quotes, portfolio measures, concentration evidence, coverage and unknowns. `complete: false` means the requested analysis is a preview or has unresolved coverage, even when useful rows are present. The same request contract is available through `POST /cloud/exposure/analyze`; the scenario library is `GET /cloud/exposure/scenarios` and dataset status is `GET /cloud/exposure/status`. Ask Gloom and the Cloud MCP exposure tools use these same sourced results.
