import type { EarningsCalendarPayload, EarningsCalendarQuery } from "../../../api-client/earnings";
import type { SupplyChainPayload } from "../../../api-client/supply-chain";
import { DEFAULT_GRAPH_OPTIONS, type GraphOptions, type GraphPayload } from "../../../api-client/supply-chain-graph";
import { errorMessage } from "../../../utils/errors";
import { addDays, newYorkToday } from "../earnings/board-model";
import { loadEarningsBoard } from "../earnings/client";
import { loadSupplyChain } from "../supply-chain/client";
import { cachedGraph, loadGraph } from "../supply-chain/graph-client";
import { projectRipple, projectSecondHop, rippleCompanyTickers, RIPPLE_DAYS, secondHopLinks, type RippleRow, type SecondHopRow } from "./model";

export interface RippleSources {
  supplyChain(symbol: string): Promise<SupplyChainPayload>;
  calendar(query: EarningsCalendarQuery): Promise<EarningsCalendarPayload>;
  /** SPLC's graph, which returns both hops around a holding in one call. Absent when the account sees one hop only. */
  graph?(symbol: string, options: GraphOptions): Promise<GraphPayload>;
}

/**
 * The graph query behind the 2 hops tab. Supplier and customer links only, and
 * only evidence from filings, company announcements and calls (graph classes
 * structured and primary), the tiers the 1 hop tab's disclosures are read with.
 * The server filters before it ranks and caps each direction, so news and
 * partner routes cannot use up the 50 companies a direction returns.
 */
const RIPPLE_GRAPH_OPTIONS: GraphOptions = { ...DEFAULT_GRAPH_OPTIONS, depth: 2, roles: ["customer", "supplier"], tiers: ["structured", "primary"] };

/**
 * What opens SPLC's Path view on a 2 hops row: from the holding to the company
 * that reports, on RIPL's own query in the row's direction, so the route the
 * row shows is the one Path lists.
 */
export function rippleRouteSettings(row: Pick<SecondHopRow, "company" | "link">): Record<string, string> {
  return { tab: "path", to: row.company, depth: String(RIPPLE_GRAPH_OPTIONS.depth), direction: row.link === "supplier" ? "upstream" : "downstream",
    roles: RIPPLE_GRAPH_OPTIONS.roles.join(","), tiers: RIPPLE_GRAPH_OPTIONS.tiers.join(",") };
}

interface Failure { symbol: string; error: string }

export interface RippleSnapshot {
  rows: RippleRow[];
  /** Holdings whose disclosures could not be read, with the reason. */
  failures: Failure[];
  /** Holdings whose disclosures the free preview cut short, so a missing link may only be hidden. */
  truncated: string[];
  /**
   * Companies two hops away, when asked for. `locked`: the account sees one hop
   * only. `truncated`: holdings whose graph search stopped at a limit, with the
   * server's reasons, so a company missing there may only be cut off.
   */
  secondHop: { rows: SecondHopRow[]; failures: Failure[]; truncated: { symbol: string; reasons: string[] }[]; locked: boolean } | null;
  stale: boolean;
  from: string;
  to: string;
}

/**
 * The same caches SPLC and ERN fill, so opening either pane after this costs
 * nothing. `graph`: no graph source, graphs read through the cache, or graphs
 * from the cache alone (fetched only when missing) while 2 hops is not on screen.
 */
export function cachedRippleSources(accessKey: string, force = false, graph: "off" | "load" | "cached" = "off"): RippleSources & { staleFlags: boolean[] } {
  const staleFlags: boolean[] = [];
  return {
    staleFlags,
    supplyChain: async (symbol) => { const result = await loadSupplyChain(symbol, accessKey, force); staleFlags.push(result.stale); return result.payload; },
    calendar: async (query) => { const result = await loadEarningsBoard(query, force); staleFlags.push(result.stale); return result.payload; },
    // Cached by the full query, apart from SPLC Graph's default one.
    ...(graph !== "off" ? { graph: async (symbol: string, options: GraphOptions) => {
      const cached = graph === "cached" ? cachedGraph(symbol, "", options, accessKey) : null;
      const result = cached ?? await loadGraph(symbol, "", options, accessKey, force); staleFlags.push(result.stale); return result.payload;
    } } : {}),
  };
}

const CONCURRENCY = 6;

async function eachLimited(symbols: readonly string[], load: (symbol: string) => Promise<void>) {
  const queue = [...symbols];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let symbol = queue.shift(); symbol; symbol = queue.shift()) await load(symbol);
  }));
}

const locked = () => ({ graphs: new Map<string, GraphPayload>(), failures: [] as Failure[], locked: true });
const isPreview = (graphs: ReadonlyMap<string, GraphPayload>) => [...graphs.values()].some((graph) => graph.access === "preview");

/** One graph call per holding. The first answer says whether the account sees two hops; a one-hop preview skips the rest. */
async function loadGraphs(holdings: readonly string[], graph: NonNullable<RippleSources["graph"]>) {
  const graphs = new Map<string, GraphPayload>();
  const failures: Failure[] = [];
  const load = async (symbol: string) => {
    try { graphs.set(symbol, await graph(symbol, RIPPLE_GRAPH_OPTIONS)); }
    catch (error) { failures.push({ symbol, error: errorMessage(error) }); }
  };
  const [first, ...rest] = holdings;
  if (first) await load(first);
  if (isPreview(graphs)) return locked();
  await eachLimited(rest, load);
  // Only when the first holding failed can a preview get this far.
  if (isPreview(graphs)) return locked();
  return { graphs, failures: failures.sort((a, b) => a.symbol.localeCompare(b.symbol)), locked: false };
}

export async function loadRipple(holdings: readonly string[], sources: RippleSources & { staleFlags?: boolean[] }, now = new Date(), { secondHop = false } = {}): Promise<RippleSnapshot> {
  const from = newYorkToday(now);
  const to = addDays(from, RIPPLE_DAYS);
  const symbols = [...new Set(holdings.map((symbol) => symbol.toUpperCase()))];
  const chains = new Map<string, SupplyChainPayload>();
  const failures: Failure[] = [];
  await eachLimited(symbols, async (symbol) => {
    try { chains.set(symbol, await sources.supplyChain(symbol)); }
    catch (error) { failures.push({ symbol, error: errorMessage(error) }); }
  });
  const second = !secondHop ? null : sources.graph ? await loadGraphs(symbols, sources.graph) : locked();
  const graphs = second?.graphs ?? new Map<string, GraphPayload>();
  const companies = [...rippleCompanyTickers(chains), ...secondHopLinks(chains, graphs).map((link) => link.company.ticker!.toUpperCase())];
  const reports: EarningsCalendarPayload["reports"] = [];
  if (companies.length) {
    const calendarSymbols = [...new Set([...companies, ...symbols])].sort();
    for (let offset = 0; offset < calendarSymbols.length; offset += 200) {
      const payload = await sources.calendar({ from, to, perDay: 0, symbols: calendarSymbols.slice(offset, offset + 200) });
      reports.push(...payload.reports);
    }
  }
  const truncated = [...chains].filter(([, chain]) => chain.truncated).map(([symbol]) => symbol).sort();
  return {
    rows: projectRipple(chains, reports), failures, truncated,
    secondHop: second ? { rows: projectSecondHop(chains, graphs, reports), failures: second.failures, locked: second.locked,
      truncated: [...graphs].filter(([, graph]) => graph.truncated || !graph.search.complete)
        .map(([symbol, graph]) => ({ symbol, reasons: graph.search.reasons })).sort((a, b) => a.symbol.localeCompare(b.symbol)) } : null,
    stale: !!sources.staleFlags?.some(Boolean), from, to,
  };
}
