import { describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { createCdsHeadless } from "./headless";
import type { CdsActivity } from "./client";

const activity: CdsActivity = {
  source: "DTCC",
  asOf: "2026-09-04T12:00:00Z",
  issuer: "Oracle Corporation",
  trades: [{
    id: "1", issuer: "Oracle Corporation", issuerKey: "oracle", eventAt: 100,
    maturity: "2031-06-20", notional: 5_000_000, notionalCapped: false,
    currency: "USD", couponBp: 100, spreadBp: 45, upfront: null, upfrontCurrency: null,
  }],
};

function args(argument: string | null): HeadlessPaneLoadArgs {
  return { rawArgument: argument ?? "", argument, symbols: argument ? [argument] : [], options: {} };
}

describe("CDS headless model", () => {
  test("switches from issuer summaries to trade rows for a ticker argument", async () => {
    const headless = createCdsHeadless({ load: async () => activity });
    const market = await headless.load(args(null), {} as HeadlessPaneContext);
    const ticker = await headless.load(args("ORCL"), {} as HeadlessPaneContext);

    expect(market.rows).toEqual([expect.objectContaining({ issuer: "Oracle Corporation", trades: 1 })]);
    expect(ticker.rows).toEqual([expect.objectContaining({ id: "1", spreadBp: 45 })]);
  });
});
