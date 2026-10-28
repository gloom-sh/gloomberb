import { afterEach, expect, setSystemTime, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { setCloudApiFetchTransport } from "../../../api-client/request";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig, saveConfig } from "../../../data/config/store";
import { createTestCliContext } from "../../../test-support/cli-context";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { createDefaultConfig } from "../../../types/config";
import type { QuoteBatchResult, QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";
import { currencyPairSpelling } from "../../../utils/currency-pair";
import { alertsCliCommand, parseAlertAddArgs } from "./cli";
import { farTargetMessage } from "./quotes";
import { readAlertStores } from "./storage";
import { getPublishedUsEquitySession } from "../../../market-data/published-us-sessions";
import { serializeCliResult } from "../../../cli/result";
import type { CliGlobalOptions } from "../../../cli/options";
import { resumeStateKey } from "../../registry/plugin-state";
import { createAlert } from "./alert-engine";
import { ALERTS_PLUGIN_ID } from "./constants";
import { FIRED_LOG_KEY, readFiredAlerts } from "./fired-log";

const dataDirs: string[] = [];

afterEach(async () => {
  setSystemTime();
  setCloudApiFetchTransport(null);
  apiClient.setSessionToken(null);
  await Promise.all(dataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const pair: Quote = createTestQuote({
  symbol: "USDMXN=X", name: "USD/MXN", currency: "MXN", price: 18.42, listingExchangeName: "CCY", exchangeName: "CCY", instrumentType: "CURRENCY",
});

/**
 * Gloom Cloud for a few symbols: the pair is quoted under its own listing only (USDMXN as typed is no
 * ticker, as the service answers it), USD_NGN is a miss search lists the pair for, and AAPL is a US stock.
 */
function cloud() {
  const quotes: Record<string, Quote> = {
    "USDMXN=X": pair,
    "USDNGN=X": { ...pair, symbol: "USDNGN=X", name: "USD/NGN", currency: "NGN", price: 1322 },
    // After hours: the alert is checked on the regular-session price, which the far-target check measures against.
    AAPL: createTestQuote({ symbol: "AAPL", name: "Apple Inc.", price: 250, listingExchangeName: "NASDAQ", exchangeName: "NASDAQ",
      marketState: "POST", postMarketPrice: 300 }),
    // The bare coin ticker is the Grayscale fund, as the data service answers it.
    BTC: createTestQuote({ symbol: "BTC", name: "Grayscale Bitcoin Mini Trust ETF", price: 37.35, listingExchangeName: "ARCA", exchangeName: "ARCA", instrumentType: "ETF" }),
    // A stale company shares SOL's letters, and a live one LINK's.
    SOL: createTestQuote({ symbol: "SOL", name: "Emeren Group Ltd", price: 1.94, listingExchangeName: "NYSE", exchangeName: "NYSE", instrumentType: "Common Stock", stale: true }),
    LINK: createTestQuote({ symbol: "LINK", name: "Interlink Electronics, Inc.", price: 4.08, listingExchangeName: "NASDAQ", exchangeName: "NASDAQ", instrumentType: "EQUITY" }),
  };
  return createTestDataProvider({
    search: async (query: string) => {
      if (query.toUpperCase() === "AAPL") return [{ providerId: "test", symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", type: "EQUITY", currency: "USD" }];
      if (query.toUpperCase() === "BTC") return [{ providerId: "test", symbol: "BTC", name: "Grayscale Bitcoin Mini Trust ETF", exchange: "ARCA", type: "ETF", currency: "USD" }];
      if (query.toUpperCase() === "SOL") return [{ providerId: "test", symbol: "SOL", name: "Emeren Group Ltd", exchange: "NYSE", type: "Common Stock", currency: "USD" }];
      if (query.toUpperCase() === "LINK") return [{ providerId: "test", symbol: "LINK", name: "Interlink Electronics, Inc.", exchange: "NASDAQ", type: "EQUITY", currency: "USD" }];
      const found = currencyPairSpelling(query.replace("_", "/").toUpperCase(), "CCY");
      const quote = found ? quotes[found.symbol] : undefined;
      return quote ? [{ providerId: "test", symbol: quote.symbol, name: quote.name!, exchange: "CCY", type: "CURRENCY", currency: quote.currency }] : [];
    },
    getQuotesBatch: async (targets: QuoteSubscriptionTarget[]): Promise<QuoteBatchResult[]> => targets.map((target) => (
      quotes[target.symbol] ? { target, quote: quotes[target.symbol]! } : { target, quote: null, error: `Not a ticker: ${target.symbol}.` }
    )),
  });
}

async function addAlert(args: string[]) {
  const dataDir = await mkdtemp(join(tmpdir(), "gloomberb-alerts-add-"));
  dataDirs.push(dataDir);
  const config = createDefaultConfig(dataDir);
  await saveConfig(config);
  const cli = createTestCliContext({ config, dataProvider: cloud() });
  let error: string | null = null;
  try {
    await alertsCliCommand.execute(["add", ...args], cli.context);
  } catch (thrown) {
    error = (thrown as Error).message;
  }
  const saved = await loadConfig(dataDir);
  const stores = readAlertStores(saved);
  return { stored: stores.alerts, events: stores.events.rules, pluginState: saved.pluginConfig.alerts ?? {}, error, printed: cli.printed[0] };
}

test("a price alert is kept for the listing quote prints, so one pair is one target however it is typed", async () => {
  const spellings = await Promise.all(["USDMXN", "USD/MXN", "usdmxn=x", "MXN=X"].map((typed) => addAlert([typed, "above", "18.8"])));
  for (const { stored, error } of spellings) {
    expect(error).toBeNull();
    expect(stored.map((alert) => [alert.symbol, alert.exchange, alert.targetPrice])).toEqual([["USDMXN=X", undefined, 18.8]]);
  }
});

test("a symbol nothing quotes is refused and nothing is stored, with the nearest listing named when there is one", async () => {
  const unknown = await addAlert(["ZZZQQ9", "above", "1"]);
  expect(unknown.error).toContain("Not a ticker: ZZZQQ9.");
  expect(unknown.stored).toEqual([]);
  expect(unknown.printed).toBeUndefined();

  const near = await addAlert(["USD_NGN", "above", "1500"]);
  expect(near.error).toBe("Not a ticker: USD_NGN. Did you mean USDNGN=X (USD/NGN)?");
  expect(near.stored).toEqual([]);

  // One slip from a US ticker the user is likely to mean, which search lists no typo for.
  const typo = await addAlert(["AAPLL", "above", "100"]);
  expect(typo.error).toContain("Did you mean AAPL");
  expect(typo.stored).toEqual([]);
});

test("a price alert says what delivers it, and the app is the one thing that always does", async () => {
  const { printed, stored } = await addAlert(["AAPL", "above", "250"]);
  expect(stored).toHaveLength(1);
  const text = printed!.options!.text!(printed!.result.data);
  expect(text).toContain("AAPL above 250 (the app alerts while it is running;");
  // Signed in, Cloud emails or pushes it only once the app has been closed for a while: never promised to everyone.
  expect(text).toContain("sign in with Cloud sync for email or phone alerts when it is closed");
});

test("a bare coin ticker on its fund gets quote's note, and a target ten times its price is refused with it", async () => {
  const far = await addAlert(["btc", "above", "85000"]);
  expect(far.error).toBe("A target of 85,000 is more than 10 times BTC's last price of 37.35. BTC is Grayscale Bitcoin Mini Trust ETF, not bitcoin. For bitcoin use BTC-USD.");
  expect(far.stored).toEqual([]);
  // Measured against the price the alert is checked on (250), not the after-hours print, and the same for crosses.
  expect((await addAlert(["AAPL", "below", "24.99"])).error).toBe("A target of 24.99 is under 1/10 of AAPL's last price of 250. Check the price and the symbol.");
  expect((await addAlert(["AAPL", "crosses", "2500.01"])).error).toMatch(/^A target of 2,500.01 is more than 10 times AAPL's last price of 250\./);
  expect((await addAlert(["AAPL", "crosses", "2500"])).error).toBeNull();

  const near = await addAlert(["btc", "above", "40"]);
  expect(near.stored.map((alert) => [alert.symbol, alert.targetPrice])).toEqual([["BTC", 40]]);
  expect(near.printed!.result.warnings).toContain("BTC is Grayscale Bitcoin Mini Trust ETF, not bitcoin. For bitcoin use BTC-USD.");
});

test("a coin ticker on a stale company says so firmly, and on a live one softly", async () => {
  expect((await addAlert(["SOL", "below", "90"])).error)
    .toBe("A target of 90 is more than 10 times SOL's last price of 1.94. SOL is Emeren Group Ltd, not solana. For solana use SOL-USD.");
  expect((await addAlert(["LINK", "above", "500"])).error)
    .toBe("A target of 500 is more than 10 times LINK's last price of 4.08. LINK is Interlink Electronics, Inc. Also a coin: LINK-USD.");
  expect((await addAlert(["LINK", "above", "5"])).printed!.result.warnings).toContain("LINK is Interlink Electronics, Inc. Also a coin: LINK-USD.");
});

test("alerts add reads the dialog's news, flow and IV forms", () => {
  expect(parseAlertAddArgs(["IBIT", "iv", "above", "50"], undefined)).toEqual({ kind: "iv_level", symbol: "IBIT", metric: "atm", direction: "above", level: 50 });
  expect(parseAlertAddArgs(["SPY", "RR", "below", "-6"], undefined)).toEqual({ kind: "iv_level", symbol: "SPY", metric: "rr", direction: "below", level: -6 });
  // A level takes its unit, joined or apart, and only the one its measure is in.
  expect(parseAlertAddArgs(["IBIT", "iv", "above", "50%"], undefined)).toMatchObject({ metric: "atm", level: 50 });
  expect(parseAlertAddArgs(["IBIT", "iv", "above", "50", "%"], undefined)).toMatchObject({ metric: "atm", level: 50 });
  expect(parseAlertAddArgs(["SPY", "rr", "below", "-5.5", "pts"], undefined)).toMatchObject({ metric: "rr", level: -5.5 });
  expect(parseAlertAddArgs(["SPY", "rr", "below", "-5.5pts"], undefined)).toMatchObject({ metric: "rr", level: -5.5 });
  expect(() => parseAlertAddArgs(["SPY", "rr", "below", "-5%"], undefined)).toThrow("A risk reversal is in vol points, not %");
  expect(() => parseAlertAddArgs(["IBIT", "iv", "above", "50", "pts"], undefined)).toThrow("An ATM IV level is in %, not vol points");
  expect(parseAlertAddArgs(["AAPL271217C00300000", "iv", "spike", "5", "pts"], undefined)).toMatchObject({ kind: "iv_spike", points: 5 });
  expect(parseAlertAddArgs(["AAPL271217C00300000", "iv", "spike", "5"], undefined)).toEqual({ kind: "iv_spike", contract: "AAPL271217C00300000", points: 5 });
  expect(parseAlertAddArgs(["AAPL", "news", "share", "buyback"], undefined)).toEqual({ kind: "news", symbol: "AAPL", keyword: "share buyback" });
  expect(parseAlertAddArgs(["news", "rate", "cut"], undefined)).toEqual({ kind: "news", symbol: null, keyword: "rate cut" });
  expect(parseAlertAddArgs(["NVDA", "flow", "5m", "calls", "sweeps"], undefined)).toEqual({ kind: "flow", symbol: "NVDA", premium: 5_000_000, side: "calls", print: "sweep" });
  expect(parseAlertAddArgs(["flow"], undefined)).toEqual({ kind: "flow", symbol: null, premium: 1_000_000, side: "any", print: "any" });
  // A symbol that spells a form word is still a price alert.
  expect(parseAlertAddArgs(["NEWS", "above", "10"], undefined)).toMatchObject({ kind: "price", symbol: "NEWS", price: 10 });

  expect(() => parseAlertAddArgs(["IBIT", "iv", "50"], undefined)).toThrow("An iv alert takes above or below and a level");
  expect(() => parseAlertAddArgs(["IBIT", "iv", "above", "900"], undefined)).toThrow("1 to 500");
  expect(() => parseAlertAddArgs(["AAPL271217C00300000", "iv", "above", "5"], undefined)).toThrow("iv spike 5");
  expect(() => parseAlertAddArgs(["NVDA", "flow", "10k"], undefined)).toThrow("$50,000");
  expect(() => parseAlertAddArgs(["AAPL", "news", "buyback"], "3")).toThrow("--days is for earnings");
});

test("an IV level from the shell is the rule the dialog saves, on the listing quote reads, in the list released versions never read", async () => {
  const { events, error, printed, pluginState } = await addAlert(["aapl", "iv", "above", "35%"]);
  expect(error).toBeNull();
  expect(events).toHaveLength(1);
  expect(Object.keys(pluginState)).toEqual(["ivLevelAlerts"]);
  expect(events[0]).toMatchObject({ kind: "iv_level", target: "rule", status: "active" });
  expect(JSON.parse(events[0]!.value)).toEqual({ version: 1, symbol: "AAPL", exchange: "US", metric: "atm", direction: "above", threshold: 35 });
  expect(printed!.options!.text!(printed!.result.data)).toContain("IV level AAPL · 30d ATM IV above 35% (the app checks it every 15 minutes while it is running");
});

test("the far-target refusal is exactly past ten times either way, and writes prices as typed, never in exponent form", () => {
  expect(farTargetMessage("XYZ", 100, 10, null)).toBeNull();
  expect(farTargetMessage("XYZ", 1, 10, null)).toBeNull();
  expect(farTargetMessage("XYZ", 0.999, 10, null)).toBe("A target of 0.999 is under 1/10 of XYZ's last price of 10. Check the price and the symbol.");
  expect(farTargetMessage("XYZ", 1, 0.0000001234, null)).toBe("A target of 1 is more than 10 times XYZ's last price of 0.0000001234. Check the price and the symbol.");
  expect(farTargetMessage("XYZ", 0.00000001, 1, null)).toBe("A target of 0.00000001 is under 1/10 of XYZ's last price of 1. Check the price and the symbol.");
  // No price to measure against: nothing is refused.
  expect(farTargetMessage("XYZ", 85_000, 0, null)).toBeNull();
});

/**
 * China's week as Gloom Cloud lists it on Sat 24 Oct 2026 (or at `now`), with a US PMI and the FOMC decision beside it, from
 * the stored calendar, and the FOMC meeting the rate path lists. `printed` gives NBS Manufacturing PMI its figure; `offline`
 * answers nothing.
 */
function serveCalendar({ now = "2026-10-24T06:00:00Z", printed = false, offline = false } = {}) {
  const nbs = { name: "National Bureau of Statistics" };
  const row = (date: string, country: string, impact: string, event: string, extra: Record<string, unknown> = {}) => ({
    id: `${country}-${event}-${date}`, date, time: date.slice(11, 16), country, event, impact, actual: null, forecast: null, prior: null, ...extra,
  });
  const events = [
    row("2026-10-26T00:00:00.000Z", "CN", "medium", "Communist Party Fifth Plenum", { time: "All Day" }),
    row("2026-10-27T01:30:00.000Z", "CN", "low", "Industrial Profits (YTD) YoY", { prior: "15.7%", source: nbs }),
    row("2026-10-31T01:30:00.000Z", "CN", "medium", "NBS Non Manufacturing PMI", { prior: "50.2", source: nbs }),
    row("2026-10-31T01:30:00.000Z", "CN", "high", "NBS Manufacturing PMI", { prior: "50.1", source: nbs, ...printed ? { actual: "50.3" } : {} }),
    row("2026-10-28T18:00:00.000Z", "US", "high", "Fed Interest Rate Decision", { prior: "4%", source: { name: "Federal Reserve" } }),
    row("2026-11-02T14:00:00.000Z", "US", "high", "ISM Manufacturing PMI", { prior: "49.1" }),
  ];
  const ratePath = {
    asOf: null, fetchedAt: now, stale: false, status: "available", gaps: [], fedFunds: [], sofr: [], ghosts: [],
    current: { effr: {}, targetLower: {}, targetUpper: {} }, dotPlot: { points: [] }, schedule: {},
    meetings: [{ date: "2026-10-28", impliedRate: null, percentile: null, samples: 0, probabilities: [] }],
  };
  setSystemTime(new Date(now));
  setCloudApiFetchTransport(async (url) => {
    if (offline) throw new TypeError("fetch failed");
    const path = new URL(url).pathname;
    return {
      ok: true, status: 200, headers: new Headers(),
      text: async () => JSON.stringify(path.endsWith("/rate-path") ? ratePath : path.endsWith("/calendar/history") ? { events, storedFrom: "2026-01-01" } : events),
    } as Response;
  });
}

test("an economic calendar event from the shell is matched by name, kept in its own list, and says what it was read as", async () => {
  serveCalendar();
  for (const args of [["NBS PMI"], ["CN", "PMI"], ["pmi", "--country", "cn"]]) {
    const { events, error, printed, pluginState } = await addAlert(args);
    expect(error).toBeNull();
    // Released versions read eventAlerts whole, so a kind they do not know goes in a list of its own.
    expect(Object.keys(pluginState)).toEqual(["calendarAlerts"]);
    expect(events[0]).toMatchObject({ kind: "calendar_event", eventDate: "2026-10-31" });
    expect(JSON.parse(events[0]!.value)).toEqual({ version: 1, event: "NBS Manufacturing PMI", country: "CN", publisher: "National Bureau of Statistics", leadDays: 1 });
    expect(printed!.options!.text!(printed!.result.data)).toContain(
      "NBS Manufacturing PMI (CN) on Sat 2026-10-31 01:30 UTC, 1 day before and when it prints (the app alerts on 2026-10-30, and with the actual, forecast and prior once out, only while it is running).");
    expect(printed!.result.warnings).toContain("Also matching: NBS Non Manufacturing PMI (CN). To follow one of them instead: alerts add \"NBS Non Manufacturing PMI\" --country CN.");
  }
  const profits = await addAlert(["Industrial", "Profits", "--country", "CN", "--days", "2"]);
  expect(profits.printed!.result.warnings).toEqual(['Read "Industrial Profits" as Industrial Profits (YTD) YoY (CN), low impact.']);
  expect(JSON.parse(profits.events[0]!.value)).toMatchObject({ event: "Industrial Profits (YTD) YoY", leadDays: 2 });
  // An all-day event prints no figures, so it alerts only before.
  const plenum = await addAlert(["Fifth Plenum"]);
  expect(plenum.printed!.options!.text!(plenum.printed!.result.data)).toContain(
    "Communist Party Fifth Plenum (CN) on Mon 2026-10-26, all day, 1 day before (the app alerts on 2026-10-25, only while it is running).");
});

test("a calendar name that is ambiguous or matches nothing is refused with the way to name it, and nothing is stored", async () => {
  serveCalendar();
  const several = await addAlert(["PMI"]);
  expect(several.error).toBe('"PMI" is listed for several countries: NBS Manufacturing PMI (CN), ISM Manufacturing PMI (US). Name the country: alerts add PMI --country CN.');
  const slip = await addAlert(["NBP", "PMI"]);
  expect(slip.error).toContain('No kind of alert and no release in the economic calendar matches "NBP PMI". Did you mean NBS Manufacturing PMI (CN), NBS Non Manufacturing PMI (CN)?');
  // Every refusal of words no form reads names every kind there is, rather than the calendar alone.
  for (const { error } of [slip, await addAlert(["AAPL", "abve", "250"]), await addAlert(["XLE", "dividend", "cut"])]) {
    expect(error).toContain("52-week range, unusual volume, SEC filing, insider trade, short interest");
    expect(error).toContain("gloom help alerts shows how to type each");
  }
  // A bare word that only starts a name, or is its initials, is offered rather than added.
  const bare = await addAlert(["MAN"]);
  expect(bare.error).toContain('No kind of alert and no release in the economic calendar matches "MAN". Did you mean NBS Manufacturing PMI (CN), ISM Manufacturing PMI (US)');
  expect([several, slip, bare].map((attempt) => attempt.events)).toEqual([[], [], []]);
  // With no calendar to look a bare word up in, it still says what each form takes.
  serveCalendar({ offline: true });
  const offline = await addAlert(["AAPL"]);
  expect(offline.error).toStartWith('Unknown event "AAPL": the economic calendar could not be loaded to look it up');
  expect(offline.error).toContain("gloom alerts add takes price, P/E, P/S or RSI");
});

test("the FOMC's calendar row by name is the FOMC alert, and a release already out today is followed to its next listing", async () => {
  serveCalendar();
  const fed = await addAlert(["Fed", "Interest", "Rate", "Decision"]);
  expect(fed.error).toBeNull();
  // The rule `alerts add FOMC` saves, so the one duplicate check refuses the other.
  expect(fed.events).toMatchObject([{ kind: "macro_event", eventDate: "2026-10-28" }]);
  expect(JSON.parse(fed.events[0]!.value)).toEqual({ version: 1, event: "fomc", leadDays: 1 });
  expect(fed.printed!.result.warnings).toEqual(['Read "Fed Interest Rate Decision" as the FOMC decision alert, which follows Fed Interest Rate Decision (US).']);

  // An hour after the decision: the alert says it is out, rather than promising an alert at the next check.
  serveCalendar({ now: "2026-10-28T19:00:00Z" });
  const late = await addAlert(["FOMC"]);
  expect(late.printed!.options!.text!(late.printed!.result.data)).toContain(
    "FOMC decision on 2026-10-28, 1 day before and when it prints (it came out today at 18:00 UTC, so the app alerts before the next one");
  // A release that printed earlier today follows its next listing, none here yet.
  serveCalendar({ now: "2026-10-31T03:00:00Z", printed: true });
  const pmi = await addAlert(["NBS", "Manufacturing", "PMI"]);
  expect(pmi.events[0]!.eventDate).toBeUndefined();
  expect(pmi.printed!.options!.text!(pmi.printed!.result.data)).toContain("the app alerts once the calendar lists its next date");
});

test("XLK/SPY quoting nothing is the two listings' ratio, kept apart from older apps' lists with its dated reading", async () => {
  setSystemTime(new Date("2026-10-27T12:00:00Z"));
  const etf = (symbol: string) => createTestQuote({ symbol, name: symbol, price: 100, listingExchangeName: "ARCA", exchangeName: "ARCA", instrumentType: "ETF" });
  const quotes: Record<string, Quote> = { XLK: etf("XLK"), SPY: etf("SPY"), XLE: etf("XLE") };
  const days: string[] = [];
  for (let time = Date.parse("2026-05-01"); time <= Date.parse("2026-10-26"); time += 86_400_000) {
    const day = new Date(time).toISOString().slice(0, 10);
    if (getPublishedUsEquitySession("ARCA", day)?.kind === "session") days.push(day);
  }
  const close = (symbol: string, day: string) => symbol === "XLK" ? (day === "2026-10-26" ? 24.34 : 24) : symbol === "XLE" ? 50 : 100;
  const dataProvider = createTestDataProvider({
    getQuotesBatch: async (targets: QuoteSubscriptionTarget[]): Promise<QuoteBatchResult[]> => targets.map((target) => {
      const quote = quotes[target.symbol.split(":")[0]!];
      return quote ? { target, quote } : { target, quote: null, error: `Not a ticker: ${target.symbol}.` };
    }),
    getDetailedPriceHistory: async (symbol: string) => days.map((day) => ({ date: new Date(day), open: 1, high: 1, low: 1, close: close(symbol, day), volume: 1 })),
  });
  const add = async (args: string[]) => {
    const dataDir = await mkdtemp(join(tmpdir(), "gloomberb-alerts-relative-"));
    dataDirs.push(dataDir);
    const config = createDefaultConfig(dataDir);
    await saveConfig(config);
    const cli = createTestCliContext({ config, dataProvider });
    const error = await Promise.resolve(alertsCliCommand.execute(["add", ...args], cli.context)).then(() => null, (thrown: Error) => thrown.message);
    const saved = await loadConfig(dataDir);
    const printed = cli.printed[0];
    return { error, stored: readAlertStores(saved).alerts, pluginState: saved.pluginConfig.alerts ?? {}, text: printed?.options?.text?.(printed.result.data) };
  };

  const ratio = await add(["XLK/SPY", "above", "0.25"]);
  expect(ratio.error).toBeNull();
  expect(ratio.stored).toMatchObject([{ symbol: "XLK", exchange: "ARCA", condition: "above", targetPrice: 0.25, lastCheckedPrice: 0.2434, lastDailyClose: "2026-10-26",
    metric: { kind: "rs_ratio", benchmark: "SPY", benchmarkExchange: "ARCA" } }]);
  expect(JSON.parse(String(ratio.pluginState.relativeAlerts))).toHaveLength(1);
  expect(JSON.parse(String(ratio.pluginState.metricAlerts ?? "[]"))).toEqual([]);
  expect(ratio.text).toContain("XLK ratio to SPY above 0.25 · on daily close (the app alerts while it is running;");
  expect(ratio.text).toContain("Ratio to SPY was 0.2434 on the 2026-10-26 close. First checked on the 2026-10-27 close, from 20:30 UTC.");

  const rrg = await add(["XLE", "rrg", "leading"]);
  expect(rrg.error).toBeNull();
  expect(rrg.stored).toMatchObject([{ symbol: "XLE", condition: "crosses", targetPrice: 0, lastDailyClose: "2026-10-23",
    metric: { kind: "rrg", quadrant: "leading", benchmark: "SPY", benchmarkExchange: "ARCA" } }]);
  expect(rrg.text).toContain("XLE RRG vs SPY enters Leading · on weekly close (the app alerts while it is running;");
  // An RRG quadrant is first judged on the week's last session, Friday the 30th.
  expect(rrg.text).toContain("RRG vs SPY was Neutral (strength 100.00, momentum 100.00) on the 2026-10-23 weekly close. First checked on the 2026-10-30 weekly close, from 20:30 UTC.");

  expect((await add(["XLE", "rs", "above", "100"])).error).toContain("alerts add XLK/SPY above 0.25, or alerts add XLE rrg leading");
  expect((await add(["XLK/SPY", "above", "0.25", "--benchmark", "QQQ"])).error).toContain("--benchmark takes the listing an RRG alert is measured against");
  expect((await add(["XLK/ZZZQQ9", "above", "0.25"])).error).toContain("Not a ticker: ZZZQQ9.");
});

/** One profile across several `alerts` commands, with the device state the alert log lives in. */
async function profile() {
  // Tue 27 Oct 2026, 03:30 in New York: between sessions, AAPL's after-hours print is its latest price.
  setSystemTime(new Date("2026-10-27T07:30:00Z"));
  const dataDir = await mkdtemp(join(tmpdir(), "gloomberb-alerts-desk-"));
  dataDirs.push(dataDir);
  await saveConfig(createDefaultConfig(dataDir));
  const state = new Map<string, unknown>();
  const persistence = {
    close: () => {},
    pluginState: {
      get: (plugin: string, key: string) => state.has(`${plugin}:${key}`) ? { value: state.get(`${plugin}:${key}`) } : null,
      set: (plugin: string, key: string, value: unknown) => { state.set(`${plugin}:${key}`, value); },
    },
  };
  const run = async (args: string[], options: Partial<CliGlobalOptions> = {}) => {
    const cli = createTestCliContext({ config: await loadConfig(dataDir), dataProvider: cloud(), persistence }, options);
    try {
      await alertsCliCommand.execute(args, cli.context);
    } catch (thrown) {
      return { error: (thrown as Error).message, printed: undefined, output: "" };
    }
    const printed = cli.printed[0]!;
    return { error: null, printed, output: serializeCliResult(printed.result, cli.context.cliOptions, printed.options) };
  };
  const log = () => readFiredAlerts(state.get(`${ALERTS_PLUGIN_ID}:${resumeStateKey(FIRED_LOG_KEY)}`));
  // The session the app saves after sign-in, as the CLI reads it.
  const signIn = () => state.set("gloomberb-cloud:session", { sessionToken: "session-token" });
  return { dataDir, run, log, signIn, stored: async () => readAlertStores(await loadConfig(dataDir)) };
}

test("a second add of one alert names it and adds nothing, re-arming an active one leaves it, and each change is logged", async () => {
  const desk = await profile();
  const added = await desk.run(["add", "AAPL", "above", "260"]);
  const id = added.printed!.result.data.alert.id as string;
  expect(await desk.run(["add", "aapl", "above", "260"])).toMatchObject({ error: `AAPL:NASDAQ above 260 already exists as alert ${id}. Nothing was added.` });
  expect((await desk.stored()).alerts.map((alert) => alert.id)).toEqual([id]);
  // Another level on the same listing is another alert.
  const other = await desk.run(["add", "AAPL", "above", "270"]);
  expect(other.error).toBeNull();

  const active = await desk.run(["rearm", id]);
  expect(active.printed!.result.data).toMatchObject({ changed: false, active: true });
  expect(active.output).toContain(`Alert ${id} is already active; nothing to re-arm.`);
  // Once it has gone off, re-arming arms it again, and a duplicate names it with the way back.
  const config = await loadConfig(desk.dataDir);
  const [first, ...rest] = (await desk.stored()).alerts;
  config.pluginConfig.alerts = { ...config.pluginConfig.alerts, alerts: JSON.stringify([{ ...first, status: "triggered", triggeredAt: Date.now() }, ...rest]) };
  await saveConfig(config);
  expect((await desk.run(["add", "AAPL", "above", "260"])).error).toContain(`re-arm it with gloom alerts rearm ${id}`);
  expect((await desk.run(["rearm", id])).printed!.result.data).toMatchObject({ changed: true });
  expect((await desk.stored()).alerts.find((alert) => alert.id === id)?.status).toBe("active");
  await desk.run(["delete", id]);
  await desk.run(["add", "AAPL", "above", "280"], { dryRun: true });

  // Beside the alerts that fired, the device's log keeps what was done to each rule here; a dry run changes nothing.
  expect(desk.log().map((entry) => [entry.action, entry.ruleId === id, entry.rule])).toEqual([
    ["created", true, "AAPL:NASDAQ above 260"],
    ["created", false, "AAPL:NASDAQ above 270"],
    ["rearmed", true, "AAPL:NASDAQ above 260"],
    ["deleted", true, "AAPL:NASDAQ above 260"],
  ]);
});

test("alerts list --csv keeps its columns in their order and adds when each alert was made, its listing, currency and last reading", async () => {
  const desk = await profile();
  await desk.run(["add", "AAPL", "above", "260"]);
  // A rule saved before any check (an older version's, or one just re-armed) says it has not been read.
  const config = await loadConfig(desk.dataDir);
  const unchecked = { ...createAlert("LINK", "below", 4), createdAt: Date.parse("2026-10-20T09:30:00Z") };
  config.pluginConfig.alerts = { ...config.pluginConfig.alerts, alerts: JSON.stringify([...JSON.parse(config.pluginConfig.alerts!.alerts as string), unchecked]) };
  await saveConfig(config);

  const csv = (await desk.run(["list"], { format: "csv" })).output.split("\n");
  expect(csv[0]).toBe("id,kind,target,trigger,eventDate,status,lastCheckedPrice,triggeredAt,createdAt,listing,currency,lastReading,lastReadingAt");
  const rows = csv.slice(1).map((line) => line.split(","));
  // Its first reading is the price it was added at, as the app checks it (after hours, the after-hours price).
  expect(rows[0]!.slice(1, 7)).toEqual(["Price", "AAPL", "above 260", "", "active", "300"]);
  expect(rows[0]![8]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  expect(rows[0]!.slice(9, 11)).toEqual(["AAPL:NASDAQ", "USD"]);
  expect(rows[0]![11]).toMatch(/^300 USD as of \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/);
  expect(rows[0]![12]).toMatch(/Z$/);
  expect(rows[1]!.slice(8)).toEqual(["2026-10-20T09:30:00Z", "LINK", "", "not checked yet", ""]);
  // Gloom Cloud checks a 52-week rule for a signed-in account; signed out, nothing has read it yet.
  expect((await desk.run(["add", "AAPL", "52-week", "high"])).error).toBeNull();
  const [, , , research] = (await desk.run(["list"], { format: "csv" })).output.split("\n");
  expect(research!.split(",").slice(1, 3)).toEqual(["52-week range", "AAPL · 52w high"]);
  expect(research!.split(",")[5]).toBe("needs sign-in");
  expect(research!.split(",").slice(9)).toEqual(["AAPL", "", "not checked yet", ""]);

  const text = (await desk.run(["list"])).output;
  expect(text).toContain("AAPL:NASDAQ (USD)");
  expect(text).toContain("not checked yet");
  expect(text).toContain("2026-10-20T09:30:00Z");
});

test("an alert only a signed-in account gets checked is saved signed out and reads needs sign-in until a session is saved", async () => {
  const desk = await profile();
  const added = await desk.run(["add", "AAPL", "filing", "10-Q"]);
  expect(added.error).toBeNull();
  expect(added.printed!.result.data.status).toBe("needs sign-in");
  expect(added.output).toContain("It needs sign-in: nothing checks it while you are signed out.");
  // The app checks an IV level itself, signed in or not.
  expect((await desk.run(["add", "AAPL", "iv", "above", "35%"])).output).not.toContain("needs sign-in");
  expect((await desk.stored()).events.rules).toHaveLength(2);

  const list = await desk.run(["list"], { format: "csv" });
  expect(list.output.split("\n").slice(1).map((line) => line.split(",").slice(1, 6))).toEqual([
    ["SEC filing", "AAPL · 10-Q", "", "", "needs sign-in"],
    ["IV level", "AAPL · 30d ATM IV above 35%", "", "", "active"],
  ]);
  expect(list.printed!.result.warnings).toContain("1 event alert needs sign-in: it is checked only for a signed-in account. "
    + "Open the app (gloom) and log in or sign up free from the command bar (Ctrl+P, Log In or Sign Up).");

  desk.signIn();
  // Cloud's readings are asked for with the saved session; here it does not answer.
  setCloudApiFetchTransport(async () => { throw new TypeError("fetch failed"); });
  const signedIn = await desk.run(["list"], { format: "csv" });
  expect(signedIn.output.split("\n")[1]!.split(",")[5]).toBe("active");
  // The command keeps the saved session once it set it, so a lookup running beside Cloud's readings never loses it.
  expect(apiClient.getSessionToken()).toBe("session-token");
  expect(signedIn.printed!.result.warnings?.some((warning) => warning.includes("needs sign-in"))).toBe(false);
  expect((await desk.run(["add", "AAPL", "filing", "8-K"])).output).not.toContain("needs sign-in");
});

test("alerts add takes every kind Add Event Alert offers, by the words a desk types", () => {
  const rule = (words: string) => parseAlertAddArgs(words.split(" "), undefined);
  expect(rule("XLE 52-week high")).toEqual({ kind: "rule", event: "fifty_two_week", symbol: "XLE", listing: "us", values: { direction: "high" } });
  expect(rule("XLE 52w low")).toMatchObject({ event: "fifty_two_week", values: { direction: "low" } });
  expect(rule("NVDA unusual volume 3x")).toMatchObject({ event: "unusual_volume", values: { threshold: "3" } });
  expect(rule("NVDA unusual volume")).toMatchObject({ values: { threshold: "2" } });
  expect(rule("AAPL filing 10q")).toMatchObject({ event: "filing_type", values: { form: "10-Q" } });
  expect(rule("AAPL filings SC 13G/A")).toMatchObject({ values: { form: "SCHEDULE 13G/A" } });
  expect(rule("TSLA insider sell")).toMatchObject({ event: "insider_trade", values: { direction: "sell" } });
  expect(rule("GME short interest increase 20%")).toMatchObject({ event: "short_interest_change", values: { direction: "increase", threshold: "20" } });
  expect(rule("AAPL analyst downgrade")).toMatchObject({ event: "analyst_change", values: { direction: "downgrade" } });
  expect(rule("ADYEN:AMS hiring slowing")).toMatchObject({ event: "hiring_move", listing: "any", values: { direction: "slowing" } });
  expect(rule("perps hyperliquid:default:BTC funding above 0.05%")).toMatchObject({
    event: "perps_threshold", symbol: null, values: { marketId: "hyperliquid:default:BTC", metric: "funding8h", direction: "above", threshold: "0.05" } });
  // A market id keeps its case past the venue, as Add Event Alert saves it; only the venue is lowered.
  expect(rule("perps Hyperliquid:default:kPEPE oi below -10%")).toMatchObject({ values: { marketId: "hyperliquid:default:kPEPE", metric: "oiChange24h" } });
  expect(rule("perps hyperliquid:xyz:TSLA closed premium above 1%")).toMatchObject({ values: { marketId: "hyperliquid:xyz:TSLA", metric: "closedMarketPremium" } });
  expect(rule("PFE catalyst")).toMatchObject({ event: "catalyst-ticker", symbol: "PFE" });
  expect(rule("catalyst type clinical")).toMatchObject({ event: "catalyst-type", symbol: null, values: { value: "clinical" } });
  expect(rule("congress")).toMatchObject({ event: "congress-watched" });
  expect(parseAlertAddArgs(["congress", "Nancy Pelosi"], undefined)).toMatchObject({ event: "congress-member", values: { value: "Nancy Pelosi" } });
  expect(rule("13f 1067983")).toMatchObject({ event: "thirteenf-fund", values: { value: "1067983" } });
  // A form mistyped names its own words; a symbol that spells a form word is still a price alert.
  expect(() => rule("XLE 52-week")).toThrow("Name the side: gloom alerts add XLE 52-week high");
  expect(() => rule("NVDA unusual volume 50x")).toThrow("1.1 to 20");
  expect(() => rule("AAPL filing 8-Q")).toThrow("8-K, 10-K, 10-Q");
  expect(() => rule("catalyst type weather")).toThrow("A catalyst type is one of");
  expect(() => rule("13f berkshire")).toThrow("numeric SEC CIK");
  expect(() => parseAlertAddArgs(["XLE", "52-week", "high"], "2")).toThrow("--days is for earnings");
  expect(rule("PERPS above 10")).toMatchObject({ kind: "price", symbol: "PERPS" });
  // `help alerts` lists every form, and an unknown phrase is refused with their names.
  const help = alertsCliCommand.help!.usage!.join("\n");
  for (const form of ["52-week <high|low>", "unusual volume", "filing [8-K", "insider [buy|sell]", "short interest", "analyst [upgrade|downgrade]", "hiring", "perps <market>", "<symbol> catalyst", "catalyst [type", "congress", "13f <fund CIK>"]) {
    expect(help).toContain(form);
  }
});

test("a daily technical alert is saved while its close cannot be read yet, and says when it is first checked", async () => {
  const desk = await profile();
  // This connection serves no daily history: the rule is kept, unread, rather than refused.
  const added = await desk.run(["add", "AAPL", "rsi(14)", "above", "70"]);
  expect(added.error).toBeNull();
  expect(added.output).toMatch(/Not read yet: .+\. First checked on the 2026-10-27 close, from 20:30 UTC\./);
  expect(added.printed!.result.data).toMatchObject({ unread: expect.any(String), firstCheck: { close: "2026-10-27", at: "2026-10-27T20:30:00Z" } });
  const [saved] = (await desk.stored()).alerts;
  expect(saved).toMatchObject({ symbol: "AAPL", metric: { kind: "rsi", period: 14 }, status: "active", lastQuoteCurrency: "USD" });
  expect(saved!.lastCheckedPrice).toBeUndefined();
});
