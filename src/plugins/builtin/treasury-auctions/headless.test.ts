import { expect, test } from "bun:test";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { headlessReportTables, renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { createTestHeadlessArgs } from "../../../test-support/headless";
import { treasuryAuctionsHeadless } from "./headless";

const row = (secType: string, rate: number, extra: Record<string, unknown> = {}) => ({
  auctionDate: "2026-09-23", secType, securityTerm: "10-Year", rate, ...extra,
});

test("a TIPS rate reads as a real yield and an FRN's as a spread in the text; the export keeps plain numbers", () => {
  const result = { rows: [
    row("Bill", 4.048), row("Note", 5.3), row("TIPS", 2.653),
    row("FRN", 0.04, { highDiscountMargin: 0.04 }), { ...row("TIPS", 0), rate: null },
  ] };
  const args = createTestHeadlessArgs();
  const lines = renderHeadlessPaneText(treasuryAuctionsHeadless, result, args, "AUCT").split("\n");
  const rates = lines.filter((line) => /^2026-09-23/.test(line)).map((line) => line.replace(/^\S+\s+\S+\s+\S+\s+/, "").split(/\s{2,}/)[0]);
  expect(rates).toEqual(["4.048%", "5.300%", "2.653% real", "4.0bp spread", "-"]);

  const freshness = deriveHeadlessFreshness(treasuryAuctionsHeadless, result);
  const table = headlessReportTables(treasuryAuctionsHeadless, result, args, "AUCT", freshness, { complete: true, unavailableSymbols: [] }).tables[0]!;
  const rate = table.columns.indexOf("Rate");
  expect(table.rows.map((entry) => entry[rate])).toEqual([4.048, 5.3, 2.653, 4, ""]);
  expect(table.rows.map((entry) => entry[table.columns.indexOf("Rate unit")])).toEqual(["%", "%", "%", "bp", ""]);
});
