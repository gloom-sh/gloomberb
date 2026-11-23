import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useEffect } from "react";
import { apiClient, type CloudAccountPlan } from "../../api-client";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { AppProvider, useAppDispatch, useAppGetState, type AppState } from "../../state/app/context";
import { createTestTicker } from "../../test-support/ticker";
import { createDefaultConfig, type AppConfig } from "../../types/config";
import type { PaneTemplateCreateOptions, PaneTemplateDef } from "../../types/plugin";
import type { TickerRecord } from "../../types/ticker";
import { pressProWelcomeKey } from "./keys";
import { ProWelcomeRow } from "./row";
import { useProWelcome } from "./use-pro-welcome";

const tui = createOpenTuiTestHarness({ width: 120, height: 3 });

const NOW = Date.parse("2026-11-17T12:00:00Z");
const DAY = 86_400_000;
const realNow = Date.now;
const LEAD = "Try Pro";

const TEMPLATES = new Map<string, PaneTemplateDef>(
  [
    ["earnings-calls-pane", "earnings-calls", "Earnings Calls"],
    ["scanner-flow-pane", "scanner-flow", "Options Flow"],
    ["social-mentions-pane", "social-mentions", "Social Mentions"],
    ["jobs-pane", "jobs", "Hiring"],
    ["filing-events-pane", "filing-events", "8-K Filings"],
    ["risk-factors-pane", "risk-factors", "Risk Factors"],
  ].map(([id, paneId, label]) => [id!, { id: id!, paneId: paneId!, label: label! } as PaneTemplateDef]),
);

const TICKERS = new Map<string, TickerRecord>([
  ["NVDA", createTestTicker("NVDA", "NVIDIA", { portfolios: ["main"] })],
  ["AAPL", createTestTicker("AAPL", "Apple", { watchlists: ["watch"] })],
]);

/** The app's state store, as far as the row uses it: one owner's keys in memory, kept across launches. */
function memoryState() {
  const values = new Map<string, unknown>();
  return {
    values,
    get: <T,>(owner: string, key: string) => (values.has(`${owner}/${key}`) ? { value: values.get(`${owner}/${key}`) as T } : null),
    set: (owner: string, key: string, value: unknown) => {
      values.set(`${owner}/${key}`, value);
    },
  } as unknown as Parameters<typeof useProWelcome>[0]["pluginState"] & { values: Map<string, unknown> };
}

function signIn(user: { plan: "free" | "pro"; trialEndsAt?: string | null }) {
  apiClient.setSessionToken("pro-welcome-test");
  apiClient.restoreCachedUser({ id: "u1", name: "Sam", emailVerified: true, ...user });
}

interface Launch {
  getState: () => AppState;
  opened: Array<{ templateId: string; options?: PaneTemplateCreateOptions }>;
  planRequests: () => number;
}

async function launch({
  pluginState,
  plan,
  config: overrides = {},
}: {
  pluginState: ReturnType<typeof memoryState>;
  plan: CloudAccountPlan;
  config?: Partial<AppConfig>;
}): Promise<Launch> {
  const handle: Launch = { getState: () => { throw new Error("not mounted"); }, opened: [], planRequests: () => requests };
  let requests = 0;
  const registry = {
    paneTemplates: TEMPLATES,
    createPaneFromTemplateAsync: async (templateId: string, options?: PaneTemplateCreateOptions) => {
      handle.opened.push({ templateId, options });
    },
  };
  function Workspace() {
    const dispatch = useAppDispatch();
    handle.getState = useAppGetState();
    useEffect(() => {
      dispatch({ type: "SET_TICKERS", tickers: new Map(TICKERS) });
      dispatch({ type: "SET_INITIALIZED" });
    }, [dispatch]);
    const welcome = useProWelcome({
      active: true,
      pluginState,
      pluginRegistry: registry,
      loadPlan: async () => {
        requests += 1;
        return plan;
      },
    });
    return welcome.chips ? <ProWelcomeRow welcome={welcome} /> : null;
  }
  const config: AppConfig = {
    ...createDefaultConfig("/tmp/gloomberb-pro-welcome"),
    onboardingComplete: true,
    portfolios: [{ id: "main", name: "Main", currency: "USD" }],
    watchlists: [{ id: "watch", name: "Watch" }],
    ...overrides,
  } as AppConfig;
  await tui.render(<AppProvider config={config}><Workspace /></AppProvider>);
  await tui.renderFrames(3);
  return handle;
}

const paid = (daysAgo: number): CloudAccountPlan => ({
  firstChargeAt: new Date(NOW - daysAgo * DAY).toISOString(),
  proTeam: null,
});

describe("ProWelcomeRow", () => {
  beforeEach(() => {
    Date.now = () => NOW;
  });

  afterEach(async () => {
    await tui.destroy();
    Date.now = realNow;
    apiClient.setSessionToken(null);
  });

  test("a payer in their first two weeks sees Pro functions they have not opened, each opening on their own ticker", async () => {
    signIn({ plan: "pro" });
    const run = await launch({
      pluginState: memoryState(),
      plan: paid(2),
      config: { recentCommands: [{ id: "pane-template:jobs-pane", label: "Hiring", arg: "NVDA" }] },
    });

    const frame = await tui.waitForFrameToContain(LEAD);
    expect(frame).toContain("Earnings calls · NVDA");
    expect(frame).toContain("Options flow · AAPL");
    expect(frame).toContain("X mentions · NVDA");
    expect(frame).toContain("Dismiss");
    expect(run.planRequests()).toBe(1);

    await tui.clickFrameText("Earnings calls · NVDA");
    expect(run.opened).toEqual([{
      templateId: "earnings-calls-pane",
      options: { arg: "NVDA", symbol: "NVDA", ticker: TICKERS.get("NVDA")! },
    }]);
    // Kept as a command bar run, so the row names the next function instead.
    expect(run.getState().config.recentCommands[0]).toEqual({ id: "pane-template:earnings-calls-pane", label: "Earnings Calls", arg: "NVDA" });
    const next = await tui.waitForFrameToContain("8-K events");
    expect(next).not.toContain("Earnings calls");
  });

  test("dismissed for good: gone now and on the next launch, which asks the server nothing", async () => {
    signIn({ plan: "pro" });
    const pluginState = memoryState();
    await launch({ pluginState, plan: paid(0) });
    await tui.waitForFrameToContain(LEAD);

    await act(async () => {
      expect(pressProWelcomeKey("dismiss")).toBe(true);
    });
    await tui.waitForFrameToExclude(LEAD);
    expect(pressProWelcomeKey("dismiss")).toBe(false);
    await tui.destroy();

    const again = await launch({ pluginState, plan: paid(0) });
    await tui.renderFrames(3);
    expect(tui.frame()).not.toContain(LEAD);
    expect(again.planRequests()).toBe(0);
  });

  test("a trial sees it from its first day, before any charge", async () => {
    signIn({ plan: "pro", trialEndsAt: new Date(NOW + 7 * DAY).toISOString() });
    const run = await launch({ pluginState: memoryState(), plan: { firstChargeAt: null, proTeam: null } });

    const frame = await tui.waitForFrameToContain(LEAD);
    expect(frame).toContain("Earnings calls · NVDA");
    expect(run.planRequests()).toBe(1);
  });

  test("not past day 14, with Pro through a team, or on Free", async () => {
    signIn({ plan: "free" });
    const free = await launch({ pluginState: memoryState(), plan: paid(0) });
    expect(free.planRequests()).toBe(0);
    expect(tui.frame()).not.toContain(LEAD);
    await tui.destroy();

    signIn({ plan: "pro" });
    for (const plan of [paid(15), { ...paid(1), proTeam: { id: "t1", name: "Desk" } }]) {
      const run = await launch({ pluginState: memoryState(), plan });
      await tui.renderFrames(3);
      expect(run.planRequests()).toBe(1);
      expect(tui.frame()).not.toContain(LEAD);
      await tui.destroy();
    }
  });
});
