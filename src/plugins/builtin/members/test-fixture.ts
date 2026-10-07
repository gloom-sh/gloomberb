import type { FundMember, FundMembersPayload, FundChangesPayload } from "../../../api-client/members";
export const member = (id: string, changePercent: number | null, weight = 0.25): FundMember => ({ id, symbol: id, name: `Company ${id}`, sector: "Technology", weight, shares: 10000, holdingPrice: 100, marketValue: 1000000,
  price: changePercent === null ? null : 100, priceAsOf: "2026-10-07T15:00:00Z", changePercent, dailyAsOf: changePercent === null ? null : "2026-10-07T15:00:00Z",
  return1WPercent: changePercent, return1MPercent: changePercent, returnYtdPercent: changePercent, contribution: changePercent === null ? null : weight * changePercent, stale: false });
export const board: FundMembersPayload = { fund: { ticker: "IVV", name: "S&P 500", aliases: ["SPY", "SPX"], changes: "sp500" },
  asOf: "2026-10-05", fetchedAt: "2026-10-07T12:00:00Z", excludedDerivatives: 0, stale: false, quotesUnavailable: false,
  snapshotAsOf: "2026-10-07T15:00:00Z", fundDailyAsOf: "2026-10-07T15:00:00Z", quoteCap: 8,
  members: [member("AAA", 1.23, 0.5), member("BBB", -0.27, 0.3), member("CCC", null, 0.2)],
  aggregate: { sum: 0.534, fundReturn: 0.5, residual: -0.034, tolerancePp: 0.15, withinTolerance: true, covered: 2, total: 3, coveredWeight: 0.8, holdingsWeight: 1, fresh1D: 2 } };
export const changes: FundChangesPayload = { fund: board.fund, asOf: "2026-10-07T12:00:00Z", stale: false, available: true, estimateLabel: "Estimate from IVV share counts", attribution: null,
  changes: [{ id: "new", fund: "IVV", effectiveDate: "2026-10-12", announcedAt: "2026-10-07T12:00:00Z", added: "AAA", removed: "BBB", reason: "Market capitalization changes.", headline: null,
    url: "https://example.com/change", kind: "announcement", daysToGo: 5, estimates: [{ symbol: "BBB", usd: -1000000, advUsd: 2000000, days: -0.5, asOf: "2026-10-05", advAsOf: "2026-10-06" }] }] };
