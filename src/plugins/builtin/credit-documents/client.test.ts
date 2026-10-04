import { describe, expect, test } from "bun:test";
import type { CreditDocumentsPayload } from "../../../api-client/credit-documents";
import fixture from "./fico.fixture.json";
import { creditIssuerSymbol, fetchCreditInstrument, validateCreditDocuments, validateCreditInstrument, validateCreditScreen } from "./client";
import { creditMaturityRows, factValue, maturitySeries } from "./model";
const payload = () => structuredClone(fixture) as CreditDocumentsPayload;

describe("credit evidence boundary", () => {
  test("US venue aliases resolve to SEC symbols while foreign listing identity survives", () => {
    expect(creditIssuerSymbol("FICO:XNYS")).toBe("FICO");
    expect(creditIssuerSymbol("005930:KRX")).toBe("005930:KRX");
    expect(creditIssuerSymbol("6758:TSE")).toBe("6758:TSE");
  });
  test("real filing amounts preserve USD and unavailable adjusted headroom", () => {
    const data = validateCreditDocuments(payload(), "FICO");
    expect(data.instruments.length).toBe(4);
    expect(data.covenants[0]?.headroomPercent).toBeNull();
    expect(data.covenants[0]?.status).toBe("uncomputable");
    expect(data.maturities.find((row) => row.year === 2028)?.principal).toBe(900_000_000);
    expect(data.instruments.flatMap((row) => row.facts).every((row) => row.quote.length > 0)).toBe(true);
  });
  test("rejects orphan derived evidence and unsupported computed headroom", () => {
    const data = payload();
    data.maturities[0]!.instruments[0]!.evidenceIds = ["missing"];
    expect(() => validateCreditDocuments(data)).toThrow("unreadable credit documents");
    const computed = payload();
    computed.covenants[0]!.headroomPercent = 25;
    expect(() => validateCreditDocuments(computed)).toThrow("unreadable credit documents");
    const foreign = payload();
    foreign.covenants[0]!.evidenceIds = [foreign.instruments.find((row) => row.id !== foreign.covenants[0]!.instrumentId)!.facts[0]!.id];
    expect(() => validateCreditDocuments(foreign)).toThrow("unreadable credit documents");
  });
  test("future revisions remain in history and cannot support current balances or risk signals", () => {
    const instrument = payload().instruments[0]!;
    const pending = { ...instrument.facts[0]!, id: "future-revision", status: "pending" as const, effectiveDate: "2027-01-01" };
    instrument.history = [...instrument.facts, pending];
    expect(validateCreditInstrument(instrument).history?.at(-1)?.status).toBe("pending");
    const screen = { rows: [{ symbol: "FICO", issuerName: "Fair Isaac", instrumentId: instrument.id, instrumentName: instrument.name, kind: "headroom" as const, value: 2, date: "2026-09-30", currency: "USD", reason: "Low headroom", evidence: [pending] }], access: "full" as const, lockedRows: 0, asOf: "2026-10-04T12:00:00Z", truncated: false };
    expect(() => validateCreditScreen(screen)).toThrow("screening");
    pending.effectiveDate = "2027-02-30";
    expect(() => validateCreditInstrument(instrument)).toThrow("instrument evidence");
    pending.effectiveDate = "2027-01-01";
    instrument.facts.push(pending);
    expect(() => validateCreditInstrument(instrument)).toThrow("instrument evidence");
  });
  test("rejects cross-instrument evidence, malformed dates and unsafe source links", async () => {
    const data = payload();
    data.instruments[0]!.facts[0]!.instrumentId = "unrelated";
    expect(() => validateCreditDocuments(data)).toThrow("instrument evidence");
    const date = payload(); date.instruments[0]!.facts[0]!.filedAt = "2025-02-30";
    expect(() => validateCreditDocuments(date)).toThrow("instrument evidence");
    const link = payload(); link.instruments[0]!.facts[0]!.filingUrl = "javascript:alert(1)";
    expect(() => validateCreditDocuments(link)).toThrow("instrument evidence");
    await expect(fetchCreditInstrument("FICO", "wrong", { creditDocuments: async <T,>() => payload().instruments[0]! as T })).rejects.toThrow("different credit instrument");
  });
  test("screens accept dated empty observations but reject unsupported risk signals", () => {
    expect(validateCreditScreen({ rows: [], access: "full", lockedRows: 0, asOf: "2026-10-04T12:00:00.000Z", truncated: false }).rows).toEqual([]);
    expect(() => validateCreditScreen({ rows: [{ symbol: "FICO", issuerName: "Fair Isaac", instrumentId: "loan", instrumentName: "Loan", kind: "headroom", value: 2, date: "2026-09-30", currency: "USD", reason: "Low headroom", evidence: [] }], access: "full", lockedRows: 0, asOf: "2026-10-04T12:00:00Z", truncated: false })).toThrow("screening");
  });
  test("maturity charts never combine currencies or infer absent years as zero", () => {
    const data = payload();
    data.maturities.push({ year: 2028, currency: "EUR", principal: 2_000_000, instruments: [] });
    const rows = creditMaturityRows(data, "USD");
    expect(rows.every((row) => row.currency === "USD")).toBe(true);
    const series = maturitySeries(rows, "USD", "#fff")[0]!;
    expect(series.points.filter((point) => point.value !== null).map((point) => point.date.getUTCFullYear())).toEqual(rows.map((row) => row.year));
    expect(factValue(data.instruments.flatMap((row) => row.facts).find((row) => row.field === "principal")!)).toContain("USD");
  });
});
