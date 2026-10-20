import { expect, test } from "bun:test";
import type { CloudPricePointPayload } from "../api-client/types";
import { CostFxError, loadCostFxRate, type CostFxHistoryClient } from "./cost-fx";

/** Daily closes by pair symbol, served for whatever window is asked; the asked windows are kept. */
function historyClient(closes: Record<string, Record<string, number>>) {
  const asked: { symbol: string; startDate?: string; endDate?: string }[] = [];
  const client: CostFxHistoryClient = {
    getCloudHistory: async (symbol, _exchange, params) => {
      asked.push({ symbol, startDate: params.startDate, endDate: params.endDate });
      const data: CloudPricePointPayload[] = Object.entries(closes[symbol] ?? {})
        .filter(([day]) => (!params.startDate || day >= params.startDate) && (!params.endDate || day <= params.endDate))
        .map(([day, close]) => ({ date: `${day}T00:00:00.000Z`, close }));
      return { status: "success", data } as Awaited<ReturnType<CostFxHistoryClient["getCloudHistory"]>>;
    },
  };
  return { client, asked };
}

const now = new Date("2026-10-19T12:00:00Z");

test("a purchase date reads each pair's last close on or before it, crossed through USD", async () => {
  const { client, asked } = historyClient({
    // USD/TRY quotes TRY per USD and inverts; EUR/USD quotes USD per EUR.
    "TRY=X": { "2024-02-29": 31.2337, "2024-03-01": 31.3694, "2024-03-04": 31.6 },
    "EURUSD=X": { "2024-02-29": 1.0802, "2024-03-01": 1.0842 },
  });
  // A Saturday purchase takes Friday's close.
  expect(await loadCostFxRate("USD", "TRY", "2024-03-02", client, now)).toEqual({ rate: expect.closeTo(31.3694, 9), date: "2024-03-01" });
  expect(asked[0]).toEqual({ symbol: "TRY=X", startDate: "2024-02-24", endDate: "2024-03-03" });
  const euroLira = await loadCostFxRate("EUR", "TRY", "2024-03-01", client, now);
  expect(euroLira.rate).toBeCloseTo(1.0842 * 31.3694, 9);
  // Into USD is the inverse leg alone.
  expect((await loadCostFxRate("TRY", "USD", "2024-02-29", client, now)).rate).toBeCloseTo(1 / 31.2337, 12);
});

test("a gap longer than a week, a pair that is not served, and today's unfinished bar never give a rate", async () => {
  const { client } = historyClient({ "TRY=X": { "2024-02-01": 30.2, "2026-10-19": 49.5 } });
  await expect(loadCostFxRate("USD", "TRY", "2024-03-01", client, now)).rejects.toThrow(new CostFxError("No TRY FX close in the week up to 2024-03-01"));
  await expect(loadCostFxRate("USD", "TRY", "2026-10-19", client, now)).rejects.toBeInstanceOf(CostFxError);
  await expect(loadCostFxRate("USD", "XOF", "2024-03-01", client, now)).rejects.toThrow("No daily FX history is served for XOF");
});
