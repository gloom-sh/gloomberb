import { expect, test } from "bun:test";
import { createTestCliContext } from "../test-support/cli-context";
import { createTestDataProvider, createTestQuote } from "../test-support/data-provider";
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

function harness(calendar: (symbols: string[]) => Promise<EarningsEvent[]>) {
  const asked: string[][] = [];
  const dataProvider = createTestDataProvider({
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
  expect(run.text(0)).toBe(`BHP:ASX: no calendar for this listing; ADR date ${day(120).toISOString().slice(0, 10)} (estimate)`);

  // SAN in New York is Banco Santander, so Sanofi's Paris line borrows nothing from it.
  const sanofi = harness(async (symbols) => symbols.includes("SAN") ? [event("SAN", "Banco Santander, S.A.", 24, true)] : []);
  await earnings.execute(["SAN:EPA"], sanofi.context);
  expect(sanofi.text(0)).toBe("SAN:EPA: no calendar for this listing");
});

test("a calendar the source failed to answer says what failed, never a bare reason code", async () => {
  const run = harness(async () => { throw new Error("UPSTREAM_ERROR"); });
  await expect(earnings.execute(["SAN:MCE"], run.context))
    .rejects.toThrow("Earnings dates for SAN:MCE did not load: the calendar source failed. Try again in a few minutes.");
});
