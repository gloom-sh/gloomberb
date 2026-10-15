# Chat input workload

Linear: GLO-789, GLO-790

Run `bun scripts/pane-chrome/chat-latency.ts --check --label chat-latency`.
`--quick` uses 500 messages; `--recent` dates them within the last day instead
of exercising the older-date labels. Set `PANE_CHROME_CACHE` for the output.
The pointer workflow runs the quick structural check, not a timing threshold.

## Method

Production DOM bundles, headless Chromium 155 on Linux, 1280 by 900, no GPU.
The same real chat controller, composer, message rows and shell run in both
profiles. The desktop profile uses `enableCapabilityHandlers: false` and
`RemotePersistence` with a stub native bridge. Web uses enabled handlers and
`JsonPersistence` over the browser's local storage. Both run the normal sync
hook and core contributors, with an in-memory transport replacing the remote
server. No account or production writes occur.

Real pointer events switch channels and open the image picker. Only the OS
picker is substituted by CDP's file selection. The 1024 by 768 PNG goes
through the normal file reader and preview decoder. Controlled upload
progress crosses the same controller subscription boundary as a real upload.
Each case types 60 keys at 50 ms intervals, with a 350 ms pause every ten
keys so draft persistence runs. Keys are scheduled outside the renderer,
without awaiting previous key dispatches, so UI stalls cannot slow the driver
and hide queueing. Key timestamps include that queueing. Paint is estimated
by an animation frame followed by a task, not GPU presentation.

The structural check counts rendered message components through the render
hook, skipping reused subtrees. It requires **zero unchanged message-row
renders** for both text and uploading-image workloads, checks all 60 keys
arrive and that the draft survives a channel round trip. Profiles, source
maps, long tasks, changed row props, sync counters and raw samples are saved.

## Measured causes

At the start of this investigation, main and v0.17.4 were both `c79f69a69`.
The baseline below is that commit; the same fixtures run against the change.
These are individual shared-host runs, not significance-tested distributions.

1. `getVisibleMessages` copied and sorted both message lists on every snapshot,
   even for a draft save or upload-progress notification. The changed array
   also invalidated the author map and row callbacks. At 500 messages this
   caused 3,000 row renders in the text workload and 10,500 with an upload.
   The change retains the projection while both immutable source arrays are
   unchanged. Actual messages, reactions, pages and pending-send transitions
   still replace those arrays and invalidate it.
2. Older relative-time labels constructed a locale date formatter per row.
   CPU samples attributed 797 ms of one baseline upload workload to that
   formatting path. Reusing the formatter preserves the strings and helps
   first render as well as feeds elsewhere in the app.

Typing alone did not rerender every markdown body. The draft debounce and
upload notifications were the triggers. The snapshot hook's many setters
were already batched. Preview reads were asynchronous. Core sync collection
and observation took only a few milliseconds across this small workspace;
this does not exclude a problem with a much larger real workspace.

### Key to estimated paint, milliseconds

| Profile | Messages | Draft | Before p50 / p95 / p99 | After p50 / p95 / p99 |
|---|---:|---|---|---|
| Desktop | 40 | Text | 17.4 / 18.7 / 20.2 | 6.6 / 7.1 / 8.0 |
| Desktop | 40 | Upload | 15.1 / 27.0 / 35.2 | 14.7 / 16.4 / 17.8 |
| Desktop | 200 | Text | 5.3 / 17.6 / 19.0 | 5.7 / 6.7 / 7.5 |
| Desktop | 200 | Upload | 7.7 / 64.3 / 134.3 | 12.5 / 14.3 / 15.4 |
| Desktop | 500 | Text | 17.6 / 19.4 / 20.7 | 6.0 / 10.3 / 21.3 |
| Desktop | 500 | Upload | 89.4 / 170.7 / 186.0 | 9.4 / 15.0 / 25.9 |
| Web | 40 | Text | 12.4 / 13.2 / 13.3 | 8.5 / 10.5 / 11.4 |
| Web | 40 | Upload | 6.1 / 18.7 / 23.0 | 15.9 / 17.7 / 18.0 |
| Web | 200 | Text | 7.9 / 10.4 / 10.8 | 4.5 / 10.2 / 21.1 |
| Web | 200 | Upload | 7.1 / 66.0 / 77.1 | 15.7 / 17.4 / 19.3 |
| Web | 500 | Text | 11.4 / 13.1 / 19.2 | 13.7 / 15.1 / 16.0 |
| Web | 500 | Upload | 96.9 / 214.8 / 281.2 | 18.0 / 22.7 / 32.2 |

Every after case rendered zero unchanged message rows and had zero long
tasks during typing/upload progress. The baseline 500-message upload cases
had 21 long tasks each. The structural gate fails on the baseline in all
12 cases and passes with the change.

### Channel and attachment timings, milliseconds

| Profile | Messages | Cold open before / after | Warm open before / after | Attach through decoded preview before / after |
|---|---:|---|---|---|
| Desktop | 40 | 91 / 65 | 61 / 50 | 28 / 21 |
| Desktop | 200 | 228 / 168 | 332 / 150 | 114 / 23 |
| Desktop | 500 | 565 / 332 | 621 / 341 | 284 / 24 |
| Web | 40 | 72 / 53 | 59 / 36 | 29 / 27 |
| Web | 200 | 281 / 172 | 216 / 164 | 113 / 12 |
| Web | 500 | 601 / 350 | 555 / 340 | 314 / 25 |

Repeated channel switches and image removal are also driven by pointer input.
The fixture keeps both channels' complete loaded histories, not just their
first 50-message page.

## Remaining work and limits

**Opening a long channel is not yet instant.** Its profile still spends time
mounting the whole transcript and laying it out for sticky scrolling. A
separate windowing change needs to preserve navigation to messages, copy,
pagination, scroll anchors, pending sends and pixel-native resize. Do not
claim this change completes the channel-open acceptance criterion.

The three-run chat resize comparison stayed within +0.5 ms/frame and +1
commit: 3.36 to 3.44 ms/frame at 40 messages and 6.53 to 6.71 at 500, with
18 commits on both sides. Existing real-pointer chat checks cover scrolling,
selection, replies, pagination and resizing. Terminal chat character frames
at 80 and 120 columns were byte-identical; date equivalence is also tested
across calendar boundaries.

No real Mac, native WebKit, GPU presentation, production network upload,
large saved workspace, signed-in/Pro all-pane sweep, or sustained leak test
is claimed. The native RPC is a stub, not a measured native process. Timing
thresholds would be unreliable on the shared host, so CI gates structural
work only.

## Follow-up investigation on `adb3a28fb`

**Investigation only, not a product fix.** The application source is unchanged.
There is no failing-before/passing-after reproduction of the blank-channel
report, and no windowing implementation or bounded-open regression gate yet.
The measurements below are baseline observations, not before/after gains.

### Additional harness coverage

The same harness now also accepts:

- `--lifecycle`: mount the chat initially hidden, reveal it through a real
  title-bar tab, then hide, move offscreen and unmount/remount it with incoming
  messages. Switch between populated, empty, pending and failed channels;
  resolve a previous channel's request after leaving it; switch with `[` and
  `]`. Verify visible rows or visible loading/error/empty text without a
  subsequent scroll or input. The host wrapper is fixture-only.
- `--multiple`: run alongside two more real chat panes. The fake connections
  are per channel, so closing one cannot disconnect another. The fixture's
  app-wide sync runtime stays mounted when a pane unmounts.
- `--large-workspace`: eight additional saved layouts with 80 panes each,
  long per-pane session state, and 80 long channel drafts written through the
  controller's normal draft persistence. These are invented stress data,
  not an exported personal workspace.
- `--open-only`: capture opening/switching profiles without the input phase.

Opening now records `firstVisibleMs`, `latestVisibleMs`, estimated paint
`ms`, mounted `rows`, and component `renderedRows`. The old DOM-presence
selector was insufficient: an offscreen row counted as shown, and the prefix
`m` for everyone also matched `macro:m`. It now checks the requested channel
and waits for its actual latest message to intersect the scrollport and the
page viewport. These are layout observations, not GPU pixel visibility.
Do not compare the new timings directly with the older DOM-presence metric.

The lifecycle scenarios pass on the baseline, including the rejected response
remaining a visible error. That does not disprove an intermittent report or
identify its cause. A first-frame compositor failure, native process timing,
and real service/network races are not reproduced by this fixture.

### Whole-transcript mounting remains the opening bottleneck

The structural observation is unambiguous: opening each channel mounts all
40, 200 or 500 messages, respectively. At 500, that includes the offscreen
headers, text and image rows. The target for follow-up work is the
latest loaded messages within two 60 Hz frames (about 33 ms), with mounting
and first-layout work bounded by the viewport rather than loaded history.
There is no timing gate while that structural change is missing.

For completeness, the following is the new probe's `verified-baseline` run,
not a speed comparison. The shared host was heavily contended (load average
about 32); these timings are **not suitable for setting a regression budget**.
An earlier run of the original probe on the same application revision had
500-message desktop cold/warm opens of 457/339 ms and web 377/368 ms. The large
spread is another reason not to gate wall-clock times on this machine.

| Profile | Messages | Cold first/latest in view, ms | Cold estimated paint, ms | Warm estimated paint, ms | Repeated switches, ms | Mounted rows |
|---|---:|---|---:|---:|---|---:|
| Desktop | 40 | 291.4 / 291.4 | 307.0 | 183.1 | 202.4 / 102.4 | 40 |
| Desktop | 200 | 738.2 / 738.2 | 750.1 | 623.6 | 399.7 / 408.6 | 200 |
| Desktop | 500 | 835.4 / 835.4 | 854.4 | 708.9 | 1131.6 / 959.1 | 500 |
| Web | 40 | 217.4 / 217.4 | 226.0 | 69.8 | 75.2 / 49.9 | 40 |
| Web | 200 | 730.4 / 730.4 | 765.4 | 640.2 | 422.5 / 487.6 | 200 |
| Web | 500 | 1820.6 / 1820.6 | 1880.8 | 1288.4 | 950.7 / 1489.3 | 500 |

| Profile | Messages | Draft | Key to estimated paint p50 / p95 / p99, ms | Unchanged row renders |
|---|---:|---|---|---:|
| Desktop | 40 | Text | 27.8 / 143.5 / 246.5 | 0 |
| Desktop | 40 | Upload | 25.4 / 132.0 / 176.8 | 0 |
| Desktop | 200 | Text | 23.7 / 90.3 / 113.0 | 0 |
| Desktop | 200 | Upload | 24.1 / 234.0 / 234.0 | 0 |
| Desktop | 500 | Text | 30.2 / 128.9 / 166.8 | 0 |
| Desktop | 500 | Upload | 74.1 / 391.5 / 467.5 | 0 |
| Web | 40 | Text | 112.8 / 355.0 / 537.7 | 0 |
| Web | 40 | Upload | 39.5 / 256.0 / 266.0 | 0 |
| Web | 200 | Text | 60.2 / 290.6 / 345.5 | 0 |
| Web | 200 | Upload | 41.9 / 491.8 / 604.5 | 0 |
| Web | 500 | Text | 63.3 / 380.6 / 401.6 | 0 |
| Web | 500 | Upload | 79.0 / 316.0 / 362.9 | 0 |

All keys arrived and the drafts survived the round trips. This retains the
structural protection from PR #1845; it does not establish a wall-clock input
budget under contention.

### Large workspace sync

The per-contributor timings and profiles are retained with each run. In the
initial 500-message large-workspace run, `core.config` observation during
input took 5.2 ms on desktop and 6.6/7.7 ms on web; collection took 6.0 ms and
6.8/5.9 ms, respectively. Only one observation/collection occurred during each
of those typing workloads. No observer or collector ran during the desktop
upload workload that nevertheless had a 124 ms key-to-paint p95.

Source-mapped CPU samples attributed about 3.5 ms directly, or 7.6 ms including
callees, to `snapshotContentSignature` in the web upload profile; none appeared
in that desktop upload profile. The text profiles had 7.9 ms desktop and
7.1 ms web inclusive totals. These are sampled CPU totals, not exact per-call
durations.
The web profile also had about 103 ms directly in local JSON storage over the
whole workload; that is not interchangeable with sync observer/signature
cost. No sync implementation was changed: these results do not establish it
as the dominant opening or typing cause. The native persistence bridge is
still a stub, so this is not a native storage-latency measurement.

### Remaining delivery and verification

Split the next implementation work: first obtain a failing main reproduction
for the blank pane (preferably the affected native host and a frame trace),
and separately implement bounded transcript mounting. No shared cause is
proven. The latter must retain target-message navigation, selection/copy and
browser find, pagination, historical anchors, sticky bottom, unread and
pending-send behavior, replies, reactions and attachments. A tail-only slice
without those paths is not a complete fix.

The lifecycle checks added here are preventive coverage that passes on main,
not evidence of a fixed blank-pane bug. Chromium's geometry checks do not
prove a WebKit or compositor fix. No real Mac, sign-in/Pro sweep, all-pane
before/after contact sheets, resize-budget comparison, glyph-track audit, or
terminal byte-capture comparison was performed for this investigation. No
application renderer, stylesheet, component or sync source changed, but that
source-level fact is not a substitute for those acceptance checks when a
product fix is made.
