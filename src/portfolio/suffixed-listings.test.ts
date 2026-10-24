import { expect, test } from "bun:test";
import { AppPersistence } from "../data/app-persistence";
import { TickerRepository } from "../data/ticker-repository";
import { createTestTicker } from "../test-support/ticker";
import { createDefaultConfig } from "../types/config";
import type { TickerPosition, TickerRecord } from "../types/ticker";
import { mergeSavedSuffixedListings, mergeSuffixedListings } from "./suffixed-listings";

const lot = (shares: number, avgCost: number, overrides: Partial<TickerPosition> = {}): TickerPosition => ({
  portfolio: "savings", shares, avgCost, currency: "TRY", broker: "manual", ...overrides,
});
const bist = { exchange: "BIST", currency: "TRY" };

/** GARAN saved twice, as a saver who typed GARAN.IS one day and GARAN:BIST another had it. */
function garanPair(): TickerRecord[] {
  return [
    createTestTicker("GARAN.IS:BIST", "Turkiye Garanti Bankasi A.S.", {
      ...bist, portfolios: ["savings"], watchlists: ["banks"], positions: [lot(50, 100, { dateAcquired: "2025-03-01" })], tags: ["bank"], custom: { thesis: "rates" },
    }),
    createTestTicker("GARAN", "Turkiye Garanti Bankasi A.S.", { ...bist, portfolios: ["savings"], positions: [lot(100, 120)] }),
  ];
}

test("a suffixed row and its listing's row merge into the listing's, its lots, lists, tags and target added, and loading again changes nothing", async () => {
  const persistence = new AppPersistence(":memory:");
  const store = new TickerRepository(persistence.tickers);
  try {
    await store.saveTickers(garanPair());
    const config = { ...createDefaultConfig("/unused"), portfolios: [{ id: "savings", name: "Savings", currency: "TRY", targetWeights: { "GARAN.IS:BIST": 10, GARAN: 5 } }] };
    const merged = await mergeSavedSuffixedListings(await store.loadAllTickers(), config, (rows) => store.saveTickers(rows));

    const garan = (await store.loadTicker("GARAN"))!.metadata;
    expect(garan.positions).toEqual([lot(100, 120), lot(50, 100, { dateAcquired: "2025-03-01" })]);
    expect(garan).toMatchObject({ portfolios: ["savings"], watchlists: ["banks"], tags: ["bank"], custom: { thesis: "rates" } });
    // The suffixed row stays for what names it, holding nothing.
    expect((await store.loadTicker("GARAN.IS:BIST"))!.metadata).toMatchObject({ portfolios: [], watchlists: [], positions: [], tags: [], custom: {} });
    expect(merged!.config.portfolios[0]!.targetWeights).toEqual({ GARAN: 15 });
    expect(merged!.tickers.filter((ticker) => ticker.metadata.positions.length > 0).map((ticker) => ticker.metadata.ticker)).toEqual(["GARAN"]);

    expect(mergeSuffixedListings(await store.loadAllTickers())).toBeNull();
  } finally {
    persistence.close();
  }
});

test("a suffixed row synced back with lots already merged adds only the lots that are new", () => {
  const first = mergeSuffixedListings(garanPair())!;
  const garan = first.saves.find((row) => row.metadata.ticker === "GARAN")!;
  // Another device still has the old row, with one lot bought there since.
  const synced = createTestTicker("GARAN.IS:BIST", "Turkiye Garanti Bankasi A.S.", {
    ...bist, portfolios: ["savings"], positions: [lot(50, 100, { dateAcquired: "2025-03-01" }), lot(10, 130)],
  });
  const again = mergeSuffixedListings([garan, synced])!;
  expect(again.saves.find((row) => row.metadata.ticker === "GARAN")!.metadata.positions)
    .toEqual([lot(100, 120), lot(50, 100, { dateAcquired: "2025-03-01" }), lot(10, 130)]);
});

test("a suffixed row with no listing row becomes one, beside another venue's row under the bare symbol; a broker's row and a share class stay", () => {
  const merge = mergeSuffixedListings([
    createTestTicker("VOD", "Vodafone Group Plc ADR", { exchange: "NASDAQ", watchlists: ["growth"] }),
    createTestTicker("VOD.L", "Vodafone Group Plc", { exchange: "LSE", currency: "GBP", watchlists: ["growth"] }),
    createTestTicker("AKBNK.IS", "Akbank T.A.S.", { exchange: "", currency: "TRY", watchlists: ["banks"] }),
    createTestTicker("THYAO.IS:BIST", "Turk Hava Yollari", { ...bist, positions: [lot(5, 300, { broker: "ibkr", brokerInstanceId: "ib" })], portfolios: ["savings"] }),
    createTestTicker("BRK.B", "Berkshire Hathaway", { exchange: "NYSE", watchlists: ["growth"] }),
  ])!;
  expect([...merge.moved]).toEqual([["VOD.L", "VOD:XLON"], ["AKBNK.IS", "AKBNK"]]);
  expect(merge.saves.find((row) => row.metadata.ticker === "VOD:XLON")!.metadata).toMatchObject({ exchange: "LSE", watchlists: ["growth"] });
  expect(merge.saves.find((row) => row.metadata.ticker === "AKBNK")!.metadata).toMatchObject({ exchange: "BIST", watchlists: ["banks"] });
});
