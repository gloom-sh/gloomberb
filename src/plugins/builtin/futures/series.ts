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
export const FUTURES_SERIES: readonly SeriesDefinition[] = FUTURES_CONTRACTS.map((contract) => ({
  id: `fut:${contract.code}`,
  name: contract.name,
  unit: futuresSeriesUnit(contract),
  frequency: "daily",
  group: "Futures",
  tags: [contract.code, FUTURES_SECTOR_LABELS[contract.sector], "futures", "front month"],
  expression: `FUT:${contract.code}`,
}));
