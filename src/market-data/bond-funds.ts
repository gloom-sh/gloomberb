import { apiClient } from "../api-client";
import type { FundBondFacts, FundFactsPayload } from "../api-client/fund-facts";
import { tf } from "../i18n";

/**
 * A bond fund's sponsor figures as every view shows them (`fundamentals`,
 * `ticker`, DVD, DES, ETF): the 30-day SEC yield, the yield to worst and the
 * duration, each dated, and the words that keep its distribution yield apart
 * from the SEC yield.
 */

/** A fund yield as sponsors publish it: `4.04%`. */
export function formatFundYield(value: number): string {
  return `${value.toFixed(2)}%`;
}

/** A duration in years: `7.13 yrs`. */
export function formatDurationYears(value: number): string {
  return `${value.toFixed(2)} yrs`;
}

/**
 * What a bond fund's distribution yield is called beside its SEC yield: the
 * cash it paid, annualized, which is not the standardized 30-day SEC yield
 * its sponsor publishes (MUB on 2026-10-15: 3.27% against 4.04%).
 */
export const NOT_SEC_YIELD = "not SEC yield";

/** The sponsor's duration measure as a label: effective (option-adjusted), or Vanguard's month-end average. */
export function bondDurationLabel(bond: FundBondFacts, short = false): string {
  const average = bond.duration?.measure === "average";
  return short ? (average ? "Avg Duration" : "Eff Duration") : average ? "Average duration" : "Effective duration";
}

/** The date beside a bond figure: Vanguard's average duration is a month end's, as its net assets are. */
function bondFigureDate(bond: FundBondFacts, key: "secYield" | "yieldToWorst" | "duration"): string | undefined {
  const asOf = bond[key]?.asOf;
  if (!asOf) return undefined;
  return key === "duration" && bond.duration?.measure === "average" ? tf("{date} month-end", { date: asOf }) : asOf;
}

export interface BondFigure {
  key: "secYield" | "yieldToWorst" | "duration";
  label: string;
  value: number;
  text: string;
  date?: string;
  source: string;
}

/** A bond fund's sponsor figures in order: SEC yield, yield to worst, duration, each with its date. */
export function bondFigures(bond: FundBondFacts): BondFigure[] {
  const figures: BondFigure[] = [];
  if (bond.secYield) figures.push({ key: "secYield", label: "SEC yield", value: bond.secYield.value, text: formatFundYield(bond.secYield.value),
    date: bondFigureDate(bond, "secYield"), source: bond.secYield.source });
  if (bond.yieldToWorst) figures.push({ key: "yieldToWorst", label: "Yield to worst", value: bond.yieldToWorst.value,
    text: formatFundYield(bond.yieldToWorst.value), date: bondFigureDate(bond, "yieldToWorst"), source: bond.yieldToWorst.source });
  if (bond.duration) figures.push({ key: "duration", label: bondDurationLabel(bond), value: bond.duration.value,
    text: formatDurationYears(bond.duration.value), date: bondFigureDate(bond, "duration"), source: bond.duration.source });
  return figures;
}

/** `Municipal, CA (single-state)`, `Municipal, national` or `Taxable`: what a bond fund is for tax. */
export function bondClassText(bond: FundBondFacts): string {
  if (bond.kind === "taxable") return "Taxable";
  return bond.state ? `Municipal, ${bond.state} (single-state)` : "Municipal, national";
}

const fact = (value: unknown) => value === null || (typeof value === "object" && value !== null && "value" in value && "source" in value);

/** Absent (a server before bond facts), null, or a bond fund's class with its dated figures. */
export function isBondFactsShape(value: FundFactsPayload["bond"]): boolean {
  return value == null
    || ((value.kind === "municipal" || value.kind === "taxable") && [value.secYield, value.yieldToWorst, value.duration].every(fact));
}

/**
 * A fund's bond facts from its fund facts, for a report that shows them
 * beside its yield; null for a fund that has none, or a server before them.
 */
export async function fetchFundBondFacts(symbol: string, client: Pick<typeof apiClient, "getFundFacts"> = apiClient): Promise<FundBondFacts | null> {
  const payload = await client.getFundFacts(symbol);
  if (!payload || !isBondFactsShape(payload.bond)) throw new Error("Unreadable fund facts response");
  return payload.bond ?? null;
}
