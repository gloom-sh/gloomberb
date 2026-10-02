import { expect, test } from "bun:test";
import type { Quote } from "../../types/financials";
import { resolveCanonicalQuote } from "./resolution";
import { mergeQuoteContribution, normalizeQuoteContribution } from "./contributions";
const now=Date.parse("2026-09-10T18:00:00Z");
const quote=(changes:Partial<Quote>={}):Quote=>({symbol:"CONTROLLED",price:87,currency:"USD",change:1,changePercent:100/86,
  previousClose:86,instrumentType:"BOND",priceBasis:"percent-of-par",lastUpdated:now,marketState:"REGULAR",sessionConfidence:"explicit",...changes});

test("selected price owns its unit; incompatible contributors cannot supply daily, session or range prices",()=>{
  const ibkr={...quote(),providerId:"ibkr",dataSource:"live" as const};
  const gloom={...quote({price:.87,previousClose:.86,priceBasis:"per-unit",marketState:"POST",postMarketPrice:.89,high52w:1,low52w:.8,bid:.85}),providerId:"gloom"};
  const selected=resolveCanonicalQuote({ibkr,gloom},now).quote!;
  expect(selected).toMatchObject({price:87,priceBasis:"percent-of-par",previousClose:86,change:1});
  for(const key of ["bid","postMarketPrice","high52w","low52w"] as const)expect(selected[key]).toBeUndefined();
  const unknown=resolveCanonicalQuote({ibkr:{...ibkr,priceBasis:undefined},gloom:{...gloom,priceBasis:"percent-of-par"}},now).quote!;
  expect(unknown.priceBasis).toBeUndefined();
  expect(unknown.postMarketPrice).toBeUndefined();
});

test("new untagged responses clear prior basis and cannot inherit old unit-priced session fields or extrema",()=>{
  const old=normalizeQuoteContribution(quote({providerId:"ibkr",marketState:"POST",postMarketPrice:88,postMarketChange:2,high:89,low:85}))!;
  const next=mergeQuoteContribution(old,quote({providerId:"ibkr",priceBasis:undefined,price:.87,marketState:undefined,high:undefined,low:undefined,previousClose:undefined}));
  expect(next.priceBasis).toBeUndefined();
  expect(next.postMarketPrice).not.toBe(88);
  expect(next.high).toBeUndefined(); expect(next.low).toBeUndefined();
  expect(resolveCanonicalQuote({ibkr:next},now).quote!.priceBasis).toBeUndefined();
  const restored=mergeQuoteContribution(next,quote({providerId:"ibkr",price:90,postMarketPrice:90,marketState:"POST"}));
  expect(restored).toMatchObject({priceBasis:"percent-of-par",price:90,postMarketPrice:90});
});

test("unknown bond observations cannot borrow old or cross-provider units, anchors or descriptive share classification",()=>{
  const ibkr={...quote({priceBasis:undefined,previousClose:undefined,change:0}),providerId:"ibkr",dataSource:"live" as const};
  const gloom={...quote({priceBasis:undefined,previousClose:80,bid:85,high52w:100,marketState:"POST",postMarketPrice:89}),providerId:"gloom"};
  const selected=resolveCanonicalQuote({ibkr,gloom},now).quote!;
  expect(selected).toMatchObject({price:87,change:0,instrumentType:"BOND"});
  for(const key of ["priceBasis","previousClose","bid","postMarketPrice","high52w"] as const)expect(selected[key]).toBeUndefined();
  const enriched=resolveCanonicalQuote({ibkr,gloom:{...gloom,instrumentType:"STK"}},now).quote!;
  expect(enriched.instrumentType).toBe("BOND");expect(enriched.priceBasis).toBeUndefined();
  const old=normalizeQuoteContribution({...ibkr,previousClose:80,bid:85,open:84,high:90,low:80,high52w:100,lastTradePrice:86,lastTradeTime:now-1000,marketState:"REGULAR",exchangeName:"NYSE"})!;
  const next=mergeQuoteContribution(old,{...ibkr,lastUpdated:now+1000,marketState:"REGULAR",exchangeName:"NYSE"});
  for(const key of ["previousClose","bid","open","high","low","high52w","lastTradePrice","lastTradeTime"] as const)expect(next[key]).toBeUndefined();
  const self=resolveCanonicalQuote({ibkr:{...ibkr,previousClose:86,bid:85}},now).quote!;
  expect(self).toMatchObject({previousClose:86,bid:85});
});
