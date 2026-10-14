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
 * business belongs to when its profile files it under another, a curated
 * group's core first (the subject is one of that core) and its industry
 * after, or a curated list when too few covered equities can be read.
 */
type PeerMethod = "industry" | "related-industry" | "curated-core" | "curated";

/** The peers `--peers` added to one symbol, and how; the pane and the report both read it. */
export interface PeerSelection {
  subject: string;
  peers: string[];
  method: PeerMethod;
  /** The industry the peers come from, as the screener names it. */
  industry: string | null;
  /** The subject's own industry, as its profile names it. */
  subjectIndustry: string | null;
  /** The peers taken from a curated group's core, first in `peers`; the rest came from `industry`. */
  curatedPeers?: string[];
  /** The curated group, as the header and the note name it (`online learning`). */
  curatedGroup?: string;
  /** How the peers were chosen, read after "Peers chosen automatically: ". */
  basis: string;
}

/**
 * An industry whose companies are often filed under another: a subject
 * filed under one of `filedUnder` whose profile opens on this business takes
 * its peers from `industry` instead. Its curated `core` are the companies
 * that compete head on: one of them is compared with the rest of the core
 * first and the industry after, and they join every other subject's
 * candidates.
 */
interface RelatedIndustry {
  /** The business, as the note names it (`its education business`). */
  label: string;
  industry: string;
  filedUnder: readonly string[];
  /** What the first sentence of the profile says when the company is in this business. */
  business: RegExp;
  /** The curated group the core forms, as the header and the note name it. */
  coreLabel: string;
  /** The curated core; also the peers used when the screener cannot answer, or covers fewer than four. */
  core: readonly string[];
}

/** Kept small on purpose: an entry earns its place when an industry label hides who the competitors are. */
const RELATED_INDUSTRIES: readonly RelatedIndustry[] = [{
  label: "education",
  industry: "Education & Training Services",
  filedUnder: ["Software - Application", "Software - Infrastructure", "Internet Content & Information"],
  business: /\b(?:education|educational|e-?learning|online learning|language learning|learning platform|tutoring)\b/i,
  coreLabel: "online learning",
  core: ["DUOL", "COUR", "CHGG", "NRDY", "LRN", "UDMY"],
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
  /** The subject is one of the related industry's curated core, which it is compared with first. */
  inCore: boolean;
}

function bareSymbol(symbol: string): string {
  return parsePublicTickerKey(symbol).symbol.toUpperCase();
}

/** A period that ends an abbreviation or an initial (`Inc.`, `N.V.`, `U.S.`), not a sentence. */
const ABBREVIATION_END = /(?:\b(?:inc|corp|co|ltd|plc|llc|lp|ag|se|nv|sa|no|st|mr|mrs|dr|jr|sr|vs|etc)|\b[a-z])\.$/i;

/**
 * What a profile says the company does, before who it serves: its first
 * sentence, read past the name's `Inc.` (`Duolingo, Inc. Class A Common Stock
 * represents ownership in Duolingo, a technology company focused on...`).
 */
function firstSentence(text: string | null): string {
  const source = text ?? "";
  for (const match of source.matchAll(/[.!?](?=\s+[A-Z])/g)) {
    const head = source.slice(0, match.index + 1);
    if (!ABBREVIATION_END.test(head)) return head;
  }
  return source;
}

export function peerGroupOf(subject: Pick<PeerSubject, "symbol" | "industry" | "description">): PeerGroup | null {
  const symbol = bareSymbol(subject.symbol);
  // A member of a curated core is placed by its symbol, whatever its profile says.
  const core = RELATED_INDUSTRIES.find((group) => group.core.includes(symbol));
  if (core) return { industry: core.industry, related: core, inCore: true };
  const industry = subject.industry?.trim();
  if (!industry) return null;
  const related = RELATED_INDUSTRIES.find((group) => group.industry === industry
    || (group.filedUnder.includes(industry) && group.business.test(firstSentence(subject.description))));
  return related ? { industry: related.industry, related, inCore: false } : { industry, related: null, inCore: false };
}

/**
 * The candidates closest to the subject in market cap, measured as a ratio
 * (half its size and twice its size are as close), at most six. A candidate
 * that reports no revenue figures is left out, and the subject itself.
 * Without the subject's cap the largest come first.
 */
export function rankPeerCandidates(
  subject: Pick<PeerSubject, "symbol" | "marketCapUsd">,
  candidates: readonly PeerCandidate[],
  { limit = MOST_PEERS, exclude = [] }: { limit?: number; exclude?: readonly string[] } = {},
): string[] {
  const seen = new Set([bareSymbol(subject.symbol), ...exclude.map(bareSymbol)]);
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
    .slice(0, limit)
    .map((candidate) => candidate.symbol);
}

/** `A`, `A and B`, `A, B and C`. */
function listText(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The covered equities the screener returned for a subject's group: its industry's, and its curated core's. */
export interface PeerCandidates {
  industry: readonly PeerCandidate[];
  core: readonly PeerCandidate[];
}

/**
 * The peers of the subject, from the covered equities of its group. One of a
 * curated core is compared with the rest of that core first, closest in
 * market cap, and the industry's closest fill the table to six. Any other
 * subject takes the closest of its own industry, or of the related industry
 * its business belongs to with that core among the candidates. Fewer than
 * four, or no candidates at all (`candidates` null: the screener did not
 * answer), falls back to the related industry's curated core when it has
 * one; otherwise what was found, or null when nothing was.
 */
export function selectPeers(subject: PeerSubject, group: PeerGroup, candidates: PeerCandidates | null): PeerSelection | null {
  const symbol = subject.symbol;
  const related = group.related;
  const curatedCore = group.inCore && related ? (candidates ? rankPeerCandidates(subject, candidates.core) : []) : [];
  const fill = candidates
    ? group.inCore
      ? rankPeerCandidates(subject, candidates.industry, { limit: MOST_PEERS - curatedCore.length, exclude: curatedCore })
      : rankPeerCandidates(subject, [...candidates.industry, ...related ? candidates.core : []])
    : [];
  const peers = [...curatedCore, ...fill];
  if (peers.length < FEWEST_PEERS && related) {
    const curated = related.core.filter((peer) => peer !== bareSymbol(symbol)).slice(0, MOST_PEERS);
    return {
      subject: symbol, peers: curated, method: "curated", industry: related.industry, subjectIndustry: subject.industry,
      curatedPeers: curated, curatedGroup: related.coreLabel,
      basis: `the ${related.coreLabel} curated list (${listText(curated)}), as ${candidates ? `fewer than ${FEWEST_PEERS}` : "no"} covered equities in ${related.industry} could be read`,
    };
  }
  if (peers.length === 0) return null;
  // `the 6 covered equities in X closest to DUOL in market cap`, the fill after a core naming its own.
  const closest = (names: readonly string[]) => {
    const count = names.length === 1 ? "the covered equity" : `the ${names.length} covered equities`;
    return `${names === peers ? "" : `${listText(names)}, `}${count} in ${group.industry} closest to ${symbol} in market cap`;
  };
  if (related && group.inCore && curatedCore.length > 0) {
    return {
      subject: symbol, peers, method: "curated-core", industry: group.industry, subjectIndustry: subject.industry,
      curatedPeers: curatedCore, curatedGroup: related.coreLabel,
      basis: `${listText(curatedCore)} from the ${related.coreLabel} curated core${fill.length > 0 ? `; ${closest(fill)}` : ""}`,
    };
  }
  if (related && group.industry !== subject.industry) {
    return {
      subject: symbol, peers, method: "related-industry", industry: group.industry, subjectIndustry: subject.industry,
      basis: `${closest(peers)}, where its ${related.label} business sits though its profile files it under ${subject.industry ?? "another industry"}`,
    };
  }
  return { subject: symbol, peers, method: "industry", industry: group.industry, subjectIndustry: subject.industry, basis: closest(peers) };
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
    case "curated-core":
      return selection.peers.length > (selection.curatedPeers?.length ?? 0)
        ? `${peers}: ${selection.curatedGroup} curated core, then ${selection.industry}`
        : `${peers}: ${selection.curatedGroup} curated core`;
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
 * Picks the peers of `symbol` for `--peers`: its group from its symbol or
 * profile, the group's covered equities from the screener (its industry, and
 * a related industry's curated core), ranked as `selectPeers` says. Throws
 * when nothing places the subject, or nothing can be found, saying how to
 * list peers instead.
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
  let candidates: PeerCandidates | null = null;
  let failure: string | null = null;
  try {
    const [capUsd, industryRows, coreRows] = await Promise.all([
      subjectCapUsd(financials, ctx).catch(() => null),
      screenRows({ field: "industry", op: "in", value: [group.industry] }, ctx),
      group.related ? screenRows({ field: "symbol", op: "in", value: [...group.related.core] }, ctx) : Promise.resolve([]),
    ]);
    subject.marketCapUsd = capUsd;
    candidates = { industry: industryRows.map(candidateOf), core: coreRows.map(candidateOf) };
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
