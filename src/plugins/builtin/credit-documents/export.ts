import type { CreditDocumentsPayload, CreditFact, CreditInstrument, CreditObligor, CreditScreenPayload } from "../../../api-client/credit-documents";
import type { HeadlessBundleSection, HeadlessPaneColumn, HeadlessPaneRow } from "../../../types/plugin";
import { capitalCell, capitalColumns, comparatorSymbol, covenantFact, covenantNumber, creditAmount, creditCurrencies, creditMaturityRows, creditPercent, factValue, fieldLabel,
  instrumentOutstanding, isClosed, maturityShares, NO_VALUE, outstandingText, screenSignal, sentence } from "./model";

/** A column the text report leaves out: the exports keep it, for ids and figures a spreadsheet reads whole. */
type ExportColumn = HeadlessPaneColumn & { exportOnly?: boolean };
type Section = Extract<HeadlessBundleSection, { rows: HeadlessPaneRow[] }>;

const blank = (text: string) => text === NO_VALUE ? null : text;
const name = (obligor: CreditObligor | null | undefined) => obligor?.name ?? null;
const number = (value: unknown) => typeof value === "number" ? value : null;
const wide = (key: string, header: string, extra: Partial<HeadlessPaneColumn> = {}): ExportColumn => ({ key, header, shrink: true, minWidth: 16, ...extra });
const OBLIGOR: ExportColumn = { key: "obligor", header: "Obligor", minWidth: 16 };
const INSTRUMENT_ID: ExportColumn = { key: "instrumentId", header: "Instrument ID", stackPriority: 9 };

/**
 * A table of flat records: the exports keep every column; the text report
 * prints the pane's, and leaves out the obligor when the filing names none.
 */
function table(title: string, columns: readonly ExportColumn[], rows: HeadlessPaneRow[], { textKeys, empty }: { textKeys?: readonly string[]; empty?: string } = {}): Section {
  const named = rows.some((row) => row.obligor != null);
  const plain = (column: ExportColumn): HeadlessPaneColumn => { const { exportOnly: _, ...rest } = column; return rest; };
  return { title, columns: columns.map(plain), rows,
    textColumns: columns.filter((column) => !column.exportOnly && (column.key !== "obligor" || named) && (!textKeys || textKeys.includes(column.key))).map(plain),
    ...(empty ? { empty } : {}) };
}

const CAPITAL: ExportColumn[] = [
  { key: "name", header: "Instrument", minWidth: 20, textFormat: (value, row) => isClosed({ lifecycle: row.lifecycle as string | null }) ? `${value} (${row.lifecycle})` : String(value) },
  { key: "lifecycle", header: "Status", exportOnly: true },
  { key: "facilityType", header: "Type", format: (value) => value ? fieldLabel(String(value)) : NO_VALUE },
  { key: "coupon", header: "Coupon/Margin" },
  { key: "maturity", header: "Maturity" },
  { key: "outstanding", header: "Outstanding", align: "right", textFormat: (value, row) => outstandingText(number(value), number(row.commitment)) },
  { key: "commitment", header: "Commitment", align: "right", exportOnly: true },
  { key: "currency", header: "CCY" },
  { key: "ranking", header: "Rank", minWidth: 12 },
  { key: "controlPut", header: "CoC put", align: "right" },
  OBLIGOR,
  INSTRUMENT_ID,
];
/** The pane's capital column behind each export column; the others are not in the pane's own list. */
const PANE_COLUMN: Record<string, string> = { name: "name", facilityType: "facility", coupon: "coupon", maturity: "maturity", outstanding: "principal", currency: "currency", ranking: "ranking", controlPut: "control" };

function capitalRows(data: CreditDocumentsPayload, instruments: readonly CreditInstrument[]): HeadlessPaneRow[] {
  return instruments.map((row) => ({
    name: row.name, lifecycle: row.lifecycle ?? null, facilityType: row.facilityType,
    coupon: blank(capitalCell(row, "coupon", data)), maturity: row.maturity, outstanding: instrumentOutstanding(row), commitment: row.commitment,
    currency: row.currency, ranking: blank(capitalCell(row, "ranking", data)), controlPut: blank(capitalCell(row, "control", data)),
    obligor: name(row.obligor), instrumentId: row.id,
  }));
}
/** The instruments as the Capital tab lists them; a column the pane leaves out as undisclosed stays out of the text report. */
export function capitalSection(data: CreditDocumentsPayload, title = "Capital structure", instruments: readonly CreditInstrument[] = data.instruments): Section {
  const shown = new Set(capitalColumns(data, Number.MAX_SAFE_INTEGER).map((column) => column.id));
  return table(title, CAPITAL, capitalRows(data, instruments), { textKeys: CAPITAL.map((column) => column.key).filter((key) => !(key in PANE_COLUMN) || shown.has(PANE_COLUMN[key]!)) });
}

/** The unit a covenant row's figures are in, read from the fact its columns carry. */
const figureUnit = (row: HeadlessPaneRow) => ({ unit: typeof row.unit === "string" ? row.unit : null, currency: typeof row.currency === "string" ? row.currency : null });
const COVENANTS: ExportColumn[] = [
  wide("metric", "Covenant"),
  { key: "threshold", header: "Limit", align: "right", textFormat: (value, row) => `${comparatorSymbol(row.comparator as string, row.inclusive as boolean | null ?? undefined)} ${covenantNumber(number(value), figureUnit(row))}` },
  { key: "comparator", header: "Comparator", exportOnly: true },
  { key: "inclusive", header: "Inclusive", exportOnly: true },
  { key: "unit", header: "Unit", exportOnly: true },
  { key: "currency", header: "CCY", exportOnly: true },
  { key: "current", header: "Reported", align: "right", textFormat: (value, row) => covenantNumber(number(value), figureUnit(row)) },
  { key: "headroomPercent", header: "Headroom", align: "right", format: (value) => creditPercent(number(value)) },
  { key: "status", header: "Status", format: (value) => fieldLabel(String(value)) },
  { key: "asOf", header: "As of" },
  { key: "testDate", header: "Test date", exportOnly: true },
  wide("instrument", "Instrument"),
  OBLIGOR,
  { key: "reason", header: "Reason", underRow: true },
  { key: "id", header: "Covenant ID", exportOnly: true },
  { key: "instrumentId", header: "Instrument ID", exportOnly: true },
];
export function covenantSection(data: CreditDocumentsPayload): Section {
  return table("Covenants", COVENANTS, data.covenants.map((row) => {
    const fact = covenantFact(data, row);
    return { metric: sentence(row.metric), threshold: row.threshold, comparator: row.comparator, inclusive: row.inclusive ?? null, unit: fact?.unit ?? null, currency: fact?.currency ?? null,
      current: row.current, headroomPercent: row.headroomPercent, status: row.status, asOf: row.asOf, testDate: row.testDate, instrument: row.instrumentName,
      obligor: name(row.obligor), reason: row.reason, id: row.id, instrumentId: row.instrumentId };
  }));
}

function maturityColumns(preview: boolean): ExportColumn[] {
  return [
    { key: "year", header: "Year" },
    { key: "currency", header: "CCY" },
    { key: "principal", header: "Principal", align: "right", textFormat: (value) => creditAmount(number(value)) },
    ...preview ? [] : [
      { key: "share", header: "Share", align: "right", format: (value: unknown) => creditPercent(number(value)) } as ExportColumn,
      { key: "cumulative", header: "Cumulative", align: "right", format: (value: unknown) => creditPercent(number(value)) } as ExportColumn,
    ],
    wide("instrument", "Instrument"),
    OBLIGOR,
    INSTRUMENT_ID,
  ];
}
/** One row per instrument and year, in each currency: wall currencies are never added together. A preview wall is partial, so it has no shares. */
export function maturitySection(data: CreditDocumentsPayload): Section {
  const preview = data.access === "preview";
  const rows = creditCurrencies(data).flatMap((currency) => {
    const buckets = creditMaturityRows(data, currency), shares = preview ? new Map() : maturityShares(buckets);
    return buckets.flatMap((bucket) => bucket.instruments.map((instrument) => {
      const share = shares.get(`${bucket.year}:${instrument.id}`);
      return { year: bucket.year, currency, principal: instrument.principal, ...preview ? {} : { share: share?.share ?? null, cumulative: share?.cumulative ?? null },
        instrument: instrument.name, obligor: name(bucket.obligor), instrumentId: instrument.id };
    }));
  });
  return table("Maturity wall", maturityColumns(preview), rows);
}

const CONTROL: ExportColumn[] = [
  wide("instrument", "Instrument", { minWidth: 20 }),
  { key: "putPercent", header: "Put", align: "right", format: (value) => value == null ? "" : `${value}%` },
  { key: "principal", header: "Principal", align: "right", textFormat: (value) => creditAmount(number(value)) },
  { key: "currency", header: "CCY" },
  wide("trigger", "Trigger", { minWidth: 24 }),
  OBLIGOR,
  INSTRUMENT_ID,
];
export function controlSection(data: CreditDocumentsPayload): Section {
  return table("Change of control", CONTROL, data.changeOfControl.map((row) => ({ instrument: row.instrumentName, putPercent: row.putPercent, principal: row.principal,
    currency: row.currency, trigger: row.trigger, obligor: name(row.obligor), instrumentId: row.instrumentId })));
}

const SCREEN: ExportColumn[] = [
  { key: "symbol", header: "Issuer" },
  { key: "signal", header: "Signal" },
  { key: "headroomPercent", header: "Headroom", align: "right", format: (value) => creditPercent(number(value)) },
  { key: "date", header: "Date" },
  wide("instrument", "Instrument", { minWidth: 20 }),
  wide("condition", "Condition", { minWidth: 24 }),
  { key: "currency", header: "CCY", exportOnly: true },
  INSTRUMENT_ID,
];
/** The risk screen's signals as the Screen tab lists them; the evidence behind each stays behind `--instrument`. */
export function screenSection(data: CreditScreenPayload): Section {
  return table("Credit risk screen", SCREEN, data.rows.map((row) => ({ symbol: row.symbol, signal: screenSignal(row), headroomPercent: row.value, date: row.date, instrument: row.instrumentName,
    condition: sentence(row.reason), currency: row.currency, instrumentId: row.instrumentId })));
}

const FACTS: ExportColumn[] = [
  wide("term", "Term", { shrink: false }),
  wide("value", "Disclosed value", { minWidth: 24 }),
  { key: "amount", header: "Amount", exportOnly: true, align: "right" },
  { key: "unit", header: "Unit", exportOnly: true },
  { key: "asOf", header: "As of" },
  { key: "filedAt", header: "Filed" },
  { key: "status", header: "Revision", format: (value) => fieldLabel(String(value)) },
  { key: "form", header: "Form", exportOnly: true },
  { key: "confidence", header: "Confidence", exportOnly: true, align: "right" },
  { key: "filingUrl", header: "Filing URL", exportOnly: true },
  { key: "id", header: "Fact ID", exportOnly: true },
  // The filing's own words belong to the instrument view; the text report prints them under their term.
  { key: "quote", header: "Filing text", underRow: true },
];
const factRow = (fact: CreditFact): HeadlessPaneRow => ({ term: fieldLabel(fact.field), value: factValue(fact), amount: number(fact.value), unit: fact.currency ?? fact.unit, asOf: fact.asOf, filedAt: fact.filedAt, status: fact.status,
  form: fact.form, confidence: fact.confidence, filingUrl: fact.filingUrl, id: fact.id, quote: fact.quote });
/** An instrument's terms and amendments, each with the filing text behind it. Current terms are all in effect, so only the history names the revision. */
export function instrumentSections(data: CreditDocumentsPayload, instrument: CreditInstrument): Section[] {
  const byTerm = (a: CreditFact, b: CreditFact) => a.field.localeCompare(b.field) || a.factKey.localeCompare(b.factKey);
  const history = [...instrument.history ?? []].sort((a, b) => b.filedAt.localeCompare(a.filedAt) || a.field.localeCompare(b.field));
  return [
    capitalSection(data, instrument.name, [instrument]),
    table("Current terms", FACTS, [...instrument.facts].sort(byTerm).map(factRow), { textKeys: FACTS.map((column) => column.key).filter((key) => key !== "status") }),
    table("Amendment history", FACTS, history.map(factRow)),
  ];
}
