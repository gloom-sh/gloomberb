import type { ScreenDefinition, ScreenRow } from "../../../api-client/equity-screener";
import type { HeadlessPaneContext } from "../../../types/headless";
import type { TickerFinancials } from "../../../types/financials";
import { isUsListingExchange, parsePublicTickerKey } from "../../../utils/exchanges";
import { errorMessage } from "../../../utils/errors";
import { selectMarketCapitalization } from "../../../utils/market-capitalization";
import { fetchScreen } from "../equity-screener/client";
import { loadFxLegs } from "./relative-valuation-currency";

/** How many peers `--peers` adds at most, and the fewest it settles for before it falls back. */
const MOST_PEERS = 6;
const FEWEST_PEERS = 4;

/**
 * How the peers were picked: the subject's own industry, the industry its
 * business belongs to when its profile files it under another, or a curated
 * list when too few covered equities share either.
 */
type PeerMethod = "industry" | "related-industry" | "curated";

/** The peers `--peers` added to one symbol, and how; the pane and the report both read it. */
export interface PeerSelection {
  subject: string;
  peers: string[];
  method: PeerMethod;
  /** The industry the peers come from, as the screener names it. */
  industry: string | null;
  /** The subject's own industry, as its profile names it. */
  subjectIndustry: string | null;
  /** How the peers were chosen, read after "Peers chosen automatically: ". */
  basis: string;
}

/**
 * An industry whose companies are often filed under another: a subject
 * filed under one of `filedUnder` whose profile opens on this business, or
 * one of `members`, takes its peers from `industry` instead.
 */
interface RelatedIndustry {
  /** The business, as the header and the note name it. */
  label: string;
  industry: string;
  filedUnder: readonly string[];
  /** What the first sentence of the profile says when the company is in this business. */
  business: RegExp;
  /** Companies in this business that are filed under one of `filedUnder`; they join its peers. */
  members: readonly string[];
  /** The peers used when the screener cannot answer, or covers fewer than four. */
  curated: readonly string[];
}

/** Kept small on purpose: an entry earns its place when an industry label hides who the competitors are. */
const RELATED_INDUSTRIES: readonly RelatedIndustry[] = [{
  label: "education",
  industry: "Education & Training Services",
  filedUnder: ["Software - Application", "Software - Infrastructure", "Internet Content & Information"],
  business: /\b(?:education|educational|e-?learning|online learning|language learning|learning platform|tutoring)\b/i,
  members: ["DUOL", "NRDY", "UDMY"],
  curated: ["COUR", "CHGG", "LRN", "NRDY", "DUOL", "UDMY"],
}];

/** The company `--peers` was given: its industry and business from its profile, and its market cap in US dollars. */
export interface PeerSubject {
  symbol: string;
  industry: string | null;
  description: string | null;
  marketCapUsd: number | null;
}

/** A covered equity the screener returned, with what the ranking reads. */
export interface PeerCandidate {
  symbol: string;
  marketCapUsd: number | null;
  /** It reports revenue figures (growth or a margin): a shell or a treasury vehicle filed in an industry does not. */
  reportsOperations: boolean;
}

/** Where the subject's peers come from: its own industry, or the related one its business belongs to. */
interface PeerGroup {
  industry: string;
  related: RelatedIndustry | null;
}

function bareSymbol(symbol: string): string {
  return parsePublicTickerKey(symbol).symbol.toUpperCase();
}

/** What a profile says the company does, before who it serves: its first sentence. */
function firstSentence(text: string | null): string {
  return (text ?? "").split(/(?<=[.!?])\s+/, 1)[0] ?? "";
}

export function peerGroupOf(subject: Pick<PeerSubject, "symbol" | "industry" | "description">): PeerGroup | null {
  const industry = subject.industry?.trim();
  if (!industry) return null;
  const symbol = bareSymbol(subject.symbol);
  const related = RELATED_INDUSTRIES.find((group) => group.industry === industry || (group.filedUnder.includes(industry)
    && (group.members.includes(symbol) || group.business.test(firstSentence(subject.description)))));
  return related ? { industry: related.industry, related } : { industry, related: null };
}

/**
 * The candidates closest to the subject in market cap, measured as a ratio
 * (half its size and twice its size are as close), at most six. A candidate
 * that reports no revenue figures is left out, and the subject itself.
 * Without the subject's cap the largest come first.
 */
export function rankPeerCandidates(subject: Pick<PeerSubject, "symbol" | "marketCapUsd">, candidates: readonly PeerCandidate[]): string[] {
  const seen = new Set([bareSymbol(subject.symbol)]);
  const usable = candidates.filter((candidate) => {
    const key = bareSymbol(candidate.symbol);
    if (!candidate.reportsOperations || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const base = subject.marketCapUsd != null && subject.marketCapUsd > 0 ? subject.marketCapUsd : null;
  const distance = (cap: number | null) => (base && cap != null && cap > 0 ? Math.abs(Math.log(cap / base)) : Number.POSITIVE_INFINITY);
  return usable
    .sort((left, right) => distance(left.marketCapUsd) - distance(right.marketCapUsd)
      || (right.marketCapUsd ?? 0) - (left.marketCapUsd ?? 0)
      || left.symbol.localeCompare(right.symbol))
    .slice(0, MOST_PEERS)
    .map((candidate) => candidate.symbol);
}

/**
 * The peers of the subject, from the covered equities of its group: its own
 * industry, or the related industry its business belongs to with that
 * business's members filed elsewhere. Fewer than four, or no candidates at
 * all (`candidates` null: the screener did not answer), falls back to the
 * related industry's curated list when it has one; otherwise what was found,
 * or null when nothing was.
 */
export function selectPeers(subject: PeerSubject, group: PeerGroup, candidates: readonly PeerCandidate[] | null): PeerSelection | null {
  const peers = candidates ? rankPeerCandidates(subject, candidates) : [];
  const symbol = subject.symbol;
  const related = group.related;
  if (peers.length < FEWEST_PEERS && related) {
    const curated = related.curated.filter((peer) => peer !== bareSymbol(symbol)).slice(0, MOST_PEERS);
    return {
      subject: symbol, peers: curated, method: "curated", industry: related.industry, subjectIndustry: subject.industry,
      basis: `a curated list of ${related.label} companies, as ${candidates ? `fewer than ${FEWEST_PEERS}` : "no"} covered equities in ${related.industry} could be read`,
    };
  }
  if (peers.length === 0) return null;
  const closest = `the ${peers.length} covered ${peers.length === 1 ? "equity" : "equities"} in ${group.industry} closest to ${symbol} in market cap`;
  if (related && group.industry !== subject.industry) {
    return {
      subject: symbol, peers, method: "related-industry", industry: group.industry, subjectIndustry: subject.industry,
      basis: `${closest}, where its ${related.label} business sits though its profile files it under ${subject.industry}`,
    };
  }
  return { subject: symbol, peers, method: "industry", industry: group.industry, subjectIndustry: subject.industry, basis: closest };
}

/**
 * The header's words for the peers: `peers by industry: Airlines`; a pane
 * title, which has no note under it, says they were chosen for the reader
 * (`auto peers by industry: Airlines`).
 */
export function peerMethodTitle(selection: PeerSelection, { automatic = false }: { automatic?: boolean } = {}): string {
  const peers = automatic ? "auto peers" : "peers";
  switch (selection.method) {
    case "industry":
      return `${peers} by industry: ${selection.industry}`;
    case "related-industry":
      return `${peers} by related industry: ${selection.industry}`;
    case "curated":
      return `${peers} from a curated list`;
  }
}

function screenSymbol(row: ScreenRow): string {
  return isUsListingExchange(row.exchange) ? row.symbol : `${row.symbol}:${row.exchange}`;
}

function candidateOf(row: ScreenRow): PeerCandidate {
  const metric = (field: keyof ScreenRow["metrics"]) => row.metrics[field]?.value ?? null;
  return {
    symbol: screenSymbol(row),
    marketCapUsd: metric("marketCap"),
    reportsOperations: metric("revenueGrowthPercent") != null || metric("grossMarginPercent") != null
      || metric("operatingMarginPercent") != null,
  };
}

async function screenRows(criterion: ScreenDefinition["criteria"][number], ctx: HeadlessPaneContext): Promise<ScreenRow[]> {
  const definition: ScreenDefinition = { version: 1, criteria: [criterion], sort: { field: "marketCap", direction: "desc" }, currency: "USD" };
  return (await fetchScreen(definition, null, ctx.signal, ctx.apiClient)).rows;
}

/** The subject's market cap in US dollars, through the app's FX rates when it is quoted in another currency. */
async function subjectCapUsd(financials: TickerFinancials | null, ctx: HeadlessPaneContext): Promise<number | null> {
  const cap = selectMarketCapitalization(financials?.quote, financials?.fundamentals);
  if (!cap) return null;
  if (cap.currency === "USD") return cap.value;
  const { legs } = await loadFxLegs([cap.currency], ctx);
  const rate = legs.get(cap.currency)?.rate;
  return rate != null ? cap.value * rate : null;
}

/**
 * Picks the peers of `symbol` for `--peers`: its group from its profile, the
 * group's covered equities from the screener (its industry, and the members
 * of a related one), ranked by market cap. Throws when the profile names no
 * industry, or nothing can be found, saying how to list peers instead.
 */
export async function pickPeers(symbol: string, financials: TickerFinancials | null, ctx: HeadlessPaneContext): Promise<PeerSelection> {
  const subject: PeerSubject = {
    symbol,
    industry: financials?.profile?.industry?.trim() || null,
    description: financials?.profile?.description ?? null,
    marketCapUsd: null,
  };
  const listYourOwn = `List them yourself: gloomberb fn RV ${symbol} <tickers>.`;
  const group = peerGroupOf(subject);
  if (!group) throw new Error(`${symbol}'s profile names no industry, so --peers cannot pick its peers. ${listYourOwn}`);
  let candidates: PeerCandidate[] | null = null;
  let failure: string | null = null;
  try {
    const [capUsd, industryRows, memberRows] = await Promise.all([
      subjectCapUsd(financials, ctx).catch(() => null),
      screenRows({ field: "industry", op: "in", value: [group.industry] }, ctx),
      group.related ? screenRows({ field: "symbol", op: "in", value: [...group.related.members] }, ctx) : Promise.resolve([]),
    ]);
    subject.marketCapUsd = capUsd;
    candidates = [...industryRows, ...memberRows].map(candidateOf);
  } catch (error) {
    ctx.signal.throwIfAborted();
    failure = errorMessage(error);
  }
  const selection = selectPeers(subject, group, candidates);
  if (selection) return selection;
  throw new Error(failure
    ? `--peers could not read the covered equities in ${group.industry}: ${failure} ${listYourOwn}`
    : `No other covered equity is in ${group.industry}, so --peers found no peers for ${symbol}. ${listYourOwn}`);
}
