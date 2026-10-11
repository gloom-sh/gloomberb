import type { SeriesDefinition } from "../../../series/types";
import { FUTURES_CONTRACTS, FUTURES_SECTOR_LABELS } from "./contracts";

/** Each continuous front-month contract on the futures board, as `FUT:ES`. */
export const FUTURES_SERIES: readonly SeriesDefinition[] = FUTURES_CONTRACTS.map((contract) => ({
  id: `fut:${contract.code}`,
  name: contract.name,
  unit: "USD",
  frequency: "daily",
  group: "Futures",
  tags: [contract.code, FUTURES_SECTOR_LABELS[contract.sector], "futures", "front month"],
  expression: `FUT:${contract.code}`,
}));
