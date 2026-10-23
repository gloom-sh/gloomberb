# Hiring momentum and app attention

`HIRE` opens the covered-company hiring board; `HIRE NET` opens a company. `APPS` opens public app rankings; `APPS META` narrows them to a listed parent. Non-US tickers retain the exchange, for example `APPS 0700:HKEX`. Both functions also appear in the company research pane. They are Pro datasets, with latest values and three rows per section available as a free preview.

Enter opens a company or an individual app’s rank history for the exact store, country and chart. Within APPS, **C** opens the listed parent. **E** opens evidence, **O** opens the primary source, and **D**, **F** and **G** open description, financials and the price chart. **A** switches between hiring and app attention for the selected company. Research tables support sorting and CSV export; individual app histories retain reverse date order. The screen `EQS` includes hiring open roles, weekly net adds, remote percentage and z-score, plus app attention score, rank velocity, rating drift and rating-count growth.

## Hiring

Table compares covered companies; Chart shows observed weekly history with additions, removals and net changes. Mix groups open requisitions by role family, seniority, country or location and includes observed signals. Peers compares mapped employers; Evidence retains original role titles, locations, primary links, observation dates and snapshot revisions.

Open roles are requisitions observed on public career boards, not employees hired, vacancies in an economy or headcount. Subsidiaries roll up only through evidenced company ownership. A decline can reflect a closed posting, a changed source or incomplete coverage. Deltas require comparable complete snapshots. Remote share uses known work modes as its denominator and shows that count beside it (`100% of 5 known`); unknown modes remain unknown. A posting counts as known only where its source states remote, hybrid or on-site work, so a share over a few roles can read high for a company whose other roles name only a city. Unclassified titles and unknown countries are retained, not silently discarded.

History starts with retained observations; legacy daily counts are identified separately and do not acquire invented role-level evidence. HIRE retains the first successful observation per source and UTC week for 52 weeks, including corrections within that window. Sparse history has an explicit collecting state. A new location means a newly observed posting location, not a confirmed physical office. Z-score surge and freeze signals require sufficient comparable history and cannot be inferred from a single capture. Immutable posting versions are reused across weekly snapshots.

Weekly additions, removals, net change and z-score appear as columns and figures once consecutive complete captures can give them; until then the tables show what the first capture observed. Signals read in tone: a surge green, a freeze red, a company still collecting quiet. Role-family shares in Mix draw as bars. APPS leaves out its seven-day columns and figures the same way until a week of captures exists, and a company's own apps do not repeat its ticker.

### Moves

Moves compares each covered company's new roles in the latest complete week (Monday to Sunday, UTC) with its own measured weeks before it, up to 13, and with its peers'. On the board, Show picks own moves (the default), one direction, or every measured company. Each row gives the week's new roles, the average before, the pace against it (`3.4x`) and its z-score, the peers' median pace and the role family that moved most (`Operations +209`). A company is **Accelerating** or **Slowing** when its pace stands out from its own weeks (z-score at least 3, at least 1.5 times or at most half its average, ten roles or more) and from its peers' (1.5 times their median pace either way); one whose industry moved with it reads **With peers**, and a measured week with no move **In line**. Peers are the company's industry, else its sector, else every covered company. A move of 50 roles or more is shown with a **Check** when one day carried three quarters of its new roles (**One-day batch**, such as a seasonal posting run) its boards were read too seldom that week to tell (**Few reads**), or it is more roles than the company's boards ever held open (**Over board size**); it ranks after the other moves and does not alert. The board ranks moves by z-score up to 10, then by roles off the average. **E** opens why: the sentence and every number behind it, with whether the move alerts. Enter opens the company on its Moves tab: its weeks, with why a week is not measured; the role families and titles behind the move; and the postings first seen or closed that week, each linking to the employer's posting. **N** opens an event alert on the company's next move; it fires once a later pass, 12 hours on, still reads the same move, so a week some boards have not finished reading on Monday never alerts alone.

Free shows the first three own moves, whatever Show picks, and counts the rest. A free company read of one of those three has its move without the weeks behind its average; any other company shows its latest week's counts and leaves the move to Pro. Either way three postings each side, no weekly history.

A week is measured only when nothing in the collection changed: a board's first read, a board added later, a truncated or collapsed read, a gap between reads, a rediscovered or restored board and a vendor-wide change each leave the week out, and the week's row says which. New roles are first seen postings, not hires.

### Expansion and Anomalies

Two more tabs read the same weeks. **Expansion** lists a company's first roles in a new country (**New country**) or in a new city of a country it already hires in (**New city**). **Anomalies** lists one place (**Place spike**) or one role family (**Family spike**) far above the company's own weeks, and a role family it never posted before (**New family**). Show picks one kind.

"Never" goes back to the company's first read, and every first says since when: the Since column and the board's **Never means** figure (`since Sep 17`). A first needs three weeks of reads before it, at least 30 earlier postings with 80% of them placed (or naming a city, or with a role family), and at least three new roles under two titles. A first is dropped when most of its roles were dated more than a week before the company's first read, and a week whose boards wrote their places anew gives no new city. A spike needs a z-score of at least 3, twice its average, ten roles or more over it, and a share of the company's roles at least twice its usual: so a company that doubled everywhere spikes nowhere. A city carrying most of its country's rise stands in for the country. A spike in a week Moves flagged, or on a board read too seldom to tell, is shown with a **Check** and ranks last.

A company's week gives no signal at all when it is not measured, when its boards were read for under three weeks before it, or when it posted far more roles than were new (re-listed roles); the board counts these under **Held**, and the company's tab says which. Role families are those of the Mix tab; no model is asked anything.

**E** opens why: the sentence, every number behind it (the weeks before for a spike, the earlier postings for a first), where the roles are, their top titles and the first postings, each linking to the employer's page. Enter opens the company on the same tab: its signals this week and earlier, and under View, the postings behind this week's. Free shows each tab's first three and counts the rest; a free company read opens only those and counts the others, with no earlier weeks.

## App attention

Table shows each app, country and chart basis separately. Chart follows company attention history; Markets compares countries and cross-country rank spreads; Peers compares listed parents; Evidence retains source and ownership links with capture revisions. The country, chart and history-window controls apply to the request together. Lower ranks are better; positive rank changes and velocity mean improvement.

Coverage follows the public source registry. App Store public free and paid Apps feeds are keyless; gaming-chart coverage is unverified. Grossing feeds are unavailable. Google Play observations, where publicly readable, are unranked and have no invented chart position. Unmapped apps stay visible. A ticker none of the observed apps is mapped to says so in place of its empty tables, `COIN has no mapped apps in the observed App Store and Google Play charts.`, rather than reading as the free preview's cap; with a country or chart filter set, the empty table names the filter instead. Coverage is global where sources permit, including separate country storefronts; a missing country or a missing app does not establish zero attention. Daily observations are retained for 730 days, with shared immutable metadata and source evidence.

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
gloomberb shot HIRE --tab moves --moves slowing --width 1280 --height 540 --output moves.png
gloomberb shot HIRE RIVN --tab moves --view drivers --width 720 --height 360 --output rivn.png
gloomberb shot HIRE --tab expansion --kind new_country --width 1280 --height 540 --output expansion.png
gloomberb shot HIRE STT --tab anomalies --signals-view postings --width 720 --height 360 --output stt.png
gloomberb shot APPS META --tab evidence --width 720 --height 360 --output apps.png
```

Headless bundles accept `--limit` and `--offset`; `metadata.nextOffset` identifies the continuation and `complete` stays false until the final page. They include the displayed tables and full authorized provenance, revisions, coverage, units, limitations and preview state. REST uses `/cloud/hiring`, `/cloud/hiring/:symbol`, `/cloud/hiring/moves?signal=moves`, `/cloud/hiring/moves/:symbol`, `/cloud/hiring/signals/expansion?kind=all`, `/cloud/hiring/signals/anomalies?kind=all`, `/cloud/hiring/signals/company/:symbol`, `/cloud/app-attention/board` and `/cloud/app-attention/:symbol`. Individual app timelines use `/cloud/app-attention/app/:store/:appId?country=US&chart=free&days=90`, with explicit chart exits retained as null ranks. The deployment begins accumulating history from real captures; the UI never fabricates a chart to fill an empty history window.
