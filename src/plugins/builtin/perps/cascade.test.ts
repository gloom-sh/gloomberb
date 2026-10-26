import { expect, test } from "bun:test";
import { renderHeadlessPaneText, serializeHeadlessPaneResult } from "../../../cli/pane-functions/headless";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { depthCellText, depthColumns, depthFigures, liquidationCellText, liquidationColumns, liquidationFigures, liquidationFreshness, printCellText, printColumns } from "./cascade";
import { fetchPerpsLiquidations, validatePerpsDepth, validatePerpsLiquidations } from "./client";
import { perpsHeadless } from "./headless";
import { cascadeAsOf as asOf, depthPayload as depth, depthRow, liquidationPrint as print, liquidationsPayload as liquidations } from "./test-fixture";

const colors = { positive: "green", negative: "red", text: "text", textBright: "bright", textMuted: "muted", textDim: "dim" };
test("a band wider than the book the venue returned reads as at least what the book holds", () => {
  const binance = depthRow();
  // Binance's 1,000 levels end 0.47% from mid: the 0.5%, 1% and 2% bands are all floors.
  expect(["bid05", "ask1", "bid2"].map((id) => depthCellText(binance, id as never))).toEqual(["≥57.58M", "≥66.75M", "≥57.58M"]);
  const okx = depth().rows[1]!;
  expect(["bid05", "bid1", "bid2", "reach"].map((id) => depthCellText(okx, id as never))).toEqual(["33.92M", "45.61M", "98.65M", "2.23%"]);
  // The figures sum the books shown, and say "at least" when any book ends inside the band.
  const figures = depthFigures(depth().rows);
  expect(figures.map((figure) => [figure.label, figure.value])).toEqual([["±0.5% of mid", "≥193.66M"], ["±1% of mid", "≥217.87M"], ["±2% of mid", "≥293.61M"]]);
  expect(figures[1]!.detail).toBe("bids 103.19M · asks 114.69M");
});

test("narrow panes give up a band's bid and ask together and always keep the venue and the contract", () => {
  for (const width of [78, 98, 118]) {
    const ids = depthColumns(width).map((column) => column.id);
    expect(ids.slice(0, 2)).toEqual(["venue", "symbol"]);
    for (const band of ["05", "1", "2"]) expect(ids.includes(`bid${band}`)).toBe(ids.includes(`ask${band}`));
    const liq = liquidationColumns(width).map((column) => column.id);
    expect(liq.slice(0, 4)).toEqual(["venue", "symbol", "long24h", "short24h"]);
    expect(liq.includes("long7d")).toBe(liq.includes("short7d"));
    expect(printColumns(width, "ETH").map((column) => column.id).slice(0, 5)).toEqual(["eventAt", "venue", "symbol", "side", "notionalUsd"]);
  }
});

test("liquidations read by side, and windows that start before collection say when it started", () => {
  const data = liquidations();
  expect(liquidationCellText(data.markets[0]!, "long24h")).toBe("3.1k");
  expect(liquidationCellText(data.markets[2]!, "lastEventAt")).toBe("--");
  expect(["eventAt", "side", "priceKind", "notionalUsd", "receivedAt"].map((id) => printCellText(data.largest[0]!, id as never)))
    .toEqual(["10-26 07:00:49", "Short", "Fill", "32.0k", "07:00:50"]);
  const figures = liquidationFigures(data, colors);
  expect(figures.map((figure) => [figure.label, figure.value, figure.color, figure.detail])).toEqual([
    ["Longs 24h", "3.2k", "red", "since 10-26 06:52 UTC"], ["Shorts 24h", "29.2k", "green", "since 10-26 06:52 UTC"],
    ["Longs 7d", "3.2k", "red", "since 10-26 06:52 UTC"], ["Shorts 7d", "29.2k", "green", "since 10-26 06:52 UTC"]]);
  // A week of collection behind it: the windows are whole and need no date.
  expect(liquidationFigures(liquidations({ collectingSince: "2026-10-01T00:00:00.000Z" }), colors).every((figure) => !figure.detail)).toBeTrue();
  // A stream that is down is said with the figures' date; it is not a feed.
  expect(liquidationFreshness(data)).toEqual({ source: "Binance, OKX, Hyperliquid", asOf, maxAgeMinutes: 10, note: "OKX stream down since 10-26 07:01 UTC" });
});

test("payloads are validated, and a pair reads as the base asset it stands for", async () => {
  expect(validatePerpsLiquidations(liquidations())).toBeTruthy();
  expect(() => validatePerpsLiquidations({ ...liquidations(), largest: [print({ side: "buy" as never })] })).toThrow("unreadable perpetual liquidations");
  expect(() => validatePerpsLiquidations({ ...liquidations(), totals: { ...liquidations().totals, long24h: -1 } })).toThrow();
  expect(validatePerpsDepth(depth())).toBeTruthy();
  expect(() => validatePerpsDepth({ ...depth(), rows: [depthRow({ mid: 0 })] })).toThrow("unreadable order book depth");
  const asked: string[] = [];
  const client = { getCloudPerpsLiquidations: async (base: string) => { asked.push(base); return base === "ETH" ? liquidations() : liquidations({ baseAsset: base, markets: [], largest: [] }); } };
  expect((await fetchPerpsLiquidations("ETH-USD", client as never)).baseAsset).toBe("ETH");
  expect(asked).toEqual(["ETH-USD", "ETH"]);
});

test("fn PERP --tab liquidations and depth: totals, contracts and prints free, the hourly series and depth history Pro, with every stream limit", async () => {
  const apiClient = { getCloudPerpsLiquidations: async () => liquidations(), getCloudPerpsDepth: async () => depth() } as never;
  const run = async (tab: string) => {
    const args = createTestHeadlessArgs({ argument: "ETH-USD", rawArgument: "ETH-USD", options: { tab } });
    const result = await perpsHeadless.load(args, createTestHeadlessContext({ apiClient }));
    return { result, text: renderHeadlessPaneText(perpsHeadless, result, args, "PERP") };
  };
  const liq = await run("liquidations");
  expect(liq.text.split("\n")[0]).toBe("Perpetual liquidations across venues");
  expect(liq.text).toContain('Showing ETH for "ETH-USD".');
  expect(liq.text).toMatch(/Longs liquidated 24h\s+3\.2k USD/);
  expect(liq.text).toMatch(/Binance\s+ETHUSDT\s+3\.1k\s+29\.2k\s+3\.1k\s+29\.2k\s+10\s+10-26 07:10/);
  expect(liq.text).toMatch(/10-26 07:00:49\s+Binance\s+ETHUSDC\s+Short\s+32\.0k\s+2,321\.94\s+Fill/);
  expect(liq.text).toContain("Binance sends at most one liquidation per contract each second");
  expect(liq.text).toContain("Pro: Free shows liquidation totals and the three largest prints. Gloom Pro adds the hourly series and the twenty largest prints");
  expect(liq.text).not.toMatch(/Hourly|undefined|NaN/);
  const json = serializeHeadlessPaneResult(perpsHeadless, liq.result) as { sections: Array<{ title: string; locked?: boolean }>; metadata: Record<string, unknown> };
  expect(json.sections.map((section) => [section.title, !!section.locked])).toEqual([["Totals", false], ["By contract", false], ["Hourly", true], ["Largest prints", false]]);
  expect(json.metadata).toMatchObject({ baseAsset: "ETH", access: "preview", collectingSince: "2026-10-26T06:52:41.387Z" });
  const books = await run("depth");
  expect(books.text.split("\n")[0]).toBe("Perpetual order book depth across venues");
  expect(books.text).toMatch(/Binance\s+ETHUSDT\s+2,318\.38\s+≥57\.58M\s+≥66\.75M/);
  expect(books.text).toContain("Pro: Free shows each book's latest depth. Gloom Pro adds the week's hourly depth");
  expect(books.text).toMatch(/Binance 06:52 · OKX 06:54 UTC/);
});
