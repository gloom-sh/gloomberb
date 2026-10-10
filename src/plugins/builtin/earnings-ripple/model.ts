import type { EarningsCalendarReport, EarningsTiming } from "../../../api-client/earnings";
import type { SupplyChainPayload, SupplyEntity, SupplyRow } from "../../../api-client/supply-chain";
import type { GraphPath, GraphPayload } from "../../../api-client/supply-chain-graph";
import { isUsListingExchange } from "../../../utils/exchanges";
import { MIN_AVERAGE_REPORTS } from "../earnings/board-model";
import { exposureLabel } from "../supply-chain/graph-model";

/** Days ahead the calendar is read. */
export const RIPPLE_DAYS = 30;

export interface RippleRow {
  id: string;
  /** The company that reports. */
  company: string;
  companyName: string;
  /** `customer`: the company buys from the holding. `supplier`: it sells to the holding. */
  link: "customer" | "supplier";
  date: string;
  timing: EarningsTiming | null;
  /** Mean absolute move over the company's last reports, once it has as many as ERN requires. */
  averageMove: number | null;
  holding: string;
  /**
   * Percent of the seller's revenue, as the seller's filing discloses it: the
   * holding's revenue for a customer, the supplier's revenue for a supplier.
   */
  pctOfRevenue: number;
  pctScope: string | null;
  period: string;
  /** The holding's own next report in the window, when it has one. */
  holdingDate: string | null;
}

/** Whose revenue the share is of. */
export const revenueOwner = (row: RippleRow) => row.link === "customer" ? row.holding : row.company;

/**
 * Listed counterparties in one role with a share of the seller's revenue: one
 * per company, the latest period, then the larger share. Receivables and
 * purchase shares measure something else and are left out.
 */
function revenueLinks(rows: readonly SupplyRow[], role: "customer" | "supplier"): SupplyRow[] {
  const best = new Map<string, SupplyRow>();
  for (const row of rows) {
    const ticker = row.counterparty.ticker;
    if (row.role !== role || !ticker || row.counterparty.aggregate || row.pctBasis !== "revenue" || row.pctOfRevenue == null) continue;
    // The calendar covers US listings; a foreign code such as Foxconn's 2317 could collide with one.
    if (row.counterparty.exchange && !isUsListingExchange(row.counterparty.exchange)) continue;
    const key = ticker.toUpperCase();
    const current = best.get(key);
    if (!current || row.period > current.period || (row.period === current.period && row.pctOfRevenue > current.pctOfRevenue!)) best.set(key, row);
  }
  return [...best.values()];
}

/** Customers a holding names (`says`) and suppliers that name it (`names`), each with its link. */
function rippleLinks(chain: SupplyChainPayload) {
  return [
    ...revenueLinks(chain.says, "customer").map((row) => ({ row, link: "customer" as const })),
    ...revenueLinks(chain.names, "supplier").map((row) => ({ row, link: "supplier" as const })),
  ];
}

/** Calendar symbols use the same eligibility as the displayed rows, in both directions. */
export function rippleCompanyTickers(chains: ReadonlyMap<string, SupplyChainPayload>): string[] {
  const companies = new Set<string>();
  for (const [holding, chain] of chains) {
    for (const { row } of rippleLinks(chain)) {
      const company = row.counterparty.ticker!.toUpperCase();
      if (company !== holding.toUpperCase()) companies.add(company);
    }
  }
  return [...companies];
}

/** Each company's soonest report in the window. */
function nextReports(reports: readonly EarningsCalendarReport[]) {
  const next = new Map<string, EarningsCalendarReport>();
  for (const report of reports) {
    const key = report.symbol.toUpperCase();
    const current = next.get(key);
    if (!current || report.date < current.date) next.set(key, report);
  }
  return next;
}

/**
 * Customers a holding names in its own filings (`says`), and suppliers whose
 * filings name the holding as a customer (`names`), that report in the
 * calendar: soonest first, then by the share.
 */
export function projectRipple(chains: ReadonlyMap<string, SupplyChainPayload>, reports: readonly EarningsCalendarReport[]): RippleRow[] {
  const next = nextReports(reports);
  const rows: RippleRow[] = [];
  for (const [holding, chain] of chains) {
    for (const { row, link } of rippleLinks(chain)) {
      const company = row.counterparty.ticker!.toUpperCase();
      const report = next.get(company);
      if (!report || company === holding.toUpperCase()) continue;
      rows.push({ id: `${holding}:${link}:${company}`, company, companyName: report.name ?? row.counterparty.name, link, date: report.date,
        timing: report.timing, averageMove: report.averageReports >= MIN_AVERAGE_REPORTS ? report.averageMove : null, holding, pctOfRevenue: row.pctOfRevenue!, pctScope: row.pctScope,
        period: row.period, holdingDate: next.get(holding.toUpperCase())?.date ?? null });
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || b.pctOfRevenue - a.pctOfRevenue || a.holding.localeCompare(b.holding));
}

/** One hop of a two-hop route, with the share the reporting company's filing discloses. */
export interface RippleHop {
  /** Whose figure it is: the reporting company. */
  owner: string;
  pct: number | null;
  basis: SupplyRow["pctBasis"];
  scoped: boolean;
}

export interface SecondHopRow extends Omit<RippleRow, "pctOfRevenue" | "pctScope" | "period"> {
  /** The company between the holding and the one that reports. */
  via: string;
  viaName: string;
  /** Holding to via, then via to the company. */
  hops: [RippleHop, RippleHop];
  /** Chained estimate along the route, when every hop's figure is compatible. */
  exposure: string | null;
}

const entityLabel = (entity: SupplyEntity) => entity.ticker?.toUpperCase() ?? entity.name;

interface SecondHopLink { holding: string; company: SupplyEntity; via: SupplyEntity; link: "customer" | "supplier"; path: GraphPath; graph: GraphPayload }

/**
 * Companies two disclosed hops from each holding: a supplier's supplier
 * (upstream) or a customer's customer (downstream). Anyone the holding already
 * has a direct link with, in its disclosures or in the graph, is hop 1 and is
 * left out, as are companies outside the US calendar. One row per holding and
 * company: the higher-scoring route when both directions reach it.
 */
export function secondHopLinks(chains: ReadonlyMap<string, SupplyChainPayload>, graphs: ReadonlyMap<string, GraphPayload>): SecondHopLink[] {
  const result: SecondHopLink[] = [];
  for (const [holding, graph] of graphs) {
    const chain = chains.get(holding);
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const reaches = [...graph.upstream, ...graph.downstream];
    const direct = new Set([holding.toUpperCase(),
      ...[...chain?.says ?? [], ...chain?.names ?? []].flatMap((row) => row.counterparty.ticker ? [row.counterparty.ticker.toUpperCase()] : []),
      ...reaches.filter((reach) => reach.hops === 1).flatMap((reach) => nodes.get(reach.entityId)?.ticker?.toUpperCase() ?? [])]);
    const best = new Map<string, SecondHopLink>();
    for (const reach of reaches) {
      const path = reach.shortestPath;
      const company = nodes.get(reach.entityId);
      const via = nodes.get(path.nodeIds[1] ?? "");
      const ticker = company?.ticker?.toUpperCase();
      if (reach.hops !== 2 || path.hops !== 2 || !company || !via || !ticker || company.aggregate || direct.has(ticker)) continue;
      if (company.exchange && !isUsListingExchange(company.exchange)) continue;
      const current = best.get(ticker);
      if (!current || path.score > current.path.score) best.set(ticker, { holding, company, via, link: reach.direction === "upstream" ? "supplier" : "customer", path, graph });
    }
    result.push(...best.values());
  }
  return result;
}

function hopShare(graph: GraphPayload, linkId: string): RippleHop {
  const link = graph.links.find((entry) => entry.id === linkId);
  const evidence = link?.evidence.find((item) => item.id === link.primaryEvidenceId);
  return { owner: evidence ? entityLabel(evidence.reporter) : "--", pct: evidence?.pctOfRevenue ?? null, basis: evidence?.pctBasis ?? null, scoped: !!evidence?.pctScope };
}

/** `30% of TSM`, `12% of AVGO purchases`, or `--` where the filing names the link without a figure. */
export function hopLabel(hop: RippleHop) {
  if (hop.pct == null) return "--";
  return `${hop.pct}%${hop.scoped ? "*" : ""} of ${hop.owner}${hop.basis && hop.basis !== "revenue" ? ` ${hop.basis}` : ""}`;
}

export function projectSecondHop(chains: ReadonlyMap<string, SupplyChainPayload>, graphs: ReadonlyMap<string, GraphPayload>, reports: readonly EarningsCalendarReport[]): SecondHopRow[] {
  const next = nextReports(reports);
  const rows: SecondHopRow[] = [];
  for (const { holding, company, via, link, path, graph } of secondHopLinks(chains, graphs)) {
    const ticker = company.ticker!.toUpperCase();
    const report = next.get(ticker);
    if (!report) continue;
    rows.push({ id: `${holding}:${link}:2:${ticker}`, company: ticker, companyName: report.name ?? company.name, link, date: report.date, timing: report.timing,
      averageMove: report.averageReports >= MIN_AVERAGE_REPORTS ? report.averageMove : null, holding, holdingDate: next.get(holding.toUpperCase())?.date ?? null,
      via: entityLabel(via), viaName: via.name, hops: [hopShare(graph, path.linkIds[0]!), hopShare(graph, path.linkIds[1]!)],
      exposure: path.exposure ? exposureLabel(path, graph) : null });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.holding.localeCompare(b.holding) || a.company.localeCompare(b.company));
}
