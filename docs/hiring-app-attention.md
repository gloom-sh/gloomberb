# Hiring momentum and app attention

`HIRE` opens the covered-company hiring board; `HIRE NET` opens a company. `APPS` opens public app rankings; `APPS META` narrows them to a listed parent. Non-US tickers retain the exchange, for example `APPS 0700:HKEX`. Both functions also appear in the company research pane. They are Pro datasets, with latest values and three rows per section available as a free preview.

Enter opens a company or an individual app’s rank history for the exact store, country and chart. Within APPS, **C** opens the listed parent. **E** opens evidence, **O** opens the primary source, and **D**, **F** and **G** open description, financials and the price chart. **A** switches between hiring and app attention for the selected company. Every table supports sorting and CSV export. The screen `EQS` includes hiring open roles, weekly net adds, remote percentage and z-score, plus app attention score, rank velocity, rating drift and rating-count growth.

## Hiring

Table compares covered companies; Chart shows observed weekly history with additions, removals and net changes. Mix groups open requisitions by role family, seniority, country or location and includes observed signals. Peers compares mapped employers; Evidence retains original role titles, locations, primary links, observation dates and snapshot revisions.

Open roles are requisitions observed on public career boards, not employees hired, vacancies in an economy or headcount. Subsidiaries roll up only through evidenced company ownership. A decline can reflect a closed posting, a changed source or incomplete coverage. Deltas require comparable complete snapshots. Remote share uses known work modes as its denominator; unknown modes remain unknown. Unclassified titles and unknown countries are retained, not silently discarded.

History starts with retained observations; legacy daily counts are identified separately and do not acquire invented role-level evidence. Sparse history has an explicit collecting state. A new location means a newly observed posting location, not a confirmed physical office. Z-score surge and freeze signals require sufficient comparable history and cannot be inferred from a single capture. Revision history supersedes corrected snapshots without erasing their evidence.

## App attention

Table shows each app, country and chart basis separately. Chart follows company attention history; Markets compares countries and cross-country rank spreads; Peers compares listed parents; Evidence retains source and ownership links with capture revisions. The country, chart and history-window controls apply to the request together. Lower ranks are better; positive rank changes and velocity mean improvement.

Coverage follows the public source registry. App Store public free and paid feeds are keyless. Grossing feeds are unavailable. Google Play observations, where publicly readable, are unranked and have no invented chart position. Unmapped apps stay visible. Coverage is global where sources permit, including separate country storefronts; a missing country or a missing app does not establish zero attention.

Ranks are ordinal positions within a bounded chart, not downloads, revenue or market share. Attention scores summarize observed rank positions and remain sensitive to source composition. Rank changes compare the same app, country, chart and category across captures. Rating-count growth is distinct from written-review growth. Missing ratings, missing comparisons and delisted apps remain missing rather than becoming zero. Source gaps and sparse history are exposed through the warning footer and REST provenance.

## Access, freshness and coverage

Both panes fetch through authenticated Gloom Cloud routes. Free previews keep source evidence and show the standard Pro upgrade action; full history and remaining observations require Pro. Persistent caches are partitioned by account and entitlement. A failed refresh retains the last valid response, marks it stale and exposes the failure. The pane shows observation dates, not a manufactured current timestamp.

Use the API coverage routes for current deployment coverage: `/cloud/hiring/coverage` and `/cloud/app-attention/coverage`. No fixed company or country coverage claim is embedded in the app: it reads the captured payload. Additional countries and public sources can be added server-side without a new client.

## CLI and REST

```sh
gloomberb fn HIRE NET --json
gloomberb fn APPS META --country US --chart free --days 90 --json
gloomberb fn APPS --app-id 6446901002 --store app-store --country US --chart free --days 90 --json
gloomberb shot HIRE NET --tab mix --width 1280 --height 540 --output hiring.png
gloomberb shot APPS META --tab evidence --width 720 --height 360 --output apps.png
```

Headless bundles accept `--limit` and `--offset`; `metadata.nextOffset` identifies the continuation and `complete` stays false until the final page. They include the displayed tables and full authorized provenance, revisions, coverage, units, limitations and preview state. REST uses `/cloud/hiring`, `/cloud/hiring/:symbol`, `/cloud/app-attention/board` and `/cloud/app-attention/:symbol`. Individual app timelines use `/cloud/app-attention/app/:store/:appId?country=US&chart=free&days=90`, with explicit chart exits retained as null ranks. The deployment begins accumulating history from real captures; the UI never fabricates a chart to fill an empty history window.
