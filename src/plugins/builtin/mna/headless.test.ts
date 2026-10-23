import { expect, test } from "bun:test";
import type { MnaDealsParams, MnaDealsPayload } from "../../../api-client/mna";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import type { HeadlessPaneContext, HeadlessPaneOptionValues } from "../../../types/headless";
import { mnaHeadless } from "./headless";

const payload: MnaDealsPayload = {
  deals: [{
    id: "ath",
    target: { name: "Athabasca Oil Corporation", symbol: "ATH.TO", country: "CA" },
    acquirer: { name: "Cenovus Energy Inc.", symbol: "CVE.TO", country: "CA" },
    status: "pending",
    stage: null,
    hostile: false,
    terms: { consideration: "mixed", cashPerShare: 12, exchangeRatio: 0.264, ratioSymbol: "CVE.TO", currency: "CAD", cvr: false, partial: false, election: true },
    value: 4.1e9,
    valueCurrency: "CAD",
    valueUsd: 3e9,
    announced: "2026-09-10",
    expectedClose: "2026-12-31",
    closed: null,
    headline: "Cenovus to buy Athabasca Oil",
    updatedAt: "2026-09-17T00:00:00Z",
    lastReported: "2026-09-17",
    stale: false,
  }],
  hasMore: false,
  nextOffset: 1,
  access: "full",
  delayDays: 0,
  lockedDeals: 0,
  asOf: "2026-09-27T12:00:00Z",
};

async function load(symbol: string | null, options: HeadlessPaneOptionValues = {}) {
  const requests: MnaDealsParams[] = [];
  const ctx = createTestHeadlessContext({
    apiClient: { getCloudMnaDeals: async (params: MnaDealsParams) => { requests.push(params); return payload; } } as unknown as HeadlessPaneContext["apiClient"],
  });
  const result = await mnaHeadless.load(createTestHeadlessArgs({ rawArgument: symbol ?? "", argument: symbol, symbols: symbol ? [symbol] : [], options }), ctx);
  return { result, request: requests[0]! };
}

test("a listing abroad asks for deals by the symbol they are filed under, with no name search beside it", async () => {
  // `fn MA ATH.TO` reaches the function as the listing its quote names.
  const { result, request } = await load("ATH:TSX");
  expect(request).toMatchObject({ symbol: "ATH.TO", status: "all" });
  expect(request.query).toBeUndefined();
  expect(result.rows.map((row) => row.targetSymbol)).toEqual(["ATH.TO"]);
  expect(result.metadata?.notices).toBeUndefined();
  expect((await load("CVE:TSX")).request.symbol).toBe("CVE.TO");
});

test("a US ticker, with or without its venue, and the market's deals ask as before", async () => {
  expect((await load("ACVA")).request).toMatchObject({ symbol: "ACVA", status: "all" });
  expect((await load("ACVA:NASDAQ")).request.symbol).toBe("ACVA");
  const market = (await load(null, { target: "public" })).request;
  expect(market).toMatchObject({ status: "pending", target: "public" });
  expect(market.symbol).toBeUndefined();
});
