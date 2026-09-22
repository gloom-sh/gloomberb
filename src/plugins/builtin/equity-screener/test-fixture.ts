import { NUMERIC_FIELDS, type ScreenPayload } from "../../../api-client/equity-screener";
import { DEFAULT_SCREEN } from "./model";
export function screenFixture(): ScreenPayload {
  return {
    version: 1,
    status: "available",
    definition: structuredClone(DEFAULT_SCREEN),
    snapshot: {
      id: "one",
      assembledAt: "2026-09-22T16:00:00Z",
      expiresAt: "2026-09-22T18:00:00Z",
      sourceOldestAt: null,
      sourceNewestAt: null,
    },
    universe: {
      covered: 1,
      matched: 1,
      skipped: 0,
      knownByField: {} as any,
      missingByField: {} as any,
      partialByField: {} as any,
      staleByField: {} as any,
      currencies: ["USD"],
      sectors: [],
      exchanges: [],
    },
    nextCursor: null,
    warnings: [],
    rows: [
      {
        symbol: "AAPL",
        exchange: "NASDAQ",
        name: "Apple",
        currency: "USD",
        sector: "Technology",
        industry: null,
        warnings: [],
        metrics: Object.fromEntries(
          NUMERIC_FIELDS.map((id) => [
            id,
            {
              value: null,
              unit: "x",
              asOf: null,
              availableAt: null,
              observedAt: null,
              source: "test",
              state: "unavailable",
              scope: "reported",
              reason: null,
              sourceUrl: null,
              percentile: {
                value: null,
                sampleCount: 0,
                scope: "covered-universe",
              },
            },
          ]),
        ) as any,
      },
    ],
  };
}
