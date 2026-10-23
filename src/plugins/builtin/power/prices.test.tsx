import { ApiRequestError } from "../../../api-client/errors";
import type { DesktopPaneShotPayload } from "../../../cli/desktop-pane-shot";
import type { ResolvedPaneFunction } from "../../../cli/pane-functions/resolver";
import { createRemoteUiRegistry, RemoteUiRegistryProvider } from "../../../remote/semantic-tree";
import { powerScreenshotEvidence, type PowerPricesSnapshot } from "./evidence";
import { act, useReducer } from "react";
import { afterEach, expect, spyOn, test } from "bun:test";
import { apiClient, setCloudApiFetchTransport } from "../../../api-client";
import type { CarbonBoard, EuropePowerBoard, GasStorageBoard, GasStorageRow, GasStorageSeasonal, PowerPriceRow } from "../../../api-client/europe-energy";
import { PaneFooterBar, PaneFooterKeys, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame, TestPaneProvider } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box } from "../../../ui";
import { PowerPane } from "./pane";
import { carbonPriceCache, powerPriceHistoryCache, powerPricesCache } from "./prices-client";
import { gasHistoryCache, gasSeasonalCache, gasStorageCache } from "./gas-client";
import { GAS_STORAGE_SERIES, parseGasQuery } from "./gas-model";
import { deriveHeadlessFreshness, formatStatusLine } from "../../../cli/pane-functions/freshness";
import { loadPowerPricesReport, powerPricesHeadless } from "./prices-headless";

const tui = createOpenTuiTestHarness();
const caches = [powerPricesCache, powerPriceHistoryCache, carbonPriceCache, gasStorageCache, gasHistoryCache, gasSeasonalCache];
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
const auction = (date: string, name: string, zone: string, price: number | null, extra = {}) => ({
  date, auction: name, contract: "T3PA", status: price == null ? "cancelled" : "successful", zone, price, minBid: null, maxBid: null,
  meanBid: null, medianBid: null, volume: 1_548_000, coverRatio: 1.93, bidders: 22, successfulBidders: 16, aviation: false, ...extra,
});
const carbon: CarbonBoard = {
  generatedAt: "2026-10-11T12:00:00.000Z", status: "available", market: "primary auction", unit: "EUR/tCO2",
  source: { name: "EEX", url: "https://www.eex.com/en/markets/environmental-markets/emissions-auctions" },
  checkedAt: "2026-10-11T11:00:00.000Z", publishedAt: "2026-10-09T09:02:01.000Z", gaps: [],
  row: { ...priceRow({ name: "EU carbon allowance (EUA)", date: "2026-10-09", price: 86.11, previousDate: "2026-10-08", change: 1.04,
    average30: 85.06, yearAgoDate: "2025-10-09", yearAgo: 77.95 }), code: "EUA", volume: 1_548_000, auctions: 1 },
  auctions: [auction("2026-10-09", "Auction 4. Period DE", "DE", 86.11), auction("2026-10-08", "EUAA Auction CAP3 EU", "EU", 70, { aviation: true, contract: "EAA3" }),
    auction("2026-10-07", "Auction 4. Period CAP3 EU", "EU", null, { coverRatio: 0.98 })],
};
const history = (code: string) => ({ code, name: code === "DE" ? "Germany" : code, market: "day-ahead", unit: "EUR/MWh", source: board.source,
  points: [{ date: "2026-10-05", value: 162.89 }, { date: "2026-10-06", value: 209.78 }, { date: "2026-10-07", value: 191.14 }] });

function gasRow(overrides: Partial<GasStorageRow>): GasStorageRow {
  return { code: "EU", name: "EU", gasDay: "2026-10-12", status: "estimated", full: 73.87, gasInStorage: 834.8755, workingGasVolume: 1130.1222,
    injection: 2029.08, withdrawal: 586.8, previousGasDay: "2026-10-11", change: 0.12,
    yearAgo: { gasDay: "2025-10-12", full: 83.15, gasInStorage: 948.8615, change: -9.28 },
    fiveYear: { years: [2021, 2022, 2023, 2024, 2025], min: 77.03, max: 97.33, average: 88.83, vsAverage: -14.96, position: -15.6 },
    trail: [{ date: "2026-10-05", value: 73.1 }, { date: "2026-10-12", value: 73.87 }], ...overrides };
}
const gas: GasStorageBoard = {
  generatedAt: "2026-10-12T22:00:00.000Z", status: "available", units: { full: "%", storage: "TWh", flow: "GWh/day" },
  source: { name: "GIE AGSI+", url: "https://agsi.gie.eu/" }, checkedAt: "2026-10-12T21:00:00.000Z", gaps: [],
  rows: [gasRow({}), gasRow({ code: "DE", name: "Germany", status: "confirmed", full: 60.11, gasInStorage: 147.3108, injection: 445.84, withdrawal: 83.3,
    fiveYear: { years: [2022, 2023, 2024, 2025], min: 71.5, max: 97.7, average: 87.48, vsAverage: -27.37, position: -43.5 } }),
  gasRow({ code: "SE", name: "Sweden", gasDay: null, status: null, full: null, gasInStorage: null, workingGasVolume: null, injection: null,
    withdrawal: null, previousGasDay: null, change: null, yearAgo: null, fiveYear: null, trail: [] })],
};
const seasonal = (code: string): GasStorageSeasonal => ({ code, name: code === "EU" ? "EU" : "Germany", unit: "%", source: gas.source, year: 2026,
  years: [2021, 2022, 2023, 2024, 2025], current: [["2026-10-11", 73.75], ["2026-10-12", 73.87]], previous: [["2026-10-12", 83.15], ["2026-10-13", 83.2]],
  band: [["2026-10-11", 77, 88.7, 97.3, 5], ["2026-10-12", 77.03, 88.83, 97.33, 5], ["2026-10-13", null, null, null, 0]] });
const gasHistory = (code: string) => ({ code, name: "Germany", units: gas.units, source: gas.source, points: [
  { date: "2026-10-10", status: "confirmed", full: 59.8, gasInStorage: 146.5664, workingGasVolume: 245.0863, injection: 680, withdrawal: 4.5 },
  { date: "2026-10-11", status: "confirmed", full: 59.96, gasInStorage: 146.9482, workingGasVolume: 245.0863, injection: null, withdrawal: 83.3 },
  { date: "2026-10-12", status: "estimated", full: 60.11, gasInStorage: 147.3108, workingGasVolume: 245.0863, injection: 445.84, withdrawal: 83.3 },
] });

function serve() {
  const asked: string[] = [];
  setCloudApiFetchTransport(async (input) => {
    const url = new URL(String(input));
    asked.push(url.pathname);
    const area = /\/gas\/([A-Z]{2})\/(history|seasonal)$/.exec(url.pathname);
    if (url.pathname.endsWith("/gas")) return Response.json(gas);
    if (area) return Response.json(area[2] === "seasonal" ? seasonal(area[1]!) : gasHistory(area[1]!));
    const match = /\/power\/([A-Z]{2})\/history$/.exec(url.pathname);
    if (url.pathname.endsWith("/carbon")) return Response.json(carbon);
    if (url.pathname.endsWith("/carbon/history")) return Response.json({ code: "EUA", name: "EU carbon allowance (EUA)", market: "primary auction",
      unit: "EUR/tCO2", source: carbon.source, points: [{ date: "2026-10-08", value: 85.07 }, { date: "2026-10-09", value: 86.11 }] });
    return Response.json(match ? history(match[1]!) : board);
  });
  return asked;
}

async function mount(opened: Array<[string, string | undefined]>, params?: Record<string, string>) {
  for (const cache of caches) cache.attach(new MemoryPluginPersistence());
  const id = "power:prices-test";
  const state = createInitialState(createTestPaneConfig("/tmp/power-prices-test", { paneId: "power", instanceId: id, settings: { tab: "prices" },
    ...(params ? { params } : {}) }));
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
  // The EU carbon allowance sits in the figures above, in its own unit and dated by its auction.
  const figures = await tui.waitForFrameToContain("EUA EUR/tCO2");
  expect(figures).toContain("86.11");
  expect(figures).toContain("2026-10-09");
  await tui.emitKeypress({ name: "g" });
  // c charts the allowance above the board, from its own history; g then charts it in a custom chart.
  await tui.emitKeypress({ name: "c" });
  expect(await tui.waitForFrameToContain("EU carbon (EUA) auction")).toContain("EUR/tCO2");
  expect(asked).toContain("/cloud/europe-energy/carbon/history");
  await tui.emitKeypress({ name: "g" });
  expect(opened).toEqual([["chart-composer-pane", "CAP:day-ahead:de"], ["chart-composer-pane", "CAP:carbon:eua"]]);
  // Back on a market, Enter opens its history.
  await tui.emitKeypress({ name: "down" });
  await tui.waitForFrameToContain("day-ahead");
  await tui.emitKeypress({ name: "return" });
  const detail = await tui.waitForFrameToContain("52W range");
  expect(detail).toContain("-4.13 to 239.88");
});

test("the report names a market by code, name or alias and lists its last delivery days", async () => {
  serve();
  const report = await loadPowerPricesReport("uk");
  expect(report.sections.map((section) => section.title)).toEqual([
    "Great Britain day-ahead power, EUR/MWh", "Great Britain, last 30 delivery days",
  ]);
  expect(report.sections[1]!.rows?.[0]).toEqual({ date: "2026-10-07", price: 191.14 });
  expect(report.freshness).toMatchObject({ source: "Ember", asOf: "2026-10-08", observation: "delivery day", status: "not-a-feed" });
  await expect(loadPowerPricesReport("Atlantis")).rejects.toThrow("Use a market such as DE");
});

test("the report adds the EUA and its general-allowance auctions, dates the board by the day most markets have reached, and EUA reports alone", async () => {
  serve();
  const report = await loadPowerPricesReport(undefined);
  expect(report.sections.map((section) => section.title)).toEqual([
    "Day-ahead power, EUR/MWh", "EU carbon allowance (EUA) auction price, EUR/tCO2", "Latest EUA auctions",
  ]);
  // The aviation auction is not the EUA; the cancelled one is listed with no price.
  expect(report.sections[2]!.rows?.map((row) => [row.date, row.status, row.price])).toEqual([
    ["2026-10-09", "successful", 86.11], ["2026-10-07", "cancelled", null],
  ]);
  // Dated by the day most markets have reached, not the freshest market (Great Britain) or the EUA.
  const line = (result: typeof report) => formatStatusLine(deriveHeadlessFreshness(powerPricesHeadless, result, Date.parse("2026-10-11T12:00:00Z")));
  expect(line(report)).toBe("Source: Ember, EEX · most markets 2026-10-07 · lag 4 days");
  const alone = await loadPowerPricesReport("carbon");
  expect(alone.sections[0]!.rows?.[0]).toMatchObject({ market: "EU carbon allowance (EUA)", date: "2026-10-09", price: 86.11, change: 1.04 });
  expect(line(alone)).toBe("Source: EEX · last auction 2026-10-09 · lag 2 days");
});

test("the gas board boards each area's storage by its gas day, charts the EU's year against its five-year range and opens an area's history", async () => {
  const asked = serve();
  const opened: Array<[string, string | undefined]> = [];
  await mount(opened);
  // The power board opens; the query bar switches to gas storage, credited to its publisher.
  await tui.waitForFrameToContain("Great Britain");
  await tui.clickFrameText("Gas storage");
  const frame = await tui.waitForFrameToContain("2026-10-12 est");
  expect(frame).toContain("GIE AGSI+");
  expect(frame).toContain("73.87");
  expect(frame).toContain("below");
  // An area without a reading is listed without figures, never as zero.
  expect(frame).toMatch(/Sweden\s+--/);
  expect(asked).toContain("/cloud/europe-energy/gas/EU/seasonal");
  // The legend reads the latest gas day across this year, last year and the range's average.
  const chart = await tui.waitForFrameToContain("5Y avg 88.8%");
  expect(chart).toContain("EU 2026 73.9%");
  expect(chart).toContain("2025 83.2%");
  expect(chart).toContain("[o]pen GIE AGSI+");
  await tui.emitKeypress({ name: "g" });
  await tui.emitKeypress({ name: "down" });
  await tui.waitForFrameToContain("Germany 2026");
  await tui.emitKeypress({ name: "return" });
  const detail = await tui.waitForFrameToContain("4Y range %");
  expect(detail).toContain("71.50 to 97.70");
  expect(detail).toContain("4 of 5 years");
  expect(asked).toContain("/cloud/europe-energy/gas/DE/history");
  expect(opened).toEqual([["chart-composer-pane", "CAP:gas-storage:eu"]]);
});

test("EPWR GAS opens on the area it names; the report lists every area, or one area's last gas days, credited and dated by gas day", async () => {
  expect(parseGasQuery("gas storage germany")).toMatchObject({ area: { code: "DE" }, named: true });
  expect(parseGasQuery("GAS")).toMatchObject({ area: { code: "EU" }, named: false });
  // A bare market stays a power market; a gas query naming no listed area says so.
  expect(parseGasQuery("DE")).toBeNull();
  expect(() => parseGasQuery("gas atlantis")).toThrow("No gas storage for");

  const asked = serve();
  await mount([], { board: "gas", area: "DE" });
  expect(await tui.waitForFrameToContain("Germany 2026")).toContain("60.11");
  expect(asked).toContain("/cloud/europe-energy/gas/DE/seasonal");

  const line = (result: Awaited<ReturnType<typeof loadPowerPricesReport>>) =>
    formatStatusLine(deriveHeadlessFreshness(powerPricesHeadless, result, Date.parse("2026-10-12T22:00:00Z")));
  const all = await loadPowerPricesReport("gas");
  expect(all.sections[0]!.rows?.map((row) => [row.area, row.full, row.status, row.range])).toEqual([
    ["EU", 73.87, "estimated", "below"], ["Germany", 60.11, "confirmed", "below"], ["Sweden", null, null, "--"],
  ]);
  expect(line(all)).toBe("Source: GIE AGSI+ · EU gas day 2026-10-12 · lag 0 days");
  const germany = await loadPowerPricesReport("GAS DE");
  expect(germany.sections.map((section) => section.title)).toEqual(["Germany gas storage", "Germany, last 30 gas days"]);
  expect(germany.sections[1]!.rows?.[0]).toMatchObject({ date: "2026-10-12", status: "estimated", full: 60.11 });
  expect(line(germany)).toBe("Source: GIE AGSI+ · gas day 2026-10-12 · lag 0 days");
  await expect(loadPowerPricesReport("gas se")).rejects.toThrow("No gas storage figures for Sweden yet.");

  // Net injection is injection less withdrawal; a day missing either is left out, not drawn as zero.
  const net = GAS_STORAGE_SERIES.find((series) => series.id === "gas-injection:de")!;
  expect(net.unit).toBe("GWh/day");
  const loaded = await (net as Extract<typeof net, { load: unknown }>).load({});
  expect(loaded).toMatchObject({ points: [{ date: "2026-10-10", value: 675.5 }, { date: "2026-10-12", value: 362.54 }],
    attribution: { source: "GIE AGSI+" } });
});


test("a prepared partial power capture retains its carbon warning in the pane and verified evidence", async () => {
  serve();
  const failure = spyOn(apiClient, "getCloudEuropeCarbon").mockRejectedValue(new ApiRequestError("Fixture unavailable", 503));
  try {
    const resolved = { options: { tab: "prices" }, createOptions: {} } as ResolvedPaneFunction;
    const prepared = await powerScreenshotEvidence.prepare!({ resolved, settings: {} } as Parameters<NonNullable<typeof powerScreenshotEvidence.prepare>>[0]);
    const snapshot = prepared.settings.powerPricesSnapshot as PowerPricesSnapshot;
    const message = "The EU carbon auction price is not available yet.";
    expect(snapshot).toMatchObject({ board, carbon: null, carbonError: message });
    expect(snapshot.history).toEqual(history("DE"));
    const id = "power:captured";
    const settings = { tab: "prices", ...prepared.settings };
    const config = createTestPaneConfig("/unused/carbon-capture-test", { paneId: "power", instanceId: id, settings });
    const registry = createRemoteUiRegistry();
    // A frozen capture must not fetch carbon a second time during rendering.
    failure.mockClear();
    await tui.render(<RemoteUiRegistryProvider registry={registry}>
      <TestPaneFrame state={createInitialState(config)} paneId={id} pluginId="power" runtime={createTestPluginRuntime()}
        width={120} height={30} footerKeys>
        {(size) => <PowerPane paneId={id} paneType="power" {...size} focused />}
      </TestPaneFrame>
    </RemoteUiRegistryProvider>, { width: 120, height: 30 });
    await tui.waitForFrameToContain("Germany");
    const raw = registry.snapshot().find((node) => node.role === "chart-data" && node.metadata?.kind === "power")!.metadata;
    const evidence = powerScreenshotEvidence.read(raw)!;
    expect(evidence).toMatchObject({ complete: true, carbon: null, carbonError: message });
    const request = { resolved, payload: { paneId: id, config } as DesktopPaneShotPayload };
    expect(powerScreenshotEvidence.mismatches(evidence, request)).toEqual([]);
    expect(powerScreenshotEvidence.unavailable(evidence, request)).toEqual([]);
    expect(powerScreenshotEvidence.mismatches({ ...evidence, carbonError: undefined }, request)).toHaveLength(1);
    expect(powerScreenshotEvidence.read({ ...raw, carbonError: 5 })).toBeNull();
    expect(failure).not.toHaveBeenCalled();
    await tui.emitKeypress({ name: "!", sequence: "!" });
    await tui.waitForFrameToContain(message);
  } finally {
    failure.mockRestore();
  }
});
