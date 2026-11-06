import type { SelectButtonOption } from "../../../components/ui/select-button";

/** Market value bands in US dollars, as the rankings that filter by size draw them (INS, BUZZ). */
export type MarketCapBand = "micro" | "small" | "mid" | "large";

export const MARKET_CAP_BAND_OPTIONS: SelectButtonOption<MarketCapBand | "all">[] = [
  { value: "all", label: "All" },
  { value: "micro", label: "Micro", description: "Under $300M" },
  { value: "small", label: "Small", description: "$300M to $2B" },
  { value: "mid", label: "Mid", description: "$2B to $10B" },
  { value: "large", label: "Large", description: "Over $10B" },
];
