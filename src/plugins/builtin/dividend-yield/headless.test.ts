import { describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import type { DividendData } from "./client";
import { createDividendYieldHeadless } from "./headless";

const fixture: DividendData = {
  price: 200,
  metrics: {
    trailingYield: 0.005,
    forwardYield: 0.0052,
    trailingRate: 1,
    forwardRate: 1.04,
    payoutRatio: 0.14,
    growth1Y: 0.04,
    growth3Y: 0.03,
    paymentFrequency: "quarterly",
    exDividendDate: new Date("2026-08-10T00:00:00.000Z"),
    nextPayDate: new Date("2026-08-17T00:00:00.000Z"),
  },
  payments: [
    {
      exDate: new Date("2026-08-10T00:00:00.000Z"),
      recordDate: null,
      paymentDate: null,
      declarationDate: null,
      amount: 0.26,
      currency: "USD",
      type: "cash",
    },
    {
      exDate: new Date("2026-05-11T00:00:00.000Z"),
      recordDate: null,
      paymentDate: null,
      declarationDate: null,
      amount: 0.24,
      currency: "USD",
      type: "special",
    },
  ],
};

function args(options: Record<string, string | number | boolean>): HeadlessPaneLoadArgs {
  return {
    rawArgument: "AAPL",
    argument: "AAPL",
    symbols: ["AAPL"],
    options,
  };
}

const context = {} as HeadlessPaneContext;

describe("dividend yield headless", () => {
  test("maps metrics and payment rows", async () => {
    const definition = createDividendYieldHeadless({
      loadData: async () => fixture,
    });

    const result = await definition.load(args({ type: "all", limit: 40 }), context);

    expect(result.sections[0]).toMatchObject({
      title: "Dividend metrics",
      entries: expect.arrayContaining([
        { label: "Trailing yield", value: 0.005 },
        { label: "Frequency", value: "quarterly" },
      ]),
    });
    expect(result.sections[1]).toMatchObject({
      title: "Dividend history",
      rows: [
        expect.objectContaining({ exDate: "2026-08-10", amount: 0.26, type: "cash" }),
        expect.objectContaining({ exDate: "2026-05-11", amount: 0.24, type: "special" }),
      ],
    });
  });

  test("applies type and limit options", async () => {
    const definition = createDividendYieldHeadless({ loadData: async () => fixture });

    const result = await definition.load(args({ type: "cash", limit: 1 }), context);
    const history = result.sections[1];

    expect(history).toMatchObject({
      rows: [expect.objectContaining({ type: "cash" })],
    });
    expect(result.metadata).toMatchObject({ totalPayments: 1, returnedPayments: 1 });
  });
});
