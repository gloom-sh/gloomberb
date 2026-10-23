import type { GloomPlugin } from "../../../types/plugin";
import { DEFAULT_LEAD_DAYS, isResearchAlertKind, MACRO_ALERT_EVENTS, normalizeResearchRule, readResearchRule, RESEARCH_ALERT_FORMS, type IvLevelMetric, type MacroAlertEvent, type ResearchAlertKind } from "./research-rules";
import type { EventAlertRule } from "./events";

/** What a macro event is called in a rule, a list and a notification. */
export const MACRO_EVENT_NAMES: Record<MacroAlertEvent, string> = { cpi: "CPI release", fomc: "FOMC decision" };
export const RESEARCH_LABELS: Record<ResearchAlertKind, string> = {
  perps_threshold: "Perpetual threshold", earnings_date: "Earnings date", macro_event: "Macro event", filing_type: "SEC filing", news_keyword: "News keyword", analyst_change: "Analyst change", fifty_two_week: "52-week range", unusual_volume: "Unusual volume", short_interest_change: "Short interest", insider_trade: "Insider trade", iv_spike: "IV spike", iv_level: "IV level", options_flow: "Options flow",
};
/** What an IV level rule follows, as the form, a list and a notification name it. */
export const IV_LEVEL_NAMES: Record<IvLevelMetric, string> = { atm: "30d ATM IV", rr: "30d 25D RR" };
/** An IV level in its unit: an ATM IV in percent, a risk reversal in signed vol points. */
export function formatIvLevel(metric: IvLevelMetric, value: number): string {
  const rounded = Number(value.toFixed(2));
  return metric === "atm" ? `${rounded}%` : `${rounded > 0 ? "+" : ""}${rounded} pts`;
}
/**
 * An OCC contract that has not expired, for the IV spike form's example: an
 * AAPL call on the monthly expiry (the third Friday) two months from `now`.
 */
function occContractExample(now = new Date()): string {
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1));
  const thirdFriday = 1 + ((5 - month.getUTCDay() + 7) % 7) + 14;
  const two = (value: number) => String(value).padStart(2, "0");
  return `AAPL${two(month.getUTCFullYear() % 100)}${two(month.getUTCMonth() + 1)}${two(thirdFriday)}C00300000`;
}
type Command = Parameters<Parameters<NonNullable<GloomPlugin["setup"]>>[0]["registerCommand"]>[0];
type Field = NonNullable<Command["wizard"]>[number];
/** An earnings alert goes off days before the report, or once its results are out. */
const EARNINGS_ALERT_WHEN = [{ value: "before", label: "Days before the date" }, { value: "results", label: "When results are out" }];
const choices = (values: string[]) => values.map(value => ({label: value.replaceAll("_", " "), value}));
export const researchWizardFields: Field[] = Object.keys(RESEARCH_LABELS).flatMap(kind => {
  const fields: Field[] = kind === "perps_threshold" ? [
    { key: "marketId", label: "Market", type: "text", placeholder: "hyperliquid:default:BTC", required: true },
    { key: "metric", label: "Metric", type: "select", defaultValue: "funding8h", options: [{ value: "funding8h", label: "Funding / 8h" }, { value: "oiChange24h", label: "OI change / 24h" }, { value: "premium", label: "Premium vs oracle" }, { value: "closedMarketPremium", label: "Closed-market premium" }] },
    { key: "direction", label: "Crossing", type: "select", defaultValue: "above", options: choices(["above", "below"]) },
    { key: "threshold", label: "Threshold (%)", type: "number", defaultValue: "0.1" },
  ] : kind === "iv_spike" ? [{key:"contract", label:"OCC contract", type:"text", placeholder:occContractExample(), required:true}]
    : kind === "macro_event" ? [{key:"event", label:"Release", type:"select", defaultValue:"cpi", options:MACRO_ALERT_EVENTS.map((value) => ({value, label:MACRO_EVENT_NAMES[value]}))}]
    : [{key:"symbol",label:kind === "news_keyword" ? "Symbol (optional)" : kind === "options_flow" ? "Symbol (blank: portfolio and watchlists)" : "Symbol",type:"text",placeholder:"AAPL", required:kind !== "news_keyword" && kind !== "options_flow"},
      {key:"exchange",label:"US exchange",type:"select",defaultValue:"US",options:choices(["US","NASDAQ","NYSE","ARCA","AMEX","BATS","OTC"])}];
  if (kind === "earnings_date") {
    fields.push({key:"when",label:"Alert",type:"select",defaultValue:"before",options:EARNINGS_ALERT_WHEN});
    fields.push({key:"leadDays",label:"Days before earnings",type:"number",defaultValue:String(DEFAULT_LEAD_DAYS)});
  }
  if (kind === "macro_event") fields.push({key:"leadDays",label:"Days before",type:"number",defaultValue:String(DEFAULT_LEAD_DAYS)});
  if (kind === "filing_type") fields.push({key:"form",label:"Filing type",type:"select",defaultValue:"8-K",options:choices([...RESEARCH_ALERT_FORMS])});
  if (kind === "news_keyword") fields.push({key:"keyword",label:"Keyword or phrase",type:"text",required:true,placeholder:"buyback"});
  if (kind === "iv_level") fields.push({key:"metric",label:"Measure",type:"select",defaultValue:"atm",options:[{value:"atm",label:"30d ATM IV (%)"},{value:"rr",label:"30d 25D risk reversal (vol pts)"}]});
  const directions: Partial<Record<ResearchAlertKind, string[]>> = {iv_level:["above","below"],analyst_change:["any","upgrade","downgrade"],fifty_two_week:["high","low"],short_interest_change:["either","increase","decrease"],insider_trade:["either","buy","sell"],options_flow:["any","calls","puts"]};
  const direction = directions[kind as ResearchAlertKind];
  if (direction) fields.push({key:"direction",label:kind === "options_flow" ? "Calls or puts" : "Direction",type:"select",defaultValue:direction[0],options:choices(direction)});
  if (kind === "options_flow") {
    fields.push({key:"threshold",label:"Minimum premium ($)",type:"number",defaultValue:"1000000"});
    fields.push({key:"print",label:"Print type",type:"select",defaultValue:"any",options:[{label:"any print",value:"any"},{label:"sweeps only",value:"sweep"},{label:"blocks only",value:"block"}]});
  }
  if (kind === "iv_level") fields.push({key:"threshold",label:"Level (IV %, RR vol pts)",type:"number",placeholder:"35",required:true});
  if (kind === "unusual_volume" || kind === "short_interest_change" || kind === "iv_spike") fields.push({key:"threshold",label:kind === "unusual_volume" ? "Volume / prior 20-session average" : kind === "iv_spike" ? "IV rise (percentage points)" : "Settlement change (%)",type:"number",defaultValue:kind === "unusual_volume" ? "2" : kind === "iv_spike" ? "5" : "10"});
  return fields.map(field => ({...field, key:`${kind}:${field.key}`, dependsOn: kind === "earnings_date" && field.key === "leadDays"
    // The lead time is for an alert before the date, not one waiting for results.
    ? [{key:"event",value:kind}, {key:"earnings_date:when",value:"before"}]
    : {key:"event",value:kind}}));
});
/** The Add Event Alert form filled in for an earnings alert on `symbol` that goes off once its results are out, as ERN opens it. */
export function earningsResultsAlertValues(symbol: string): Record<string, string> {
  return { event: "earnings_date", "earnings_date:symbol": symbol, "earnings_date:when": "results" };
}
export function createResearchAlert(kind: string, values: Record<string,string>, now = Date.now()): EventAlertRule {
  if (!isResearchAlertKind(kind)) throw new Error("Choose an alert event.");
  const input: Record<string,unknown> = {version:1};
  for (const [key,value] of Object.entries(values)) if (key.startsWith(`${kind}:`)) {
    const field = key.slice(kind.length+1);
    if (kind === "perps_threshold" && field === "threshold" && value.trim()) input[field] = Number(value) / 100;
    // A level reads as typed, signed (a risk reversal is often below zero) and with or without its unit.
    else if (kind === "iv_level" && field === "threshold" && value.trim()) {
      const unitError = ivLevelUnitError(values["iv_level:metric"] === "rr" ? "rr" : "atm", value);
      if (unitError) throw new Error(`${unitError}.`);
      input[field] = parseIvLevel(value);
    }
    else if (value.trim()) input[field] = field === "threshold" || field === "leadDays" ? parseAmount(value) : value;
  }
  const value = normalizeResearchRule(kind,input);
  if (!value) throw new Error(kind === "options_flow"
    ? "Check the symbol and US exchange. The minimum premium is $50,000."
    : kind === "iv_level"
      ? "Check the symbol and US exchange. An ATM IV level is 1 to 500 (%), a risk reversal -50 to 50 (vol pts)."
      : kind === "iv_spike"
        ? `Use a valid OCC contract, such as ${occContractExample()}.`
        : "Check the symbol, US exchange and event fields.");
  return {id:crypto.randomUUID(),kind,target:"rule",value,createdAt:now,status:"active"};
}
/** "2.5", "1,000,000", "$250k" and "1.5m" all read as numbers; anything else is NaN. */
export function parseAmount(value: string): number {
  const match = /^\$?\s*([0-9][0-9,_]*(?:\.[0-9]+)?)\s*([kmb])?$/i.exec(value.trim());
  if (!match) return Number.NaN;
  const scale = { k: 1e3, m: 1e6, b: 1e9 }[match[2]?.toLowerCase() as "k" | "m" | "b"] ?? 1;
  return Number(match[1]!.replace(/[,_]/g, "")) * scale;
}
const IV_LEVEL_PATTERN = /^([+-]?\d+(?:\.\d+)?)\s*(%|pts?|points?|vol pts?|vol points?)?$/i;
/** "35", "35%", "-4.5", "+2 pts" and "-5.5 vol points" read as numbers; anything else is NaN. */
export function parseIvLevel(value: string): number {
  const match = IV_LEVEL_PATTERN.exec(value.trim());
  return match ? Number(match[1]) : Number.NaN;
}
/** Why a level typed with a unit does not suit its measure (`5 pts` for an ATM IV, `-5%` for a risk reversal); null when it does or has none. */
export function ivLevelUnitError(metric: IvLevelMetric, value: string): string | null {
  const unit = IV_LEVEL_PATTERN.exec(value.trim())?.[2];
  if (!unit) return null;
  const percent = unit === "%";
  if (metric === "atm" && !percent) return `An ATM IV level is in %, not vol points ("${value.trim()}")`;
  if (metric === "rr" && percent) return `A risk reversal is in vol points, not % ("${value.trim()}")`;
  return null;
}
/** $1M, $250K, $1.5B, and $500 under a thousand. */
export function formatPremium(value: number): string {
  if (value >= 1e9) return `$${Number((value / 1e9).toFixed(1))}B`;
  if (value >= 1e6) return `$${Number((value / 1e6).toFixed(1))}M`;
  if (value >= 1e3) return `$${Number((value / 1e3).toFixed(1))}K`;
  return `$${Number(Math.max(0, value).toFixed(2))}`;
}
export function researchAlertDescription(rule: EventAlertRule): string {
  if (!isResearchAlertKind(rule.kind)) return rule.value;
  const config = readResearchRule(rule.kind,rule.value);
  if (!config) return "Invalid rule";
  const symbol = config.symbol ?? "All symbols";
  switch(rule.kind) {
    case "perps_threshold": return `${config.marketId} · ${config.metric} ${config.direction} ${((config.threshold ?? 0) * 100).toFixed(3)}%`;
    case "earnings_date": return `${symbol} · ${config.when === "results" ? "results" : `${config.leadDays}d before`}`;
    case "macro_event": return `${MACRO_EVENT_NAMES[config.event as MacroAlertEvent] ?? config.event} · ${config.leadDays}d before`;
    case "filing_type": return `${symbol} · ${config.form}`;
    case "news_keyword": return `${symbol} · ${config.keyword}`;
    case "analyst_change": case "insider_trade": return `${symbol} · ${config.direction}`;
    case "fifty_two_week": return `${symbol} · 52w ${config.direction}`;
    case "unusual_volume": return `${symbol} · ≥${config.threshold}× 20d`;
    case "short_interest_change": return `${symbol} · ${config.direction} ≥${config.threshold}%`;
    case "iv_spike": return `${config.contract} · +${config.threshold}pt`;
    case "iv_level": {
      const metric = config.metric as IvLevelMetric;
      return `${symbol} · ${IV_LEVEL_NAMES[metric]} ${config.direction} ${formatIvLevel(metric, config.threshold ?? 0)}`;
    }
    case "options_flow": return [
      config.symbol ?? "Portfolio and watchlists",
      `≥${formatPremium(config.threshold ?? 0)}`,
      config.direction === "calls" ? "calls" : config.direction === "puts" ? "puts" : null,
      config.print === "sweep" ? "sweeps" : config.print === "block" ? "blocks" : null,
    ].filter(Boolean).join(" · ");
  }
}
