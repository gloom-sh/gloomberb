import type { FundMember } from "../../../api-client/members";
import type { Portfolio, Watchlist } from "../../../types/ticker";
import { getSectorCollection } from "../sectors/sector-data";

/** Focused industries, named by the fund whose published holdings define the group. */
const INDUSTRIES = [
  { etf: "SOXX", name: "Semiconductors" },
  { etf: "XPH", name: "Pharmaceuticals" },
  { etf: "XBI", name: "Biotech" },
  { etf: "ITA", name: "Aerospace & defense" },
  { etf: "KRE", name: "Regional banks" },
  { etf: "IGV", name: "Software" },
  { etf: "XRT", name: "Retail" },
  { etf: "XHB", name: "Homebuilders" },
  { etf: "XOP", name: "Oil & gas exploration" },
] as const;

/** Which companies ERN lists: the market, the user's lists, or a fund's holdings. */
export type EarningsScope =
  | { kind: "all" }
  | { kind: "mine" }
  | { kind: "portfolio" | "watchlist"; id: string; name: string }
  | { kind: "fund"; etf: string; name: string };

export interface EarningsScopeOption {
  value: string;
  label: string;
  description?: string;
  group?: string;
  scope: EarningsScope;
}

/** The value that lists the market; also what an unknown or removed choice reads as. */
export const ALL_SCOPE = "all";
export const MINE_SCOPE = "mine";

/** "Portfolio" under a portfolio's name, unless the name already says so ("Main Portfolio"). */
const kindNote = (name: string, kind: "Portfolio" | "Watchlist") =>
  name.toLowerCase().includes(kind.toLowerCase()) ? undefined : kind;

/** Personal lists, broad sectors and focused industries stay separate in the Names menu. */
export function earningsScopeOptions(collections: { portfolios: readonly Portfolio[]; watchlists: readonly Watchlist[] }): EarningsScopeOption[] {
  return [
    { value: ALL_SCOPE, label: "All", scope: { kind: "all" } },
    { value: MINE_SCOPE, label: "Mine", description: "Portfolios and watchlists", scope: { kind: "mine" } },
    ...collections.portfolios.map((portfolio): EarningsScopeOption => ({
      value: `portfolio:${portfolio.id}`, label: portfolio.name, description: kindNote(portfolio.name, "Portfolio"), group: "Your lists",
      scope: { kind: "portfolio", id: portfolio.id, name: portfolio.name },
    })),
    ...collections.watchlists.map((watchlist): EarningsScopeOption => ({
      value: `watchlist:${watchlist.id}`, label: watchlist.name, description: kindNote(watchlist.name, "Watchlist"), group: "Your lists",
      scope: { kind: "watchlist", id: watchlist.id, name: watchlist.name },
    })),
    ...getSectorCollection("sectors").items.map((sector): EarningsScopeOption => ({
      // Keep the saved sector choice when switching to that fund's own holdings.
      value: `sector:${sector.etf}`, label: `${sector.name} (${sector.etf})`, group: "Sectors",
      scope: { kind: "fund", etf: sector.etf, name: sector.name },
    })),
    ...INDUSTRIES.map((industry): EarningsScopeOption => ({
      value: `industry:${industry.etf}`, label: `${industry.name} (${industry.etf})`, group: "Industries",
      scope: { kind: "fund", etf: industry.etf, name: industry.name },
    })),
  ];
}

/** The scope a saved value names among `options`; the market when it names none. */
export function readEarningsScope(value: string, options: readonly EarningsScopeOption[]): EarningsScopeOption {
  return options.find((option) => option.value === value) ?? options[0]!;
}

/** A fund's companies, largest weight first; cash and other unlisted holdings have no symbol. */
export function fundSymbols(members: readonly FundMember[]): string[] {
  const symbols = [...members]
    .sort((left, right) => (right.weight ?? 0) - (left.weight ?? 0))
    .flatMap((member) => member.symbol?.trim() ? [member.symbol.trim().toUpperCase()] : []);
  return [...new Set(symbols)];
}
