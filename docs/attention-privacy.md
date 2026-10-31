# Attention Counts privacy review

Attention Counts is the contribution behind ATTN and Gloom Trending. It is separate from Usage Counts and crash reports. It is on by default, including in the EU and UK, and anyone can switch it off at any time; switching it off applies from then on.

## Default, notice and switching off

`telemetry.attention` has three states. `false` is off and nothing is counted. `true` is an explicit on, as an earlier opt-in left it; it counts without the notice. Unset is the default: on, but an account is counted only after this installation has shown it a one-time notice. The notice is a toast without a title, the same in the terminal and on desktop and web, that stays until dismissed: "Attention Counts is now on. Tickers you open are sent to Gloom with your account; only hourly totals of 20+ people are published." Its **Turn off** switches the setting off. It shows once per account on each installation, while the app is in front, to a signed-in account with a verified email whose setting is unset, and only once the app has pulled the account's synced settings in that session, so an off made on another device arrives first. It never shows under a privacy signal or on a surface without a collector (CLI commands, `shot`). Counting under the default starts when the toast is drawn, not when it is dismissed. Nothing opened before that is counted. An explicit off is never turned back on by the notice. The installation keeps the ids of the accounts it showed the notice to in `telemetry.attentionNoticeShownTo`, on this device only.

Attention Counts is switched in the command bar: run **Attention Counts** to turn it off or back on; the row says it is on by default. The command is the same in the terminal, desktop and web. Switching off takes effect immediately, clears unsent counts, and says that totals already published can't be withdrawn. The CLI reads and writes the same setting while Gloom is closed; a running app keeps the setting it loaded and saves it back, so use the command bar while it is open:

```sh
gloom config get telemetry.attention   # false, true, or default (on once the app has shown its notice)
gloom config set telemetry.attention false
gloom config set telemetry.attention true
```

**Off applies to the account.** The setting is kept on each installation or browser profile. While signed in, cloud sync carries one field for it, `attentionOff` (whether it is off), and never the notice list. Turning it off on one device turns it off on the account's other signed-in devices running a current version the next time they sync: at launch and every 15 seconds while open. Those devices drop their unsent counts when the off arrives, and a device counts nothing in a session until it has pulled the account's settings, so one that was closed cannot count before the off reaches it (a popped-out desktop window takes them from the main window). Turning it back on afterwards on one device turns the others back on the same way. The default never overrides a choice either way, and a device's first sync after updating takes an off already on the account instead of replacing it. While signed out nothing syncs and the setting applies to that installation only; once it signs in, an off made there applies to the account. A device that does not sync, such as one with the Gloom Cloud plugin disabled, counts nothing. Older app versions count only after an explicit opt-in on that device and do not read the synced off. `GLOOMBERB_NO_TELEMETRY=1`, `DO_NOT_TRACK=1`, browser Do Not Track and Global Privacy Control override the setting on that device and suppress the notice. Turning Usage Counts off does not change Attention Counts.

Only an authenticated, email-verified account can contribute. Signing out, losing verification or changing accounts drops queued data. Nothing collected while switched off, before the notice, before authentication or on a previous account is sent after those states change. Viewing ATTN does not require contributing.

## What leaves the app

The app records successful explicit opens of a security description, a security chart, a quote monitor or an options chain, plus successful watchlist additions. Explicit Chart and Options tab selections count. Restoring a workspace, mounting a pane, quote updates, background requests, automated opens and opening ATTN do not count. Headless CLI data reads do not install a collector.

The authenticated request is `POST /telemetry/attention` with this complete body shape:

```json
{"consent":true,"events":[{"symbol":"VOD:LSE","action":"des"}]}
```

`consent: true` is the app's statement that the setting allows counting for this account: an explicit on, or the default after the notice. The server accepts both the same way.

Allowed actions are `des`, `chart`, `quote`, `option_chain` and `watchlist_add`. Symbols retain the public listing or exchange qualifier where known. The server resolves them against its instrument registry and suppresses ambiguous or unknown instruments. The body contains no user, device, session, install, portfolio or watchlist identifiers, no position sizes, search strings, event timestamps, or workspace content.

**Collection is authenticated, not anonymous at the network boundary.** The normal Gloom session credential accompanies the request. The server also receives the connection IP and user agent. These are not included in the public attention dataset. No analytics SDK or third-party analytics endpoint is involved in this collection path. Existing Usage Counts, search reporting and crash reports have their own documented behavior.

## Client storage and deletion

There is no persistent ticker event log. At most 100 distinct ticker/action pairs wait in memory, with duplicates collapsed. The app attempts one batch after 60 seconds. A batch older than two minutes or belonging to an earlier UTC hour is dropped; offline failures and server refusals are never retried. The client does not use unload beacons or a keepalive request to prolong collection after closing.

Switching it off synchronously erases the queue, invalidates pending asynchronous ticker opens and aborts an in-flight request where the transport supports it. An already transmitted request cannot be recalled. In particular, the desktop's existing RPC transport cannot withdraw a request already handed to its native process; that request has a five-second deadline. Published aggregate totals cannot be attributed back to an account for subtraction.

## Server controls and publication

Production collection defaults off behind the server's attention collection switch, independent of the app setting. The endpoint requires the literal `consent: true`, validates the entire body, rejects identifiers and unknown fields, limits batch size, rejects bots and honors privacy headers. It never forwards ticker events to the existing usage analytics pipeline.

The server counts at most one contribution per account, ticker and UTC hour, capped at 20 distinct tickers per account per hour. The same account across devices does not add another contribution. Contributor deduplication uses a domain-separated hourly HMAC key and an account-derived HMAC digest in a separate unlogged staging table. No account, device, session or IP identifier is stored there. This digest is pseudonymous while the staging data and server secret exist; it is not a claim of irreversible anonymisation.

Staging expires after six hours by default, with a maximum of 24 hours. Finalization deletes its staging rows atomically, including suppressed buckets; expiry cleanup continues even when collection or publication is disabled. Staging must be excluded from logical backups. Unlogged staging is excluded from PostgreSQL WAL replication.

The public dataset contains no contributor identifier or digest. A ticker/hour is only released at least one hour after the bucket closes, with at least 20 distinct contributors. Both the lag and threshold can be raised. Counts are rounded down to multiples of five, without random noise. Published hourly releases are immutable. Hourly counts are retained for 35 days while the cleanup worker operates; a small permanent finalization record prevents an expired hour from being republished. Unreferenced listing metadata versions are removed with retention cleanup. Action-level breakdowns and small buckets are not released. Published totals are research attention among contributors, not all Gloom users, holdings, orders or investment intent.

See the platform PR's privacy review for the exact ephemeral deduplication scheme, retention and operational switches. The privacy policy describes the default and how to switch it off; collection stays behind the server switch until rollout.

## Review and limitations

The collector's tests exercise the default before and after the notice, explicit off and on, malformed settings (which read as off), the synced off reaching other devices and a stale local on never undoing it, counting held until the account's settings are pulled, account changes during asynchronous work, opt-out during in-flight sending, queue erasure, automation suppression, bounded batches, stale-hour suppression, no retries and transport allowlisting of every serialized field. Backend tests separately verify release thresholds and aggregate-schema identifier exclusion.

Threshold suppression and rounding reduce disclosure risk; they do not provide a formal differential privacy guarantee. Coordinated verified accounts, outside knowledge and comparison of correlated releases remain risks. Contributors are signed-in, verified Gloom users who have not switched it off, a self-selected sample. A minimum threshold limits early and thin-market coverage; a missing ticker is not evidence of zero interest. Infrastructure request-body logging must remain disabled for this endpoint, and raw credentials must never be logged. The server's environment gate is the operational kill switch.
