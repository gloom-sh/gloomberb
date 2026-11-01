# Research attention

`ATTN` shows the tickers Gloom users are researching. `ATTN 6758:JPX` opens one listing's published history. The same dataset appears in Gloom Trending on Home and DES, and in EQS through **Research attention hours (Pro)** and **Abnormal research attention (Pro)**. Existing saved workspaces keep their layout; open **Gloom Trending** from the command bar to add the compact daily panel.

This is a Pro dataset. A free account gets the same three leading published tickers across the board and ticker endpoints, three groups per section and the latest history point. Pro accounts get all published rows and up to 29 days of hourly history. A ticker outside the preview cannot be retrieved by changing the ticker argument.

## Views and periods

Ranking orders tickers by rounded researcher-hours. Abnormal orders available latest-hour z-scores. Sectors and Countries sum the same published ticker observations, grouped by listing metadata. Selecting a group filters the ranking. History charts published hours for the selected listing, with gaps wherever no hour was published. Evidence shows the publication period, delay, threshold, rounding, market timestamps and related dated news.

Above the ranking, four figures summarise the whole board for the period: total research hours, the number of tickers with a latest-hour z-score of 2 or more, and the top sector and country by share. Share draws as a bar measured against the largest row. The free preview leaves the figures out, since it holds only its own rows.

**Now** is the latest eligible completed UTC hour. **Today** starts at UTC midnight and ends with the latest eligible hour. **Week** is the trailing 168 hours. The publication lag is at least one hour after a bucket ends. The footer shows publication time and stale state; counts are never described as live.

A research hour means one eligible contributor researched one ticker within one hour. Opening several supported functions for that ticker in that hour does not increase its contribution. Summing hours does not measure distinct people over a day or week. Research hours are rounded, so small differences and ranks should not be interpreted as precise estimates.

The **latest-hour z-score** compares a ticker's latest eligible published hour with its own same UTC hour over the preceding 28 days. It needs at least 14 privacy-qualified historical periods and a nonzero baseline standard deviation. Otherwise the score is unavailable. Today and Week change research counts, not the z-score's hourly basis. Missing hours are not zero and are not interpolated. History may remain available when a ticker has no current publishable observation; its current count remains unavailable.

Price change and relative volume retain independent observation times in Evidence. News provides contemporaneous context, not a claim that attention caused a price move. Click a news item to open its source. **D**, **F**, **G** and **N** open DES, FA, chart and news for the selected listing; **E** opens Evidence and **O** opens this methodology there.

## Coverage and quality

Coverage is global wherever the instrument registry can resolve a listing. Listing-qualified identifiers keep similarly named securities on different exchanges separate. Sector and country come from the listing registry; unknown metadata stays unknown. Counts reflect participating Gloom users and supported research actions, not all investors, ownership, trading volume or investment intent. Small and unpopular listings may have no published observations.

Every hourly ticker bucket must meet the distinct-contributor threshold before publication (default 20, configurable upward). Groups, rolling windows and history use only released ticker buckets. Neither the app nor the API reveals suppressed counts or their contributor totals. Hourly observations are retained for 35 days, covering the 28-day baseline and a calculation buffer; the API exposes the latest 29 days. Small permanent release records prevent an expired hour from being republished. Listing metadata is stored separately from compact hourly counts. Publication records include their period, source, units and methodology version. The app caches responses separately by signed-in account and entitlement and clears denied data after account changes.

Collection ships disabled on the server. The separate **Attention Counts** setting is on by default and counts an account only after the app has shown it a one-time notice; switching it off stops counting, and **Usage Counts** does not affect it. See the [privacy review](attention-privacy.md) for the default, the notice and retention. No historical activity or analytics events are backfilled. Until enough contributors produce qualified hours, the product shows a collecting state. The shipped code includes no collected dataset.

## Listing

Until the dataset publishes, ATTN is unlisted: command-bar search, Help, `gloom catalog` and search, the plugin directory and chat suggestions leave it out, as do the EQS field and metric pickers for its two fields. Typing `ATTN` still opens it, `gloom fn ATTN` and `gloom shot ATTN` still run, and the Attention Counts setting and collection are unchanged. To list it again, set `ATTENTION_LISTED` in `src/plugins/builtin/attention/listing.ts` to true and run `bun run docs:snapshot` once the site lists ATTN.

## Command line and REST

```sh
gloom fn ATTN --window today --json
gloom fn ATTN 6758:JPX --tab history --json
gloom fn ATTN --tab sectors --window week --json
gloom shot ATTN --tab ranking --width 1280 --height 540 --output attention.png
```

Authenticated REST endpoints are `GET /cloud/attention?window=now|today|week` and `GET /cloud/attention/:symbol?window=now|today|week`. Responses contain the dated rows, sector/country groups, privacy policy parameters, coverage, entitlement, and methodology link. The read API is independent of the Attention Counts setting; contributing is never required to read published data. Headless output preserves the same entitlement and provenance. CSV exports visible table values with units in their headers.
