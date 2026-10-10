import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import {
  MarketDataCoordinator,
  setSharedMarketDataCoordinator,
} from "../../../market-data/coordinator";
import { createIdleEntry, type QueryEntry } from "../../../market-data/result-types";
import { createInitialState } from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
import type { PluginRuntimeAccess } from "../../runtime";
import { fxMatrixModule } from "./index";
import { TestPaneProvider } from "../../../test-support/pane";
import { RemoteUiRegistryProvider, createRemoteUiRegistry } from "../../../remote/semantic-tree";
import { renderedReportObservations } from "../../../cli/pane-functions/report-notices";
import { deriveRenderedFreshness, formatFreshnessLine } from "../../../cli/pane-functions/freshness";

const FxMatrixPane = fxMatrixModule.panes![0]!.component as (props: {
  paneId: string;
  paneType: string;
  focused: boolean;
  width: number;
  height: number;
}) => React.ReactNode;

function readyEntry(rate: number): QueryEntry<number> {
  return {
    phase: "ready",
    data: rate,
    lastGoodData: rate,
    source: "test",
    fetchedAt: 1,
    staleAt: null,
    error: null,
    attempts: [],
  };
}

function errorEntry(): QueryEntry<number> {
  return {
    phase: "error",
    data: null,
    lastGoodData: null,
    source: "test",
    fetchedAt: null,
    staleAt: null,
    error: { reasonCode: "upstream", message: "no rate" },
    attempts: [],
  };
}

/** Every currency resolves except JPY, which has no rate at all. */
const RATES: Record<string, number> = { EUR: 1.08, GBP: 1.27, CHF: 1.12, CAD: 0.73, AUD: 0.65, NZD: 0.6 };

function installCoordinator(): void {
  setSharedMarketDataCoordinator({
    subscribe: () => () => {},
    subscribeKeys: () => () => {},
    getVersion: () => 1,
    getFxEntry: (currency: string) => (
      RATES[currency] != null ? readyEntry(RATES[currency]!) : errorEntry()
    ),
    loadFxRate: async () => {},
    // The USD legs also subscribe as pair quotes; none arrive in this test.
    subscribeQuotes: () => () => {},
    getQuoteEntry: () => createIdleEntry(),
  } as unknown as MarketDataCoordinator);
}

function Harness() {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-fxc-pane-test"));
  const runtime = { getMarketData: () => ({}) } as unknown as PluginRuntimeAccess;

  return (
    <TestPaneProvider state={state} paneId="fx-matrix" runtime={runtime} pluginId="market-overview">
      <FxMatrixPane paneId="fx-matrix" paneType="fx-matrix" focused width={100} height={14} />
    </TestPaneProvider>
  );
}

const tui = createOpenTuiTestHarness();

afterEach(() => {
  setSharedMarketDataCoordinator(null);
  setSystemTime();
});

describe("FxMatrixPane", () => {
  test("renders a missing rate as unavailable instead of parity", async () => {
    installCoordinator();
    await tui.render(<Harness />, { width: 100, height: 14 });
    await act(async () => {
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    const frame = tui.frame();
    // EUR/USD is a real cross built from the two USD legs.
    expect(frame).toContain("1.0800");
    // The terminal draws no flags: codes only, in the columns it always had.
    const [header, usdRow] = frame.split("\n");
    expect(header!.trim().split(/\s+/)).toEqual(["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"]);
    expect(header!.indexOf("USD")).toBe(13);
    expect(usdRow!.indexOf("USD")).toBe(1);

    // Regression: a currency with no rate rendered 1.0000 against everything.
    const jpyRow = frame.split("\n").find((line) => line.trimStart().startsWith("JPY"));
    expect(jpyRow).toBeDefined();
    // Its own diagonal is the only 1.0000 in the row.
    expect(jpyRow!.match(/1\.0000/g)).toHaveLength(1);
    expect(jpyRow).toContain("—");
  });

  test("publishes what the rates it draws are, for a report to date them", async () => {
    // Saturday 18:45 UTC: most pairs last traded Friday, the Canadian dollar ticked on Saturday.
    setSystemTime(new Date("2026-10-10T18:45:00Z"));
    const loaded = (rate: number, asOf: string): QueryEntry<number> => ({
      ...readyEntry(rate), source: "gloom", fetchedAt: Date.parse("2026-10-10T18:40:00Z"),
      asOf: Date.parse(asOf), staleAt: Date.parse("2026-10-11T22:00:00Z"),
    });
    const entries: Record<string, QueryEntry<number>> = {
      EUR: loaded(1.12, "2026-10-09T21:29:00Z"), JPY: loaded(0.0063, "2026-10-09T20:59:00Z"),
      CHF: loaded(1.2, "2026-10-10T04:21:11Z"), CAD: loaded(0.7, "2026-10-10T14:50:28Z"),
      AUD: loaded(0.7, "2026-10-09T21:29:00Z"), NZD: loaded(0.56, "2026-10-09T21:29:00Z"),
      // GBP has no rate at all: drawn as a dash, so not an observation.
    };
    setSharedMarketDataCoordinator({
      subscribe: () => () => {}, subscribeKeys: () => () => {}, getVersion: () => 1,
      getFxEntry: (currency: string) => entries[currency] ?? errorEntry(),
      loadFxRate: async () => {}, subscribeQuotes: () => () => {}, getQuoteEntry: () => createIdleEntry(),
    } as unknown as MarketDataCoordinator);
    const registry = createRemoteUiRegistry();
    await tui.render(<RemoteUiRegistryProvider registry={registry}><Harness /></RemoteUiRegistryProvider>, { width: 100, height: 14 });
    await act(async () => {
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    const observed = renderedReportObservations(registry.snapshot());
    expect(observed.map((row) => row.currency)).toEqual(["EUR", "JPY", "CHF", "CAD", "AUD", "NZD"]);
    expect(observed[0]).toEqual({
      currency: "EUR", quoteTime: "2026-10-09T21:29:00.000Z", dataSource: "delayed", stale: false,
      sessionExchange: "CCY", marketState: "CLOSED",
    });
    const freshness = deriveRenderedFreshness(undefined, { footerText: "", cellTimes: [], observed });
    expect(formatFreshnessLine(freshness)).toBe("Source: Gloom Cloud · Fri 9 Oct close · delayed · markets closed");
  });
});
