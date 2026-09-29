import type { MarketNewsItem } from "../../../../types/news-source";

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  tech: ["ai", "chip", "semiconductor", "software", "cloud", "cyber", "apple", "google", "microsoft", "meta", "nvidia", "amazon", "saas", "startup"],
  energy: ["oil", "gas", "crude", "opec", "refinery", "solar", "wind", "pipeline", "lng", "drilling"],
  finance: ["bank", "rate", "fed", "fomc", "treasury", "yield", "credit", "loan", "mortgage", "ipo"],
  healthcare: ["pharma", "drug", "fda", "biotech", "vaccine", "hospital", "medicare"],
  macro: ["gdp", "cpi", "inflation", "jobs", "unemployment", "trade", "tariff", "deficit", "pmi"],
  earnings: ["earnings", "revenue", "eps", "beat", "miss", "guidance", "outlook", "quarterly"],
  crypto: ["bitcoin", "ethereum", "crypto", "blockchain", "token", "defi", "mining"],
  geopolitical: ["war", "sanctions", "nato", "military", "conflict", "diplomacy"],
};

/**
 * Feed and cloud sources emit snake_case category ids. Panes show people
 * words, so every id passes through here before it reaches a cell.
 */
const CATEGORY_LABELS: Record<string, string> = {
  mna: "M&A",
  ma: "M&A",
  ipo: "IPO",
  macro_politics: "Politics",
  macro_policy: "Policy",
  central_bank: "Central bank",
  fx: "FX",
  esg: "ESG",
  ai: "AI",
  it: "IT",
  us: "US",
};

export function formatNewsCategory(value: string | null | undefined): string {
  const raw = value?.trim();
  if (!raw) return "";
  const key = raw.toLowerCase().replace(/[\s-]+/g, "_");
  const mapped = CATEGORY_LABELS[key];
  if (mapped) return mapped;
  const words = key.split("_").filter(Boolean);
  if (words.length === 0) return "";
  return words
    .map((word, index) => (
      CATEGORY_LABELS[word] ?? (index === 0
        ? word.charAt(0).toUpperCase() + word.slice(1)
        : word)
    ))
    .join(" ");
}

const KNOWN_TICKERS = new Set([
  "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "JPM", "JNJ", "UNH",
  "PG", "XOM", "CVX", "HD", "BAC", "V", "MA", "PFE", "KO", "PEP", "ABBV", "MRK",
  "LLY", "COST", "AVGO", "CRM", "NFLX", "AMD", "INTC", "QCOM", "IBM", "GS", "MS",
  "WFC", "C", "DIS", "PYPL", "SQ", "COIN", "PLTR", "SNOW", "CRWD",
]);

function classifyArticle(item: MarketNewsItem): string[] {
  const text = `${item.title} ${item.summary ?? ""}`.toLowerCase();
  const matched: string[] = [];

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const kw of keywords) {
      if (text.includes(kw)) {
        matched.push(category);
        break;
      }
    }
  }

  return matched;
}

/** Known tickers that are also words a headline uses: "COST of living". */
const WORD_TICKERS = new Set(["COST", "NOW", "ALL", "ONE", "OPEN", "LOW", "KEY"]);

/** A headline in capitals, where every word looks like a ticker. */
function isShoutingLine(line: string): boolean {
  const letters = line.replace(/[^A-Za-z]/g, "");
  return letters.length >= 12 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.8;
}

/**
 * Known tickers the text names. A cashtag, an exchange pair or a ticker in
 * brackets ("$V", "(NYSE: MA)", "Visa (V)") names one whatever it spells; a
 * bare word only with three letters or more, outside a shouting headline,
 * so "MA" in an address or "C" in a sentence is not a company.
 */
function extractTickers(text: string, knownTickers?: Set<string>): string[] {
  const known = new Set([...KNOWN_TICKERS, ...(knownTickers ?? [])]);
  const found: Array<{ index: number; symbol: string }> = [];
  const deliberate = /(?:\$([A-Z]{1,5})|\((?:NYSE|NASDAQ|Nasdaq|AMEX|NYSE American)\s*:\s*([A-Z]{1,5})\)|\(([A-Z]{1,5})\))(?![A-Za-z0-9])/g;
  for (const match of text.matchAll(deliberate)) {
    found.push({ index: match.index ?? 0, symbol: match[1] ?? match[2] ?? match[3] ?? "" });
  }
  let offset = 0;
  for (const line of text.split("\n")) {
    if (!isShoutingLine(line)) {
      for (const match of line.matchAll(/(?<![A-Za-z0-9$(])[A-Z]{3,5}(?![A-Za-z0-9)])/g)) {
        if (!WORD_TICKERS.has(match[0])) found.push({ index: offset + (match.index ?? 0), symbol: match[0] });
      }
    }
    offset += line.length + 1;
  }
  return [...new Set(
    found
      .filter((entry) => known.has(entry.symbol))
      .sort((left, right) => left.index - right.index)
      .map((entry) => entry.symbol),
  )];
}

const BREAKING_PATTERNS = [
  /\bbreaking\b/i,
  /\bjust in\b/i,
  /\bflash\b/i,
  /\balert\b/i,
  /\burgent\b/i,
];

function detectBreaking(title: string, publishedAt: Date, authority: number): boolean {
  for (const re of BREAKING_PATTERNS) {
    if (re.test(title)) return true;
  }

  const ageMs = Date.now() - publishedAt.getTime();
  if (authority >= 70 && ageMs < 10 * 60 * 1000) return true;

  return false;
}

function scoreImportance(authority: number, publishedAt: Date, isBreaking: boolean): number {
  const ageMs = Date.now() - publishedAt.getTime();
  let score = authority;

  if (ageMs < 30 * 60 * 1000) score += 20;
  else if (ageMs < 2 * 60 * 60 * 1000) score += 10;

  if (isBreaking) score += 30;

  return Math.min(100, score);
}

export function enrichNewsItem(item: MarketNewsItem, authority = 50, knownTickers?: Set<string>): MarketNewsItem {
  const categories = item.categories.length > 0
    ? [...new Set([...item.categories, ...classifyArticle(item)])]
    : classifyArticle(item);

  const text = `${item.title}\n${item.summary ?? ""}`;
  const tickers = extractTickers(text, knownTickers);
  const isBreaking = detectBreaking(item.title, item.publishedAt, authority);
  const importance = scoreImportance(authority, item.publishedAt, isBreaking);
  const topic = categories[0] ?? item.topic ?? "general";
  const scores = {
    importance,
    urgency: isBreaking ? 80 : Math.min(100, Math.max(0, importance - 10)),
    marketImpact: importance,
    novelty: item.scores?.novelty ?? 0,
    confidence: item.scores?.confidence ?? 0,
  };

  return {
    ...item,
    topic,
    topics: [...new Set([topic, ...(item.topics ?? []), ...categories])],
    sectors: item.sectors ?? [],
    categories,
    tickers,
    scores,
    isBreaking,
    isDeveloping: item.isDeveloping ?? false,
    importance,
  };
}
