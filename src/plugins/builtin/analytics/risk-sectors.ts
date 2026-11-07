import type { HeadlessBundleResult, HeadlessPaneContext, HeadlessPaneLoadArgs, HeadlessPaneRow } from "../../../types/headless";
import { canonicalTickerKey } from "../../../utils/exchanges";
import { formatNumber } from "../../../utils/format";
import { CASH_SYMBOL } from "../../../portfolio/allocation";
import type { FundMembersPayload } from "../../../api-client/members";
import { collectionHoldingsHeadless } from "../portfolio-list/headless";

const SECTOR_NAMES: Record<string, string> = {
  technology: "Information Technology", "information technology": "Information Technology",
  "financial services": "Financials", financials: "Financials", "health care": "Health Care", healthcare: "Health Care",
  "consumer cyclical": "Consumer Discretionary", "consumer discretionary": "Consumer Discretionary",
  "consumer defensive": "Consumer Staples", "consumer staples": "Consumer Staples",
  "basic materials": "Materials", materials: "Materials", "communication services": "Communication Services", communication: "Communication Services",
  "cash and/or derivatives": "Cash", cash: "Cash",
  energy: "Energy", industrials: "Industrials", "real estate": "Real Estate", utilities: "Utilities",
};
const sectorName = (value: unknown) => typeof value === "string" ? SECTOR_NAMES[value.trim().toLowerCase()] ?? null : null;

/** Signed positions as a share of net liquidation, including cash. Unknowns stay in the denominator. */
export function comparePortfolioSectors(positions: HeadlessPaneRow[], total: number, benchmark: FundMembersPayload,
  sectors: ReadonlyMap<string, string | null>) {
  if (!Number.isFinite(total) || total <= 0) throw new Error("Sector comparison needs positive net liquidation.");
  const book = new Map<string, number>(), index = new Map<string, number>();
  const unknown: HeadlessPaneRow[] = [];
  for (const member of benchmark.members) {
    const sector = sectorName(member.sector) ?? "Unknown benchmark sector";
    if (member.weight != null && Number.isFinite(member.weight)) index.set(sector, (index.get(sector) ?? 0) + member.weight * 100);
  }
  if (![...index.values()].some(weight => weight > 0)) throw new Error("No benchmark sector weights are available.");
  for (const position of positions) {
    const symbol = String(position.symbol);
    const sector = symbol === CASH_SYMBOL ? "Cash" : sectorName(sectors.get(canonicalTickerKey(symbol, typeof position.exchange === "string" ? position.exchange : undefined))) ?? "Unclassified / funds";
    const value = position.marketValue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      unknown.push({ symbol, reason: "Position has no market value", weightPercent: null });
      continue;
    }
    const weight = 100 * value / total;
    book.set(sector, (book.get(sector) ?? 0) + weight);
    if (sector === "Unclassified / funds") unknown.push({ symbol, reason: "No company sector; funds are not looked through", weightPercent: weight });
  }
  const rows = [...new Set([...book.keys(), ...index.keys()])].map(sector => ({ sector,
    portfolioWeightPercent: book.get(sector) ?? 0, benchmarkWeightPercent: index.get(sector) ?? 0,
    activeWeightPp: (book.get(sector) ?? 0) - (index.get(sector) ?? 0),
  })).sort((a, b) => b.activeWeightPp - a.activeWeightPp || a.sector.localeCompare(b.sector));
  return { rows, unknown };
}

export async function portfolioSectorReport(args: HeadlessPaneLoadArgs, ctx: HeadlessPaneContext): Promise<HeadlessBundleResult> {
  const [holdings, benchmark] = await Promise.all([
    collectionHoldingsHeadless.load({ ...args, options: { limit: 200, close: false } }, ctx),
    ctx.apiClient.getFundMembers("SPY"),
  ]);
  const rows = holdings.rows;
  const metadata = holdings.metadata ?? {};
  const total = (metadata.totals as { total?: number } | undefined)?.total;
  if (typeof total !== "number") throw new Error("Sector comparison needs portfolio holdings with net liquidation.");
  const sectors = new Map<string, string | null>();
  const missing = rows.filter(row => row.symbol !== CASH_SYMBOL);
  // The batch preserves exact listing keys; membership under a matching bare ticker never classifies a namesake abroad.
  if (missing.length && ctx.marketData.getTickerFinancialsBatch) {
    for (let offset = 0; offset < missing.length; offset += 50) {
      const chunk = missing.slice(offset, offset + 50);
      const loaded = await ctx.marketData.getTickerFinancialsBatch(chunk.map(row => ({ symbol: String(row.symbol), exchange: String(row.exchange ?? "") })));
      loaded.forEach(result => {
        const financials = result.financials;
        const fund = /ETF|FUND|MUTUAL/i.test(financials?.quote?.instrumentType ?? "");
        sectors.set(canonicalTickerKey(result.target.symbol, result.target.exchange), fund ? null : financials?.profile?.sector ?? null);
      });
    }
  }
  ctx.signal.throwIfAborted();
  const comparison = comparePortfolioSectors(rows, total, benchmark, sectors);
  const truncated = typeof metadata.positions === "number" && metadata.positions > missing.length;
  const unknownBenchmark = comparison.rows.some(row => row.sector === "Unknown benchmark sector");
  return {
    sections: [
      { title: `Sectors vs S&P 500 (${benchmark.fund.ticker} holdings)`, columns: [
        { key: "sector", header: "Sector" }, { key: "portfolioWeightPercent", header: "Book %", align: "right", format: value => formatNumber(Number(value), 2) },
        { key: "benchmarkWeightPercent", header: `${benchmark.fund.ticker} %`, align: "right", format: value => formatNumber(Number(value), 2) }, { key: "activeWeightPp", header: "Active pp", align: "right", format: value => formatNumber(Number(value), 2) },
      ], rows: comparison.rows },
      { title: "Unclassified holdings", columns: [{ key: "symbol", header: "Ticker" }, { key: "weightPercent", header: "Book %" }, { key: "reason", header: "Reason" }], rows: comparison.unknown },
    ],
    complete: holdings.complete !== false && !truncated && !benchmark.stale && comparison.unknown.length === 0 && !unknownBenchmark,
    notes: ["Signed market values / net liquidation, cash included; active weights are percentage points. Direct company sectors; funds are not looked through. Unknown weights remain in the denominator.",
      `Benchmark: ${benchmark.fund.ticker} holdings as of ${benchmark.asOf}.`],
    errors: [...(holdings.errors ?? []), ...(truncated ? ["Portfolio list exceeds 200 rows; the comparison covers only those returned."] : []),
      ...(benchmark.stale ? ["Benchmark holdings are stale."] : [])],
    metadata: { portfolio: metadata.collection, currency: metadata.currency, netLiquidation: total, benchmark: benchmark.fund.ticker, benchmarkAsOf: benchmark.asOf },
  };
}
