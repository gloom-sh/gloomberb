import { afterEach, expect, test } from "bun:test";
import type { FundFactsPayload } from "../../../api-client/fund-facts";
import type { StatItem } from "../../../components/ui/stat-grid";
import { setLanguage, t } from "../../../i18n";
import { fetchFundFacts, fundFactEntries, fundFactItems, fundFactOverviewFields, fundFactPublishers, fundFactsEmptyText, fundFactsErrorLine, fundFactsStaleText, FUND_FACTS_UNAVAILABLE } from "./fund-facts";

const IVV: FundFactsPayload = {
  ticker: "IVV", covered: true, name: "iShares Core S&P 500 ETF", structure: "registered",
  expenseRatio: { value: 0.03, asOf: "2026-10-16", source: "iShares", kind: "net" },
  nav: { value: 766.76, asOf: "2026-10-16", source: "iShares" },
  closingPrice: { value: 766.8, asOf: "2026-10-16", source: "Gloom Cloud" },
  premiumDiscount: { value: 0.005, asOf: "2026-10-16", source: "Gloom Cloud", basis: "computed" },
  netAssets: { value: 879e9, asOf: "2026-10-16", source: "iShares", scope: "share-class", period: "day" },
  sponsor: { value: "BlackRock (iShares)", asOf: null, source: "iShares" },
  inception: { value: "2000-05-15", asOf: null, source: "iShares" },
  index: null, stale: false, fetchedAt: null,
};

const byId = (facts: FundFactsPayload): Record<string, StatItem> => Object.fromEntries(fundFactItems(facts).map((item) => [item.id, item]));

afterEach(() => setLanguage("en"));

test("every figure carries its own date; one older than the NAV beside it is marked, month-end net assets are not", () => {
  const current = byId(IVV);
  expect(current.nav).toMatchObject({ detail: "2026-10-16" });
  expect(current.premium).toMatchObject({ detail: "2026-10-16 close" });
  expect(current.fee).toMatchObject({ detail: "net 2026-10-16" });
  expect(current.assets).toMatchObject({ detail: "2026-10-16" });
  expect(Object.values(current).some((item) => item.tone)).toBe(false);

  const lagging = byId({
    ...IVV,
    premiumDiscount: { ...IVV.premiumDiscount!, asOf: "2026-10-15" },
    netAssets: { ...IVV.netAssets!, asOf: "2026-10-15" },
  });
  expect(lagging.premium).toMatchObject({ detail: "2026-10-15 close", tone: "warning" });
  expect(lagging.assets).toMatchObject({ detail: "2026-10-15", tone: "warning" });
  expect(lagging.nav!.tone).toBeUndefined();

  const monthEnd = byId({ ...IVV, netAssets: { value: 1e12, asOf: "2026-09-30", source: "Vanguard", scope: "share-class", period: "month-end" } });
  expect(monthEnd.assets).toMatchObject({ detail: "2026-09-30 month-end" });
  expect(monthEnd.assets!.tone).toBeUndefined();

  // A stale NAV marks every dated figure, and DES colours the same ones.
  const stale = byId({ ...IVV, stale: true });
  expect(stale.nav).toMatchObject({ detail: "2026-10-16 stale", tone: "warning" });
  for (const id of ["premium", "fee", "assets"]) expect(stale[id]!.tone).toBe("warning");
  expect(stale.sponsor!.tone).toBeUndefined();
  expect(fundFactOverviewFields({ ...IVV, stale: true }).filter((field) => field.warn).map((field) => field.label))
    .toEqual(["NAV", "Prem/Disc", "Net Assets", "Exp Ratio"]);
  expect(fundFactOverviewFields(IVV).find((field) => field.label === "Prem/Disc")!.detail).toEqual(["2026-10-16 close", "10-16 close", "2026-10-16", "10-16"]);
  expect(fundFactsStaleText("IVV", { ...IVV, stale: true })).toBe("IVV's newest NAV is from 2026-10-16; its sponsor has not published one since.");
  expect(fundFactsStaleText("IVV", IVV)).toBeNull();
});

test("the footer names the fund's sponsor, not the close a premium was computed from", () => {
  expect(fundFactPublishers(IVV)).toEqual(["iShares"]);
  expect(fundFactPublishers({ ...IVV, netAssets: { ...IVV.netAssets!, source: "Vanguard" }, nav: { ...IVV.nav!, source: "Vanguard" }, expenseRatio: { ...IVV.expenseRatio!, source: "Vanguard" } }))
    .toEqual(["Vanguard"]);
});

test("the pane's labels, dates and notices are translated", () => {
  setLanguage("es");
  const items = byId({ ...IVV, stale: true });
  expect(items.premium!.detail).toBe("2026-10-16 cierre");
  expect(items.fee!.detail).toBe("neto 2026-10-16");
  expect(items.nav!.detail).toBe("2026-10-16 desactualizado");
  expect(t(items.premium!.label)).toBe("Prima/descuento");
  expect(fundFactOverviewFields(IVV).map((field) => t(field.label))).toEqual(["Valor liquidativo", "Prima/Desc.", "Patrimonio", "Ratio gastos", "Lanzamiento"]);
  expect(fundFactsEmptyText("USO", { ...IVV, covered: false, structure: "trust" })).toStartWith("USO está registrado ante la SEC como fideicomiso");
  expect(fundFactsEmptyText("QQQ", { ...IVV, covered: false, structure: "registered" })).toBe("Gloom aún no recopila los datos que publica el patrocinador de QQQ.");
  expect(fundFactsErrorLine(new Error(FUND_FACTS_UNAVAILABLE))).toBe("Los datos del fondo aún no están disponibles en este servidor.");
  expect(fundFactsStaleText("IVV", { ...IVV, stale: true })).toBe("El valor liquidativo más reciente de IVV es del 2026-10-16; su patrocinador no ha publicado otro desde entonces.");
  setLanguage("ja");
  expect(t("Premium/discount")).toBe("乖離率");
  expect(byId(IVV).premium!.detail).toBe("2026-10-16 終値");
});

const DFAC: FundFactsPayload = {
  ticker: "DFAC", covered: true, status: "covered", name: "Dimensional U.S. Core Equity 2 ETF", structure: "registered",
  expenseRatio: { value: 0.17, asOf: "2026-02-27", source: "SEC EDGAR", kind: "gross", document: "prospectus" },
  nav: null, closingPrice: null, premiumDiscount: null,
  netAssets: { value: 47.89e9, asOf: "2026-07-31", source: "SEC EDGAR", scope: "fund", period: "month-end", document: "N-PORT" },
  sponsor: null, inception: null, index: null, stale: false, fetchedAt: null,
};

test("figures from the SEC's data sets say which filing they come from: the prospectus's fee, net or gross, and N-PORT's month-end net assets of the whole fund", () => {
  const items = byId(DFAC);
  expect(Object.keys(items)).toEqual(["fee", "assets"]);
  expect(items.fee).toMatchObject({ value: "0.17%", detail: "gross, prospectus 2026-02-27" });
  expect(byId({ ...DFAC, expenseRatio: { ...DFAC.expenseRatio!, kind: "net" } }).fee!.detail).toBe("net, prospectus 2026-02-27");
  expect(byId({ ...DFAC, expenseRatio: { ...DFAC.expenseRatio!, kind: undefined as never } }).fee!.detail).toBe("prospectus 2026-02-27");
  // N-PORT's figure is the whole fund's, every share class: the label says so.
  expect(items.assets).toMatchObject({ label: "Fund net assets", detail: "2026-07-31 month-end · N-PORT" });
  // Without a NAV to compare with, neither is marked.
  expect(items.fee!.tone).toBeUndefined();
  expect(items.assets!.tone).toBeUndefined();
  expect(fundFactOverviewFields(DFAC).find((field) => field.label === "Fund Assets")!.detail)
    .toEqual(["2026-07-31 month-end · N-PORT", "07-31 month-end · N-PORT", "2026-07-31 month-end", "07-31 month-end"]);
  expect(fundFactEntries(DFAC).find((entry) => entry.key === "netAssets")!.formatted)
    .toBe("$47.89B · 2026-07-31 month-end N-PORT · all share classes · SEC EDGAR");
  // A share class's own figure (Vanguard's) and a trust's are plain net assets.
  expect(byId({ ...DFAC, netAssets: { ...DFAC.netAssets!, scope: "share-class" } }).assets!.label).toBe("Net assets");
  expect(byId({ ...DFAC, structure: "trust" }).assets!.label).toBe("Net assets");
  expect(fundFactOverviewFields({ ...DFAC, structure: "trust" }).map((field) => field.label)).toContain("Net Assets");
  expect(fundFactPublishers(DFAC)).toEqual(["SEC EDGAR"]);
  // A sponsor's NAV beside N-PORT's net assets: both publishers, and the month end is not marked as lagging.
  const soxl = byId({ ...DFAC, nav: { value: 107.36, asOf: "2026-10-15", source: "Direxion" } });
  expect(soxl.assets!.tone).toBeUndefined();
  expect(fundFactPublishers({ ...DFAC, nav: { value: 107.36, asOf: "2026-10-15", source: "Direxion" } })).toEqual(["Direxion", "SEC EDGAR"]);
  setLanguage("es");
  expect(byId(DFAC).fee!.detail).toBe("bruto, folleto 2026-02-27");
  expect(byId(DFAC).assets!.detail).toBe("2026-07-31 fin de mes · N-PORT");
  expect(t(byId(DFAC).assets!.label)).toBe("Patrimonio neto del fondo");
});

test("a fund without figures says not collected yet when a source Gloom reads covers it, and not published only when none does", () => {
  const empty = { ...IVV, covered: false };
  expect(fundFactsEmptyText("USO", { ...empty, status: "not-collected-yet", structure: "trust" }))
    .toBe("USO's figures are not collected yet; the next read stores them.");
  expect(fundFactsEmptyText("GBTC", { ...empty, status: "not-published", structure: "trust" }))
    .toBe("GBTC files with the SEC as a trust or pool, not as an open-end fund, and its sponsor's site is not one Gloom reads.");
  expect(fundFactsEmptyText("NEWF", { ...empty, status: "not-published", structure: "registered" }))
    .toBe("No figures for NEWF: its sponsor's site is not one Gloom reads, and the SEC's prospectus and N-PORT data sets list none for it yet.");
  expect(fundFactsEmptyText("DRAM", { ...empty, status: "not-published", structure: null }))
    .toBe("No figures for DRAM: it lists as a fund, but the SEC's lists do not name it yet and its sponsor's site is not one Gloom reads.");
  expect(fundFactsEmptyText("AAPL", { ...empty, status: "not-a-fund", structure: null }))
    .toBe("No fund facts for AAPL: it is not on the SEC's lists of US-listed funds.");
  setLanguage("ko");
  expect(fundFactsEmptyText("USO", { ...empty, status: "not-collected-yet", structure: "trust" }))
    .toBe("USO의 수치는 아직 수집되지 않았습니다. 다음 읽기에서 저장됩니다.");
});

test("a pool's total expense ratio reads as an expense ratio, gross, though the pool is a trust; only a sponsor fee reads as one", () => {
  const uso: FundFactsPayload = {
    ...IVV, ticker: "USO", name: "United States Oil Fund, LP", structure: "trust",
    expenseRatio: { value: 0.86, asOf: "2026-10-16", source: "USCF", kind: "gross" },
    netAssets: { value: 1.897e9, asOf: "2026-10-16", source: "USCF", scope: "fund", period: "day" },
  };
  expect(byId(uso).fee).toMatchObject({ label: "Expense ratio", value: "0.86%", detail: "gross 2026-10-16" });
  expect(fundFactOverviewFields(uso).find((field) => field.value === "0.86%")!.label).toBe("Exp Ratio");
  expect(fundFactEntries(uso).find((entry) => entry.key === "expenseRatioPercent")).toMatchObject({
    label: "Expense ratio", formatted: "0.86% gross · 2026-10-16 · USCF",
  });
  // A trust's net assets are the trust's: no share classes to speak of.
  expect(byId(uso).assets!.detail).toBe("2026-10-16");
  const ibit: FundFactsPayload = { ...uso, ticker: "IBIT", expenseRatio: { value: 0.25, asOf: "2026-10-16", source: "iShares", kind: "sponsor-fee" } };
  expect(byId(ibit).fee).toMatchObject({ label: "Sponsor fee", detail: "2026-10-16" });
  expect(fundFactOverviewFields(ibit).find((field) => field.value === "0.25%")!.label).toBe("Sponsor Fee");
});

const MUB: FundFactsPayload = {
  ...IVV, ticker: "MUB", name: "iShares National Muni Bond ETF",
  bond: {
    kind: "municipal", state: null,
    secYield: { value: 4.0418, asOf: "2026-10-15", source: "iShares" },
    yieldToWorst: { value: 4.16, asOf: "2026-10-15", source: "iShares" },
    duration: { value: 7.12591, asOf: "2026-10-15", source: "iShares", measure: "effective" },
  },
};

test("a bond fund's SEC yield, yield to worst and duration follow its net assets, each dated, and its class is a report line", () => {
  expect(fundFactItems(MUB).map((item) => [item.label, item.value, item.detail])).toEqual([
    ["NAV", "$766.76", "2026-10-16"],
    ["Premium/discount", "+0.01%", "2026-10-16 close"],
    ["Expense ratio", "0.03%", "net 2026-10-16"],
    ["Net assets", "$879B", "2026-10-16"],
    ["SEC yield", "4.04%", "2026-10-15"],
    ["Yield to worst", "4.16%", "2026-10-15"],
    ["Effective duration", "7.13 yrs", "2026-10-15"],
    ["Sponsor", "BlackRock (iShares)", undefined],
    ["Inception", "2000-05-15", undefined],
  ]);
  const entries = Object.fromEntries(fundFactEntries(MUB).map((entry) => [entry.key, [entry.value, entry.formatted, entry.unit]]));
  expect(entries).toMatchObject({
    bondClass: ["municipal", "Municipal, national", undefined],
    secYieldPercent: [4.0418, "4.04% · 2026-10-15 · iShares", "%"],
    yieldToWorstPercent: [4.16, "4.16% · 2026-10-15 · iShares", "%"],
    durationYears: [7.12591, "7.13 yrs · 2026-10-15 · iShares", "years"],
  });
  // Vanguard's average duration is a month end's; a single-state fund names its state.
  const vtec: FundFactsPayload = { ...MUB, bond: { kind: "municipal", state: "CA", secYield: null, yieldToWorst: null,
    duration: { value: 7, asOf: "2026-09-30", source: "Vanguard", measure: "average" } } };
  expect(byId(vtec).duration).toMatchObject({ label: "Average duration", value: "7.00 yrs", detail: "2026-09-30 month-end" });
  expect(fundFactEntries(vtec).find((entry) => entry.key === "bondClass")?.formatted).toBe("Municipal, CA (single-state)");
  // A fund the server sends no bond facts for, or an older server, shows none; the IVV cells are unchanged.
  expect(fundFactItems(IVV).map((item) => item.id)).toEqual(["nav", "premium", "fee", "assets", "sponsor", "inception"]);
  expect(fundFactPublishers(MUB)).toEqual(["iShares"]);
});

test("a metal trust's ounces and tonnes in trust follow its net assets, with the day's change and the date, from its sponsor's daily holdings", async () => {
  const gld: FundFactsPayload = {
    ...IVV, ticker: "GLD", name: "SPDR Gold Trust", structure: "trust",
    nav: { value: 378.04, asOf: "2026-10-20", source: "SPDR Gold Shares" },
    expenseRatio: null, premiumDiscount: null, netAssets: null, sponsor: null, inception: null,
    metalHoldings: {
      metal: "gold", asOf: "2026-10-20", ounces: 34085936.5, tonnes: 1060.18,
      change: { since: "2026-10-19", ounces: 54994.78, tonnes: 1.71 },
      source: { publisher: "SPDR Gold Shares", page: "https://www.spdrgoldshares.com/usa/gld/" },
      fetchedAt: "2026-10-21T23:00:00.000Z", stale: false,
    },
  };
  // The server's answer reads, and one with a malformed holdings figure is refused.
  expect((await fetchFundFacts("GLD", { getFundFacts: async () => gld })).metalHoldings?.ounces).toBe(34085936.5);
  await expect(fetchFundFacts("GLD", { getFundFacts: async () => ({ ...gld, metalHoldings: { ...gld.metalHoldings!, ounces: "lots" } }) as never }))
    .rejects.toThrow("Unreadable fund facts response");

  expect(fundFactItems(gld).map((item) => [item.label, item.value, item.detail])).toEqual([
    ["NAV", "$378.04", "2026-10-20"],
    ["Gold in trust", "1,060.18 t", "34.09M oz · 2026-10-20"],
    ["Day change", "+1.71 t", "+54,995 oz · since 2026-10-19"],
  ]);
  const entries = Object.fromEntries(fundFactEntries(gld).map((entry) => [entry.key, [entry.value, entry.formatted, entry.unit]]));
  expect(entries).toMatchObject({
    metalOunces: [34085936.5, "34,085,936.5 troy oz · 1,060.18 tonnes · 2026-10-20 · SPDR Gold Shares", "troy oz"],
    metalChangeOunces: [54994.78, "+54,994.78 troy oz · +1.71 tonnes · since 2026-10-19", "troy oz"],
  });

  // SLV's first stored day has no change yet, says so, and its stale day is marked.
  const slv: FundFactsPayload = { ...gld, ticker: "SLV", metalHoldings: { ...gld.metalHoldings!, metal: "silver", asOf: "2026-10-21",
    ounces: 497876480.1, tonnes: 15485.69, change: null, stale: true, source: { ...gld.metalHoldings!.source, publisher: "iShares" } } };
  expect(fundFactItems(slv).filter((item) => item.id?.startsWith("metal")).map((item) => [item.label, item.value, item.tone]))
    .toEqual([["Silver in trust", "15,485.69 t", "warning"]]);
  expect(fundFactEntries(slv).find((entry) => entry.key === "metalChangeOunces")).toMatchObject({ value: null, formatted: "-- · 2026-10-21 is the first day stored" });
  expect(fundFactPublishers(slv)).toEqual(["SPDR Gold Shares", "iShares"]);
});
