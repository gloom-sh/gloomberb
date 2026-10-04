# Pro wall teaser experiment

`wall_teaser` compares the existing Pro walls (`control`) with those same walls
plus a small preview (`teaser`). The Upgrade and Manage account actions retain
their placement ids and behavior. This changes neither access nor prices.

The platform registry controls enrollment. Signed-in Free accounts use their
account id on web, desktop and terminal; signed-out web visitors use the
existing anonymous browser id. An account's saved first arm wins. Signed-out
desktop and terminal users send no wall-view or exposure events, even with a
website handoff id. They remain outside the experiment and its baseline. Bots, Do Not Track
and Global Privacy Control are excluded. The initial wall remains usable while
the exposure answer arrives; refused or failed requests preserve the old wall.
The platform registry starts with `running: false`; neither PR enables the test.
That switch stops new-session enrollment without an app release. An accepted
arm stays stable for the current browser/app session, as does its exposure.

## Wall inventory and summary sources

These are the 12 existing Pro-wall placements. Counts are preferred only when
the wall has a ticker and the public route has data for that listing.

| Placement | App location | Free summary |
| --- | --- | --- |
| `risk-wall` | `risk-factors/pane.tsx`, through `useProFeatureWall` | Risk count and filing date from the same SEC risk-report service as `/public/risks/*`. |
| `exec-wall` | `executives/pane.tsx`, through `useProFeatureWall` | Number of available proxy statements and latest filing date, using the same service as `/public/proxies/*`. |
| `ek-wall` | `filing-events/pane.tsx`, through `useProFeatureWall` | Count of available 8-K filings in the last 90 days and latest filing date from the filing-events index. |
| `calls-wall` | `earnings-calls/pane.tsx`, list wall | Count of publicly listed calls and latest call date from the public transcript index. |
| `calls-transcript-wall` | `earnings-calls/pane.tsx`, detail wall | The same public call count and date for the selected ticker. No transcript is returned. |
| `jobs-wall` | `jobs/pane.tsx`, `HiringProWall` | Open role count and last successful read date from the company's own careers system, already collected by Gloom Cloud. |
| `diag-wall` | `research/equity-diagnostic-pane.tsx` | Sample only. A count of generated findings would imply paid diagnostic coverage and is not an honest free source summary. |
| `most-wall` | `market-movers/session-body.tsx` | Sample only; a market-wide wall has no selected issuer. |
| `flow-wall` | `scanner/flow-pane.tsx`, through `ScannerDeniedState` | Sample only; no live options prints are requested. |
| `hilo-wall` | `scanner/hilo-pane.tsx`, through `ScannerDeniedState` | Sample only; no live highs or lows are requested. |
| `srch-wall` | `research-search/pane.tsx` | Sample only; neither search text nor results go to the summary route. |
| `team` | `cloud/team/pane-sections.tsx`, `CreateTeamForm` | Sample only; no team, membership or account data is used. |

Paths above are relative to `src/plugins/builtin/`. The team form keeps its
existing `team` upgrade placement instead of introducing a separate denominator.
Every ticker summary also has a frozen sample fallback for absent coverage,
unsupported listings or an unavailable summary. A short pane omits the teaser
so its existing actions remain visible.

The unauthenticated `GET /public/wall-summary?wall=...&symbol=...&exchange=...`
route returns only `kind: "counts"` and fixed label keys paired with counts or
ISO dates. It is rate limited and cached for five minutes, including empty
results. It reuses existing reads, does not start extraction or transcription,
and never returns paid text, prices, compensation, job details or personal data.
The app never requests a Pro endpoint to obtain a preview.

## Samples and summary hooks

The small catalog lives beside the shared wall code in
`src/plugins/builtin/shared/wall-teaser-catalog.ts`. Each summary adds one dim
line naming what Pro adds: changes to risks, executive pay, filing items,
transcripts and guidance, or roles by function and location. The hook uses the
English i18n helper and makes no trial offer.

All samples are authored layouts with no provider payload, historical value,
invented number, personal name or research text. The only readable row labels
are AAPL, MSFT, NVDA, AMZN, TSLA, META, AMD and GOOGL where the real pane has a
ticker column. Other fields are placeholders, including names, dates and titles.
Prose samples retain their section shape with an issuer label and masked lines;
Team uses masked workspace content. There is no third-party sample dataset to
redistribute.

Tables fill the available height with at most eight rows. They preserve the
real pane's column order and show the full set when it fits; less important
columns give way at narrow widths. The catalog uses the actual labels, including
MOST's EVENT, FLOW's EXP, SRCH's DATE and HILO's NEW HIGH / PRICE / COUNT.

| Wall | Table columns, when all fit |
| --- | --- |
| MOST | #, TICKER, NAME, LAST, GAP%, CHG%, PRE VOL, RVOL, VWAP%, FLOAT, EVENT |
| FLOW | TIME, TICKER, TYPE, STRIKE, EXP, SIDE, SIZE, PREM, V/OI |
| HILO | NEW HIGH, PRICE, COUNT |
| SRCH | TICKER, TYPE, DATE, TITLE, MATCH |
| EXEC | NAME, TITLE, EQ%, TOTAL |
| CALLS | TICKER, COMPANY, DATE, PERIOD, LENGTH, TONE |
| JOBS | TICKER, COMPANY, OPEN, 30D, POSTED 30D, NEW 7D, TOP FUNCTION, TOP COUNTRY |

The Sample badge and headers stay readable. Placeholder widths vary
predictably by row and column, so rerenders do not move them. Terminal values
are shade cells with no readable digits; desktop and web use real CSS-blurred
bars. Samples are passive and leave the existing actions visible and focused.

## Measurement

All events use `/activity/research`, with the existing `surface`,
`authenticated`, `product_area: "gloomberb_terminal"` and event-id deduplication.
The new wall measurement adds no query, ticker, label text or payload contents.
The ticker is sent only to the data route needed to return its free summary.

| Event | Properties | Frequency |
| --- | --- | --- |
| `experiment_exposed` | `experiment: "wall_teaser"`, `variant: "control"` or `"teaser"`; attribution property `exp_wall_teaser` | Once per eligible unit per app/browser session when a Pro wall is visible, in both arms. |
| `wall_viewed` | `placement`; `teaser_kind: "summary"`, `"sample"` or `"none"` only for the teaser arm; `exp_wall_teaser` when assigned | Once per placement, account/visitor and session, including signed-in accounts and identified web visitors outside the experiment. `none` includes insufficient room. |
| `upgrade_intent` | Existing `placement`; `exp_wall_teaser` when assigned | Existing upgrade-action behavior is retained. |
| `workspace_opened` | Existing surface/account attribution, including `exp_wall_teaser` when assigned | Existing session milestone, used to read returning use. |

Growth's primary metric is users with `upgrade_intent` divided by exposed wall
viewers, compared by `exp_wall_teaser` and, where useful, matching `placement`.
Read the returning-use guardrail from later `workspace_opened` sessions for the
same exposed account or browser cohort. `wall_viewed` also supplies the placement
baseline outside the experiment; it must not be mistaken for an exposure.

Wall-view counts cover signed-in accounts on any surface and web visitors with
an anonymous id. Signed-out desktop/TUI users send nothing new and are not part
of this baseline, including installations with a website handoff id. No native
identifier is minted. Existing non-wall milestones keep their existing rules.

## What remains outside this change

The 33 `SignInWall` uses remain phase 2. Signed-out screens that already choose
`SignInWall` retain that gate and do not become Pro walls. Thesis drafting and
reviewing use an action-level Pro notification while manual thesis work remains
free. They have no full-pane Pro wall, so turning them into one would change
gating and is outside this experiment. Existing trial status-bar experiments,
upgrade-dialog copy, Stripe copy and prices are unchanged.
