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
const bond = lot(50, 98.5, { dateAcquired: "2025-03-01", priceBasis: "percent-of-par" });

/** GARAN saved twice, as a saver who typed GARAN.IS one day and GARAN:BIST another had it. */
function garanPair(): TickerRecord[] {
  return [
    createTestTicker("GARAN.IS:BIST", "Turkiye Garanti Bankasi A.S.", {
      ...bist, portfolios: ["savings"], watchlists: ["banks"], positions: [bond], tags: ["bank"],
      custom: { thesis: "rates", note: "from IS", target: "" },
    }),
    createTestTicker("GARAN", "Turkiye Garanti Bankasi A.S.", {
      ...bist, portfolios: ["savings"], positions: [lot(100, 120)], custom: { thesis: "", note: "own", target: "150" },
    }),
  ];
}

test("a suffixed row merges into its listing's row: lots, lists, tags, custom fields and targets, the target saved before the rows, and nothing on a second load", async () => {
  const persistence = new AppPersistence(":memory:");
  const store = new TickerRepository(persistence.tickers);
  try {
    await store.saveTickers(garanPair());
    const config = { ...createDefaultConfig("/unused"), portfolios: [{ id: "savings", name: "Savings", currency: "TRY", targetWeights: { "GARAN.IS:BIST": 10, GARAN: 5 } }] };
    const writes: string[] = [];
    const merged = await mergeSavedSuffixedListings(await store.loadAllTickers(), config, {
      config: async (next) => { writes.push(`config ${JSON.stringify(next.portfolios[0]!.targetWeights)}`); },
      tickers: async (rows) => {
        writes.push(`rows ${rows.map((row) => row.metadata.ticker).join(" ")}`);
        await store.saveTickers(rows);
      },
    });
    expect(writes).toEqual(['config {"GARAN":15}', "rows GARAN GARAN.IS:BIST"]);

    const garan = (await store.loadTicker("GARAN"))!.metadata;
    expect(garan.positions).toEqual([lot(100, 120), bond]);
    expect(garan).toMatchObject({ portfolios: ["savings"], watchlists: ["banks"], tags: ["bank"] });
    // The listing's value wins where it has one; a value it lacks comes over; the bookkeeping is no custom field.
    expect(garan.custom).toEqual({ thesis: "rates", note: "own", target: "150" });
    expect(garan.mergedLots?.["GARAN.IS:BIST"]).toHaveLength(1);
    // The suffixed row stays for what names it, holding nothing but the value it was outvoted on.
    expect((await store.loadTicker("GARAN.IS:BIST"))!.metadata).toMatchObject({ portfolios: [], watchlists: [], positions: [], tags: [], custom: { note: "from IS" } });
    expect(merged).toMatchObject({ keptCustom: [{ from: "GARAN.IS:BIST", into: "GARAN", fields: ["note"] }] });

    expect(mergeSuffixedListings(await store.loadAllTickers())?.saves).toEqual([]);
    expect(await mergeSavedSuffixedListings(await store.loadAllTickers(), merged!.config, { config: async () => {}, tickers: async () => {} })).toBeNull();
  } finally {
    persistence.close();
  }
});

test("a suffixed row brought back with lots merged before adds only the new ones, matched on the fields sync keeps", () => {
  const first = mergeSuffixedListings(garanPair())!;
  const garan = first.saves.find((row) => row.metadata.ticker === "GARAN")!;
  // Through sync the bond lot lost its price basis; another device bought one more lot since.
  const { priceBasis: _basis, ...synced } = bond;
  const back = createTestTicker("GARAN.IS:BIST", "Turkiye Garanti Bankasi A.S.", {
    ...bist, portfolios: ["savings"], positions: [synced, lot(10, 130)],
  });
  const again = mergeSuffixedListings([garan, back])!;
  expect(again.saves.find((row) => row.metadata.ticker === "GARAN")!.metadata.positions).toEqual([lot(100, 120), bond, lot(10, 130)]);
  // A target an older config still names moves too, though the row was merged before.
  expect(again.moved.get("GARAN.IS:BIST")).toBe("GARAN");
});

test("a merge takes its venue's key, never a free bare one, and leaves a broker's row and a suffix its venue contradicts", () => {
  const merge = mergeSuffixedListings([
    createTestTicker("VOD", "Vodafone Group Plc ADR", { exchange: "NASDAQ", watchlists: ["growth"] }),
    createTestTicker("VOD.L", "Vodafone Group Plc", { exchange: "LSE", currency: "GBP", watchlists: ["growth"] }),
    // SHOP stays free for the US listing.
    createTestTicker("SHOP.TO", "Shopify Inc.", { exchange: "TSX", currency: "CAD", watchlists: ["growth"] }),
    // A venue code the exchange table does not know: the suffix names it.
    createTestTicker("AKBNK.IS", "Akbank T.A.S.", { exchange: "IST", currency: "TRY", watchlists: ["banks"] }),
    // Already saved on its venue under the bare key: that row takes it.
    createTestTicker("SAP", "SAP SE", { exchange: "XETRA", currency: "EUR" }),
    createTestTicker("SAP.DE", "SAP SE", { exchange: "XETRA", currency: "EUR", watchlists: ["growth"] }),
    createTestTicker("THYAO.IS:BIST", "Turk Hava Yollari", { ...bist, positions: [lot(5, 300, { broker: "ibkr", brokerInstanceId: "ib" })], portfolios: ["savings"] }),
    // McCormick's voting class on NYSE, not a TSX Venture listing.
    createTestTicker("MKC.V", "McCormick & Company", { exchange: "NYSE", watchlists: ["growth"] }),
    createTestTicker("BRK.B", "Berkshire Hathaway", { exchange: "NYSE", watchlists: ["growth"] }),
  ])!;
  expect([...merge.moved]).toEqual([["VOD.L", "VOD:XLON"], ["SHOP.TO", "SHOP:XTSE"], ["AKBNK.IS", "AKBNK:BIST"], ["SAP.DE", "SAP"]]);
  expect(merge.saves.find((row) => row.metadata.ticker === "AKBNK:BIST")!.metadata).toMatchObject({ exchange: "BIST", watchlists: ["banks"] });
  expect(merge.saves.find((row) => row.metadata.ticker === "SAP")!.metadata.watchlists).toEqual(["growth"]);
});
