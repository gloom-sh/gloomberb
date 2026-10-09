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
      ["US after-hours label on a regular-session print", afterHours, { ...usPost, lastUpdated: at("2026-10-09T19:51:00Z") }, true, false],
      // 12:30 Hong Kong: over lunch the morning's last print stands for any source.
      ["HKEX over lunch", "2026-10-09T04:30:00Z", quote("0700", "HKEX", "2026-10-09T03:59:00Z", { providerId: "other" }), false, true],
      ["HKEX thin over lunch, traded at 10:00", "2026-10-09T04:30:00Z", quote("1234", "HKEX", "2026-10-09T02:00:00Z"), true, true],
    ];
    for (const [what, now, observed, recentAnswer, usable] of rows) {
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

  test("another source's thin quote keeps the age bound", async () => {
    const { router } = source("other", { ...zioc, providerId: "other" });
    expect((await router.getQuotesBatch([target]))[0]?.quote).toBeNull();
    await expect(router.getQuote("ZIOC", "LSE")).rejects.toThrow("No quote provider");
  });
});
