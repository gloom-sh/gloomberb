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
  }, { now: () => clock });
  const label = (quote: Quote) => changeBasisLabel(quoteChangeBasis(quote)!, NOW);
  // Reads the closes for a quote, waiting as long as they take, and answers it dated by them.
  const date = async (quote: Quote) => {
    await dates.settle([{ quote, listing: listing(quote) }], { waitMs: 5_000 });
    return dates.known(quote, listing(quote));
  };
  return { dates, asked, label, date, advance: (ms: number) => { clock += ms; } };
}

const listing = (quote: Quote): DatedCloseListing => ({ symbol: quote.symbol, exchange: "" });
const entry = (quote: Quote) => ({ quote, listing: listing(quote) });

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !check(); attempt += 1) await Bun.sleep(5);
}

test("a London or Helsinki move is dated by the listing's daily close that its previous close is, read once", async () => {
  const { dates, asked, label, date } = dailyCloses({
    "SHEL.L": { "2026-10-21": 39.09, "2026-10-22": 38.885, "2026-10-23": 40.33 },
    // History closes come as float32.
    "NESTE.HE": { "2026-10-22": 30.93000030517578, "2026-10-23": 31.280000686645508 },
  });
  expect(label(shell)).toBe("vs prev close");
  // Two requests at once share one read.
  await Promise.all([dates.settle([entry(shell)], { waitMs: 5_000 }), dates.settle([entry(shell), entry(neste)], { waitMs: 5_000 })]);
  expect(label(dates.known(shell, listing(shell)))).toBe("vs Thu 22 Oct close");
  expect(label(dates.known(neste, listing(neste)))).toBe("vs Thu 22 Oct close");
  // A refresh, a tick or a cached copy of that quote is dated by what was read.
  const tick = { ...shell, price: 40.4, lastUpdated: shell.lastUpdated + 60_000 };
  expect(dates.observe(tick, listing(tick)).previousCloseDate).toBe("2026-10-22");
  expect(label(await date(tick))).toBe("vs Thu 22 Oct close");
  expect(asked).toEqual(["SHEL.L", "NESTE.HE"]);
  // The next session's quote has another close to date, and is read for.
  const monday = { ...shell, changeSessionDate: "2026-10-26", previousClose: 40.33, lastUpdated: Date.parse("2026-10-26T15:35:00Z") };
  expect(dates.known(monday, listing(monday)).previousCloseDate).toBeUndefined();
  expect((await date(monday)).previousCloseDate).toBe("2026-10-23");
  expect(asked).toEqual(["SHEL.L", "NESTE.HE", "SHEL.L"]);
});

test("a history whose latest close is not the previous close names no day, until it is read again later", async () => {
  const closes: Record<string, Record<string, number>> = { "SHEL.L": { "2026-10-20": 39, "2026-10-21": 39.09 } };
  const { asked, label, date, advance } = dailyCloses(closes);
  expect(label(await date(shell))).toBe("vs prev close");
  expect(label(await date(shell))).toBe("vs prev close");
  expect(asked).toEqual(["SHEL.L"]);
  // Thursday's bar lands in the history; the reading is retried once it is old.
  closes["SHEL.L"]!["2026-10-22"] = 38.885;
  advance(11 * 60_000);
  expect(label(await date(shell))).toBe("vs Thu 22 Oct close");
  expect(asked).toEqual(["SHEL.L", "SHEL.L"]);
});

test("a quote its venue's calendar or its source dates asks for no history", async () => {
  const { dates, asked } = dailyCloses({});
  expect(dates.observe(hk, listing(hk))).toBe(hk);
  const sourceDated = { ...shell, previousCloseDate: "2026-10-22" };
  expect(dates.observe(sourceDated, listing(sourceDated))).toBe(sourceDated);
  await dates.settle([entry(hk), entry(sourceDated)], { waitMs: 5_000 });
  expect(asked).toEqual([]);
});

test("a tick is never held for the read: the read dates the ticks after it and passes the latest one on", async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const passedOn: Quote[] = [];
  const dates = new PreviousCloseDates(async () => {
    await released;
    return [{ date: new Date("2026-10-22T00:00:00Z"), close: 38.885 }];
  }, { now: () => NOW, onDated: (_listing, quote) => passedOn.push(quote) });
  expect(dates.observe(shell, listing(shell))).toBe(shell);
  const later = { ...shell, price: 40.4, lastUpdated: shell.lastUpdated + 60_000 };
  expect(dates.observe(later, listing(later))).toBe(later);
  release();
  await eventually(() => passedOn.length > 0);
  expect(passedOn).toEqual([{ ...later, previousCloseDate: "2026-10-22" }]);
  expect(dates.observe(shell, listing(shell)).previousCloseDate).toBe("2026-10-22");
});

test("a few reads run at once and the rest queue; a hung read gives its slot up at the deadline", async () => {
  const asked: string[] = [];
  const dates = new PreviousCloseDates(async ({ symbol }) => {
    asked.push(symbol);
    // The first two never answer.
    if (symbol.startsWith("HUNG")) return new Promise<never>(() => {});
    return [{ date: new Date("2026-10-22T00:00:00Z"), close: 38.885 }];
  }, { now: () => NOW, maxReadsInFlight: 2, readDeadlineMs: 50 });
  const quotes = ["HUNG1.L", "HUNG2.L", "BP.L", "VOD.L"].map((symbol) => ({ ...shell, symbol }));
  for (const quote of quotes) dates.observe(quote, listing(quote));
  await Bun.sleep(0);
  expect(asked).toEqual(["HUNG1.L", "HUNG2.L"]);
  // The queued reads run once the hung ones time out, and date their quotes.
  await dates.settle(quotes.slice(2).map(entry), { waitMs: 5_000 });
  expect(asked).toEqual(["HUNG1.L", "HUNG2.L", "BP.L", "VOD.L"]);
  expect(quotes.map((quote) => dates.known(quote, listing(quote)).previousCloseDate ?? null))
    .toEqual([null, null, "2026-10-22", "2026-10-22"]);
});

test("waiting for the closes stops at its limit or when the caller stops waiting", async () => {
  const dates = new PreviousCloseDates(() => new Promise<never>(() => {}), { now: () => NOW });
  const started = performance.now();
  await dates.settle([entry(shell)], { waitMs: 30 });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  await dates.settle([entry(neste)], { waitMs: 60_000, signal: controller.signal });
  expect(performance.now() - started).toBeLessThan(5_000);
  expect(dates.known(shell, listing(shell))).toBe(shell);
});
