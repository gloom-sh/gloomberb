# Attention Counts privacy review

Attention Counts is an optional contribution to ATTN and Gloom Trending. It is a new kind of collection, separate from Usage Counts and crash reports. It is off for new and existing installations unless the user explicitly enables `telemetry.attention`.

## Consent and scope

Run **Attention Counts** in the command bar. Enabling it opens a consent dialog describing the ticker data, authenticated contribution limit, publication threshold and how to stop. Cancelling leaves collection off. Disabling takes effect immediately and clears unsent counts. The command is shared by terminal, desktop and web. The equivalent explicit CLI setting is:

```sh
gloomberb config get telemetry.attention
gloomberb config set telemetry.attention true
gloomberb config set telemetry.attention false
```

The setting belongs to this installation or browser profile. It is absent from cloud sync's allowlisted configuration, and a remote configuration cannot enable it. An intentionally imported local configuration backup may contain the setting. `GLOOMBERB_NO_TELEMETRY=1`, `DO_NOT_TRACK=1`, browser Do Not Track and Global Privacy Control override it. Usage Counts being enabled does not imply consent. Turning Usage Counts off does not change an explicit Attention Counts choice.

Only an authenticated, email-verified account can contribute. Signing out, losing verification or changing accounts drops queued data. Nothing collected before consent, before authentication or on a previous account is sent after those states change. Viewing ATTN does not require contributing.

## What leaves the app

The app records successful explicit opens of a security description, a security chart, a quote monitor or an options chain, plus successful watchlist additions. Explicit Chart and Options tab selections count. Restoring a workspace, mounting a pane, quote updates, background requests, automated opens and opening ATTN do not count. Headless CLI data reads do not install a collector.

The authenticated request is `POST /telemetry/attention` with this complete body shape:

```json
{"consent":true,"events":[{"symbol":"VOD:LSE","action":"des"}]}
```

Allowed actions are `des`, `chart`, `quote`, `option_chain` and `watchlist_add`. Symbols retain the public listing or exchange qualifier where known. The server resolves them against its instrument registry and suppresses ambiguous or unknown instruments. The body contains no user, device, session, install, portfolio or watchlist identifiers, no position sizes, search strings, event timestamps, or workspace content.

**Collection is authenticated, not anonymous at the network boundary.** The normal Gloom session credential accompanies the request. The server also receives the connection IP and user agent. These are not included in the public attention dataset. No analytics SDK or third-party analytics endpoint is involved in this collection path. Existing Usage Counts, search reporting and crash reports have their own documented behavior.

## Client storage and deletion

There is no persistent ticker event log. At most 100 distinct ticker/action pairs wait in memory, with duplicates collapsed. The app attempts one batch after 60 seconds. A batch older than two minutes or belonging to an earlier UTC hour is dropped; offline failures and server refusals are never retried. The client does not use unload beacons or a keepalive request to prolong collection after closing.

Turning consent off synchronously erases the queue, invalidates pending asynchronous ticker opens and aborts an in-flight request where the transport supports it. An already transmitted request cannot be recalled. In particular, the desktop's existing RPC transport cannot withdraw a request already handed to its native process; that request has a five-second deadline. Published anonymous totals cannot be attributed back to an account for subtraction.

## Server controls and publication

Production collection defaults off behind the server's attention collection switch, independent of client consent. The endpoint requires the literal consent boolean, validates the entire body, rejects identifiers and unknown fields, limits batch size, rejects bots and honors privacy headers. It never forwards ticker events to the existing usage analytics pipeline.

The server counts at most one contribution per account, ticker and UTC hour, capped at 20 distinct tickers per account per hour. The same account across devices does not add another contribution. Contributor deduplication uses a domain-separated hourly HMAC key and an account-derived HMAC digest in a separate unlogged staging table. No account, device, session or IP identifier is stored there. This digest is pseudonymous while the staging data and server secret exist; it is not a claim of irreversible anonymisation.

Staging expires after six hours by default, with a maximum of 24 hours. Finalization deletes its staging rows atomically, including suppressed buckets; expiry cleanup continues even when collection or publication is disabled. Staging must be excluded from logical backups. Unlogged staging is excluded from PostgreSQL WAL replication.

The public dataset contains no contributor identifier or digest. A ticker/hour is only released at least one hour after the bucket closes, with at least 20 distinct contributors. Both the lag and threshold can be raised. Counts are rounded down to multiples of five, without random noise. Published hourly releases are immutable. Action-level breakdowns and small buckets are not released. Published totals are research attention among contributors, not all Gloom users, holdings, orders or investment intent.

See the platform PR's privacy review for the exact ephemeral deduplication scheme, retention and operational switches. The accompanying policy wording is a separate reviewed diff; collection remains disabled pending owner review and rollout.

## Review and limitations

The collector's tests exercise opt-in defaults after configuration migration, malformed consent, cloud sync exclusion and malicious remote opt-in, account changes during asynchronous work, opt-out during in-flight sending, queue erasure, automation suppression, bounded batches, stale-hour suppression, no retries and transport allowlisting of every serialized field. Backend tests separately verify release thresholds and aggregate-schema identifier exclusion.

Threshold suppression and rounding reduce disclosure risk; they do not provide a formal differential privacy guarantee. Coordinated verified accounts, outside knowledge and comparison of correlated releases remain risks. Opt-in contributors are a self-selected sample. A minimum threshold limits early and thin-market coverage; a missing ticker is not evidence of zero interest. Infrastructure request-body logging must remain disabled for this endpoint, and raw credentials must never be logged. The server's environment gate is the operational kill switch.
