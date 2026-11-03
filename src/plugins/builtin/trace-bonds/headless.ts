import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/headless";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import {
  TRUNCATED_TEXT,
  fetchBondTape,
  issuerFallbackText,
  noPrintsText,
  parseBondQuery,
  quotedCompanyName,
  type CorporateBond,
} from "./client";
import { bondStackPriority, formatBondChange, formatBondDecimal, sharesOneIssuer, type BondColumnId } from "./model";
import {
  HISTORY_RANGES,
  keptSinceText,
  pricedDays,
  readStoredHistory,
  storedHistoryRefusal,
  type HistoryRange,
} from "./history";
import { logFailure } from "../../../utils/log-failure";
import type { StoredBondPayload } from "../../../api-client/bond-trades";

const decimal = (digits: number) => (value: unknown) => (
  typeof value === "number" ? formatBondDecimal(value, digits) : "—"
);

/** A narrow terminal moves columns under their row in the order the pane drops them. */
const column = (id: BondColumnId, spec: HeadlessPaneColumn): HeadlessPaneColumn => {
  const priority = bondStackPriority(id);
  return priority > 0 ? { ...spec, stackPriority: priority } : spec;
};

const COLUMNS: HeadlessPaneColumn[] = [
  // Cut no shorter than a name reads (`WHIRLPOOL CORP`); a narrow terminal moves other columns under the row first.
  column("issuer", { key: "issuerName", header: "Issuer", minWidth: 14 }),
  column("cusip", { key: "cusip", header: "CUSIP", shrink: false }),
  column("coupon", { key: "couponRate", header: "Coupon", align: "right", format: decimal(3) }),
  column("maturity", { key: "maturityDate", header: "Maturity" }),
  column("price", { key: "lastSalePrice", header: "Price", align: "right", format: decimal(3) }),
  column("yield", { key: "lastSaleYield", header: "Yield", align: "right", format: decimal(3) }),
  column("change", { key: "priceChangeNumber", header: "Chg", align: "right", format: (value: unknown) => formatBondChange(typeof value === "number" ? value : null) }),
  column("traded", { key: "lastTradeDate", header: "Traded" }),
  column("grade", { key: "traceGradeCode", header: "Grade" }),
];

/**
 * One issuer's tape (`sharesOneIssuer`) leaves the issuer column out of the
 * text table, as the pane does; exports and piped output keep it.
 */
function reportColumns(bonds: readonly CorporateBond[]): HeadlessPaneColumn[] {
  if (!sharesOneIssuer(bonds)) return COLUMNS;
  return COLUMNS.map((spec) => spec.key === "issuerName" ? { ...spec, minTableWidth: Number.MAX_SAFE_INTEGER } : spec);
}

function reportRow(bond: CorporateBond) {
  return {
    id: bond.id,
    issuerName: bond.issuerName,
    cusip: bond.cusip,
    couponRate: bond.couponRate,
    maturityDate: bond.maturityDate,
    lastSalePrice: bond.lastSalePrice,
    lastSaleYield: bond.lastSaleYield,
    priceChangeNumber: bond.priceChangeNumber,
    lastTradeDate: bond.lastTradeDate,
    traceGradeCode: bond.traceGradeCode,
  };
}

const HISTORY_COLUMNS: HeadlessPaneColumn[] = [
  { key: "date", header: "Date" },
  { key: "price", header: "Price", align: "right", format: decimal(3) },
  { key: "yield", header: "Yield", align: "right", format: decimal(3) },
  { key: "prints", header: "Prints", align: "right" },
];

/** A bond's kept daily closes in the range, newest first, titled by since when prints are kept. */
function historySection(history: StoredBondPayload, range: HistoryRange) {
  const days = HISTORY_RANGES.find((entry) => entry.value === range)!.days;
  const from = new Date(Date.parse(`${history.to}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  // A server from before daily closes were served answers none.
  const rows = pricedDays(history.days ?? []).filter((day) => day.date >= from).reverse();
  return {
    title: history.keptSince ? `Daily closes, kept since ${history.keptSince}` : "Daily closes",
    columns: HISTORY_COLUMNS,
    rows: rows.map((day) => ({ id: day.date, date: day.date, price: day.price, yield: day.yield, prints: day.prints })),
    empty: history.backfillPending
      ? "No kept prints yet; the source's earlier prints are still being read."
      : `No kept prints since ${from}.`,
  };
}

/** The latest corporate and agency bond sales, or one issuer's, symbol's or CUSIP's, asked of the tape itself. */
export const traceBondsHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: {
    kind: "free-text",
    optional: true,
    placeholder: "issuer, symbol or CUSIP",
    description: "Issuer name (matched from its start), symbol root, stock ticker or CUSIP. Leave it out for the market's latest sales.",
  },
  options: [
    {
      key: "range",
      type: "enum",
      description: "How far back a CUSIP's kept daily closes reach (Gloom Pro).",
      values: HISTORY_RANGES.map((entry) => ({ value: entry.value })),
      defaultValue: "3M",
      example: "--range 1Y",
    },
  ],
  discovery: {
    aliases: ["TRACE"],
    dataRequirements: ["Corporate and agency bond last sales", "Kept bond prints (Gloom Pro)"],
    limitations: [
      "One page of 100 bonds, most recent last sale first",
      "An issuer name matches the start of the issuer's name; a symbol matches the tape's own symbol root, which can differ from the stock ticker. A ticker with no bonds under either is asked once more by the name its quote gives the company",
      "An issuer's bonds that have matured are left out; a CUSIP shows its bond either way",
      "A CUSIP or a ticker looked up here is kept from then on, with the prints the source still publishes for it (about three years); a CUSIP's daily closes start where its prints are kept, and nothing before that is shown",
    ],
  },
  describe: "Latest corporate and agency bond sales",
  freshness: { source: "FINRA", status: "not-a-feed", basis: "last sales", observedKey: "lastTradeDate" },
  async load(args, ctx) {
    const argument = Array.isArray(args.argument) ? args.argument.join(" ") : args.argument ?? "";
    // A CUSIP's kept history, and a ticker's bonds kept from now on, read beside the tape: Gloom Pro, and never what fails it.
    const stored = readStoredHistory(parseBondQuery(argument), ctx.apiClient, { signal: ctx.signal })
      .then((history) => ({ history, note: null }))
      .catch((error: unknown) => {
        if (ctx.signal.aborted) return { history: null, note: null };
        return { history: null, note: storedHistoryRefusal(error) ?? logFailure("trace-bonds.headless", "Load kept bond prints failed", "Kept price history unavailable.")(error) };
      });
    const tape = await fetchBondTape(argument, {
      signal: ctx.signal,
      // A stock ticker with no bonds of its own: its company, as its quote names it.
      companyName: async (ticker) => {
        const { symbol, exchange } = await resolveHeadlessInstrument(ctx, ticker);
        return quotedCompanyName(ctx.marketData, symbol, exchange);
      },
    });
    const { query, bonds, tradeDate, truncated, issuer, failures } = tape;
    const shown = issuer && bonds.length > 0;
    const range = (HISTORY_RANGES.some((entry) => entry.value === args.options.range) ? args.options.range : "3M") as HistoryRange;
    const { history, note: historyNote } = await stored;
    ctx.signal.throwIfAborted();
    const kept = history ? keptSinceText(history) : null;
    return {
      sections: [{
        // An empty answer is its message alone, dated in its own words.
        title: bonds.length > 0 ? (tradeDate ? `Last sales ${tradeDate}` : "Last sales") : query ? "" : "Last sales",
        columns: reportColumns(bonds),
        rows: bonds.map(reportRow),
        ...(query ? { empty: noPrintsText(query, tradeDate, issuer) } : {}),
      }, ...(history ? [historySection(history, range)] : [])],
      complete: failures.length === 0,
      ...(failures.length > 0 ? { errors: failures } : {}),
      ...(truncated || kept || historyNote ? {
        notes: [...(truncated ? [TRUNCATED_TEXT] : []), ...(kept ? [kept] : []), ...(historyNote ? [historyNote] : [])],
      } : {}),
      ...(shown ? { warnings: [issuerFallbackText(query!, issuer)] } : {}),
      metadata: {
        tradeDate,
        matched: bonds.length,
        ...(query ? { query: query.text } : {}),
        ...(issuer ? { issuerName: issuer.name, company: issuer.company } : {}),
        ...(truncated ? { truncated } : {}),
        ...(history ? { keptSince: history.keptSince, backfillPending: history.backfillPending } : {}),
      },
      // One issuer's rows are each issue's own last sale, however old: a history, not stale rows.
      ...(query ? { freshness: { oldest: null } } : {}),
    };
  },
};
