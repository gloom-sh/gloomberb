import { afterEach, describe, expect, test } from "bun:test";
import { createGloomberbCloudCapabilities, GloomberbCloudProvider } from "./index";
import { getRangeStartDate, toHistoryRequest } from "./normalizers";
import type { NewsCapability } from "../../capabilities";
import { apiClient, type AuthUser, type CloudNewsPayload } from "../../api-client";

const verifiedUser: AuthUser = {
  id: "user-1",
  name: "Test User",
  email: "test@example.com",
  username: "test",
  emailVerified: true,
  image: null,
  createdAt: "2026-03-30T00:00:00.000Z",
  updatedAt: "2026-03-30T00:00:00.000Z",
};

const originalEnsureVerifiedSession = apiClient.ensureVerifiedSession.bind(apiClient);
const originalGetCloudHistory = apiClient.getCloudHistory.bind(apiClient);
const originalGetCloudQuote = apiClient.getCloudQuote.bind(apiClient);
const originalGetCloudHolders = apiClient.getCloudHolders.bind(apiClient);
const originalGetCloudAnalystResearch = apiClient.getCloudAnalystResearch.bind(apiClient);
const originalGetCloudCorporateActions = apiClient.getCloudCorporateActions.bind(apiClient);
const originalGetCloudOptionsChain = apiClient.getCloudOptionsChain.bind(apiClient);
const originalGetCloudNews = apiClient.getCloudNews.bind(apiClient);
const originalGetCloudNewsStory = apiClient.getCloudNewsStory.bind(apiClient);
const originalSubscribeQuotes = apiClient.subscribeQuotes.bind(apiClient);

test("requests fifty years of cloud history for the ALL range", () => {
  const endDate = new Date("2026-07-30T20:00:00.000Z");

  expect(getRangeStartDate("ALL", endDate).toISOString()).toBe("1976-07-30T20:00:00.000Z");
  expect(toHistoryRequest("ALL")).toEqual({
    interval: "1month",
    outputsize: 600,
    rangeKey: "ALL",
  });
});

function makeCloudNewsPayload(overrides: Partial<CloudNewsPayload> = {}): CloudNewsPayload {
  return {
    id: "story-1",
    headline: "Apple raises guidance",
    summary: "Apple lifted its outlook after stronger iPhone demand.",
    topic: "guidance",
    topics: ["guidance"],
    category: "guidance",
    sentiment: "positive",
    sectors: ["information_technology"],
    firstPublishedAt: "2026-04-01T10:00:00.000Z",
    lastPublishedAt: "2026-04-01T10:05:00.000Z",
    firstSeenAt: "2026-04-01T10:00:10.000Z",
    lastSeenAt: "2026-04-01T10:05:10.000Z",
    primaryUrl: "https://example.com/aapl-guidance",
    primarySource: "example-wire",
    scores: {
      importance: 91,
      urgency: 74,
      marketImpact: 88,
      novelty: 86,
      confidence: 95,
    },
    flags: {
      breaking: true,
      developing: false,
      stale: false,
    },
    variantCount: 1,
    sourceCount: 1,
    sources: ["example-wire"],
    entities: [],
    tickerLinks: [{
      symbol: "AAPL",
      exchange: "XNAS",
      canonicalTicker: "AAPL:XNAS",
      relationType: "direct",
      displayTier: "primary",
      confidence: 0.98,
      relevanceScore: 95,
      impactScore: 93,
      sentiment: "positive",
    }],
    ...overrides,
  };
}

afterEach(() => {
  apiClient.ensureVerifiedSession = originalEnsureVerifiedSession;
  apiClient.getCloudHistory = originalGetCloudHistory;
  apiClient.getCloudQuote = originalGetCloudQuote;
  apiClient.getCloudHolders = originalGetCloudHolders;
  apiClient.getCloudAnalystResearch = originalGetCloudAnalystResearch;
  apiClient.getCloudCorporateActions = originalGetCloudCorporateActions;
  apiClient.getCloudOptionsChain = originalGetCloudOptionsChain;
  apiClient.getCloudNews = originalGetCloudNews;
  apiClient.getCloudNewsStory = originalGetCloudNewsStory;
  apiClient.subscribeQuotes = originalSubscribeQuotes;
});

describe("GloomberbCloudProvider", () => {
  test("fetches detailed intraday chart history with Twelve Data intervals", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;

    const requestArgs: { current: { symbol: string; exchange: string; params: Record<string, string | number | undefined> } | null } = { current: null };
    apiClient.getCloudHistory = async (symbol, exchange, params = {}) => {
      requestArgs.current = { symbol, exchange, params };
      return {
        status: "success",
        data: [{
          date: "2026-03-27 10:15:00",
          close: 250.12,
        }],
      };
    };

    const provider = new GloomberbCloudProvider();
    const history = await provider.getDetailedPriceHistory(
      "AAPL",
      "NASDAQ",
      new Date("2026-03-27T14:00:00Z"),
      new Date("2026-03-27T16:00:00Z"),
      "15m",
    );

    expect(requestArgs.current).toEqual({
      symbol: "AAPL",
      exchange: "NASDAQ",
      params: {
        interval: "15min",
        startDate: "2026-03-27 10:00:00",
        endDate: "2026-03-27 12:00:00",
      },
    });
    expect(history).toHaveLength(1);
    expect(history[0]?.close).toBe(250.12);
    expect(history[0]?.date.toISOString()).toBe("2026-03-27T14:15:00.000Z");
  });

  test("rejects isolated cloud OHLC spikes so another history source can be used", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;
    apiClient.getCloudHistory = async () => ({
      status: "success",
      data: [
        {
          date: "2026-07-29T20:46:00Z",
          open: 728.4,
          high: 728.7,
          low: 728.3,
          close: 728.5,
          volume: 0,
        },
        {
          date: "2026-07-29T20:47:00Z",
          open: 686.98,
          high: 728.67,
          low: 686.98,
          close: 728.6,
          volume: 0,
        },
        {
          date: "2026-07-29T20:48:00Z",
          open: 728.6,
          high: 728.7,
          low: 728.1,
          close: 728.3,
          volume: 0,
        },
      ],
    });

    const provider = new GloomberbCloudProvider();

    await expect(
      provider.getPriceHistoryForResolution("SPY", "NYSEARCA", "1W", "1m"),
    ).rejects.toThrow("failed OHLC validation");
  });

  test("validates an outlier after normalizing descending cloud history", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;
    apiClient.getCloudHistory = async () => ({
      status: "success",
      data: [
        {
          date: "2026-07-29T20:48:00Z",
          open: 728.6,
          high: 728.7,
          low: 728.1,
          close: 728.3,
          volume: 0,
        },
        {
          date: "2026-07-29T20:47:00Z",
          open: 686.98,
          high: 728.67,
          low: 686.98,
          close: 728.6,
          volume: 0,
        },
        {
          date: "2026-07-29T20:46:00Z",
          open: 728.4,
          high: 728.7,
          low: 728.3,
          close: 728.5,
          volume: 0,
        },
      ],
    });

    const provider = new GloomberbCloudProvider();

    await expect(
      provider.getPriceHistoryForResolution("SPY", "NYSEARCA", "1W", "1m"),
    ).rejects.toThrow("failed OHLC validation");
  });

  test("preserves a wide cloud bar during a continuing price move", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;
    apiClient.getCloudHistory = async () => ({
      status: "success",
      data: [
        {
          date: "2026-07-29T20:10:00Z",
          open: 561.1,
          high: 561.3,
          low: 560.7,
          close: 560.8994,
        },
        {
          date: "2026-07-29T20:15:00Z",
          open: 560.11,
          high: 585.61,
          low: 553.41,
          close: 555.4,
        },
        {
          date: "2026-07-29T20:20:00Z",
          open: 555.2,
          high: 556,
          low: 548.9,
          close: 549.01,
        },
      ],
    });

    const provider = new GloomberbCloudProvider();
    const history = await provider.getPriceHistoryForResolution(
      "META",
      "NASDAQ",
      "1W",
      "5m",
    );

    expect(history).toHaveLength(3);
  });

  test("does not reject an explicitly Yahoo-backed cloud history response", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;
    apiClient.getCloudHistory = async () => ({
      status: "success",
      providerMeta: { provider: "yahoo" },
      data: [
        { date: "2026-07-29T20:46:00Z", close: 728.5 },
        {
          date: "2026-07-29T20:47:00Z",
          open: 686.98,
          high: 728.67,
          low: 686.98,
          close: 728.6,
          volume: 0,
        },
        { date: "2026-07-29T20:48:00Z", close: 728.3 },
      ],
    });

    const provider = new GloomberbCloudProvider();
    const history = await provider.getPriceHistoryForResolution(
      "SPY",
      "NYSEARCA",
      "1W",
      "1m",
    );

    expect(history[1]?.low).toBe(686.98);
  });

  test("normalizes daily detailed history requests to 1day", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;

    const requestArgs: { current: Record<string, string | number | undefined> | null } = { current: null };
    apiClient.getCloudHistory = async (_symbol, _exchange, params = {}) => {
      requestArgs.current = params;
      return {
        status: "success",
        data: [],
      };
    };

    const provider = new GloomberbCloudProvider();
    await provider.getDetailedPriceHistory(
      "AAPL",
      "NASDAQ",
      new Date(2026, 0, 1, 0, 0, 0),
      new Date(2026, 2, 27, 0, 0, 0),
      "1d",
    );

    expect(requestArgs.current).toEqual({
      interval: "1day",
      startDate: "2026-01-01",
      endDate: "2026-03-27",
    });
  });

  test("fetches fixed-resolution chart history with the requested interval", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;

    const requestArgs: { current: Record<string, string | number | undefined> | null } = { current: null };
    apiClient.getCloudHistory = async (_symbol, _exchange, params = {}) => {
      requestArgs.current = params;
      return {
        status: "success",
        data: [{
          date: "2026-03-27",
          close: 250.12,
        }],
      };
    };

    const provider = new GloomberbCloudProvider();
    const history = await provider.getPriceHistoryForResolution("AAPL", "NASDAQ", "1Y", "1wk");

    expect(requestArgs.current?.interval).toBe("1week");
    expect(requestArgs.current?.startDate).toBeDefined();
    expect(requestArgs.current?.endDate).toBeDefined();
    expect(history[0]?.close).toBe(250.12);
  });

  test("does not advertise unsupported 45 minute chart resolution", () => {
    const provider = new GloomberbCloudProvider();
    expect(provider.getChartResolutionCapabilities()).not.toContain("45m");
  });

  test("normalizes sub-unit cloud quotes to their main currency", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;
    apiClient.getCloudQuote = async () => ({
      status: "success",
      data: {
        symbol: "IQE",
        providerId: "gloomberb-cloud",
        price: 23.1,
        currency: "GBp",
        change: -1.4,
        changePercent: -5.71,
        previousClose: 24.5,
        lastUpdated: Date.now(),
        dataSource: "delayed",
      },
    });

    const provider = new GloomberbCloudProvider();
    const quote = await provider.getQuote("IQE", "LSE");

    expect(quote.currency).toBe("GBP");
    expect(quote.price).toBeCloseTo(0.231, 8);
    expect(quote.change).toBeCloseTo(-0.014, 8);
    expect(quote.previousClose).toBeCloseTo(0.245, 8);
  });

  test("normalizes sub-unit cloud history using the response currency metadata", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;
    apiClient.getCloudHistory = async () => ({
      status: "success",
      providerMeta: {
        currency: "GBp",
      },
      data: [{
        date: "2026-03-27 10:15:00",
        open: 22.55,
        high: 23.4,
        low: 22.1,
        close: 23.1,
      }],
    });

    const provider = new GloomberbCloudProvider();
    const history = await provider.getPriceHistory("IQE", "LSE", "1Y");

    expect(history[0]?.open).toBeCloseTo(0.2255, 8);
    expect(history[0]?.high).toBeCloseTo(0.234, 8);
    expect(history[0]?.low).toBeCloseTo(0.221, 8);
    expect(history[0]?.close).toBeCloseTo(0.231, 8);
  });

  test("normalizes LSE cloud history when the response reports a default currency", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;
    apiClient.getCloudHistory = async () => ({
      status: "success",
      currency: "USD",
      data: [{
        date: "2026-05-22",
        open: 407.5,
        high: 410,
        low: 350,
        close: 379,
      }],
    });

    const provider = new GloomberbCloudProvider();
    const history = await provider.getPriceHistory("FTC", "LSE", "1M");

    expect(history[0]?.open).toBeCloseTo(4.075, 8);
    expect(history[0]?.high).toBeCloseTo(4.1, 8);
    expect(history[0]?.low).toBeCloseTo(3.5, 8);
    expect(history[0]?.close).toBeCloseTo(3.79, 8);
  });

  test("fetches institutional holders from the cloud market endpoint", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;

    const requestArgs: { current: { symbol: string; exchange: string } | null } = { current: null };
    apiClient.getCloudHolders = async (symbol, exchange) => {
      requestArgs.current = { symbol, exchange: exchange ?? "" };
      return {
        status: "success",
        data: {
          providerId: "gloomberb-cloud",
          symbol: "AAPL",
          currency: "USD",
          exchange: "NASDAQ",
          asOf: "2026-03-31",
          holders: [{
            providerId: "gloomberb-cloud",
            ownerType: "institution",
            name: "Vanguard Group Inc",
            reportDate: "2026-03-31",
            shares: 1_250_000_000,
            value: 250_000_000_000,
            percentHeld: 0.085,
          }],
        },
      };
    };

    const provider = new GloomberbCloudProvider();
    const holders = await provider.getHolders("AAPL", "NASDAQ");

    expect(requestArgs.current).toEqual({ symbol: "AAPL", exchange: "NASDAQ" });
    expect(holders.providerId).toBe("gloomberb-cloud");
    expect(holders.holders[0]?.name).toBe("Vanguard Group Inc");
    expect(holders.holders[0]?.percentHeld).toBe(0.085);
  });

  test("fetches analyst research from the cloud market endpoint", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;

    const requestArgs: { current: { symbol: string; exchange: string } | null } = { current: null };
    apiClient.getCloudAnalystResearch = async (symbol, exchange) => {
      requestArgs.current = { symbol, exchange: exchange ?? "" };
      return {
        status: "success",
        data: {
          providerId: "gloomberb-cloud",
          symbol: "AAPL",
          currency: "USD",
          exchange: "NASDAQ",
          priceTarget: { average: 300, current: 270, currency: "USD" },
          recommendationRating: 8.2,
          recommendations: [{ period: "current month", strongBuy: 7, buy: 24, hold: 14, sell: 1, strongSell: 1 }],
          ratings: [{ date: "2026-04-17", firm: "BNP Paribas", action: "Upgrade", current: "Outperform", prior: "Neutral" }],
          earningsEstimates: [],
          revenueEstimates: [],
        },
      };
    };

    const provider = new GloomberbCloudProvider();
    const research = await provider.getAnalystResearch("AAPL", "NASDAQ");

    expect(requestArgs.current).toEqual({ symbol: "AAPL", exchange: "NASDAQ" });
    expect(research.priceTarget?.average).toBe(300);
    expect(research.ratings[0]?.firm).toBe("BNP Paribas");
  });

  test("fetches corporate actions from the cloud market endpoint", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;

    const requestArgs: { current: { symbol: string; exchange: string } | null } = { current: null };
    apiClient.getCloudCorporateActions = async (symbol, exchange) => {
      requestArgs.current = { symbol, exchange: exchange ?? "" };
      return {
        status: "success",
        data: {
          providerId: "gloomberb-cloud",
          symbol: "AAPL",
          currency: "USD",
          exchange: "NASDAQ",
          dividends: [{ exDate: "2026-02-09", amount: 0.26 }],
          splits: [],
          earnings: [{ date: "2026-01-29", epsEstimate: 2.67, epsActual: 2.84, difference: 0.17, surprisePercent: 6.37 }],
        },
      };
    };

    const provider = new GloomberbCloudProvider();
    const actions = await provider.getCorporateActions("AAPL", "NASDAQ");

    expect(requestArgs.current).toEqual({ symbol: "AAPL", exchange: "NASDAQ" });
    expect(actions.dividends[0]?.amount).toBe(0.26);
    expect(actions.earnings[0]?.surprisePercent).toBe(6.37);
  });

  test("fetches options chains from the cloud market endpoint", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;

    const requestArgs: { current: { symbol: string; exchange?: string; expirationDate?: number } | null } = { current: null };
    apiClient.getCloudOptionsChain = async (symbol, exchange, expirationDate) => {
      requestArgs.current = { symbol, exchange, expirationDate };
      return {
        status: "success",
        data: {
          providerId: "gloomberb-cloud",
          underlyingSymbol: "AMD",
          expirationDates: [1_800_000_000],
          dataSource: "live",
          feed: "opra",
          delayMinutes: 0,
          realtimeEligible: true,
          asOf: "2027-01-15T14:30:00.000Z",
          calls: [{
            contractSymbol: "AMD270917C00230000",
            strike: 230,
            currency: "USD",
            lastPrice: 11,
            change: 1,
            percentChange: 10,
            volume: 10,
            openInterest: 20,
            bid: 10,
            ask: 12,
            impliedVolatility: 0.4,
            inTheMoney: false,
            expiration: 1_800_000_000,
            lastTradeDate: 1_799_000_000,
          }],
          puts: [],
        },
      };
    };

    const provider = new GloomberbCloudProvider();
    const chain = await provider.getOptionsChain("AMD", "NASDAQ", 1_800_000_000);

    expect(requestArgs.current).toEqual({
      symbol: "AMD",
      exchange: "NASDAQ",
      expirationDate: 1_800_000_000,
    });
    expect(chain.underlyingSymbol).toBe("AMD");
    expect(chain.calls[0]?.contractSymbol).toBe("AMD270917C00230000");
    expect(chain).toMatchObject({
      providerId: "gloomberb-cloud",
      dataSource: "live",
      feed: "opra",
      delayMinutes: 0,
      realtimeEligible: true,
      asOf: "2027-01-15T14:30:00.000Z",
    });
  });

  test("preserves original target context when streaming quotes", () => {
    let unsubscribeCalled = false;
    const seenQuotes: Array<{ price: number; currency: string }> = [];
    apiClient.subscribeQuotes = (_targets, onQuote) => {
      onQuote(
        { symbol: "AAPL", exchange: "NASDAQ" },
        {
          symbol: "AAPL",
          providerId: "gloomberb-cloud",
          price: 23.1,
          currency: "GBp",
          change: -1.4,
          changePercent: 0.5,
          lastUpdated: Date.now(),
          dataSource: "live",
        },
      );
      return () => {
        unsubscribeCalled = true;
      };
    };

    const provider = new GloomberbCloudProvider();
    const seenTargets: Array<{ brokerId?: string; brokerInstanceId?: string }> = [];
    const unsubscribe = provider.subscribeQuotes([{
      symbol: "AAPL",
      exchange: "NASDAQ",
      context: {
        brokerId: "ibkr",
        brokerInstanceId: "ibkr-live",
      },
    }], (target, quote) => {
      seenTargets.push({
        brokerId: target.context?.brokerId,
        brokerInstanceId: target.context?.brokerInstanceId,
      });
      seenQuotes.push({
        price: quote.price,
        currency: quote.currency,
      });
    });

    expect(seenTargets).toEqual([{
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-live",
    }]);
    expect(seenQuotes).toEqual([{
      price: 0.231,
      currency: "GBP",
    }]);

    unsubscribe();
    expect(unsubscribeCalled).toBe(true);
  });

  test("maps news ticker labels from validated story links only", async () => {
    apiClient.getCloudNews = async () => ({
      items: [{
        id: "story-1",
        headline: "Sanofi reports vaccine update",
        summary: "Sanofi and Moderna shared new vaccine data.",
        topic: "product_approval",
        topics: ["product_approval"],
        category: "product_approval",
        sentiment: "positive",
        sectors: ["health_care"],
        firstPublishedAt: "2026-04-01T10:00:00.000Z",
        lastPublishedAt: "2026-04-01T10:05:00.000Z",
        firstSeenAt: "2026-04-01T10:00:10.000Z",
        lastSeenAt: "2026-04-01T10:05:10.000Z",
        primaryUrl: "https://example.com/sny-vaccine",
        primarySource: "example-wire",
        scores: {
          importance: 77,
          urgency: 66,
          marketImpact: 82,
          novelty: 71,
          confidence: 93,
        },
        flags: {
          breaking: false,
          developing: false,
          stale: false,
        },
        variantCount: 1,
        sourceCount: 1,
        sources: ["example-wire"],
        entities: [{
          id: "entity-1",
          entityType: "company",
          name: "Sanofi",
          symbol: "SNY",
          exchange: "NASDAQ",
          canonicalTicker: "SNY:NASDAQ",
          role: null,
          confidence: 0.95,
        }, {
          id: "entity-2",
          entityType: "company",
          name: "Noise Corp",
          symbol: "NOISE",
          exchange: "OTC",
          canonicalTicker: "NOISE:OTC",
          role: null,
          confidence: 0.6,
        }],
        tickerLinks: [{
          symbol: "SNY",
          exchange: "NASDAQ",
          canonicalTicker: "SNY:NASDAQ",
          relationType: "direct",
          displayTier: "primary",
          confidence: 0.98,
          relevanceScore: 95,
          impactScore: 88,
          sentiment: "positive",
        }, {
          symbol: "SNY",
          exchange: "NASDAQ",
          canonicalTicker: "SNY:NASDAQ",
          relationType: "direct",
          displayTier: "primary",
          confidence: 0.98,
          relevanceScore: 95,
          impactScore: 88,
          sentiment: "positive",
        }, {
          symbol: "MRNA",
          exchange: "NASDAQ",
          canonicalTicker: "MRNA:NASDAQ",
          relationType: "competitor",
          displayTier: "related",
          confidence: 0.8,
          relevanceScore: 65,
          impactScore: 54,
          sentiment: "neutral",
        }],
      }],
      nextCursor: null,
    });

    const source = createGloomberbCloudCapabilities().find((capability) => capability.kind === "news") as NewsCapability;
    const news = await source.provider.fetchNews({ feed: "top", ticker: "SNY" });

    expect(news[0]?.tickers).toEqual(["SNY", "MRNA"]);
    expect(news[0]?.importance).toBe(77);
    expect(news[0]?.scores).toEqual({
      importance: 77,
      urgency: 66,
      marketImpact: 82,
      novelty: 71,
      confidence: 93,
    });
  });

  test("fetches story detail with ordered source items", async () => {
    let requestedStoryId = "";
    apiClient.getCloudNewsStory = async (storyId) => {
      requestedStoryId = storyId;
      return makeCloudNewsPayload({
        id: storyId,
        items: [{
          id: "item-2",
          sourceKey: "wire-b",
          sourceName: "Wire B",
          title: "Follow-up",
          summary: "More details emerged.",
          url: "https://example.com/follow-up",
          publishedAt: "2026-04-01T10:05:00.000Z",
          hasArticleText: true,
        }, {
          id: "item-1",
          sourceKey: "wire-a",
          sourceName: "Wire A",
          title: "Original",
          summary: "The first report.",
          url: "https://example.com/original",
          publishedAt: "2026-04-01T10:00:00.000Z",
          hasArticleText: false,
        }],
      });
    };

    const source = createGloomberbCloudCapabilities().find((capability) => capability.kind === "news") as NewsCapability;
    const story = await source.provider.fetchNewsStory?.("story-1");

    expect(requestedStoryId).toBe("story-1");
    expect(story?.items?.map((item) => item.id)).toEqual(["item-2", "item-1"]);
    expect(story?.items?.[0]?.publishedAt).toEqual(new Date("2026-04-01T10:05:00.000Z"));
  });
});
