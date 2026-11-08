import { expect, test } from "bun:test";
import { createTestQuote } from "../../test-support/data-provider";
import type { Quote } from "../../types/financials";
import { changeBasisLabel, quoteChangeBasis } from "./change-basis";
import { PreviousCloseDates, type DatedCloseListing } from "./dated-previous-close";
import { getRegularSessionDisplay, quoteMarketStateLabel } from "./status";
import { nominalPriceText } from "../quotes/freshness";

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

test("a BMV move is dated by the session right before its official close, and a closed B3 quote headlines its official close", async () => {
  // WALMEX.MX and PETR4.SA as `quote` served them on Sat 7 Nov 2026.
  const fri = { changeSessionDate: "2026-11-06", marketState: "CLOSED" as const };
  const walmex = createTestQuote({ symbol: "WALMEX.MX", currency: "MXN", listingExchangeName: "BMV", exchangeName: "BMV",
    price: 54.14, change: 0.57, changePercent: 1.06, previousClose: 53.57, lastUpdated: Date.parse("2026-11-06T20:59:55Z"), ...fri });
  const petr4 = createTestQuote({ symbol: "PETR4.SA", currency: "BRL", listingExchangeName: "B3", exchangeName: "B3",
    price: 45.36, change: -0.59, changePercent: -1.28, previousClose: 45.95, lastUpdated: Date.parse("2026-11-06T21:00:13Z"), ...fri });
  const { label, date } = dailyCloses({
    // The BMV's closing auction gave 53.57 for Thu 5 Nov; its bar closes on the last trade, 53.68.
    "WALMEX.MX": { "2026-11-04": 52.22, "2026-11-05": 53.68, "2026-11-06": 54.14 },
    "PETR4.SA": { "2026-11-05": 45.95, "2026-11-06": 45.3 },
  });
  expect(label(await date(walmex))).toBe("vs Thu 5 Nov close");
  // A bar more than 1% off, or one sessions back, is another close: no day.
  expect(label(await date({ ...walmex, previousClose: 52.9 }))).toBe("vs prev close");
  const b3 = await date(petr4);
  expect(label(b3)).toBe("vs Thu 5 Nov close");
  expect(b3).toMatchObject({ regularClose: 45.3, regularCloseSessionDate: "2026-11-06" });
  expect(getRegularSessionDisplay(b3)?.price).toBe(45.3);
  // While B3 trades, the price is the session's.
  expect((await date({ ...petr4, marketState: "REGULAR" })).regularClose).toBeUndefined();
});

test("a closed B3 quote read before its session's official close is in the history is read again until it lands", async () => {
  // PETR4.SA read on the evening of Fri 6 Nov 2026, before the day's bar: the previous close is dated, the close is not.
  const petr4 = createTestQuote({ symbol: "PETR4.SA", currency: "BRL", listingExchangeName: "B3", exchangeName: "B3",
    price: 45.36, change: -0.59, changePercent: -1.28, previousClose: 45.95, lastUpdated: Date.parse("2026-11-06T21:00:13Z"),
    changeSessionDate: "2026-11-06", marketState: "CLOSED" });
  const closes: Record<string, Record<string, number>> = { "PETR4.SA": { "2026-11-05": 45.95 } };
  const { asked, label, date, advance } = dailyCloses(closes);
  const early = await date(petr4);
  expect(label(early)).toBe("vs Thu 5 Nov close");
  expect(early.regularClose).toBeUndefined();
  // Not again within the retry window, then again once it is old: the bar has landed.
  expect((await date(petr4)).regularClose).toBeUndefined();
  closes["PETR4.SA"]!["2026-11-06"] = 45.3;
  advance(11 * 60_000);
  expect(await date(petr4)).toMatchObject({ regularClose: 45.3, regularCloseSessionDate: "2026-11-06", previousCloseDate: "2026-11-05" });
  expect(asked).toEqual(["PETR4.SA", "PETR4.SA"]);
  // Once it has, the reading stands.
  advance(11 * 60_000);
  await date(petr4);
  expect(asked).toHaveLength(2);
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

test("an index moves from its daily close of the day its move is dated from, whatever its source said", async () => {
  // ^HSI as a source served it on Fri 6 Nov 2026: Wed 4 Nov's close "vs Thu 5 Nov close", +2.35% for a -1.27% day.
  const hsi = createTestQuote({ symbol: "^HSI", currency: "HKD", instrumentType: "INDEX", listingExchangeName: "HKSE", exchangeName: "HKSE",
    price: 24481.86, change: 562.36, changePercent: 2.35, previousClose: 23919.5, changeSessionDate: "2026-11-06",
    marketState: "CLOSED", lastUpdated: Date.parse("2026-11-06T08:09:00Z") });
  const closes: Record<string, Record<string, number>> = { "^HSI": { "2026-11-04": 23919.5, "2026-11-05": 24796.98046875 } };
  const { asked, label, date } = dailyCloses(closes);
  expect(label(hsi)).toBe("vs Thu 5 Nov close");
  const measured = await date(hsi);
  // The bar's float32 close is the decimal it is, as Gloom Cloud serves it.
  expect(measured).toMatchObject({ previousClose: 24796.98, previousCloseDate: "2026-11-05" });
  expect(measured.changePercent).toBeCloseTo(-1.2708, 3);
  expect(label(measured)).toBe("vs Thu 5 Nov close");
  // A copy with the right close is checked once and left as it is; history without that day leaves the source's close.
  const right = { ...hsi, previousClose: 24796.98, change: -315.12, changePercent: -1.27 };
  expect(await date(right)).toMatchObject({ previousClose: 24796.98, change: -315.12 });
  expect(asked).toEqual(["^HSI", "^HSI"]);
  delete closes["^HSI"]!["2026-11-05"];
  const behind = { ...hsi, changeSessionDate: "2026-11-09", previousClose: 23900, lastUpdated: Date.parse("2026-11-09T08:09:00Z") };
  expect((await date(behind)).previousClose).toBe(23900);
});

test("an index's bars are dated where it trades, and a bar not closed yet is no close", async () => {
  // The Nikkei's bars stamped at Tokyo's midnight: by the UTC date, Fri 6 Nov's bar would be read as Thursday's close.
  const nikkei = createTestQuote({ symbol: "^N225", currency: "JPY", instrumentType: "INDEX", listingExchangeName: "OSAKA",
    exchangeName: "OSAKA", price: 57434.77, change: -2565.23, changePercent: -4.28, previousClose: 60000, changeSessionDate: "2026-11-06",
    marketState: "CLOSED", lastUpdated: Date.parse("2026-11-06T06:45:00Z") });
  const tokyo = [
    { date: new Date("2026-11-04T15:00:00Z"), close: 61077.8984375 },
    { date: new Date("2026-11-05T15:00:00Z"), close: 57434.77 },
  ];
  // A copy of the Hang Seng's bars kept from Thursday's session, its Thursday bar still forming.
  const hsi = createTestQuote({ symbol: "^HSI", currency: "HKD", instrumentType: "INDEX", listingExchangeName: "HKSE", exchangeName: "HKSE",
    price: 24481.86, change: -315.12, changePercent: -1.27, previousClose: 24796.98, changeSessionDate: "2026-11-06",
    marketState: "CLOSED", lastUpdated: Date.parse("2026-11-06T08:09:00Z") });
  const kept = [
    { date: new Date("2026-11-04T01:30:00Z"), close: 23919.5 },
    { date: new Date("2026-11-05T01:30:00Z"), close: 24500.12, partial: true },
  ];
  const dates = new PreviousCloseDates(async ({ symbol }) => symbol === "^N225" ? tokyo : kept, { now: () => NOW });
  await dates.settle([entry(nikkei), entry(hsi)], { waitMs: 5_000 });
  expect(dates.known(nikkei, listing(nikkei))).toMatchObject({ previousClose: 61077.9, previousCloseDate: "2026-11-05" });
  expect(dates.known(hsi, listing(hsi))).toMatchObject({ previousClose: 24796.98, change: -315.12 });
  expect(dates.known(hsi, listing(hsi)).previousCloseDate).toBeUndefined();
});

test("an index close corrected from its bars is read again ten minutes on, so a wrong bar cannot stand for the session", async () => {
  const hsi = createTestQuote({ symbol: "^HSI", currency: "HKD", instrumentType: "INDEX", listingExchangeName: "HKSE", exchangeName: "HKSE",
    price: 24481.86, change: -315.12, changePercent: -1.27, previousClose: 24796.98, changeSessionDate: "2026-11-06",
    marketState: "CLOSED", lastUpdated: Date.parse("2026-11-06T08:09:00Z") });
  const closes: Record<string, Record<string, number>> = { "^HSI": { "2026-11-05": 24500 } };
  const { dates, asked, advance } = dailyCloses(closes);
  await dates.settle([entry(hsi)], { waitMs: 5_000 });
  expect(dates.known(hsi, listing(hsi)).previousClose).toBe(24500);
  // Within ten minutes the correction answers without a read.
  advance(5 * 60_000);
  expect(dates.observe(hsi, listing(hsi)).previousClose).toBe(24500);
  expect(asked).toEqual(["^HSI"]);
  // Past them the bars are read again; once they agree with the source, its close stands.
  closes["^HSI"]!["2026-11-05"] = 24796.98;
  advance(6 * 60_000);
  await dates.settle([entry(hsi)], { waitMs: 5_000 });
  expect(asked).toEqual(["^HSI", "^HSI"]);
  expect(dates.known(hsi, listing(hsi))).toMatchObject({ previousClose: 24796.98, previousCloseDate: "2026-11-05" });
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

test("a board of indices checks them side by side and waits briefly; a Cboe index is left to Cboe's closes", async () => {
  // `fn WEI` checks two dozen indices: queued six at a time behind the dating reads, it ran 2.5 s slower than before.
  let inFlight = 0;
  let most = 0;
  const asked: string[] = [];
  const dates = new PreviousCloseDates(async ({ symbol }) => {
    asked.push(symbol);
    inFlight += 1;
    most = Math.max(most, inFlight);
    await Bun.sleep(symbol === "^SLOW" ? 5_000 : 20);
    inFlight -= 1;
    return [{ date: new Date("2026-11-05T01:30:00Z"), close: 100 }];
  }, { now: () => NOW, maxReadsInFlight: 2, indexWaitMs: 100 });
  const index = (symbol: string, venue = "HKSE") => createTestQuote({ symbol, instrumentType: "INDEX", listingExchangeName: venue,
    exchangeName: venue, price: 101, change: 2, changePercent: 2, previousClose: 99, changeSessionDate: "2026-11-06",
    marketState: "CLOSED", lastUpdated: Date.parse("2026-11-06T08:09:00Z") });
  const board = [...Array.from({ length: 12 }, (_, at) => index(`^I${at}`)), index("^SLOW"), index("^VIX", "CBOE INDICES")];
  const started = performance.now();
  await dates.settle(board.map(entry), { waitMs: 2_500 });
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(most).toBe(13);
  expect(asked).not.toContain("^VIX");
  expect(dates.known(board[0]!, listing(board[0]!))).toMatchObject({ previousClose: 100, change: 1 });
});

test("a thin listing that did not trade in the calendar's session before moves from its previous trade, named only when its closes hold it", async () => {
  // B95 on SGX, Sun 8 Nov 2026: Friday's 3,661 units against a 1.009 previous close; the calendar puts Thu 5 Nov before it.
  const sgx = (overrides: Partial<Quote> = {}) => createTestQuote({ symbol: "B95", currency: "SGD", listingExchangeName: "SGX", exchangeName: "SGX",
    instrumentType: "ETF", price: 1.012, change: 0.003, changePercent: 0.297, previousClose: 1.009, volume: 3661,
    changeSessionDate: "2026-11-06", marketState: "CLOSED", lastUpdated: Date.parse("2026-11-06T01:01:00Z"), ...overrides });
  const bars = (closes: Array<[string, number, number]>) => closes.map(([date, close, volume]) => ({ date: new Date(`${date}T00:00:00Z`), close, volume }));
  const read = (points: ReturnType<typeof bars>) => {
    const asked: string[] = [];
    const dates = new PreviousCloseDates(async ({ symbol }) => { asked.push(symbol); return points; }, { now: () => Date.parse("2026-11-08T01:00:00Z") });
    return { asked, date: async (quote: Quote) => {
      await dates.settle([entry(quote)], { waitMs: 5_000 });
      return changeBasisLabel(quoteChangeBasis(dates.known(quote, listing(quote)))!, Date.parse("2026-11-08T01:00:00Z"));
    } };
  };
  expect(changeBasisLabel(quoteChangeBasis(sgx())!, Date.parse("2026-11-08T01:00:00Z"))).toBe("vs Thu 5 Nov close");
  // Its last trade, 22 Oct, closed at the previous close: the move is from that day. A day with no volume is no trade.
  const named = read(bars([["2026-10-12", 0.998, 30], ["2026-10-22", 1.009, 50], ["2026-10-30", 1.009, 0], ["2026-11-06", 1.012, 3661]]));
  expect(await named.date(sgx())).toBe("vs Thu 22 Oct close");
  // Its closes end at 1.003 on 22 Oct: the 1.009 is from a day they do not hold, so none is named.
  expect(await read(bars([["2026-10-22", 1.003, 50], ["2026-11-06", 1.012, 3661]])).date(sgx())).toBe("vs prev close");
  // It traded in the calendar's session: the calendar stands.
  expect(await read(bars([["2026-11-05", 1.009, 900], ["2026-11-06", 1.012, 3661]])).date(sgx())).toBe("vs Thu 5 Nov close");
  // A busy listing, or one still trading, reads no history.
  const busy = read(bars([]));
  await busy.date(sgx({ volume: 2_000_000 }));
  await busy.date(sgx({ marketState: "REGULAR" }));
  expect(busy.asked).toEqual([]);
});

// 9042.HK, a bitcoin fund's USD counter: nothing traded on it after Thu 29 Oct, and HKEX set its nominal prices since.
// Its quote keeps Fri 6 Nov's nominal 1.172 against Thu 5 Nov's 1.244, stamped by its last print on Wed 4 Nov.
const usdCounter = createTestQuote({ symbol: "9042.HK", currency: "USD", listingExchangeName: "HKEX", exchangeName: "HKEX", instrumentType: "ETF",
  price: 1.172, change: -0.072, changePercent: -5.79, previousClose: 1.244, open: 1.19, high: 1.254, low: 1.168, volume: 123_100,
  changeSessionDate: "2026-11-04", marketState: "CLOSED", lastUpdated: Date.parse("2026-11-04T03:32:00Z"), stale: true });
const counterBar = (date: string, close: number, volume?: number) => ({
  date: new Date(`${date}T00:00:00+08:00`), close, open: close, high: close, low: close, ...volume === undefined ? {} : { volume },
});
const NOMINAL_BARS = [counterBar("2026-10-29", 1.238, 95_200), counterBar("2026-10-30", 1.208, 0), counterBar("2026-11-03", 1.192, 0),
  counterBar("2026-11-04", 1.21, 0), counterBar("2026-11-05", 1.244, 0), counterBar("2026-11-06", 1.1720000505447388, 0)];

function readCounter(points: ReturnType<typeof counterBar>[], now: number) {
  const asked: string[] = [];
  const dates = new PreviousCloseDates(async ({ symbol }) => {
    asked.push(symbol);
    return points;
  }, { now: () => now });
  const date = async (quote: Quote) => {
    await dates.settle([entry(quote)], { waitMs: 5_000 });
    return dates.known(quote, listing(quote));
  };
  return { date, asked };
}

test("a stale counter whose bars carry later nominal prices is dated by them, keeping its last print, and says nothing traded", async () => {
  const now = Date.parse("2026-11-08T09:38:00Z");
  expect(changeBasisLabel(quoteChangeBasis(usdCounter)!, now)).toBe("vs Tue 3 Nov close");
  const nominal = await readCounter(NOMINAL_BARS, now).date(usdCounter);
  expect(changeBasisLabel(quoteChangeBasis(nominal)!, now)).toBe("vs Thu 5 Nov close");
  // Friday's nominal price, with no range or volume of its own: nothing traded since 29 Oct. Its last print and stale flag stay.
  expect(nominal).toMatchObject({ changeSessionDate: "2026-11-06", previousCloseDate: "2026-11-05", stale: true,
    lastUpdated: usdCounter.lastUpdated, volume: 0, nominalPrice: { session: "2026-11-06", lastTraded: "2026-10-29" } });
  expect([nominal.open, nominal.high, nominal.low]).toEqual([undefined, undefined, undefined]);
  // A bar whose volume is not reported proves no trade either.
  const unknown = await readCounter([counterBar("2026-11-05", 1.244, 4_000), counterBar("2026-11-06", 1.172)], now).date(usdCounter);
  expect(unknown.nominalPrice).toEqual({ session: "2026-11-06", lastTraded: "2026-11-05" });
  expect(unknown.volume).toBeUndefined();
  // Bars that traded date it the same way, with the session's own range; bars that end at the quote's own session leave it be.
  const traded = await readCounter([counterBar("2026-11-05", 1.244, 4_000), counterBar("2026-11-06", 1.172, 9_100)], now).date(usdCounter);
  expect(traded).toMatchObject({ changeSessionDate: "2026-11-06", volume: 9_100, open: 1.172 });
  expect(traded.nominalPrice).toBeUndefined();
  const own = await readCounter([counterBar("2026-11-03", 1.244, 0), counterBar("2026-11-04", 1.172, 0)], now).date(usdCounter);
  expect(own).toMatchObject({ changeSessionDate: "2026-11-04", stale: true, volume: 123_100 });
  expect(changeBasisLabel(quoteChangeBasis(own)!, now)).toBe("vs Tue 3 Nov close");
});

test("an untraded counter keeps its nominal session through HKEX's trading day and lunch break, until it prints", async () => {
  // Mon 9 Nov 2026: a bar for the day in progress, unmarked, is no completed session.
  const bars = [...NOMINAL_BARS, counterBar("2026-11-09", 1.172, 0)];
  for (const [at, marketState] of [["2026-11-09T02:15:00Z", "REGULAR"], ["2026-11-09T04:30:00Z", "REGULAR"], ["2026-11-09T04:30:00Z", "CLOSED"]] as const) {
    const now = Date.parse(at);
    const quote = { ...usdCounter, marketState };
    const dated = await readCounter(bars, now).date(quote);
    expect(dated.nominalPrice).toEqual({ session: "2026-11-06", lastTraded: "2026-10-29" });
    expect(changeBasisLabel(quoteChangeBasis(dated)!, now)).toBe("vs Thu 5 Nov close");
    expect(quoteMarketStateLabel(dated, now)).toBe("NO TRADES");
    expect(nominalPriceText(dated)).toBe("no trades since Thu 29 Oct, nominal price");
  }
  // A print since the open is the day's own session: no history is read for it.
  const now = Date.parse("2026-11-09T02:15:00Z");
  const printed = readCounter(bars, now);
  const quote = { ...usdCounter, marketState: "REGULAR" as const, lastUpdated: Date.parse("2026-11-09T02:01:00Z") };
  expect(await printed.date(quote)).toBe(quote);
  expect(printed.asked).toEqual([]);
});

test("a thin counter whose previous close is its venue's nominal price of the calendar's session keeps the calendar's date", async () => {
  // 83042.HK on Sun 8 Nov 2026: 8.315, Thu 5 Nov's nominal price; it last traded on Wed 4 Nov at 8.095.
  const now = Date.parse("2026-11-08T09:38:00Z");
  const rmb = createTestQuote({ symbol: "83042.HK", currency: "CNY", listingExchangeName: "HKEX", exchangeName: "HKEX", instrumentType: "ETF",
    price: 7.815, change: -0.5, changePercent: -6.01, previousClose: 8.315, volume: 26_900,
    changeSessionDate: "2026-11-06", marketState: "CLOSED", lastUpdated: Date.parse("2026-11-06T01:30:00Z") });
  const points = [["2026-11-03", 7.94, 0], ["2026-11-04", 8.095, 205_300], ["2026-11-05", 8.315, 0], ["2026-11-06", 7.815, 0]] as const;
  const dates = new PreviousCloseDates(async () => points.map(([date, close, volume]) => ({ date: new Date(`${date}T00:00:00+08:00`), close, volume })),
    { now: () => now });
  await dates.settle([entry(rmb)], { waitMs: 5_000 });
  expect(changeBasisLabel(quoteChangeBasis(dates.known(rmb, listing(rmb)))!, now)).toBe("vs Thu 5 Nov close");
});

test("a Cboe yield index is dated by its own closes, across a bond holiday its venue's calendar does not have", async () => {
  // Thu 12 Nov 2026, after Veterans Day: ^TNX's 4.07 is Tuesday's close, not Wednesday's.
  const now = Date.parse("2026-11-12T22:00:00Z");
  const tnx = createTestQuote({ symbol: "^TNX", instrumentType: "INDEX", listingExchangeName: "CBOE INDICES", exchangeName: "CBOE INDICES",
    price: 4.1, change: 0.03, changePercent: 0.74, previousClose: 4.07, changeSessionDate: "2026-11-12", marketState: "CLOSED",
    lastUpdated: Date.parse("2026-11-12T20:59:00Z") });
  const dates = new PreviousCloseDates(async () => [["2026-11-09", 4.02], ["2026-11-10", 4.07], ["2026-11-12", 4.1]]
    .map(([date, close]) => ({ date: new Date(`${date}T00:00:00Z`), close: close as number })), { now: () => now });
  await dates.settle([entry(tnx)], { waitMs: 5_000 });
  expect(changeBasisLabel(quoteChangeBasis(dates.known(tnx, listing(tnx)))!, now)).toBe("vs Tue 10 Nov close");
});

