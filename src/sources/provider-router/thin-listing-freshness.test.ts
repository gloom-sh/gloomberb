import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import { createTestDataProvider, createTestQuote } from "../../test-support/data-provider";
import type { Quote } from "../../types/financials";
import { isProviderQuoteUsableForCurrentSession } from "./financials";
import { AssetDataRouter } from "./index";

// A thinly traded listing can go an hour between trades while its venue
// trades. Gloom Cloud's not-stale verdict on a delayed quote it just gave
// stands in for the app's own age bound; every other quote keeps that bound.

const at = (time: string) => Date.parse(time);
const minutes = 60_000;

function quote(symbol: string, exchange: string, lastPrint: string, overrides: Partial<Quote> = {}): Quote {
  return createTestQuote({ symbol, listingExchangeName: exchange, exchangeName: exchange, marketState: "REGULAR",
    dataSource: "delayed", providerId: "gloomberb-cloud", stale: false, lastUpdated: at(lastPrint), ...overrides });
}

/** [what, now, quote, answered on this request or inside the cache TTL, usable] */
type Row = [string, string, Quote, boolean, boolean];

describe("a delayed quote's last trade age", () => {
  let clock: ReturnType<typeof spyOn>;
  beforeEach(() => {
    clock = spyOn(Date, "now");
  });
  afterEach(() => clock.mockRestore());

  test("gives way to the service's verdict only where it can vouch", () => {
    // 13:49 London on Friday 9 Oct 2026: ZIOC.L's last trade was 77 minutes old.
    const london = "2026-10-09T12:49:00Z";
    // 14:19 New York and Toronto.
    const americas = "2026-10-09T18:19:00Z";
    const zioc = quote("ZIOC", "LSE", "2026-10-09T11:32:00Z");
    const stuck = quote("VOD", "LSE", "2026-10-09T12:09:00Z");
    // 19:30 New York, after the regular close at 16:00.
    const afterHours = "2026-10-09T23:30:00Z";
    const usPost = quote("XSD", "NASDAQ", "2026-10-09T20:10:00Z", { marketState: "POST", postMarketPrice: 527.93 });
    const sar = quote("SAR=X", "CCY", "2026-10-09T12:08:00Z", { instrumentType: "CURRENCY", currency: "SAR" });
    const rows: Row[] = [
      ["thin, 77 min, a fresh not-stale answer", london, zioc, true, true],
      ["thin, 77 min, a cache entry past its TTL", london, zioc, false, false],
      ["thin, 77 min, the service says stale", london, { ...zioc, stale: true }, true, false],
      ["liquid and stuck, the service says stale", london, { ...stuck, stale: true }, true, false],
      // An answer without the flag cannot vouch, so the app's own bound decides.
      ["liquid, 40 min, an answer without the flag", london, { ...stuck, stale: undefined }, true, false],
      // Nothing in the answer tells a liquid listing from a thin one.
      ["liquid, 40 min, the service wrongly says not stale", london, stuck, true, true],
      ["thin, 77 min, another source", london, { ...zioc, providerId: "other" }, true, false],
      ["another source, 25 min", london, quote("ZIOC", "LSE", "2026-10-09T12:24:00Z", { providerId: "other" }), false, true],
      ["real-time, 40 min, not stale", london, { ...stuck, dataSource: "live" }, true, false],
      ["thin, last trade yesterday", london, quote("ZIOC", "LSE", "2026-10-08T15:35:00Z"), true, false],
      ["thin, a trade before today's open", london, quote("ZIOC", "LSE", "2026-10-09T06:30:00Z"), true, false],
      ["thin, traded in the opening auction", london, quote("ZIOC", "LSE", "2026-10-09T06:55:00Z"), true, true],
      ["a venue without session hours", london, quote("ABC", "MCE", "2026-10-09T11:32:00Z"), true, false],
      ["US thin, 35 min, a fresh answer", americas, quote("CODA", "NASDAQ", "2026-10-09T17:44:00Z"), true, true],
      ["US thin, 2 h, a cache entry past its TTL", americas, quote("GEG", "NASDAQ", "2026-10-09T16:13:00Z"), false, false],
      ["TSXV thin, 77 min, a fresh answer", americas, quote("LIO", "TSXV", "2026-10-09T17:02:00Z"), true, true],
      // 19:30 New York: a thin listing's last after-hours trade, at 16:10, is the current price.
      ["US after-hours, 3 h, a fresh answer", afterHours, usPost, true, true],
      ["US after-hours, 3 h, a cache entry past its TTL", afterHours, usPost, false, false],
      ["US after-hours, 3 h, the service says stale", afterHours, { ...usPost, stale: true }, true, false],
      ["US after-hours, 3 h, another source", afterHours, { ...usPost, providerId: "other" }, true, false],
      ["US after-hours, 3 h, real-time", afterHours, { ...usPost, dataSource: "live" }, true, false],
      ["US after-hours, an answer without the flag", afterHours, { ...usPost, stale: undefined }, true, false],
      ["US after-hours label without an after-hours price", afterHours, { ...usPost, postMarketPrice: undefined }, true, false],
      // 12:30 Hong Kong: over lunch the morning's last print stands for any source.
      ["HKEX over lunch", "2026-10-09T04:30:00Z", quote("0700", "HKEX", "2026-10-09T03:59:00Z", { providerId: "other" }), false, true],
      ["HKEX thin over lunch, traded at 10:00", "2026-10-09T04:30:00Z", quote("1234", "HKEX", "2026-10-09T02:00:00Z"), true, true],
      // A currency pair has no session hours here; the service judges it against how often it prints.
      ["SAR=X, 2 h, a fresh not-stale answer", "2026-10-09T14:08:00Z", sar, true, true],
      ["SAR=X, 2 h, a cache entry past its TTL", "2026-10-09T14:08:00Z", sar, false, false],
      ["SAR=X, 2 h, the service says stale", "2026-10-09T14:08:00Z", { ...sar, stale: true }, true, false],
      ["SAR=X, 2 h, another source", "2026-10-09T14:08:00Z", { ...sar, providerId: "other" }, true, false],
      ["EURUSD=X on Saturday, Friday's close", "2026-10-10T01:30:00Z",
        quote("EURUSD=X", "CCY", "2026-10-09T21:29:00Z", { marketState: "CLOSED", instrumentType: "CURRENCY" }), false, true],
    ];
    for (const [what, now, observed, recentAnswer, usable] of rows) {
      clock.mockReturnValue(at(now));
      const exchange = observed.listingExchangeName;
      expect(isProviderQuoteUsableForCurrentSession(observed, exchange, observed.symbol, { recentAnswer }), what).toBe(usable);
    }
  });

  // A thin US listing that does not trade after the close: the service labels
  // it POST, derives the after-hours price from the regular close and says it
  // is not stale, as it did for CRBG, PRTA and SAH on Friday 9 Oct 2026.
  const thinPost = (lastPrint: string, overrides: Partial<Quote> = {}) => quote("CRBG", "NYSE", lastPrint, {
    marketState: "POST", price: 34.09, regularClose: 34.09, postMarketPrice: 34.09, sessionConfidence: "derived", ...overrides,
  });
  // Before the open: the service labels it PRE with the previous close as the pre-market price.
  const thinPre = (lastPrint: string, overrides: Partial<Quote> = {}) => quote("PRTA", "NASDAQ", lastPrint, {
    marketState: "PRE", price: 8.84, preMarketPrice: 8.84, sessionConfidence: "derived", ...overrides,
  });
  // Fri 9 Oct 2026 is on daylight time: 16:00 New York is 20:00Z.
  const evening = "2026-10-09T23:30:00Z";
  const morning = "2026-10-09T12:30:00Z";
  // Fri 27 Nov 2026 closes at 13:00 New York (18:00Z); the app's clock reads 14:30 as regular hours.
  const earlyClose = "2026-11-27T19:30:00Z";
  const extendedRows: Row[] = [
    ["17:05, PRTA's 16:01 print", "2026-10-09T21:05:00Z", thinPost("2026-10-09T20:01:24Z"), true, true],
    ["17:05, PRTA's 16:01 print, past the TTL", "2026-10-09T21:05:00Z", thinPost("2026-10-09T20:01:24Z"), false, false],
    ["POST, 1 h old after-hours print", evening, thinPost("2026-10-09T22:30:00Z"), true, true],
    ["POST, 1 h old after-hours print, past the TTL", evening, thinPost("2026-10-09T22:30:00Z"), false, false],
    ["POST, 5 h old regular-session print", evening, thinPost("2026-10-09T18:30:00Z"), true, true],
    ["POST, 5 h old regular-session print, past the TTL", evening, thinPost("2026-10-09T18:30:00Z"), false, false],
    ["POST, print at today's open", evening, thinPost("2026-10-09T13:30:00Z"), true, true],
    ["POST, print just before today's open", evening, thinPost("2026-10-09T13:29:59Z"), true, false],
    ["POST, print from this morning's pre-market", evening, thinPost("2026-10-09T12:00:00Z"), true, false],
    ["POST, print from yesterday's regular session", evening, thinPost("2026-10-08T18:30:00Z"), true, false],
    ["POST, print from yesterday's after-hours", evening, thinPost("2026-10-08T22:30:00Z"), true, false],
    ["POST, an answer without the flag", evening, thinPost("2026-10-09T18:30:00Z", { stale: undefined }), true, false],
    ["POST, the service says stale", evening, thinPost("2026-10-09T18:30:00Z", { stale: true }), true, false],
    ["POST, real-time", evening, thinPost("2026-10-09T18:30:00Z", { dataSource: "live" }), true, false],
    ["POST, another source", evening, thinPost("2026-10-09T18:30:00Z", { providerId: "other" }), true, false],
    ["PRE, 3 h old pre-market print", morning, thinPre("2026-10-09T09:30:00Z"), true, true],
    ["PRE, 3 h old pre-market print, past the TTL", morning, thinPre("2026-10-09T09:30:00Z"), false, false],
    ["PRE, the previous close", morning, thinPre("2026-10-08T19:40:00Z"), true, true],
    ["PRE, the previous session's after-hours", morning, thinPre("2026-10-08T21:10:00Z"), true, true],
    ["PRE, print from yesterday's pre-market", morning, thinPre("2026-10-08T12:00:00Z"), true, false],
    ["PRE, the close two sessions back", morning, thinPre("2026-10-07T19:40:00Z"), true, false],
    ["PRE, pre-market print, an answer without the flag", morning, thinPre("2026-10-09T09:30:00Z", { stale: undefined }), true, false],
    ["PRE, pre-market print, real-time", morning, thinPre("2026-10-09T09:30:00Z", { dataSource: "live" }), true, false],
    ["PRE, pre-market print, another source", morning, thinPre("2026-10-09T09:30:00Z", { providerId: "other" }), true, false],
    ["early close, 14:30, a 12:10 print", earlyClose, thinPost("2026-11-27T17:10:00Z"), true, true],
    ["early close, 14:30, a 12:10 print, past the TTL", earlyClose, thinPost("2026-11-27T17:10:00Z"), false, false],
    ["early close, 16:30, a 12:10 print", "2026-11-27T21:30:00Z", thinPost("2026-11-27T17:10:00Z"), true, true],
    ["early close, 14:30, the day before's close", earlyClose, thinPost("2026-11-25T20:50:00Z"), true, false],
    // Unchanged: a Saturday has no session to age a print in, and Labor Day's
    // weekday session hours still read Friday's print as an old day's.
    ["Saturday, Friday's print", "2026-10-10T15:00:00Z", thinPost("2026-10-09T22:30:00Z"), true, true],
    ["Saturday, Friday's print, past the TTL", "2026-10-10T15:00:00Z", thinPost("2026-10-09T22:30:00Z"), false, true],
    ["Labor Day evening, Friday's print", "2026-09-07T22:00:00Z", thinPost("2026-09-04T18:30:00Z"), true, false],
    ["Labor Day morning, Friday's close", "2026-09-07T12:30:00Z", thinPre("2026-09-04T19:40:00Z"), true, false],
  ];

  test("in the US extended-hours sessions, back to the regular session they extend", () => {
    for (const [what, now, observed, recentAnswer, usable] of extendedRows) {
      clock.mockReturnValue(at(now));
      const exchange = observed.listingExchangeName;
      expect(isProviderQuoteUsableForCurrentSession(observed, exchange, observed.symbol, { recentAnswer }), what).toBe(usable);
    }
  });
});

describe("thinly traded listings through the router", () => {
  const now = at("2026-10-09T12:49:00Z");
  const zioc = quote("ZIOC", "LSE", "2026-10-09T11:32:00Z", { price: 0.0325, currency: "GBP" });
  let clock: ReturnType<typeof spyOn>;
  let persistence: AppPersistence;
  beforeEach(() => {
    clock = spyOn(Date, "now").mockReturnValue(now);
    persistence = new AppPersistence(":memory:");
  });
  afterEach(() => {
    clock.mockRestore();
    persistence.close();
  });

  function source(id: string, answer: Quote) {
    const state = { fails: false, asked: 0 };
    const respond = () => {
      state.asked += 1;
      if (state.fails) throw new Error("Fixture source unavailable");
      return answer;
    };
    const provider = createTestDataProvider({ id, priority: 1,
      getQuote: async () => respond(),
      getQuotesBatch: async (targets) => targets.map((target) => ({ target, quote: respond() })),
    });
    return { router: new AssetDataRouter(provider, [], persistence.resources), state };
  }
  const target = { symbol: "ZIOC", exchange: "LSE" };

  test("a fresh answer is served, from the cache within its TTL, and not once the TTL has passed", async () => {
    const { router, state } = source("gloomberb-cloud", zioc);
    expect((await router.getQuotesBatch([target]))[0]?.quote).toMatchObject({ price: 0.0325, lastUpdated: zioc.lastUpdated });

    state.fails = true;
    clock.mockReturnValue(now + 2 * minutes);
    expect((await router.getQuotesBatch([target]))[0]?.quote).toMatchObject({ price: 0.0325 });
    expect(await router.getQuote("ZIOC", "LSE")).toMatchObject({ price: 0.0325 });
    expect(state.asked).toBe(1);

    // Past the quote TTL with every refresh refused: the copy no longer vouches.
    clock.mockReturnValue(now + 6 * minutes);
    expect((await router.getQuotesBatch([target]))[0]?.quote).toBeNull();
    await expect(router.getQuote("ZIOC", "LSE")).rejects.toThrow("No quote provider");
  });

  test("a currency pair asked for as BASE/QUOTE takes the service's answer in its own spelling", async () => {
    clock.mockReturnValue(at("2026-10-10T01:30:00Z"));
    const pair = (symbol: string) => quote(symbol, "CCY", "2026-10-09T21:29:00Z", { marketState: "CLOSED", instrumentType: "CURRENCY" });
    const answers: Array<[string, string, boolean]> = [
      ["EUR/USD", "EURUSD=X", true],
      ["USD/CHF", "USDCHF=X", true],
      ["USD/JPY", "JPY=X", true],
      ["GBP/USD", "EURUSD=X", false],
      ["JPY/USD", "JPY=X", false],
    ];
    for (const [asked, answered, served] of answers) {
      const { router } = source("gloomberb-cloud", pair(answered));
      const result = (await router.getQuotesBatch([{ symbol: asked, exchange: "" }]))[0]?.quote;
      expect(result?.symbol ?? null, `${asked} answered as ${answered}`).toBe(served ? answered : null);
    }
  });

  test("another source's thin quote keeps the age bound, and is served as the last known price", async () => {
    const { router, state } = source("other", { ...zioc, providerId: "other" });
    // No source has a current quote: the answer comes back flagged stale, and is not kept.
    expect((await router.getQuotesBatch([target]))[0]?.quote).toMatchObject({ price: 0.0325, lastUpdated: zioc.lastUpdated, stale: true });
    expect(await router.getQuote("ZIOC", "LSE")).toMatchObject({ price: 0.0325, stale: true });
    const asked = state.asked;
    await router.getQuote("ZIOC", "LSE");
    expect(state.asked).toBe(asked + 1);
  });
});
