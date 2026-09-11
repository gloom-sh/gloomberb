import { describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { createSectorsHeadless } from "./headless";
import { pricePointIntegrity } from "../../../utils/price-history-integrity";

function args(collection: string): HeadlessPaneLoadArgs {
  return { rawArgument: "", argument: null, symbols: [], options: { collection } };
}

describe("sectors headless model", () => {
  test("reports incomplete quotes even when historical returns remain available", async () => {
    const headless = createSectorsHeadless({
      load: async (_args, definitions) => definitions.map((definition) => ({
        etf: definition.etf,
        row: { price: null, changePercent: null, return1Y: 10, quoteUnavailable: true },
      })),
    });
    const result = await headless.load(args("sectors"), {} as HeadlessPaneContext);
    expect(result.unavailableSymbols).toContain("XLK");
    expect(result.rows.find((row) => row.etf === "XLK")?.return1Y).toBe(10);
  });

  test("changes the loaded ETF universe with the collection option", async () => {
    const requested: string[][] = [];
    const headless = createSectorsHeadless({
      load: async (_args, definitions) => {
        requested.push(definitions.map(({ etf }) => etf));
        return definitions.map((definition, index) => ({
          etf: definition.etf,
          row: { price: 100, changePercent: index, return1M: index + 1, return1Y: index + 2, currency: "USD" },
        }));
      },
    });

    const sectors = await headless.load(args("sectors"), {} as HeadlessPaneContext);
    const industries = await headless.load(args("industries"), {} as HeadlessPaneContext);
    expect(sectors.rows.some((row) => row.etf === "XLK")).toBe(true);
    expect(industries.rows.some((row) => row.etf === "SMH")).toBe(true);
    expect(requested[0]).not.toEqual(requested[1]);
  });
});


test("an available quote does not make an unavailable annual window complete", async () => {
  const headless = createSectorsHeadless({
    load: async (_args, definitions) => definitions.map((definition) => ({
      etf: definition.etf,
      row: { price: 100, changePercent: 1, return1M: 2, return1Y: null, quoteUnavailable: false, returnAsOfDate: "2026-09-10" },
    })),
  });
  const result = await headless.load(args("sectors"), {} as HeadlessPaneContext);
  expect(result.unavailableSymbols).toContain("XLK");
  expect(result.errors?.some((error) => error.startsWith("XLK:"))).toBe(true);
  expect(result.rows.find((row) => row.etf === "XLK")).toMatchObject({ price: 100, return1M: 2, return1Y: null });
});

test("exports stale quote dates and rejected endpoints with the matching reason", async () => {
  const integrity = pricePointIntegrity({ date: new Date("2025-09-10"), open: 80, high: 79, low: 78, close: 80 })!;
  const headless = createSectorsHeadless({
    load: async (_args, definitions) => definitions.map((definition) => ({ etf: definition.etf, row: {
      price: null, lastReportedPrice: 117, quoteSessionDate: "2026-09-09", quoteIssue: "stale quote from 2026-09-09",
      quoteUnavailable: true, changePercent: null, return1M: 2, return1Y: null, returnIntegrity: { "1Y": integrity },
    } })),
  });
  const result = await headless.load(args("sectors"), {} as HeadlessPaneContext);
  expect(result.unavailableSymbols).toContain("XLK");
  expect(result.errors).toContain("XLK: stale quote from 2026-09-09.");
  expect(result.errors).toContain("XLK: 1Y: inconsistent OHLC at return endpoint.");
  expect(result.errors?.some((error) => error.includes("history does not cover"))).toBe(false);
  expect(result.rows.find((row) => row.etf === "XLK")).toMatchObject({ lastReportedPrice: 117,
    quoteSessionDate: "2026-09-09", returnIntegrity: { "1Y": integrity } });
});
