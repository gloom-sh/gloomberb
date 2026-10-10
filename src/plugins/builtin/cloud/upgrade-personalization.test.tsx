import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../api-client";
import type { ExperimentAnswer } from "../../../api-client/web-experiments";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../../state/app/context";
import { setAppVisible } from "../../../state/app/activity";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createTestTicker } from "../../../test-support/ticker";
import { createDefaultConfig } from "../../../types/config";
import { Text } from "../../../ui";
import { proStepRealtimeTitle } from "./upgrade-dialog";
import { useUpgradePersonalization } from "./upgrade-personalization";

const tui = createOpenTuiTestHarness({ width: 80, height: 20 });
const originalExposure = apiClient.recordExperimentExposure;
let account = 0;

function signIn() {
  act(() => {
    apiClient.setSessionToken("personalization-test-session");
    apiClient.restoreCachedUser({ id: `personalization-render-${++account}`, email: "test@example.com", emailVerified: true, plan: "free" });
  });
}

function Probe({ shown }: { shown: boolean }) {
  return <Text>{proStepRealtimeTitle(useUpgradePersonalization("onboarding-pro", shown))}</Text>;
}

async function render({ shown = true, held = true } = {}) {
  const state = createInitialState(createDefaultConfig(`${process.env.HOME}/.cache/gloom-smoke/glo357/unit`));
  state.tickers.set("NVDA", createTestTicker("NVDA", "Nvidia", {
    watchlists: [state.config.watchlists[0]!.id],
    positions: held ? [{ portfolio: "main", shares: 10, marketValue: 1000, broker: "manual" }] : [],
  }));
  await act(async () => {
    await tui.render(<AppContext value={createStaticAppStore(state)}><Probe shown={shown} /></AppContext>);
  });
  await tui.waitForFrameToContain("Real-time");
}

afterEach(() => {
  apiClient.recordExperimentExposure = originalExposure;
  act(() => {
    apiClient.setSessionToken(null);
    apiClient.restoreCachedUser(null);
    setAppVisible(true);
  });
});

test("hidden, signed-out and seed-only viewers keep generic copy without exposure", async () => {
  let requests = 0;
  apiClient.recordExperimentExposure = async () => {
    requests++;
    return { accepted: true, variant: "personalized" };
  };
  await render();
  expect(tui.frame()).toContain("Real-time market data");
  await tui.destroy();
  signIn();
  await render({ shown: false });
  await render({ held: false });
  act(() => setAppVisible(false));
  await render();
  expect(tui.frame()).toContain("Real-time market data");
  expect(requests).toBe(0);
});

test("the same visible eligibility enrolls both arms; changing accounts never reuses the previous copy", async () => {
  for (const variant of ["control", "personalized"] as const) {
    await tui.destroy();
    signIn();
    const response = Promise.withResolvers<ExperimentAnswer>();
    let requests = 0;
    apiClient.recordExperimentExposure = () => { requests++; return response.promise; };
    await render();
    expect(tui.frame()).toContain("Real-time market data");
    expect(requests).toBe(1);
    await act(async () => response.resolve({ accepted: true, variant }));
    await tui.waitForFrameToContain(variant === "personalized" ? "Real-time quotes for NVDA" : "Real-time market data");
    await render();
    expect(requests).toBe(1);
  }
  act(() => apiClient.restoreCachedUser(null));
  await render();
  expect(tui.frame()).toContain("Real-time market data");
});
