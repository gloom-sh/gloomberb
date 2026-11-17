import type { HeadlessPaneDefinition } from "../../../../types/headless";
import type { Quote } from "../../../../types/financials";
import { dollarPairLabel, spotFromUsdValue, spotRateKind } from "../../../../market-data/depositary-pair";
import { loadHeadlessFinancials, resolveHeadlessInstrument } from "../../shared/headless-market-data";
import { quoteObservation } from "../../shared/report-freshness";
import { heldCurrencyUnit } from "../../../../utils/currency-units";
import { canonicalExchange, displayTickerKey, isUsListingExchange, parsePublicTickerKey } from "../../../../utils/exchanges";
import { listingSuffixCandidate } from "../../../../sources/listing-symbols";
import { companyLinesName } from "../../../../tickers/company-name";
import { logFailure } from "../../../../utils/log-failure";
import { adrPairComparison, adrPairFigures, adrPairInputRows, adrPairLegs, ahPairFigures, ahPairInputRows, ADR_PAIR_TEMPLATE_ID } from "./model";
import { ahPairOf, ahPairSide, compareAhPair, type AhComparison, type AhPair, type AhSpot } from "../../../../market-data/ah-pair";
import { pairPriceInput } from "../../../../market-data/depositary-pair";
import { mayBeAhLine } from "./ah";

/** Words that ask for this report's figures without being its code: `fn CCL` answers with ADR. */
export const ADR_PAIR_KEYWORDS = [
  "adr", "adrs", "adr vs home", "adr ratio", "adr premium", "adr discount", "depositary receipt", "depositary receipts",
  "home listing", "home line", "implied fx", "implied exchange rate", "implied dollar", "ccl", "contado con liquidacion",
  "dolar ccl", "mep", "dolar mep", "dolar bolsa", "blue chip swap", "cross listing", "dual listing",
  "a/h premium", "ah premium", "a+h premium",
];

type LoadContext = Parameters<HeadlessPaneDefinition["load"]>[1];

/** The currency's dollar rate, dated when the cached query says when it was observed (as `fx` dates it). */
async function readSpot(currency: string, ctx: LoadContext) {
  if (currency === "USD") return { rate: 1, observedAt: null };
  const { marketData } = ctx;
  if (marketData.getCachedQuery) {
    const entry = await marketData.getCachedQuery("getExchangeRate", [currency]).load({ background: marketData.revalidatesInBackground });
    return spotFromUsdValue(entry.value, entry.asOf ?? null);
  }
  return spotFromUsdValue(await marketData.getExchangeRate(currency));
}

/** A leg's quote through the standard quote path, so both legs are read alike. */
async function readQuote(key: string, ctx: LoadContext, failed: (error: unknown) => null): Promise<Quote | null> {
  const instrument = await resolveHeadlessInstrument(ctx, key);
  return ctx.marketData.getQuote(instrument.symbol, instrument.exchange ?? "").catch(failed);
}

/** The company's other lines a note names before it counts the rest ("and 2 more"). */
const OTHER_LINES_NAMED = 3;

/**
 * The company's lines on venues other than the pair's, as their listings
 * (Hong Kong's 0005:HKEX for HSBC beside its London home line), with the
 * issuer's name. Null when the service cannot say.
 */
async function otherLines(receiptKey: string, homeKey: string, ctx: LoadContext): Promise<{ issuer: string; lines: string[] } | null> {
  const { getIssuerListings } = ctx.marketData;
  if (!getIssuerListings) return null;
  const [receipt, home] = await Promise.all([resolveHeadlessInstrument(ctx, receiptKey), resolveHeadlessInstrument(ctx, homeKey)]);
  const homeVenue = canonicalExchange(home.exchange || listingSuffixCandidate(home.symbol)?.exchange || parsePublicTickerKey(homeKey).exchange);
  const issuer = await Promise.resolve().then(() => getIssuerListings.call(ctx.marketData, receipt.symbol, receipt.exchange || undefined))
    .catch(logFailure("plugins.adr-pair", "Reading the company's listings failed", null));
  if (!issuer) return null;
  // The receipt is the company's US line; another US line or the home venue's is no line abroad to add.
  const lines = issuer.listings.filter((line) => {
    const venue = canonicalExchange(line.exchange);
    return venue && venue !== homeVenue && !isUsListingExchange(venue);
  }).map((line) => parsePublicTickerKey(line.symbol).exchange ? displayTickerKey(line.symbol) : `${line.symbol}:${canonicalExchange(line.exchange)}`);
  return { issuer: issuer.name, lines: [...new Set(lines)] };
}

/**
 * "HSBC Holdings plc also lists 0005:HKEX.", the company named as the
 * not-traded message names it (`companyLinesName`, by its home line's name),
 * the first few lines and how many more. Null when it has no other line.
 */
function otherLinesNote(other: { issuer: string; lines: string[] } | null, home: Quote | null): string | null {
  if (!other || other.lines.length === 0) return null;
  const named = other.lines.slice(0, OTHER_LINES_NAMED);
  const more = other.lines.length - named.length;
  const list = more > 0 ? `${named.join(", ")} and ${more} more` : named.join(", ");
  return `${companyLinesName(home?.name, other.issuer)} also lists ${list}.`;
}

/** An A+H pair's comparison, with the quotes it read; null for a listing of no such pair. */
interface AhRead {
  pair: AhPair;
  quotes: { h: Quote | null; a: Quote | null };
  comparison: AhComparison | null;
}

/**
 * The A+H pair of the listing `key`, from the company's lines Gloom Cloud
 * holds, both lines read through the quote path and the yuan's Hong Kong
 * dollar rate from both dollar rates (as `fx` dates them). Null for a listing
 * off HKEX, SSE and SZSE, or of a company that is no such pair.
 */
async function readAhPair(key: string, ctx: LoadContext, failed: (label: string) => (error: unknown) => null): Promise<AhRead | null> {
  const { getIssuerListings } = ctx.marketData;
  const instrument = await resolveHeadlessInstrument(ctx, key);
  if (!getIssuerListings || !mayBeAhLine(instrument.symbol, instrument.exchange)) return null;
  const issuer = await Promise.resolve().then(() => getIssuerListings.call(ctx.marketData, instrument.symbol, instrument.exchange || undefined))
    .catch(logFailure("plugins.adr-pair", "Reading the company's listings failed", null));
  const pair = ahPairOf(issuer);
  if (!pair || !ahPairSide(pair, instrument.symbol, instrument.exchange)) return null;
  const [h, a, cny, hkd] = await Promise.all([
    readQuote(pair.h, ctx, failed(pair.h)),
    readQuote(pair.a, ctx, failed(pair.a)),
    readSpot("CNY", ctx).catch(failed(dollarPairLabel("CNY"))),
    readSpot("HKD", ctx).catch(failed(dollarPairLabel("HKD"))),
  ]);
  // Units a dollar, so Hong Kong dollars a yuan is the one over the other.
  const spot: AhSpot | null = cny && hkd ? {
    rate: hkd.rate / cny.rate,
    observedAt: cny.observedAt != null && hkd.observedAt != null ? Math.min(cny.observedAt, hkd.observedAt) : null,
  } : null;
  return { pair, quotes: { h, a }, comparison: compareAhPair(pairPriceInput(pair.h, h), pairPriceInput(pair.a, a), spot) };
}

const INPUT_COLUMNS = [
  { key: "listing", header: "Listing" },
  { key: "role", header: "Role" },
  { key: "price", header: "Price", align: "right" as const },
  { key: "asOf", header: "As of (UTC)" },
  { key: "session", header: "Session" },
];

/** The A+H pair's figures and inputs as report sections, leaving out an input line `listed` already holds. */
function ahSections(read: AhRead & { comparison: AhComparison }, listed: readonly string[] = []) {
  const { comparison } = read;
  return [
    {
      title: `${read.pair.h} vs ${read.pair.a}`,
      entries: ahPairFigures(comparison, read.quotes.h).map((figure) => ({
        key: figure.id, label: figure.label,
        value: figure.id === "ah-premium" ? comparison.premiumPercent
          : figure.id === "ah-a-in-hkd" ? comparison.aInHkd
          : comparison.spot?.rate ?? null,
        formatted: figure.detail ? `${figure.value} (${figure.detail})` : figure.value,
      })),
    },
    {
      title: "A+H inputs",
      columns: INPUT_COLUMNS,
      rows: ahPairInputRows(comparison, read.quotes, listed).map(({ opens: _opens, ...row }) => row),
    },
  ];
}

/** What the report's metadata says of an A+H pair. */
function ahMetadata(read: AhRead & { comparison: AhComparison }) {
  const { comparison } = read;
  return {
    hShare: read.pair.h, aShare: read.pair.a, ahPremiumPercent: comparison.premiumPercent, aInHkd: comparison.aInHkd,
    hPrice: comparison.h.price, hObservedAt: comparison.h.observedAt, aPrice: comparison.a.price, aObservedAt: comparison.a.observedAt,
    cnyHkd: comparison.spot?.rate ?? null, cnyHkdObservedAt: comparison.spot?.observedAt ?? null,
  };
}

const hasComparison = (read: AhRead | null): read is AhRead & { comparison: AhComparison } => !!read?.comparison;

export const adrPairHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: { kind: "ticker", description: "A depositary receipt (GGAL, TSM), its home listing (GGAL.BA, 2330.TW), or a line of an A+H company (1088:HKEX, 601088:SSE)" },
  options: [],
  discovery: {
    // CCL is also a ticker (Carnival), so neither word opens ADR: `fn CCL` and `catalog ccl` point to it.
    suggestFor: ["CCL", "MEP"],
    screenshotReadiness: "ready",
    limitations: [
      "Listings Gloom Cloud pairs with a receipt, or whose company it holds as an A+H pair, only; the ratio is the depositary's, checked against both lines' prices.",
    ],
  },
  description: "A depositary receipt beside its home listing: the ratio, both regular-session prices with when each was set, the dollar rate they imply (home × ratio / ADR, the CCL rate for an Argentine pair), spot, and the receipt's premium or discount at spot. A line of an A+H company adds its other line: the H price over the A price at the yuan's spot rate, each price in its own currency with when it was set.",
  describe: ({ symbols }) => `ADR vs Home | ${symbols[0] ?? ""}`,
  async load({ symbols }, ctx) {
    const key = symbols[0]!;
    const financials = await loadHeadlessFinancials(ctx, key);
    ctx.signal.throwIfAborted();
    const legs = adrPairLegs(financials, null, key);
    const errors: string[] = [];
    const failed = (label: string) => (error: unknown) => {
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    };
    if (!legs) {
      // A line of an A+H company with no receipt: its two lines alone.
      const ah = await readAhPair(key, ctx, failed);
      ctx.signal.throwIfAborted();
      if (hasComparison(ah)) {
        return {
          sections: ahSections(ah),
          ...(ah.comparison.timingNote ? { notes: [ah.comparison.timingNote] } : {}),
          ...(errors.length > 0 ? { errors } : {}),
          freshness: {
            observations: [ah.quotes.h, ah.quotes.a].filter((quote): quote is Quote => !!quote).map((quote) => ({ ...quoteObservation(quote) })),
          },
          metadata: { ...ahMetadata(ah), template: ADR_PAIR_TEMPLATE_ID },
        };
      }
      if (ah) {
        const missing = !ah.quotes.h ? ah.pair.h : ah.pair.a;
        return { sections: [], empty: `No price for ${missing}, so the pair cannot be compared.`, unavailableSymbols: [missing], errors };
      }
      return {
        sections: [],
        empty: `${key} has no depositary receipt or A+H pair on record. ADR takes a receipt (GGAL, TSM), its home listing (GGAL.BA, 2330.TW) or a line of an A+H company (1088:HKEX, 601088:SSE).`,
        unavailableSymbols: [key],
      };
    }
    const [receipt, home, other, ah] = await Promise.all([
      readQuote(legs.receiptKey, ctx, failed(legs.receiptKey)),
      readQuote(legs.homeKey, ctx, failed(legs.homeKey)),
      otherLines(legs.receiptKey, legs.homeKey, ctx),
      readAhPair(key, ctx, failed),
    ]);
    ctx.signal.throwIfAborted();
    const quotes = { receipt, home };
    const otherLinesText = otherLinesNote(other, home);
    // A minor unit (GBp) is read as its currency, as the comparison reads the price.
    const homeCurrency = quotes.home?.currency ? heldCurrencyUnit(quotes.home.currency).currency : "";
    const spot = homeCurrency ? await readSpot(homeCurrency, ctx).catch(failed(dollarPairLabel(homeCurrency))) : null;
    const comparison = adrPairComparison(legs, quotes, spot);
    if (!comparison) {
      const missing = !quotes.receipt ? legs.receiptKey : legs.homeKey;
      return { sections: [], empty: `No price for ${missing}, so the pair cannot be compared.`, unavailableSymbols: [missing], errors };
    }
    const figures = adrPairFigures(comparison);
    const rows = adrPairInputRows(comparison, quotes);
    const kind = spotRateKind(homeCurrency);
    const pairNotes = [comparison.timingNote, ...hasComparison(ah) ? [ah.comparison.timingNote] : [], otherLinesText]
      .filter((note): note is string => !!note);
    return {
      sections: [
        {
          title: `${legs.receiptKey} vs ${legs.homeKey}`,
          entries: figures.map((figure) => ({
            key: figure.id, label: figure.label,
            value: figure.id === "implied" ? comparison.impliedFx
              : figure.id === "spot" ? comparison.spot?.rate ?? null
              : figure.id === "premium" ? comparison.premiumPercent
              : comparison.ratio,
            formatted: figure.detail ? `${figure.value} (${figure.detail})` : figure.value,
          })),
        },
        {
          title: "Inputs",
          columns: INPUT_COLUMNS,
          rows: rows.map(({ opens: _opens, ...row }) => row),
        },
        ...hasComparison(ah) ? ahSections(ah, rows.map((row) => row.listing)) : [],
      ],
      ...(pairNotes.length > 0 ? { notes: pairNotes } : {}),
      ...(errors.length > 0 ? { errors } : {}),
      freshness: {
        observations: [quotes.receipt, quotes.home, ...hasComparison(ah) ? [ah.quotes.a] : []]
          .filter((quote): quote is Quote => !!quote).map((quote) => ({ ...quoteObservation(quote) })),
      },
      metadata: {
        receipt: legs.receiptKey, home: legs.homeKey, ratio: comparison.ratio, currency: homeCurrency,
        impliedFx: comparison.impliedFx, spot: comparison.spot?.rate ?? null, ...(kind ? { spotKind: kind } : {}),
        premiumPercent: comparison.premiumPercent,
        receiptPrice: comparison.receipt.price, receiptObservedAt: comparison.receipt.observedAt,
        homePrice: comparison.home.price, homeObservedAt: comparison.home.observedAt,
        spotObservedAt: comparison.spot?.observedAt ?? null, template: ADR_PAIR_TEMPLATE_ID,
        ...hasComparison(ah) ? ahMetadata(ah) : {},
      },
    };
  },
};
