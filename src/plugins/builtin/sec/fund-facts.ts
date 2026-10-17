import { apiClient } from "../../../api-client";
import type { FundFactsPayload } from "../../../api-client/fund-facts";
import type { StatItem } from "../../../components/ui/stat-grid";
import { createPluginCache } from "../../../data/plugin-cache";
import type { HeadlessPaneEntry } from "../../../types/plugin";
import { errorMessage } from "../../../utils/errors";
import { formatCompact } from "../../../utils/format";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";

/** Sponsors publish once a day, in the US evening; a copy younger than this is not asked for again. */
export const fundFactsCache = createPluginCache<FundFactsPayload>({
  kind: "fund-facts", source: "gloom-cloud", schemaVersion: 1, policy: { staleMs: 15 * 60_000, expireMs: 24 * 60 * 60_000 },
});

type Client = Pick<typeof apiClient, "getFundFacts">;

const fact = (value: unknown) => value === null || (typeof value === "object" && value !== null && "value" in value && "source" in value);

function validateFundFacts(data: FundFactsPayload): FundFactsPayload {
  if (!data || typeof data.ticker !== "string" || typeof data.covered !== "boolean"
    || ![data.expenseRatio, data.nav, data.premiumDiscount, data.netAssets, data.sponsor, data.inception, data.index].every(fact)) {
    throw new Error("Unreadable fund facts response");
  }
  return data;
}

export const FUND_FACTS_UNAVAILABLE = "Fund facts are not available on this server yet.";

/** A failed load as one line: the server-not-ready message as it is, anything else after "Fund facts unavailable:". */
export function fundFactsErrorText(error: unknown): string {
  const message = errorMessage(error);
  return message === FUND_FACTS_UNAVAILABLE ? message : `Fund facts unavailable: ${message}`;
}

export async function fetchFundFacts(ticker: string, client: Client = apiClient): Promise<FundFactsPayload> {
  try { return validateFundFacts(await client.getFundFacts(ticker)); } catch (error) { throw unavailableOnServer(error, FUND_FACTS_UNAVAILABLE); }
}
const cacheKey = (ticker: string) => ticker.trim().toUpperCase();
export const cachedFundFacts = (ticker: string) => cachedCloudResource(fundFactsCache, cacheKey(ticker), validateFundFacts);
export const loadFundFacts = (ticker: string, force = false) =>
  loadCloudResource(fundFactsCache, cacheKey(ticker), () => fetchFundFacts(ticker), { force, validate: validateFundFacts });

/** A fee as the prospectus states it: two decimals at least, four when it has them (0.0945%). */
function formatFeePercent(value: number): string {
  return `${value.toFixed(4).replace(/0{1,2}$/, "")}%`;
}

function formatPremiumPercent(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded > 0 ? "+" : ""}${(rounded === 0 ? 0 : rounded).toFixed(2)}%`;
}

function formatNav(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function formatNetAssets(value: number): string {
  return `$${formatCompact(value)}`;
}

/** A trust charges a sponsor fee; a fund states an expense ratio, net or gross of waivers, which its detail says. */
function expenseRatioLabel(facts: Pick<FundFactsPayload, "expenseRatio" | "structure">): string {
  return facts.expenseRatio?.kind === "sponsor-fee" || facts.structure === "trust" ? "Sponsor fee" : "Expense ratio";
}

function feeBasis(facts: FundFactsPayload): "net" | "gross" | null {
  const kind = facts.expenseRatio?.kind;
  return facts.structure === "trust" || kind === "sponsor-fee" ? null : kind === "gross" ? "gross" : kind === "net" ? "net" : null;
}

/**
 * What the fund measures itself against, as its sponsor names it: the index
 * an index fund tracks, an active fund's benchmark, a trust's reference price.
 */
const BENCHMARK_LABEL = "Benchmark";

/**
 * The facts as a pane's summary sheet: each figure with its own date beside
 * it. A premium computed from the consolidated close says so, a gross fee says
 * gross; who published the figures is the footer's.
 */
export function fundFactItems(facts: FundFactsPayload): StatItem[] {
  const items: StatItem[] = [];
  if (facts.nav) items.push({ id: "nav", label: "NAV", value: formatNav(facts.nav.value), ...(facts.nav.asOf ? { detail: facts.nav.asOf } : {}) });
  if (facts.premiumDiscount) {
    const date = facts.premiumDiscount.asOf ?? "";
    items.push({ id: "premium", label: "Premium/discount", value: formatPremiumPercent(facts.premiumDiscount.value),
      detail: facts.premiumDiscount.basis === "computed" ? `${date} close`.trim() : date || undefined });
  }
  if (facts.expenseRatio) {
    const basis = feeBasis(facts);
    items.push({ id: "fee", label: expenseRatioLabel(facts), value: formatFeePercent(facts.expenseRatio.value), ...(basis ? { detail: basis } : {}) });
  }
  if (facts.netAssets) items.push({ id: "assets", label: "Net assets", value: formatNetAssets(facts.netAssets.value), ...(facts.netAssets.asOf ? { detail: facts.netAssets.asOf } : {}) });
  if (facts.sponsor) items.push({ id: "sponsor", label: "Sponsor", value: facts.sponsor.value });
  if (facts.inception) items.push({ id: "inception", label: "Inception", value: facts.inception.value });
  if (facts.index) items.push({ id: "index", label: BENCHMARK_LABEL, value: facts.index.value, wide: true });
  return items;
}

/**
 * The facts in the overview's Fundamentals style, short Title Case labels
 * beside a company's `Mkt Cap` and `Div Yield`: price-side figures with their
 * dates, then the fee and inception. Sponsor and index stay in ETF.
 */
export function fundFactOverviewFields(facts: FundFactsPayload): { label: string; value: string; detail?: string }[] {
  const fields: { label: string; value: string; detail?: string }[] = [];
  if (facts.nav) fields.push({ label: "NAV", value: formatNav(facts.nav.value), ...(facts.nav.asOf ? { detail: facts.nav.asOf } : {}) });
  if (facts.premiumDiscount) fields.push({ label: "Prem/Disc", value: formatPremiumPercent(facts.premiumDiscount.value) });
  if (facts.netAssets) fields.push({ label: "Net Assets", value: formatNetAssets(facts.netAssets.value) });
  if (facts.expenseRatio) {
    const fee = facts.expenseRatio.kind === "sponsor-fee" || facts.structure === "trust";
    fields.push({ label: fee ? "Sponsor Fee" : "Exp Ratio", value: formatFeePercent(facts.expenseRatio.value),
      ...(!fee && facts.expenseRatio.kind === "gross" ? { detail: "gross" } : {}) });
  }
  if (facts.inception) fields.push({ label: "Inception", value: facts.inception.value });
  return fields;
}

/** Where a figure came from and when, for text reports: `2026-10-16 · iShares`. */
function provenance(...parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(" · ");
}

/**
 * The facts as report entries: JSON keeps each raw number, the text says its
 * date and publisher beside it, so every figure can be checked against the
 * sponsor's page it came from.
 */
export function fundFactEntries(facts: FundFactsPayload): HeadlessPaneEntry[] {
  const entries: HeadlessPaneEntry[] = [];
  const add = (key: string, label: string, value: unknown, formatted: string, unit?: string) =>
    entries.push({ key, label, value, formatted, ...(unit ? { unit } : {}) });
  if (facts.name) add("name", "Name", facts.name, facts.name);
  if (facts.structure) add("structure", "Structure", facts.structure,
    facts.structure === "trust" ? "Trust or pool, not an open-end fund" : "Registered fund");
  if (facts.expenseRatio) {
    const kind = feeBasis(facts);
    add("expenseRatioPercent", expenseRatioLabel(facts), facts.expenseRatio.value,
      provenance(`${formatFeePercent(facts.expenseRatio.value)}${kind ? ` ${kind}` : ""}`, facts.expenseRatio.asOf, facts.expenseRatio.source), "%");
  }
  if (facts.nav) add("nav", "NAV", facts.nav.value, provenance(formatNav(facts.nav.value), facts.nav.asOf, facts.nav.source), "USD");
  if (facts.closingPrice) add("closingPrice", "Closing price", facts.closingPrice.value,
    provenance(formatNav(facts.closingPrice.value), facts.closingPrice.asOf, facts.closingPrice.source), "USD");
  if (facts.premiumDiscount) {
    const basis = facts.premiumDiscount.basis === "computed" ? "closing price vs NAV" : null;
    add("premiumDiscountPercent", "Premium/discount", facts.premiumDiscount.value,
      provenance(formatPremiumPercent(facts.premiumDiscount.value), facts.premiumDiscount.asOf, basis, facts.premiumDiscount.source), "%");
  }
  if (facts.netAssets) {
    const scope = facts.netAssets.scope === "fund" && facts.structure !== "trust" ? "all share classes" : null;
    add("netAssets", "Net assets", facts.netAssets.value, provenance(formatNetAssets(facts.netAssets.value), facts.netAssets.asOf, scope, facts.netAssets.source), "USD");
  }
  if (facts.sponsor) add("sponsor", "Sponsor", facts.sponsor.value, facts.sponsor.value);
  if (facts.inception) add("inception", "Inception", facts.inception.value, facts.inception.value);
  if (facts.index) add("index", BENCHMARK_LABEL, facts.index.value, provenance(facts.index.value, facts.index.source));
  const url = facts.nav?.url ?? facts.expenseRatio?.url ?? facts.netAssets?.url;
  if (url) add("url", "Sponsor page", url, url);
  return entries;
}

/** Names as a sentence lists them: `A`, `A and B`, `A, B and C`. */
export function listNames(names: readonly string[]): string {
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Everyone the figures cite, in the order they appear: `iShares`, `Vanguard, Gloom Cloud`. */
export function fundFactPublishers(facts: FundFactsPayload): string[] {
  return [...new Set([facts.nav, facts.premiumDiscount, facts.expenseRatio, facts.netAssets, facts.index]
    .flatMap((value) => value ? [value.source] : []))];
}

/**
 * Why a fund has no facts, in one line, and where to look instead: its SEC
 * filings, unless the caller already points there.
 */
export function fundFactsEmpty(symbol: string, facts: FundFactsPayload | null, pointToSec = true): string {
  const reason = facts?.reason ?? `No fund facts for ${symbol} yet.`;
  return pointToSec ? `${reason} Its SEC filings: fn SEC ${symbol}.` : reason;
}
