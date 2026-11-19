import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createDefaultConfig } from "../../../types/config";
import { createTestTicker } from "../../../test-support/ticker";
import { createTestFinancials, createTestQuote } from "../../../test-support/data-provider";
import { TestPaneFrame } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { TickerSnapshotState } from "../../../market-data/hooks";
import { OverviewTab } from "./overview-tab";

const config = createDefaultConfig("/tmp/gloom-overview-status-test-unused");
const ticker = createTestTicker("AMGN", "Amgen Inc.", { exchange: "NASDAQ", currency: "USD" });
const tui = createOpenTuiTestHarness();

async function show(snapshot: TickerSnapshotState) {
  await act(async () => {
    await tui.render(
      <AppContext value={createStaticAppStore(createInitialState(config))}>
        <OverviewTab ticker={ticker} financials={null} width={100} snapshot={snapshot} />
      </AppContext>,
      { width: 100, height: 12 },
    );
  });
  await settleFrame(tui.setup(), 5);
  return tui.frame();
}

// The tab stood empty for a round trip on every new ticker, and for good when the network was down.
test("an overview with nothing in yet says it is loading, then why it could not, with a retry", async () => {
  let retried = 0;
  const retry = async () => { retried += 1; };

  expect(await show({ loading: true, error: null, retry })).toContain("Loading overview...");

  const failed = await show({ loading: false, error: "Gloom couldn't reach its data service", retry });
  expect(failed).toContain("Overview unavailable.");
  expect(failed).toContain("Gloom couldn't reach its data service");
  const row = failed.split("\n").findIndex((line) => line.includes("Retry"));
  expect(row).toBeGreaterThanOrEqual(0);
  await act(async () => {
    await tui.setup().mockMouse.click(failed.split("\n")[row]!.indexOf("Retry") + 1, row);
    await settleFrame(tui.setup(), 2);
  });
  expect(retried).toBe(1);
  await tui.destroy();
});

test("a quarter-only runway leaves no history warning on an overview without a runway stat", async () => {
  const financials = createTestFinancials({
    quote: createTestQuote({ symbol: ticker.metadata.ticker }),
    annualStatements: [],
    quarterlyStatements: [{ date: "2026-06-30", cashAndCashEquivalents: 120, operatingCashFlow: -30 }],
  });
  const overview = createOpenTuiTestHarness();
  let notes: readonly string[] = [];
  try {
    await act(async () => {
      await overview.render(
        <TestPaneFrame state={createInitialState(config)} paneId="overview" pluginId="ticker-research"
          runtime={createTestPluginRuntime()} width={100} height={30}>
          {(body, footer) => {
            notes = footer.info.flatMap((info) => info.notes ?? []);
            return <OverviewTab {...body} focused ticker={ticker} financials={financials} />;
          }}
        </TestPaneFrame>,
        { width: 100, height: 30 },
      );
    });
    await settleFrame(overview.setup(), 5);
    expect(overview.frame()).not.toContain("Runway");
    expect(notes.join(" ")).not.toMatch(/runway|quarters/i);
  } finally {
    await overview.destroy();
  }
});
