# Chat painting in WebKit

The Mac desktop report is a channel that stays black until a scroll. PR #1855
could not reproduce it in Chromium; PR #1857 introduced a measured, windowed
transcript. This check runs that same chat fixture and lifecycle workload in
WebKit, not a separate replacement fixture.

## Running

```sh
bun install
bun node_modules/playwright-core/cli.js install --with-deps webkit
bun scripts/pane-chrome/chat-latency.ts --webkit --lifecycle --multiple --arrival-on-mount --check --repeat 3
bun scripts/pane-chrome/chat-latency.ts --webkit --lifecycle --detached --arrival-on-mount --check --repeat 3
bun scripts/pane-chrome/chat-latency.ts --webkit --open-only --check --repeat 3
```

Omit `--webkit` to run the same cases in Chromium. `--quick` limits history to
500 messages; otherwise each run covers 40, 200 and 500. Every invocation runs
both the desktop persistence/capability profile (`enableCapabilityHandlers:
false`) and the web profile. `--detached` uses the real detached pane shell,
with the native bridge recorded rather than a native window manager. Typing,
uploads and CPU profiles remain in the existing Chromium workload.

Use `PANE_CHROME_CACHE` for builds, screenshots and `samples.json`. On a shared
host, serialize browser runs with `flock ~/.cache/gloom-announce-render.lock
nice -n19`, and set `TMPDIR` to a scratch directory. The CI WebKit job installs
the browser revision pinned by the development dependency and retains the
measurement JSON plus failure screenshots.

## What is checked

- Cold and warm channel opens and repeated switches, with bounded row mounts.
- Initially inactive (`display: none`) chat, hide/reveal, an offscreen pane,
  unmount/remount and live arrivals during those transitions.
- An arrival inside the first history request, before it returns on mount.
- Empty, held loading, rejected and stale channel responses. The held response
  also resolves while hidden before reveal.
- Resize while loading, resize around a successful response, and restore.
- Wheel back from the bottom, hide the tab, receive a message and reveal it:
  the visible anchor and scroll offset must survive. Then switch channels away
  and back, and switch with the keyboard.
- Other chat panes remain painted throughout; the same transitions run in a
  detached shell.

Every lifecycle checkpoint and timed channel open checks visible row geometry
**and actual screenshot pixels** before further input. Pixels are compared
with the computed pane background within the scrollport and within visible
text ranges. Overlapping panes are excluded, so another pane's text cannot
make a blank transcript pass. Loading, empty and error states must paint too.
The detector's negative control makes message rows transparent without moving
or unmounting them: geometry still passes, but the pixel gate must fail. It
then restores the rows and requires painted content again. This injected
control is not a reproduction of the reported product bug.

## Investigation result

On main after PR #1857, the reported blank-until-scroll state did **not**
reproduce. Three repeats at each history length and in both profiles passed
522 three-pane checkpoints and 486 detached checkpoints in WebKit, plus 36
negative detector controls. Cold/warm opens and switches also passed three
repeats at all history lengths in both profiles. No product code was changed
and no speculative paint invalidation or scroll workaround was added.

The expanded three-pane matrix also passed 522 checkpoints in Chromium.
The original Chromium pointer, typing/upload and opening checks remain the
compatibility gates for PR #1845, PR #1855 and PR #1857.

## Limits

Playwright's Linux WebKit is not the Mac app's WKWebView. It exercises a WebKit
layout and paint path, but not native macOS compositing, window occlusion,
focus delivery or GPU presentation. Screenshots and geometry reads can flush
layout or paint. An intermittent native-only invalidation bug remains possible.
The bridge, persistence, messages, sockets and sync are local fixtures; there
are no production requests or account mutations. The unsuccessful reproduction
leaves the root cause unresolved. Capture an affected native window before
scrolling to continue that investigation, rather than guessing a runtime fix.
