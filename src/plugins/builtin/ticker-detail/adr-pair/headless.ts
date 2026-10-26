import type { HeadlessPaneDefinition } from "../../../../types/headless";
import type { Quote } from "../../../../types/financials";
import { dollarPairLabel, spotFromUsdValue, spotRateKind } from "../../../../market-data/depositary-pair";
import { loadHeadlessFinancials, resolveHeadlessInstrument } from "../../shared/headless-market-data";
import { quoteObservation } from "../../shared/report-freshness";
import { heldCurrencyUnit } from "../../../../utils/currency-units";
import { adrPairComparison, adrPairFigures, adrPairInputRows, adrPairLegs, ADR_PAIR_TEMPLATE_ID } from "./model";

/** Words that ask for this report's figures without being its code: `fn CCL` answers with ADR. */
export const ADR_PAIR_KEYWORDS = [
  "adr", "adrs", "adr vs home", "adr ratio", "adr premium", "adr discount", "depositary receipt", "depositary receipts",
  "home listing", "home line", "implied fx", "implied exchange rate", "implied dollar", "ccl", "contado con liquidacion",
  "dolar ccl", "mep", "dolar mep", "dolar bolsa", "blue chip swap", "cross listing", "dual listing",
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

export const adrPairHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: { kind: "ticker", description: "A depositary receipt (GGAL, TSM) or its home listing (GGAL.BA, 2330.TW)" },
  options: [],
  discovery: {
    // CCL is also a ticker (Carnival), so neither word opens ADR: `fn CCL` and `catalog ccl` point to it.
    suggestFor: ["CCL", "MEP"],
    screenshotReadiness: "ready",
    limitations: [
      "Listings Gloom Cloud pairs with a receipt only; the ratio is the depositary's, checked against both lines' prices.",
    ],
  },
  description: "A depositary receipt beside its home listing: the ratio, both regular-session prices with when each was set, the dollar rate they imply (home × ratio / ADR, the CCL rate for an Argentine pair), spot, and the receipt's premium or discount at spot.",
  describe: ({ symbols }) => `ADR vs Home | ${symbols[0] ?? ""}`,
  async load({ symbols }, ctx) {
    const key = symbols[0]!;
    const financials = await loadHeadlessFinancials(ctx, key);
    ctx.signal.throwIfAborted();
    const legs = adrPairLegs(financials, null, key);
    if (!legs) {
      return {
        sections: [],
        empty: `${key} has no depositary receipt pair on record. ADR takes a receipt (GGAL, TSM) or its home listing (GGAL.BA, 2330.TW).`,
        unavailableSymbols: [key],
      };
    }
    const errors: string[] = [];
    const failed = (label: string) => (error: unknown) => {
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    };
    const [receipt, home] = await Promise.all([
      readQuote(legs.receiptKey, ctx, failed(legs.receiptKey)),
      readQuote(legs.homeKey, ctx, failed(legs.homeKey)),
    ]);
    ctx.signal.throwIfAborted();
    const quotes = { receipt, home };
    // A minor unit (GBp) is read as its currency, as the comparison reads the price.
    const homeCurrency = quotes.home?.currency ? heldCurrencyUnit(quotes.home.currency).currency : "";
    const spot = homeCurrency ? await readSpot(homeCurrency, ctx).catch(failed(dollarPairLabel(homeCurrency))) : null;
    const comparison = adrPairComparison(legs, quotes, spot);
    if (!comparison) {
      const missing = !quotes.receipt ? legs.receiptKey : legs.homeKey;
      return { sections: [], empty: `No price for ${missing}, so the pair cannot be compared.`, unavailableSymbols: [missing], errors };
    }
    const figures = adrPairFigures(comparison);
    const rows = adrPairInputRows(comparison);
    const kind = spotRateKind(homeCurrency);
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
          columns: [
            { key: "listing", header: "Listing" },
            { key: "role", header: "Role" },
            { key: "price", header: "Price", align: "right" },
            { key: "asOf", header: "As of (UTC)" },
            { key: "session", header: "Session" },
          ],
          rows: rows.map(({ opens: _opens, ...row }) => row),
        },
      ],
      ...(comparison.timingNote ? { notes: [comparison.timingNote] } : {}),
      ...(errors.length > 0 ? { errors } : {}),
      freshness: {
        observations: [quotes.receipt, quotes.home].filter((quote): quote is Quote => !!quote).map((quote) => ({ ...quoteObservation(quote) })),
      },
      metadata: {
        receipt: legs.receiptKey, home: legs.homeKey, ratio: comparison.ratio, currency: homeCurrency,
        impliedFx: comparison.impliedFx, spot: comparison.spot?.rate ?? null, ...(kind ? { spotKind: kind } : {}),
        premiumPercent: comparison.premiumPercent,
        receiptPrice: comparison.receipt.price, receiptObservedAt: comparison.receipt.observedAt,
        homePrice: comparison.home.price, homeObservedAt: comparison.home.observedAt,
        spotObservedAt: comparison.spot?.observedAt ?? null, template: ADR_PAIR_TEMPLATE_ID,
      },
    };
  },
};
