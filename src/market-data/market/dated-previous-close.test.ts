import { expect, test } from "bun:test";
import { createTestQuote } from "../../test-support/data-provider";
import type { Quote } from "../../types/financials";
import { changeBasisLabel, quoteChangeBasis } from "./change-basis";
import { PreviousCloseDates, type DatedCloseListing } from "./dated-previous-close";

// Sat 24 Oct 2026.
const NOW = Date.parse("2026-10-24T10:00:00Z");

// SHEL.L and NESTE.HE as `quote` served them on Sat 24 Oct: Friday's move, from Thursday's close.
const friday = { changeSessionDate: "2026-10-23", marketState: "CLOSED" as const, lastUpdated: Date.parse("2026-10-23T15:39:00Z") };
const shell = createTestQuote({ symbol: "SHEL.L", currency: "GBP", listingExchangeName: "LSE", exchangeName: "LSE",
  price: 40.33, change: 1.445, changePercent: 3.72, previousClose: 38.885, ...friday });
const neste = createTestQuote({ symbol: "NESTE.HE", currency: "EUR", listingExchangeName: "HEL", exchangeName: "HEL",
  price: 31.28, change: 0.35, changePercent: 1.13, previousClose: 30.93, ...friday });
// 3042.HK on Tue 20 Oct: HKEX's calendar dates its move.
const hk = createTestQuote({ symbol: "3042.HK", currency: "HKD", listingExchangeName: "HKEX", exchangeName: "HKEX",
  price: 9.88, change: -0.06, changePercent: -0.6, previousClose: 9.94, changeSessionDate: "2026-10-20",
  marketState: "CLOSED", lastUpdated: Date.parse("2026-10-20T08:08:00Z") });

function dailyCloses(closes: Record<string, Record<string, number>>) {
  const asked: string[] = [];
  let clock = NOW;
  const dates = new PreviousCloseDates(async ({ symbol }: DatedCloseListing) => {
    asked.push(symbol);
    return Object.entries(closes[symbol] ?? {}).map(([date, close]) => ({ date: new Date(`${date}T00:00:00Z`), close }));
  }, () => clock);
  const label = (quote: Quote) => changeBasisLabel(quoteChangeBasis(quote)!, NOW);
  return { dates, asked, label, advance: (ms: number) => { clock += ms; } };
}

const listing = (quote: Quote): DatedCloseListing => ({ symbol: quote.symbol, exchange: "" });

test("a London or Helsinki move is dated by the listing's daily close that its previous close is, read once", async () => {
  const { dates, asked, label } = dailyCloses({
    "SHEL.L": { "2026-10-21": 39.09, "2026-10-22": 38.885, "2026-10-23": 40.33 },
    // History closes come as float32.
    "NESTE.HE": { "2026-10-22": 30.93000030517578, "2026-10-23": 31.280000686645508 },
  });
  expect(label(shell)).toBe("vs prev close");
  // Two copies asked for at once share one read.
  const [first, second] = await Promise.all([dates.date(shell, listing(shell)), dates.date(shell, listing(shell))]);
  expect([label(first), label(second)]).toEqual(["vs Thu 22 Oct close", "vs Thu 22 Oct close"]);
  expect(label(await dates.date(neste, listing(neste)))).toBe("vs Thu 22 Oct close");
  // A refresh, a tick or a cached copy of that quote is dated by what was read.
  const tick = { ...shell, price: 40.4, lastUpdated: shell.lastUpdated + 60_000 };
  expect(dates.known(tick, listing(tick)).previousCloseDate).toBe("2026-10-22");
  expect(label(await dates.date(tick, listing(tick)))).toBe("vs Thu 22 Oct close");
  expect(asked).toEqual(["SHEL.L", "NESTE.HE"]);
  // The next session's quote has another close to date, and is read for.
  const monday = { ...shell, changeSessionDate: "2026-10-26", previousClose: 40.33, lastUpdated: Date.parse("2026-10-26T15:35:00Z") };
  expect(dates.known(monday, listing(monday)).previousCloseDate).toBeUndefined();
  expect((await dates.date(monday, listing(monday))).previousCloseDate).toBe("2026-10-23");
  expect(asked).toEqual(["SHEL.L", "NESTE.HE", "SHEL.L"]);
});

test("a history whose latest close is not the previous close names no day, until it is read again later", async () => {
  const closes: Record<string, Record<string, number>> = { "SHEL.L": { "2026-10-20": 39, "2026-10-21": 39.09 } };
  const { dates, asked, label, advance } = dailyCloses(closes);
  expect(label(await dates.date(shell, listing(shell)))).toBe("vs prev close");
  expect(label(await dates.date(shell, listing(shell)))).toBe("vs prev close");
  expect(asked).toEqual(["SHEL.L"]);
  // Thursday's bar lands in the history; the reading is retried once it is old.
  closes["SHEL.L"]!["2026-10-22"] = 38.885;
  advance(11 * 60_000);
  expect(label(await dates.date(shell, listing(shell)))).toBe("vs Thu 22 Oct close");
  expect(asked).toEqual(["SHEL.L", "SHEL.L"]);
});

test("a quote its venue's calendar or its source dates asks for no history", async () => {
  const { dates, asked } = dailyCloses({});
  expect(await dates.date(hk, listing(hk))).toBe(hk);
  const sourceDated = { ...shell, previousCloseDate: "2026-10-22" };
  expect(await dates.date(sourceDated, listing(sourceDated))).toBe(sourceDated);
  expect(asked).toEqual([]);
});
