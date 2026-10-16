import { describe, expect, test } from "bun:test";
import type { JodiBoardPayload } from "../../../api-client/commodity-balances";
import { ApiRequestError } from "../../../api-client/errors";
import { fetchBalances, JODI_NOT_AVAILABLE } from "./client";

const row = (country: string, month: string | null, production: number | null) => ({
  country, month, production, demand: null, imports: null, exports: null, stocks: null, unit: "kb/d, kbbl",
});
const payload = (overrides: Partial<JodiBoardPayload> = {}): JodiBoardPayload => ({
  source: "JODI",
  status: "partial",
  checkedAt: "2026-10-16T06:00:00.000Z",
  stale: false,
  gaps: [],
  oil: { month: "2026-07", commodity: "oil", rows: [row("United States", "2026-07", 13817.4), row("India", "2026-03", 556.1)] },
  gas: null,
  ...overrides,
});
const serving = (answer: () => Promise<JodiBoardPayload>) => ({ getCloudJodiBoard: answer });

describe("oil and gas balances from Gloom Cloud", () => {
  test("keeps each country's own month and passes the server's staleness on", async () => {
    const balances = await fetchBalances(undefined, serving(async () => payload({
      stale: true,
      gaps: ["Crude oil balances have not refreshed since 11 Oct 2026."],
    })));
    expect(balances.oil.rows.map((entry) => [entry.country, entry.month])).toEqual([["United States", "2026-07"], ["India", "2026-03"]]);
    expect(balances).toMatchObject({ gas: null, stale: true, gaps: ["Crude oil balances have not refreshed since 11 Oct 2026."] });
  });

  test("a server without the board yet says so; a broken board is refused whole", async () => {
    const missing = new ApiRequestError("Not found", 404);
    await expect(fetchBalances(undefined, serving(async () => { throw missing; }))).rejects.toThrow(JODI_NOT_AVAILABLE);
    await expect(fetchBalances(undefined, serving(async () => payload({ status: "unavailable", oil: null }))))
      .rejects.toThrow(JODI_NOT_AVAILABLE);
    const broken = payload();
    broken.oil!.rows[1] = { ...row("India", "March", 1) };
    await expect(fetchBalances(undefined, serving(async () => broken))).rejects.toThrow("invalid oil and gas balance board");
  });
});
