import { expect, test } from "bun:test";
import { parseDesignations, parseDistressFilings, parseGoingConcern, parseInsolvencyNotices } from "./client";
import { designationRow, designationsPage, filingEvent, goingConcernRow, insolvencyPage, insolvencyRow } from "./test-fixture";

const goingConcernPage = (rows: unknown[]) => ({ disclosures: rows, hasMore: true, limit: 100, offset: 0 });

test("a parsed page parses to itself, so a cached copy is checked again on the way out", () => {
  const designations = parseDesignations(designationsPage([designationRow()]));
  expect(parseDesignations(designations)).toEqual(designations);
  // The two attribution shapes, a dataset list and one dataset page, read as one list of links.
  expect(designations.attributions[0]!.datasetUrls).toEqual(["https://data.gov.tw/dataset/11543", "https://data.gov.tw/dataset/11760"]);

  const notices = parseInsolvencyNotices(insolvencyPage([insolvencyRow()]));
  expect(parseInsolvencyNotices(notices)).toEqual(notices);
  expect(notices.attributions[0]!.datasetUrls).toEqual(["https://www.thegazette.co.uk/insolvency"]);

  const disclosures = parseGoingConcern(goingConcernPage([goingConcernRow()]));
  expect(parseGoingConcern(disclosures)).toEqual(disclosures);
  // Fields the tab never shows, such as which reader classified the note, are not kept.
  expect(Object.keys(disclosures.disclosures[0]!)).not.toContain("read_at");
});

test("a link that is not a web address, or a verdict this build cannot word, makes the page unreadable", () => {
  expect(() => parseDistressFilings({ events: [filingEvent({ docUrl: "javascript:alert(1)" })] })).toThrow("unreadable 8-K filings");
  expect(() => parseGoingConcern(goingConcernPage([goingConcernRow({ verdict: "likely_to_fail" })]))).toThrow("unreadable going-concern");
  expect(() => parseInsolvencyNotices(insolvencyPage([insolvencyRow({ notice_url: "file:///etc/passwd" })]))).toThrow("unreadable insolvency");
  expect(() => parseInsolvencyNotices({ ...insolvencyPage([insolvencyRow()]), attributions: [{ source: "gazette_uk" }] })).toThrow("unreadable insolvency");
  expect(() => parseDesignations({ designations: [designationRow()], hasMore: false, limit: 100, offset: 0 })).toThrow("unreadable listing");
});

test("an official date basis without its date is unreadable; a first sighting needs none", () => {
  expect(() => parseDesignations(designationsPage([designationRow({ date_basis: "effective", effective_at: null })]))).toThrow();
  expect(parseDesignations(designationsPage([designationRow()])).designations).toHaveLength(1);
});
