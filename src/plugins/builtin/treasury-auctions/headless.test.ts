import { afterEach, expect, setSystemTime, test } from "bun:test";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { headlessReportTables, renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { attachTreasuryAuctionsPersistence, resetTreasuryAuctionsPersistence } from "./cache";
import { RECORDED_NOW, recordedFiscalData, recordedTreasuryDirect } from "./test-fixture";
import { treasuryAuctionsHeadless } from "./headless";

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
  expect(table.rows[4]!.slice(table.columns.indexOf("Stop-out vs avg (bp)"), table.columns.indexOf("Dealer (%)") + 1).every((cell) => cell === "")).toBe(true);
});

afterEach(() => {
  resetTreasuryAuctionsPersistence();
  setSystemTime();
});

test("the report is dated by the newest auction it lists, not by where Fiscal Data's board ends; an announced one is not an observation", async () => {
  setSystemTime(new Date(RECORDED_NOW));
  const persistence = new MemoryPluginPersistence();
  persistence.seedResource("treasury-auctions", "recent:120", recordedFiscalData(), { sourceKey: "treasury-fiscal-data", schemaVersion: 4 });
  persistence.seedResource("treasury-auctions", "direct:60", recordedTreasuryDirect(), { sourceKey: "treasury-direct", schemaVersion: 1 });
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
