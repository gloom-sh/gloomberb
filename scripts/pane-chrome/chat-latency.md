# Chat input workload

Linear: GLO-790

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
