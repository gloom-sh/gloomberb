import { expect, test } from "bun:test";
import {
  buildBeneficialRows,
  DEFAULT_BENEFICIAL_SORT,
  disclosedStake,
  formatFilerName,
  formatPercentOfClass,
  formatPointChange,
  sortBeneficialRows,
  thirteenFAction,
} from "./beneficial-model";
import { beneficialCoverageNotices, beneficialListUnreadable } from "./beneficial-report";
import { CAR_BENEFICIAL_OWNERS, carBeneficialOwnersPayload } from "./test-fixture";
import type { HolderRow } from "./types";

const holder = (id: string, name: string, shares?: number, changeShares?: number): HolderRow =>
  ({ id, name, ownerType: "institution", shares, changeShares });

test("a row reads its change against the filer's previous report and its 13F move by CIK, then by exact name", () => {
  const holders = [
    // The 13F manager matched to this row carries Pentwater's CIK under another spelling.
    holder("pentwater", "Pentwater Capital Mgmt", 2_513_300, -1_340_000),
    holder("morgan", "Morgan Stanley", 2_029_978, 2_029_978),
    holder("srs", "Srs Investment Management, Llc", 17_430_882, 0),
    holder("blackrock", "Blackrock Inc.", 1_660_106, 50_000),
    // Two rows under one name are ambiguous.
    holder("vanguard-1", "Vanguard Group Inc", 788_708, 10_000),
    holder("vanguard-2", "The Vanguard Group, Inc.", 756_350, 10_000),
    // A longer name is a subsidiary, not the filer.
    holder("jane-street-sub", "Jane Street Group LLC Capital Markets", 900_000, 10_000),
  ];
  const fundMatches = new Map([["pentwater", { cik: "1425851" }], ["blackrock", { cik: "0001086364" }]]);
  const rows = buildBeneficialRows(CAR_BENEFICIAL_OWNERS, holders, fundMatches);
  const byFiler = new Map(rows.map((row) => [row.filing.filerName, row]));

  const pentwater = byFiler.get("Pentwater Capital Management LP")!;
  expect(pentwater.formLabel).toBe("13G/A");
  expect(formatPointChange(pentwater.changePoints)).toBe("-14.9 pt");
  expect(pentwater.thirteenF?.label).toBe("-35%");
  expect(byFiler.get("Morgan Stanley")?.thirteenF?.label).toBe("NEW");
  expect(byFiler.get("SRS Investment Management, LLC")).toMatchObject({ formLabel: "13D/A", thirteenF: { label: "0%" } });
  // Its 13F manager files under another CIK; the exact name still joins.
  expect(byFiler.get("BlackRock, Inc.")?.thirteenF?.label).toBe("+3%");
  expect(byFiler.get("Vanguard Group Inc")?.thirteenF).toBeNull();
  expect(byFiler.get("Jane Street Group, LLC")?.thirteenF).toBeNull();
  // No previous report leaves the change empty.
  expect(byFiler.get("Morgan Stanley")?.changePoints).toBeNull();

  expect(thirteenFAction(holder("exit", "Gone", 0, -500))?.label).toBe("EXIT");
  expect(thirteenFAction(holder("unknown", "No change reported", 1_000))).toBeNull();
});

test("a stake under 5% stays a stake, only a report of zero is an exit, and a missing figure is unknown", () => {
  const rows = buildBeneficialRows(CAR_BENEFICIAL_OWNERS);
  const row = (filer: string) => rows.find((candidate) => candidate.filing.filerName === filer)!;

  const nomura = row("Nomura Holdings Inc");
  expect(nomura.stake).toBe("below-threshold");
  expect(formatPercentOfClass(nomura)).toBe("3.9%");
  expect(formatPercentOfClass(nomura, { marker: true })).toBe("3.9% <5%");
  const fmr = row("FMR LLC");
  expect(fmr.stake).toBe("exited");
  expect(formatPercentOfClass(fmr, { marker: true })).toBe("0.0% EXIT");
  const goldman = row("Goldman Sachs Group Inc");
  expect(goldman.stake).toBe("holder");
  expect(formatPercentOfClass(goldman, { marker: true })).toBe("-");
  expect(goldman.changePoints).toBeNull();

  // A route that still calls a 4.9% stake an exit is read by the figure; no figures at all is unknown.
  expect(disclosedStake({ percentOfClass: 4.9, shares: 1_700_000, status: "exited" })).toBe("below-threshold");
  expect(disclosedStake({ percentOfClass: null, shares: null, status: "exited" })).toBeNull();
  expect(disclosedStake({ percentOfClass: null, shares: null })).toBeNull();
  expect(disclosedStake({ percentOfClass: null, shares: 0 })).toBe("exited");
  // History reports carry no status or previous report, and none is made up.
  const history = buildBeneficialRows(carBeneficialOwnersPayload({ history: true }).filings!);
  expect(history.filter((entry) => entry.stake === "exited").map((entry) => entry.filing.filerName)).toEqual(["FMR LLC"]);
  expect(history.every((entry) => entry.changePoints === null)).toBe(true);

  const sorted = sortBeneficialRows(rows, DEFAULT_BENEFICIAL_SORT).map((entry) => entry.filing.filerName);
  expect(sorted).toEqual([
    "SRS Investment Management, LLC",
    "Vanguard Group Inc",
    "Pentwater Capital Management LP",
    "BlackRock, Inc.",
    "Morgan Stanley",
    "Jane Street Group, LLC",
    "Goldman Sachs Group Inc",
    "Nomura Holdings Inc",
    "Susquehanna Securities, LLC",
    "FMR LLC",
  ]);
  // Stakes under 5% and exits stay after the 5% holders in either direction.
  const ascending = sortBeneficialRows(rows, { columnId: "percentOfClass", direction: "asc" });
  expect(ascending.slice(-3).map((entry) => entry.stake)).toEqual(["below-threshold", "below-threshold", "exited"]);
});

test("a narrow filer column drops the entity suffix before the name and never cuts the group count", () => {
  expect(formatFilerName("SRS Investment Management, LLC", 2, 40)).toBe("SRS Investment Management, LLC +2");
  expect(formatFilerName("SRS Investment Management, LLC", 2, 28)).toBe("SRS Investment Management +2");
  expect(formatFilerName("SRS Investment Management, LLC", 2, 18)).toBe("SRS Investment… +2");
  expect(formatFilerName("Pentwater Capital Management L.P.", 0, 14)).toBe("Pentwater Cap…");
});

test("filings that could not be read are a gap, not an empty list", () => {
  const coverage = { from: "2022-10-09", filings: 12, parsed: 9, unparsed: 3, unavailable: 2 };
  expect(beneficialCoverageNotices(coverage)).toEqual([
    "2 of 12 filings could not be read this time and are left out; a refresh retries them.",
    "Percent of class and shares are blank for 1 filing known only from the EDGAR index.",
  ]);
  expect(beneficialListUnreadable({ owners: [], coverage: { ...coverage, parsed: 0, unparsed: 12, unavailable: 12 } })).toBe(true);
  expect(beneficialListUnreadable({ owners: [], coverage: { from: "2022-10-09", filings: 0, parsed: 0, unparsed: 0 } })).toBe(false);
});
