import type { FundMember } from "../../../api-client/members";
import type { Portfolio, Watchlist } from "../../../types/ticker";
import { getSectorCollection } from "../sectors/sector-data";

/**
 * The fund whose holdings name each company's GICS sector: the S&P 500's, as
 * MEMB reads it. A Select Sector SPDR holds the S&P 500's companies of one
 * sector, so its members are these holdings in that sector.
 */
export const SECTOR_HOLDINGS_FUND = "IVV";

/** The GICS sector each of SECT's sector funds holds, as the S&P 500's holdings name it. */
const SECTOR_OF_FUND: Readonly<Record<string, readonly string[]>> = {
  XLK: ["Information Technology"],
  XLV: ["Health Care"],
  XLF: ["Financials"],
  XLY: ["Consumer Discretionary"],
  // The holdings file says "Communication"; GICS's own name is the longer one.
  XLC: ["Communication", "Communication Services"],
  XLI: ["Industrials"],
  XLP: ["Consumer Staples"],
  XLE: ["Energy"],
  XLU: ["Utilities"],
  XLRE: ["Real Estate"],
  XLB: ["Materials"],
};

/** Which companies ERN lists: the market's, the user's, one portfolio or watchlist, or one sector fund's. */
export type EarningsScope =
  | { kind: "all" }
  | { kind: "mine" }
  | { kind: "portfolio" | "watchlist"; id: string; name: string }
  | { kind: "sector"; etf: string; name: string; sectors: readonly string[] };

export interface EarningsScopeOption {
  value: string;
  label: string;
  description?: string;
  scope: EarningsScope;
}

/** The value that lists the market; also what an unknown or removed choice reads as. */
export const ALL_SCOPE = "all";
export const MINE_SCOPE = "mine";

/** "Portfolio" under a portfolio's name, unless the name already says so ("Main Portfolio"). */
const kindNote = (name: string, kind: "Portfolio" | "Watchlist") =>
  name.toLowerCase().includes(kind.toLowerCase()) ? undefined : kind;

/**
 * The choices of ERN's Names filter, in menu order: the market, every held or
 * watched name, each portfolio and watchlist, then SECT's sector funds, each
 * named with its fund ("Technology (XLK)").
 */
export function earningsScopeOptions(collections: { portfolios: readonly Portfolio[]; watchlists: readonly Watchlist[] }): EarningsScopeOption[] {
  return [
    { value: ALL_SCOPE, label: "All", scope: { kind: "all" } },
    { value: MINE_SCOPE, label: "Mine", description: "Portfolios and watchlists", scope: { kind: "mine" } },
    ...collections.portfolios.map((portfolio): EarningsScopeOption => ({
      value: `portfolio:${portfolio.id}`, label: portfolio.name, description: kindNote(portfolio.name, "Portfolio"),
      scope: { kind: "portfolio", id: portfolio.id, name: portfolio.name },
    })),
    ...collections.watchlists.map((watchlist): EarningsScopeOption => ({
      value: `watchlist:${watchlist.id}`, label: watchlist.name, description: kindNote(watchlist.name, "Watchlist"),
      scope: { kind: "watchlist", id: watchlist.id, name: watchlist.name },
    })),
    ...getSectorCollection("sectors").items.flatMap((sector): EarningsScopeOption[] => {
      const sectors = SECTOR_OF_FUND[sector.etf];
      return sectors ? [{
        value: `sector:${sector.etf}`, label: `${sector.name} (${sector.etf})`,
        scope: { kind: "sector", etf: sector.etf, name: sector.name, sectors },
      }] : [];
    }),
  ];
}

/** The scope a saved value names among `options`; the market when it names none. */
export function readEarningsScope(value: string, options: readonly EarningsScopeOption[]): EarningsScopeOption {
  return options.find((option) => option.value === value) ?? options[0]!;
}

/** A sector fund's companies: the S&P 500's holdings in its sector, largest weight first. */
export function sectorSymbols(members: readonly FundMember[], sectors: readonly string[]): string[] {
  const symbols = members
    .filter((member) => member.symbol && member.sector && sectors.includes(member.sector))
    .sort((left, right) => (right.weight ?? 0) - (left.weight ?? 0))
    .map((member) => member.symbol!.trim().toUpperCase());
  return [...new Set(symbols)];
}
