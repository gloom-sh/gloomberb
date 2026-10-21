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

## Viewport-bounded transcripts (Linear: GLO-790)

The DOM transcript now uses the shared `WindowedList`, backed by the same
windowing engine as the data table. The table's row component itself does
not fit a variable-height, bottom-anchored conversation. Measured CSS pixel
positions include wrapped text, attachments, quotes, reactions and the
separators inside each message. Eight overscan rows and a buffered render
subscription bound mounting during opening, switching, scrolling and resize.
The ordinary shared ScrollBox still owns pane scroll-key registration.
There is no stylesheet, token, sync or terminal-rendering change.

### Same-fixture before/after

The before is `9409e791f`, including PR #1855's harness. The final runtime is
`1bbd36c35`. Both use the existing harness at 1440 by 900, the same invented
40/200/500-message histories and both persistence profiles. These are single
shared-host observations, not a wall-clock gate. All values below are ms.

| Profile | Messages | Cold paint before / after | Warm paint before / after | Mounted before / after |
|---|---:|---|---|---|
| Desktop | 40 | 97.0 / 47.4 | 49.0 / 34.1 | 40 / 20 |
| Desktop | 200 | 235.6 / 37.8 | 283.9 / 27.5 | 200 / 20 |
| Desktop | 500 | 598.2 / 44.3 | 787.5 / 28.2 | 500 / 20 |
| Web | 40 | 166.2 / 37.1 | 59.8 / 32.7 | 40 / 20 |
| Web | 200 | 260.7 / 43.9 | 477.7 / 29.3 | 200 / 20 |
| Web | 500 | 752.3 / 50.0 | 488.4 / 27.7 | 500 / 20 |

First and latest messages became visible in the same observation in every
case below. Thus each cold/warm visibility value reports **both** first and
latest, not mere presence in the DOM. Switch columns list the two repeated
switches, before then after.

| Profile | Messages | Cold first/latest before / after | Warm first/latest before / after | Switch first/latest before → after | Switch paint before → after |
|---|---:|---|---|---|---|
| Desktop | 40 | 94.1 / 45.1 | 47.0 / 32.0 | 58.0, 59.2 → 28.7, 26.9 | 60.7, 62.4 → 30.6, 28.9 |
| Desktop | 200 | 226.4 / 35.7 | 273.5 / 25.7 | 258.0, 226.9 → 22.8, 22.9 | 264.3, 231.6 → 24.6, 26.7 |
| Desktop | 500 | 590.0 / 42.2 | 760.8 / 26.2 | 470.7, 415.8 → 23.7, 24.3 | 476.7, 437.6 → 30.0, 30.9 |
| Web | 40 | 161.4 / 34.4 | 53.9 / 30.5 | 110.6, 39.8 → 24.0, 25.5 | 137.0, 54.3 → 32.3, 30.7 |
| Web | 200 | 252.0 / 41.6 | 472.9 / 25.3 | 169.0, 230.5 → 25.1, 26.0 | 174.3, 234.4 → 31.0, 30.0 |
| Web | 500 | 744.2 / 47.2 | 479.4 / 25.8 | 510.9, 681.2 → 24.6, 27.3 | 530.5, 692.9 → 26.5, 29.7 |

At each history length, cold peak mounting was 21 rows and settled mounting
was 20. Warm opens and switches mounted 20. Mounting depends on viewport
height and row height, not channel length. At 500, repeated switches meet
about two 60 Hz frames in this run; cold opening still takes about three.
CI now caps peak mounting at 80 in this fixed viewport, including the initial
open, cold/warm opens and switches. It is deliberately not a timing threshold.
PR #1845's zero unchanged-row-render gate still passes in all 12 typing/upload
workloads, with all keys retained and drafts preserved across channel trips.

### Interaction and resize verification

The existing real-pointer suite passed all 177 checks. Its 41 chat checks
include the original scrolling, unread marker, selection, pagination and
resize cases, plus these window-specific paths:

- Open at the bottom; new messages keep a pinned reader at the bottom, while
  a reader further back retains their message and offset. Older-history
  pagination holds that position, including with browser anchoring disabled.
- Notification targets outside the initial window mount and highlight.
  Clicking a quote can jump to an unmounted row or fetch older pages until
  the target is available; a page already in flight does not lose the jump.
- Real text selection and Ctrl+C copy a visible message. Arrow navigation
  crosses multiple windows; Home, End, PageUp and PageDown move the transcript.
- Pending sends, failed-send retry, keyboard replies and clicked reactions
  survive scrolling away and back. A held image response keeps its reserved
  space before decoding and after loading.
- Hidden open, tab reveal, offscreen return, remount and late responses still
  show the latest message without a subsequent input. The lifecycle check
  also passes with three real chat panes in both profiles. This is preventive
  coverage, not a fix or reproduction of the separate blank-channel report.

Five alternating resize runs per side, at 50 and 500 loaded messages, gave:

| Loaded messages | Main-thread ms/frame before / after | Commits before / after |
|---|---|---|
| 50 | 3.09 / 3.09 | 18 / 19 |
| 500 | 5.91 / 2.73 | 18 / 19 |

These medians meet +0.5 ms/frame and +1 commit; each paired run also stayed
within those limits. Divider and floating-corner pointer checks sample every
animation frame and the release. Visible text glyphs stay inside their body
or quote track, and row edges track the pane within 0.5 px. The glyph probe
ignores unpainted trailing spaces and respects clipping; it passes on both
base and head. The measured resize had no release jump.

### Visual and terminal review

The signed-out all-pane Chromium sweep covered 154 functions and bundled
plugin panes, dark and light at 640 and 1280 px. Of 1,888 comparable captures,
1,832 were pixel-identical, including the chat root in all four profiles.
The 56 differing captures were reviewed: late data/loading/error transitions,
spinner phases, animated heat-map positions, footer-warning arrival, a caret
phase and an as-of timestamp. The volatility surface's larger difference
was checked again: 23 of 24 captures became identical; the remaining one
differed only in canvas axis-label rasterization. Four unmatched detail
captures came from asynchronous detail discovery, not a new pane layout.
There was no unexplained movement of an untouched view.

The deterministic rest comparison was pixel-identical across all 20 layouts,
and the 500-message transcript with replies was pixel-identical at both
widths in both themes. Contact sheets place that transcript next to the news
reader, news table, position-sizing form and bundled polling plugin. No new
visual treatment or pane-local controls were introduced. The all-pane sweep
compares the isolated change against the PR #1855 base; later main updates
were rebased separately. The final rest and interaction checks include them.

Six styled terminal frames, including text, colors and attributes, were
byte-identical at 64 and 120 columns for open, selected-message and reply
states. These used the existing terminal harness in a throwaway tmux session
with a fixed in-memory channel catalog, not the user's terminal profile.

### Limits

Only mounted messages participate in native text selection and browser Find.
Selection across unmounted history is not supported; this is also stated in
usage documentation. Loaded history remains in memory, and scrollbar extent
uses estimates until unseen rows have been measured. This is a mounting and
layout improvement, not a history-memory or network optimization.

The all-pane sweep reached 79 sign-in/Pro gates rather than exercising their
protected content. External registry plugins, a real Mac app, native WebKit,
GPU presentation, production uploads and long-session leak behavior were not
measured. The desktop persistence bridge remains a fixture stub. Evidence
and raw profiles are local artifacts, not public market-data attachments.

## Review follow-up (Linear: GLO-790)

Compared `8bb2ac742` with runtime `7e562fb21`, using the existing fixtures and
checks. No stylesheet, token, layout, new visible text or terminal branch
changed. `WindowedList` and its props are no longer exported by either public
component barrel; chat imports the internal module directly. The public API
snapshot test passes with the addition removed.

### Reproductions and fixes

Six real-input checks were added to `chat-checks.ts`:

| Check | Before | After |
|---|---|---|
| Select latest with ArrowUp, Enter to reply, grow composer | Latest message clipped; 90 px from bottom | Entire latest message visible, at bottom, no transient jump control |
| Click latest Reply, grow composer | Pass | Pass |
| Drag-select, wheel the anchor out while holding the pointer, extend, Ctrl+C | Whole-message handler replaces the shortened range | Browser-default copy, not intercepted; a fresh selection still copies original markdown |
| Select latest, wheel it out, press p | Pass | Pass, existing fallback card stays inside the pane |
| Hide/reveal a scrolled-back tab, with and without an arrival | Moves the reader to another message | Same message and pixel offset, rows visible |
| Quote click in an unfocused detached shell, then ArrowUp | Jump highlights but keyboard remains unfocused | Both jump highlight and subsequent keyboard selection work |

`scrollToItem` derives pin state after moving instead of unconditionally
clearing it. Copy remembers disconnected selection edges, including when the
browser later normalizes them onto live rows. It does not retain extra rows
or try to reconstruct unseen selected text. Thread background clearing runs
in capture so a quote can bubble to the shell's focus handler without losing
its highlight. The existing profile fallback needed no runtime change.

Hidden viewports retain measured heights and offsets instead of accepting
zero-sized layout as new data. Append following uses the remembered pin,
not a hidden element's zero extent. An initially hidden mount keeps its pin
until its first real viewport measurement. The existing three-pane lifecycle
probe caught that last ordering case during development; all 36 states now
pass across desktop and web, including hidden open/reveal and late arrivals.
The detached check supplies the host blur notification, then uses real pointer
and keyboard input; it is not a native window-manager focus test.

### Timing and bounded work

Ten paired runs of the existing open-only probe at its 1280 by 900 viewport,
40/200/500 invented messages and both persistence profiles. Five pairs ran
base first, five head first to balance order on the shared machine. All
numbers below are median estimated paint times in ms, before / after.

| Profile | Messages | Cold | Warm | Switch 1 | Switch 2 |
|---|---:|---|---|---|---|
| Desktop | 40 | 47.70 / 51.00 | 36.20 / 36.05 | 33.55 / 32.45 | 30.30 / 30.20 |
| Desktop | 200 | 42.15 / 44.00 | 33.70 / 33.95 | 31.45 / 31.80 | 30.15 / 28.45 |
| Desktop | 500 | 47.20 / 47.00 | 31.00 / 29.35 | 29.10 / 29.10 | 30.85 / 31.10 |
| Web | 40 | 36.45 / 39.70 | 31.10 / 31.55 | 29.15 / 30.80 | 29.55 / 30.95 |
| Web | 200 | 40.75 / 41.00 | 30.20 / 30.05 | 27.45 / 29.40 | 30.60 / 30.75 |
| Web | 500 | 49.75 / 54.15 | 29.30 / 30.40 | 29.45 / 28.70 | 28.75 / 30.45 |

The largest median increase is 8.9%. The first five pairs alone had one 11.8%
increase at web/40 cold opening; the balanced ten-pair set includes those
observations rather than discarding them. These remain shared-host timing
observations, not GPU presentation measurements. Every measured open and
switch mounted 21 rows, peak and settled, independent of history length.
All 12 text/upload typing workloads retain zero unchanged-row renders, all
keys and the draft across channel round trips, preserving PR #1845's gate.

Five alternating resize pairs on the final runtime, before / after:

| Messages | Main-thread ms/frame | React commits |
|---|---|---|
| 50 | 2.94 / 2.69 | 19 / 19 |
| 500 | 2.54 / 2.56 | 19 / 19 |

Every pair meets +0.5 ms/frame and +1 commit (largest time increase 0.05 ms).
All 183 pointer checks pass, retaining PR #1845, PR #1855 and the original
windowing checks. Both resize shapes retain per-frame glyph-track checks and
no release jump. All 20 deterministic rest layouts are pixel-identical.
No visual treatment changed, so the earlier all-pane dark/light, narrow/wide
sweep was not repeated for this follow-up. There are no rest-image differences
to classify as noise. Six styled terminal frames, text/colors/attributes,
are byte-identical at 64 and 120 columns for open, selected and reply states,
using the same in-memory fixture under a disposable tmux/HOME.

### Verification limits

Chat, public API and import-boundary tests: 310 pass. Desktop view build,
dead-code check and Worker typecheck pass. The full local suite has 8,260
passes and 14 failures outside chat: nine CLI failures reproduce unchanged
on the baseline; five async earnings-shelf failures disappear on isolated
rerun, on both sides. The shared dependency tree still lacks the updater API
required by both revisions, blocking the other local typecheck groups with
the same four diagnostics. Hosted clean-install checks on runtime
`7e562fb21` all pass, including typecheck, full tests, registry, pointer checks,
terminal benchmarks and pane-drag budget; deployment is skipped.

Native WebKit, GPU presentation, production services, protected account
content and long-session behavior were not exercised. Browser-default copy
still only copies the browser's surviving selection, not unmounted history.
No release, merge, deployment or production mutation was performed.

## Covered floating windows (Linear: GLO-789)

### Reproduction and cause

Reproduced on `fb1dd6289` in Chromium 155 and Linux Playwright WebKit, using
both the desktop capability profile and the browser profile. Bringing other
floating panes forward with Tab, then cycling back, leaves the channel list
and composer intact but the transcript empty. Backgrounding the OS window is
not necessary. Clicking saved-layout tabs alone did not reproduce it.

`resolveFloating` sorts panes by z-index. Mapping that order into React
children moves existing window nodes with `appendChild` or `insertBefore`
when focus changes. Both engines reset nested scrollports during that move,
without a scroll event or size change. At 500 messages, the transcript moves
from scrollTop 31,032 to zero while its 19 mounted rows still describe the
tail. Visible message text pixels fall to zero. A virtualized table and an
ordinary article reader also lose their reading positions. This is not the
hidden chart measurement problem from PR #1908.

The shared shell now keeps DOM siblings in saved insertion order. CSS z-index
still determines the front window, including the existing insertion-order
tie break. Hit testing and occlusion retain their sorted inputs. The terminal
continues mapping the original back-to-front list. No scroll nudges, remounts,
new text, styling changes or chat-specific recovery timers are added.

### Before and after

The final fixture alternates five Tab returns and five real header clicks,
with a table and an expanded article reader covering chat. It includes an
arrival while covered, a scrolled-back return with another arrival, and real
wheel scrolling of both sibling panes. It extends the existing harness:

```sh
bun scripts/pane-chrome/chat-latency.ts --pane-return --check
bun scripts/pane-chrome/chat-latency.ts --webkit --pane-return --check
bun scripts/pane-chrome/chat-latency.ts --layout-return --quick --check
bun scripts/pane-chrome/chat-latency.ts --webkit --layout-return --quick --check
```

The same final fixture was run with main's z-index-ordered mapping restored
as a control, and with the fix, on base `51365f9dc`. Each engine covers both
profiles at 40/200/500 messages:

| Check, per engine | Main ordering | Stable DOM ordering |
|---|---:|---:|
| Blank chat returns, out of 60 | 60 | 0 |
| Failed state checks, out of 180 | 174 | 0 |
| 500-message return scrollTop | 0 | 31,032 |
| Table and article return scrollTop | 0 | 500 |

The six initial captures pass on both sides. A failed return is photographed
before any recovery input; history checks cannot silently pass when the
transcript is already blank. Saved-layout clicking at 500 messages passes
all 20 round trips per engine. Both return modes run in CI.

### Other verification and limits

- 326/326 existing pointer checks pass, including chat behavior, selection and
  per-frame resize geometry. The 40/200/500-message typing/upload workloads
  pass the bounded mounting and zero unchanged-row-render gates from PR #1845.
- Three-pane lifecycle checks, including loading, error, stale results and
  arrival during mount: 58/58 states in each engine. The detached WebKit run
  passed desktop's 27 states; the local command deadline interrupted its
  browser-profile run, so that part is not claimed complete.
- Five alternating resize pairs: median main-thread ms/frame 3.21 to 3.38
  (first page), 3.00 to 3.00 (500 messages); commits 19 to 19 and 19 to 20.
  Individual pairs include +2 commits. No release jump; glyph-track checks
  pass, including narrowing. These are headless measurements, not GPU frames.
- Desktop view build and dead-code check pass. Local typecheck and full unit
  suite were deferred on the busy shared host; clean-install CI remains a gate.
- A targeted Chromium dark/light comparison at 640/1280 px covers chat's
  signed-out state, news and its detail, the position form/table, and the
  registry news plugin's six views: 40 picture pairs, 0/10 views changed,
  identical token measures. No loading-timing differences needed classifying.
  The full all-pane baseline audit reached 170 measurements and 343 pictures
  before its 25-minute limit. It is incomplete, not an all-pane visual pass;
  the full UI benchmark and token workflows remain required.
- Linux WebKit reproduced the bug and passes the fix. The native Mac app,
  macOS window background/foreground transitions, GPU presentation and
  protected production content were not tested. Terminal ordering is unchanged
  by inspection; a new byte-for-byte terminal capture was not made.
