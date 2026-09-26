import { expect, test } from "bun:test";
import type { Quote, TickerFinancials } from "../../../types/financials";
import type { TickerPosition, TickerRecord } from "../../../types/ticker";
import { getPortfolioPositionMetrics, resolvePortfolioMarketValue, resolvePortfolioPositionPnl } from "./position-metrics";
import { calculatePortfolioSummaryTotals, getColumnValue, getSortValue } from "./metrics";
import { buildPositionRows } from "../ticker-detail/overview/model";
import { getPortfolioPositionValue } from "../kelly-sizer/portfolio";

const position = (overrides: Partial<TickerPosition> = {}): TickerPosition => ({ portfolio: "main", broker: "controlled", shares: 1000,
  currency: "USD", avgCost: 87.742, markPrice: 86.359375, multiplier: 1, priceBasis: "percent-of-par", ...overrides });
const record = (positions = [position()], assetCategory = "BOND"): TickerRecord => ({ metadata: {
  ticker: "CONTROLLED", name: "Controlled", exchange: "", currency: "USD", assetCategory,
  positions, portfolios: ["main"], watchlists: [], tags: [], custom: {},
} });
const quote = (overrides: Partial<Quote> = {}): Quote => ({ symbol: "CONTROLLED", price: 87, change: 1, changePercent: 100/86,
  currency: "USD", instrumentType: "BOND", priceBasis: "percent-of-par", lastUpdated: 1700000000000, ...overrides });
const financials = (q?: Quote): TickerFinancials => ({ quote: q, annualStatements: [], quarterlyStatements: [], priceHistory: [] });
const ctx = { activeTab: "main", baseCurrency: "USD", exchangeRates: new Map([["USD",1],["EUR",1.2]]), now: 1700000000000 };
const col = (id: string) => ({ id, label: id, width: 18, align: "right" as const });
const totals = (r: TickerRecord, q?: Quote) => calculatePortfolioSummaryTotals([r], new Map([["CONTROLLED",financials(q)]]), "USD", ctx.exchangeRates, true, "main");

test("nominal bond cost and mark apply /100 once, independently of contract multiplier and optional totals", () => {
  for (const multiplier of [undefined, 1, 100]) {
    for (const supplied of [{}, { marketValue: 863.59 }, { unrealizedPnl: -13.83 }, { marketValue: 863.59, unrealizedPnl: -13.83 }]) {
      const r = record([position({ multiplier, ...supplied })]); const m = getPortfolioPositionMetrics(r,"main","USD");
      expect(m.totalCost).toBeCloseTo(877.42,8);
      expect(resolvePortfolioMarketValue(m)?.gross ?? null).toBeCloseTo(supplied.marketValue ?? 863.59375,8);
      expect(resolvePortfolioPositionPnl(m).value).toBeCloseTo(supplied.unrealizedPnl ?? (supplied.marketValue ?? 863.59375)-877.42,8);
      expect(r.metadata.positions[0]!.multiplier).toBe(multiplier);
    }
  }
  const r = record([position({ marketValue:863.59, unrealizedPnl:-13.83 })]);
  expect(totals(r).unrealizedPnlPct).toBeCloseTo(-1.5762120763,8);
  expect(getColumnValue(col("avg_cost"),r,financials(),ctx).text).toBe("87.74% par");
  expect(getSortValue(col("cost_basis"),r,financials(),ctx)).toBeCloseTo(877.42,8);
  expect(getSortValue(col("mkt_value"),r,financials(),ctx)).toBe(863.59);
  expect(buildPositionRows({ticker:r,quote:undefined,quoteCurrency:"USD",baseCurrency:"USD",toBase:v=>v})[0])
    .toMatchObject({qty:"1k USD face",avg:"87.7% par",mark:"86.4% par",cost:"$877.42",value:"$863.59",ret:"-1.58%"});
});

test("bond quote basis belongs to its own observation, and all monetary consumers select compatible snapshots", () => {
  const r = record([position({marketValue:863.59,unrealizedPnl:-13.83})]);
  for (const [q,value,pnl] of [
    [quote(),870,-7.42], [quote({priceBasis:"per-unit",price:.87,change:.01}),870,-7.42],
    [quote({priceBasis:undefined}),863.59,-13.83], [quote({price:NaN}),863.59,-13.83],
    [quote({currency:"EUR"}),863.59,-13.83], [quote({price:0,change:0}),0,-877.42],
  ] as const) {
    expect(totals(r,q).totalMktValue).toBeCloseTo(value,8);
    expect(totals(r,q).unrealizedPnl).toBeCloseTo(pnl,8);
    expect(getSortValue(col("mkt_value"),r,financials(q),ctx)).toBeCloseTo(value,8);
    expect(getSortValue(col("pnl"),r,financials(q),ctx)).toBeCloseTo(pnl,8);
    expect(getPortfolioPositionValue({ticker:r,financials:financials(q),portfolioId:"main",baseCurrency:"USD",exchangeRates:ctx.exchangeRates})).toBeCloseTo(value,8);
    expect(buildPositionRows({ticker:r,quote:q,quoteCurrency:q.currency,baseCurrency:"USD",toBase:(v,c)=>c==="EUR"?v*1.2:v})[0]!.pnlValue).toBeCloseTo(pnl,8);
  }
  expect(totals(r,quote()).dailyPnl).toBe(10);
  expect(totals(r,quote({priceBasis:undefined})).dailyPnl).toBeNaN();
  expect(getSortValue(col("mark_delta"),r,financials(quote({priceBasis:"per-unit",price:.87})),ctx)).toBeNull();
});

test("unknown legacy bond units preserve raw totals and quantity but cannot derive money or percentages", () => {
  const r=record([position({priceBasis:undefined,marketValue:863.59,unrealizedPnl:-13.83})]);
  expect(totals(r,quote())).toMatchObject({totalMktValue:863.59,totalCostBasis:Number.NaN,unrealizedPnl:-13.83,unrealizedPnlPct:Number.NaN,unavailableCostSymbols:["CONTROLLED"]});
  for(const id of ["avg_cost","cost_basis","pnl_pct","price"]) {
    expect(getColumnValue(col(id),r,financials(),ctx).text).toBe("—");
    expect(getSortValue(col(id),r,financials(),ctx)).toBeNull();
  }
  expect(r.metadata.positions[0]).toMatchObject({shares:1000,avgCost:87.742,markPrice:86.359375});
  const noTotals=record([position({priceBasis:undefined})]);
  expect(totals(noTotals).totalMktValue).toBeNaN(); expect(totals(noTotals).unrealizedPnl).toBeNaN();
});

test("signed nominal currency totals convert after pricing; absent cost, zero and mixed lots remain distinct", () => {
  const short=record([position({currency:"EUR",side:"short",marketValue:-863.59,unrealizedPnl:13.83})]);
  expect(totals(short).totalCostBasis).toBeCloseTo(877.42*1.2,8);
  expect(totals(short).netMktValue).toBeCloseTo(-863.59*1.2,8);
  expect(totals(short).unrealizedPnl).toBeCloseTo(13.83*1.2,8);
  expect(totals(record([position({avgCost:undefined,unrealizedPnl:-13.83})])).unrealizedPnl).toBe(-13.83);
  expect(totals(record([position({avgCost:0})]))).toMatchObject({totalCostBasis:0,unrealizedPnlPct:Number.NaN});
  const mixed=record([position(),position({priceBasis:"per-unit",avgCost:.87742,markPrice:.86359375})]);
  expect(totals(mixed).totalCostBasis).toBeCloseTo(1754.84,8);
  expect(getSortValue(col("avg_cost"),mixed,financials(),ctx)).toBeNull();
  const offset=record([position(),position({side:"short"})]);
  expect(totals(offset,quote())).toMatchObject({totalMktValue:1740,netMktValue:0,unrealizedPnl:0});
});

test("explicit per-unit bonds and other asset contracts retain monetary unit prices and derivative cost policy", () => {
  for(const asset of ["STK","ETF","OPT","FUT"]) {
    const r=record([position({priceBasis:undefined})],asset);
    expect(totals(r).totalCostBasis).toBe(87742); expect(totals(r).totalMktValue).toBe(86359.375);
  }
  expect(totals(record([position({priceBasis:"per-unit",avgCost:.87742,markPrice:.86359375})])).totalCostBasis).toBeCloseTo(877.42,8);
  const option=record([position({priceBasis:undefined,shares:2,multiplier:100,avgCost:400,markPrice:5,marketValue:1000,unrealizedPnl:200})],"OPT");
  expect(totals(option)).toMatchObject({totalCostBasis:800,totalMktValue:1000,unrealizedPnl:200});
});

test("mixed known and legacy bond lots retain per-lot quote and source valuations without net-exposure division",()=>{
  const r=record([position({marketValue:863.59,unrealizedPnl:-13.83}),position({shares:500,priceBasis:undefined,marketValue:550,unrealizedPnl:50})]);
  const result=totals(r,quote());
  expect(result.totalMktValue).toBeCloseTo(1420,8);
  expect(result.unrealizedPnl).toBeCloseTo(42.58,8);
  expect(result.unrealizedPnlBasis).toBe("mixed");
  expect(result.totalCostBasis).toBeNaN(); expect(result.dailyPnl).toBeNaN();
  expect(getSortValue(col("mkt_value"),r,financials(quote()),ctx)).toBeCloseTo(1420,8);
});

test("a percentage quote cannot define nominal quantity for a per-unit holding",()=>{
  for(const asset of ["STK","BOND"]) {
    const r=record([position({priceBasis:"per-unit",shares:100,avgCost:2,markPrice:2.5,marketValue:250,unrealizedPnl:50})],asset);
    expect(totals(r,quote({price:98}))).toMatchObject({totalMktValue:250,unrealizedPnl:50,unrealizedPnlBasis:"broker-snapshot"});
  }
});

test("nominal bond currency cannot be supplied by an independent quote",()=>{
  const r=record([position({currency:"",marketValue:863.59,unrealizedPnl:-13.83})]);r.metadata.currency="";
  const m=getPortfolioPositionMetrics(r,"main","USD",undefined,quote());
  expect(m.positionCurrency).toBe("");expect(m.totalCost).toBeNaN();
  expect(resolvePortfolioMarketValue(m)?.gross ?? null).toBeNull();
  expect(totals(r,quote()).totalMktValue).toBeNaN();
  expect(r.metadata.positions[0]).toMatchObject({marketValue:863.59,unrealizedPnl:-13.83,currency:""});
});
