import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createTestCliContext } from "../../test-support/cli-context";
import { createTestQuote } from "../../test-support/data-provider";
import { setCliColorEnabledOverride, setCliPlainOverride, setCliWidthOverride, visibleLength } from "../../utils/cli-output";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { serializeCliResult } from "../result";
import { marketDataCliCommands } from "./market";

afterEach(() => {
  setSystemTime();
  setCliWidthOverride(null);
  setCliPlainOverride(null);
  setCliColorEnabledOverride(null);
});

test("quote at 80 and 100 columns drops no column: Chg Basis, Cur, Feed and Updated move to labelled lines under their row", async () => {
  // Midday in New York: after the close the feed reads stale.
  setSystemTime(new Date("2026-10-22T16:00:00Z"));
  const listed = { marketState: "REGULAR", listingExchangeName: "NYSE", exchangeName: "NYSE", dataSource: "delayed", previousClose: 25.62 } as const;
  const quotes = [
    createTestQuote({ ...listed, symbol: "PBR", name: "Petroleo Brasileiro S.A. Petrobras ADR", price: 26.03, change: 0.41, changePercent: 1.58 }),
    createTestQuote({ ...listed, symbol: "VALE", name: "VALE S.A. ADR", price: 12.24, change: 0.04, changePercent: 0.33 }),
  ];
  const cli = createTestCliContext({ dataProvider: {
    getQuotesBatch: async () => quotes.map((quote) => ({ target: { symbol: quote.symbol, exchange: "" }, quote })),
  } });
  await marketDataCliCommands.find((command) => command.name === "quote")!.execute(["PBR", "VALE"], cli.context);
  const { result, options } = cli.printed[0]!;
  setCliColorEnabledOverride(false);
  for (const plain of [false, true]) {
    setCliPlainOverride(plain);
    for (const width of [80, 100]) {
      setCliWidthOverride(width);
      const lines = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, width }, options).split("\n");
      const text = lines.join("\n");
      expect(lines.every((line) => visibleLength(line) <= width)).toBe(true);
      // Each fact is in the table under its header or on a line under its row after it.
      for (const header of ["Symbol", "Name", "Last", "Chg%", "Chg Basis", "Session", "Cur", "Feed", "Updated"]) expect(text).toContain(header);
      expect(text.match(/USD/g)).toHaveLength(2);
      expect(text.match(/delayed/g)!.length).toBeGreaterThanOrEqual(2);
      expect(text.match(/vs \w{3} \d{1,2} \w{3} close/g)).toHaveLength(2);
      // The name stays whole, wrapped in its cell at most.
      expect(text).toMatch(/Petroleo Brasileiro(?: S\.A\.)?\s/);
      expect(text).toMatch(/(?:S\.A\. )?Petrobras ADR/);
    }
  }
});
