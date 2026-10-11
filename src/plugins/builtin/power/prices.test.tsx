import { act, useReducer } from "react";
import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../../api-client";
import type { EuropePowerBoard, PowerPriceRow } from "../../../api-client/europe-energy";
import { PaneFooterBar, PaneFooterKeys, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box } from "../../../ui";
import { PowerPane } from "./pane";
import { powerPriceHistoryCache, powerPricesCache } from "./prices-client";
import { loadPowerPricesReport } from "./prices-headless";

const tui = createOpenTuiTestHarness();
const caches = [powerPricesCache, powerPriceHistoryCache];
afterEach(() => { setCloudApiFetchTransport(null); for (const cache of caches) cache.reset(); });

function priceRow(overrides: Partial<PowerPriceRow>): PowerPriceRow {
  return { code: "DE", name: "Germany", date: "2026-10-07", price: 191.14, previousDate: "2026-10-06", change: -18.64, average7: 184.35,
    average30: 160.52, yearAgoDate: "2025-10-07", yearAgo: 138.61, low52w: -4.13, high52w: 239.88,
    trail: [{ date: "2026-09-30", value: 170 }, { date: "2026-10-07", value: 184.35 }], ...overrides };
}
const board: EuropePowerBoard = {
  generatedAt: "2026-10-11T12:00:00.000Z", status: "available", market: "day-ahead", unit: "EUR/MWh",
  source: { name: "Ember", licence: "CC-BY-4.0", url: "https://ember-energy.org/data/european-wholesale-electricity-price-data/" },
  checkedAt: "2026-10-11T11:00:00.000Z", publishedAt: "2026-10-11T09:09:35.000Z", gaps: [],
  rows: [
    priceRow({ code: "FR", name: "France", price: 187.97, change: -15.64 }),
    priceRow({}),
    priceRow({ code: "GB", name: "Great Britain", date: "2026-10-08", price: 157.31, change: -30.89 }),
    priceRow({ code: "AL", name: "Albania", date: null, price: null, previousDate: null, change: null, average7: null, average30: null,
      yearAgoDate: null, yearAgo: null, low52w: null, high52w: null, trail: [] }),
  ],
};
const history = (code: string) => ({ code, name: code === "DE" ? "Germany" : code, market: "day-ahead", unit: "EUR/MWh", source: board.source,
  points: [{ date: "2026-10-05", value: 162.89 }, { date: "2026-10-06", value: 209.78 }, { date: "2026-10-07", value: 191.14 }] });

function serve() {
  const asked: string[] = [];
  setCloudApiFetchTransport(async (input) => {
    const url = new URL(String(input));
    asked.push(url.pathname);
    const match = /\/power\/([A-Z]{2})\/history$/.exec(url.pathname);
    return Response.json(match ? history(match[1]!) : board);
  });
  return asked;
}

async function mount(opened: Array<[string, string | undefined]>) {
  for (const cache of caches) cache.attach(new MemoryPluginPersistence());
  const id = "power:prices-test";
  const state = createInitialState(createTestPaneConfig("/tmp/power-prices-test", { paneId: "power", instanceId: id, settings: { tab: "prices" } }));
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    return <TestPaneProvider state={current} dispatch={dispatch} paneId={id} pluginId="market-overview"
      runtime={createTestPluginRuntime({ createPaneFromTemplate: (template, options) => opened.push([template, options?.arg ?? undefined]) })}>
      <PaneFooterProvider>{(footer) => <Box width={120} height={30} flexDirection="column">
        <Box height={29}><PowerPane paneId={id} paneType="power" width={120} height={29} focused /></Box>
        <PaneFooterBar footer={footer} width={120} focused /><PaneFooterKeys paneId={id} footer={footer} focused />
      </Box>}</PaneFooterProvider>
    </TestPaneProvider>;
  }
  await act(async () => { await tui.render(<Harness />, { width: 120, height: 30 }); });
}

test("the Prices tab boards each market's day-ahead price as of its own day, charts Germany first and opens its history", async () => {
  const asked = serve();
  const opened: Array<[string, string | undefined]> = [];
  await mount(opened);
  const frame = await tui.waitForFrameToContain("Great Britain");
  expect(frame).toContain("EUR/MWH");
  expect(frame).toContain("191.14");
  expect(frame).toContain("2026-10-08");
  // The queue board is never asked for; the selected market's history is.
  expect(asked).not.toContain("/cloud/power/board");
  expect(asked).toContain("/cloud/europe-energy/power/DE/history");
  expect(await tui.waitForFrameToContain("Germany day-ahead")).toContain("[o]pen Ember");
  await tui.emitKeypress({ name: "g" });
  expect(opened).toEqual([["chart-composer-pane", "CAP:day-ahead:de"]]);
  await tui.emitKeypress({ name: "return" });
  const detail = await tui.waitForFrameToContain("52W range");
  expect(detail).toContain("-4.13 to 239.88");
  expect(detail).toContain("vs 2026-10-06");
});

test("the report names a market by code, name or alias and lists its last delivery days", async () => {
  serve();
  const report = await loadPowerPricesReport("uk");
  expect(report.sections.map((section) => section.title)).toEqual([
    "Great Britain day-ahead power, EUR/MWh", "Great Britain, last 30 delivery days",
  ]);
  expect(report.sections[1]!.rows?.[0]).toEqual({ date: "2026-10-07", price: 191.14 });
  expect(report.freshness).toMatchObject({ source: "Ember", asOf: "2026-10-08", status: "not-a-feed" });
  await expect(loadPowerPricesReport("Atlantis")).rejects.toThrow("Use a market such as DE");
});
