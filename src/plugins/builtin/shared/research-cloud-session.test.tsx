import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient, type AuthUser } from "../../../api-client";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createTestControls, emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { TestPaneProvider, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box } from "../../../ui";
import { DividendYieldPane } from "../dividend-yield/pane";
import { fetchProviderDividendData } from "../dividend-yield/provider-client";
import { AnalystResearchView } from "../research/analyst-pane";
import { CorporateActionsView } from "../research/corporate-actions-pane";
import { isCloudSessionRequired } from "./research-cloud-session";

const denial = "Gloom Cloud requires signup and email verification";
const panes = ["dividend-yield", "analyst-research", "corporate-actions", "earnings-estimates"] as const;
let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let user: AuthUser | null = null;
const listeners = new Set<() => void>();
let getUserSpy: ReturnType<typeof spyOn>;
let subscribeSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  user = null;
  getUserSpy = spyOn(apiClient, "getCurrentUser").mockImplementation(() => user);
  subscribeSpy = spyOn(apiClient, "subscribeCurrentUser").mockImplementation((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
});

afterEach(async () => {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  setup = undefined;
  getUserSpy.mockRestore();
  subscribeSpy.mockRestore();
  listeners.clear();
});

async function frame() {
  await act(async () => { await Bun.sleep(1); });
  await act(async () => { await setup!.renderOnce(); });
}

async function setSession(emailVerified: boolean | null) {
  await act(async () => {
    user = emailVerified === null ? null : { id: "research-test", email: "research@example.test", emailVerified, plan: "free" } as AuthUser;
    for (const listener of listeners) listener();
  });
  for (let i = 0; i < 5; i++) await frame();
}

async function render(pane: typeof panes[number], state: { cloudRequired: boolean; failure?: string; analystDenied?: boolean }) {
  const commands: string[] = [];
  const checkAccess = () => {
    if (state.failure) throw new Error(state.failure);
    if (state.cloudRequired && !user?.emailVerified) throw new Error(denial);
  };
  const provider = createTestDataProvider({
    getCorporateActions: async () => {
      checkAccess();
      return { symbol: "TEST", currency: "USD", coverage: { dividends: "available", earnings: "available", splits: "available" },
        dividends: [{ exDate: "2026-08-01", amount: 0.25 }], splits: [],
        earnings: [{ date: "2026-06-30", dateType: "fiscal-period-end", epsActual: 2, currency: "USD" }],
      };
    },
    getAnalystResearch: async () => {
      checkAccess();
      if (state.analystDenied) throw new Error(denial);
      return { symbol: "TEST", currency: "USD", recommendations: [], ratings: [{ date: "2026-08-01", firm: "Fixture Research", currentPriceTarget: 120 }],
        earningsEstimates: [{ date: "2026-09-30", period: "current_quarter", average: 3 }], revenueEstimates: [],
      };
    },
  });
  const id = `${pane}:TEST`;
  const config = createTestPaneConfig("/tmp/gloom-research-auth-test", { instanceId: id, paneId: pane, binding: { kind: "fixed", symbol: "TEST" } });
  const appState = createInitialState(config);
  appState.focusedPaneId = id;
  appState.tickers = new Map([["TEST", createTestTicker("TEST", "Test", { exchange: "ASX" })]]);
  const runtime = createTestPluginRuntime({ getMarketData: () => provider, openCommandBar: (query) => commands.push(query ?? "") });
  const loadData = (symbol: string, price: number | null, exchange?: string, currency?: string) => fetchProviderDividendData(provider, symbol, price, exchange, currency);
  const content = pane === "dividend-yield"
    ? <DividendYieldPane focused width={80} height={23} loadData={loadData} />
    : pane === "analyst-research"
      ? <AnalystResearchView focused width={80} height={23} />
      : <CorporateActionsView focused width={80} height={23} variant={pane} footerPaneId={pane} />;
  await act(async () => {
    setup = await testRender(<TestPaneProvider state={appState} paneId={id} pluginId="ticker-research" runtime={runtime}>
      <PaneFooterProvider>{(footer) => <Box width={80} height={24} flexDirection="column">
        <Box width={80} height={23}>{content}</Box>
        <PaneFooterBar footer={footer} focused width={80} />
      </Box>}</PaneFooterProvider>
    </TestPaneProvider>, { width: 80, height: 24 });
  });
  for (let i = 0; i < 5; i++) await frame();
  return commands;
}

test.each(panes)("%s recovers from sign-in and verification while preserving provider failures", async (pane) => {
  const state = { cloudRequired: true, failure: undefined as string | undefined };
  const commands = await render(pane, state);
  const controls = createTestControls(() => setup!);
  expect(setup!.captureCharFrame()).toContain("Sign in to");
  expect(setup!.captureCharFrame()).not.toContain(denial);
  await controls.clickFrameText("Log in");
  expect(commands.at(-1)).toBe("Log In");
  await setSession(false);
  expect(setup!.captureCharFrame()).toContain("Verify your email to");
  await controls.clickFrameText("Resend Verification Email");
  expect(commands.at(-1)).toBe("Resend Verification Email");
  state.failure = "Research provider timed out";
  await setSession(true);
  expect(setup!.captureCharFrame()).toContain(state.failure);
  expect(setup!.captureCharFrame()).not.toContain("Sign in to");
  state.failure = undefined;
  await emitKeypress(setup!, { name: "r" });
  for (let i = 0; i < 5; i++) await frame();
  expect(setup!.captureCharFrame()).toContain(pane === "dividend-yield" ? "TTM Cash/Share" : pane === "analyst-research" ? "Fixture Research" : "Earnings");
  expect(setup!.captureCharFrame()).not.toContain("Research provider timed out");
  // A usable non-Cloud source remains available without any signed-in account.
  state.cloudRequired = false;
  await setSession(null);
  expect(setup!.captureCharFrame()).not.toContain("Sign in to");
  expect(setup!.captureCharFrame()).toContain(pane === "dividend-yield" ? "TTM Cash/Share" : pane === "analyst-research" ? "Fixture Research" : "Earnings");
});

test("partial event data keeps usable rows and reports an auth-denied source once", async () => {
  await render("corporate-actions", { cloudRequired: false, analystDenied: true });
  const output = setup!.captureCharFrame();
  expect(output).toContain("Dividend");
  expect(output).toContain("Earnings");
  expect(output.match(/Gloom Cloud requires signup/g)).toHaveLength(1);
  expect(output).not.toContain("Sign in to");
});

test("Cloud account detection does not turn unrelated provider failures into sign-in prompts", () => {
  expect(isCloudSessionRequired(denial)).toBe(true);
  for (const error of [null, "Unauthorized: Yahoo", "Verification service unavailable", "Cloud request failed", "Gloom Cloud Pro required"]) {
    expect(isCloudSessionRequired(error)).toBe(false);
  }
});
