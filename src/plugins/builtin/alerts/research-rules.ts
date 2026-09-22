
export const RESEARCH_ALERT_KINDS = [
  "earnings_date",
  "filing_type",
  "news_keyword",
  "analyst_change",
  "fifty_two_week",
  "unusual_volume",
  "short_interest_change",
  "insider_trade",
  "iv_spike",
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
}
export const RESEARCH_ALERT_FORMS = [
  "8-K",
  "10-K",
  "10-Q",
  "S-1",
  "SC 13D",
  "SC 13G",
  "6-K",
  "20-F",
] as const
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


export function optionIdentity(
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
    if (kind === "iv_spike") {
      const identity = optionIdentity(
        typeof input.contract === "string" ? input.contract : "",
      )
      if (!identity) return null
      result.symbol = identity.symbol
      result.exchange = "US"
      result.contract = identity.contract
    } else if (kind !== "news_keyword" || input.symbol) {
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
      case "earnings_date":
        numeric("leadDays", 1, 0, 14, true)
        break
      case "filing_type": {
        const form =
          typeof input.form === "string"
            ? input.form.trim().toUpperCase()
            : "8-K"
        if (
          !RESEARCH_ALERT_FORMS.includes(
            form as (typeof RESEARCH_ALERT_FORMS)[number],
          )
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
      case "iv_spike":
        numeric("threshold", 5, 0.1, 100)
        break
    }
    return JSON.stringify(result)
  } catch {
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
