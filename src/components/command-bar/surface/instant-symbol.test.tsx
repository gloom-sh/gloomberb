import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { installListingDirectory } from "../../../tickers/search/listing-index";
import type { InstrumentSearchResult } from "../../../types/instrument";
import type { AppConfig } from "../../../types/config";
import type { TickerRecord } from "../../../types/ticker";
import searchAnswers from "../../../tickers/search/fixtures/search-answers-2026-11-13.json";
import { CommandBarHarness } from "./test-harness";

const tui = createOpenTuiTestHarness();
const tencent: InstrumentSearchResult = {
  providerId: "test", symbol: "0700", name: "Tencent Holdings Limited", exchange: "HKEX", currency: "HKD", type: "Common Stock", homeListing: true,
};
const renegade: InstrumentSearchResult = {
  providerId: "test", symbol: "0700", name: "Renegade Gold Inc.", exchange: "XDUS", currency: "EUR", type: "Common Stock",
};
const sive: InstrumentSearchResult = {
  providerId: "test", symbol: "SIVE", name: "Sivers Semiconductors AB", exchange: "SFB", currency: "SEK", type: "Common Stock",
};

/** The shipped listings as `bun run listings:snapshot` writes them: Tencent's home line. */
function shipTencent(): void {
  installListingDirectory([["0700", "Tencent Holdings Limited", "HKEX", "Common Stock", "HKD", null, 1, null]]);
}

/** Renders the bar empty and types `text`; search answers only once released. */
async function typeWithSearchHeld(text: string, answer: InstrumentSearchResult[], configureConfig?: (config: AppConfig) => AppConfig) {
  const opened: string[] = [];
  const saved: TickerRecord[] = [];
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  let searches = 0;
  await tui.render(<CommandBarHarness
    query=""
    live
    configureConfig={configureConfig}
    onAction={(action) => { if (action.type === "UPDATE_TICKER") saved.push(action.ticker); }}
    configurePluginRegistry={(registry) => { registry.pinTicker = (key) => { opened.push(key); }; }}
    dataProvider={createTestDataProvider({
      search: async (query) => {
        if (query.toUpperCase() !== text.toUpperCase()) return [];
        searches += 1;
        await held;
        return answer;
      },
      getQuote: async (symbol) => createTestQuote({ symbol }),
    })}
  />, { width: 110, height: 28 });
  await act(async () => { await tui.setup().mockInput.typeText(text); });
  // The first frame drawn for the typed text.
  await tui.setup().renderOnce();
  return { opened, saved, release, searches: () => searches };
}

/** The rows from the first section heading down. */
function listOf(frame: string): string {
  return frame.slice(frame.indexOf("Exact Match"));
}

// What the user holds and the major listings are named on the keystroke, before
// search answers (cold: nothing searched yet), and Enter opens the named line
// while search is still out.
for (const [text, name, setup] of [
  ["0700", "Tencent Holdings Limited", shipTencent],
  // Saved in a watchlist (the harness's AAPL).
  ["AAPL", "Apple Inc.", () => {}],
] as const) {
  test(`${text} shows its exact match on the first frame and Enter opens it during the search`, async () => {
    setup();
    const { opened, release, searches } = await typeWithSearchHeld(text, []);
    try {
      const frame = tui.frame();
      expect(frame).toContain("Exact Match");
      expect(listOf(frame)).toContain(name);
      expect(frame).toContain("Searching");
      await tui.emitKeypress({ name: "return", sequence: "\r" });
      await tui.waitForFrameToContain("bar:closed");
      expect(opened).toEqual([text]);
      expect(searches()).toBeLessThanOrEqual(1);
    } finally {
      release();
    }
  });
}

test("a symbol search answered once is named on the keystroke the next time the bar opens (warm)", async () => {
  const first = await typeWithSearchHeld("SIVE", [sive]);
  expect(tui.frame()).not.toContain("Exact Match");
  first.release();
  await tui.waitForFrameToContain("Sivers Semiconductors");
  expect(tui.frame()).toContain("Exact Match");

  // A new bar, so nothing of the last visit's own answers is left in it.
  const second = await typeWithSearchHeld("SIVE", [sive]);
  try {
    expect(tui.frame()).toContain("Exact Match");
    expect(listOf(tui.frame())).toContain("Sivers Semiconductors");
    await tui.emitKeypress({ name: "return", sequence: "\r" });
    await tui.waitForFrameToContain("bar:closed");
    expect(second.opened).toEqual(["SIVE"]);
  } finally {
    second.release();
  }
});

test("search's answer leaves the named lines where they were and adds the rest below", async () => {
  installListingDirectory([
    ["0700", "Tencent Holdings Limited", "HKEX", "Common Stock", "HKD", null, 1, 27_587],
    ["0700", "Renegade Gold Inc.", "XDUS", "Common Stock", "EUR", null, 0, null],
  ]);
  // The answer has another line of Renegade's, which it ranks above the one named.
  const { opened, saved, release } = await typeWithSearchHeld("0700", [
    { ...tencent, popularity: 27_587 },
    { ...renegade, exchange: "FWB2" },
    renegade,
  ]);
  expect(tui.frame()).not.toContain("FWB2");
  release();
  await tui.waitForFrameToContain("FWB2");
  await tui.waitForFrameToExclude("Searching");
  const frame = tui.frame();
  expect(frame.indexOf("Tencent")).toBeLessThan(frame.indexOf("XDUS"));
  expect(frame.indexOf("XDUS")).toBeLessThan(frame.indexOf("FWB2"));
  await tui.emitKeypress({ name: "return", sequence: "\r" });
  await tui.waitForFrameToContain("bar:closed");
  expect(opened).toEqual(["0700"]);
  expect(saved.at(-1)?.metadata).toMatchObject({ exchange: "HKEX", name: "Tencent Holdings Limited" });
});

// From Gloom Cloud, as the index's lines are, so a line both name is one row.
const dollarGeneral: InstrumentSearchResult = {
  providerId: "gloomberb-cloud", symbol: "DG", name: "Dollar General Corporation", exchange: "NYSE", currency: "USD", type: "Common Stock",
  homeListing: true, popularity: 13_617_000,
};
const vinci = (exchange: string): InstrumentSearchResult => ({
  providerId: "gloomberb-cloud", symbol: "DG", name: "Vinci SA", exchange, currency: "EUR", type: "Common Stock", ...(exchange === "EPA" ? { homeListing: true } : {}),
});
/** Lines the index got wrong: Vinci's, with nothing to say Dollar General is the DG people mean. */
function shipVinci(): void {
  installListingDirectory([
    ["DG", "Vinci SA", "EPA", "Common Stock", "EUR", null, 1, null],
    ["DG", "Vinci SA", "VIE", "Common Stock", "EUR", null, 0, null],
  ]);
}

test("an answer that leads with another listing than the index named takes the highlight the user left alone", async () => {
  shipVinci();
  const { opened, saved, release } = await typeWithSearchHeld("DG", [dollarGeneral, vinci("EPA"), vinci("VIE")]);
  expect(listOf(tui.frame())).toContain("Vinci SA");
  release();
  await tui.waitForFrameToContain("Dollar General");
  await tui.waitForFrameToExclude("Searching");
  expect(tui.frame().indexOf("Dollar General")).toBeLessThan(tui.frame().indexOf("Vinci"));
  await tui.emitKeypress({ name: "return", sequence: "\r" });
  await tui.waitForFrameToContain("bar:closed");
  expect(opened).toEqual(["DG"]);
  expect(saved.at(-1)?.metadata).toMatchObject({ exchange: "NYSE", name: "Dollar General Corporation" });
});

test("an answer that puts the company the word names ahead of the lines the index named takes its order: hsbc's home line and 0005 before the receipt's copies", async () => {
  // HSBC's own lines, as an earlier search left them in the index: the receipt in New York and its copies.
  installListingDirectory([
    ["HSBC", "HSBC Holdings, plc.", "NYSE", "American Depositary Receipt", "USD", "NYSE", 0, 11_277_000],
    ["HSBC", "HSBC Holdings Plc CEDAR", "BYMA", "Depositary Receipt", "ARS", "BYMA", 0, null],
    ["HSBC", "HSBC Holdings, plc.", "IEX", "American Depositary Receipt", "USD", "IEX", 0, null],
  ]);
  const venues = () => tui.frame().split("\n").filter((line) => line.includes("HSBC Holdings")).map((line) => line.trim().split(/\s+/).at(-1));
  const { release } = await typeWithSearchHeld("hsbc", searchAnswers.answers.hsbc as InstrumentSearchResult[]);
  expect(venues()).not.toContain("HKEX");
  release();
  await tui.waitForFrameToContain("HKEX");
  await tui.waitForFrameToExclude("Searching");
  // The service's order of HSBC's lines, under the ticker as typed: London, Hong Kong, then the copies.
  expect(venues()).toEqual(["NYSE", "LSE", "HKEX", "BYMA", "IEX"]);
});

test("a highlight the user moved stays on its row, in its place, whatever the answer leads with", async () => {
  shipVinci();
  const { saved, release } = await typeWithSearchHeld("DG", [dollarGeneral, vinci("EPA"), vinci("VIE")]);
  await tui.emitKeypress({ name: "down" });
  release();
  await tui.waitForFrameToContain("Dollar General");
  await tui.waitForFrameToExclude("Searching");
  const frame = tui.frame();
  expect(frame.indexOf("EPA")).toBeLessThan(frame.indexOf("VIE"));
  expect(frame.indexOf("VIE")).toBeLessThan(frame.indexOf("Dollar General"));
  await tui.emitKeypress({ name: "return", sequence: "\r" });
  await tui.waitForFrameToContain("bar:closed");
  expect(saved.at(-1)?.metadata).toMatchObject({ exchange: "VIE", name: "Vinci SA" });
});

test("a broker account's search names nothing before its own answer", async () => {
  shipTencent();
  const { release } = await typeWithSearchHeld("0700", [tencent], (config) => ({
    ...config,
    portfolios: config.portfolios.map((portfolio) => ({ ...portfolio, brokerId: "ibkr", brokerInstanceId: "ibkr-live" })),
  }));
  expect(tui.frame()).not.toContain("Tencent");
  expect(tui.frame()).toContain("Searching");
  release();
  await tui.waitForFrameToContain("Tencent Holdings Limited");
});

test("search's answer keeps every line named before it, even where it adds another security", async () => {
  const venues = ["XNAS", "BVC", "BMV", "VIE", "WSE", "IEX"];
  installListingDirectory(venues.map((venue, index) => ["ACME", "Acme Corp.", venue, "Common Stock", "USD", null, index === 0 ? 1 : 0, null]));
  const answer: InstrumentSearchResult[] = [
    ...venues.map((exchange, index) => ({ providerId: "test", symbol: "ACME", name: "Acme Corp.", exchange, currency: "USD", type: "Common Stock", homeListing: index === 0 })),
    { providerId: "test", symbol: "ACME", name: "Acme Corp. CEDEAR", exchange: "BYMA", currency: "ARS", type: "Common Stock" },
  ];
  const { release } = await typeWithSearchHeld("ACME", answer);
  const named = tui.frame().split("\n").filter((line) => line.includes("Acme Corp."));
  expect(named).toHaveLength(5);
  release();
  await tui.waitForFrameToExclude("Searching");
  expect(tui.frame().split("\n").filter((line) => line.includes("Acme Corp."))).toEqual(named);
});

test("a search cut short that finds none of the symbol's lines leaves the named ones up", async () => {
  shipTencent();
  // The keystroke's search gave a slow source up: nothing came back for 0700.
  const { release } = await typeWithSearchHeld("0700", []);
  release();
  await tui.waitForFrameToExclude("Searching");
  expect(listOf(tui.frame())).toContain("Tencent Holdings Limited");
});
