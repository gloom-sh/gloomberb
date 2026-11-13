import { expect, test } from "bun:test";
import { createTestCliContext } from "../test-support/cli-context";
import { createTestDataProvider, createTestFinancials, createTestQuote } from "../test-support/data-provider";
import type { EarningsEvent } from "../types/data-provider";
import { serializeCliResult } from "./result";
import { DEFAULT_CLI_OPTIONS } from "./options";
import { marketDataCliCommands } from "./commands/market";

const earnings = marketDataCliCommands.find((command) => command.name === "earnings")!;
const NOW = Date.now();
const day = (offset: number) => new Date(NOW + offset * 86_400_000);

const event = (symbol: string, name: string, offset: number, isDateEstimate: boolean | null): EarningsEvent => ({
  symbol, name, earningsDate: day(offset), isDateEstimate, epsEstimate: null, epsActual: null,
  revenueEstimate: null, revenueActual: null, surprise: null, timing: "",
});

// What search lists for each symbol, and the quote of each listing abroad.
const LISTINGS: Record<string, Array<[string, string]>> = {
  SAN: [["NYSE", "Banco Santander, S.A. Sponsored ADR"], ["MCE", "Banco Santander, S.A."], ["EPA", "Sanofi SA"]],
  BHP: [["NYSE", "BHP Group Limited"], ["ASX", "BHP Group Limited"]],
};
const QUOTES: Record<string, string> = { "SAN:MCE": "Banco Santander, S.A.", "SAN:EPA": "Sanofi", "BHP:ASX": "BHP Group Limited" };

/** A listing as the tables above key it, however its request names it (VOW3:XETRA, or VOW3 on XETRA). */
const keyOf = (symbol: string, exchange?: string) => symbol.includes(":") || !exchange ? symbol : `${symbol}:${exchange}`;

function harness(
  calendar: (symbols: string[]) => Promise<EarningsEvent[]>,
  reported: Record<string, string[]> = {},
  statements: Record<string, string[]> = {},
) {
  const asked: string[][] = [];
  const dataProvider = createTestDataProvider({
    // The quarters on record: each date a reported one, plus a fiscal period end that is no report.
    getCorporateActions: async (symbol, exchange) => ({ dividends: [], splits: [], earnings: [
      ...(reported[keyOf(symbol, exchange)] ?? []).map((date) => ({ date, dateType: "announcement" as const, epsActual: 1 })),
      { date: "2099-01-01", dateType: "announcement" as const, epsActual: 1 },
      { date: "2026-12-31", dateType: "fiscal-period-end" as const, epsActual: 1 },
    ] }),
    // The quarters a listing's statements end on.
    getTickerFinancials: async (symbol, exchange) => createTestFinancials({
      quarterlyStatements: (statements[keyOf(symbol, exchange)] ?? []).map((date) => ({ date })),
    }),
    search: async (query) => (LISTINGS[query] ?? []).map(([exchange, name]) => ({
      providerId: "test", symbol: query, name, exchange, type: "Common Stock", currency: "USD",
    })),
    getQuote: async (symbol, exchange) => {
      const name = QUOTES[symbol];
      if (!name) throw new Error(`no quote for ${symbol}`);
      return createTestQuote({ symbol, name, listingExchangeName: exchange, exchangeName: exchange });
    },
    getEarningsCalendar: async (symbols) => {
      asked.push(symbols);
      return calendar(symbols);
    },
  });
  const cli = createTestCliContext({ dataProvider });
  // The body, without the source line under it.
  const text = (index: number) => serializeCliResult(
    cli.printed[index]!.result, { ...DEFAULT_CLI_OPTIONS, color: false }, cli.printed[index]!.options,
  ).split("\n\n")[0];
  return { ...cli, asked, text };
}

test("a listing abroad shows its own date with its status, as asked for by its venue key", async () => {
  const run = harness(async (symbols) => symbols.includes("SAN:MCE") ? [event("SAN:MCE", "Banco Santander, S.A.", 17, false)] : []);
  await earnings.execute(["SAN:MCE"], run.context);
  expect(run.asked).toEqual([["SAN:MCE"]]);
  expect(run.text(0)).toMatch(/\d{4}-\d{2}-\d{2}\s+confirmed\s+SAN:MCE\s+Banco Santander/);
});

test("a listing abroad with no calendar says so, lending the date of the same company's US line as an estimate", async () => {
  const run = harness(async (symbols) => symbols.includes("BHP") ? [event("BHP", "BHP Group Limited", 120, false)] : []);
  await earnings.execute(["BHP:ASX"], run.context);
  expect(run.text(0)).toBe(`BHP:ASX: no next report date on record; ADR date ${day(120).toISOString().slice(0, 10)} (estimate)`);

  // SAN in New York is Banco Santander, so Sanofi's Paris line borrows nothing from it.
  const sanofi = harness(async (symbols) => symbols.includes("SAN") ? [event("SAN", "Banco Santander, S.A.", 24, true)] : []);
  await earnings.execute(["SAN:EPA"], sanofi.context);
  expect(sanofi.text(0)).toBe("SAN:EPA: no next report date on record. Headlines: gloom news SAN:EPA");
});

test("a calendar the source failed to answer says what failed, never a bare reason code", async () => {
  const run = harness(async () => { throw new Error("UPSTREAM_ERROR"); });
  await expect(earnings.execute(["SAN:MCE"], run.context))
    .rejects.toThrow("Earnings dates for SAN:MCE did not load: the calendar source failed. Try again in a few minutes.");
});

// `earnings NTR MOS ICL ADM BG LAND FPI` printed five rows and said nothing of BG and FPI; `earnings KO IBM` said
// "no earnings date found" for a company that had reported two weeks before; `earnings SIE:XETRA VOW3:XETRA` said
// "no calendar for this listing" for a company that reported a fortnight earlier.
test("a list names each listing the calendar came back without, with when it last reported, the quarter, and its headlines", async () => {
  const calendar = async () => [event("NTR", "Nutrien Ltd.", 5, false), event("MOS", "The Mosaic Company", 9, false)];
  const reported = { BG: ["2026-04-30", "2026-07-30"], "VOW3:XETRA": ["2026-10-29"] };
  const statements = { "VOW3:XETRA": ["2026-06-30", "2026-09-30", "2026-12-31"] };
  const run = harness(calendar, reported, statements);
  await earnings.execute(["NTR", "BG", "MOS", "FPI", "SAN:EPA", "VOW3:XETRA"], run.context);
  const lines = run.text(0)!.split("\n");
  expect(lines.slice(-4)).toEqual([
    "BG: no next report date on record; last reported 2026-07-30. Headlines: gloom news BG",
    "FPI: no next report date on record. Headlines: gloom news FPI",
    "SAN:EPA: no next report date on record. Headlines: gloom news SAN:EPA",
    "VOW3:XETRA: no next report date on record; last reported 2026-10-29 (quarter ended 2026-09-30). Headlines: gloom news VOW3:XETRA",
  ]);
  const json = harness(calendar, reported, statements);
  json.context.cliOptions.format = "json";
  await earnings.execute(["NTR", "BG", "MOS", "FPI"], json.context);
  expect(json.printed[0]!.result.warnings).toEqual(expect.arrayContaining([
    "BG: no next report date on record; last reported 2026-07-30. Headlines: gloom news BG",
  ]));
});
