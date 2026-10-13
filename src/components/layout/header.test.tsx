import { afterEach, expect, test } from "bun:test";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../state/app/context";
import { createStaticAppStore } from "../../test-support/app-store";
import { createDefaultConfig } from "../../types/config";
import { act } from "react";
import { Header } from "./header";
import { resolveHeaderPromptGeometry } from "./shell/chrome";
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
 * A failed update's message can be as long as whatever the updater threw. In the
 * terminal the header counts its columns, so the banner is cut to what the Help
 * pill and the market cluster leave it; it must never reach into either, at any
 * width, and the retry key stays while the message still has room.
 */
test("cuts a failed update to the room the Help pill and the market summary leave it", async () => {
  const error = "Desktop update did not finish downloading because the release server answered with an unexpected response while verifying the signature of the package";
  const release = { version: "9.9.9", tagName: "v9.9.9", downloadUrl: "", publishedAt: "", updateAction: { kind: "desktop" as const } };
  const state = {
    ...createInitialState(createDefaultConfig("/tmp/gloomberb-header-test")),
    updateAvailable: release,
    updateProgress: { phase: "error" as const, error },
  };
  const seen = new Map<number, string>();
  // 60 is the narrowest header that still shows the whole Help pill.
  for (const width of [60, 70, 80, 100, 120, 160, 200, 240, 300]) {
    await tui.render(
      <AppContext value={createStaticAppStore(state)}>
        <Header onOpenHelp={() => {}} />
      </AppContext>,
      { width, height: 1 },
    );
    await tui.setup().renderOnce();
    const frame = tui.frame().split("\n")[0]!;
    seen.set(width, frame);

    const prompt = resolveHeaderPromptGeometry({ termWidth: width });
    const helpX = frame.indexOf("Help ?");
    expect(helpX).toBeGreaterThanOrEqual(0);
    // Whatever sits between the prompt and the Help pill is the banner: it starts
    // as the message, stops short of the pill, and its cut ends in an ellipsis.
    const slot = frame.slice(prompt.left + prompt.width, helpX);
    expect(slot.length).toBeGreaterThan(0);
    expect(slot.endsWith(" ")).toBe(true);
    const banner = slot.trim();
    if (banner) {
      expect(banner.startsWith("Update f")).toBe(true);
      expect(banner).toContain("...");
    }
    // Nothing of it leaks into the prompt on its left or the cluster on its right.
    expect(frame.slice(0, prompt.left + prompt.width)).not.toMatch(/Update|retry/);
    expect(frame.slice(helpX)).not.toMatch(/Update|retry|\.\.\./);
    // The market summary is right of the pill, whole, and not pushed off the row.
    if (width >= 80) expect(frame.slice(helpX)).toMatch(/Help \? +SPY — USD/);
  }

  // Narrow: the slot is a few columns, so the banner keeps the message and drops the key.
  expect(seen.get(70)).toContain("Update fa...");
  expect(seen.get(70)).not.toContain("retry");
  // Wide: the message is cut and the retry key stays after it.
  expect(seen.get(240)).toMatch(/Update failed: Desktop update[^.]*\.\.\.  \S+ retry/);
  expect(seen.get(300)).toMatch(/Update failed: Desktop update[^.]*\.\.\.  \S+ retry/);
  // The longer window shows more of the same message.
  expect(seen.get(300)!.indexOf("...")).toBeGreaterThan(seen.get(240)!.indexOf("..."));
});

test("shows a short failed update whole, on one line", async () => {
  const state = {
    ...createInitialState(createDefaultConfig("/tmp/gloomberb-header-test")),
    updateProgress: { phase: "error" as const, error: "Checksum\n  mismatch" },
  };
  await tui.render(
    <AppContext value={createStaticAppStore(state)}>
      <Header onOpenHelp={() => {}} />
    </AppContext>,
    { width: 200, height: 1 },
  );
  await tui.setup().renderOnce();
  expect(tui.frame()).toContain("Update failed: Checksum mismatch");
});
