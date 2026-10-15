import type { SeriesDefinition } from "../../../series/types";
import { FUTURES_CONTRACTS, FUTURES_SECTOR_LABELS, type FuturesContract } from "../../../market-data/futures-board";

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

/** Each continuous front-month contract on the futures board, as `FUT:ES`. */
const FRONT_MONTH_SERIES: readonly SeriesDefinition[] = FUTURES_CONTRACTS.map((contract) => ({
  id: `fut:${contract.code}`,
  name: contract.name,
  unit: futuresSeriesUnit(contract),
  frequency: "daily",
  group: "Futures",
  tags: [contract.code, FUTURES_SECTOR_LABELS[contract.sector], "futures", "front month"],
  expression: `FUT:${contract.code}`,
}));

/**
 * Refining margins of the front months, per barrel: heating oil and gasoline
 * quote per gallon, so each takes 42 gallons to the barrel against crude.
 */
const CRACK_SPREAD_SERIES: readonly SeriesDefinition[] = [
  {
    id: "fut:crack-ho-wti",
    name: "Heating oil crack vs WTI",
    expression: "42*HO=F - CL=F",
    description: "Heating oil less WTI crude, per barrel.",
    tags: ["HO", "CL", "heating oil", "diesel", "WTI"],
  },
  {
    id: "fut:crack-ho-brent",
    name: "Heating oil crack vs Brent",
    expression: "42*HO=F - BZ=F",
    description: "Heating oil less Brent crude, per barrel.",
    tags: ["HO", "BZ", "heating oil", "diesel", "Brent"],
  },
  {
    id: "fut:crack-321",
    name: "3:2:1 crack spread",
    expression: "(2*42*RB=F + 42*HO=F - 3*CL=F)/3",
    description: "Two barrels of gasoline and one of heating oil less three of WTI crude, per barrel of crude.",
    tags: ["RB", "HO", "CL", "gasoline", "heating oil", "WTI"],
  },
].map((series) => ({
  ...series,
  unit: "USD/barrel",
  frequency: "daily" as const,
  group: "Futures",
  tags: [...series.tags, "crack", "crack spread", "refining margin", "futures"],
}));

/** The futures the catalog lists: each front month, then the crack spreads drawn from them. */
export const FUTURES_SERIES: readonly SeriesDefinition[] = [...FRONT_MONTH_SERIES, ...CRACK_SPREAD_SERIES];
