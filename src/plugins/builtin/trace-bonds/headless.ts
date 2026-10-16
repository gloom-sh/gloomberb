import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/headless";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import {
  TRUNCATED_TEXT,
  fetchBondTape,
  issuerFallbackText,
  noPrintsText,
  quotedCompanyName,
  type CorporateBond,
} from "./client";
import { bondStackPriority, formatBondChange, formatBondDecimal, type BondColumnId } from "./model";

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

/** The latest corporate and agency bond sales, or one issuer's, symbol's or CUSIP's, asked of the tape itself. */
export const traceBondsHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: {
    kind: "free-text",
    optional: true,
    placeholder: "issuer, symbol or CUSIP",
    description: "Issuer name (matched from its start), symbol root, stock ticker or CUSIP. Leave it out for the market's latest sales.",
  },
  options: [],
  discovery: {
    aliases: ["TRACE"],
    dataRequirements: ["Corporate and agency bond last sales"],
    limitations: [
      "One page of 100 bonds, most recent last sale first",
      "An issuer name matches the start of the issuer's name; a symbol matches the tape's own symbol root, which can differ from the stock ticker. A ticker with no bonds under either is asked once more by the name its quote gives the company",
      "An issuer's bonds that have matured are left out; a CUSIP shows its bond either way",
    ],
  },
  describe: "Latest corporate and agency bond sales",
  freshness: { source: "FINRA", status: "not-a-feed", basis: "last sales", observedKey: "lastTradeDate" },
  async load(args, ctx) {
    const argument = Array.isArray(args.argument) ? args.argument.join(" ") : args.argument ?? "";
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
    return {
      sections: [{
        // An empty answer is its message alone, dated in its own words.
        title: bonds.length > 0 ? (tradeDate ? `Last sales ${tradeDate}` : "Last sales") : query ? "" : "Last sales",
        columns: COLUMNS,
        rows: bonds.map(reportRow),
        ...(query ? { empty: noPrintsText(query, tradeDate, issuer) } : {}),
      }],
      complete: true,
      ...(failures.length > 0 ? { errors: failures } : {}),
      ...(truncated ? { notes: [TRUNCATED_TEXT] } : {}),
      ...(shown ? { warnings: [issuerFallbackText(query!, issuer)] } : {}),
      metadata: {
        tradeDate,
        matched: bonds.length,
        ...(query ? { query: query.text } : {}),
        ...(issuer ? { issuerName: issuer.name, company: issuer.company } : {}),
        ...(truncated ? { truncated } : {}),
      },
      // One issuer's rows are each issue's own last sale, however old: a history, not stale rows.
      ...(query ? { freshness: { oldest: null } } : {}),
    };
  },
};
