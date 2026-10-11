import { buildFundHoldingRows } from "../../thirteenf/model";
import type { FundDetailData } from "../../thirteenf/types";
import type { PortfolioImportSource } from "../../../../types/ticker";

/** A 13F line ranked by reported value, with why it cannot be a portfolio position when it cannot. */
export interface ThirteenFImportLine {
  ticker: string;
  issuer: string;
  cusip: string;
  /** Reported value, USD. */
  value: number;
  shares: number;
  /** Null for a line that can be imported. */
  skip: string | null;
}

export interface ThirteenFImportPosition {
  ticker: string;
  issuer: string;
  /** Share of the imported lines' reported value. */
  weight: number;
  /** Share of the whole filing's reported value. */
  filingWeight: number | null;
  /** Reported shares scaled to the notional. */
  shares: number;
  /** Reported value per share: the quarter-end price the filing implies. */
  avgCost: number;
}

/**
 * The manager's current 13F lines, largest reported value first. Common-stock
 * lines with a ticker can become positions; options, principal amounts and
 * lines whose CUSIP has no ticker carry the reason they cannot. Two CUSIPs
 * that map to one ticker are one line.
 */
export function rankThirteenFLines(detail: FundDetailData): ThirteenFImportLine[] {
  const lines = new Map<string, ThirteenFImportLine>();
  for (const row of buildFundHoldingRows(detail)) {
    if (row.action === "exit" || row.value == null || row.value <= 0) continue;
    const skip = row.putCall ? `${row.putCall.toLowerCase()} option, not shares`
      : row.shareType.toUpperCase() === "PRN" ? "principal amount, not shares"
        : !row.ticker ? `CUSIP ${row.cusip} has no ticker`
          : row.shares == null || row.shares <= 0 ? "no share count reported"
            : null;
    const key = skip ? `${row.id}|skip` : row.ticker.toUpperCase();
    const line = lines.get(key);
    if (line) {
      line.value += row.value;
      line.shares += row.shares ?? 0;
    } else {
      lines.set(key, { ticker: row.ticker, issuer: row.issuer, cusip: row.cusip, value: row.value, shares: row.shares ?? 0, skip });
    }
  }
  return [...lines.values()].sort((left, right) => right.value - left.value);
}

/** Round to four decimals: a notional share count need not be whole, but it need not show float noise either. */
const roundShares = (value: number) => Math.round(value * 10_000) / 10_000;

/**
 * Positions worth `notional` in total, weighted by reported value: each line's
 * reported shares scaled by notional over the lines' total value, at the
 * quarter-end price the filing implies.
 */
export function notionalPositions(
  lines: readonly Pick<ThirteenFImportLine, "ticker" | "issuer" | "value" | "shares">[],
  notional: number,
  filingValue: number | null,
): ThirteenFImportPosition[] {
  const total = lines.reduce((sum, line) => sum + line.value, 0);
  if (!(total > 0) || !(notional > 0)) return [];
  return lines.map((line) => ({
    ticker: line.ticker,
    issuer: line.issuer,
    weight: line.value / total,
    filingWeight: filingValue && filingValue > 0 ? line.value / filingValue : null,
    shares: roundShares(line.shares * notional / total),
    avgCost: line.value / line.shares,
  }));
}

/** The filing a portfolio's positions came from, or null when it was not imported. */
export function importSource(detail: FundDetailData): PortfolioImportSource | null {
  const form = detail.latestForm;
  if (!form?.periodOfReport || !form.filedAsOfDate) return null;
  return { kind: "13f", cik: detail.cik, name: detail.name, period: form.periodOfReport, filed: form.filedAsOfDate };
}
