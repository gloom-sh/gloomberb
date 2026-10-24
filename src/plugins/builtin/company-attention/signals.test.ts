import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import type { HiringCompanySignals, HiringSignalsBoard } from "../../../api-client/hiring";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { fetchSignals, validateSignals } from "./client";
import { attentionHeadless } from "./headless";
import { attentionPaneTabs } from "./model";
import { companySignalsModel, signalFacts, signalsBoardModel, signalsNumber, signalsPreviewNote } from "./signals-model";
import realExpansion from "./fixtures/hiring-expansion-board.json";
import realAnomalies from "./fixtures/hiring-anomalies-board.json";
import realStt from "./fixtures/hiring-signals-stt.json";
import realJbht from "./fixtures/hiring-signals-jbht.json";
import realHiring from "./fixtures/hiring.json";
import realMovesBoard from "./fixtures/hiring-moves-board.json";
import type { HiringPayload } from "../../../api-client/hiring";

const expansion = () => structuredClone(realExpansion) as HiringSignalsBoard;
const anomalies = () => structuredClone(realAnomalies) as HiringSignalsBoard;
const stt = () => structuredClone(realStt) as HiringCompanySignals;
const jbht = () => structuredClone(realJbht) as HiringCompanySignals;
const movesBoard = async () => structuredClone(realMovesBoard);
const emptyBoard = { generatedAt: "2026-10-15T00:00:00.000Z", proRequired: true, preview: false, total: 0, locked: 0, companies: [] };
const noMoves = async (symbol?: string) => ({ generatedAt: "2026-10-19T08:00:00.000Z", proRequired: true, preview: false, symbol: symbol ?? "", name: null, latest: null, week: null, weeks: [], history: [],
  evidence: { added: [], closed: [] }, evidenceTotals: { added: 0, closed: 0 }, locked: { history: 0, added: 0, closed: 0 } });

test("HIRE has Expansion and Anomalies tabs after Moves, on the board and on a company", () => {
  expect(attentionPaneTabs("hiring", null)).toEqual(["table", "moves", "expansion", "anomalies", "building"]);
  expect(attentionPaneTabs("hiring", "STT")).toEqual(["table", "chart", "mix", "peers", "evidence", "moves", "expansion", "anomalies", "building"]);
  expect(attentionPaneTabs("apps", "META")).not.toContain("expansion");
});

test("the Expansion board lists firsts with how far back never goes, and leaves spike columns out", () => {
  const model = signalsBoardModel(expansion(), "all");
  const board = model.sections.board!;
  // JBHT's first roles in Mexico: none of its 703 earlier postings, read since Sep 18, was there.
  expect(board.rows[0]!.values).toMatchObject({ symbol: "JBHT", kind: "New country", label: "Mexico", country: "MX", newRoles: 7, titles: 6, prior: 703, since: "Sep 18" });
  expect(board.rows.map((row) => row.values.kind)).toEqual([...Array(8).fill("New country"), ...Array(8).fill("New city")]);
  expect(board.columns.map((column) => column.id)).toEqual(["symbol", "name", "kind", "label", "newRoles", "titles", "prior", "since", "title"]);
  expect(model.figures.map((figure) => [figure.label, figure.value])).toEqual([["New countries", "8"], ["New cities", "26"], ["Measured", "1,618"], ["First seen since", "Sep 17"], ["Held", "508"]]);
  expect(signalsBoardModel({ ...expansion(), signals: [], total: 0, filter: "new_city" }, "new_city").sections.board!.empty).toBe("None of this kind this week.");
  expect(signalsBoardModel({ ...expansion(), week: null, signals: [] }, "all").sections.board!.empty).toBe("No week has been computed yet.");
});

test("a first's detail says why and gives every number behind it", () => {
  const signal = jbht().signals[0]!;
  expect(signal.why).toContain("the first seen there since Sep 18, 2026: none of the 703 postings");
  expect(signalFacts(signal)).toEqual(expect.arrayContaining([
    { label: "New roles", value: "7 under 6 titles, week of Oct 12, 2026" },
    { label: "First seen since", value: "Sep 18, 2026, none of 703 earlier postings (98% placed)" },
    { label: "Cities", value: "Querétaro, MX (7)" },
  ]));
  expect(signalFacts(signal).some((fact) => fact.label === "Average before")).toBe(false);
});

test("the Anomalies board shows paces against each company's own weeks, flagged spikes last with what to check", () => {
  const board = signalsBoardModel(anomalies(), "all").sections.board!;
  expect(board.rows[0]!.values).toMatchObject({ symbol: "RIVN", kind: "Family spike", label: "Operations", newRoles: 222 });
  expect(signalsNumber("pace", board.rows[1]!.values.pace as number)).toBe("16x");
  expect(signalsNumber("z", board.rows[1]!.values.z as number)).toBe("+19.2");
  expect(signalsNumber("mean", board.rows[1]!.values.mean as number)).toBe("5.3");
  // A family has no country to flag.
  expect(board.rows[0]!.values.country).toBeNull();
  expect(board.rows.slice(-3).map((row) => [row.symbol, row.values.check])).toEqual([["DNOW", "Few reads"], ["PAHC", "Few reads"], ["J", "Few reads"]]);
  expect(board.columns.at(-1)!.id).toBe("check");
  expect(signalFacts(board.rows.at(-1)!.signal!)).toEqual(expect.arrayContaining([{ label: "Check", value: "Few reads, 3 reads that week" }]));
  const unflagged = signalsBoardModel({ ...anomalies(), signals: anomalies().signals.slice(0, 3) }, "all").sections.board!;
  expect(unflagged.columns.some((column) => column.id === "check")).toBe(false);
});

test("a company's spike lists its weeks before, and its postings link to the employer's page", () => {
  const model = companySignalsModel(stt(), "anomalies");
  const row = model.sections.signals!.rows[0]!;
  expect(row.values).toMatchObject({ week: "2026-10-12", kind: "Place spike", label: "Hangzhou, CN", newRoles: 83 });
  expect(signalFacts(row.signal!)).toEqual(expect.arrayContaining([
    { label: "Average before", value: "5.3 a week over 3 measured weeks: 9, 2, 5" },
    { label: "Pace", value: "16x its average, z +19.2" },
    { label: "Company pace", value: "1.3x, its roles placed in a city" },
  ]));
  const postings = model.sections.postings!.rows;
  expect(postings).toHaveLength(8);
  expect(postings[0]!.url).toStartWith("https://statestreet.wd1.myworkdayjobs.com/");
  expect(postings[0]!.values.signal).toBe("Place spike: Hangzhou, CN");
  // STT posted no first this week.
  expect(companySignalsModel(stt(), "expansion").sections.signals!).toMatchObject({ rows: [], empty: "No first in a new country or city this week." });
});

test("a free company read counts what each tab holds back, and a held week says why it gives none", () => {
  const free: HiringCompanySignals = { ...stt(), preview: true, signals: [], history: [], locked: { signals: 1, history: 0, expansion: 0, anomalies: 1 } };
  const anomaly = companySignalsModel(free, "anomalies");
  expect(anomaly.sections.signals).toMatchObject({ locked: 1, empty: "This company's anomaly signals are in Pro." });
  expect(anomaly.figures.find((figure) => figure.label === "In Pro")?.value).toBe("1");
  expect(companySignalsModel(free, "expansion").sections.signals).toMatchObject({ locked: 0, empty: "No first in a new country or city this week." });
  // A server that does not count by tab: both tabs show the whole count.
  const older = { ...free, locked: { signals: 1, history: 2 } };
  expect(companySignalsModel(older, "expansion").sections.signals!.locked).toBe(3);
  expect(signalsPreviewNote(older)).toBe("Free shows the signals the free boards show. Gloom Pro adds 1 signal and 2 earlier signals.");

  const held = companySignalsModel({ ...stt(), signals: [], held: "recounted" }, "expansion");
  expect(held.held).toBe("Postings well above its new roles (re-listed roles)");
  expect(held.sections.signals!.empty).toBe("No signal this week: postings well above its new roles (re-listed roles).");
  const skipped = companySignalsModel({ ...stt(), signals: [], skipped: ["thin_history", "posted_before_watch"] }, "expansion");
  expect(skipped.figures.at(-1)).toMatchObject({ label: "Not looked for", value: "Under 6 weeks of reads or 100 earlier postings, Roles dated before its first read" });
  // A spelling of a known city and a one-day batch say so.
  const dropped = companySignalsModel({ ...stt(), signals: [], skipped: ["similar_city", "one_day"] }, "anomalies");
  expect(dropped.figures.at(-1)).toMatchObject({ label: "Not looked for", value: "A new city named like a known one, A spike mostly posted on one day" });
});

test("a free board is the group's first three whatever kind was asked, and says so", () => {
  const free: HiringSignalsBoard = { ...expansion(), preview: true, signals: expansion().signals.slice(0, 3), locked: 31 };
  expect(signalsBoardModel(free, "new_city").sections.board!.locked).toBe(31);
  expect(signalsPreviewNote(free)).toBe("Free shows 3 of 34 expansion signals. Gloom Pro adds the other 31 and every posting behind them.");
  expect(signalsPreviewNote(free, "new_city")).toContain("3 of 34 expansion signals: the preview can't filter by kind");
  expect(signalsPreviewNote(expansion())).toBeNull();
});

test("signals reads reject another company's or another tab's payload and malformed numbers", async () => {
  const client = { getCloudHiringSignals: async () => anomalies(), getCloudHiringCompanySignals: async () => stt() };
  await expect(fetchSignals("expansion", undefined, {}, client)).rejects.toThrow("another tab's signals");
  await expect(fetchSignals("anomalies", "JBHT", {}, client)).rejects.toThrow("different company");
  const broken = stt();
  broken.signals[0]!.newRoles = -1;
  expect(() => validateSignals(broken)).toThrow("unreadable hiring signals");
  const asked: unknown[] = [];
  await fetchSignals("expansion", undefined, { filter: "new_city", offset: 100 }, { ...client, getCloudHiringSignals: async (group, query) => { asked.push(group, query); return expansion(); } });
  expect(asked).toEqual(["expansion", { limit: undefined, offset: 100, kind: "new_city" }]);
  await expect(fetchSignals("expansion", undefined, {}, { ...client, getCloudHiringSignals: async () => { throw new ApiRequestError("Not found", 404); } })).rejects.toThrow("Hiring signals are not available yet.");
});

test("a HIRE report has Expansion and Anomalies: each signal with why, a company's postings, and a server without signals keeps the rest", async () => {
  const hiring = { ...structuredClone(realHiring), symbol: "STT" } as HiringPayload;
  const company = await attentionHeadless("hiring").load(createTestHeadlessArgs({ symbols: ["STT"] }),
    createTestHeadlessContext({ apiClient: { getCloudHiring: async () => hiring, getCloudHiringMoves: noMoves, getCloudHiringCompanySignals: async () => stt() } as never }));
  expect(company.sections.map((section) => section.title).slice(-3)).toEqual(["Expansion", "Anomalies", "Anomalies postings"]);
  const spike = company.sections.find((section) => section.title === "Anomalies")!;
  expect(spike.rows![0]).toMatchObject({ label: "Hangzhou, CN", newRoles: 83, why: realStt.signals[0]!.why });
  expect(spike.columns!.find((column) => column.key === "pace")?.format?.(spike.rows![0]!.pace, spike.rows![0]!)).toBe("16x");
  expect(company.sections.find((section) => section.title === "Anomalies postings")!.rows![0]!.sourceUrl).toStartWith("https://statestreet.");

  const asked: unknown[] = [];
  const market = await attentionHeadless("hiring").load(createTestHeadlessArgs({ options: { kind: "new_city" } }), createTestHeadlessContext({ apiClient: { getCloudHiring: async () => emptyBoard, getCloudHiringMoves: movesBoard,
    getCloudHiringSignals: async (group: string, query: { kind?: string }) => { asked.push([group, query.kind]); return group === "expansion" ? expansion() : anomalies(); } } as never }));
  // The kind applies to the tab it belongs to; the other lists all.
  expect(asked).toEqual([["expansion", "new_city"], ["anomalies", "all"]]);
  expect(market.sections.map((section) => section.title)).toEqual(["Companies hiring", "Hiring moves", "Expansion", "Anomalies"]);
  expect(market.sections.find((section) => section.title === "Expansion")!.rows![0]).toMatchObject({ symbol: "JBHT", why: realJbht.signals[0]!.why });

  const free = await attentionHeadless("hiring").load(createTestHeadlessArgs(), createTestHeadlessContext({ apiClient: { getCloudHiring: async () => emptyBoard, getCloudHiringMoves: movesBoard,
    getCloudHiringSignals: async (group: string) => ({ ...(group === "expansion" ? expansion() : anomalies()), preview: true, signals: [], locked: group === "expansion" ? 34 : 94 }) } as never }));
  expect(free.errors).toEqual(["Free shows 0 of 34 expansion signals. Gloom Pro adds the other 34 and every posting behind them.", "Free shows 0 of 94 anomaly signals. Gloom Pro adds the other 94 and every posting behind them."]);

  const held = await attentionHeadless("hiring").load(createTestHeadlessArgs({ symbols: ["STT"] }),
    createTestHeadlessContext({ apiClient: { getCloudHiring: async () => hiring, getCloudHiringMoves: noMoves, getCloudHiringCompanySignals: async () => ({ ...stt(), signals: [], held: "short_watch" }) } as never }));
  expect(held.notes).toContain("No expansion or anomaly signal this week: read for under three weeks before it.");

  const missing = await attentionHeadless("hiring").load(createTestHeadlessArgs(), createTestHeadlessContext({ apiClient: { getCloudHiring: async () => emptyBoard, getCloudHiringMoves: movesBoard,
    getCloudHiringSignals: async () => { throw new ApiRequestError("Not found", 404); } } as never }));
  expect(missing.sections.map((section) => section.title)).toEqual(["Companies hiring", "Hiring moves"]);
  expect(missing.notes).toContain("Hiring signals are not available yet.");
});
