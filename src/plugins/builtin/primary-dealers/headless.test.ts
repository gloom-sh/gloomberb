import { afterEach, beforeEach, expect, test } from "bun:test";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { headlessReportTables, renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { renderReportCsv } from "../../../cli/report-tables";
import type { HeadlessBundleResult, HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { resetPrimaryDealersCache } from "./client";
import { primaryDealersHeadless } from "./headless";

const args: HeadlessPaneLoadArgs = { rawArgument: "", argument: null, symbols: [], options: {} };
const row = (keyid: string, value: string) => ({ asofdate: "2026-10-07", keyid, value });

beforeEach(() => {
  resetPrimaryDealersCache();
  setHttpFetchTransport(async (url) => {
    if (String(url).endsWith("seriesbreaks.json")) {
      return Response.json({ pd: { seriesbreaks: [{ seriesbreak: "SBN2024", startdate: "2024-07-03" }] } });
    }
    return Response.json({ pd: { timeseries: [
      row("PDPOSGST-TOT", "444683"), row("PDPOSGST-TOTC", "12651"),
      row("PDPOSGS-B", "109081"), row("PDPOSGS-BC", "-564"),
      row("PDPOSMBSFGS-TBA", "-421068"), row("PDPOSMBSFGS-TBAC", "1500"),
      row("PDFTD-USTET", "121178"), row("PDFTD-USTETC", "-9511"),
    ] } });
  });
});

afterEach(() => setHttpFetchTransport(null));

async function report() {
  const result = await primaryDealersHeadless.load(args, {} as HeadlessPaneContext) as HeadlessBundleResult;
  const freshness = deriveHeadlessFreshness(primaryDealersHeadless, result);
  const tables = headlessReportTables(primaryDealersHeadless, result, args, "PDLR", freshness, { complete: true, unavailableSymbols: [] });
  return {
    text: renderHeadlessPaneText(primaryDealersHeadless, result, args, "PDLR", freshness),
    csv: renderReportCsv(tables, freshness).split("\n"),
  };
}

test("the report sets a breakdown in under its total, and the export names the total and the unit beside each number", async () => {
  const { text, csv } = await report();
  const lines = text.split("\n");
  expect(lines.find((line) => line.startsWith("Treasuries"))).toMatch(/2026-10-07\s+444,683\s+432,032\s+\+12,651/);
  expect(lines.find((line) => line.includes("  Bills"))).toMatch(/^ {2}Bills\s+2026-10-07\s+109,081\s+109,645\s+-564/);
  expect(lines.find((line) => line.includes("Treasuries ex-TIPS, fails to deliver"))).toMatch(/121,178\s+130,689\s+-9,511/);

  const header = csv.find((line) => line.startsWith("Position"))!;
  expect(header).toContain("Group");
  expect(header).toContain("Latest $mn");
  expect(csv.find((line) => line.startsWith("Bills,"))).toContain("Treasuries");
  expect(csv.find((line) => line.startsWith("TBA,"))).toContain("-421068");
  expect(csv.find((line) => line.startsWith("Bills,"))).toContain("USD millions");
});
