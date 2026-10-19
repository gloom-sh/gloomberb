import type { SupplyChainPayload, SupplyOptions, SupplyRole, SupplyRow } from "../../../api-client/supply-chain";
import { SERIES_COLORS } from "../../../theme/series-colors";
import { revenueAmount } from "../revenue-breakdown/model";
import { countOf, freePreviewNote } from "../shared/free-preview";
import { entityTicker } from "./graph-model";
import { activeRelationship, corroborationLabel, evidenceDate, evidenceLabel, isUnconfirmed, matchesSupplyOptions, trustTier } from "./trust";

/** One colour per role from the shared series palette, the same in the table, the flow and the evidence. */
export const ROLE_COLORS: Record<SupplyRole, string> = {
  supplier: SERIES_COLORS[0], customer: SERIES_COLORS[1], partner: SERIES_COLORS[3], competitor: SERIES_COLORS[5], investee: SERIES_COLORS[7],
};

/** A company, a customer the filer does not name, or a geographic or channel cohort that is not one company. */
export type CounterpartyKind = "company" | "undisclosed" | "group";
export const counterpartyKind = (row: SupplyRow): CounterpartyKind =>
  row.counterparty.aggregate ? "group" : row.counterparty.anonymous ? "undisclosed" : "company";

const GENERIC_WORDS = /\b(And|Of|The|Based|End|Customers?|Suppliers?|Vendors?|Channel|Partners?|Undisclosed|Other|Carriers?|Networks?|Cellular|Distributors?|Retailers?)\b/g;

/** The counterparty's name without the kind spelled into it; the kind travels as its own label. */
export function counterpartyLabel(row: SupplyRow): string {
  const kind = counterpartyKind(row);
  if (kind === "company") return row.counterparty.name;
  const name = counterpartyName(row).replace(/^Group: /, "").replace(/\s*\(undisclosed\)$/i, "");
  // Cohort labels arrive in title case from XBRL member names; generic words read lower case, names keep theirs.
  return name.replace(GENERIC_WORDS, (word) => word.toLowerCase()).replace(/^./, (first) => first.toUpperCase());
}
export const counterpartyKindLabel = (row: SupplyRow, short = false) => {
  const kind = counterpartyKind(row);
  if (short) return kind === "group" ? "group" : kind === "undisclosed" ? "undisclosed" : null;
  return kind === "group" ? `${row.role} group` : kind === "undisclosed" ? `undisclosed ${row.role}` : null;
};

/** A filer's segment or product scope in plain words: "Compute And Networking Segment" reads "Compute & Networking". */
export function scopeWords(scope: string): string {
  return scope.replace(/^Business segments?:\s*/i, "").replace(/\s+segment$/i, "").replace(/\s+and\s+/gi, " & ")
    .replace(/^non[\s-]?us$/i, "non-US").trim();
}

/**
 * A disclosed share and what it is a share of, in words. The denominator is
 * always the reporting company's: a supplier saying the focus company is 91%
 * of its revenue reads "of CRUS revenue", never as the focus company's.
 */
export function shareParts(row: SupplyRow, focusId?: string | null, { includeReporter = false }: { includeReporter?: boolean } = {}): { value: string; basis: string } | null {
  if (row.pctOfRevenue === null || row.pctBasis === null || trustTier(row) !== 1 || isUnconfirmed(row) || !activeRelationship(row)) return null;
  const reporter = includeReporter || (focusId && row.reportingEntity.id !== focusId) ? `${entityTicker(row.reportingEntity) ?? row.reportingEntity.name} ` : "";
  const scope = row.pctScope ? scopeWords(row.pctScope) : "";
  const basis = row.pctBasis === "cost" ? "cost of sales" : row.pctBasis;
  // XBRL dimensions can qualify the numerator, denominator, or both. NVDA's
  // NonUs fact is a share of total revenue, while TW omits a Data Center qualifier.
  // Neither supports turning its dimensional member into an "of ..." claim.
  if (row.sourceKind === "xbrl" && scope) return { value: `${Number(row.pctOfRevenue.toFixed(1))}%`, basis: `${reporter}${basis} · context: ${scope}` };
  // A scope that names its own denominator ("Vendor non-trade receivables") is a description, read in lower case.
  const scoped = scope && scope.toLowerCase().includes(basis) ? scope.replace(/^[A-Z](?=[a-z])/, (first) => first.toLowerCase()) : `${scope ? `${scope} ` : ""}${basis}`;
  // Form alone does not identify a metric's duration: a 10-Q includes YTD facts.
  return { value: `${Number(row.pctOfRevenue.toFixed(1))}%`, basis: `of ${reporter}${scoped}` };
}
/** An XBRL fact's tagged dimensions, as the filing reader stores them in place of a sentence: "ConcentrationRiskByType=CustomerConcentrationRisk;MajorCustomers=StandardChartered;". */
const TAGGED_DIMENSIONS = /^\s*[A-Za-z][\w.:-]*=[^;=]*(?:;\s*[A-Za-z][\w.:-]*=[^;=]*)*;?\s*$/;
export const isTaggedFact = (row: Pick<SupplyRow, "sourceKind" | "quote">) => row.sourceKind === "xbrl" && TAGGED_DIMENSIONS.test(row.quote);

/**
 * What a disclosure says, in words. A sentence from the filing reads as it is;
 * a tagged XBRL fact reads as the kind of concentration it tags, its tagged
 * context and what the share is of: "Customer, Gold, revenue", never the
 * dimension names.
 */
export function disclosureText(row: Pick<SupplyRow, "sourceKind" | "quote" | "pctScope" | "pctBasis">): string {
  if (!isTaggedFact(row)) return row.quote;
  const type = /(?:^|;)\s*ConcentrationRiskByType=([^;]*)/.exec(row.quote)?.[1]?.replace(/^.*:/, "").replace(/ConcentrationRisk(Member)?$/, "") ?? "";
  const kind = type.replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  const basis = row.pctBasis === "cost" ? "cost of sales" : row.pctBasis;
  return [kind ? kind[0]!.toUpperCase() + kind.slice(1).toLowerCase() : null, row.pctScope ? scopeWords(row.pctScope) : null, basis]
    .filter((part): part is string => !!part).join(", ") || "Tagged in the filing";
}

export function counterpartyName(row: SupplyRow): string {
  if (row.counterparty.aggregate) return `Group: ${row.counterparty.name.replace(/^Undisclosed customer \((.+)\)$/i, "$1")}`;
  if (!row.counterparty.anonymous) return row.counterparty.name;
  const name = row.counterparty.name;
  const member = name.match(/^Undisclosed [^(]+\((.+)\)$/i)?.[1]
    ?? (name.toLowerCase().startsWith("undisclosed") ? null : name);
  if (/^undisclosed/i.test(member ?? "")) return member!;
  return member ? `${member.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s*\(undisclosed\)/gi, "")} (undisclosed)` : name;
}
export const roleLabel = (role: SupplyRole) => role[0]!.toUpperCase() + role.slice(1);

const SUPPLY_ROLE_ORDER: readonly SupplyRole[] = ["customer", "supplier", "partner", "competitor", "investee"];
export interface SupplyRoleCount { role: SupplyRole; counterparties: number; locked: number }

/**
 * The one count behind the figures over the table, the flow and the headless
 * report: per role, the companies the reader can see, each counted once
 * however many disclosures name it (the flow draws one card per counterparty
 * and role). Unconfirmed leads, inactive links and cohort groups are not
 * counterparties. The server's counts are disclosures, not companies, so what
 * a free preview withholds is reported apart as locked disclosures rather
 * than added to the companies.
 */
export function supplyRoleCounts(data: Pick<SupplyChainPayload, "says" | "names" | "counts" | "earlier" | "earlierCounts">, views: readonly ("says" | "names")[], options: Required<SupplyOptions>): SupplyRoleCount[] {
  return SUPPLY_ROLE_ORDER.map((role) => {
    const companies = new Set<string>();
    let locked = 0;
    for (const view of views) {
      const rows = data[view].filter((row) => row.role === role);
      for (const row of rows) if (!row.counterparty.aggregate && !isUnconfirmed(row) && matchesSupplyOptions(row, options)) companies.add(row.counterparty.id);
      locked += Math.max(0, data.counts[view][role] - rows.length)
        + Math.max(0, (data.earlierCounts?.[view][role] ?? 0) - earlierRows(data, view).filter((row) => row.role === role).length);
    }
    return { role, counterparties: companies.size, locked };
  }).filter((entry) => entry.counterparties > 0 || entry.locked > 0);
}

/**
 * A view's shares from before the latest period their reporter disclosed on
 * the same basis: dated, listed apart from the current rows and never counted
 * as current counterparties. Empty from servers that do not split them.
 */
export const earlierRows = (data: Pick<SupplyChainPayload, "earlier">, view: "says" | "names"): SupplyRow[] => data.earlier?.[view] ?? [];

/** Disclosures a free preview withholds from these views: the server's counts less the rows it sent. */
export function lockedDisclosures(data: Pick<SupplyChainPayload, "says" | "names" | "counts" | "earlier" | "earlierCounts">, views: readonly ("says" | "names")[]): number {
  const total = (counts: Record<SupplyRole, number> | undefined) => Object.values(counts ?? {}).reduce((a, b) => a + b, 0);
  return views.reduce((sum, view) => sum + Math.max(0, total(data.counts[view]) - data[view].length)
    + Math.max(0, total(data.earlierCounts?.[view]) - earlierRows(data, view).length), 0);
}

/** The lock line of a free preview, in the same words in the pane and `fn SPLC`. */
export function supplyPreviewNote(data: Pick<SupplyChainPayload, "previewRowsPerRole">, locked: number): string {
  return freePreviewNote({ shows: data.previewRowsPerRole ? `${countOf(data.previewRowsPerRole, "relationship")} per role` : "part of the relationships",
    adds: locked > 0 ? `${locked.toLocaleString("en-US")} more` : null });
}

export const percentage = (row: SupplyRow) => row.pctOfRevenue === null || trustTier(row) !== 1 || isUnconfirmed(row) || !activeRelationship(row) ? "--" : `${Number(row.pctOfRevenue.toFixed(2))}% ${row.pctScope ? "scoped " : ""}${row.pctBasis ?? ""}`;
export const dollars = (row: SupplyRow) => row.usd === null ? "--" : `${row.usdBasis === "derived" ? "≈ " : ""}$${revenueAmount(row.usd)} ${row.usdBasis}`;
const scaleLabel = (scale: number) => scale === 1 ? "" : scale === 1_000 ? " thousand" : scale === 1_000_000 ? " million" : scale === 1_000_000_000 ? " billion" : ` ×${scale.toLocaleString("en-US")}`;
/** Retain the original currency and disclosed scale; never imply an FX conversion. */
export const nativeValue = (row: SupplyRow) => row.nativeAmount == null || !row.nativeCurrency || !row.nativeScale ? null
  : `${row.nativeAmount.toLocaleString("en-US", { maximumFractionDigits: 12 })} ${row.nativeCurrency}${scaleLabel(row.nativeScale)}`;
export const disclosedValue = (row: SupplyRow) => nativeValue(row) ?? dollars(row);
const QUOTE_LANGUAGES: Record<string, string> = { ko: "Korean", ja: "Japanese", zh: "Chinese", "zh-TW": "Chinese", "zh-Hant": "Chinese", "zh-Hans": "Chinese", en: "English" };
export const quoteLanguageLabel = (row: Pick<SupplyRow, "quoteLanguage">) => QUOTE_LANGUAGES[row.quoteLanguage ?? ""] ?? row.quoteLanguage ?? "original language";
/**
 * How long a period is, in the words the KPI pane uses for a period's kind:
 * a share of receivables is a balance at the period end, an instant. Null
 * when the source does not say; a form or a period label never does.
 */
function periodLength(months: number | null | undefined): string | null {
  if (months == null) return null;
  return months === 0 ? "instant" : months === 3 ? "quarter" : months === 6 ? "half" : months === 12 ? "year" : `${months} month${months === 1 ? "" : "s"}`;
}
/** The period end with its length when the source states it: 2026-07-31 half. */
export const periodText = (row: Pick<SupplyRow, "period" | "periodMonths">) => {
  const length = periodLength(row.periodMonths);
  return length ? `${row.period} ${length}` : row.period;
};
export const sourceLabel = (row: SupplyRow) => row.sourceKind === "xbrl" ? "XBRL" : row.sourceKind === "filing_text" ? row.form ?? "Filing" : row.sourceKind === "call" ? "Call" : row.sourceKind === "news" ? "News" : row.sourceKind === "press_release" ? "Release" : row.sourceKind === "web" ? "Web" : "Disclosure";
export function cellText(row: SupplyRow, column: string): string {
  return column === "name" ? counterpartyName(row) : column === "ticker" ? entityTicker(row.counterparty) ?? "--"
    : column === "role" ? roleLabel(row.role) : column === "direction" ? row.direction === "in" ? "In" : row.direction === "out" ? "Out" : "Both"
    : column === "pct" ? percentage(row) : column === "usd" ? disclosedValue(row) : column === "fy" ? periodText(row)
    : column === "publisher" ? row.evidence?.find((item) => item.status === "active")?.publisher ?? row.reportingEntity.name
    : column === "corroboration" ? corroborationLabel(row)
    : column === "evidence" ? evidenceLabel(row) : column === "source" ? sourceLabel(row) : column === "filed" ? evidenceDate(row) : `${Math.round(row.confidence * 100)}%`;
}
export type SupplySort = { column: string; direction: "asc" | "desc" };
/** Shares of different bases never rank against each other: revenue first, receivables last. */
const SHARE_BASIS_ORDER: readonly SupplyRow["pctBasis"][] = ["revenue", "cost", "purchases", "receivables"];
export function sortRows(rows: SupplyRow[], sort: SupplySort): SupplyRow[] {
  const value = (row: SupplyRow): string | number | null => sort.column === "pct" ? row.pctOfRevenue : sort.column === "usd" ? row.nativeAmount != null ? row.nativeAmount * (row.nativeScale ?? 1) : row.usd
    : sort.column === "confidence" ? row.confidence : sort.column === "evidence" ? trustTier(row) : cellText(row, sort.column).toLowerCase();
  return [...rows].sort((a, b) => { const x = value(a), y = value(b);
    // Group currencies before comparing amounts. JPY and KRW have no common numeric scale.
    if (sort.column === "usd" && x !== null && y !== null) {
      const currency = (row: SupplyRow) => row.nativeAmount != null ? row.nativeCurrency! : "USD";
      const difference = currency(a).localeCompare(currency(b));
      if (difference) return difference;
    }
    // Group bases before comparing shares: 30% of receivables is not more than 21% of revenue.
    if (sort.column === "pct" && x !== null && y !== null) {
      const difference = SHARE_BASIS_ORDER.indexOf(a.pctBasis) - SHARE_BASIS_ORDER.indexOf(b.pctBasis);
      if (difference) return difference;
    }
    return x === null || y === null ? x === y ? 0 : x === null ? 1 : -1
    : x === y ? a.id.localeCompare(b.id) : (x < y ? -1 : 1) * (sort.direction === "asc" ? 1 : -1); });
}
/** Cohort concentrations beside the flow: never nodes or ribbons, one latest disclosure per group and role. */
export function flowGroups(rows: readonly SupplyRow[]): SupplyRow[] {
  const seen = new Set<string>();
  return [...rows].filter((row) => row.counterparty.aggregate && !isUnconfirmed(row) && activeRelationship(row)).sort((a, b) => b.asOf.localeCompare(a.asOf) || (b.pctOfRevenue ?? -1) - (a.pctOfRevenue ?? -1))
    .filter((row) => { const key = `${row.counterparty.id}:${row.role}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => (b.pctOfRevenue ?? -1) - (a.pctOfRevenue ?? -1));
}

export type FlowBand = "suppliers" | "customers" | "related";
export interface FlowNode { id: string; label: string; row: SupplyRow | null; band: FlowBand; more: number; weight: number | null; weightScope: string | null; weightBasis: "revenue" | "usd" | null; }
const revenueKey = (row: SupplyRow) => JSON.stringify([row.reportingEntity.id, row.period, row.pctScope]);
/** Percentages from different filers and denominators are never summed. One latest edge per counterparty/role is drawn. */
export function flowBands(rows: SupplyRow[], limit: number, pages: Partial<Record<FlowBand, number>> = {}, focusId?: string): Record<FlowBand, FlowNode[]> {
  const grouped: Record<FlowBand, SupplyRow[]> = { suppliers: [], customers: [], related: [] };
  const seen = new Set<string>();
  for (const row of [...rows].sort((a, b) => trustTier(a) - trustTier(b) || b.asOf.localeCompare(a.asOf) || Number(b.pctOfRevenue !== null || b.usd !== null) - Number(a.pctOfRevenue !== null || a.usd !== null) || b.confidence - a.confidence)) {
    if (row.counterparty.aggregate || isUnconfirmed(row) || !activeRelationship(row)) continue;
    const key = `${row.counterparty.id}:${row.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    grouped[row.role === "supplier" ? "suppliers" : row.role === "customer" ? "customers" : "related"].push(row);
  }
  return Object.fromEntries((Object.keys(grouped) as FlowBand[]).map((band) => {
    const values = sortRows(grouped[band], { column: "pct", direction: "desc" });
    // One reporter, period and revenue scope form a compatible percentage scale,
    // and a quarter and a half ending on that date do not: each stated length
    // is its own scale, which a share whose length is not stated can join.
    // Prefer the largest compatible group, then whole-company revenue on a tie.
    const revenueGroups = new Map<string, { length: number | null; rows: SupplyRow[] }>();
    const unstated = new Map<string, SupplyRow[]>();
    for (const row of values) if (trustTier(row) === 1 && band === "customers" && row.pctBasis === "revenue" && !(row.sourceKind === "xbrl" && row.pctScope) && (row.pctOfRevenue ?? 0) > 0 && (!focusId || row.reportingEntity.id === focusId)) {
      const key = revenueKey(row), length = row.periodMonths ?? null;
      if (length === null) unstated.set(key, [...(unstated.get(key) ?? []), row]);
      else revenueGroups.set(`${key}:${length}`, { length, rows: [...(revenueGroups.get(`${key}:${length}`)?.rows ?? []), row] });
    }
    for (const [key, rows] of unstated) {
      const stated = [...revenueGroups.values()].filter((group) => revenueKey(group.rows[0]!) === key);
      for (const group of stated) group.rows.push(...rows);
      if (!stated.length) revenueGroups.set(key, { length: null, rows });
    }
    const revenueGroup = [...revenueGroups.values()].sort((a, b) => b.rows.length - a.rows.length || Number(a.rows[0]!.pctScope !== null) - Number(b.rows[0]!.pctScope !== null))[0];
    const scaleKey = revenueGroup ? revenueKey(revenueGroup.rows[0]!) : null;
    const value = (row: SupplyRow) => trustTier(row) !== 1 ? 0 : scaleKey === null ? row.usd ?? 0
      : row.pctBasis === "revenue" && !(row.sourceKind === "xbrl" && row.pctScope) && revenueKey(row) === scaleKey
        && (row.periodMonths == null || revenueGroup!.length === null || row.periodMonths === revenueGroup!.length) ? row.pctOfRevenue ?? 0 : 0;
    // Use the entire band: paging must not change an existing ribbon's width.
    const max = Math.max(0, ...values.map(value));
    const ordered = [...values].sort((a, b) => value(b) - value(a));
    const pageSize = Math.max(1, limit - 1), paged = values.length > limit;
    const start = paged ? ((pages[band] ?? 0) % Math.ceil(values.length / pageSize)) * pageSize : 0;
    const visible = ordered.slice(start, start + (paged ? pageSize : limit));
    const nodes: FlowNode[] = visible.map((row) => ({ id: row.id, label: counterpartyName(row), row, band, more: 0,
      weight: value(row) > 0 ? value(row) / max : null, weightScope: revenueGroup?.rows[0]?.pctScope ?? null, weightBasis: scaleKey ? "revenue" : max > 0 ? "usd" : null }));
    if (paged) nodes.push({ id: `more:${band}`, label: `+${values.length - visible.length} more`, row: null, band, more: values.length - visible.length, weight: null, weightScope: null, weightBasis: null });
    return [band, nodes];
  })) as Record<FlowBand, FlowNode[]>;
}
