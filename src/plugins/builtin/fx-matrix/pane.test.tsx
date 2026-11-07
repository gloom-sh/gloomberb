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
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
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

function Harness({ width = 100, settings }: { width?: number; settings?: Record<string, unknown> }) {
  const state = createInitialState(settings
    ? createTestPaneConfig("/tmp/gloomberb-fxc-pane-test", { paneId: "fx-matrix", instanceId: "fx-matrix", settings })
    : createDefaultConfig("/tmp/gloomberb-fxc-pane-test"));
  const runtime = { getMarketData: () => ({}) } as unknown as PluginRuntimeAccess;

  return (
    <TestPaneProvider state={state} paneId="fx-matrix" runtime={runtime} pluginId="market-overview">
      <FxMatrixPane paneId="fx-matrix" paneType="fx-matrix" focused width={width} height={14} />
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
    expect(frame).toContain("1.08000");
    // The terminal draws no flags: codes only, in the columns it always had.
    // Under the amount field.
    const [, header, usdRow] = frame.split("\n");
    expect(header!.trim().split(/\s+/)).toEqual(["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"]);
    expect(header!.indexOf("USD")).toBe(13);
    expect(usdRow!.indexOf("USD")).toBe(1);

    // Regression: a currency with no rate rendered 1.0000 against everything.
    const jpyRow = frame.split("\n").find((line) => line.trimStart().startsWith("JPY"));
    expect(jpyRow).toBeDefined();
    // Its own diagonal, at the yen's three decimals, is the only 1.000 in the row.
    expect(jpyRow!.match(/1\.000\b/g)).toHaveLength(1);
    expect(jpyRow).toContain("—");
  });

  // At 52 columns the board showed USD, EUR and GBP, "5 columns hidden", and no key reached JPY.
  test("a pane too narrow for every currency scrolls to the rest as other wide tables do, and an amount reads in each", async () => {
    installCoordinator();
    await tui.render(<Harness width={52} settings={{ amount: "2,500,000 EUR" }} />, { width: 52, height: 14 });
    const settle = async () => {
      for (let i = 0; i < 3; i++) await act(async () => { await tui.setup().renderOnce(); });
    };
    await settle();
    const lines = () => tui.frame().split("\n");
    // The field holds the amount, and its column the amount in each currency at the board's rates: 1.08 / 1.27 for GBP.
    expect(lines()[0]).toContain("2,500,000 EUR");
    const header = lines()[1]!;
    expect(header.trim().split(/\s+/).slice(0, 2)).toEqual(["AMOUNT", "USD"]);
    // The table's own sign that columns go on past the edge.
    expect(header.trimEnd().endsWith("→")).toBe(true);
    expect(header).not.toContain("JPY");
    const row = (code: string) => lines().find((line) => line.trimStart().startsWith(`${code} `))!;
    expect(row("GBP")).toContain((2_500_000 * 1.08 / 1.27).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    // JPY has no rate here: its amount is unavailable, never parity.
    expect(row("JPY")).toContain("—");
    // Every currency keeps its row, and Shift+Right brings the columns past the edge into view, the codes kept.
    expect(lines().filter((line) => /^\s*(USD|EUR|GBP|JPY|CHF|CAD|AUD|NZD)\s/.test(line))).toHaveLength(8);
    for (let step = 0; step < 4 && !lines()[1]!.includes("JPY"); step++) {
      await act(async () => { await tui.emitKeypress({ name: "right", shift: true }); });
      await settle();
    }
    expect(lines()[1]).toContain("JPY");
    expect(row("EUR").trimStart().startsWith("EUR")).toBe(true);
  });

  test("publishes what the rates it draws are, for a report to date them", async () => {
    // Saturday 18:45 UTC: each pair's last print by Friday's 17:00 New York close.
    setSystemTime(new Date("2026-10-10T18:45:00Z"));
    const loaded = (rate: number, asOf: string): QueryEntry<number> => ({
      ...readyEntry(rate), source: "gloom", fetchedAt: Date.parse("2026-10-10T18:40:00Z"),
      asOf: Date.parse(asOf), staleAt: Date.parse("2026-10-11T22:00:00Z"),
    });
    const entries: Record<string, QueryEntry<number>> = {
      EUR: loaded(1.12, "2026-10-09T20:59:00Z"), JPY: loaded(0.0063, "2026-10-09T20:59:00Z"),
      CHF: loaded(1.2, "2026-10-09T20:58:11Z"), CAD: loaded(0.7, "2026-10-09T20:50:28Z"),
      AUD: loaded(0.7, "2026-10-09T20:59:00Z"), NZD: loaded(0.56, "2026-10-09T20:59:00Z"),
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
      currency: "EUR", quoteTime: "2026-10-09T20:59:00.000Z", dataSource: "delayed", stale: false,
      sessionExchange: "CCY", marketState: "CLOSED",
    });
    const freshness = deriveRenderedFreshness(undefined, { footerText: "", cellTimes: [], observed });
    expect(formatFreshnessLine(freshness)).toBe("Source: Gloom Cloud · FX trading day Fri 9 Oct 2026 close · delayed · markets closed · reopens Sun 21:00 UTC, 17:00 ET");
  });
});
