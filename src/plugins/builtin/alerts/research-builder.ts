import type { GloomPlugin } from "../../../types/plugin";
import { isResearchAlertKind, normalizeResearchRule, readResearchRule, RESEARCH_ALERT_FORMS, type ResearchAlertKind } from "./research-rules";
import type { EventAlertRule } from "./events";

export const RESEARCH_LABELS: Record<ResearchAlertKind, string> = {
  earnings_date: "Earnings date", filing_type: "SEC filing", news_keyword: "News keyword", analyst_change: "Analyst change", fifty_two_week: "52-week range", unusual_volume: "Unusual volume", short_interest_change: "Short interest", insider_trade: "Insider trade", iv_spike: "IV spike", options_flow: "Options flow",
};
type Command = Parameters<Parameters<NonNullable<GloomPlugin["setup"]>>[0]["registerCommand"]>[0];
type Field = NonNullable<Command["wizard"]>[number];
const choices = (values: string[]) => values.map(value => ({label: value.replaceAll("_", " "), value}));
export const researchWizardFields: Field[] = Object.keys(RESEARCH_LABELS).flatMap(kind => {
  const fields: Field[] = kind === "iv_spike" ? [{key:"contract", label:"OCC contract", type:"text", placeholder:"AAPL261016C00300000", required:true}]
    : [{key:"symbol",label:kind === "news_keyword" ? "Symbol (optional)" : kind === "options_flow" ? "Symbol (blank: portfolio and watchlists)" : "Symbol",type:"text",placeholder:"AAPL", required:kind !== "news_keyword" && kind !== "options_flow"},
      {key:"exchange",label:"US exchange",type:"select",defaultValue:"US",options:choices(["US","NASDAQ","NYSE","ARCA","AMEX","BATS","OTC"])}];
  if (kind === "earnings_date") fields.push({key:"leadDays",label:"Days before earnings",type:"number",defaultValue:"1"});
  if (kind === "filing_type") fields.push({key:"form",label:"Filing type",type:"select",defaultValue:"8-K",options:choices([...RESEARCH_ALERT_FORMS])});
  if (kind === "news_keyword") fields.push({key:"keyword",label:"Keyword or phrase",type:"text",required:true,placeholder:"buyback"});
  const directions: Partial<Record<ResearchAlertKind, string[]>> = {analyst_change:["any","upgrade","downgrade"],fifty_two_week:["high","low"],short_interest_change:["either","increase","decrease"],insider_trade:["either","buy","sell"],options_flow:["any","calls","puts"]};
  const direction = directions[kind as ResearchAlertKind];
  if (direction) fields.push({key:"direction",label:kind === "options_flow" ? "Calls or puts" : "Direction",type:"select",defaultValue:direction[0],options:choices(direction)});
  if (kind === "options_flow") {
    fields.push({key:"threshold",label:"Minimum premium ($)",type:"number",defaultValue:"1000000"});
    fields.push({key:"print",label:"Print type",type:"select",defaultValue:"any",options:[{label:"any print",value:"any"},{label:"sweeps only",value:"sweep"},{label:"blocks only",value:"block"}]});
  }
  if (kind === "unusual_volume" || kind === "short_interest_change" || kind === "iv_spike") fields.push({key:"threshold",label:kind === "unusual_volume" ? "Volume / prior 20-session average" : kind === "iv_spike" ? "IV rise (percentage points)" : "Settlement change (%)",type:"number",defaultValue:kind === "unusual_volume" ? "2" : kind === "iv_spike" ? "5" : "10"});
  return fields.map(field => ({...field, key:`${kind}:${field.key}`, dependsOn:{key:"event",value:kind}}));
});
export function createResearchAlert(kind: string, values: Record<string,string>, now = Date.now()): EventAlertRule {
  if (!isResearchAlertKind(kind)) throw new Error("Choose an alert event.");
  const input: Record<string,unknown> = {version:1};
  for (const [key,value] of Object.entries(values)) if (key.startsWith(`${kind}:`)) {
    const field = key.slice(kind.length+1);
    if (value.trim()) input[field] = field === "threshold" || field === "leadDays" ? parseAmount(value) : value;
  }
  const value = normalizeResearchRule(kind,input);
  if (!value) throw new Error(kind === "options_flow"
    ? "Check the symbol and US exchange. The minimum premium is $50,000."
    : "Check the symbol, US exchange and event fields. Use a valid OCC contract for IV alerts.");
  return {id:crypto.randomUUID(),kind,target:"rule",value,createdAt:now,status:"active"};
}
/** "2.5", "1,000,000", "$250k" and "1.5m" all read as numbers; anything else is NaN. */
export function parseAmount(value: string): number {
  const match = /^\$?\s*([0-9][0-9,_]*(?:\.[0-9]+)?)\s*([kmb])?$/i.exec(value.trim());
  if (!match) return Number.NaN;
  const scale = { k: 1e3, m: 1e6, b: 1e9 }[match[2]?.toLowerCase() as "k" | "m" | "b"] ?? 1;
  return Number(match[1]!.replace(/[,_]/g, "")) * scale;
}
/** $1M, $250K, $1.5B. */
export function formatPremium(value: number): string {
  if (value >= 1e9) return `$${Number((value / 1e9).toFixed(1))}B`;
  if (value >= 1e6) return `$${Number((value / 1e6).toFixed(1))}M`;
  return `$${Math.round(value / 1e3)}K`;
}
export function researchAlertDescription(rule: EventAlertRule): string {
  if (!isResearchAlertKind(rule.kind)) return rule.value;
  const config = readResearchRule(rule.kind,rule.value);
  if (!config) return "Invalid rule";
  const symbol = config.symbol ?? "All symbols";
  switch(rule.kind) {
    case "earnings_date": return `${symbol} · ${config.leadDays}d before`;
    case "filing_type": return `${symbol} · ${config.form}`;
    case "news_keyword": return `${symbol} · ${config.keyword}`;
    case "analyst_change": case "insider_trade": return `${symbol} · ${config.direction}`;
    case "fifty_two_week": return `${symbol} · 52w ${config.direction}`;
    case "unusual_volume": return `${symbol} · ≥${config.threshold}× 20d`;
    case "short_interest_change": return `${symbol} · ${config.direction} ≥${config.threshold}%`;
    case "iv_spike": return `${config.contract} · +${config.threshold}pt`;
    case "options_flow": return [
      config.symbol ?? "Portfolio and watchlists",
      `≥${formatPremium(config.threshold ?? 0)}`,
      config.direction === "calls" ? "calls" : config.direction === "puts" ? "puts" : null,
      config.print === "sweep" ? "sweeps" : config.print === "block" ? "blocks" : null,
    ].filter(Boolean).join(" · ");
  }
}
