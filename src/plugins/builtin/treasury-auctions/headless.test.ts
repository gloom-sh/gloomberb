import { afterEach, expect, setSystemTime, test } from "bun:test";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { headlessReportTables, renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { attachTreasuryAuctionsPersistence, CACHE_SCHEMA_VERSION, DIRECT_CACHE_SCHEMA_VERSION, resetTreasuryAuctionsPersistence } from "./cache";
import { auction, RECORDED_NOW, recordedFiscalData, recordedTreasuryDirect } from "./test-fixture";
import { createTreasuryAuctionsHeadless, treasuryAuctionsHeadless } from "./headless";

const row = (secType: string, rate: number, extra: Record<string, unknown> = {}) => ({
  auctionDate: "2026-09-23", secType, securityTerm: "10-Year", rate, ...extra,
});

test("a TIPS rate reads as a real yield and an FRN's as a spread in the text, an announced auction that its results are not published; the export keeps plain numbers", () => {
  const result = { rows: [
    row("Bill", 4.048), row("Note", 5.3), row("TIPS", 2.653),
    row("FRN", 0.04, { highDiscountMargin: 0.04 }), { ...row("TIPS", 0), rate: null },
  ] };
  const args = createTestHeadlessArgs();
  const lines = renderHeadlessPaneText(treasuryAuctionsHeadless, result, args, "AUCT").split("\n");
  const rates = lines.filter((line) => /^2026-09-23/.test(line)).map((line) => line.replace(/^\S+\s+\S+\s+\S+\s+/, "").split(/\s{2,}/)[0]);
  expect(rates).toEqual(["4.048%", "5.300%", "2.653% real", "4.0bp spread", "results not published"]);

  const freshness = deriveHeadlessFreshness(treasuryAuctionsHeadless, result);
  const table = headlessReportTables(treasuryAuctionsHeadless, result, args, "AUCT", freshness, { complete: true, unavailableSymbols: [] }).tables[0]!;
  const rate = table.columns.indexOf("Rate");
  expect(table.rows.map((entry) => entry[rate])).toEqual([4.048, 5.3, 2.653, 4, ""]);
  expect(table.rows.map((entry) => entry[table.columns.indexOf("Rate unit")])).toEqual(["%", "%", "%", "bp", ""]);
  // The export says it once, in the row's status, and leaves the figures blank.
  expect(table.rows.map((entry) => entry[table.columns.indexOf("status")])).toEqual(["", "", "", "", "Rate: results not published"]);
  const stopOut = table.columns.indexOf("Stop-out vs avg (bp)");
  expect(stopOut).toBeGreaterThan(rate);
  expect(table.rows[4]!.slice(stopOut, table.columns.indexOf("Dealer (%)") + 1).every((cell) => cell === "")).toBe(true);
});

afterEach(() => {
  resetTreasuryAuctionsPersistence();
  setSystemTime();
});

test("the report is dated by the newest auction it lists, not by where Fiscal Data's board ends; an announced one is not an observation", async () => {
  setSystemTime(new Date(RECORDED_NOW));
  const persistence = new MemoryPluginPersistence();
  persistence.seedResource("treasury-auctions", "recent:120", recordedFiscalData(), { sourceKey: "treasury-fiscal-data", schemaVersion: CACHE_SCHEMA_VERSION });
  persistence.seedResource("treasury-auctions", "direct:60", recordedTreasuryDirect(), { sourceKey: "treasury-direct", schemaVersion: DIRECT_CACHE_SCHEMA_VERSION });
  attachTreasuryAuctionsPersistence(persistence);

  const run = async (argument: string | null) => {
    const result = await treasuryAuctionsHeadless.load(
      createTestHeadlessArgs({ argument, options: { historyDays: "120", filter: "all" } }), createTestHeadlessContext(),
    );
    return { rows: result.rows.map((entry) => String(entry.auctionDate)), asOf: deriveHeadlessFreshness(treasuryAuctionsHeadless, result, Date.parse(RECORDED_NOW)).asOf };
  };
  const all = await run(null);
  // Fiscal Data's last row is 22 Oct; the newest result is 5 Nov, and 9 to 12 Nov are announced.
  expect(all.rows).toEqual(expect.arrayContaining(["2026-11-12", "2026-11-05", "2026-10-22"]));
  expect(all.asOf).toBe("2026-11-05");
  // A search dates the report by the rows it leaves.
  expect((await run("2026-10-2")).asOf).toBe("2026-10-29");
  expect((await run("2026-10-22")).asOf).toBe("2026-10-22");
});

test("a bill board heads its rate as the investment rate and lists the discount rate Treasury announces beside it", async () => {
  // 2026-11-03 6-week bill: investment rate 4.013%, high discount rate 3.940%.
  const bill = auction({
    secType: "Bill", securityTerm: "6-Week", auctionDate: "2026-11-03", cusip: "912797VH7",
    highInvestmentRate: 4.013, highDiscountRate: 3.94, avgMedDiscountRate: 3.91, bidToCoverRatio: 2.88,
  });
  const headless = createTreasuryAuctionsHeadless({
    load: async () => ({ auctions: [bill], fetchedAt: Date.parse(RECORDED_NOW), stale: false }),
    curves: async () => ({ curves: new Map(), errors: [] }),
  });
  const args = createTestHeadlessArgs({ argument: "6-Week", options: { historyDays: "120", filter: "all" } });
  const result = await headless.load(args, createTestHeadlessContext());
  const [header, line] = renderHeadlessPaneText(headless, result, args, "AUCT").split("\n").filter((entry) => /^(Date|2026)/.test(entry));
  expect(header).toMatch(/Investment rate\s+Discount rate\s+Stop-out vs median \(bp\)/);
  expect(line).toMatch(/4\.013%\s+3\.940%\s+3\.0/);
  // The text says median; exports keep the name scripts read the spread by, whichever figure Treasury published.
  expect(result.rows[0]).toMatchObject({ stopOutVsAvgBp: 3 });
  const freshness = deriveHeadlessFreshness(headless, result);
  const table = headlessReportTables(headless, result, args, "AUCT", freshness, { complete: true, unavailableSymbols: [] }).tables[0]!;
  expect(table.rows[0]![table.columns.indexOf("Stop-out vs avg (bp)")]).toBe(3);
});

test("--sort by an after column shows the after view, and the export carries its percentiles and moves", async () => {
  const sevens = Array.from({ length: 14 }, (_, index) => auction({
    secType: "Note", securityTerm: "7-Year", id: `7y-${index}`, cusip: `91282C${String(index).padStart(3, "0")}`,
    auctionDate: `2026-${String(Math.floor(index / 2) + 1).padStart(2, "0")}-${index % 2 ? "25" : "05"}`,
    highYield: 4.5, bidToCoverRatio: 2.3 + index / 100,
  }));
  const closes = [{ date: "2026-07-25", value: 4.5 }, { date: "2026-07-27", value: 4.56 }];
  const shown: string[][] = [];
  const headless = createTreasuryAuctionsHeadless({
    load: async () => ({ auctions: sevens, fetchedAt: Date.parse(RECORDED_NOW), stale: false }),
    curves: async (rows) => {
      shown.push(rows.map((row) => row.id));
      return { curves: new Map([["us:7Y", closes]]), errors: [] };
    },
  });
  setSystemTime(new Date("2026-08-01T00:00:00Z"));
  const args = createTestHeadlessArgs({ argument: "7Y", options: { historyDays: "3650", filter: "all", sort: "btc-pctl" } });
  const result = await headless.load(args, createTestHeadlessContext());
  expect(result.metadata).toMatchObject({ view: "after", sort: "btc-pctl" });
  // The newest, with the highest B/C of its 13 before it, leads; the 12th and older have too few before them.
  expect(result.rows[0]).toMatchObject({ id: "7y-13", btcPercentile: 100, after1d: 6, cmt: "7Y" });
  expect(result.rows.slice(-12).every((row) => row.btcPercentile == null)).toBe(true);
  const table = headlessReportTables(headless, result, args, "AUCT", deriveHeadlessFreshness(headless, result), { complete: true, unavailableSymbols: [] }).tables[0]!;
  expect(table.columns).toEqual(expect.arrayContaining(["B/C pctl", "Indirect pctl", "Dealer pctl", "+1d (bp)", "+5d (bp)", "+20d (bp)"]));
  expect(table.rows[0]![table.columns.indexOf("+1d (bp)")]).toBe(6);
  expect(shown[0]).toHaveLength(14);

  // -btc-pctl turns it: the lowest ranked first, the ones with too few before them still last; the options name the view shown.
  const reversed = await headless.load(createTestHeadlessArgs({ argument: "7Y", options: { historyDays: "3650", filter: "all", sort: "-btc-pctl" } }),
    createTestHeadlessContext());
  expect(reversed.rows.slice(0, 2).map((row) => row.btcPercentile)).toEqual([100, 100]);
  expect(reversed.rows.at(-1)!.btcPercentile).toBeNull();
  expect([reversed.appliedOptions, reversed.metadata?.sort]).toEqual([{ market: "us", view: "after" }, "-btc-pctl"]);
});

// The analyst joined the results and after CSVs in Python to find the weak 10Y auctions like this week's and what yields did next.
test("--like ranks the tenor's earlier auctions by their stop-out, B/C and indirect percentiles' distance, and sums up the yield after them", async () => {
  // 40 monthly 7-year notes from 2023 to 2026, their figures turning over on different cycles, and a 10-year on the newest's day.
  const month = (index: number) => `${2023 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, "0")}-15`;
  const sevens = Array.from({ length: 40 }, (_, index) => auction({
    secType: "Note", securityTerm: "7-Year", id: `7y-${index}`, auctionDate: month(index),
    highYield: 4 + (index * 3 % 7) / 100, avgMedYield: 4, bidToCoverRatio: 2.2 + (index * 5 % 11) / 20,
    competitiveAccepted: 40e9, indirectAccepted: (20 + index * 7 % 13) * 1e9, primaryDealerAccepted: 5e9,
  }));
  const ten = auction({ secType: "Note", securityTerm: "10-Year", auctionDate: month(39), highYield: 4.5, avgMedYield: 4.4, bidToCoverRatio: 2.5 });
  // A close every day, up and down.
  const closes = Array.from({ length: 1300 }, (_, day) => ({
    date: new Date(Date.UTC(2023, 0, 1) + day * 86_400_000).toISOString().slice(0, 10), value: 4 + (day * 37 % 100) / 1000,
  }));
  const headless = createTreasuryAuctionsHeadless({
    load: async (_args, window) => {
      expect(window).toBe("all");
      return { auctions: [ten, ...sevens].toReversed(), fetchedAt: Date.parse("2026-07-01T00:00:00Z"), stale: false };
    },
    curves: async () => ({ curves: new Map([["us:7Y", closes]]), errors: [] }),
  });
  setSystemTime(new Date("2026-07-01T00:00:00Z"));
  const args = createTestHeadlessArgs({ argument: "7Y", options: { historyDays: "120", filter: "all", like: month(39) } });
  const result = await headless.load(args, createTestHeadlessContext());
  const like = result.metadata?.like as Record<string, unknown> & { summary: unknown[] };
  expect(like).toMatchObject({ id: "7y-39", compared: ["stopOutPercentile", "btcPercentile", "indirectPercentile"] });
  // The 15 closest of the 27 with a percentile before it, all 7-years and earlier, the closest first.
  expect(result.rows).toHaveLength(15);
  expect(result.rows.every((row) => row.securityTerm === "7-Year" && String(row.auctionDate) < month(39))).toBe(true);
  const distances = result.rows.map((row) => Number(row.distance));
  expect(distances).toEqual(distances.toSorted((left, right) => left - right));
  const gap = (row: Record<string, unknown>) => Math.sqrt((["stopOutPercentile", "btcPercentile", "indirectPercentile"] as const)
    .reduce((sum, key) => sum + (Number(row[key]) - Number(like[key])) ** 2, 0) / 3);
  expect(gap(result.rows[0]!)).toBeCloseTo(distances[0]!, 0);
  // The summary is the listed auctions' own moves: the median and the share that rose.
  const fives = result.rows.map((row) => Number(row.after5d)).toSorted((left, right) => left - right);
  expect(like.summary[1]).toEqual({ move: "after5d", label: "+5d", medianBp: fives[7]!, rosePct: Math.round(fives.filter((move) => move > 0).length / 15 * 100), count: 15 });
  // CSV and JSON alike: the ranked table with its distance, then the summary.
  const tables = headlessReportTables(headless, result, args, "AUCT", deriveHeadlessFreshness(headless, result), { complete: true, unavailableSymbols: [] }).tables;
  expect(tables[0]!.columns).toEqual(expect.arrayContaining(["Stop-out vs avg (bp)", "Stop-out pctl", "Indirect (%)", "Distance", "+5d (bp)"]));
  expect([tables[1]!.title, tables[1]!.columns.slice(0, 4)]).toEqual(["7Y yield after them", ["After", "Median (bp)", "Rose (%)", "Auctions"]]);
  expect(renderHeadlessPaneText(headless, result, args, "AUCT")).toContain(`Treasury Auctions | like ${month(39)} | all`);
  // A day with two auctions asks for a search that tells them apart.
  await expect(headless.load(createTestHeadlessArgs({ argument: null, options: { historyDays: "120", filter: "all", like: month(39) } }),
    createTestHeadlessContext())).rejects.toThrow(/held 2 auctions \(7-Year Note, 10-Year Note\): search for one/);
});
