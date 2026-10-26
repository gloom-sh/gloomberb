import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import type { HiringBuildingBoard, HiringCompanyBuilding } from "../../../api-client/hiring";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { buildingBoardModel, buildingNumber, buildingPreviewNote, companyBuildingModel, shiftFacts } from "./building-model";
import { fetchBuilding, validateBuilding } from "./client";
import { attentionHeadless } from "./headless";
import { attentionPaneTabs } from "./model";
import realBoard from "./fixtures/hiring-building-board.json";
import realGm from "./fixtures/hiring-building-gm.json";
import realHiring from "./fixtures/hiring.json";
import realMovesBoard from "./fixtures/hiring-moves-board.json";
import realExpansion from "./fixtures/hiring-expansion-board.json";
import realAnomalies from "./fixtures/hiring-anomalies-board.json";
import type { HiringPayload } from "../../../api-client/hiring";

const board = () => structuredClone(realBoard) as HiringBuildingBoard;
const gm = () => structuredClone(realGm) as HiringCompanyBuilding;
const emptyBoard = { generatedAt: "2026-10-15T00:00:00.000Z", proRequired: true, preview: false, total: 0, locked: 0, companies: [] };
const noMoves = async (symbol?: string) => ({ generatedAt: "2026-10-19T08:00:00.000Z", proRequired: true, preview: false, symbol: symbol ?? "", name: null, latest: null, week: null, weeks: [], history: [],
  evidence: { added: [], closed: [] }, evidenceTotals: { added: 0, closed: 0 }, locked: { history: 0, added: 0, closed: 0 } });
const noSignals = async (symbol: string) => ({ generatedAt: "2026-10-19T08:00:00.000Z", proRequired: true, preview: false, symbol, name: null, week: null, watchedSince: null, held: null, skipped: [], signals: [], history: [],
  locked: { signals: 0, history: 0, expansion: 0, anomalies: 0 } });

test("HIRE has a Building tab last, on the board and on a company", () => {
  expect(attentionPaneTabs("hiring", null)).toEqual(["table", "moves", "expansion", "anomalies", "building"]);
  expect(attentionPaneTabs("hiring", "GM").at(-1)).toBe("building");
  expect(attentionPaneTabs("apps", "META")).not.toContain("building");
});

test("the Building board lists each shift's share now against before, in points, with its weeks and top title", () => {
  const model = buildingBoardModel(board(), "all");
  const rows = model.sections.board!.rows;
  // OKTA's sales roles: 38% of its new roles with a role family in the last two weeks, from 15% in the two before.
  expect(rows[0]!.values).toMatchObject({ symbol: "OKTA", kind: "Role family", label: "Sales", roles: 45, weeks: "2 vs 2", title: "Strategic Account Executive" });
  expect(buildingNumber("now", rows[0]!.values.now as number)).toBe("38%");
  expect(buildingNumber("before", rows[0]!.values.before as number)).toBe("15%");
  expect(buildingNumber("change", rows[0]!.values.change as number)).toBe("+24 pts");
  expect(buildingNumber("z", rows[0]!.values.z as number)).toBe("+4.1");
  // GM's AI roles: a theme, under a tenth, so to a tenth of a point.
  expect(rows.at(-1)!.values).toMatchObject({ symbol: "GM", kind: "Theme", label: "AI & machine learning" });
  expect(buildingNumber("now", rows.at(-1)!.values.now as number)).toBe("7.9%");
  expect(buildingNumber("change", rows.at(-1)!.values.change as number)).toBe("+5.0 pts");
  // A change that rounds to nothing says so, unsigned.
  expect(buildingNumber("change", -0.0003)).toBe("0 pts");
  // What moved and by how much come before the kind, so a narrow pane keeps them.
  expect(model.sections.board!.columns.map((column) => column.id)).toEqual(["symbol", "name", "label", "now", "before", "change", "roles", "kind", "weeks", "z", "title"]);
  expect(model.figures.map((figure) => [figure.label, figure.value])).toEqual([["Role families", "3"], ["Themes", "1"], ["Compared", "308"], ["Held", "1,195"], ["Theme titles read", "100%"]]);
  expect(buildingBoardModel({ ...board(), shifts: [], total: 0, filter: "theme" }, "theme").sections.board!.empty).toBe("None of this kind this week.");
  expect(buildingBoardModel({ ...board(), week: null, shifts: [] }, "all").sections.board!.empty).toBe("No week has been computed yet.");
});

test("a shift's detail gives every number behind its sentence: both windows, each week, the titles", () => {
  const shift = board().shifts[0]!;
  expect(shift.why).toContain("38% of OKTA's new roles in the last 2 weeks (45 of 117 with a role family), up from 15%");
  expect(shiftFacts(shift)).toEqual(expect.arrayContaining([
    { label: "Now", value: "38% of new roles with a role family, 45 of 117 over the last 2 weeks" },
    { label: "Before", value: "15%, 17 of 115 over the 2 weeks before" },
    { label: "Change", value: "+24 pts, 2.6x its share, z +4.1" },
    { label: "Recent weeks", value: "Oct 5: 14 of 53, Oct 12: 31 of 64" },
  ]));
  // A theme's share is of all new roles.
  expect(shiftFacts(board().shifts.at(-1)!).find((fact) => fact.label === "Now")!.value).toBe("7.9% of new roles, 29 of 365 over the last 2 weeks");
});

test("a company's Building tab shows its whole mix now and before, marks the shift, and lists the postings behind it", () => {
  const model = companyBuildingModel(gm());
  const families = model.sections.families!;
  expect(families.rows[0]!.values).toMatchObject({ label: "Engineering", roles: 138, beforeRoles: 163, note: null });
  expect(families.rows.find((row) => row.values.label === "Research")!.values.note).toBeNull();
  const themes = model.sections.themes!;
  expect(themes.rows[0]!.values).toMatchObject({ label: "AI & machine learning", roles: 29, beforeRoles: 11, note: "Shift" });
  expect(model.sections.shifts!.rows).toHaveLength(1);
  expect(model.sections.postings!.rows[0]!.values.shift).toBe("Theme: AI & machine learning");
  // Behind one shift, the postings do not name it on every row.
  expect(model.sections.postings!.columns.map((column) => column.id)).not.toContain("shift");
  expect(model.figures.map((figure) => [figure.label, figure.value])).toEqual([["Shifts", "1"], ["Weeks", "2 vs 2"], ["Roles", "365 vs 377"]]);

  const held = companyBuildingModel({ ...gm(), held: "thin", functions: [], themes: [], shifts: [] });
  expect(held.sections.families!.empty).toBe("No mix to compare this week: too few roles to compare shares.");
  expect(held.figures.find((figure) => figure.label === "No mix")!.value).toBe("Too few roles to compare shares");
  // A theme whose titles are still being read gives no change yet.
  const reading = companyBuildingModel({ ...gm(), themes: gm().themes.map((row) => ({ ...row, read: false })) });
  expect(reading.sections.themes!.rows[0]!.values).toMatchObject({ change: null, note: "Reading titles" });
});

test("a free read says what free shows and what Pro adds, whatever was asked", () => {
  const free: HiringBuildingBoard = { ...board(), preview: true, shifts: board().shifts.slice(0, 3), locked: 1 };
  expect(buildingPreviewNote(free, "theme")).toBe("Free shows 3 of 4 shifts: the preview can't filter by dimension. Gloom Pro adds the other 1 and every posting behind them.");
  expect(buildingBoardModel(free, "all").sections.board!.locked).toBe(1);
  const company: HiringCompanyBuilding = { ...gm(), preview: true, functions: gm().functions.slice(0, 3), themes: gm().themes.slice(0, 3), shifts: [], history: [],
    locked: { functions: 13, themes: 5, shifts: 1, history: 0 } };
  expect(buildingPreviewNote(company)).toBe("Free shows the three largest families and themes, and the shifts the free board shows. Gloom Pro adds 18 more families and themes, 1 shift.");
  expect(companyBuildingModel(company).sections.shifts!.empty).toBe("This company's shifts are in Pro.");
  expect(buildingPreviewNote(gm())).toBeNull();
});

test("building reads reject another company's payload, the board's in place of a company's, and malformed shares", async () => {
  const client = { getCloudHiringBuilding: async () => board(), getCloudHiringCompanyBuilding: async () => gm() };
  await expect(fetchBuilding("OKTA", {}, client)).rejects.toThrow("different company");
  await expect(fetchBuilding(undefined, {}, { ...client, getCloudHiringBuilding: async () => gm() as never })).rejects.toThrow("company's mix for the board");
  const broken = gm();
  broken.themes[0]!.recentShare = 1.4;
  expect(() => validateBuilding(broken)).toThrow("unreadable hiring mix");
  const asked: unknown[] = [];
  await fetchBuilding(undefined, { filter: "theme", offset: 100 }, { ...client, getCloudHiringBuilding: async (query) => { asked.push(query); return board(); } });
  expect(asked).toEqual([{ limit: undefined, offset: 100, dimension: "theme" }]);
  await expect(fetchBuilding(undefined, {}, { ...client, getCloudHiringBuilding: async () => { throw new ApiRequestError("Not found", 404); } })).rejects.toThrow("What companies are building is not available yet.");
});

test("a HIRE report has Building: each shift with why, a company's mix, and a held company says why", async () => {
  const hiring = { ...(structuredClone(realHiring) as HiringPayload), symbol: "GM" };
  const company = await attentionHeadless("hiring").load(createTestHeadlessArgs({ symbols: ["GM"] }),
    createTestHeadlessContext({ apiClient: { getCloudHiring: async () => hiring, getCloudHiringMoves: noMoves, getCloudHiringCompanySignals: noSignals, getCloudHiringCompanyBuilding: async () => gm() } as never }));
  const themes = company.sections.find((section) => section.title === "Building: themes")!;
  expect(themes.rows![0]).toMatchObject({ label: "AI & machine learning", note: "Shift" });
  expect(themes.columns!.find((column) => column.key === "share")!.format!(themes.rows![0]!.share, themes.rows![0]!)).toBe("7.9%");
  expect(company.sections.find((section) => section.title === "Building: shifts")!.rows![0]!.why).toContain("AI & machine learning: 7.9% of GM's new roles");
  expect(company.sections.some((section) => section.title === "Building postings")).toBe(true);

  const asked: unknown[] = [];
  const market = await attentionHeadless("hiring").load(createTestHeadlessArgs({ options: { dimension: "function" } }), createTestHeadlessContext({ apiClient: { getCloudHiring: async () => emptyBoard,
    getCloudHiringMoves: async () => structuredClone(realMovesBoard), getCloudHiringSignals: async (group: string) => group === "expansion" ? realExpansion : realAnomalies,
    getCloudHiringBuilding: async (query: unknown) => { asked.push(query); return board(); } } as never }));
  expect(asked).toEqual([{ limit: undefined, offset: undefined, dimension: "function" }]);
  const shifts = market.sections.find((section) => section.title === "Building")!;
  expect(shifts.rows!.map((row) => row.symbol)).toEqual(["OKTA", "NTR", "ADSK", "GM"]);
  expect(typeof shifts.rows![0]!.why).toBe("string");

  const held = await attentionHeadless("hiring").load(createTestHeadlessArgs({ symbols: ["GM"] }),
    createTestHeadlessContext({ apiClient: { getCloudHiring: async () => hiring, getCloudHiringMoves: noMoves, getCloudHiringCompanySignals: noSignals,
      getCloudHiringCompanyBuilding: async () => ({ ...gm(), held: "short_watch", functions: [], themes: [], shifts: [] }) } as never }));
  expect(held.notes).toContain("No mix to compare this week: too few measured weeks to compare.");
});
