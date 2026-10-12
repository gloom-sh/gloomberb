/** A central bank the CBR board lists a policy rate for. */
export interface CentralBank {
  /** The board's row id: the ISO country code, EA for the euro area. */
  id: string;
  /** The jurisdiction, as the board labels the row. */
  place: string;
  name: string;
  /** What a sentence calls it: "Fed", "ECB", "Norges Bank". */
  short: string;
  /** The policy instrument the board charts, lower case. */
  instrument: string;
  /** Other names and acronyms people look it up by. */
  aliases: readonly string[];
  /** The FRED series the board reads the row from; the other rows come from BIS. */
  fredSeriesIds?: readonly string[];
}

/**
 * The banks on the CBR board, in its order: the G20 members with a policy
 * rate, then the other banks the same BIS batch covers. Gloom Cloud serves
 * the rows; a bank here that the served board does not carry yet is "not on
 * the board right now" to its chart series.
 */
export const CENTRAL_BANKS: readonly CentralBank[] = [
  { id: "US", place: "United States", name: "Federal Reserve", short: "Fed", instrument: "Fed funds target, midpoint",
    aliases: ["FOMC", "Federal Reserve Board", "Federal Reserve System"], fredSeriesIds: ["DFEDTARL", "DFEDTARU"] },
  { id: "EA", place: "Euro area", name: "European Central Bank", short: "ECB", instrument: "deposit facility rate",
    aliases: [], fredSeriesIds: ["ECBDFR"] },
  { id: "JP", place: "Japan", name: "Bank of Japan", short: "BoJ", instrument: "call rate target", aliases: [] },
  { id: "GB", place: "United Kingdom", name: "Bank of England", short: "BoE", instrument: "Bank Rate", aliases: [] },
  { id: "CA", place: "Canada", name: "Bank of Canada", short: "BoC", instrument: "overnight rate target", aliases: [] },
  { id: "AU", place: "Australia", name: "Reserve Bank of Australia", short: "RBA", instrument: "cash rate target", aliases: [] },
  { id: "CN", place: "China", name: "People's Bank of China", short: "PBoC", instrument: "1-year loan prime rate", aliases: [] },
  { id: "IN", place: "India", name: "Reserve Bank of India", short: "RBI", instrument: "repo rate", aliases: [] },
  { id: "ID", place: "Indonesia", name: "Bank Indonesia", short: "Bank Indonesia", instrument: "7-day reverse repo rate", aliases: [] },
  { id: "KR", place: "South Korea", name: "Bank of Korea", short: "BoK", instrument: "base rate", aliases: [] },
  { id: "BR", place: "Brazil", name: "Central Bank of Brazil", short: "BCB", instrument: "Selic target",
    aliases: ["Banco Central do Brasil"] },
  { id: "MX", place: "Mexico", name: "Bank of Mexico", short: "Banxico", instrument: "overnight rate target",
    aliases: ["Banco de México"] },
  { id: "RU", place: "Russia", name: "Bank of Russia", short: "Bank of Russia", instrument: "key rate",
    aliases: ["Central Bank of Russia"] },
  { id: "SA", place: "Saudi Arabia", name: "Saudi Central Bank", short: "SAMA", instrument: "repo rate",
    aliases: ["Saudi Arabian Monetary Authority"] },
  { id: "TR", place: "Turkey", name: "Central Bank of the Republic of Türkiye", short: "CBRT", instrument: "1-week repo rate",
    aliases: ["Central Bank of the Republic of Turkey", "Central Bank of Turkey", "TCMB"] },
  { id: "ZA", place: "South Africa", name: "South African Reserve Bank", short: "SARB", instrument: "repo rate", aliases: [] },
  { id: "CH", place: "Switzerland", name: "Swiss National Bank", short: "SNB", instrument: "SNB policy rate", aliases: [] },
  { id: "NO", place: "Norway", name: "Norges Bank", short: "Norges Bank", instrument: "sight deposit rate", aliases: [] },
  { id: "SE", place: "Sweden", name: "Sveriges Riksbank", short: "Riksbank", instrument: "Riksbank policy rate", aliases: [] },
  { id: "NZ", place: "New Zealand", name: "Reserve Bank of New Zealand", short: "RBNZ", instrument: "official cash rate", aliases: [] },
];

/** Every name the bank goes by: its name, what a sentence calls it and its aliases. */
export function centralBankNames(bank: CentralBank): string[] {
  return [...new Set([bank.name, bank.short, ...bank.aliases])];
}

/** Lower case without accents, apostrophes, punctuation or a leading "the": "the People's Bank of China" is "peoples bank of china". */
function nameKey(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ")
    .trim().replace(/^the /, "");
}

/** The bank a query names as a whole, by any of its names in any case ("snb", "Swiss National Bank"), else null. */
export function centralBankNamed(query: string): CentralBank | null {
  const wanted = nameKey(query);
  if (!wanted) return null;
  return CENTRAL_BANKS.find((bank) => centralBankNames(bank).some((name) => nameKey(name) === wanted)) ?? null;
}

/** The bank whose board row reads a FRED series (DFEDTARU is the Fed's), else null. */
export function centralBankCiting(fredSeriesId: string): CentralBank | null {
  const wanted = fredSeriesId.trim().toUpperCase();
  return CENTRAL_BANKS.find((bank) => bank.fredSeriesIds?.includes(wanted)) ?? null;
}
