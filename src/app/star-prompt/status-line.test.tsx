import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { setConfigStoreHost, type ConfigStoreHost } from "../../data/config/store";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { AppProvider, useAppGetState, type AppState } from "../../state/app/context";
import { flushPendingPersistence } from "../../state/persist-scheduler";
import { createDefaultConfig, type AppConfig, type StarPromptConfig } from "../../types/config";
import { localDayKey } from "./model";
import { allowStarPrompt, pressStarPromptKey } from "./runtime";
import { StarPromptStatusLine } from "./status-line";

const tui = createOpenTuiTestHarness({ width: 100, height: 2 });
const LEAD = "Star it on GitHub";
const TWO_DAYS = ["2026-01-01", "2026-01-02"];
let saved: AppConfig[] = [];

const recordingHost = {
  saveConfig: async (config: AppConfig) => {
    saved.push(config);
  },
} as unknown as ConfigStoreHost;

async function launch(starPrompt: StarPromptConfig | undefined): Promise<() => AppState> {
  let getState: (() => AppState) | null = null;
  function Probe() {
    getState = useAppGetState();
    return null;
  }
  const config: AppConfig = {
    ...createDefaultConfig("/tmp/gloomberb-star-prompt-test"),
    onboardingComplete: true,
    ...(starPrompt ? { starPrompt } : {}),
  };
  await tui.render(
    <AppProvider config={config}>
      <StarPromptStatusLine delayMs={0} />
      <Probe />
    </AppProvider>,
  );
  await tui.renderFrames(3);
  return () => getState!();
}

/** The notification key, as the global shortcuts hand it to the line. */
async function press(kind: "open" | "dismiss"): Promise<boolean> {
  let handled = false;
  await act(async () => {
    handled = pressStarPromptKey(kind);
  });
  return handled;
}

describe("StarPromptStatusLine", () => {
  beforeEach(() => {
    saved = [];
    allowStarPrompt(true);
    setConfigStoreHost(recordingHost);
  });

  afterEach(async () => {
    allowStarPrompt(false);
    await flushPendingPersistence();
    setConfigStoreHost(null);
  });

  test("shows on the third day of use, saves that it showed, and never returns after the dismiss key", async () => {
    const state = await launch({ days: TWO_DAYS });
    await tui.waitForFrameToContain(LEAD);
    const shownAt = state().config.starPrompt?.shownAt;
    expect(shownAt).toBeString();
    await flushPendingPersistence();
    expect(saved.at(-1)?.starPrompt).toEqual({ shownAt });

    expect(await press("dismiss")).toBe(true);
    await tui.waitForFrameToExclude(LEAD);
    await flushPendingPersistence();
    expect(saved.at(-1)?.starPrompt).toEqual({ shownAt, outcome: "dismissed" });
    expect(await press("dismiss")).toBe(false);

    // The next launch reads what was saved.
    const relaunched = await launch(saved.at(-1)?.starPrompt);
    await tui.renderFrames(5);
    expect(tui.frame()).not.toContain("GitHub");
    expect(relaunched().config.starPrompt).toEqual({ shownAt, outcome: "dismissed" });
  });

  test("opening it ends it too, by key or by click", async () => {
    let state = await launch({ days: TWO_DAYS });
    await tui.waitForFrameToContain(LEAD);
    expect(await press("open")).toBe(true);
    await tui.waitForFrameToExclude(LEAD);
    expect(state().config.starPrompt?.outcome).toBe("opened");

    state = await launch({ days: TWO_DAYS });
    await tui.waitForFrameToContain(LEAD);
    await tui.clickFrameText(LEAD);
    await tui.waitForFrameToExclude(LEAD);
    expect(state().config.starPrompt?.outcome).toBe("opened");
  });

  test("counts today on the first two days and stays hidden", async () => {
    const state = await launch({ days: ["2026-01-01"] });
    expect(state().config.starPrompt).toEqual({ days: ["2026-01-01", localDayKey(new Date())] });
    await flushPendingPersistence();
    expect(saved.at(-1)?.starPrompt).toEqual({ days: ["2026-01-01", localDayKey(new Date())] });
    expect(tui.frame()).not.toContain("GitHub");
  });

  test("the off switch keeps it hidden and records nothing", async () => {
    const state = await launch({ enabled: false, days: TWO_DAYS });
    await tui.renderFrames(5);
    expect(tui.frame()).not.toContain("GitHub");
    expect(state().config.starPrompt).toEqual({ enabled: false, days: TWO_DAYS });
    await flushPendingPersistence();
    expect(saved).toEqual([]);
  });

  test("records nothing and shows nothing unless the terminal app allowed it", async () => {
    allowStarPrompt(false);
    const state = await launch({ days: TWO_DAYS });
    await tui.renderFrames(5);
    expect(tui.frame()).not.toContain("GitHub");
    expect(state().config.starPrompt).toEqual({ days: TWO_DAYS });
    await flushPendingPersistence();
    expect(saved).toEqual([]);
    expect(await press("open")).toBe(false);
  });
});
