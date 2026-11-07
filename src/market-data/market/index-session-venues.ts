/**
 * The venue whose trading days and hours an index's bars follow, for the
 * bare index symbols quoted outside the US. A bare symbol is otherwise read
 * as its US listing, so the Hang Seng's hourly bars, which end at 16:10 Hong
 * Kong time, were judged against New York's close and refused as behind:
 * `history ^HSI --range 1W` answered "No history provider available".
 * Venues are the ones the session tables know (freshness.ts).
 */
const INDEX_SESSION_VENUES: Readonly<Record<string, string>> = {
  "^HSI": "HKEX",
  "^HSCE": "HKEX",
  "^HSTECH": "HKEX",
  "^N225": "JPX",
  "^KS11": "KRX",
  "^KQ11": "KOSDAQ",
  "^TWII": "TWSE",
  "^AXJO": "ASX",
  "^AORD": "ASX",
  "^NSEI": "NSE",
  "^NSEBANK": "NSE",
  "^BSESN": "BSE",
  "^STI": "SGX",
  "^NZ50": "NZX",
  "^FTSE": "LSE",
  "^FTMC": "LSE",
  "^GDAXI": "XETRA",
  "^STOXX50E": "XETRA",
  "^FCHI": "EPA",
  "^AEX": "AMS",
  "^BFX": "BRU",
  "^SSMI": "SWX",
  "^ATX": "VIE",
  "^OMX": "SFB",
  "^OMXH25": "HEL",
  "^OMXC25": "CPH",
  "^PSI20": "LIS",
  "^GSPTSE": "TSX",
  "^MXX": "BMV",
};

/** The venue a bare index symbol's sessions follow; null for any other symbol and for US indices. */
export function indexSessionVenue(symbol: string | null | undefined): string | null {
  return symbol ? INDEX_SESSION_VENUES[symbol.trim().toUpperCase()] ?? null : null;
}
