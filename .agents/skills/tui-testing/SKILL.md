---
name: tui-testing
description: >-
  Testing Gloomberb at every level: CLI commands for fast data/integration checks,
  OpenTUI's built-in test harness for component tests, and tmux for full end-to-end
  terminal TUI testing. Use this skill when you need to verify terminal TUI features,
  write OpenTUI regression tests, or smoke-test the terminal app. Do not use it for
  Electrobun/desktop-web-only visual or window chrome work unless tmux/OpenTUI
  coverage is explicitly needed.
---

# Testing Gloomberb

Three testing approaches. **Start with the simplest level that covers your change** and escalate only when needed.

This skill is for terminal TUI and OpenTUI test workflows. For Electrobun/desktop-web-only fixes, use focused desktop builds/tests instead unless the task explicitly asks for tmux or terminal rendering coverage.

## Critical Rules

Cleanup is part of testing. If you start `tmux`, a dev server, a watcher, or any other background process while testing, stop it before you finish the task, even if the test fails.

- Prefer named `tmux` sessions and end them with `tmux kill-session -t <name>`.
- If you start a background process without `tmux`, capture its PID and terminate it explicitly with `kill <pid>` or the matching shutdown command.
- Do not leave test helpers running across iterations unless the workflow explicitly requires it and you clean them up before handoff.

**Never open the TV pane in a live app.** `macro-tv` (shortcut `TV`) spawns an external media player such as `mpv`, plus `yt-dlp`/`ffmpeg`. Those processes outlive the `tmux` session that started them, keep playing audio, and burn CPU on the developer's machine until they are killed by hand. Verify TV changes by reading the code and with unit tests. The same rule applies to any pane or feature that shells out to a media player.

**Never run an unbounded or streaming log scan.** A `tail -c 4000000 <log> | strings | grep ... | head -20` health scan once pinned a core at 100% for over five hours. Scan a bounded slice of a file that is no longer being written, and never involve `strings`:

```bash
head -c 200000 /tmp/gloomberb-test.log | grep -aE "<pattern>" | head -20
```

**Finish with a leak sweep.** Before you report a test as done, confirm nothing you started is still alive:

```bash
ps -Ao pid,%cpu,etime,command \
  | grep -iE "mpv|yt-dlp|ffmpeg|ffplay|tail -c|strings|bun run dev" \
  | grep -v grep
tmux ls 2>&1
```

Kill anything of yours that shows up and re-run until the sweep is clean.

```
What are you testing?
├─ Data flow, config, business logic, or integration with external sources
│  ├─ CLI command exists for it → Run the CLI command (fastest)
│  └─ No CLI command, but it makes sense as one → Add it, then use it
├─ A component's rendering, interaction, or visual regression
│  └─ OpenTUI test harness (.test.tsx file)
├─ Pure logic with no UI or data layer
│  └─ Unit test (bun:test, no renderer needed)
└─ Full app behavior across multiple views
   └─ tmux (last resort)
```

---

## 1. CLI Commands (fastest feedback loop)

Gloomberb doubles as a CLI tool. CLI commands are the **fastest way to verify data flow, config state, and business logic** — no renderer, no harness setup, just run and check output.

### Available commands

```bash
bun run dev help                        # Show all commands
bun run dev portfolio                   # List all portfolios/watchlists with ticker counts
bun run dev portfolio "Main Portfolio"  # Show detailed positions, P&L, quotes
bun run dev ticker AAPL                 # Show quote, fundamentals, positions
bun run dev plugins                     # List installed plugins
```

### When to use CLI testing

- **Verifying data layer changes** — After modifying config, ticker storage, or persistence, run `portfolio` or `ticker` to confirm data loads correctly.
- **Checking new data fields** — If you add a new field (e.g. earnings date), first expose it via the `ticker` CLI command and verify the output, before wiring it into the TUI.
- **Smoke-testing integrations** — `ticker AAPL` exercises the Yahoo Finance client, quote formatting, and fundamentals parsing in one command.
- **Testing plugin management** — `install`, `remove`, `update`, and `plugins` commands verify the plugin lifecycle.

### Adding new CLI commands

If you're building a feature and need to verify data that isn't exposed via CLI yet, consider adding a CLI command first when it makes sense (e.g. listing watchlists, showing config values, checking broker sync status). This gives you a fast feedback loop before building the TUI component.

The CLI dispatcher is in `src/cli.ts` — add a new case to the `switch` in `runCli()`.

### Example: verifying a data change via CLI

```bash
# After modifying how positions are calculated:
$ bun run dev portfolio "Main Portfolio"
Main Portfolio (USD)

TICKER    PRICE         CHG%    SHARES  AVG COST      P&L
------------------------------------------------------------
AMD         $201.99    -0.87%    100     $150.00    +$5,199.00
------------------------------------------------------------
                                              Total: +$5,199.00
```

---

## 2. OpenTUI Test Harness (component & snapshot tests)

Headless, deterministic component and integration tests using Bun's test runner and OpenTUI's built-in test renderer. **Use this for UI component tests and visual regressions.**

### Why use this

- **Deterministic** — `renderOnce()` guarantees the frame is complete before capture. No timing guesswork.
- **Fast** — Full suite runs in < 1 second.
- **Isolated** — Each test gets its own headless renderer. No shared state, no cleanup burden.
- **Composable** — Render individual components with controlled props/state.
- **Snapshotable** — Built-in `toMatchSnapshot()` for visual regression testing.

### Quick start

```typescript
import { test, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/react/test-utils";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(() => {
  if (testSetup) {
    testSetup.renderer.destroy();
    testSetup = undefined;
  }
});

test("renders my component", async () => {
  testSetup = await testRender(<MyComponent someProp="value" />, {
    width: 80,
    height: 24,
  });

  await testSetup.renderOnce();
  const frame = testSetup.captureCharFrame();

  expect(frame).toContain("expected text");
  // or: expect(frame).toMatchSnapshot();
});
```

### Interaction testing

Use `mockInput` and React's `act()` to simulate user input:

```typescript
import { act } from "react";

test("arrow keys navigate the list", async () => {
  testSetup = await testRender(<MyList items={items} />, {
    width: 80,
    height: 24,
  });

  await testSetup.renderOnce();

  await act(async () => {
    testSetup!.mockInput.pressArrow("down");
    await testSetup!.renderOnce();
  });

  expect(testSetup.captureCharFrame()).toContain("▸ Second Item");
});
```

### Testing components that need app context

Many components require `AppContext`, `DialogProvider`, etc. Create a harness wrapper:

```typescript
function TestHarness({ children, overrides = {} }) {
  const config = { ...createDefaultConfig("/tmp/test"), ...overrides };
  const state = { ...createInitialState(config), ...overrides };
  return (
    <AppContext value={{ state, dispatch: () => {} }}>
      <DialogProvider>{children}</DialogProvider>
    </AppContext>
  );
}
```

See `src/components/command-bar/command-bar.test.tsx` for a full example of this pattern.

### Test setup return object

| Property | Type | Description |
|----------|------|-------------|
| `renderer` | `Renderer` | The headless renderer instance |
| `renderOnce` | `() => Promise<void>` | Trigger a single render cycle |
| `captureCharFrame` | `() => string` | Capture current output as text |
| `resize` | `(w, h) => void` | Resize the virtual terminal |
| `mockInput` | `MockInput` | Simulate keyboard input (e.g. `pressArrow("down")`) |

### Running tests

```bash
bun test                              # Run all tests
bun test src/components/ui/ui.test.tsx # Run a specific file
bun test --filter "CommandBar"        # Filter by name
bun test --update-snapshots           # Update snapshot files
```

### Conventions

- Test files live next to source: `foo.tsx` → `foo.test.tsx`
- Always call `renderer.destroy()` in `afterEach`
- Always call `renderOnce()` before `captureCharFrame()`
- Use consistent dimensions for snapshot stability (80×24 default)

---

## 3. tmux (full end-to-end TUI testing)

Run the actual app in a tmux session, send keystrokes, and capture the rendered screen. **Use this as a last resort** — for verifying full-app behavior that can't be tested with the harness or CLI.

When tmux is used for React/OpenTUI changes, always treat runtime health as part of the smoke. Do not stop at "it rendered"; scan for React hook/update-depth failures, listener leak warnings, and obvious memory runaway.

### When to use tmux

- Verifying layout and pane arrangement with real data
- Testing keyboard navigation flows across multiple views
- Smoke-testing after major refactors
- Debugging rendering issues that only appear with the full app
- Checking for real-app React warnings, listener leaks, update loops, or memory growth after layout/pane/chart/subscription changes

### Setup

```bash
# Kill any existing test session first
tmux kill-session -t test 2>/dev/null

# Start the app — use a fixed terminal size for consistent captures
tmux new-session -d -s test -x 120 -y 40 'bun run dev 2>&1'

# Wait for the app to render (2-3 seconds for initial load)
sleep 3
```

For warning/error scans, pipe the pane output to a log before interacting:

```bash
tmux pipe-pane -o -t test 'cat > /tmp/gloomberb-test.log'
```

If you need to run the app without `tmux`, keep the process handle so you can shut it down:

```bash
bun run dev > /tmp/gloomberb-test.log 2>&1 &
app_pid=$!

# ... test whatever you need ...

kill "$app_pid"
wait "$app_pid" 2>/dev/null
```

### Capturing the screen

```bash
tmux capture-pane -t test -p
```

Returns the full rendered text grid including box-drawing characters. Does NOT capture colors or styling.

### Sending input

```bash
# Special keys
tmux send-keys -t test C-p          # Ctrl+P — open command bar
tmux send-keys -t test Escape        # Escape — close dialogs
tmux send-keys -t test Enter         # Enter — select/confirm
tmux send-keys -t test Tab           # Tab — switch tabs
tmux send-keys -t test Up            # Arrow keys
tmux send-keys -t test Down
tmux send-keys -t test j             # j/k — navigate lists
tmux send-keys -t test k

# Typing text (always use -l flag for literal strings)
tmux send-keys -t test -l 'AAPL'
```

**Important:** Always use `-l` for text input. Without it, each character is interpreted as a key name.

### Typical test flow

Always add `sleep 0.5` to `sleep 1` after sending input to let the UI re-render.

```bash
# 1. Start the app
tmux kill-session -t test 2>/dev/null
tmux new-session -d -s test -x 120 -y 40 'bun run dev 2>&1'
sleep 3

# 2. Capture initial state
tmux capture-pane -t test -p

# 3. Open command bar and search
tmux send-keys -t test C-p
sleep 0.5
tmux send-keys -t test -l 'AAPL'
sleep 0.5
tmux capture-pane -t test -p

# 4. Select and verify
tmux send-keys -t test Enter
sleep 1
tmux capture-pane -t test -p

# 5. Always clean up
tmux kill-session -t test
```

### Runtime health checks

For real-app smokes, especially after touching React hooks, subscriptions, chart rendering, pane settings, market-data events, layout switching, or plugin runtime code, perform these checks before finishing:

1. Capture a log and final screen.
2. Scan both for React/runtime warnings.
3. Sample RSS before and after interactions if the test runs long enough to compare.
4. Explicitly report any remaining uncertainty, such as a short smoke not proving long-horizon leak absence.

Suggested scan:

```bash
LOG=/tmp/gloomberb-test.log
CAP=/tmp/gloomberb-test.capture
tmux capture-pane -t test -p > "$CAP"

rg -n \
  "Possible EventTarget|MaxListeners|Maximum update depth|Invalid hook|Rendered more hooks|Rendered fewer hooks|React has detected|\\[ERROR\\]|Error:" \
  "$LOG" "$CAP" || true
```

Suggested RSS sampling:

```bash
pane_pid=$(tmux display-message -p -t test '#{pane_pid}')
child_pids=$(pgrep -P "$pane_pid" || true)
grandchild_pids=""
for pid in $child_pids; do
  grandchild_pids="$grandchild_pids $(pgrep -P "$pid" || true)"
done
app_pids=$(printf '%s\n' $child_pids $grandchild_pids | awk 'NF' | sort -u)

for pid in $app_pids; do
  ps -o pid=,rss=,command= -p "$pid" || true
done
```

Interpret memory samples conservatively:

- A short smoke can catch obvious runaway growth, but it cannot prove there is no long-horizon leak.
- Startup, first data load, chart bitmap allocation, and layout switching can legitimately increase RSS.
- Suspicious signs are repeated warning logs, unbounded growth across repeated identical interactions, or jumps paired with update-depth/listener warnings.

### Layout and pane smoke coverage

When a bug mentions a specific saved layout, pane type, or focus path, launch directly into that layout or use the remote-control endpoint to switch layouts rather than relying only on keyboard shortcuts. Keyboard encoding in tmux can be terminal-dependent.

Recommended coverage for layout/pane regressions:

- Launch the affected layout directly from an isolated temp config or copied app config.
- Exercise the affected pane's own interactions, such as chart period changes, refresh, tab changes, pane settings, or legend toggles.
- Switch between the affected layout and another layout at least a few times when the bug involved layout activation or pane unmount/remount behavior.
- Re-run the warning scan after interactions and after layout switches.

### Common command bar actions (Ctrl+P)

| Command              | Description                              |
|----------------------|------------------------------------------|
| (ticker symbol)      | Jump to or add a ticker                  |
| Add Pane / Remove Pane | Manage panes in layout                 |
| New Portfolio / New Watchlist | Create collections                |
| Delete Portfolio / Delete Watchlist | Remove collections         |
| Edit Columns         | Toggle visible table columns             |
| Change Theme         | Switch color theme                       |
| Manage Plugins       | Toggle plugins on/off                    |

### Tips

- **Timing:** If captures look incomplete, increase sleep duration. Network-dependent views take longer.
- **Terminal size:** `-x 120 -y 40` gives consistent layout. Smaller sizes may cause wrapping.
- **Cleanup:** Always kill the `tmux` session or any other background process you started when done.
- **Debugging crashes:** stderr is captured via `2>&1` so crash output is visible.
