import { describe, expect, test } from "bun:test";
import type { CreditDocumentsPayload, CreditFact, CreditInstrument, CreditScreenPayload } from "../../../api-client/credit-documents";
import type { HeadlessBundleResult, HeadlessBundleSection, HeadlessPaneContext } from "../../../types/plugin";
import fixture from "./fico.fixture.json";
import { creditHeadless } from "./headless";
import { creditCoupon } from "./model";

const payload = () => structuredClone(fixture) as CreditDocumentsPayload;
const quote = "\u201cApplicable Margin\u201d means 1.48%.";
const fact = (instrument: CreditInstrument, field: string, value: CreditFact["value"], unit: string | null = null): CreditFact => ({
  ...payload().instruments[1]!.facts[0]!, instrumentName: instrument.name, instrumentKey: instrument.key, id: `${instrument.id}-${field}`, instrumentId: instrument.id, field, factKey: field, value, unit, currency: null, quote,
});
const loan = (facts: Array<[string, CreditFact["value"], string | null]>, currency: string | null = "USD"): CreditInstrument => {
  const base = payload().instruments[1]!;
  const row: CreditInstrument = { ...base, id: "loan", key: "loan", name: "Class A-L credit agreement", currency, facilityType: "term_loan", principal: 250_000_000, maturity: "2031-09-02", history: [],
    obligor: { name: "Owl Rock CLO XXVI, LLC", role: "borrower" }, facts: [] };
  row.facts = facts.map(([field, value, unit]) => fact(row, field, value, unit));
  return row;
};

async function load(options: Record<string, string | number | boolean>, data: CreditDocumentsPayload, screen?: CreditScreenPayload, instrument?: CreditInstrument) {
  const creditDocuments = async (path: string) => path.startsWith("screen") ? screen : path.includes("/instruments/") ? instrument : data;
  return await creditHeadless.load({ rawArgument: data.symbol, argument: data.symbol, symbols: [data.symbol], options },
    { apiClient: { creditDocuments }, signal: new AbortController().signal } as unknown as HeadlessPaneContext) as HeadlessBundleResult;
}
const tables = (sections: HeadlessBundleSection[]) => sections.flatMap((section) => "rows" in section && section.rows ? [section] : []);
const cells = (sections: HeadlessBundleSection[]) => tables(sections).flatMap((section) => section.rows.flatMap((row) => Object.entries(row)));

describe("credit-document margin", () => {
  test("a floating margin is a spread in basis points over its base, a fixed coupon stays a percentage", () => {
    expect(creditCoupon(loan([["margin", 1.48, "percent"]], null))).toBe("S+148");
    expect(creditCoupon(loan([["margin", 1.48, "percent"]]))).toBe("S+148");
    expect(creditCoupon(loan([["reference_rate", "Term SOFR", null], ["margin", 175, "bps"]]))).toBe("S+175");
    expect(creditCoupon(loan([["reference_rate", "EURIBOR", null], ["margin", 2.25, "percent"]], "EUR"))).toBe("EURIBOR+225");
    // No base is named and the instrument is not in dollars: the margin is not guessed to be over SOFR.
    expect(creditCoupon(loan([["margin", 1.5, "percent"]], "EUR"))).toBe("+150");
    expect(creditCoupon(loan([["coupon", 5.25, "percent"]]))).toBe("5.25%");
    expect(creditCoupon(loan([]))).toBe("--");
  });
});

describe("credit-document exports", () => {
  const data = (): CreditDocumentsPayload => {
    const docs = payload();
    docs.instruments.push(loan([["margin", 1.48, "percent"], ["facility_type", "term_loan", "text"]]));
    docs.changeOfControl = [{ instrumentId: "loan", instrumentName: "Class A-L credit agreement", currency: "USD", principal: 250_000_000, trigger: "Change of control", putPercent: 101,
      evidenceIds: [docs.instruments.at(-1)!.facts[0]!.id], obligor: { name: "Owl Rock CLO XXVI, LLC", role: "borrower" } }];
    return docs;
  };
  const screen = (docs: CreditDocumentsPayload): CreditScreenPayload => ({ truncated: false, access: "full", lockedRows: 0, asOf: "2026-10-04T12:00:00.000Z",
    rows: [{ symbol: "FICO", issuerName: "Fair Isaac", instrumentId: docs.instruments[0]!.id, instrumentName: docs.instruments[0]!.name, kind: "headroom", value: -2, date: "2026-09-30", currency: "USD",
      reason: "headroom is below the limit", evidence: docs.instruments[0]!.facts }] });

  test("every section holds flat records: no nested object or array reaches a cell", async () => {
    const docs = data();
    const reports = [await load({}, docs), await load({ tab: "screen" }, docs, screen(docs)), await load({ instrument: "loan" }, docs, undefined, docs.instruments.at(-1))];
    for (const report of reports) {
      expect(report.sections.length).toBeGreaterThan(0);
      for (const [key, value] of cells(report.sections)) expect([key, typeof value === "object" && value !== null]).toEqual([key, false]);
    }
  });

  test("the capital structure is the pane's columns with a margin as S+148, and the obligor by name", async () => {
    const [capital] = tables((await load({}, data())).sections);
    expect(capital!.columns!.map((column) => column.header)).toEqual(["Instrument", "Status", "Type", "Coupon/Margin", "Maturity", "Outstanding", "Commitment", "CCY", "Rank", "CoC put", "Obligor", "Instrument ID"]);
    const row = capital!.rows.find((entry) => entry.instrumentId === "loan")!;
    expect(row).toMatchObject({ name: "Class A-L credit agreement", coupon: "S+148", outstanding: 250_000_000, controlPut: "101%", obligor: "Owl Rock CLO XXVI, LLC" });
    // The text report leaves out what the pane leaves out (no ranking is disclosed for most instruments here) and the figures only a spreadsheet reads.
    const text = capital!.textColumns!.map((column) => column.key);
    expect(text).toEqual(expect.arrayContaining(["name", "coupon", "outstanding", "obligor", "instrumentId"]));
    expect(text).not.toContain("ranking");
    expect(text).not.toContain("commitment");
  });

  test("each table keeps the instrument id that --instrument opens, and quotes are only in the instrument view", async () => {
    const docs = data();
    const overview = tables((await load({}, docs)).sections);
    expect(overview.map((section) => section.title)).toEqual(["Capital structure", "Covenants", "Maturity wall", "Change of control"]);
    for (const section of overview) expect(section.columns!.some((column) => column.key === "instrumentId")).toBe(true);
    expect(JSON.stringify(overview)).not.toContain("Applicable Margin");
    const detail = tables((await load({ instrument: "loan" }, docs, undefined, docs.instruments.at(-1))).sections);
    expect(detail.map((section) => section.title)).toEqual(["Class A-L credit agreement", "Current terms", "Amendment history"]);
    expect(detail[1]!.rows.map((row) => [row.term, row.value, row.quote])).toContainEqual(["Margin", "1.48%", quote]);
  });

  test("a full wall carries each currency's shares apart, a preview wall has none", async () => {
    const docs = data();
    docs.maturities.push({ year: 2031, currency: "EUR", principal: 100, instruments: [{ id: "loan", name: "Class A-L credit agreement", principal: 100, evidenceIds: [docs.instruments.at(-1)!.facts[0]!.id] }] });
    const wall = (await load({}, docs)).sections.find((section) => section.title === "Maturity wall") as Extract<HeadlessBundleSection, { rows: unknown[] }>;
    expect(wall.rows.filter((row) => row.currency === "EUR").map((row) => row.share)).toEqual([100]);
    expect(Math.max(...wall.rows.filter((row) => row.currency === "USD").map((row) => row.cumulative as number))).toBeCloseTo(100);
    docs.access = "preview";
    const preview = (await load({}, docs)).sections.find((section) => section.title === "Maturity wall") as Extract<HeadlessBundleSection, { rows: unknown[] }>;
    expect(preview.columns!.map((column) => column.key)).not.toContain("share");
  });

  test("the screen lists its signals by the pane's columns, evidence stays behind --instrument", async () => {
    const docs = data();
    const [section] = tables((await load({ tab: "screen" }, docs, screen(docs))).sections);
    expect(section!.columns!.map((column) => column.header)).toEqual(["Issuer", "Signal", "Headroom", "Date", "Instrument", "Condition", "CCY", "Instrument ID"]);
    expect(section!.rows[0]).toMatchObject({ symbol: "FICO", signal: "Breach", headroomPercent: -2, condition: "Headroom is below the limit" });
  });
});
