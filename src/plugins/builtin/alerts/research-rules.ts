
const RESEARCH_ALERT_KINDS = [
  "earnings_date",
  "macro_event",
  "filing_type",
  "news_keyword",
  "analyst_change",
  "fifty_two_week",
  "unusual_volume",
  "short_interest_change",
  "insider_trade",
  "iv_spike",
  "iv_level",
  "options_flow",
  "perps_threshold",
  "hiring_move",
] as const
export type ResearchAlertKind = (typeof RESEARCH_ALERT_KINDS)[number]
export interface ResearchAlertConfig {
  version: 1
  symbol?: string
  exchange?: string
  keyword?: string
  form?: string
  direction?: string
  threshold?: number
  leadDays?: number
  contract?: string
  /** Options flow: which prints count (any, sweep or block). */
  marketId?: string
  /** Perpetuals: the market figure. IV level: `atm`, the 30-day ATM IV, or `rr`, the 30-day 25-delta risk reversal. */
  metric?: "funding8h" | "oiChange24h" | "premium" | "closedMarketPremium" | IvLevelMetric
  print?: string
  /** Macro event: which scheduled release (`MACRO_ALERT_EVENTS`). */
  event?: string
  /**
   * Earnings: `results` goes off when the report's actual EPS is out, rather
   * than `leadDays` before the date. Such a rule keeps a lead of 0, so a
   * server that reads only the lead alerts on the day instead.
   */
  when?: "results"
}
/** What an IV level rule follows on its symbol's surface: 30-day ATM IV (in %) or 30-day 25-delta risk reversal (in vol points). */
const IV_LEVEL_METRICS = ["atm", "rr"] as const
export type IvLevelMetric = (typeof IV_LEVEL_METRICS)[number]
/** The levels an IV level rule takes: an ATM IV in percent, a risk reversal in vol points either side of zero. */
export const IV_LEVEL_RANGES: Record<IvLevelMetric, { min: number; max: number }> = {
  atm: { min: 1, max: 500 },
  rr: { min: -50, max: 50 },
}
/** Days before a scheduled event (earnings, a macro release) an alert fires when none is given, and the most it takes. */
export const DEFAULT_LEAD_DAYS = 1
export const MAX_LEAD_DAYS = 14
/** Scheduled US releases a macro event rule can follow, by the name the CLI and the form take. */
export const MACRO_ALERT_EVENTS = ["cpi", "fomc"] as const
export type MacroAlertEvent = (typeof MACRO_ALERT_EVENTS)[number]
export const isMacroAlertEvent = (value: unknown): value is MacroAlertEvent =>
  MACRO_ALERT_EVENTS.includes(value as MacroAlertEvent)
export const RESEARCH_ALERT_FORMS = [
  "8-K",
  "10-K",
  "10-Q",
  "S-1",
  "SCHEDULE 13D",
  "SCHEDULE 13D/A",
  "SCHEDULE 13G",
  "SCHEDULE 13G/A",
  "6-K",
  "20-F",
] as const
/** EDGAR renamed SC 13D/13G to SCHEDULE 13D/13G on 2024-12-18; rules saved with the old names stay valid and the server matches both. */
const LEGACY_RESEARCH_ALERT_FORMS: readonly string[] = ["SC 13D", "SC 13G"]
const US_EXCHANGES = new Set([
  "",
  "NASDAQ",
  "NYSE",
  "AMEX",
  "ARCA",
  "NYSEARCA",
  "BATS",
  "OTC",
  "US",
])
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
export const isResearchAlertKind = (kind: string): kind is ResearchAlertKind =>
  RESEARCH_ALERT_KINDS.includes(kind as ResearchAlertKind)


function optionIdentity(
  value: string,
): { symbol: string; contract: string; expiry: string } | null {
  const contract = value.trim().toUpperCase().replace(/^O:/, "")
  const match = /^([A-Z.]{1,6})(\d{2})(\d{2})(\d{2})[CP]\d{8}$/.exec(contract)
  if (!match) return null
  const expiry = `20${match[2]}-${match[3]}-${match[4]}`
  if (
    !Number.isFinite(Date.parse(expiry)) ||
    new Date(expiry).toISOString().slice(0, 10) !== expiry
  )
    return null
  return { symbol: match[1]!, contract, expiry }
}

/** The wire value stays compatible with existing synced event rules and the shared matcher. */
export function normalizeResearchRule(
  kind: ResearchAlertKind,
  raw: unknown,
): string | null {
  try {
    const input: unknown = typeof raw === "string" ? JSON.parse(raw) : raw
    if (!object(input) || input.version !== 1) return null
    const result: ResearchAlertConfig = { version: 1 }
    if (kind === "macro_event") {
      const event = typeof input.event === "string" ? input.event.trim().toLowerCase() : ""
      if (!isMacroAlertEvent(event)) return null
      result.event = event
    } else if (kind === "perps_threshold") {
      const marketId = typeof input.marketId === "string" ? input.marketId.trim() : "";
      const metric = input.metric;
      if (!/^[a-z][a-z0-9-]*:[^\s:]*:[^\s]+$/.test(marketId) || marketId.length > 180
        || typeof metric !== "string" || !["funding8h", "oiChange24h", "premium", "closedMarketPremium"].includes(metric)) return null;
      result.marketId = marketId;
      result.metric = metric as ResearchAlertConfig["metric"];
    } else if (kind === "iv_spike") {
      const identity = optionIdentity(
        typeof input.contract === "string" ? input.contract : "",
      )
      if (!identity) return null
      result.symbol = identity.symbol
      result.exchange = "US"
      result.contract = identity.contract
    } else if (kind === "hiring_move") {
      // A HIRE company: any listing, a world one with its venue (ADYEN:AMS).
      const symbol =
        typeof input.symbol === "string"
          ? input.symbol.trim().toUpperCase()
          : ""
      if (!/^[A-Z0-9][A-Z0-9.:-]{0,31}$/.test(symbol)) return null
      result.symbol = symbol
    } else if (
      (kind !== "news_keyword" && kind !== "options_flow") ||
      input.symbol
    ) {
      const symbol =
        typeof input.symbol === "string"
          ? input.symbol.trim().toUpperCase()
          : ""
      const exchange =
        typeof input.exchange === "string"
          ? input.exchange.trim().toUpperCase()
          : ""
      if (
        !/^[A-Z][A-Z0-9.\-]{0,14}$/.test(symbol) ||
        !US_EXCHANGES.has(exchange)
      )
        return null
      result.symbol = symbol
      result.exchange = exchange === "NYSEARCA" ? "ARCA" : exchange
    }
    const numeric = (
      field: "threshold" | "leadDays",
      fallback: number,
      min: number,
      max: number,
      integer = false,
    ) => {
      const value = input[field] ?? fallback
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < min ||
        value > max ||
        (integer && !Number.isInteger(value))
      )
        throw new Error()
      result[field] = value
    }
    const direction = (values: readonly string[], fallback: string) => {
      const value = input.direction ?? fallback
      if (typeof value !== "string" || !values.includes(value))
        throw new Error()
      result.direction = value
    }
    switch (kind) {
      case "perps_threshold":
        numeric("threshold", 0.001, -100, 100);
        direction(["above", "below"], "above");
        break;
      case "earnings_date": {
        const when = input.when ?? "before"
        if (when === "results") {
          result.leadDays = 0
          result.when = "results"
        } else if (when === "before") numeric("leadDays", DEFAULT_LEAD_DAYS, 0, MAX_LEAD_DAYS, true)
        else throw new Error()
        break
      }
      case "macro_event":
        numeric("leadDays", DEFAULT_LEAD_DAYS, 0, MAX_LEAD_DAYS, true)
        break
      case "filing_type": {
        const form =
          typeof input.form === "string"
            ? input.form.trim().toUpperCase()
            : "8-K"
        if (
          !RESEARCH_ALERT_FORMS.includes(
            form as (typeof RESEARCH_ALERT_FORMS)[number],
          ) &&
          !LEGACY_RESEARCH_ALERT_FORMS.includes(form)
        )
          return null
        result.form = form
        break
      }
      case "news_keyword": {
        const keyword =
          typeof input.keyword === "string"
            ? input.keyword.trim().replace(/\s+/g, " ").toLowerCase()
            : ""
        if (
          keyword.length < 2 ||
          keyword.length > 80 ||
          /[\u0000-\u001f]/.test(keyword)
        )
          return null
        result.keyword = keyword
        break
      }
      case "analyst_change":
        direction(["any", "upgrade", "downgrade"], "any")
        break
      case "fifty_two_week":
        direction(["high", "low"], "high")
        break
      case "unusual_volume":
        numeric("threshold", 2, 1.1, 20)
        break
      case "short_interest_change":
        direction(["increase", "decrease", "either"], "either")
        numeric("threshold", 10, 0.1, 500)
        break
      case "insider_trade":
        direction(["buy", "sell", "either"], "either")
        break
      case "hiring_move":
        direction(["either", "accelerating", "slowing"], "either")
        break
      case "iv_spike":
        numeric("threshold", 5, 0.1, 100)
        break
      case "iv_level": {
        const metric = input.metric ?? "atm"
        if (typeof metric !== "string" || !IV_LEVEL_METRICS.includes(metric as IvLevelMetric))
          throw new Error()
        result.metric = metric as IvLevelMetric
        direction(["above", "below"], "above")
        const range = IV_LEVEL_RANGES[metric as IvLevelMetric]
        // No default: a level is what the rule is about.
        if (input.threshold == null) throw new Error()
        numeric("threshold", 0, range.min, range.max)
        break
      }
      case "options_flow": {
        // Premium in dollars; Cloud records nothing under $50K.
        numeric("threshold", 1_000_000, 50_000, 1_000_000_000)
        direction(["any", "calls", "puts"], "any")
        const print = input.print ?? "any"
        if (
          typeof print !== "string" ||
          !["any", "sweep", "block"].includes(print)
        )
          throw new Error()
        result.print = print
        break
      }
    }
    return JSON.stringify(result)
  } catch {
    // Intentional ignore: malformed research input is rejected with the null validation result.
    return null
  }
}
export function readResearchRule(
  kind: ResearchAlertKind,
  value: string,
): ResearchAlertConfig | null {
  const normalized = normalizeResearchRule(kind, value)
  return normalized ? JSON.parse(normalized) : null
}
