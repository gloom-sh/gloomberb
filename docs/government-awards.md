# Government awards

`AWARDS` opens the procurement feed. `AWARDS LMT` opens a verified company's history. The function is a **Pro dataset**: free verified accounts receive a small preview of each section and evidence; Pro accounts receive the collected history and additional records.

Feed shows date, legal recipient, verified ticker, currency, face value, obligated amount, ceiling, agency, performance period and jurisdiction. Search contracts or filter by ticker, jurisdiction, currency, record type and range in the query bar. Long feeds load additional records as you scroll. Company adds monthly award cohorts and cumulative awarded obligations. Agencies ranks contracting authorities. Sectors ranks recipient companies within published industry classifications, with a Sectors view for sector totals. Opening a verified company drills into its company history; unresolved recipients remain named entities in the feed. Events shows awards relative to the listed company's annual revenue when a comparable annual filing exists.

Enter or **E** opens contract evidence, the legal-entity match, revenue denominator, preserved revisions, subawards, modifications and government/customer relationships. **O** opens the primary record. **D**, **F**, **G** and **S** open the verified company's DES, FA, chart and SPLC; **C** opens the earnings calendar. Recipients without verified matches retain their names and do not receive invented ticker links. Standard refresh, pane export, keyboard and mouse navigation work across terminal, desktop and web.

## Amounts and history

Amounts retain their source currency. No implicit exchange-rate conversion combines different currencies. Prime awards, subawards, modifications and notices remain distinct. The Obligated column is a cumulative total for that award; a modification is a transaction, and its action value is never added to a prime award's balance. Ceiling is the possible maximum, not committed funding. Missing values remain unavailable, not zero. REST and JSON preserve exact decimal strings; chart and compact display values are rounded for readability.

Company history groups the latest available obligation for each award by its original award month, then accumulates those cohorts. This is a retrospective picture of awarded obligations, not a cash-flow series, accounting revenue, deliveries, remaining contractual backlog or the obligation balance known at each historical date. A later revision can therefore change an earlier cohort. The chart only combines one currency and record type and requires at least three monthly observations. Currency selection changes the chart and table together. The table retains individual contracts and performance dates.

Publisher scopes also remain separate: an overlapping contract notice in UK and European systems is not assumed to be an additional contract. The Scope filter selects a single publication system using its procurement coverage label. The company chart names one scope through its figures; agency and sector shares use that same publication scope, currency and record type. Cross-system deduplication is not implied.

Agency share is computed within one publication scope, currency and record type. Company share is measured within its sector and those same dimensions. Sector classifications follow the original procurement schema and may be absent; opening a sector total shows the companies in that sector. Annual-revenue percentages require a published award face value, the same currency and an identified annual filing; the detail records the revenue period, filing date, numerator basis and source. Lifetime obligations and ceilings do not create event alerts. An award's multiyear value divided by annual revenue is an exposure comparison, not a forecast of a single year's revenue. An absent event may reflect missing financial evidence rather than a small award.

Enable **New awards above 1% of annual revenue** in pane settings or quick settings for in-app event notifications. This is opt-in and runs while the pane is visible and polling. Opening a pane, enabling alerts or changing its scope first establishes a baseline. Subsequent refreshes notify only previously unseen records first observed after that baseline, awarded in the last seven days and above the threshold. Historical backfills and revisions to an already-seen award do not send duplicate alerts. This is not an unattended or mobile push subscription.

## Coverage and evidence

The common schema supports US federal prime awards and subawards, award transactions, European public procurement, UK notices and other national open portals. Actual availability depends on successful collection and published fields. The server exposes source status and dated backfill ranges in REST/JSON metadata. Incomplete scopes produce a warning in the pane footer. The presence of an adapter is not a claim of complete country coverage, and a missing award or subcontractor is not proof that no contract exists. Source accounts, keys, transport restrictions and access policies can leave an adapter disabled or blocked; the backend status command is authoritative.

Retained history is bounded to 120,000 current records and 180,000 revisions. Listed-company prime awards and subawards are kept for up to 1,095 days; unlisted awards for 365 days, modifications for 90 days and notices for 30 days, measured from the last material observation. Superseded revisions are kept for up to 365 days, with at most 12 revisions per award. Capacity limits take precedence over these windows, removing the oldest unlisted records first. Collection gaps and retention removals leave coverage partial; charts and aggregates describe only retained records.

Structured official records carry a primary-source link and observed timestamp. Text-derived evidence, when enabled, must match the captured source. A listed-parent mapping carries its method, confidence and separate supporting URL. Corrections append preserved revisions linked to their predecessor; records are not silently replaced. Government/customer and subcontractor links are award evidence and remain separate from filing-derived SPLC relationships.

Published search summaries and award detail records can refresh on different dates. Where fields come from different observations, the evidence view shows each amount's own as-of date and supporting URL. Bulk latest-transaction records may date a cohort by performance-period start rather than an award signature; the Date basis column and evidence label identify this distinction. Such records are not a complete history of every transaction.

## CLI and REST

```sh
gloomberb fn AWARDS --json
gloomberb fn AWARDS LMT --tab all --currency USD --json
gloomberb fn AWARDS --tab agencies --jurisdiction US --from 2023-10-01 --json
gloomberb fn AWARDS --tab events --json
gloomberb fn AWARDS --award '<stable-award-id>' --json
gloomberb fn AWARDS --cursor '<nextCursor>' --limit 100 --json
gloomberb shot AWARDS LMT --tab company --currency USD --width 1280 --height 540 --output awards.png
```

`GET /cloud/awards` accepts `ticker`, `jurisdiction`, `currency`, `awardType`, `agency`, `sector`, `from`, `to`, `query`, `cursor` and `limit`. It returns rows, agency/sector aggregates, monthly history, revenue-comparable events, revision-aware provenance and coverage metadata. `GET /cloud/awards/detail/:id` returns evidence, revisions, subawards, modifications and contract relationships. `GET /cloud/awards/status` reports source collection status. Routes require a verified Gloom Cloud account and apply the existing preview/Pro entitlements.

The function catalog and HELP data-coverage card identify AWARDS as Pro. CLI results carry `complete: false` when source coverage, pagination or preview access limits the result; `nextCursor` allows explicit continuation. Headless output preserves published decimal amounts and every source URL.
