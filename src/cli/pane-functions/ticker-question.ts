import { isUsListingExchange } from "../../utils/exchanges";

/**
 * A question about named tickers, answered without AI by the functions a desk
 * opens for them: their prices over the days asked about (CMP for several,
 * HP for one, QQ for today's), the first one's news (CN) and its analysts
 * (ANR), or the one function a narrower question asks for (GUIDE, HDS).
 * "What moved DAL UAL and AAL from November 9 to November 13, 2026?" was
 * offered 13F, ALRT and HDS, found by "13" and "moved" in their descriptions.
 */

/**
 * Words a question writes in capitals that are no company it asks about,
 * whether or not a listing trades under them: AI is C3.ai's ticker and the AI
 * trade, ON onsemi's and a word. Two-letter words, macro and accounting
 * abbreviations, agencies, indices and currencies.
 */
const NOT_TICKERS = new Set([
  "AM", "AN", "AS", "AT", "BE", "BY", "DO", "GO", "HE", "IF", "IN", "IS", "IT", "ME", "MY", "NO", "OF", "OK", "ON", "OR", "SO", "TO", "UP",
  "US", "WE", "ALL", "AND", "ARE", "CAN", "FOR", "HOW", "LOW", "NEW", "NOT", "NOW", "ONE", "THE", "WHO", "WHY", "YES",
  "AI", "USA", "UK", "EU", "CEO", "CFO", "COO", "CTO", "CPI", "PPI", "PCE", "GDP", "PMI", "ISM", "NFP", "FOMC", "FED", "ECB", "BOJ", "BOE",
  "RBA", "RBI", "PBOC", "SNB", "ETF", "ETFS", "ETN", "ETNS", "IPO", "IPOS", "EPS", "PE", "YTD", "QTD", "MTD", "YOY", "QOQ", "MOM", "ATH",
  "ATM", "OTM", "ITM", "IV", "HV", "DCF", "EBIT", "EBITDA", "FCF", "ROE", "ROA", "ROI", "ROIC", "SEC", "FDA", "FAA", "FTC", "DOJ", "EPA",
  "IRS", "NYSE", "OPEC", "WTI", "LNG", "EV", "EVS", "API", "SPX", "NDX", "VIX", "DAX", "FTSE", "FX", "PM", "ET", "UTC", "EST", "PST", "GMT",
  "HQ", "PR", "IR", "LBO", "VC", "OTC", "ADR", "ADRS", "REIT", "REITS", "SPAC", "NAV", "AUM", "BPS", "FY", "TTM", "NTM", "LTM", "YOLO",
  "USD", "EUR", "JPY", "GBP", "CNY", "CNH", "HKD", "SGD", "AUD", "CAD", "CHF", "NZD", "INR", "KRW", "BTC", "ETH", "AMEX", "NATO",
  "COVID", "FAANG", "ESG", "CAPEX", "OPEX", "ARPU", "MAU", "DAU", "SAAS", "NFT", "DEFI", "LLM", "LLMS", "GPU", "GPUS", "CPU", "IOT", "HR",
  "PNL", "TBD", "FAQ", "ASAP", "FYI", "IMO", "LOL", "IMF", "BIS", "OECD", "BRICS", "ASEAN", "NAFTA", "USMCA", "CBO", "BLS", "BEA",
  "JOLTS", "ECI", "UST", "JGB", "JGBS", "TIPS", "OAT", "OATS", "BTP", "BTPS", "ACGB", "CDS", "CDX", "SOFR", "OIS", "LIBOR", "SONIA",
  "ESTR", "TONA", "HIBOR", "SHIBOR", "RUT", "DJIA", "DJI", "SOX", "NKY", "HSI", "KOSPI", "TSX", "CAC", "IBEX", "STOXX", "RRR", "LPR",
  "ZIRP", "NIRP", "YCC", "SPR",
]);

let majorUsSymbols: Promise<ReadonlySet<string>> | null = null;

/** The US listings shipped with the app, read the first time a question names a symbol, so a launch never loads them. */
function knownUsSymbols(): Promise<ReadonlySet<string>> {
  majorUsSymbols ??= import("../../tickers/search/major-listings.chunk").then(({ MAJOR_LISTINGS }) => new Set(MAJOR_LISTINGS
    .filter(([, , exchange]) => isUsListingExchange(exchange)).map(([symbol]) => symbol.toUpperCase())));
  return majorUsSymbols;
}

/** A cashtag (`$DAL`) or a symbol in capitals (`DAL`, `BRK.B`, `MSFT's`) that stands as a word of its own. */
const TICKER_WORD = /(?<![\p{L}\p{N}&/.\-])(\$)?([A-Za-z][A-Za-z0-9]{0,5}(?:\.[A-Z])?)(?:['’]s)?(?![\p{L}\p{N}&/]|\.[A-Za-z])/gu;

/**
 * The tickers a question names, in its order, each once: a cashtag always; a
 * word in capitals in a question that has lower case too, unless it is an
 * abbreviation (NOT_TICKERS), a short word no shipped US listing has, or a
 * function's code no listing has (`functionCodes`: OMON, WEI). A symbol of
 * three letters or more that the shipped listings do not carry (LUV) still
 * counts, as only the large caps ship.
 */
export async function questionTickers(question: string, functionCodes: ReadonlySet<string> = new Set()): Promise<string[]> {
  const mixedCase = /\p{Ll}/u.test(question);
  const found: string[] = [];
  let known: ReadonlySet<string> | null = null;
  for (const match of question.matchAll(TICKER_WORD)) {
    const [, cashtag, word] = match;
    const symbol = word!.toUpperCase();
    if (found.includes(symbol)) continue;
    if (cashtag) {
      found.push(symbol);
      continue;
    }
    // BRK.B, never U.S. nor Q4.
    if (!mixedCase || word !== symbol || !/^[A-Z]{2,5}(?:\.[A-Z])?$/.test(symbol) || NOT_TICKERS.has(symbol)) continue;
    known ??= await knownUsSymbols();
    if (known.has(symbol) || (symbol.length >= 3 && !functionCodes.has(symbol))) found.push(symbol);
  }
  return found;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const DAY = String.raw`(\d{1,2})(?:st|nd|rd|th)?`;
const YEAR = String.raw`(?:,?\s+(\d{4}))?`;
/** "November 9", "Nov 13, 2026", "9 November 2026", "2026-11-09". */
const DATE = new RegExp(String.raw`\b(?:${MONTH}\s+${DAY}${YEAR}|${DAY}\s+${MONTH}${YEAR}|(\d{4})-(\d{2})-(\d{2}))\b`, "gi");

interface QuestionDate {
  month: number;
  day: number;
  year: number | null;
  at: number;
}

function monthIndex(name: string): number {
  return MONTHS.indexOf(name.toLowerCase().slice(0, 3)) + 1;
}

function questionDates(question: string): QuestionDate[] {
  return [...question.matchAll(DATE)].flatMap((match): QuestionDate[] => {
    const [, monthFirst, dayAfter, yearA, dayFirst, monthAfter, yearB, isoYear, isoMonth, isoDay] = match;
    const date = isoYear
      ? { month: Number(isoMonth), day: Number(isoDay), year: Number(isoYear) }
      : monthFirst
        ? { month: monthIndex(monthFirst), day: Number(dayAfter), year: yearA ? Number(yearA) : null }
        : { month: monthIndex(monthAfter!), day: Number(dayFirst), year: yearB ? Number(yearB) : null };
    return date.month >= 1 && date.month <= 12 && date.day >= 1 && date.day <= 31 ? [{ ...date, at: match.index ?? 0 }] : [];
  });
}

const pad = (value: number) => String(value).padStart(2, "0");

/** A calendar day, or null for one that does not exist (31 November). */
function isoDay(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 ? `${year}-${pad(month)}-${pad(day)}` : null;
}

/** The days a question asks about: from its first date to its second, or from the one it names. */
export interface QuestionWindow {
  from: string;
  /** Absent for "since October 9": up to today. */
  to?: string;
}

/**
 * The dates a question names, as a window: "from November 9 to November 13,
 * 2026" is 2026-11-09 to 2026-11-13, a year given once counting for both. A
 * date without a year is this year's, last year's when this year's has not
 * come yet. One date is that day, or from it after "since", "after" or
 * "from". Null when it names none.
 */
export function questionWindow(question: string, now = new Date()): QuestionWindow | null {
  const dates = questionDates(question);
  if (dates.length === 0) return null;
  const today = now.toISOString().slice(0, 10);
  const statedYear = dates.find((date) => date.year !== null)?.year ?? null;
  const days = dates.slice(0, 2).map((date) => {
    const year = date.year ?? statedYear ?? now.getUTCFullYear();
    const day = isoDay(year, date.month, date.day);
    // "October 9" asked in January is last October's.
    return day && date.year === null && statedYear === null && day > today ? isoDay(year - 1, date.month, date.day) : day;
  });
  if (days.some((day) => day === null)) return null;
  const [first, second] = days as string[];
  if (second) return first! <= second ? { from: first!, to: second } : { from: second, to: first! };
  // "How did DAL trade after its earnings on October 9?" asks from that day on.
  const opened = /\b(?:since|after|from)\b[^.?!;]*$/i.test(question.slice(0, dates[0]!.at));
  return opened ? { from: first! } : { from: first!, to: first! };
}

/** A year a question asks about whole ("in 2025"), or from ("since 2024"). */
function questionYear(question: string, now: Date): QuestionWindow | null {
  const match = /\b(in|during|for|since|from)\s+((?:19|20)\d{2})\b/i.exec(question);
  const year = match ? Number(match[2]) : NaN;
  if (!match || year > now.getUTCFullYear()) return null;
  return /^(?:since|from)$/i.test(match[1]!) ? { from: `${year}-01-01` } : { from: `${year}-01-01`, to: `${year}-12-31` };
}

/** A span of recent days a question names in words, as CMP's presets: today's quotes, this week, this month, this year. */
type QuestionSpan = "today" | "1W" | "1M" | "YTD";

function questionSpan(text: string): QuestionSpan | null {
  if (/\b(?:ytd|year[- ]to[- ]date|this year)\b/.test(text)) return "YTD";
  if (/\b(?:this|past|last) month\b/.test(text)) return "1M";
  if (/\b(?:this|past|last) week\b/.test(text)) return "1W";
  if (/\b(?:today|right now|intraday|this morning|this afternoon)\b/.test(text)) return "today";
  return null;
}

/** How a price moved, traded or compares: what the price functions answer. */
const PRICE_MOVE = new RegExp(String.raw`\b(?:mov(?:e|ed|es|ing|ement|ements)|trad(?:e|ed|es|ing)|perform(?:ed|s|ing|ance)?|returns?|returned|`
  + String.raw`rall(?:y|ied|ies)|f[ae]ll|falls|falling|drop(?:s|ped|ping)?|slump(?:ed|s)?|plung(?:e|ed|es)|sank|sink(?:s|ing)?|tank(?:ed|s)?|`
  + String.raw`tumbl(?:e|ed|es)|ris(?:e|en|es|ing)|rose|gain(?:ed|s)?|lost|jump(?:ed|s)?|surg(?:e|ed|es)|soar(?:ed|s)?|spik(?:e|ed|es)|`
  + String.raw`climb(?:ed|s)?|los(?:e|es|ing)|sell-?offs?|sold off|price action|prices?(?! targets?)|chart|compare[sd]?|comparison|versus|vs)\b`
  + String.raw`|\d(?:\.\d+)?\s?%`
  + String.raw`|\bhow (?:did|does|do|is|are|has|have)\b.*\b(?:do|doing|done|go|going|gone)\b`);
const NEWS = /\b(?:news|headlines?|stor(?:y|ies)|why|happen(?:ed|ing)?|going on)\b/;
const ANALYSTS = /\b(?:analysts?|upgrad\w*|downgrad\w*|ratings?|rated|price targets?|targets?|recommendations?|coverage|initiat\w*|overweight|underweight|outperform)\b/;
const GUIDANCE = /\b(?:guid(?:e|ed|es|ing|ance)|outlook|forecasts?)\b/;
const HOLDERS = /\b(?:holds?|holders?|owns?|owners?|ownership|institutions?|institutional|stakes?)\b/;

/** A function a ticker question is answered with, and how to run it for the tickers named. */
export interface TickerQuestionFunction {
  /** The function's code, as `gloom fn` and the command bar take it. */
  code: "CMP" | "HP" | "QQ" | "CN" | "ANR" | "GUIDE" | "HDS" | "DES";
  /** As `gloom fn` takes it after the code (`DAL,UAL,AAL --from 2026-11-09 --to 2026-11-13`). */
  argument: string;
  /** As the command bar takes it after the code (`DAL,UAL,AAL`). */
  input: string;
}

/** What a question asks of the tickers it names; null when it names none. */
export interface TickerQuestion {
  tickers: string[];
  functions: TickerQuestionFunction[];
}

function priceFunction(tickers: readonly string[], window: QuestionWindow | null, span: QuestionSpan | null, now: Date): TickerQuestionFunction {
  const list = tickers.join(",");
  const dates = window ? ` --from ${window.from}${window.to ? ` --to ${window.to}` : ""}` : "";
  if (!window && span === "today") return { code: "QQ", argument: list, input: list };
  if (tickers.length > 1) {
    const preset = !window && span && span !== "today" ? ` --range-preset ${span}` : "";
    return { code: "CMP", argument: `${list}${dates}${preset}`, input: list };
  }
  const range = window ? dates : span === "YTD" ? ` --from ${now.getUTCFullYear()}` : span === "1W" || span === "1M" ? ` --range ${span}` : "";
  return { code: "HP", argument: `${list}${range}`, input: list };
}

/**
 * What a question naming tickers asks of them. A move, a trade, a comparison
 * or days asked about get the price function run over those days, then the
 * first ticker's news and analysts; a question about guidance or holders gets
 * that function; one about news or analysts those; a question that names
 * tickers and asks nothing a function answers gets DES, CN and ANR. A
 * question about earnings, valuation or the like is left to the catalog, run
 * for the tickers (`functionsForQuestion`).
 */
export async function tickerQuestion(
  question: string,
  { now = new Date(), functionCodes }: { now?: Date; functionCodes?: ReadonlySet<string> } = {},
): Promise<TickerQuestion | null> {
  const tickers = await questionTickers(question, functionCodes);
  if (tickers.length === 0) return null;
  const text = question.toLowerCase();
  const first = tickers[0]!;
  const window = questionWindow(question, now) ?? questionYear(question, now);
  const span = questionSpan(text);
  const one = (code: TickerQuestionFunction["code"]): TickerQuestionFunction => ({ code, argument: first, input: first });
  if (window || span || PRICE_MOVE.test(text)) {
    return { tickers, functions: [priceFunction(tickers, window, span, now), one("CN"), one("ANR")] };
  }
  const asked: TickerQuestionFunction[] = [
    ...(GUIDANCE.test(text) ? [one("GUIDE")] : []),
    ...(HOLDERS.test(text) ? [one("HDS")] : []),
    ...(ANALYSTS.test(text) ? [one("ANR")] : []),
    ...(NEWS.test(text) ? [one("CN")] : []),
  ];
  return { tickers, functions: asked };
}
