import type { HeadlessPaneRow } from "../../../../types/plugin";
import type { PortfolioImportSource } from "../../../../types/ticker";

/**
 * A 13F line ranked by reported value, with why it cannot be a portfolio
 * position when it cannot. Read from the rows `fn 13F <manager>` reports, so
 * the import goes through the 13F function rather than the 13F plugin's code.
 */
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

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Title-of-class words for lines that are shares but not common stock ("6.375 PREF SER A", "*W EXP 06/30/202"). */
const NOT_COMMON: Array<[RegExp, string]> = [
  [/\b(?:PFD|PREF|PREFERRED)\b/i, "preferred stock"],
  [/\*W\b|\b(?:WTS?|WARRANTS?)\b/i, "warrant"],
  [/\b(?:RTS?|RIGHTS?)\b/i, "right"],
  [/\b(?:NOTES?|DBCV|DEBT|BONDS?)\b/i, "debt"],
];
const amount = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * The manager's current 13F lines, largest reported value first. Common-stock
 * lines with a ticker can become positions; options, principal amounts,
 * preferred stock, warrants, rights and debt, and lines whose CUSIP has no
 * ticker carry the reason they cannot. Two CUSIPs that map to one ticker are
 * one line.
 */
export function rankThirteenFLines(rows: readonly HeadlessPaneRow[]): ThirteenFImportLine[] {
  const lines = new Map<string, ThirteenFImportLine>();
  for (const [index, row] of rows.entries()) {
    const value = amount(row.value);
    if (row.action === "exit" || value == null || value <= 0) continue;
    const ticker = text(row.ticker);
    const shares = amount(row.shares);
    const putCall = text(row.putCall);
    const notCommon = NOT_COMMON.find(([pattern]) => pattern.test(text(row.titleOfClass)))?.[1];
    const skip = putCall ? `${putCall.toLowerCase()} option, not shares`
      : text(row.shareType).toUpperCase() === "PRN" ? "principal amount, not shares"
        : notCommon ? `${notCommon}, not common stock`
          : !ticker ? `CUSIP ${text(row.cusip) || "unknown"} has no ticker`
            : shares == null || shares <= 0 ? "no share count reported"
              : null;
    const key = skip ? `${index}|skip` : ticker.toUpperCase();
    const line = lines.get(key);
    if (line) {
      line.value += value;
      line.shares += shares ?? 0;
    } else {
      lines.set(key, { ticker, issuer: text(row.issuer), cusip: text(row.cusip), value, shares: shares ?? 0, skip });
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

/** The filing a 13F holdings report covers, from its metadata, or null when it names no dated filing. */
export function importSource(metadata: Record<string, unknown> | undefined): PortfolioImportSource | null {
  const cik = text(metadata?.cik), name = text(metadata?.fund);
  const period = text(metadata?.latestPeriod), filed = text(metadata?.latestFiled);
  if (!cik || !period || !filed) return null;
  return { kind: "13f", cik, name: name || cik, period, filed };
}
