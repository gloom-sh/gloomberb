import { CATALYST_TYPES } from "../../../api-client/catalysts";
import { RESEARCH_ALERT_FORMS } from "./research-rules";

/**
 * One form `gloom alerts add` takes. `help alerts` lists every one, a phrase
 * none of them reads is refused with their names, and the CLI docs page lists
 * the same forms.
 */
export interface AlertAddForm {
  /** What the alert is, as a refusal lists it. */
  name: string;
  /** The words after `alerts add`. */
  usage: string;
}

export const ALERT_ADD_FORMS: readonly AlertAddForm[] = [
  { name: "price", usage: "<symbol> <above|below|crosses> <price>" },
  { name: "P/E, P/S or RSI", usage: "<symbol> <pe|ps|rsi(14)> <above|below> <level>" },
  { name: "moving average crossover", usage: "<symbol> ma(50) crosses <above|below> ma(200)" },
  { name: "close against a moving average", usage: "<symbol> closes <above|below> ma(200)" },
  { name: "earnings", usage: "<symbol> earnings [--days <n> | results]" },
  { name: "economic calendar release (CPI, FOMC, NBS PMI)", usage: "<calendar event> [--country <code>] [--days <n>]" },
  { name: "news keyword", usage: "[symbol] news <keyword>" },
  { name: "options flow", usage: "[symbol] flow [premium] [calls|puts] [sweeps|blocks]" },
  { name: "IV level", usage: "<symbol> <iv|rr> <above|below> <level>" },
  { name: "IV spike", usage: "<OCC contract> iv spike <points>" },
  { name: "52-week range", usage: "<symbol> 52-week <high|low>" },
  { name: "unusual volume", usage: "<symbol> unusual volume [<multiple>x]" },
  { name: "SEC filing", usage: "<symbol> filing [8-K|10-K|10-Q|S-1|13D|13D/A|13G|13G/A|6-K|20-F]" },
  { name: "insider trade", usage: "<symbol> insider [buy|sell]" },
  { name: "short interest", usage: "<symbol> short interest [increase|decrease] [<percent>%]" },
  { name: "analyst change", usage: "<symbol> analyst [upgrade|downgrade]" },
  { name: "hiring move", usage: "<symbol> hiring [accelerating|slowing]" },
  { name: "perpetual market", usage: "perps <market> <funding|oi|premium|closed-premium> <above|below> <percent>" },
  { name: "catalyst", usage: "catalyst [type <type> | agency <agency> | country <code>]" },
  { name: "catalyst", usage: "<symbol> catalyst" },
  { name: "Congress trade", usage: "congress [member name]" },
  { name: "13F filing", usage: "13f <fund CIK>" },
];

const KIND_NAMES = [...new Set(ALERT_ADD_FORMS.map((form) => form.name))];
/** Every kind `alerts add` takes, by name, which ends the refusal of a phrase none of them reads. */
export const ALERT_KINDS_TEXT = `gloom alerts add takes ${KIND_NAMES.slice(0, -1).join(", ")} and ${KIND_NAMES.at(-1)} alerts; gloom help alerts shows how to type each.`;

/**
 * A rule Add Event Alert makes, named in `alerts add` by its words: the
 * form's event (a research kind, `fifty_two_week`, or an event template,
 * `catalyst-type`) and its fields by their own names.
 */
export interface RuleAddRequest {
  kind: "rule";
  event: string;
  /** The symbol typed, read as `quote` reads it; null for a rule on no symbol. */
  symbol: string | null;
  /** Where that symbol may list: in the US, as Gloom Cloud's research rules follow, or anywhere (hiring, a catalyst's company). */
  listing: "us" | "any";
  values: Record<string, string>;
}

/** Who checks a rule and how it reaches you, as docs/usage.md states it. */
export function ruleDelivery(event: string): string {
  if (event.startsWith("catalyst")) return "the app checks it every five minutes while it is running and signed in";
  if (event.startsWith("congress") || event.startsWith("thirteenf")) return "Gloom Cloud sends it to your phone for a signed-in account with Cloud sync";
  return "Gloom Cloud checks it for a signed-in account with Cloud sync and sends it to your phone";
}

/** What a US-only rule is called when a listing abroad is refused. */
export const RULE_US_DATA: Record<string, string> = {
  fifty_two_week: "52-week range alerting", unusual_volume: "Unusual volume alerting", filing_type: "SEC filing alerting",
  insider_trade: "Insider trade alerting", short_interest_change: "Short interest alerting", analyst_change: "Analyst change alerting",
};

const word = (value: string | undefined) => value?.toLowerCase() ?? "";
const CONDITION_WORDS = new Set(["above", "below", "crosses", "earnings"]);

/** One word of a choice, by any of its spellings; `fallback` when nothing is typed, and a refusal naming `usage` otherwise. */
function choose(typed: readonly string[], choices: Record<string, string>, fallback: string, usage: string): string {
  if (typed.length === 0) return fallback;
  const choice = typed.length === 1 ? choices[word(typed[0])] : undefined;
  if (!choice) throw new Error(`Use ${usage}, not "${typed.join(" ")}".`);
  return choice;
}

const NUMBER = /^[+-]?\d+(?:\.\d+)?$/;

/** `8-K`, `8k`, `10q`, `S1`, `13D`, `SC 13G/A`: the form a filing rule follows, as the form lists it. */
function readFilingForm(typed: string): string | null {
  const text = typed.trim().toUpperCase().replace(/\s+/g, " ");
  if (!text) return "8-K";
  const compact = text.replace(/^(?:SCHEDULE|SC)\s*/, "").replace(/\s/g, "");
  if (/^13[DG](?:\/A)?$/.test(compact)) return `SCHEDULE ${compact}`;
  const dashed = compact.replace(/^(\d+|S)-?([KQF1])$/, "$1-$2");
  return (RESEARCH_ALERT_FORMS as readonly string[]).includes(dashed) ? dashed : null;
}

const FILING_FORMS_TEXT = "8-K, 10-K, 10-Q, S-1, 13D, 13D/A, 13G, 13G/A, 6-K or 20-F";

/** The rules of a symbol: `XLE 52-week high`, `XLE unusual volume 3x`, `AAPL filing 10-Q`, and the rest. Null for other words. */
function symbolRule(symbol: string, words: readonly string[]): RuleAddRequest | null {
  const [kind = "", next] = words.map(word);
  const rule = (event: string, values: Record<string, string>, listing: "us" | "any" = "us"): RuleAddRequest => ({ kind: "rule", event, symbol, listing, values });
  const example = (rest: string) => `gloom alerts add ${symbol.toUpperCase()} ${rest}`;
  if (/^52-?(?:w|wk|wks|week|weeks)$/.test(kind) || (kind === "52" && /^weeks?$/.test(word(next)))) {
    const tail = words.slice(kind === "52" ? 2 : 1);
    if (tail.length === 0) throw new Error(`Name the side: ${example("52-week high")}, or 52-week low.`);
    return rule("fifty_two_week", { direction: choose(tail, { high: "high", highs: "high", low: "low", lows: "low" }, "high", "52-week high or 52-week low") });
  }
  if (kind === "unusual" && word(next) === "volume") {
    const typed = words.slice(2).join("").replace(/[x×]$/i, "");
    if (typed && !NUMBER.test(typed)) throw new Error(`An unusual volume alert takes a multiple of the prior 20-session average, from 1.1 to 20: ${example("unusual volume 3x")}.`);
    const multiple = typed ? Number(typed) : 2;
    if (multiple < 1.1 || multiple > 20) throw new Error(`An unusual volume multiple is 1.1 to 20 times the prior 20-session average, not ${multiple}: ${example("unusual volume 3x")}.`);
    return rule("unusual_volume", { threshold: String(multiple) });
  }
  if (kind === "filing" || kind === "filings") {
    const typed = words.slice(1).join(" ");
    const form = readFilingForm(typed);
    if (!form) throw new Error(`A filing alert follows one form: ${FILING_FORMS_TEXT}, not "${typed}": ${example("filing 8-K")}.`);
    return rule("filing_type", { form });
  }
  if (kind === "insider" || kind === "insiders") {
    return rule("insider_trade", { direction: choose(words.slice(1), { buy: "buy", buys: "buy", sell: "sell", sells: "sell", either: "either", any: "either" }, "either", `${example("insider buy")} or insider sell, or insider alone for either`) });
  }
  if (kind === "short" && word(next) === "interest") {
    let direction = "either";
    let percent = 10;
    for (const token of words.slice(2).join(" ").replace(/\s*%/g, "%").split(/\s+/).filter(Boolean)) {
      const lower = word(token);
      if (/^(?:increase|increases|up|rise|rises)$/.test(lower)) direction = "increase";
      else if (/^(?:decrease|decreases|down|fall|falls)$/.test(lower)) direction = "decrease";
      else if (lower === "either" || lower === "any") direction = "either";
      else if (NUMBER.test(lower.replace(/%$/, ""))) percent = Number(lower.replace(/%$/, ""));
      else throw new Error(`A short interest alert takes increase or decrease and a change in percent, not "${token}": ${example("short interest increase 20%")}.`);
    }
    if (percent < 0.1 || percent > 500) throw new Error(`A short interest change is 0.1% to 500% between settlements, not ${percent}%.`);
    return rule("short_interest_change", { direction, threshold: String(percent) });
  }
  if (kind === "analyst" || kind === "analysts") {
    return rule("analyst_change", { direction: choose(words.slice(1), { upgrade: "upgrade", upgrades: "upgrade", downgrade: "downgrade", downgrades: "downgrade", any: "any", either: "any" }, "any", `${example("analyst upgrade")} or analyst downgrade, or analyst alone for either`) });
  }
  if (kind === "hiring") {
    return rule("hiring_move", { direction: choose(words.slice(1), { accelerating: "accelerating", accelerate: "accelerating", up: "accelerating", slowing: "slowing", slow: "slowing", down: "slowing", either: "either", any: "either" }, "either", `${example("hiring accelerating")} or hiring slowing, or hiring alone for either`) }, "any");
  }
  if (kind === "catalyst" || kind === "catalysts") {
    if (words.length > 1) throw new Error(`A catalyst alert on a company takes nothing after it: ${example("catalyst")}; for an event type, agency or country leave the symbol out (alerts add catalyst type clinical).`);
    return { kind: "rule", event: "catalyst-ticker", symbol, listing: "any", values: {} };
  }
  return null;
}

const PERPS_METRICS: Record<string, string> = {
  funding: "funding8h", "funding8h": "funding8h", oi: "oiChange24h", "oi-change": "oiChange24h", "open-interest": "oiChange24h",
  premium: "premium", "closed-premium": "closedMarketPremium", "closed-market-premium": "closedMarketPremium",
};
const PERPS_USAGE = "gloom alerts add perps <market> <funding|oi|premium|closed-premium> <above|below> <percent>, such as alerts add perps hyperliquid:default:BTC funding above 0.05%";

/** `perps hyperliquid:default:BTC funding above 0.05%`: a perpetual market's figure past a level, in percent. */
function perpsRule(words: readonly string[]): RuleAddRequest {
  const [market, ...rest] = words;
  if (!market) throw new Error(`Name the market: ${PERPS_USAGE}.`);
  const text = rest.map(word).join(" ").replace(/\bclosed(?:-market)? premium\b/, "closed-premium").replace(/\bopen interest\b/, "open-interest").replace(/\s*%/g, "%");
  const [metricWord, direction, level, ...extra] = text.split(/\s+/).filter(Boolean);
  const metric = PERPS_METRICS[metricWord ?? ""];
  const threshold = (level ?? "").replace(/%$/, "");
  if (!metric || (direction !== "above" && direction !== "below") || !NUMBER.test(threshold) || extra.length > 0) {
    throw new Error(`A perpetual alert takes its market, a figure, above or below and a level in percent: ${PERPS_USAGE}.`);
  }
  // Market ids are case-sensitive past the venue (hyperliquid:default:kPEPE), as the form keeps them; the venue is lower case.
  const [venue = "", ...names] = market.split(":");
  const marketId = [venue.toLowerCase(), ...names].join(":");
  return { kind: "rule", event: "perps_threshold", symbol: null, listing: "any", values: { marketId, metric, direction, threshold } };
}

/** `catalyst`, `catalyst type clinical`, `catalyst agency FDA`, `catalyst country US`: the catalysts followed with no company. */
function catalystRule(words: readonly string[]): RuleAddRequest {
  if (words.length === 0) return { kind: "rule", event: "catalyst-watched", symbol: null, listing: "any", values: {} };
  const [by, ...rest] = words;
  const value = rest.join(" ").trim();
  const which = word(by);
  if ((which === "type" || which === "agency" || which === "country") && value) {
    if (which === "type" && !(CATALYST_TYPES as readonly string[]).includes(value.toLowerCase())) {
      throw new Error(`A catalyst type is one of ${CATALYST_TYPES.join(", ")}, not "${value}".`);
    }
    return { kind: "rule", event: `catalyst-${which}`, symbol: null, listing: "any", values: { value } };
  }
  throw new Error("A catalyst alert follows your portfolio and watchlists (alerts add catalyst), a company (alerts add PFE catalyst), an event type (alerts add catalyst type clinical), an agency (alerts add catalyst agency FDA) or a country (alerts add catalyst country US).");
}

/**
 * The forms of `alerts add` for the rest of what Add Event Alert offers:
 * 52-week range, unusual volume, filings, insider trades, short interest,
 * analyst changes and hiring on a symbol, perpetual markets, catalysts,
 * Congress trades and 13F filings. Null for any other words; throws, naming
 * the form, when one of them is mistyped. A symbol that spells a form word
 * (`PERPS above 10`) is still a price alert.
 */
export function parseRuleAddArgs(args: readonly string[]): RuleAddRequest | null {
  const [first = "", ...rest] = args;
  const lead = word(first);
  if (!CONDITION_WORDS.has(word(rest[0]))) {
    if (lead === "perps" || lead === "perp") return perpsRule(rest);
    if (lead === "catalyst" || lead === "catalysts") return catalystRule(rest);
    if (lead === "congress") {
      const member = rest.join(" ").trim();
      return { kind: "rule", event: member ? "congress-member" : "congress-watched", symbol: null, listing: "any", values: member ? { value: member } : {} };
    }
    if (lead === "13f") {
      const cik = rest.join("").trim();
      if (!/^\d{1,10}$/.test(cik) || Number(cik) <= 0) throw new Error("A 13F alert follows a fund by its numeric SEC CIK: gloom alerts add 13f 1067983.");
      return { kind: "rule", event: "thirteenf-fund", symbol: null, listing: "any", values: { value: cik } };
    }
  }
  return first && rest.length > 0 ? symbolRule(first, rest) : null;
}
