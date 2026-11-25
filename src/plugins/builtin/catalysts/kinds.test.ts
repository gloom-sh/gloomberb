import { describe, expect, test } from "bun:test";
import type { CatalystEvent, CatalystResponse, CatalystType } from "../../../api-client/catalysts";
import { catalystFixture, catalystPayload } from "./test-fixture";
import { catalystKindCell, catalystKindColumns, catalystKindFold, catalystKindWidths, catalystOpeningKind, catalystSelf, catalystWith, createCatalystKindLoader, trialPhase } from "./kinds";

const TODAY = "2026-12-15";
const on = (id: string, type: CatalystType, date: string | null): CatalystEvent =>
  ({ ...catalystFixture, id, type, announcedDate: null, effectiveDate: date, deadlineDate: null, datePrecision: { effective: "day" } });

/** A type's rows as the service pages them, recording each request. */
function service(rows: Partial<Record<CatalystType, CatalystEvent[]>>, size: number, access?: (type: CatalystType) => CatalystResponse["access"]) {
  const requests: string[] = [];
  const read = async (type: CatalystType, offset: number) => {
    requests.push(`${type}@${offset}`);
    const all = rows[type] ?? [];
    const payload = { ...catalystPayload(), events: all.slice(offset, offset + size), total: all.length, offset, limit: size, upcoming: 1, access: access?.(type) ?? { pro: true, lockedRows: 0, previewLimit: 3 } };
    return { payload, stale: false, refreshError: null };
  };
  return { read, requests };
}
const page = (loader: ReturnType<typeof createCatalystKindLoader>, offset: number) => loader({ offset, force: false, signal: new AbortController().signal });

describe("a kind read across its event types", () => {
  test("lists the types' rows in the calendar's order, reading a type again only when its next row could come first", async () => {
    // Coming up soonest first, then past days latest first, then undated.
    const results = [on("r1", "results", "2026-12-20"), on("r2", "results", "2026-12-28"), on("r3", "results", "2026-12-10"), on("r4", "results", null)];
    const meetings = [on("m1", "shareholder_meeting", "2026-12-22"), on("m2", "shareholder_meeting", "2026-12-01")];
    const { read, requests } = service({ results, shareholder_meeting: meetings }, 2);
    const first = await page(createCatalystKindLoader(["results", "shareholder_meeting"], read, "any", TODAY), 0);
    expect(first.rows.map((event) => event.id)).toEqual(["r1", "m1", "r2", "r3", "m2", "r4"]);
    // Meetings were read out on their first page; results had more past its 28 December.
    expect(requests).toEqual(["results@0", "shareholder_meeting@0", "results@2"]);
    expect([first.payload.total, first.payload.upcoming, first.hasMore, first.nextOffset]).toEqual([6, 2, false, 6]);
  });

  test("pages a screen at a time and never lists a later page's row above one already shown", async () => {
    const day = (index: number) => `2027-${String(1 + Math.floor(index / 28)).padStart(2, "0")}-${String(1 + (index % 28)).padStart(2, "0")}`;
    const results = Array.from({ length: 60 }, (_, index) => on(`r${String(index).padStart(2, "0")}`, "results", day(index * 2)));
    const votes = Array.from({ length: 30 }, (_, index) => on(`v${String(index).padStart(2, "0")}`, "merger_vote", day(index * 2 + 1)));
    const { read } = service({ results, merger_vote: votes }, 25);
    const loader = createCatalystKindLoader(["results", "merger_vote"], read, "any", TODAY);
    const first = await page(loader, 0);
    expect(first.rows).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    const rest = [];
    for (let next = first; next.hasMore;) { next = await page(loader, next.nextOffset); rest.push(...next.rows); }
    const listed = [...first.rows, ...rest].map((event) => event.effectiveDate);
    expect(listed).toHaveLength(90);
    expect(listed).toEqual([...listed].sort());
    // A page asked for out of turn (a saved copy whose refresh failed) is refused, not guessed.
    await expect(page(createCatalystKindLoader(["results"], read, "any", TODAY), 50)).rejects.toThrow("Reload");
  });

  test("a free preview lists as many rows as one request would, and counts the rest as held back", async () => {
    const preview = () => ({ pro: false, lockedRows: 10, previewLimit: 3, lockedUpcoming: 4 });
    const results = [on("r1", "results", "2026-12-20"), on("r2", "results", "2026-12-24"), on("r3", "results", "2026-12-01")];
    const votes = [on("v1", "merger_vote", "2026-12-18"), on("v2", "merger_vote", "2026-12-30"), on("v3", "merger_vote", "2026-11-01")];
    const { read } = service({ results, merger_vote: votes }, 3, preview);
    const first = await page(createCatalystKindLoader(["results", "merger_vote"], read, "any", TODAY), 0);
    expect(first.rows.map((event) => event.id)).toEqual(["v1", "r1", "r2"]);
    // 20 held back by the service, and 3 more read here: one of them still to come.
    expect(first.payload.access).toEqual({ pro: false, previewLimit: 3, lockedRows: 23, lockedUpcoming: 9 });
    expect(first.hasMore).toBe(false);
  });

  test("opens on a filter's kind, else the chosen one, else the first kind in tab order with something coming up", () => {
    const trial = on("t", "clinical", "2026-12-20"), results = on("r", "results", "2026-11-01"), vote = on("v", "merger_vote", "2027-02-01");
    expect(catalystOpeningKind("pdufa", "trials", null, TODAY)).toBe("drugs");
    expect(catalystOpeningKind("approval", "drugs", null, TODAY)).toBe("approvals");
    expect(catalystOpeningKind(undefined, "legal", null, TODAY)).toBe("legal");
    expect(catalystOpeningKind(undefined, "nonsense", null, TODAY)).toBeNull();
    // A company's past results do not outrank a trial still to complete; a vote coming up does.
    expect(catalystOpeningKind(undefined, "", [trial, results], TODAY)).toBe("trials");
    expect(catalystOpeningKind(undefined, "", [trial, vote, results], TODAY)).toBe("company");
    expect(catalystOpeningKind(undefined, "", [results], TODAY)).toBe("company");
    expect(catalystOpeningKind(undefined, "", [], TODAY)).toBe("company");
  });
});

describe("a kind's columns", () => {
  test("each kind heads its own columns, and a company's own calendar names only the other parties", () => {
    const ids = (columns: { id: string }[]) => columns.map((column) => column.id);
    const trials = catalystKindColumns(158, { kind: "trials" });
    expect(ids(trials)).toEqual(["date", "basis", "ticker", "parties", "title", "phase", "status"]);
    expect(trials.find((column) => column.id === "parties")!.label).toBe("Sponsor");
    expect(ids(catalystKindColumns(158, { kind: "trials", self: { hasOthers: true } }))).toEqual(["date", "basis", "with", "title", "phase", "status"]);
    expect(ids(catalystKindColumns(158, { kind: "company", self: { hasOthers: false } }))).toEqual(["date", "title", "type", "status", "agency"]);
    // A rule's agency leads, and shrinks with the rest before it goes.
    expect(ids(catalystKindColumns(100, { kind: "regulation" }))).toEqual(["date", "basis", "agency", "parties", "title", "status"]);
    for (const width of [78, 110, 158]) {
      const need = catalystKindColumns(width, { kind: "legal" }).reduce((sum, column) => sum + column.width + 1, 3);
      expect(need).toBeLessThanOrEqual(width);
    }
  });

  test("a column the rows say alike goes, per type or on every row, and a shared basis heads the date", () => {
    const ids = (columns: { id: string; label: string }[]) => columns.map((column) => column.id);
    const decision = (id: string, deadline: string, withheld = false): CatalystEvent => ({ ...catalystFixture, id, type: "pdufa", status: "company-reported target",
      agency: "SEC / company disclosure", announcedDate: "2026-10-01", deadlineDate: deadline, datePrecision: { deadline: "day" }, metadata: withheld ? { dateWithheld: true } : {} });
    const meeting: CatalystEvent = { ...catalystFixture, id: "m", type: "advisory-meeting" as CatalystType, status: "Notice", agency: "FDA", source: "fda_advisory",
      announcedDate: "2026-10-01", deadlineDate: "2027-01-21", datePrecision: { deadline: "day" }, metadata: { deadlineMeaning: "Advisory committee meeting" } };
    // A PDUFA date is always a company's target, an advisory meeting the FDA's: only the type tells them apart.
    const drugs = [decision("p1", "2026-12-20"), decision("p2", "2027-02-01"), decision("p3", "2027-03-01", true), meeting];
    const fold = catalystKindFold(drugs, "any", "drugs");
    expect([...fold.hidden].sort()).toEqual(["agency", "basis", "status"]);
    expect(ids(catalystKindColumns(158, { kind: "drugs", fold }))).toEqual(["date", "ticker", "parties", "title", "type"]);
    expect(catalystKindCell(meeting, "type", "any", "drugs", null, true)).toBe("Advisory meeting");
    // A withheld date says so where its basis would; the dated rows still share theirs.
    expect(catalystKindCell(drugs[2]!, "date", "any", "drugs", null, true)).toBe("Undisclosed");
    const pdufas = catalystKindFold(drugs.slice(0, 3), "any", "drugs");
    expect(pdufas.basis).toBe("Deadline");
    expect(catalystKindColumns(158, { kind: "drugs", fold: pdufas })[0]!.label).toBe("Deadline");

    const trial = (id: string, status: string, completion: "ESTIMATED" | "ACTUAL") => ({ ...catalystFixture, id, status,
      metadata: { phases: ["PHASE3"], primaryCompletion: { type: completion }, deadlineDateMeaning: "Primary completion" } });
    const ahead = [trial("t1", "RECRUITING", "ESTIMATED"), trial("t2", "ACTIVE_NOT_RECRUITING", "ESTIMATED")];
    const trials = catalystKindFold(ahead, "any", "trials");
    const columns = catalystKindColumns(158, { kind: "trials", fold: trials, widths: catalystKindWidths(ahead, "any", "trials") });
    expect(ids(columns)).toEqual(["date", "ticker", "parties", "title", "status"]);
    expect(columns[0]!.label).toBe("Est. completion");
    // Nothing cut where the pane has room: the status column holds its longest status.
    expect(columns.find((column) => column.id === "status")!.width).toBeGreaterThanOrEqual("Active not recruiting".length);
    // A completed trial on a later page brings the basis back.
    expect(catalystKindFold([...ahead, trial("t3", "COMPLETED", "ACTUAL")], "any", "trials").hidden.has("basis")).toBe(false);
  });

  test("a cell reads short where the full wording would be cut, and a date ahead leaves out the status every one has", () => {
    const rule = { ...catalystFixture, type: "rulemaking" as CatalystType, agency: "Federal Aviation Administration", status: "Proposed Rule" };
    expect(catalystKindCell(rule, "agency", "any", "regulation", null, true)).toBe("FAA");
    expect(catalystKindCell(rule, "agency", "any", "regulation", null)).toBe("Federal Aviation Administration");
    const results = { ...catalystFixture, type: "results" as CatalystType, status: "scheduled", agency: "Company investor relations" };
    expect(catalystKindCell(results, "status", "any", "company", null, true)).toBe("");
    expect(catalystKindCell({ ...results, datePassed: true }, "status", "any", "company", null, true)).toBe("Date passed");
    expect(catalystKindCell(results, "agency", "any", "company", null, true)).toBe("Company IR");
  });

  test("the With cell drops the company under any of its names, and a trial reads its phase and basis short", () => {
    const party = (name: string, ticker: string | null, exchange: string | null = null) => ({ ...catalystFixture.parties[0]!, name, ticker, exchange });
    const trial = { ...catalystFixture, parties: [party("Pfizer Inc", "PFE", "NYSE"), party("Merck & Co., Inc.", "MRK", "NYSE"), party("BioNTech SE", null)],
      metadata: { phases: ["PHASE1", "PHASE2"], primaryCompletion: { type: "ESTIMATED" }, deadlineDateMeaning: "Primary completion" } };
    // An unlinked party under the company's name is the company.
    const subsidiary = { ...catalystFixture, parties: [party("Pfizer", null), party("Pfizer, Inc.", "PFE", "NYSE")] };
    const self = catalystSelf([trial, subsidiary], "PFE:XNYS");
    expect(catalystWith(trial, self)).toBe("MRK:XNYS +1");
    expect(catalystWith(subsidiary, self)).toBe("");
    expect(catalystKindCell(trial, "phase", "any", "trials", self)).toBe("1/2");
    expect(catalystKindCell(trial, "basis", "any", "trials", self)).toBe("Est. completion");
    expect(trialPhase({ metadata: { phases: ["EARLY_PHASE1"] } })).toBe("Early 1");
    expect(trialPhase({ metadata: { phases: ["NA"] } })).toBe("—");
  });
});
