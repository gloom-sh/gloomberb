import type { GloomPlugin } from "../../../types/plugin";
import { isResearchAlertKind, normalizeResearchRule, readResearchRule, RESEARCH_ALERT_FORMS, type ResearchAlertKind } from "./research-rules";
import type { EventAlertRule } from "./events";

export const RESEARCH_LABELS: Record<ResearchAlertKind, string> = {
  earnings_date: "Earnings date", filing_type: "SEC filing", news_keyword: "News keyword", analyst_change: "Analyst change", fifty_two_week: "52-week range", unusual_volume: "Unusual volume", short_interest_change: "Short interest", insider_trade: "Insider trade", iv_spike: "IV spike",
};
type Command = Parameters<Parameters<NonNullable<GloomPlugin["setup"]>>[0]["registerCommand"]>[0];
type Field = NonNullable<Command["wizard"]>[number];
const choices = (values: string[]) => values.map(value => ({label: value.replaceAll("_", " "), value}));
export const researchWizardFields: Field[] = Object.keys(RESEARCH_LABELS).flatMap(kind => {
  const fields: Field[] = kind === "iv_spike" ? [{key:"contract", label:"OCC contract", type:"text", placeholder:"AAPL261016C00300000", required:true}]
    : [{key:"symbol",label:kind === "news_keyword" ? "Symbol (optional)" : "Symbol",type:"text",placeholder:"AAPL", required:kind !== "news_keyword"},
      {key:"exchange",label:"US exchange",type:"select",defaultValue:"US",options:choices(["US","NASDAQ","NYSE","ARCA","AMEX","BATS","OTC"])}];
  if (kind === "earnings_date") fields.push({key:"leadDays",label:"Days before earnings",type:"number",defaultValue:"1"});
  if (kind === "filing_type") fields.push({key:"form",label:"Filing type",type:"select",defaultValue:"8-K",options:choices([...RESEARCH_ALERT_FORMS])});
  if (kind === "news_keyword") fields.push({key:"keyword",label:"Keyword or phrase",type:"text",required:true,placeholder:"buyback"});
  const directions: Partial<Record<ResearchAlertKind, string[]>> = {analyst_change:["any","upgrade","downgrade"],fifty_two_week:["high","low"],short_interest_change:["either","increase","decrease"],insider_trade:["either","buy","sell"]};
  const direction = directions[kind as ResearchAlertKind];
  if (direction) fields.push({key:"direction",label:"Direction",type:"select",defaultValue:direction[0],options:choices(direction)});
  if (kind === "unusual_volume" || kind === "short_interest_change" || kind === "iv_spike") fields.push({key:"threshold",label:kind === "unusual_volume" ? "Volume / prior 20-session average" : kind === "iv_spike" ? "IV rise (percentage points)" : "Settlement change (%)",type:"number",defaultValue:kind === "unusual_volume" ? "2" : kind === "iv_spike" ? "5" : "10"});
  return fields.map(field => ({...field, key:`${kind}:${field.key}`, dependsOn:{key:"event",value:kind}}));
});
export function createResearchAlert(kind: string, values: Record<string,string>, now = Date.now()): EventAlertRule {
  if (!isResearchAlertKind(kind)) throw new Error("Choose an alert event.");
  const input: Record<string,unknown> = {version:1};
  for (const [key,value] of Object.entries(values)) if (key.startsWith(`${kind}:`)) {
    const field = key.slice(kind.length+1);
    if (value.trim()) input[field] = field === "threshold" || field === "leadDays" ? Number(value) : value;
  }
  const value = normalizeResearchRule(kind,input);
  if (!value) throw new Error("Check the symbol, US exchange and event fields. Use a valid OCC contract for IV alerts.");
  return {id:crypto.randomUUID(),kind,target:"rule",value,createdAt:now,status:"active"};
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
  }
}
