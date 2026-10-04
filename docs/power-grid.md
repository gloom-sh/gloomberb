# Power and grid capacity

`POWER` opens power interconnection and large-load research. `POWER NEE` narrows it to a listed developer or utility resolved by the entity directory. Exchange-qualified tickers retain their venue. POWER is a **Pro dataset**; free accounts receive up to three records per section with a locked remainder and limited history.

The Queue table explores public interconnection registers by country, grid region, fuel, status, project, developer and utility. Columns include reported MW, proposed in-service date, location and mapped tickers. Click a column heading to sort the full matching dataset. The figures follow the selected record’s register and region; overlapping registers are not summed into a national total. Additional records append as you scroll. A missing capacity is `--`; zero remains zero. Regional summaries and portions of connection applications can be separate records, so a record count is not necessarily a count of unique physical projects.

The tabs cover:

| Tab | Coverage and interpretation |
| --- | --- |
| Queue | Generation and storage interconnection applications. Active is an application state, not a promise of delivered supply. The Benchmark filter selects historical compilations separately. |
| History | Recorded snapshots of queued MW by region, fuel and status. The complete matching history loads before a selected row charts its series; the table adds MW change and records with missing capacity. A line appears after three distinct dates with complete reported capacity; missing capacity creates gaps. |
| Outcomes | Entry-year cohorts grouped by region, each with a bar of completed, active and withdrawn projects, the counts and the rates over all eligible project records in that cohort. Selecting a status does not change the denominator. Summary and capacity-segment records are excluded. |
| Loads | Public large-load requests, approvals and operating connections. Datacenters are distinguished from other loads only where the source states the class. |
| Utilities | Large loads grouped by the stated utility or grid, with a bar of operating, approved and requested MW, the figures themselves and resolved company tickers. An application can have several capacity segments; record counts retain this distinction. |
| Capacity | Existing or planned generation capacity. The Context filter switches between generation capacity, reported generation in MWh, and utility context such as peak demand, sales and retail-sales revenue. A generation record has a Monthly generation detail view with the twelve reported months. Negative net generation is retained for consuming assets, including storage. Native metrics retain their original units in the detail. |
| Coverage | The state, dates and record counts for each public jurisdiction and dataset, including pending, failed and disabled sources. Open a row for its current limitation and primary link. |

Open a row with Enter or a click for dates, units, exact source cells, the primary document, confidence and revision history. Proposed, requested, completed and withdrawn dates remain distinct, including quarter-, month- or year-only dates where the source has no day. The observed timestamp records when Gloom captured the source; published as-of and reporting period are separate. A missing published date is never replaced with the capture date. Corrections retain older revisions; the evidence view loads all available revision pages. Confidence describes evidence and entity matching, not the probability a project will complete.

`O` opens the selected source. For a mapped company, `D`, `F`, `G` and `S` open DES, FA, a chart and SPLC. `C` opens GPU rental prices. `T` opens TBO where installed, passing the selected ticker. TBO has independent coverage; its data does not feed POWER. Actions are also in the pane menu.

Columns that would only repeat a default on every row, such as a project-level record scope or zero records with missing capacity, are left out until a row differs. The Queue figures carry the selected region's active, completed and withdrawn MW as one bar.

## History and comparability

Direct-source history uses Gloom's observation times. When a public register overwrites its file, the previous capture remains available. Published benchmark series use the period actually reported by the historical compilation and retain the time the archive was ingested. Benchmark records do not add to current direct-source totals. Sources, fuels, statuses and series are kept separate; a change is calculated against the previous observation of the same series. A coverage expansion or a source correction can move a total without representing a new grid application.

Capacity is in MW unless a native metric explicitly supplies another unit, such as MWh for generation or sales. Storage power is not storage energy. Hybrid projects can combine technologies, and total capacity is not a sum of every component unless the source defines it that way. Large-load requested, approved and operating MW describe different states; none is recognized revenue or a utility sales forecast. Company links do not turn a request into a contractual obligation.

The backend supports US grid queues, historical US queue benchmarks, US generation and utility context, and public European connection registers behind the same schema. Coverage depends on each publisher's lawful, keyless access and publication cycle. Registers that require credentials, explicitly prohibit retrieval or fail validation remain visibly unavailable. ENTSO-E is disabled until a token is supplied. The Coverage tab is the current operational ledger, with exact observation dates and counts; absence of records is not evidence of zero activity.

## CLI and REST

```sh
gloomberb fn POWER --json
gloomberb fn POWER NEE --tab queue --json
gloomberb fn POWER --region PJM --fuel storage --status active --json
gloomberb fn POWER --tab history --historical --json
gloomberb fn POWER --tab outcomes --country US --json
gloomberb fn POWER --tab utilities --json
gloomberb fn POWER --tab coverage --json
gloomberb shot POWER --tab queue --width 1280 --height 540 --output power-queue.png
```

The headless report traverses all available pages for the selected table. JSON keeps primary URLs, raw evidence, dates, entity confidence, revision identifiers, coverage and access limitations. Preview accounts receive only the server-authorized subset.

Cloud routes are `GET /cloud/power/board`, `GET /cloud/power/history`, `GET /cloud/power/projects/:id` and `GET /cloud/power/coverage`. Board filters are `country`, `region`, `fuel`, `status`, `kind`, `symbol`, `search`, `sourceId`, `loadClass`, `historical`, `offset` and `limit`; sorting uses `sort` and `direction`, including native generation, sales, retail-sales revenue and peak-demand metrics. History also accepts `from` and `to` against published periods or observed dates as appropriate. Project revision evidence accepts `offset` and `limit` and reports the full revision count. URL-encode project identifiers, including colons. Project revision history and the full dataset require Pro. Cloud authentication and entitlement rules apply equally to pane and REST requests.
