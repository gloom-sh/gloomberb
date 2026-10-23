import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import type { FailsToDeliverPayload, OtcVolumePayload } from "../../../api-client/short-side-publications";
import { fetchPublication, validatePublication } from "./publications-client";
import { publicationRows } from "./publications-model";
import { publicationHeadless } from "./publications-headless";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";

function ftd(): FailsToDeliverPayload {
  return { symbol: "AAPL", status: "available", asOf: "2026-09-21", sourceAsOf: "2026-09-30", fetchedAt: "2026-10-15T12:00:00Z",
    source: { name: "SEC", url: "https://www.sec.gov/data-research/sec-markets-data/fails-deliver-data", cadence: "twice monthly" }, warnings: [],
    coverage: { from: "2026-09-01", to: "2026-09-30", publications: 2 }, history: [
      { date: "2026-09-21", cusip: "037833100", quantity: 123456, price: 234.56, description: "APPLE INC", sourceUrl: "https://www.sec.gov/files/ftd.zip" },
      { date: "2026-09-21", cusip: "037833101", quantity: 321, price: null, description: "OTHER SECURITY", sourceUrl: "https://www.sec.gov/files/ftd.zip" },
    ] };
}
function ats(): OtcVolumePayload {
  return { ...ftd(), history: [{ weekStart: "2026-09-21", atsShares: 125, nonAtsShares: 375, totalShares: 500,
    atsTrades: 5, nonAtsTrades: 15, atsSharePercent: 25, sourceUrl: "https://otctransparency.finra.org/" }] };
}
test("settlement identity preserves multiple CUSIPs without summing and rejects duplicate or invalid observations", () => {
  const data = ftd();
  expect(publicationRows(validatePublication(data, "AAPL", "ftd")).map((row) => row.quantity)).toEqual([321, 123456]);
  data.history.push({ ...data.history[0]! });
  expect(() => validatePublication(data, "AAPL", "ftd")).toThrow("invalid");
  for (const patch of [{ date: "2026-09-31" }, { quantity: -1 }, { quantity: Number.MAX_SAFE_INTEGER + 1 }, { price: NaN }]) {
    const invalid = ftd(); Object.assign(invalid.history[0]!, patch);
    expect(() => validatePublication(invalid, "AAPL", "ftd")).toThrow("invalid");
  }
  expect(() => validatePublication(ftd(), "MSFT", "ftd")).toThrow("invalid");
});
test("weekly shares use both published categories; missing, zero and inconsistent totals remain distinct", () => {
  const missing = ats(); missing.status = "partial";
  Object.assign(missing.history[0]!, { nonAtsShares: null, nonAtsTrades: null, totalShares: null, atsSharePercent: null });
  expect(validatePublication(missing, "AAPL", "ats").history[0]).toEqual(missing.history[0]);
  const zero = ats(); Object.assign(zero.history[0]!, { atsShares: 0, nonAtsShares: 0, totalShares: 0, atsSharePercent: null });
  expect(validatePublication(zero, "AAPL", "ats").history[0]).toEqual(zero.history[0]);
  for (const patch of [{ totalShares: 501 }, { atsSharePercent: 0.25 }, { weekStart: "2026-09-22" }, { atsTrades: 1.5 }, { nonAtsShares: null }]) {
    const invalid = ats(); Object.assign(invalid.history[0]!, patch);
    expect(() => validatePublication(invalid, "AAPL", "ats")).toThrow("invalid");
  }
});
test("missing endpoints and unavailable migrations are recoverable while denied access remains an account gate", async () => {
  for (const status of [404, 503]) {
    const client = { getCloudFailsToDeliver: async () => { throw new ApiRequestError("Unavailable", status); }, getCloudOtcVolume: async () => ats() };
    await expect(fetchPublication("AAPL", "ftd", client)).rejects.toThrow("not available yet");
  }
  const error = new ApiRequestError("Forbidden", 403);
  await expect(fetchPublication("AAPL", "ats", { getCloudFailsToDeliver: async () => ftd(), getCloudOtcVolume: async () => { throw error; } })).rejects.toBe(error);
});
test("headless reports retain exact fail quantities and partial weekly source metadata", async () => {
  const data = ats(); data.status = "partial"; data.warnings = ["Some weeks are not published yet."];
  const ctx = { apiClient: { getCloudFailsToDeliver: async () => ftd(), getCloudOtcVolume: async () => data } } as unknown as HeadlessPaneContext;
  const args = { symbols: ["AAPL"], options: {} } as HeadlessPaneLoadArgs;
  const fails = await publicationHeadless("ftd").load(args, ctx);
  expect(fails.sections[0]!.rows!.map((row) => row.quantity)).toEqual([321, 123456]);
  const weekly = await publicationHeadless("ats").load(args, ctx);
  expect(weekly.complete).toBe(false);
  expect(weekly.errors).toEqual(data.warnings);
  expect(weekly.metadata?.coverage).toEqual(data.coverage);
  expect(weekly.sections[0]!.rows![0]!.atsSharePercent).toBe(25);
});
