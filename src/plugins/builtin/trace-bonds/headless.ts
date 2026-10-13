import type { HeadlessPaneDefinition } from "../../../types/headless";
import { fetchCorporateBonds, type CorporateBond } from "./client";
import { filterBondsByIssuer, formatBondChange, formatBondDecimal, latestTradeDate } from "./model";

const decimal = (digits: number) => (value: unknown) => (
  typeof value === "number" ? formatBondDecimal(value, digits) : "—"
);

const COLUMNS = [
  { key: "issuerName", header: "Issuer" },
  { key: "couponRate", header: "Coupon", align: "right" as const, format: decimal(3) },
  { key: "maturityDate", header: "Maturity" },
  { key: "lastSalePrice", header: "Price", align: "right" as const, format: decimal(3) },
  { key: "lastSaleYield", header: "Yield", align: "right" as const, format: decimal(3) },
  { key: "priceChangeNumber", header: "Chg", align: "right" as const, format: (value: unknown) => formatBondChange(typeof value === "number" ? value : null) },
  { key: "lastTradeDate", header: "Traded" },
  { key: "traceGradeCode", header: "Grade" },
];

function reportRow(bond: CorporateBond) {
  return {
    id: bond.id,
    issuerName: bond.issuerName,
    couponRate: bond.couponRate,
    maturityDate: bond.maturityDate,
    lastSalePrice: bond.lastSalePrice,
    lastSaleYield: bond.lastSaleYield,
    priceChangeNumber: bond.priceChangeNumber,
    lastTradeDate: bond.lastTradeDate,
    traceGradeCode: bond.traceGradeCode,
  };
}

/** One page of the latest corporate and agency bond sales. An issuer argument filters that page. */
export const traceBondsHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: {
    kind: "free-text",
    optional: true,
    placeholder: "issuer",
    description: "Issuer text matched against the loaded page.",
  },
  options: [],
  discovery: {
    aliases: ["TRACE"],
    dataRequirements: ["Corporate and agency bond last sales"],
    limitations: [
      "One page of 100 bonds, most recent last sale first",
      "An issuer argument filters that page and does not search the whole market",
    ],
  },
  describe: "Latest corporate and agency bond sales",
  freshness: { source: "FINRA", status: "not-a-feed", basis: "last sales", observedKey: "lastTradeDate" },
  async load(args, ctx) {
    const bonds = await fetchCorporateBonds(ctx.signal);
    const argument = Array.isArray(args.argument) ? args.argument.join(" ") : args.argument ?? "";
    const rows = filterBondsByIssuer(bonds, argument);
    const tradeDate = latestTradeDate(bonds);
    return {
      sections: [{
        title: tradeDate ? `Last sales ${tradeDate}` : "Last sales",
        columns: COLUMNS,
        rows: rows.map(reportRow),
      }],
      complete: true,
      metadata: { tradeDate, matched: rows.length },
    };
  },
};
