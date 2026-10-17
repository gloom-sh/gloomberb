import { afterEach, expect, test } from "bun:test";
import type { FundFactsPayload } from "../../../api-client/fund-facts";
import type { StatItem } from "../../../components/ui/stat-grid";
import { setLanguage, t } from "../../../i18n";
import { fundFactItems, fundFactOverviewFields, fundFactPublishers, fundFactsEmptyText, fundFactsErrorLine, fundFactsStaleText, FUND_FACTS_UNAVAILABLE } from "./fund-facts";

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
