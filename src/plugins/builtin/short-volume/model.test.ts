import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import type { ShortVolumeObservation, ShortVolumePayload } from "../../../api-client/short-volume";
import { fetchShortVolume, validateShortVolume } from "./client";
import { exactQuantity, sortedVolumeHistory, volumeHistoryPoints } from "./model";

function fixture(): ShortVolumePayload {
  const row: ShortVolumeObservation = { date: "2026-09-21", shortVolume: "50.000001", shortExemptVolume: "0.000001", totalVolume: "100.000001",
    ratioPercent: 50.00000049, markets: ["B", "Q", "N"], fetchedAt: "2026-09-22T00:00:00Z", sourceUrl: "https://cdn.finra.org/equity/regsho/daily/CNMSshvol20260921.txt", refreshFailed: false, unavailableReason: null };
  return { version: 1, symbol: "AAPL", finraSymbol: "AAPL", scope: "nms", status: "partial", fetchedAt: "2026-09-22T00:00:00Z", asOf: row.date, sourceAsOf: row.date,
    source: { name: "FINRA", url: row.sourceUrl, cadence: "Daily" }, history: [row], latest: { ...row, changePp: null, previousDate: null,
      percentile: { value: null, rank: .5, sampleCount: 1, windowStart: "2025-09-21", windowEnd: row.date, historyStart: row.date, historyEnd: row.date, completeWindow: false, min: row.ratioPercent, max: row.ratioPercent, mean: row.ratioPercent } },
    coverage: { windowStart: "2025-09-21", windowEnd: row.date, expectedFiles: 1, ingestedFiles: 1, missingFiles: 0, expectedMonths: 13, discoveredMonths: 1, completeWindow: false }, warnings: ["Limited history"] };
}
test("Cloud boundary preserves six-decimal shares and rejects ratio, precision and source identity corruption", () => {
  const data=validateShortVolume(fixture(),"AAPL","nms");
  expect(data.latest?.shortVolume).toBe("50.000001");
  expect(exactQuantity("1234567890.000001")).toBe("1,234,567,890.000001");
  const invalid=fixture(); invalid.history[0]!.shortVolume="50.0000001";
  expect(()=>validateShortVolume(invalid,"AAPL","nms")).toThrow();
  const ratio=fixture(); ratio.history[0]!.ratioPercent=55;
  expect(()=>validateShortVolume(ratio,"AAPL","nms")).toThrow();
  expect(()=>validateShortVolume(fixture(),"ABRpD","nms")).toThrow();
  expect(()=>validateShortVolume(fixture(),"AAPL","otc")).toThrow();
});
test("missing files stay chart gaps and decimal share sorting does not round microshares", () => {
  const data=fixture();
  data.history=[{...data.history[0]!, date:"2026-07-01", shortVolume:"9007199254.000002"},{...data.history[0]!,shortVolume:"9007199254.000001"}];
  expect(sortedVolumeHistory(data,{column:"shortVolume",direction:"desc"}).map(row=>row.date)).toEqual(["2026-07-01","2026-09-21"]);
  expect(volumeHistoryPoints(data).map(row=>row.value)).toEqual([50.00000049,null,50.00000049]);
  const pending=fixture(); pending.history[0]={...pending.history[0]!,shortVolume:null,shortExemptVolume:null,totalVolume:null,ratioPercent:null,fetchedAt:null,unavailableReason:"missing_file"};
  pending.latest=null;pending.asOf=null;pending.status="unavailable";pending.coverage.ingestedFiles=0;pending.coverage.missingFiles=1;
  expect(validateShortVolume(pending,"AAPL","nms").history[0]!.ratioPercent).toBeNull();
});
test("missing endpoint is recoverable while authorization failures remain distinct", async()=>{
  await expect(fetchShortVolume("AAPL","nms",{getCloudShortVolume:async()=>{throw new ApiRequestError("missing",404);}})).rejects.toThrow("not available on this Gloom Cloud server yet");
  const denied=new ApiRequestError("Forbidden",403);
  await expect(fetchShortVolume("AAPL","nms",{getCloudShortVolume:async()=>{throw denied;}})).rejects.toBe(denied);
});
