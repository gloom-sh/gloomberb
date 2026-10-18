import { expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import type { Quote } from "../../types/financials";
import { createTestCliContext } from "../../test-support/cli-context";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { serializeCliResult } from "../result";
import { marketDataCliCommands } from "./market";

const base = { currency: "USD", lastUpdated: 1_789_200_000_000, instrumentType: "INDEX" } satisfies Partial<Quote>;
const yields: Quote[] = [
  { ...base, symbol: "^TNX", price: 5.244, change: 0.013, changePercent: 0.2485 },
  { ...base, symbol: "^IRX", price: 4.057, change: -0.014, changePercent: -0.3438 },
] as Quote[];
const stock = { ...base, symbol: "AAPL", instrumentType: "EQUITY", price: 336.64, change: -3.78, changePercent: -1.11 } as Quote;

async function quote(quotes: Quote[], command = "quote") {
  const cli = createTestCliContext({ config: createDefaultConfig("/tmp/gloom-quote-yield-test"), dataProvider: {
    getQuotesBatch: async () => quotes.map((entry) => ({ target: { symbol: entry.symbol, exchange: "" }, quote: entry })),
  } });
  await marketDataCliCommands.find((entry) => entry.name === command)!.execute(quotes.map((entry) => entry.symbol), cli.context);
  const { result, options } = cli.printed[0]!;
  return { result, options, text: serializeCliResult({ ...result, freshness: undefined }, DEFAULT_CLI_OPTIONS, options) };
}

test("a Cboe yield index is a yield in percent moving in basis points from its real previous close", async () => {
  const { text, result, options } = await quote(yields);
  const lines = text.split("\n");
  expect(lines[0]).toContain(" Chg ");
  expect(lines[0]).not.toContain("Chg%");
  expect(lines.find((line) => line.startsWith("^TNX"))).toMatch(/ 5\.24% +\+1\.3bp /);
  expect(lines.find((line) => line.startsWith("^IRX"))).toMatch(/ 4\.06% +-1\.4bp /);
  // JSON adds the unit and the move in bp; the quote and its percent change are as they were.
  expect(result.data).toMatchObject([
    { unit: "percent", changeBasisPoints: 1.3, changePercent: 0.2485 },
    { unit: "percent", changeBasisPoints: -1.4 },
  ]);
  // CSV keeps the numbers it held: the level and the percent change.
  const rows = options!.rows!(result.data) as Array<Record<string, unknown>>;
  expect(rows.map((row) => [row.price, row.changePercent])).toEqual([["5.24", 0.25], ["4.06", -0.34]]);
});

// The quote's own currency stays in --json; a level's CSV row names its unit, and a 0 volume nobody counts is blank.
test("an index exports no currency: CSV names points or pct, and JSON keeps the quote as sent", async () => {
  const vix = { ...base, symbol: "^VIX", price: 19.99, change: 3.53, changePercent: 21.45, volume: 0 } as Quote;
  for (const command of ["quote", "compare"]) {
    const { result, options } = await quote([vix, yields[0]!, { ...stock, volume: 1000 }], command);
    const csv = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options).split("\n");
    const header = csv[0]!.split(",");
    const cell = (symbol: string, column: string) => csv.find((line) => line.startsWith(symbol))!.split(",")[header.indexOf(column)];
    expect([cell("^VIX", "Cur"), cell("^VIX", "currency_or_unit")]).toEqual(["", "index points"]);
    expect(cell("^TNX", "currency_or_unit")).toBe("pct");
    expect([cell("AAPL", "Cur"), cell("AAPL", "currency_or_unit")]).toEqual(["USD", "USD"]);
    if (command === "compare") expect([cell("^VIX", "Volume"), cell("AAPL", "Volume")]).toEqual(["", "1000"]);
    expect((result.data as Array<{ quote: Quote }>)[0]!.quote).toMatchObject({ currency: "USD", volume: 0 });
  }
});

test("beside other symbols the yield rows keep their own units and the header stays Chg%", async () => {
  const { text, result } = await quote([yields[0]!, stock]);
  const lines = text.split("\n");
  expect(lines[0]).toContain("Chg%");
  expect(lines.find((line) => line.startsWith("^TNX"))).toMatch(/ 5\.24% +\+1\.3bp /);
  expect(lines.find((line) => line.startsWith("AAPL"))).toMatch(/ \$336\.64 +-1\.11% /);
  expect(result.data[1]).not.toHaveProperty("unit");
  const compared = await quote([yields[0]!], "compare");
  expect(compared.text.split("\n").find((line) => line.startsWith("^TNX"))).toMatch(/ 5\.24% +\+1\.3bp .* 5\.23%( |$)/);
});
