import { apiClient } from "../../../api-client";
import type { FundFactsPayload, FundLeverage } from "../../../api-client/fund-facts";
import type { StatItem } from "../../../components/ui/stat-grid";
import { leverageFactorLabel } from "../../../time-series/leverage";
import { t, tf } from "../../../i18n";
import { createPluginCache } from "../../../data/plugin-cache";
import type { HeadlessPaneEntry } from "../../../types/plugin";
import { errorMessage } from "../../../utils/errors";
import { formatCompact } from "../../../utils/format";
import { bondClassText, bondFigures, isBondFactsShape } from "../../../market-data/bond-funds";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";

/** Sponsors publish once a day, in the US evening; a copy younger than this is not asked for again. */
export const fundFactsCache = createPluginCache<FundFactsPayload>({
  kind: "fund-facts", source: "gloom-cloud", schemaVersion: 1, policy: { staleMs: 15 * 60_000, expireMs: 24 * 60 * 60_000 },
});

type Client = Pick<typeof apiClient, "getFundFacts">;

const fact = (value: unknown) => value === null || (typeof value === "object" && value !== null && "value" in value && "source" in value);

/** Absent from servers before it; otherwise a dated factor with its reset period. */
const leverageShape = (value: FundFactsPayload["leverage"]) => value === undefined || value === null
  || (fact(value) && typeof value.value === "number" && Number.isFinite(value.value) && (value.reset === "daily" || value.reset === "monthly"));

function validateFundFacts(data: FundFactsPayload): FundFactsPayload {
  if (!data || typeof data.ticker !== "string" || typeof data.covered !== "boolean"
    || ![data.expenseRatio, data.nav, data.premiumDiscount, data.netAssets, data.sponsor, data.inception, data.index].every(fact)
    || !isBondFactsShape(data.bond) || !leverageShape(data.leverage)) {
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

/** The same line, translated for the pane. */
export function fundFactsErrorLine(error: unknown): string {
  const message = errorMessage(error);
  return message === FUND_FACTS_UNAVAILABLE ? t(FUND_FACTS_UNAVAILABLE) : tf("Fund facts unavailable: {message}", { message });
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

/**
 * The fee as the server says it is: a sponsor fee (IBIT, GLD), or an expense
 * ratio, net or gross of waivers, which its detail says. A pool's total
 * expense ratio (USO, DBC) stays an expense ratio: a trust is not enough to
 * call a fee a sponsor fee.
 */
function expenseRatioLabel(facts: Pick<FundFactsPayload, "expenseRatio">): string {
  return facts.expenseRatio?.kind === "sponsor-fee" ? "Sponsor fee" : "Expense ratio";
}

function feeBasis(facts: FundFactsPayload): "net" | "gross" | null {
  const kind = facts.expenseRatio?.kind;
  return kind === "gross" ? "gross" : kind === "net" ? "net" : null;
}

/**
 * Net assets of the whole fund, every share class (N-PORT's, a fund family's
 * figure), not the ETF class alone: the label says so, `Fund net assets`,
 * which no narrow column drops; a report says `all share classes`. A trust
 * has no classes to tell apart.
 */
function wholeFund(facts: FundFactsPayload): boolean {
  return facts.netAssets?.scope === "fund" && facts.structure !== "trust";
}

/**
 * What the fund measures itself against, as its sponsor names it: the index
 * an index fund tracks, an active fund's benchmark, a trust's reference price.
 */
const BENCHMARK_LABEL = "Benchmark";

/**
 * A leveraged or inverse fund's objective, as the ETF pane and report label
 * it: the times and direction of its benchmark's return it seeks.
 */
const OBJECTIVE_LABEL = "Objective";

/** The objective in a few words: `3× daily, long`, `-3× daily, inverse`, `1.75× monthly, long`. */
function leverageObjectiveText(leverage: Pick<FundLeverage, "value" | "reset">): string {
  return `${leverageFactorLabel(leverage.value)} ${leverage.reset}, ${leverage.value < 0 ? "inverse" : "long"}`;
}

/**
 * How each dated figure reads beside the NAV, the date the sheet is about.
 * Every figure says its own date. One that is older than it looks is marked:
 * every figure once the NAV is stale, a premium of another day than the NAV,
 * a day's net assets older than it. Vanguard's and ARK's net assets are a
 * month end's and say so, which is their normal cadence rather than a lag, as
 * do N-PORT's, which name the report. A fee is dated by the page or
 * prospectus it was read from, says so when it is the prospectus's, and is
 * marked only when stale.
 */
interface DatedFigure {
  /** The date, with what it is when that is not plain: `2026-10-16 close`, `2026-09-30 month-end`. */
  detail?: string;
  /** Older than the NAV beside it, or the NAV is stale. */
  marked: boolean;
}

function datedFigures(facts: FundFactsPayload): Record<"nav" | "premium" | "fee" | "netAssets", DatedFigure> {
  const nav = facts.nav?.asOf ?? null;
  const premium = facts.premiumDiscount;
  const assets = facts.netAssets;
  const monthEnd = assets?.period === "month-end";
  const basis = feeBasis(facts);
  const feeDate = facts.expenseRatio?.asOf ?? null;
  const prospectus = facts.expenseRatio?.document === "prospectus";
  const nport = assets?.document === "N-PORT";
  return {
    nav: { detail: nav ? (facts.stale ? tf("{date} stale", { date: nav }) : nav) : undefined, marked: facts.stale },
    premium: {
      detail: premium?.asOf ? (premium.basis === "computed" ? tf("{date} close", { date: premium.asOf }) : premium.asOf) : undefined,
      marked: facts.stale || (!!premium?.asOf && !!nav && premium.asOf !== nav),
    },
    fee: {
      detail: feeDate
        ? prospectus
          ? basis === "gross" ? tf("gross, prospectus {date}", { date: feeDate })
            : basis === "net" ? tf("net, prospectus {date}", { date: feeDate }) : tf("prospectus {date}", { date: feeDate })
          : basis === "gross" ? tf("gross {date}", { date: feeDate }) : basis === "net" ? tf("net {date}", { date: feeDate }) : feeDate
        : basis ?? undefined,
      marked: facts.stale,
    },
    netAssets: {
      detail: assets?.asOf
        ? nport ? tf("{date} month-end · N-PORT", { date: assets.asOf })
          : monthEnd ? tf("{date} month-end", { date: assets.asOf }) : assets.asOf
        : undefined,
      marked: facts.stale || (!monthEnd && !!assets?.asOf && !!nav && assets.asOf < nav),
    },
  };
}

/**
 * The facts as a pane's summary sheet: each figure with its own date beside
 * it, a marked one in the warning tone. A premium computed from the
 * consolidated close says so, a fee says net or gross; who published the
 * figures is the footer's.
 */
export function fundFactItems(facts: FundFactsPayload): StatItem[] {
  const items: StatItem[] = [];
  const dated = datedFigures(facts);
  const cell = (id: string, label: string, value: string, figure: DatedFigure): StatItem => ({
    id, label, value, ...(figure.detail ? { detail: figure.detail } : {}), ...(figure.marked ? { tone: "warning" as const } : {}),
  });
  if (facts.nav) items.push(cell("nav", "NAV", formatNav(facts.nav.value), dated.nav));
  if (facts.premiumDiscount) items.push(cell("premium", "Premium/discount", formatPremiumPercent(facts.premiumDiscount.value), dated.premium));
  if (facts.expenseRatio) items.push(cell("fee", expenseRatioLabel(facts), formatFeePercent(facts.expenseRatio.value), dated.fee));
  if (facts.netAssets) items.push(cell("assets", wholeFund(facts) ? "Fund net assets" : "Net assets", formatNetAssets(facts.netAssets.value), dated.netAssets));
  // A bond fund's yields and duration, each dated by its sponsor.
  for (const figure of facts.bond ? bondFigures(facts.bond) : []) {
    items.push(cell(figure.key, figure.label, figure.text, { detail: figure.date, marked: facts.stale }));
  }
  if (facts.sponsor) items.push({ id: "sponsor", label: "Sponsor", value: facts.sponsor.value });
  if (facts.inception) items.push({ id: "inception", label: "Inception", value: facts.inception.value });
  // A leveraged or inverse fund's objective, dated by the sponsor page it was read from, beside its benchmark.
  if (facts.leverage) {
    items.push(cell("objective", OBJECTIVE_LABEL, leverageObjectiveText(facts.leverage), { detail: facts.leverage.asOf ?? undefined, marked: false }));
  }
  if (facts.index) items.push({ id: "index", label: BENCHMARK_LABEL, value: facts.index.value, wide: true });
  return items;
}

/** A DES figure: `warn` when it is older than it looks, which DES draws in the warning colour. */
interface FundFactOverviewField {
  label: string;
  value: string;
  /** Its date, longest first: a narrow column takes the shorter form or none, and the colour still marks it. */
  detail?: string[];
  warn?: boolean;
}

/**
 * The facts in the overview's Fundamentals style, short Title Case labels
 * beside a company's `Mkt Cap` and `Div Yield`: price-side figures, then the
 * fee and inception, each dated and marked as the ETF pane marks them.
 * Sponsor and index stay in ETF.
 */
export function fundFactOverviewFields(facts: FundFactsPayload): FundFactOverviewField[] {
  const fields: FundFactOverviewField[] = [];
  const dated = datedFigures(facts);
  // A narrow column takes the date without its year (`10-16 close`), then the bare date, before none.
  const withoutYear = (text: string) => text.replace(/\b\d{4}-(\d{2}-\d{2})\b/, "$1");
  const field = (label: string, value: string, figure: DatedFigure, short?: string): FundFactOverviewField => {
    const forms = figure.detail ? [figure.detail, withoutYear(figure.detail), ...(short ? [short, withoutYear(short)] : [])] : [];
    return { label, value, ...(forms.length ? { detail: [...new Set(forms)] } : {}), ...(figure.marked ? { warn: true } : {}) };
  };
  if (facts.nav) fields.push(field("NAV", formatNav(facts.nav.value), dated.nav));
  if (facts.premiumDiscount) fields.push(field("Prem/Disc", formatPremiumPercent(facts.premiumDiscount.value), dated.premium, facts.premiumDiscount.asOf ?? undefined));
  if (facts.netAssets) {
    // N-PORT's long form gives way to the month end alone before the bare date.
    const monthEnd = facts.netAssets.document && facts.netAssets.asOf ? tf("{date} month-end", { date: facts.netAssets.asOf }) : undefined;
    fields.push(field(wholeFund(facts) ? "Fund Assets" : "Net Assets", formatNetAssets(facts.netAssets.value), dated.netAssets, monthEnd));
  }
  if (facts.expenseRatio) {
    const fee = facts.expenseRatio.kind === "sponsor-fee";
    fields.push(field(fee ? "Sponsor Fee" : "Exp Ratio", formatFeePercent(facts.expenseRatio.value), dated.fee, facts.expenseRatio.asOf ?? undefined));
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
    const date = facts.expenseRatio.asOf && facts.expenseRatio.document === "prospectus" ? `${facts.expenseRatio.asOf} prospectus` : facts.expenseRatio.asOf;
    add("expenseRatioPercent", expenseRatioLabel(facts), facts.expenseRatio.value,
      provenance(`${formatFeePercent(facts.expenseRatio.value)}${kind ? ` ${kind}` : ""}`, date, facts.expenseRatio.source), "%");
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
    const scope = wholeFund(facts) ? "all share classes" : null;
    const date = facts.netAssets.asOf && facts.netAssets.period === "month-end"
      ? `${facts.netAssets.asOf} month-end${facts.netAssets.document ? ` ${facts.netAssets.document}` : ""}` : facts.netAssets.asOf;
    add("netAssets", "Net assets", facts.netAssets.value, provenance(formatNetAssets(facts.netAssets.value), date, scope, facts.netAssets.source), "USD");
  }
  if (facts.bond) {
    add("bondClass", "Bond fund", facts.bond.kind, bondClassText(facts.bond));
    const keys = { secYield: "secYieldPercent", yieldToWorst: "yieldToWorstPercent", duration: "durationYears" } as const;
    for (const figure of bondFigures(facts.bond)) {
      add(keys[figure.key], figure.key === "secYield" ? "30-day SEC yield" : figure.label, figure.value,
        provenance(figure.text, figure.date, figure.source), figure.key === "duration" ? "years" : "%");
    }
  }
  if (facts.sponsor) add("sponsor", "Sponsor", facts.sponsor.value, facts.sponsor.value);
  if (facts.inception) add("inception", "Inception", facts.inception.value, facts.inception.value);
  if (facts.leverage) {
    add("leverageFactor", OBJECTIVE_LABEL, facts.leverage.value,
      provenance(leverageObjectiveText(facts.leverage), facts.leverage.asOf, facts.leverage.source), "x");
  }
  if (facts.index) add("index", BENCHMARK_LABEL, facts.index.value, provenance(facts.index.value, facts.index.source));
  const url = facts.nav?.url ?? facts.expenseRatio?.url ?? facts.netAssets?.url;
  if (url) add("url", "Sponsor page", url, url);
  return entries;
}

/** Names as a sentence lists them: `A`, `A and B`, `A, B and C`. */
export function listNames(names: readonly string[]): string {
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Who published the fund's figures: its sponsor, as every fund's footer and
 * report source name it (`iShares`, `State Street`). A premium computed from
 * the consolidated close cites Gloom Cloud on its own line, not here.
 */
export function fundFactPublishers(facts: FundFactsPayload): string[] {
  return [...new Set([facts.nav, facts.expenseRatio, facts.netAssets, facts.leverage, facts.index, facts.bond?.secYield, facts.bond?.yieldToWorst, facts.bond?.duration]
    .flatMap((value) => value ? [value.source] : []))];
}

/** The newest NAV is stale: one line saying since when, as the report's note says it. */
export function fundFactsStaleNote(symbol: string, facts: FundFactsPayload): string | null {
  return facts.covered && facts.stale && facts.nav?.asOf ? `${symbol}'s newest NAV is from ${facts.nav.asOf}; its sponsor has not published one since.` : null;
}

/** The stale note, translated for the pane. */
export function fundFactsStaleText(symbol: string, facts: FundFactsPayload): string | null {
  return fundFactsStaleNote(symbol, facts) ? tf("{symbol}'s newest NAV is from {date}; its sponsor has not published one since.", { symbol, date: facts.nav!.asOf! }) : null;
}

/**
 * Why a fund has no facts, in one line, and where to look instead: its SEC
 * filings, unless the caller already points there.
 */
export function fundFactsEmpty(symbol: string, facts: FundFactsPayload | null, pointToSec = true): string {
  const reason = facts?.reason ?? `No fund facts for ${symbol} yet.`;
  return pointToSec ? `${reason} Its SEC filings: fn SEC ${symbol}.` : reason;
}

/**
 * The pane's line for a fund without facts, translated, as the server's
 * reason says it in English: not collected yet when a source Gloom reads
 * covers the fund, not published only when none does, or no fund at all.
 */
export function fundFactsEmptyText(symbol: string, facts: FundFactsPayload | null): string {
  if (!facts) return tf("No fund facts for {symbol} yet.", { symbol });
  if (facts.status === "not-collected-yet") return tf("{symbol}'s figures are not collected yet; the next read stores them.", { symbol });
  if (facts.status === "not-published") {
    if (facts.structure === "trust") {
      return tf("{symbol} files with the SEC as a trust or pool, not as an open-end fund, and its sponsor's site is not one Gloom reads.", { symbol });
    }
    if (facts.structure === "registered") {
      return tf("No figures for {symbol}: its sponsor's site is not one Gloom reads, and the SEC's prospectus and N-PORT data sets list none for it yet.", { symbol });
    }
    return tf("No figures for {symbol}: it lists as a fund, but the SEC's lists do not name it yet and its sponsor's site is not one Gloom reads.", { symbol });
  }
  if (facts.status === "not-a-fund") return tf("No fund facts for {symbol}: it is not on the SEC's lists of US-listed funds.", { symbol });
  // A server before statuses: what the SEC's lists make of it.
  if (facts.structure === "trust") {
    return tf("{symbol} files with the SEC as a trust or pool, not as an open-end fund; its sponsor's daily figures are not collected yet.", { symbol });
  }
  if (facts.structure === "registered") return tf("{symbol}'s sponsor does not publish fund data Gloom collects yet.", { symbol });
  return tf("No fund facts for {symbol}: it is not on the SEC's lists of US-listed funds.", { symbol });
}
