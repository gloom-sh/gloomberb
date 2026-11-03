import { expect, setSystemTime, test } from "bun:test";
import { createTestCliContext } from "../../test-support/cli-context";
import { createTestQuote } from "../../test-support/data-provider";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { serializeCliResult } from "../result";
import { marketDataCliCommands } from "./market";

test("quote keeps a board coin's 24h marker at narrow widths and suppresses a move whose basis is none", async () => {
  const coin = { instrumentType: "CRYPTOCURRENCY", marketState: "REGULAR", listingExchangeName: "CCC", exchangeName: "CCC" } as const;
  const quotes = [
    createTestQuote({ ...coin, symbol: "TON-USD", name: "Toncoin", price: 1.3256, change: -0.0177, changePercent: -1.32, changeBasis: "24h" }),
    // A stale numeric move must not override the explicit absence of a comparison.
    createTestQuote({ ...coin, symbol: "VBNB-USD", name: "Venus BNB", price: 18.477, change: 1.677, changePercent: 9.99, changeBasis: "none" }),
    createTestQuote({ ...coin, symbol: "BTC-USD", name: "Bitcoin", price: 100000, change: 1000, changePercent: 1.01, previousClose: 99000 }),
  ];
  const cli = createTestCliContext({ dataProvider: {
    getQuotesBatch: async () => quotes.map((quote) => ({ target: { symbol: quote.symbol, exchange: "" }, quote })),
  } });
  await marketDataCliCommands.find((command) => command.name === "quote")!.execute(quotes.map((quote) => quote.symbol), cli.context);
  const { result, options } = cli.printed[0]!;
  for (const width of [undefined, 40]) {
    const text = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, width }, options);
    expect(text).toContain("-1.32% 24h");
    expect(text.match(/24h/g)).toHaveLength(1);
    expect(text).not.toContain("9.99%");
    expect(text).not.toContain("none");
    if (width == null) expect(text).toContain("since 00:00 UTC");
  }
  const rows = options!.rows!(result.data) as Array<Record<string, unknown>>;
  expect(rows.map(({ change, changePercent, changeBasis }) => ({ change, changePercent, changeBasis }))).toEqual([
    { change: -0.0177, changePercent: -1.32, changeBasis: "24h" },
    { change: null, changePercent: null, changeBasis: "" },
    { change: 1000, changePercent: 1.01, changeBasis: "since 00:00 UTC" },
  ]);
  expect(result.data[1]).toMatchObject({ change: null, changePercent: null, changeBasis: null, quote: { change: 1.677, changePercent: 9.99, changeBasis: "none" } });
  const csv = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options);
  expect(csv).toContain(",-1.32,");
  expect(csv).toContain(",24h,");
  expect(csv).not.toContain("9.99");
});

/**
 * During an outage on 3 Nov 2026, USD1-USD's last print was from 29 Oct, and `quote` still printed
 * "0.00% since 00:00 UTC" and OPEN for it, a move and a session that are not its own.
 */
test("a coin whose last print is before today's 00:00 UTC has no move and no session, and says why in an export", async () => {
  const now = Date.parse("2026-11-03T22:00:00Z");
  const coin = { instrumentType: "CRYPTOCURRENCY", marketState: "REGULAR", listingExchangeName: "CCC", exchangeName: "CCC" } as const;
  const quotes = [
    createTestQuote({ ...coin, symbol: "USD1-USD", name: "World Liberty Financial USD", price: 0.999, change: 0, changePercent: 0, previousClose: 0.999,
      lastUpdated: Date.parse("2026-10-29T00:02:00Z") }),
    createTestQuote({ ...coin, symbol: "USDT-USD", name: "Tether USDt", price: 0.9989, change: 0.0006, changePercent: 0.06, previousClose: 0.9983,
      lastUpdated: Date.parse("2026-11-03T21:46:00Z") }),
  ];
  const cli = createTestCliContext({ dataProvider: {
    getQuotesBatch: async () => quotes.map((quote) => ({ target: { symbol: quote.symbol, exchange: "" }, quote })),
  } });
  setSystemTime(new Date(now));
  try {
    await marketDataCliCommands.find((command) => command.name === "quote")!.execute(quotes.map((quote) => quote.symbol), cli.context);
    const { result, options } = cli.printed[0]!;
    const rows = options!.rows!(result.data) as Array<Record<string, unknown>>;
    expect(rows.map(({ changePercent, changeBasis, sessionLabel }) => ({ changePercent, changeBasis, sessionLabel }))).toEqual([
      { changePercent: null, changeBasis: "", sessionLabel: "" },
      { changePercent: 0.06, changeBasis: "since 00:00 UTC", sessionLabel: "OPEN" },
    ]);
    const text = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, width: 200 }, options);
    const stale = text.split("\n").find((line) => line.startsWith("USD1-USD"))!;
    expect(stale).not.toMatch(/0\.00%|since 00:00 UTC|OPEN/);
    expect(stale.match(/—/g)).toHaveLength(2);
    const csv = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options);
    expect(csv).toContain("Chg%: last print before 00:00 UTC");
  } finally {
    setSystemTime();
  }
});
