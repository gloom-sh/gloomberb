import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { apiClient, setCloudApiFetchTransport } from "../../../api-client";
import type { CloudEquityDiagnosticResponse } from "../../../api-client";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { testRender } from "../../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { cloneLayout, createDefaultConfig } from "../../../types/config";
import type { TickerRecord } from "../../../types/ticker";
import { Box } from "../../../ui";
import { PluginRenderProvider } from "../../runtime";
import { EquityDiagnosticView } from "./equity-diagnostic-pane";

const TEST_PANE_ID = "equity-diagnostic:AAPL";
const WIDTH = 96;
/** Tall enough that a full report fits without scrolling the assertions away. */
const HEIGHT = 44;

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

function makeTicker(symbol: string): TickerRecord {
  return {
    metadata: {
      ticker: symbol,
      exchange: "NASDAQ",
      currency: "USD",
      name: symbol,
      portfolios: [],
      watchlists: [],
      positions: [],
      custom: {},
      tags: [],
    },
  };
}

function signIn(plan: "free" | "pro"): void {
  apiClient.setSessionToken("equity-diagnostic-test-token");
  apiClient.restoreCachedUser({
    id: "user-1",
    name: "Tester",
    email: "tester@example.com",
    username: "tester",
    emailVerified: true,
    plan,
  } as never);
}

/** Answers the diagnostic endpoint locally and records the request bodies. */
function mockDiagnosticTransport(
  respond: (body: { symbol: string; exchange?: string; mode?: string }) => Response,
): Array<{ symbol: string; exchange?: string; mode?: string }> {
  const requests: Array<{ symbol: string; exchange?: string; mode?: string }> = [];
  setCloudApiFetchTransport(async (url, init) => {
    if (!url.endsWith("/research/equity-diagnostic")) {
      throw new Error(`unexpected cloud request: ${url}`);
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push(body);
    return respond(body);
  });
  return requests;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeReport(overrides: Partial<CloudEquityDiagnosticResponse> = {}): CloudEquityDiagnosticResponse {
  return {
    schemaVersion: 1,
    symbol: "AAPL",
    exchange: "NASDAQ",
    companyName: "Apple Inc.",
    status: "partial",
    verdict: "risk_skewed",
    summary: "Margins slipped while inventory built up.",
    confidence: 0.72,
    findings: [
      {
        id: "f-low",
        kind: "red_flag",
        severity: 1,
        confidence: 0.4,
        title: "Receivables grew faster than sales",
        observation: "Receivables rose 18 percent against 4 percent revenue growth.",
        interpretation: "Collection may be slowing.",
        evidenceIds: [],
      },
      {
        id: "f-high",
        kind: "red_flag",
        severity: 3,
        confidence: 0.81,
        title: "Gross margin fell for three quarters",
        observation: "Gross margin fell to 38.2 percent from 44.6 percent.",
        interpretation: "Pricing pressure is outpacing mix improvement.",
        evidenceIds: ["ev-10k", "ev-missing"],
      },
      {
        id: "f-green",
        kind: "green_flag",
        severity: 2,
        confidence: 0.6,
        title: "Buyback pace accelerated",
        observation: "Shares outstanding fell 3 percent.",
        interpretation: "Capital return is intact.",
        evidenceIds: ["ev-news"],
      },
    ],
    watchItems: ["Next quarter gross margin guidance"],
    coverage: [
      { dataset: "financials", status: "available", asOf: "2026-02-01", provider: "polygon" },
      { dataset: "insider", status: "no_data" },
    ],
    evidence: [
      { id: "ev-10k", dataset: "filings", label: "10-K", asOf: "2026-02-01", url: "https://sec.gov/aapl-10k" },
      { id: "ev-news", dataset: "news", label: "Reuters" },
    ],
    generatedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshAllowedAt: new Date(Date.now() + 600_000).toISOString(),
    cached: true,
    stale: true,
    promptVersion: 1,
    model: "gpt-5.6-luna",
    ...overrides,
  };
}

function DiagnosticHarness() {
  const config = createDefaultConfig("/tmp/gloomberb-equity-diagnostic-test");
  config.layout = {
    dockRoot: { kind: "pane", instanceId: TEST_PANE_ID },
    instances: [{
      instanceId: TEST_PANE_ID,
      paneId: "equity-diagnostic",
      binding: { kind: "fixed", symbol: "AAPL" },
    }],
    floating: [],
    detached: [],
  };
  config.layouts = [{ name: "Default", layout: cloneLayout(config.layout) }];

  const state = createInitialState(config);
  state.focusedPaneId = TEST_PANE_ID;
  state.tickers = new Map([["AAPL", makeTicker("AAPL")]]);

  return (
    <AppContext value={{ state, dispatch: () => {} }}>
      <PaneInstanceProvider paneId={TEST_PANE_ID}>
        <PluginRenderProvider pluginId="ticker-research" runtime={createTestPluginRuntime()}>
          <PaneFooterProvider>
            {(footer) => (
              <Box flexDirection="column" width={WIDTH} height={HEIGHT}>
                <EquityDiagnosticView width={WIDTH} height={HEIGHT - 1} focused />
                <PaneFooterBar footer={footer} focused width={WIDTH} />
              </Box>
            )}
          </PaneFooterProvider>
        </PluginRenderProvider>
      </PaneInstanceProvider>
    </AppContext>
  );
}

async function renderHarness(): Promise<void> {
  await act(async () => {
    testSetup = await testRender(<DiagnosticHarness />, { width: WIDTH, height: HEIGHT });
  });
  await settle();
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await act(async () => {
      await Bun.sleep(1);
      await testSetup!.renderOnce();
    });
  }
}

async function pressKey(name: string): Promise<void> {
  await act(async () => {
    testSetup!.renderer.keyInput.emit("keypress", {
      name,
      sequence: name,
      ctrl: false,
      meta: false,
      option: false,
      shift: false,
      eventType: "press",
      repeated: false,
      stopPropagation: () => {},
      preventDefault: () => {},
    } as never);
    await testSetup!.renderOnce();
  });
  await settle();
}

afterEach(async () => {
  if (testSetup) {
    await act(async () => testSetup!.renderer.destroy());
    testSetup = undefined;
  }
  setCloudApiFetchTransport(null);
  apiClient.setSessionToken(null);
  apiClient.restoreCachedUser(null);
});

test("keeps the diagnostic behind Pro and never asks the server for a free account", async () => {
  signIn("free");
  const requests = mockDiagnosticTransport(() => jsonResponse(makeReport()));

  await renderHarness();

  const frame = testSetup!.captureCharFrame();
  expect(requests).toHaveLength(0);
  expect(frame).toContain("Gloom Cloud Pro");
  expect(frame).toContain("Upgrade to Pro");
  expect(frame).toContain("Manage account");
  // A gated pane has nothing to refresh.
  expect(frame).not.toContain("efresh");
});

test("renders a stale partial report with severity order, split observation, and citations", async () => {
  signIn("pro");
  mockDiagnosticTransport(() => jsonResponse(makeReport()));

  await renderHarness();

  const frame = testSetup!.captureCharFrame();
  expect(frame).toContain("Risk skewed");
  expect(frame).toContain("Apple Inc.");
  expect(frame).toContain("4m ago");
  expect(frame).toContain("confidence 72%");
  expect(frame).toContain("Margins slipped");

  // Severity sorted inside a kind, and split into observation versus reading.
  expect(frame.indexOf("Gross margin fell for three quarters"))
    .toBeLessThan(frame.indexOf("Receivables grew faster than sales"));
  expect(frame).toContain("Observed");
  expect(frame).toContain("Reading");
  expect(frame).toContain("Pricing pressure is outpacing mix improvement.");

  // Citations resolve against the server catalog; unknown ids are dropped.
  expect(frame).toContain("10-K 2026-02-01");
  expect(frame).toContain("Reuters");
  expect(frame).not.toContain("ev-missing");

  expect(frame).toContain("WATCH ITEMS");
  expect(frame).toContain("COVERAGE");
  expect(frame).toContain("no data");

  // Footer carries changing state only, and the model stays an implementation detail.
  expect(frame).toContain("partial");
  expect(frame).toContain("stale");
  expect(frame).toContain("efresh");
  expect(frame).not.toContain("luna");
});

test("polls an uncached diagnostic until the background report is ready", async () => {
  signIn("pro");
  let attempts = 0;
  const requests = mockDiagnosticTransport(() => {
    attempts += 1;
    return attempts === 1
      ? jsonResponse({ status: "generating", retryAfterMs: 10 }, 202)
      : jsonResponse(makeReport());
  });

  await renderHarness();
  await Bun.sleep(20);
  await settle();

  expect(requests).toEqual([
    { symbol: "AAPL", exchange: "NASDAQ", mode: "cache-first" },
    { symbol: "AAPL", exchange: "NASDAQ", mode: "cache-first" },
  ]);
  expect(testSetup!.captureCharFrame()).toContain("Gross margin fell for three quarters");
});

test("asks for a refresh on r and keeps the last report when the retry is rate limited", async () => {
  signIn("pro");
  const requests = mockDiagnosticTransport((body) => (
    body.mode === "refresh"
      ? jsonResponse({ message: "Too many requests" }, 429)
      : jsonResponse(makeReport())
  ));

  await renderHarness();
  expect(requests).toEqual([{ symbol: "AAPL", exchange: "NASDAQ", mode: "cache-first" }]);

  await pressKey("r");

  expect(requests.at(-1)?.mode).toBe("refresh");
  const frame = testSetup!.captureCharFrame();
  expect(frame).toContain("Rate limited");
  expect(frame).toContain("Gross margin fell for three quarters");
  expect(frame).toContain("Retry");
});
