import { expect, test } from "bun:test";
import type {
  EstimatePeriod,
  EstimateRevisionsPayload,
} from "../../../api-client/estimate-revisions";
import { ApiRequestError } from "../../../api-client/errors";
import { CLOUD_SESSION_REQUIRED } from "../shared/research-cloud-session";
import { fetchEstimates, validateEstimates } from "./client";
import {
  estimateCurrent,
  estimateHistory,
  sortPeriods,
  pinnedEstimatePeriods,
} from "./model";
const stats = {
  percentile: null,
  rank: null,
  samples: 1,
  min: 1,
  max: 1,
  mean: 1,
};
function fixture(): EstimateRevisionsPayload {
  const point = {
    date: "2026-09-21",
    recordedAt: null,
    average: 1,
    low: 0.8,
    high: 1.2,
    analysts: 2,
    range: 0.4,
    relativeRange: 0.4,
    source: "yahoo" as const,
  };
  const period: EstimatePeriod = {
    id: "quarterly:2026-09-30:USD",
    frequency: "quarterly",
    periodEnd: "2026-09-30",
    currency: "USD",
    label: "current quarter",
    current: { ...point, growth: null },
    revenue: null,
    recorded: [point],
    lookbacks: [{ ...point, date: "2026-08-21", source: "yahoo-eps-trend" }],
    percentile: {
      ...stats,
      window: "1Y",
      firstDate: point.date,
      lastDate: point.date,
    },
    dispersionPercentile: stats,
    change: { value: null, percent: null, fromDate: null, toDate: point.date },
    breadth: [
      {
        days: 30,
        up: 0,
        down: 0,
        net: 0,
        ratio: null,
        asOf: point.date,
        percentile: null,
      },
    ],
  };
  const source = {
    status: "available" as const,
    fetchedAt: "2026-09-22T12:00:00Z",
    stale: false,
    reason: null,
  };
  return {
    symbol: "AAPL",
    exchange: "NASDAQ",
    generatedAt: source.fetchedAt,
    status: "partial",
    sources: {
      consensus: source,
      history: source,
      reported: { ...source, status: "unavailable" },
      guidance: { ...source, status: "unavailable" },
    },
    periods: [period],
    surprises: [],
    guidance: null,
    historyCoverage: {
      since: "2025-09-22",
      until: "2026-09-22",
      truncated: false,
      excludedRows: 0,
      recordedDays: 1,
      lookbackRows: 1,
    },
    gaps: [],
  };
}
test("period identity and actual-versus-lookback boundaries reject unsafe ranks and revisions", () => {
  const data = validateEstimates(fixture(), "AAPL", "NASDAQ");
  expect(estimateHistory(data.periods[0]!).map((row) => row.source)).toEqual([
    "yahoo",
    "yahoo-eps-trend",
  ]);
  expect(estimateCurrent({ ...data.periods[0]!, current: null })?.date).toBe(
    "2026-09-21",
  );
  const currency = fixture();
  currency.periods[0]!.currency = "DKK";
  expect(() => validateEstimates(currency, "AAPL", "NASDAQ")).toThrow();
  const source = fixture();
  source.periods[0]!.recorded[0]!.source = "yahoo-eps-trend";
  expect(() => validateEstimates(source, "AAPL", "NASDAQ")).toThrow();
  const rank = fixture();
  rank.periods[0]!.percentile.percentile = 50;
  expect(() => validateEstimates(rank, "AAPL", "NASDAQ")).toThrow();
  const count = fixture();
  count.periods[0]!.breadth[0]!.down = -1;
  expect(() => validateEstimates(count, "AAPL", "NASDAQ")).toThrow();
  expect(() => validateEstimates(fixture(), "AAPL", "NYSE")).toThrow();
});
test("sorting keeps missing consensus last without treating it as zero", () => {
  const first = fixture().periods[0]!;
  const missing = {
    ...first,
    id: "quarterly:2026-12-31:USD",
    periodEnd: "2026-12-31",
    current: null,
    recorded: [],
  };
  expect(
    sortPeriods([missing, first], "eps", "desc").map((row) => row.id),
  ).toEqual([first.id, missing.id]);
  expect(
    sortPeriods([missing, first], "eps", "asc").map((row) => row.id),
  ).toEqual([first.id, missing.id]);
});
test("absent endpoint and denied access remain distinct", async () => {
  await expect(
    fetchEstimates("AAPL", "NASDAQ", {
      getCloudEstimateRevisions: async () => {
        throw new ApiRequestError("Missing", 404);
      },
    }),
  ).rejects.toThrow("not available on this Gloom Cloud server yet");
  // A signed-out (401) or unverified (403) session becomes the shared Cloud gate the pane walls on.
  for (const status of [401, 403]) {
    await expect(
      fetchEstimates("AAPL", "NASDAQ", {
        getCloudEstimateRevisions: async () => {
          throw new ApiRequestError(status === 401 ? "Unauthorized" : "Email verification required", status);
        },
      }),
    ).rejects.toThrow(CLOUD_SESSION_REQUIRED);
  }
});

test("fiscal pin preserves frequency and currency identity and rejects invalid or unavailable dates", () => {
  const quarter = fixture().periods[0]!;
  const annual = {
    ...quarter,
    id: "annual:2026-09-30:USD",
    frequency: "annual" as const,
  };
  const alternateCurrency = {
    ...quarter,
    id: "quarterly:2026-09-30:DKK",
    currency: "DKK",
  };
  const periods = [quarter, annual, alternateCurrency];
  expect(
    pinnedEstimatePeriods(periods, "2026-09-30", "quarterly").map(
      (row) => row.id,
    ),
  ).toEqual([quarter.id, alternateCurrency.id]);
  expect(pinnedEstimatePeriods(periods, "2026-09-30", "annual")).toEqual([
    annual,
  ]);
  expect(pinnedEstimatePeriods(periods, undefined)).toBe(periods);
  expect(() => pinnedEstimatePeriods(periods, "2026-02-30")).toThrow(
    "valid YYYY-MM-DD",
  );
  expect(() => pinnedEstimatePeriods(periods, "2027-09-30")).toThrow(
    "No quarterly estimates",
  );
});

test("untracked listings resolve only an exact unambiguous Cloud search identity", async () => {
  const listing = {
    providerId: "yahoo",
    symbol: "AAPL",
    name: "Apple",
    exchange: "NASDAQ",
    type: "equity",
  };
  const seen: string[] = [];
  const client = {
    searchInstruments: async () => [listing, { ...listing, exchange: "XNAS" }],
    getCloudEstimateRevisions: async (symbol: string, exchange: string) => {
      seen.push(`${exchange}:${symbol}`);
      return fixture();
    },
  };
  await fetchEstimates("AAPL", "", client);
  expect(seen).toEqual(["NASDAQ:AAPL"]);
  await expect(
    fetchEstimates("AAPL", "", {
      ...client,
      searchInstruments: async () => [
        listing,
        { ...listing, exchange: "NYSE" },
      ],
    }),
  ).rejects.toThrow("Choose a listing exchange");
  await expect(
    fetchEstimates("AAPL", "", {
      ...client,
      searchInstruments: async () => [{ ...listing, symbol: "AAP" }],
    }),
  ).rejects.toThrow("Choose a listing exchange");
  expect(seen).toHaveLength(1);
});

test("guidance and surprise provenance are validated before rendering date and source fields", () => {
  const data = fixture();
  data.guidance = {
    callDate: "2026-08-26T00:00:00Z",
    fiscalYear: 2027,
    fiscalQuarter: 2,
    publishedAt: "2026-09-08T17:15:00Z",
    text: "Cited forecast text",
    transcriptURL: "https://gloom.sh/stocks/nvda/transcripts/2027-q2",
    webcastURL: null,
    source: "public-transcript-summary",
    numericComparison: null,
  };
  expect(validateEstimates(data, "AAPL", "NASDAQ").guidance).toBe(
    data.guidance,
  );
  data.guidance.publishedAt = "not-a-date";
  expect(() => validateEstimates(data, "AAPL", "NASDAQ")).toThrow(
    "invalid estimate revisions",
  );
  data.guidance.publishedAt = "2026-09-08T17:15:00Z";
  data.guidance.transcriptURL = "javascript:alert(1)";
  expect(() => validateEstimates(data, "AAPL", "NASDAQ")).toThrow(
    "invalid estimate revisions",
  );
});
