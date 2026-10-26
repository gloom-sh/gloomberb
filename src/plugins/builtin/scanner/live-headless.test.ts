import { describe, expect, test } from "bun:test";
import type { LiveScanMatch, LiveScanPayload } from "../../../api-client/live-scan";
import { renderHeadlessPaneText, serializeHeadlessPaneResult } from "../../../cli/pane-functions/headless";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { liveScanHeadless } from "./live-headless";

const AS_OF = Date.parse("2026-10-26T16:45:00Z");

const payload = (fields: Partial<LiveScanPayload>): LiveScanPayload => ({
  status: "live",
  access: "delayed",
  delayMinutes: 15,
  asOf: AS_OF,
  takenAt: AS_OF + 15 * 60_000,
  refreshMs: 60_000,
  scanned: 5_000,
  matched: 0,
  matches: [],
  warmingWindows: [],
  warnings: [],
  ...fields,
});

const match = (fields: Partial<LiveScanMatch>): LiveScanMatch => ({
  symbol: "NN",
  name: "NextNav",
  exchange: "NASDAQ",
  price: 11.73,
  changePercent: null,
  volume: 4_908_610,
  relativeVolume: null,
  vwapPercent: null,
  gapPercent: null,
  values: [2, 3],
  signalAt: null,
  at: AS_OF,
  ...fields,
});

async function report(answer: LiveScanPayload) {
  const args: HeadlessPaneLoadArgs = { rawArgument: "", argument: null, symbols: [], options: { universe: "all", scan: "" } };
  const context = { apiClient: { getLiveScan: async () => answer }, signal: new AbortController().signal };
  const result = await liveScanHeadless.load(args, context as unknown as HeadlessPaneContext);
  return { result, text: renderHeadlessPaneText(liveScanHeadless, result, args, "SCAN") };
}

describe("the live scanner report", () => {
  test("says the scan is warming up and over which windows, not that there is no data", async () => {
    const { result, text } = await report(payload({ warmingWindows: [5, 15] }));
    expect(text).toContain("The scanner is warming up: conditions over 5 min, 15 min match nothing");
    expect(text).not.toContain("No data.");
    expect(serializeHeadlessPaneResult(liveScanHeadless, result)).toMatchObject({
      empty: expect.stringContaining("warming up"),
      metadata: { warmingWindows: [5, 15] },
    });
    // A scan with every window measured that matches nothing says so.
    expect((await report(payload({}))).text).toContain("Nothing matches right now.");
  });

  test("prints the change in percent and the relative volume as a multiple, as the pane does", async () => {
    const { result, text } = await report(payload({
      matched: 2,
      matches: [
        match({ changePercent: 16.5674603175, relativeVolume: 3.06685236614 }),
        match({ symbol: "SGRY", name: "Surgery Partners", changePercent: -0.592216582064, relativeVolume: 51.8546879778 }),
      ],
    }));
    expect(text).toContain("+16.57%");
    expect(text).toContain("3.1x");
    expect(text).toContain("-0.59%");
    expect(text).toContain("52x");
    expect(text).not.toContain("16.5674603175");
    // The JSON keeps every digit.
    const items = serializeHeadlessPaneResult(liveScanHeadless, result).items as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ changePercent: 16.5674603175, relativeVolume: 3.06685236614 });
  });
});
