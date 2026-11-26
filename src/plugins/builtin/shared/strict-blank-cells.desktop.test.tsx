/** @jsxImportSource react */
import { expect, test } from "bun:test";
import type { CloudEarningsCallPayload } from "../../../api-client";
import type { IpoDeal } from "../../../api-client/ipo";
import type { MnaDeal } from "../../../api-client/mna";
import type { DataTableCell, DataTableColumn } from "../../../components";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { captureStrictTable } from "../../../test-support/strict-table-capture";
import { colors } from "../../../theme/colors";
import type { BrokerExecution } from "../../../types/trading";
import type { FiredAlert } from "../alerts/fired-log";
import type { AlertHistoryItem } from "../alerts/history";
import { alertHistoryCell, alertHistoryColumns, alertHistoryLine } from "../alerts/history-pane";
import { mergeAlertHistory } from "../alerts/history-rows";
import { activityColumns, renderExecutionCell } from "../broker-trading/orders";
import { calendarCallCell, calendarColumns } from "../earnings-calls/calendar";
import { callListCell, callListColumns } from "../earnings-calls/pane";
import { econFigureCell } from "../econ/calendar-model";
import type { EconEvent } from "../econ/types";
import { buildIpoColumns } from "../ipo-calendar/model";
import { ipoPriceCell } from "../ipo-calendar/pane";
import { ipoDeal } from "../ipo-calendar/test-fixture";
import type { DealSpread } from "../mna/model";
import { mnaColumns, mnaDealCell } from "../mna/pane";

// Each pane's own cells, drawn in the kit's table on the desktop renderer and read back the way a strict capture
// reads them. A column-wide exemption passed every one of the failing captures below.
const { render } = createDomTestHarness();
const NOW = Date.parse("2026-11-25T15:00:00Z");
const strict = <T, C extends DataTableColumn>(columns: C[], items: T[], cell: (item: T, column: C) => DataTableCell) =>
  captureStrictTable(render, columns, items, cell);
const blank = (...columns: string[]) => ({
  usable: false,
  blankColumns: columns,
  unusableReason: columns.length === 1
    ? `The ${columns[0]} column is blank in every row.`
    : `The ${columns.slice(0, -1).join(", ")} and ${columns.at(-1)} columns are blank in every row.`,
});
const USABLE = { usable: true, unusableReason: null };
const times = <T,>(count: number, make: (index: number) => T) => Array.from({ length: count }, (_, index) => make(index));

test("ECO fails on FORECAST and PRIOR when the figure rows have none, and not for a speech, a row past the listing or a zero", async () => {
  const columns: DataTableColumn[] = [
    { id: "event", label: "EVENT", width: 20, align: "left" },
    { id: "actual", label: "ACTUAL", width: 9, align: "right" },
    { id: "forecast", label: "FORECAST", width: 10, align: "right" },
    { id: "prior", label: "PRIOR", width: 9, align: "right" },
  ];
  const event = (index: number, overrides: Partial<EconEvent>): EconEvent => ({
    id: `e${index}`, date: new Date(NOW - 3 * 3_600_000), time: "12:00", country: "US", event: `Release ${index}`,
    actual: "0.3%", forecast: "0.2%", prior: "0.4%", impact: "high", ...overrides,
  });
  const read = (events: EconEvent[]) => strict(columns, events, (row, column) => (
    column.id === "event" ? { text: row.event } : econFigureCell(column.id as "actual" | "forecast" | "prior", row, NOW, events)
  ));
  const noConsensus = times(3, (index) => event(index, { forecast: null }));
  const firstRelease = times(3, (index) => event(index, { prior: null }));
  // A speech prints no figure, and a row past the listing's end has no feed with a consensus yet.
  const speeches = times(4, (index) => event(10 + index, { actual: null, forecast: null, prior: null }));
  const pastListing = times(4, (index) => event(20 + index, { date: new Date(NOW + 40 * 86_400_000), actual: null, forecast: null, prior: "4.50%", pastListing: true }));

  expect(await read(noConsensus)).toMatchObject(blank("FORECAST"));
  expect(await read(firstRelease)).toMatchObject(blank("PRIOR"));
  expect(await read([...speeches, ...pastListing])).toMatchObject(USABLE);
  // The rows that owe a figure decide it, however many beside them owe none.
  expect(await read([...noConsensus, ...speeches, ...pastListing])).toMatchObject(blank("FORECAST"));
  expect(await read([...noConsensus.slice(1), event(9, {}), ...speeches])).toMatchObject(USABLE);
  // Two rows are a short list's gaps, as before.
  expect(await read([...noConsensus.slice(1), ...speeches])).toMatchObject(USABLE);
  // A figure of zero is a figure.
  expect(await read(times(3, (index) => event(index, { actual: "0", forecast: "0%", prior: "0.0%" })))).toMatchObject(USABLE);
});

const call = (index: number, overrides: Partial<CloudEarningsCallPayload>): CloudEarningsCallPayload => ({
  id: `c${index}`, ticker: `T${index}`, companyName: `Company ${index}`, fiscalYear: 2026, fiscalQuarter: 4,
  callAt: "2026-11-20T21:30:00Z", status: "ready", durationSeconds: 3_600, wordCount: 9_000, hasTranscript: true, sentiment: 0.2,
  callTimeKnown: true, eventKind: "earnings", eventLabel: null, ...overrides,
});

test("CALLS fails on PERIOD for earnings calls with none, beside labelled events too, on LENGTH where the list keeps it, and not for events or calls still to come", async () => {
  const read = (calls: CloudEarningsCallPayload[]) => strict(callListColumns(100, true), calls, (row, column) => callListCell(row, column, NOW));
  const lost = times(3, (index) => call(index, { fiscalYear: null, fiscalQuarter: null, durationSeconds: null }));
  // An event that is not an earnings call has no fiscal period, and a call with no transcript has no recording yet.
  const unlabelled = times(4, (index) => call(10 + index, {
    eventKind: "other", fiscalYear: null, fiscalQuarter: null, hasTranscript: false, durationSeconds: null, callAt: "2026-12-03T21:30:00Z", status: "scheduled",
  }));
  // An analyst call after the results call reads "Analyst" under PERIOD: a label, and no period.
  const analyst = times(3, (index) => call(20 + index, { eventKind: "other", eventLabel: "analyst call", fiscalYear: null, fiscalQuarter: null }));
  // A call whose kind is unclear is not thereby an event: its missing period is still owed.
  const unclear = times(3, (index) => call(30 + index, { eventKind: null, fiscalYear: null, fiscalQuarter: null }));

  // A length no call states leaves the list, so the period alone is named.
  expect(await read(lost)).toMatchObject(blank("PERIOD"));
  expect(await read(unlabelled)).toMatchObject(USABLE);
  expect(await read([...lost, ...unlabelled])).toMatchObject(blank("PERIOD"));
  // A recording not yet transcribed keeps the column in the list, and its length is none for the transcribed calls beside it.
  expect(await read([...lost, call(40, { hasTranscript: false, status: "processing", durationSeconds: 1_800 })])).toMatchObject(blank("LENGTH"));
  expect(await read(analyst)).toMatchObject(USABLE);
  // The label fills no period for the earnings calls beside it, whose own are still lost. Each analyst call has its length.
  expect(await read([...lost, ...analyst])).toMatchObject(blank("PERIOD"));
  expect(await read(unclear)).toMatchObject(blank("PERIOD"));
  expect(await read([...lost.slice(1), call(9, {}), ...unlabelled, ...analyst])).toMatchObject(USABLE);
});

test("the calls calendar fails on LOCAL and ET for calls with no day, and not for calls known by their day alone", async () => {
  const read = (calls: CloudEarningsCallPayload[]) => (
    strict(calendarColumns(120, { localClock: true }), calls, (row, column) => calendarCallCell(row, column, NOW))
  );
  const upcoming = { hasTranscript: false, durationSeconds: null, status: "scheduled" };
  const dayAlone = times(4, (index) => call(index, { ...upcoming, callAt: "2026-12-03T00:00:00Z", callTimeKnown: false }));
  const noDay = times(3, (index) => call(10 + index, { ...upcoming, callAt: null, callTimeKnown: undefined }));

  expect(await read(dayAlone)).toMatchObject(USABLE);
  expect(await read(noDay)).toMatchObject(blank("LOCAL", "ET"));
  expect(await read([...noDay, ...dayAlone])).toMatchObject(blank("LOCAL", "ET"));
  expect(await read([...noDay, call(20, { ...upcoming, callAt: "2026-12-03T21:30:00Z" })])).toMatchObject(USABLE);
});

const deal = (index: number, overrides: Partial<MnaDeal>): MnaDeal => ({
  id: `d${index}`,
  target: { name: `Target ${index}`, symbol: `T${index}`, country: "US" },
  acquirer: { name: `Acquirer ${index}`, symbol: `A${index}`, country: "US" },
  status: "pending", stage: "Tender offer", hostile: false,
  terms: { consideration: "cash", cashPerShare: 10.5, exchangeRatio: null, ratioSymbol: null, currency: "USD", cvr: false, partial: false },
  value: 1.78e9, valueCurrency: "USD", valueUsd: 1.78e9,
  announced: "2026-09-10", expectedClose: "2027-02-15", closed: null,
  headline: "", updatedAt: "2026-11-20T00:00:00Z", lastReported: "2026-11-20", stale: false,
  ...overrides,
});
const undisclosed: MnaDeal["terms"] = { consideration: "undisclosed", cashPerShare: null, exchangeRatio: null, ratioSymbol: null, currency: null, cvr: false, partial: false };

test("MA fails on TERMS, VALUE and CLOSE for agreed deals with none, on the spread for priced deals with no quote, and not for talks", async () => {
  const read = (deals: MnaDeal[], spread: (deal: MnaDeal) => DealSpread | null = () => null) => (
    strict(mnaColumns("pending", 200), deals, (row, column) => mnaDealCell(row, column, spread(row), colors, false, NOW))
  );
  const bare = { terms: undisclosed, value: null, valueCurrency: null, valueUsd: null, expectedClose: null };
  const agreed = times(3, (index) => deal(index, bare));
  const talks = times(4, (index) => deal(10 + index, { ...bare, status: "talks", stage: null }));

  // An agreed deal with no per-share terms has no spread to read: only what it owes is named.
  expect(await read(agreed)).toMatchObject(blank("TERMS", "VALUE", "CLOSE"));
  expect(await read(talks)).toMatchObject(USABLE);
  expect(await read([...agreed, ...talks])).toMatchObject(blank("TERMS", "VALUE", "CLOSE"));
  // One agreed deal with its terms fills the three columns, and its lone missing spread is a short list's gap.
  expect(await read([...agreed.slice(1), deal(9, {}), ...talks])).toMatchObject(USABLE);

  // Per-share terms on a listed target owe a spread, so a missing quote is named.
  const priced = times(3, (index) => deal(20 + index, {}));
  expect(await read(priced)).toMatchObject(blank("PRICE", "SPREAD", "ANN.", "AS OF"));
  const at = (spread: number, annualized: number | null): DealSpread => ({
    offer: 10.5, price: 10.5 / (1 + spread), spread, annualized, basis: { kind: "close", session: "2026-11-24" }, latest: null, legs: [],
  });
  const partial = (row: MnaDeal): MnaDeal => ({ ...row, terms: { ...row.terms, partial: true } });
  const closing = (row: MnaDeal): MnaDeal => ({ ...row, expectedClose: "2026-11-26" });
  // A spread of zero is a figure, and has no annual return to state; neither has a partial offer's.
  expect(await read(priced, () => at(0, null))).toMatchObject(USABLE);
  expect(await read(priced.map(partial), () => at(0.02, null))).toMatchObject(USABLE);
  // A positive spread with no close date to annualize to follows the CLOSE it owes.
  expect(await read(priced.map((row) => ({ ...row, expectedClose: null })), () => at(0.02, null))).toMatchObject(blank("ANN.", "CLOSE"));
  // A positive spread on a close months out has an annual return, so its blank is a lost figure however well the date reads.
  expect(await read(priced, () => at(0.02, null))).toMatchObject(blank("ANN."));
  // Less than a day from the close there is none to state.
  expect(await read(priced.map(closing), () => at(0.02, null))).toMatchObject(USABLE);

  // The deal says both of those itself, so they hold with no quote: three such offers the list has no price for owe no
  // ANN. beside a quoted one that has none either, and that one fills the columns a quote gives.
  const mixed = [...priced, deal(30, {})];
  const lastQuoted = (spread: DealSpread) => (row: MnaDeal) => (row.id === "d30" ? spread : null);
  for (const excluded of [partial, closing]) {
    expect(await read(mixed.map(excluded), lastQuoted(at(0.02, null)))).toMatchObject(USABLE);
  }
  // A full offer months from its close owes one, with a quote or without: the quoted row's flat spread is no figure for it.
  expect(await read(mixed, lastQuoted(at(0, null)))).toMatchObject(blank("ANN."));
});

test("an IPO list fails on PRICE for priced and listed offerings with none, and not for deals yet to price", async () => {
  const columns = buildIpoColumns(200, 10, "listed");
  const read = (deals: IpoDeal[]) => strict(columns, deals, (row, column) => (
    column.id === "price" ? ipoPriceCell(row, colors) : { text: column.id === "size" || column.id === "return" ? "1" : row.company }
  ));
  const listed = times(3, (index) => ipoDeal({ id: `listed-${index}`, status: "listed" }));
  const upcoming = times(4, (index) => ipoDeal({ id: `upcoming-${index}`, status: "upcoming" }));
  const introduced = times(3, (index) => ipoDeal({ id: `intro-${index}`, status: "listed", listingType: "introduction" }));

  expect(await read(listed)).toMatchObject(blank("PRICE"));
  expect(await read([...upcoming, ...introduced])).toMatchObject(USABLE);
  expect(await read([...listed, ...upcoming])).toMatchObject(blank("PRICE"));
  expect(await read([...listed.slice(1), ipoDeal({ id: "priced", status: "priced", offerPrice: 18 }), ...upcoming])).toMatchObject(USABLE);
});

test("a broker's fills fail on Fees when no fill has a commission, and a commission of zero is a figure", async () => {
  const fill = (index: number, commission?: number): BrokerExecution => ({
    execId: `x${index}`, side: "BOT", shares: 10, price: 100, time: NOW - 60_000, contract: { brokerId: "demo", symbol: `T${index}` },
    ...(commission === undefined ? {} : { commission, commissionCurrency: "USD" }),
  });
  const read = (fills: BrokerExecution[]) => strict(activityColumns, fills, (row, column) => renderExecutionCell(row, column, NOW));

  expect(await read(times(3, (index) => fill(index)))).toMatchObject(blank("Fees"));
  expect(await read(times(3, (index) => fill(index, 0)))).toMatchObject(USABLE);
  expect(await read([fill(0), fill(1), fill(2, 1.25)])).toMatchObject(USABLE);
});

test("alert history fails on Value when the alerts fired on a figure have none, beside rule changes and dated events too, and not for those alone", async () => {
  const fired = (index: number, overrides: Partial<FiredAlert>): FiredAlert => ({
    id: `f${index}`, firedAt: new Date(NOW - index * 60_000).toISOString(), kind: "price", ruleId: `r${index}`, rule: `T${index} above 10`,
    value: 10.5, unit: "USD", quoteAt: new Date(NOW - index * 60_000 - 5_000).toISOString(), source: "real-time", symbol: `T${index}`, ...overrides,
  });
  const delivered = (index: number): AlertHistoryItem => ({
    id: `c${index}`, kind: "breaking_news", title: `Headline ${index}`, body: "", deliveredAt: new Date(NOW - 3_600_000 - index * 60_000).toISOString(),
  });
  const read = (log: FiredAlert[], cloud: AlertHistoryItem[] = []) => strict(
    alertHistoryColumns(160), mergeAlertHistory(log, cloud).map(alertHistoryLine), (row, column) => alertHistoryCell(row, column, false),
  );
  // The figure the app fired on, lost: a price, a move (the words beside it are no figure) and a valuation reading.
  const lost = [
    fired(0, { value: null }),
    fired(1, { kind: "move", value: null, unit: "%", detail: "since Tue close" }),
    fired(2, { kind: "pe", value: null, unit: "x" }),
  ];
  // Lines that owe none: a rule change, a dated event, and a delivery that carried a title alone.
  const unquoted = { value: null, unit: undefined, quoteAt: null, source: null };
  const changes = times(3, (index) => fired(10 + index, { ...unquoted, action: "created", detail: "Created" }));
  const events = times(3, (index) => fired(20 + index, { ...unquoted, kind: "earnings_date", detail: `T${index} reports tomorrow` }));
  const bare = times(4, delivered);

  expect(await read(lost)).toMatchObject(blank("Value"));
  expect(await read([...changes, ...events], bare)).toMatchObject(USABLE);
  expect(await read([], bare)).toMatchObject(USABLE);
  expect(await read(lost, bare)).toMatchObject(blank("Value"));
  // A rule change says "Created" under Value and a dated event what it announced: words, and no figure for the alerts beside them.
  expect(await read([...lost, ...changes])).toMatchObject(blank("Value"));
  expect(await read([...lost, ...changes, ...events], bare)).toMatchObject(blank("Value"));
  // One alert with its figure fills the column, and a move of zero is a figure.
  expect(await read([...lost.slice(1), fired(3, { kind: "move", value: 0, unit: "%" }), ...changes], bare)).toMatchObject(USABLE);
});
