/**
 * The volatility indices the VIX function reads: the curve's tenors, then
 * the board's other rows. Shared so that what points at VIX for one of them
 * (`fn INS ^VVIX`) names the same list the function shows.
 */
export const VOLATILITY_CURVE_INDICES = [
  { id: "vix9d", symbol: "^VIX9D", label: "VIX 9D", tenor: "9D", days: 9 },
  { id: "vix", symbol: "^VIX", label: "VIX", tenor: "30D", days: 30 },
  { id: "vix3m", symbol: "^VIX3M", label: "VIX 3M", tenor: "3M", days: 93 },
  { id: "vix6m", symbol: "^VIX6M", label: "VIX 6M", tenor: "6M", days: 184 },
  { id: "vix1y", symbol: "^VIX1Y", label: "VIX 1Y", tenor: "1Y", days: 366 },
] as const;
const VOLATILITY_BOARD_INDICES = [
  { id: "vvix", symbol: "^VVIX", label: "VVIX" },
  { id: "skew", symbol: "^SKEW", label: "SKEW" },
  { id: "move", symbol: "^MOVE", label: "MOVE" },
  { id: "vxn", symbol: "^VXN", label: "Nasdaq 100" },
  { id: "rvx", symbol: "^RVX", label: "Russell 2000" },
  { id: "ovx", symbol: "^OVX", label: "Oil" },
  { id: "gvz", symbol: "^GVZ", label: "Gold" },
  { id: "vxeem", symbol: "^VXEEM", label: "Emerging markets" },
  { id: "vxewz", symbol: "^VXEWZ", label: "Brazil" },
  { id: "vxapl", symbol: "^VXAPL", label: "Apple" },
  { id: "vxazn", symbol: "^VXAZN", label: "Amazon" },
  { id: "vxgog", symbol: "^VXGOG", label: "Alphabet" },
  { id: "vxgs", symbol: "^VXGS", label: "Goldman Sachs" },
  { id: "vxibm", symbol: "^VXIBM", label: "IBM" },
  // CBOE S&P 500 implied correlation: daily closes use CBOE history from the market backend.
  { id: "cor1m", symbol: "^COR1M", label: "S&P 500 corr 1M" },
  { id: "cor3m", symbol: "^COR3M", label: "S&P 500 corr 3M" },
] as const;
export const VOLATILITY_INDICES = [...VOLATILITY_CURVE_INDICES, ...VOLATILITY_BOARD_INDICES] as const;
