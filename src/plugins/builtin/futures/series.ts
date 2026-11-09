import type { SeriesDefinition } from "../../../series/types";
import { FUTURES_CONTRACTS, FUTURES_SECTOR_LABELS, futuresGroupTags, type FuturesContract } from "../../../market-data/futures-board";
import { futuresContractCode } from "../../../utils/futures-generic";

/**
 * Grains and softs the board quotes in US cents with no unit of its own
 * (soybean meal and cocoa quote in dollars). Checked against the server's
 * contract terms on 2026-10-13.
 */
const US_CENT_CONTRACTS: ReadonlySet<string> = new Set(["ZC", "ZS", "ZL", "ZW", "KE", "KC", "SB", "CT"]);

/**
 * The unit the board prints, not a blanket dollar price. Index and sector
 * futures are points, rates are points (the board prints decimals, not 32nds), cents
 * contracts are USX, and a declared quote unit wins over USD. Currency
 * futures are dollars per unit of the foreign currency.
 */
function futuresSeriesUnit(contract: FuturesContract): string {
  if (contract.unit?.startsWith("US cents") || US_CENT_CONTRACTS.has(contract.code)) return "USX";
  if (contract.unit?.startsWith("EUR")) return "EUR";
  if (contract.unit?.startsWith("USD")) return "USD";
  if (contract.sector === "equity-index" || contract.sector === "equity-sectors" || contract.sector === "rates") return "points";
  return "USD";
}

/**
 * Words a contract is looked for by that its name does not hold: a currency
 * future by its currency's code and name (`yen`, `JPY` for 6J), and the safe
 * havens, gold, the yen and the franc.
 */
const CONTRACT_TAGS: Readonly<Record<string, readonly string[]>> = {
  GC: ["safe haven"],
  "6E": ["EUR", "euro"],
  "6J": ["JPY", "yen", "safe haven"],
  "6B": ["GBP", "pound", "sterling"],
  "6A": ["AUD", "aussie"],
  "6C": ["CAD", "loonie"],
  "6S": ["CHF", "franc", "swiss franc", "safe haven"],
};

/** Each continuous front-month contract on the futures board, as `FUT:ES`, found by its sector and group words too (`catalog softs`). */
const FRONT_MONTH_SERIES: readonly SeriesDefinition[] = FUTURES_CONTRACTS.map((contract) => ({
  id: `fut:${contract.code}`,
  name: contract.name,
  unit: futuresSeriesUnit(contract),
  frequency: "daily",
  group: "Futures",
  tags: [...new Set([contract.code, FUTURES_SECTOR_LABELS[contract.sector], ...futuresGroupTags(contract), "futures", "front month",
    ...CONTRACT_TAGS[contract.code] ?? []])],
  expression: `FUT:${contract.code}`,
}));

/**
 * The delivery month a crude root's continuous contract holds on `now`, as
 * `futuresContractMonth` counts months. WTI's rolls in the middle of the
 * month before delivery (it last trades around the 20th, CL=F rolled to
 * December on 16 Oct 2026); CME's Brent trades until the last business day of
 * the second month before delivery, so its front month is two months out.
 */
export function crudeFrontMonth(root: "CL" | "BZ", now: Date): number {
  const month = now.getUTCFullYear() * 12 + now.getUTCMonth();
  return month + (root === "BZ" || now.getUTCDate() >= 16 ? 2 : 1);
}

/**
 * Refining margins per barrel: heating oil and gasoline quote per gallon, so
 * each takes 42 gallons to the barrel against crude. Every leg is priced in
 * one delivery month, the one the crude leg holds, and all roll together on
 * crude's roll day (`rollsWith`): from crude's roll until the products' own,
 * their front month is still the month before. Each names a formula of listed
 * contracts that prices one month by hand, in the crude leg's month today.
 */
const CRACK_SPREAD_SERIES: readonly SeriesDefinition[] = [
  {
    id: "fut:crack-ho-wti",
    name: "Heating oil crack vs WTI",
    expression: "42*HO=F - CL=F",
    rollsWith: "CL=F",
    summary: "Heating oil less WTI crude, per barrel, both in WTI's delivery month.",
    example: (now: Date) => {
      const month = crudeFrontMonth("CL", now);
      return `42*${futuresContractCode("HO", month)} - ${futuresContractCode("CL", month)}`;
    },
    tags: ["HO", "CL", "heating oil", "diesel", "WTI"],
  },
  {
    id: "fut:crack-ho-brent",
    name: "Heating oil crack vs Brent",
    expression: "42*HO=F - BZ=F",
    rollsWith: "BZ=F",
    summary: "Heating oil less Brent crude, per barrel, both in Brent's delivery month.",
    example: (now: Date) => {
      const month = crudeFrontMonth("BZ", now);
      return `42*${futuresContractCode("HO", month)} - ${futuresContractCode("BZ", month)}`;
    },
    tags: ["HO", "BZ", "heating oil", "diesel", "Brent"],
  },
  {
    id: "fut:crack-321",
    name: "3-2-1 crack spread",
    expression: "(2*42*RB=F + 42*HO=F - 3*CL=F)/3",
    rollsWith: "CL=F",
    summary: "Two barrels of gasoline and one of heating oil less three of WTI crude, per barrel of crude, all in WTI's delivery month.",
    example: (now: Date) => {
      const month = crudeFrontMonth("CL", now);
      return `(2*42*${futuresContractCode("RB", month)} + 42*${futuresContractCode("HO", month)} - 3*${futuresContractCode("CL", month)})/3`;
    },
    tags: ["RB", "HO", "CL", "gasoline", "heating oil", "WTI", "3-2-1", "321", "3:2:1"],
  },
].map(({ summary, example, ...series }) => ({
  ...series,
  // Read when the catalog is, so a session left open across a roll names the month that trades.
  get description() {
    return `${summary} One month by hand: ${example(new Date())}.`;
  },
  unit: "USD/barrel",
  frequency: "daily" as const,
  group: "Futures",
  tags: [...series.tags, "crack", "crack spread", "refining margin", "futures"],
}));

/** The futures the catalog lists: each front month, then the crack spreads drawn from them. */
export const FUTURES_SERIES: readonly SeriesDefinition[] = [...FRONT_MONTH_SERIES, ...CRACK_SPREAD_SERIES];
