# Catalyst calendar and litigation

`CATL` opens the market-wide catalyst calendar. `CATL PFE` narrows it to a company. `LITI MSFT` opens company litigation, enforcement and antitrust cases. International exchange-qualified tickers use the same ticker identity as other research functions. The company description pane has a Catalysts research tab; the earnings calendar (`EVTS`) links to CATL from its menu and selected-company footer.

Calendar shows published announcement, effective and deadline dates. The date-basis column distinguishes them. A date reported only to the month or year remains at that precision. Upcoming selects future effective dates and deadlines. Search and filters cover type, agency, country, sector, status and date window. Country describes the event's jurisdiction, not necessarily the company's domicile. Unresolved parties stay unlinked; unlinked events remain available market-wide. Filters apply on the server, including rows beyond the first page; scrolling loads further events.

Changes lists observed revisions. An unchanged fetched document does not create another revision. The observation date is the time Gloom detected the change, not a claim about when the underlying event occurred. An empty change feed means no matching revisions have been collected yet.

Enter opens evidence and history. Evidence includes primary document links, original quotes when available, confidence, date precision, named parties and identity resolution. History keeps prior revisions and changed fields, loading older revisions as you scroll. Clinical enrollment charts appear after two dated observations, in participants, with estimated and actual counts kept separate and missing counts left as gaps; open a revision to inspect its evidence. `O` opens the selected revision's primary document. `D`, `F` and `G` open the linked company's description, financial analysis and chart. `T` switches between company catalysts and litigation. Expected impact, when present, is explicitly a **Model opinion**, with its supporting quote and confidence. It is distinct from source-reported facts.

CATL and LITI are Pro functions. Free accounts see up to three events with current evidence and limited history. Pro sees all collected rows and revisions. These are public-record datasets, not an assurance that every legal or regulatory matter has been disclosed or linked correctly. A missing event is not evidence that none exists.

The calendar groups events under the month of the date it shows, in date order, and the change feed groups revisions by the day they were observed, newest first, with the first changed field shown from and to.

## Alerts

`A` opens the existing event alert wizard. Choose a catalyst target: company ticker, event type, agency, country, or portfolio and watchlists. Alerts require Pro and poll the change feed every five minutes while the app is running. They include first observations and later revisions after the rule's creation time. The local cursor and per-rule revision IDs survive restarts and suppress duplicate delivery. Pausing stops matching; resuming starts from the resume time. Status and failures appear in the event alert pane. Delivery is local to terminal, desktop and web sessions; mobile push delivery is not included. Closing the app stops delivery until it runs again.

## Coverage and interpretation

The same schema covers US, EU and other jurisdictions. The backend coverage response records enabled sources, failures, observation dates and event counts. Actual availability depends on source terms, keys and public publication. Sources include public clinical, medicine, competition, enforcement, rulemaking, export-control, sanctions and tariff records where collection is enabled. Source documents remain the authority. No approval decision, precise date or equity-price direction is inferred from the absence of a record.

Ticker linking follows explicit identifiers and audited aliases to corporate parents. An event linked to a parent does not establish materiality. Sector filters operate only where a sector is available. The service preserves original language and links; the pane does not translate source evidence or convert date precision into invented dates. Technical provenance, source identifiers and model details remain available in the structured output.

## Headless usage

```sh
gloomberb fn CATL --json
gloomberb fn CATL PFE --type clinical --upcoming --json
gloomberb fn CATL --country EU --from 2026-10-01 --to 2026-12-31 --dateField deadline --json
gloomberb fn CATL --tab changes --limit 100 --offset 0 --json
gloomberb fn LITI MSFT --json
gloomberb fn CATL --event EVENT_ID --json
```

Structured output preserves event IDs, revision IDs, primary URLs, evidence, all three source dates, observed timestamps, parties, confidence, coverage and preview access metadata. `limit` and `offset` page through the server dataset; `complete` is false for previews and partial pages.

The Changes view shows the before and after values of an observed revision. Party
link changes name the company and its old and new ticker match, including match
confidence. A link update is a resolution change, not a new clinical or regulatory
event. The headless Changes view uses the same summary and retains the structured
revision fields in JSON output.
