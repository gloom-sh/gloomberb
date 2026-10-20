/** Whether a board is whole, missing a part, or not loaded on the server yet. */
type BalanceBoardStatus = "available" | "partial" | "unavailable";

/** One country's crude or natural gas balance, as GET /cloud/jodi/board serves it. */
export interface JodiBalanceRow {
  country: string;
  /** The month the figures are for, YYYY-MM: each country's own latest report. Null when it never reported one. */
  month: string | null;
  production: number | null;
  demand: number | null;
  imports: number | null;
  exports: number | null;
  stocks: number | null;
  unit: string;
}

export interface JodiBalanceBoard {
  /** The newest month on the board, YYYY-MM. */
  month: string;
  commodity: "oil" | "gas";
  rows: JodiBalanceRow[];
}

/** The Oil & Gas board: JODI's monthly crude and natural gas balances. */
export interface JodiBoardPayload {
  source: "JODI";
  status: BalanceBoardStatus;
  /** When JODI last confirmed the oldest copy on the board, ISO. */
  checkedAt: string | null;
  /** The server has not been able to read JODI for days: these are the last copies it read. */
  stale: boolean;
  gaps: string[];
  oil: JodiBalanceBoard | null;
  gas: JodiBalanceBoard | null;
}

/** One crop, country and attribute of the latest market year, as GET /cloud/psd/board serves it. */
export interface PsdBalanceRow {
  id: string;
  crop: string;
  country: string;
  attribute: string;
  value: number;
  unit: string;
  /** Market year, 2026/27. */
  year: string;
  /**
   * YYYY-MM of the crop's newest estimate: the WASDE for grains, oilseeds and
   * cotton, USDA's semiannual report for coffee and sugar. Absent from boards
   * served before it was sent.
   */
  month?: string | null;
  cropOrder: number;
  countryOrder: number;
  attributeOrder: number;
}

/** A season-average farm price forecast. */
export interface PsdPriceForecast {
  id: string;
  crop: string;
  forecast: number;
  unit: string;
  season: string;
  cropOrder: number;
  seasonYear: number;
}

/** The Crops board: USDA's world crop balances and season-average price forecasts. */
export interface PsdBoardPayload {
  source: "USDA";
  status: BalanceBoardStatus;
  checkedAt: string | null;
  stale: boolean;
  gaps: string[];
  /** YYYY-MM of the newest estimate on the board: the monthly supply and demand report that set it. */
  month: string | null;
  marketYear: string | null;
  rows: PsdBalanceRow[];
  prices: PsdPriceForecast[];
  /** The model forecast date of the prices, YYYY-MM-DD. */
  pricesDate: string | null;
}
