import { afterEach, expect, jest, test } from "bun:test";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { AppContext, createInitialState, type AppAction, type AppState } from "../../state/app/context";
import { createStaticAppStore } from "../../test-support/app-store";
import { createDefaultConfig } from "../../types/config";
import { act } from "react";
import { Header } from "./header";
import { publishCommandBarPrompt } from "../command-bar/panel/prompt-binding";

const tui = createOpenTuiTestHarness();

afterEach(() => {
  publishCommandBarPrompt(null);
});

test("opens the command bar by clicking the header prompt", async () => {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-header-test"));
  const actions: Array<{ type: string; open?: boolean; query?: string }> = [];
  await tui.render(
    <AppContext value={createStaticAppStore(state, (action) => actions.push(action as { type: string }))}>
      <Header />
    </AppContext>,
    { width: 120, height: 1 },
  );

  await tui.setup().renderOnce();
  const promptX = tui.frame().indexOf(">");
  expect(promptX).toBeGreaterThanOrEqual(0);

  await act(async () => {
    await tui.setup().mockMouse.click(promptX + 2, 0);
    await tui.setup().renderOnce();
  });

  expect(actions).toContainEqual({ type: "SET_COMMAND_BAR", open: true, query: "" });
});

/**
 * While the bar is open the header prompt is its input: what the panel
 * publishes is what the user types into, and a screen without a binding (a
 * workflow with its own fields) must not put a focused input in the header.
 */
test("hosts the command bar input while a list screen is published", async () => {
  const state = {
    ...createInitialState(createDefaultConfig("/tmp/gloomberb-header-test")),
    commandBarOpen: true,
  };
  const typed: string[] = [];
  await tui.render(
    <AppContext value={createStaticAppStore(state)}>
      <Header />
    </AppContext>,
    { width: 120, height: 1 },
  );
  await tui.setup().renderOnce();
  expect(tui.frame()).not.toContain("Search or run a command");

  await act(async () => {
    publishCommandBarPrompt({
      screenKey: "root:Commands",
      query: "QQ",
      placeholder: "Command or plain English…",
      ghostSuffix: " AAPL",
      onQueryChange: (query) => typed.push(query),
    });
    await tui.setup().renderOnce();
  });
  expect(tui.frame()).toContain("QQ AAPL");

  await act(async () => {
    await tui.setup().mockInput.typeText("x");
    await tui.setup().renderOnce();
  });
  expect(typed).toEqual(["QQx"]);

  await act(async () => {
    publishCommandBarPrompt(null);
    await tui.setup().renderOnce();
  });
  expect(tui.frame()).not.toContain("QQ");
});

/**
 * A downloaded desktop update waits for the user: the header names it and
 * offers Restart, which is clickable. The terminal binary is already swapped
 * in, so it only says to restart and has nothing to press.
 */
test("offers a clickable Restart for a downloaded desktop update, and only text for a terminal one", async () => {
  const config = createDefaultConfig("/tmp/gloomberb-header-test");
  const desktop = { ...createInitialState(config), updateProgress: { phase: "ready" as const, canRestart: true } };
  let restarts = 0;
  await tui.render(
    <AppContext value={createStaticAppStore(desktop)}>
      <Header onRestartForUpdate={() => { restarts += 1; }} />
    </AppContext>,
    { width: 120, height: 1 },
  );
  await tui.setup().renderOnce();
  expect(tui.frame()).toContain("Update ready");
  const restartX = tui.frame().indexOf("Restart");
  expect(restartX).toBeGreaterThanOrEqual(0);
  // The key that restarts is advertised beside the button.
  expect(tui.frame()).toMatch(/Restart\s+u/i);

  await act(async () => {
    await tui.setup().mockMouse.click(restartX + 2, 0);
    await tui.setup().renderOnce();
  });
  expect(restarts).toBe(1);

  const terminal = { ...createInitialState(config), updateProgress: { phase: "ready" as const } };
  await tui.render(
    <AppContext value={createStaticAppStore(terminal)}>
      <Header onRestartForUpdate={() => { restarts += 1; }} />
    </AppContext>,
    { width: 120, height: 1 },
  );
  await tui.setup().renderOnce();
  expect(tui.frame()).toContain("Update ready, restart to apply");
  expect(tui.frame()).not.toContain("Restart ");
});

/**
 * The terminal header at 80 to 160 columns left the update status under a
 * dozen columns, so a failed update said nothing at all. The closed
 * prompt now gives the status its empty room, down to its placeholder, and the
 * banner says the reason in a few words. It must never reach into the prompt's
 * placeholder, the Help pill or the market cluster, at any width.
 */
test("gives a failed update room at common terminal widths and keeps it clear of its neighbours", async () => {
  const release = { version: "9.9.9", tagName: "v9.9.9", downloadUrl: "", publishedAt: "", updateAction: { kind: "desktop" as const } };
  const state = {
    ...createInitialState(createDefaultConfig("/tmp/gloomberb-header-test")),
    updateAvailable: release,
    updateProgress: {
      phase: "error" as const,
      error: "Failed to download latest version from https://example.test/releases/latest/download/stable-macos-arm64-Gloomberb.app.tar.zst",
      failure: { phase: "download" as const, code: "interrupted" as const },
    },
  };
  const seen = new Map<number, string>();
  // 60 is the narrowest header that still shows the whole Help pill.
  for (const width of [60, 70, 80, 100, 120, 160, 200, 300]) {
    await tui.render(
      <AppContext value={createStaticAppStore(state)}>
        <Header onOpenHelp={() => {}} />
      </AppContext>,
      { width, height: 1 },
    );
    await tui.setup().renderOnce();
    const frame = tui.frame().split("\n")[0]!;
    seen.set(width, frame);

    const helpX = frame.indexOf("Help ?");
    expect(helpX).toBeGreaterThanOrEqual(0);
    // The placeholder stays whole; the banner sits between it and the pill, a cell clear of the pill.
    const placeholderEnd = frame.indexOf("Search or run a command") + "Search or run a command".length;
    expect(placeholderEnd).toBeGreaterThan(0);
    const slot = frame.slice(placeholderEnd, helpX);
    expect(slot.endsWith(" ")).toBe(true);
    // Only the prompt's key hint, when it still has room for it, comes before the banner.
    expect(slot.trim()).toMatch(/^(?:\S+\s+)?Update failed/);
    expect(frame.slice(helpX)).not.toMatch(/Update|retry|\.\.\./);
    // The market summary is right of the pill, whole, and not pushed off the row.
    if (width >= 80) expect(frame.slice(helpX)).toMatch(/Help \? +SPY — base USD/);
    // The raw error, with its URL, stays out of the header.
    expect(frame).not.toContain("example.test");
  }

  // 80 columns: no room for the reason, so the banner says it failed and how to retry.
  expect(seen.get(80)).toMatch(/Update failed {2}\S+ retry/);
  // 100: as much of the reason as reads.
  expect(seen.get(100)).toContain("Update failed: download inte");
  // 120: the reason whole; 160 and wider: with the retry key after it.
  expect(seen.get(120)).toContain("Update failed: download interrupted");
  for (const width of [160, 200, 300]) expect(seen.get(width)).toMatch(/Update failed: download interrupted {2}\S+ retry/);
});

/**
 * Every other line in the slot (a passing notice, a download's progress, a
 * ready update) was once drawn whole and ran into the Help pill.
 */
test("cuts every update line to its slot, keeping a download's percent", async () => {
  const release = { version: "9.9.9", tagName: "v9.9.9", downloadUrl: "", publishedAt: "", updateAction: { kind: "desktop" as const } };
  const config = createDefaultConfig("/tmp/gloomberb-header-test");
  for (const extra of [
    { updateNotice: "Update check failed: no connection, and some more words than fit" },
    { updateAvailable: release, updateProgress: { phase: "downloading" as const, percent: 42 } },
    { updateAvailable: release, updateProgress: { phase: "ready" as const } },
  ]) {
    for (const width of [60, 70, 80]) {
      await tui.render(
        <AppContext value={createStaticAppStore({ ...createInitialState(config), ...extra })}>
          <Header onOpenHelp={() => {}} />
        </AppContext>,
        { width, height: 1 },
      );
      await tui.setup().renderOnce();
      const frame = tui.frame().split("\n")[0]!;
      const helpX = frame.indexOf("Help ?");
      expect(helpX).toBeGreaterThan(0);
      expect(frame[helpX - 1]).toBe(" ");
      if (extra.updateProgress?.phase === "downloading") expect(frame).toContain("42%");
    }
  }
});

/** The banner says why in a few words for every step that can fail; the command bar has the whole error. */
test.each([
  [{ phase: "download", code: "interrupted" }, "Update failed: download interrupted"],
  [{ phase: "download", code: "rate_limited" }, "Update failed: GitHub rate limit"],
  [{ phase: "verify", code: "corrupt" }, "Update failed: download corrupted"],
  [{ phase: "apply", code: "permission_denied" }, "Update failed: no permission to replace the app"],
  [{ phase: "apply", code: "wrong_location" }, "Update failed: move the app to Applications"],
  [{ phase: "relaunch", code: "unknown" }, "Update failed: could not restart"],
] as const)("says why a %o failed", async (failure, banner) => {
  const state = {
    ...createInitialState(createDefaultConfig("/tmp/gloomberb-header-test")),
    updateProgress: { phase: "error" as const, error: "EACCES: permission denied, rename '/Users/someone/Gloomberb.app'", failure },
  };
  await tui.render(
    <AppContext value={createStaticAppStore(state)}>
      <Header onOpenHelp={() => {}} />
    </AppContext>,
    { width: 240, height: 1 },
  );
  await tui.setup().renderOnce();
  expect(tui.frame()).toContain(banner);
  expect(tui.frame()).not.toContain("someone");
});

/**
 * A download that found nothing to take ends as a notice, which goes after
 * its time like any other. An install that is restarting keeps its line: the
 * app quits under it.
 */
test("lets a passing update notice go, and keeps an install that is restarting", async () => {
  const config = createDefaultConfig("/tmp/gloomberb-header-test");
  const actions: AppAction[] = [];
  const renderWith = async (state: Partial<AppState>) => {
    await tui.render(
      <AppContext value={createStaticAppStore({ ...createInitialState(config), ...state }, (action) => actions.push(action))}>
        <Header />
      </AppContext>,
      { width: 120, height: 1 },
    );
    await tui.setup().renderOnce();
  };
  jest.useFakeTimers();
  try {
    await renderWith({ updateNotice: "Already on the latest version" });
    expect(tui.frame()).toContain("Already on the latest version");
    jest.advanceTimersByTime(4_999);
    expect(actions).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(actions).toEqual([{ type: "SET_UPDATE_NOTICE", notice: null }]);

    actions.length = 0;
    await renderWith({ updateProgress: { phase: "done", message: "Update installed, restarting..." } });
    jest.advanceTimersByTime(60_000);
    await tui.setup().renderOnce();
    expect(actions).toEqual([]);
    expect(tui.frame()).toContain("Update installed, restarting...");
  } finally {
    jest.useRealTimers();
  }
});
