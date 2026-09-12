import { describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import type { DividendData } from "./client";
import { createDividendYieldHeadless } from "./headless";
import { renderHeadlessPaneText, serializeHeadlessPaneResult } from "../../../cli/pane-functions/headless";
import { serializeCliResult } from "../../../cli/result";
import { DEFAULT_CLI_OPTIONS } from "../../../cli/options";

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
        { label: "Trailing yield", value: 0.005, formatted: "0.50%" },
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


test("cash growth and payout text use percentages while JSON and CSV keep fractional values", async () => {
  for (const [growth, formatted] of [[-0.152317880794702, "-15.23%"], [0.11248149975332988, "+11.25%"], [0, "0.00%"], [null, "—"]] as const) {
    const data = { ...fixture, metrics: { ...fixture.metrics, payoutRatio: growth, growth1Y: growth, growth3Y: growth } };
    const definition = createDividendYieldHeadless({ loadData: async () => data });
    const request = args({ type: "all", limit: 40 });
    const result = await definition.load(request, context);
    const text = renderHeadlessPaneText(definition, result, request, "DVD");
    const section = result.sections[0]!;
    const entries = "entries" in section ? section.entries : [];
    expect(entries.filter((entry) => entry.label === "1Y Cash Growth" || entry.label === "3Y Cash CAGR")).toEqual([
      { label: "1Y Cash Growth", value: growth, formatted },
      { label: "3Y Cash CAGR", value: growth, formatted },
    ]);
    expect(text).toContain("1Y Cash Growth");
    expect(text).toContain("3Y Cash CAGR");
    expect(text).toContain(formatted);
    // Controlled provider ratio contract; these finite values are not asserted to be live ETF payouts.
    expect(entries.find((entry) => entry.label === "Earnings Payout")).toEqual({ label: "Earnings Payout", value: growth, formatted: formatted.replace(/^\+/, "") });
    const serialized = serializeHeadlessPaneResult(definition, result);
    const json = JSON.parse(serializeCliResult({ data: serialized }, { ...DEFAULT_CLI_OPTIONS, format: "json" }));
    const raw = json.data.sections[0].entries.filter((entry: { label: string }) => ["Earnings Payout", "1Y Cash Growth", "3Y Cash CAGR"].includes(entry.label));
    expect(raw.map((entry: { value: unknown }) => entry.value)).toEqual([growth, growth, growth]);
    // fn CSV retains nested sections as JSON cells; display strings cannot replace numeric values.
    const csv = serializeCliResult({ data: serialized }, { ...DEFAULT_CLI_OPTIONS, format: "csv" });
    expect(csv).toContain(`""label"":""1Y Cash Growth"",""value"":${JSON.stringify(growth)},""formatted"":""${formatted}""`);
    expect(csv).toContain(`""label"":""Earnings Payout"",""value"":${JSON.stringify(growth)}`);
    expect(data.metrics.growth1Y).toBe(growth);
  }
});
