import { describe, expect, test } from "bun:test";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createDefaultConfig } from "../../../types/config";
import { buildHeadlessFunctionReport } from "../../../cli/pane-functions/headless";
import type { PaneFunctionReport } from "../../../cli/pane-functions/report";
import { insiderHeadless } from "./headless";
import { buildInsiderRows, buildInsiderSummary, insiderReportedName, matchesInsiderOwner, parseInsiderFiling } from "./model";
import { buildInsiderAmendmentScopes } from "./amendments";
import type { SecFilingItem } from "../../../types/data-provider";

const now = new Date("2026-09-10T00:00:00Z").getTime();
function filing(id: string, form = "4", date = "2026-08-20"): SecFilingItem {
  return { accessionNumber: id, form, filingDate: new Date(`${date}T00:00:00Z`), cik: "999", filingUrl: `https://www.sec.gov/${id}` };
}
function xml({ form = "4", owner = "A. OFFICER", cik = "000111", shares = 100, original = "", security = "Class A", noTransactions = false, note = "Open market purchase." } = {}) {
  return `<ownershipDocument><documentType>${form}</documentType><dateOfOriginalSubmission>${original}</dateOfOriginalSubmission>
  <reportingOwner><reportingOwnerId><rptOwnerName>${owner}</rptOwnerName><rptOwnerCik>${cik}</rptOwnerCik></reportingOwnerId></reportingOwner>
  ${noTransactions ? "" : `<nonDerivativeTransaction><securityTitle><value>${security}</value></securityTitle><transactionDate><value>2026-08-19</value></transactionDate><transactionCoding><transactionCode>P</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>${shares}</value><footnoteId id="F1"/></transactionShares><transactionPricePerShare><value>10</value></transactionPricePerShare></transactionAmounts></nonDerivativeTransaction>`}
  <footnotes><footnote id="F1">${note}</footnote></footnotes><remarks>${note}</remarks></ownershipDocument>`;
}
const original = parseInsiderFiling(filing("original"), xml());
const independent = parseInsiderFiling(filing("independent"), xml({ owner: "B. OFFICER", cik: "222", shares: 500, security: "Class B" }));

async function report(entries: Array<{ filing: SecFilingItem; content: string | null }>, name = "") {
  const provider = createTestDataProvider({
    getSecFilings: async () => entries.map(({ filing }) => filing),
    getSecFilingContent: async (item) => entries.find(({ filing }) => filing.accessionNumber === item.accessionNumber)?.content ?? null,
  });
  return buildHeadlessFunctionReport({ headless: insiderHeadless, token: "INS", label: "Insider", options: { name, limit: 20 }, instance: { settings: {} }, capability: { id: "insider" } } as never,
    { dataProvider: provider, config: createDefaultConfig("/tmp/unused-insider-amendment-test") } as never, "CONTROL");
}

function rows(report: PaneFunctionReport): unknown[] {
  const value = report.data.rows;
  if (!Array.isArray(value)) throw new Error("The insider report lists rows");
  return value;
}

describe("as-filed insider amendments", () => {
  test.each([40, 25])("correction or addition of %i shares remains separate and cannot silently enter aggregates", (shares) => {
    const amended = parseInsiderFiling(filing("amendment", "4/A", "2026-08-21"), xml({ form: "4/A", cik: "111", shares, original: "2026-08-20" }));
    const all = [...amended, ...original, ...independent];
    expect(buildInsiderAmendmentScopes(all)).toEqual([{ accessionNumber: "amendment", originalFilingDate: "2026-08-20", originalFilingDateUsable: true, ownerCiks: ["111"], ownerIdentityComplete: true, candidateOriginalAccessions: ["original"] }]);
    const rows = buildInsiderRows(all);
    expect(rows.map((row) => [row.id, row.shares, row.amendmentStatus])).toEqual([["amendment:0", shares, "unreconciled"], ["original:0", 100, "potentially-amended"], ["independent:0", 500, null]]);
    expect(buildInsiderSummary(all, now)).toBe("Loaded filings, last 90 days: Class A: Buy total unavailable (unreconciled amendment) | Class B: Bought 500 shares ($5,000.00)");
    expect(buildInsiderSummary(independent, now, all)).toBe("Loaded filings, last 90 days: Class B: Bought 500 shares ($5,000.00)");
  });

  test("declared original date preserves independent filing dates and unknown date broadens only the possible owner history", () => {
    const earlier = parseInsiderFiling(filing("earlier", "4", "2026-08-18"), xml({ shares: 20 }));
    const later = parseInsiderFiling(filing("later", "4", "2026-08-22"), xml({ shares: 30 }));
    const amended = (date: string, cik = "111") => parseInsiderFiling(filing("amendment", "4/A", "2026-08-21"), xml({ form: "4/A", original: date, cik }));
    const context = [...original, ...earlier, ...later, ...independent];
    expect(buildInsiderAmendmentScopes([...amended("2026-08-20"), ...context])[0]?.candidateOriginalAccessions).toEqual(["original"]);
    expect(buildInsiderAmendmentScopes([...amended("2026-02-31"), ...context])[0]?.candidateOriginalAccessions).toEqual(["original", "earlier"]);
    expect(buildInsiderAmendmentScopes([...amended("", ""), ...context])[0]?.candidateOriginalAccessions).toEqual(["original", "earlier", "independent"]);
    expect(buildInsiderAmendmentScopes([...amended("2027-08-20"), ...context])[0]).toMatchObject({ originalFilingDate: "2027-08-20", originalFilingDateUsable: false, candidateOriginalAccessions: ["original", "earlier"] });
  });

  test("partially identified joint owners cannot establish independent amendments or originals", () => {
    const joint = (content: string) => content.replace("</reportingOwner>", "</reportingOwner><reportingOwner><reportingOwnerId><rptOwnerName>UNKNOWN OWNER</rptOwnerName></reportingOwnerId></reportingOwner>");
    const amendment = parseInsiderFiling(filing("amendment", "4/A", "2026-08-21"), xml({ form: "4/A", original: "2026-08-20" }));
    const partialAmendment = parseInsiderFiling(filing("amendment", "4/A", "2026-08-21"), joint(xml({ form: "4/A", original: "2026-08-20" })));
    const partialOriginal = parseInsiderFiling(filing("independent"), joint(xml({ owner: "B. OFFICER", cik: "222", shares: 500, security: "Class B" })));
    expect(buildInsiderAmendmentScopes([...partialAmendment, ...independent])[0]).toMatchObject({ ownerIdentityComplete: false, candidateOriginalAccessions: ["independent"] });
    expect(buildInsiderAmendmentScopes([...amendment, ...partialOriginal])[0]?.candidateOriginalAccessions).toEqual(["independent"]);
    expect(buildInsiderAmendmentScopes([...amendment, ...independent])[0]?.candidateOriginalAccessions).toEqual([]);
  });

  test("a joint-owner explanation matches both its generated filter name and each individual owner", async () => {
    const content = xml({ form: "4/A", original: "2026-08-20", noTransactions: true })
      .replace("</reportingOwner>", "</reportingOwner><reportingOwner><reportingOwnerId><rptOwnerName>B. OFFICER</rptOwnerName><rptOwnerCik>222</rptOwnerCik></reportingOwnerId></reportingOwner>");
    const entry = parseInsiderFiling(filing("joint", "4/A", "2026-08-21"), content)[0]!;
    expect(matchesInsiderOwner(entry, insiderReportedName(entry)!)).toBe(true);
    expect(matchesInsiderOwner(entry, "B. OFFICER")).toBe(true);
    const result = await report([{ filing: entry.filing, content }], insiderReportedName(entry)!);
    expect(rows(result)).toHaveLength(1);
    expect(rows(result)[0]).toMatchObject({ accessionNumber: "joint", status: "disclosure" });
  });

  test("an explanation-only amendment retains source text and owner filtering without inventing a missing transaction", async () => {
    const amendedFiling = filing("explanation", "4/A", "2026-08-21");
    const content = xml({ form: "4/A", original: "2026-08-20", noTransactions: true, note: "Corrects direct &amp; indirect ownership; no transaction amounts added." });
    const amended = parseInsiderFiling(amendedFiling, content);
    expect(matchesInsiderOwner(amended[0]!, "a. officer")).toBe(true);
    expect(buildInsiderRows(amended)[0]).toMatchObject({ status: "disclosure", insider: "A. OFFICER", shares: null, remarks: "Corrects direct & indirect ownership; no transaction amounts added.", footnotes: [{ id: "F1", text: "Corrects direct & indirect ownership; no transaction amounts added." }] });
    const result = await report([{ filing: amendedFiling, content }, { filing: filing("original"), content: xml() }], "a. officer");
    expect(result.data.complete).toBe(false);
    expect(rows(result)).toHaveLength(2);
    expect(result.data.errors).toEqual(["explanation: Form 4/A is unreconciled; affected transaction totals are unavailable."]);
    expect(result.text).toContain("Original filed 2026-08-20");
    expect(result.text).toContain("Corrects direct & indirect ownership");
  });

  test("actual shared report keeps corrected amounts, source explanation and unrelated owner output", async () => {
    const amendedFiling = filing("amendment", "4/A", "2026-08-21");
    const entries = [{ filing: amendedFiling, content: xml({ form: "4/A", original: "2026-08-20", shares: 40, note: "Corrects 100 shares to 40 shares." }) },
      { filing: filing("original"), content: xml() },
      { filing: filing("independent"), content: xml({ owner: "B. OFFICER", cik: "222", shares: 500, security: "Class B" }) }];
    const result = await report(entries);
    expect(result.data.complete).toBe(false);
    expect(rows(result)[0]).toMatchObject({ form: "4/A", shares: 40, originalFilingDate: "2026-08-20", transactionFootnoteIds: ["F1"], remarks: "Corrects 100 shares to 40 shares." });
    expect(result.text).toContain("Corrects 100 shares to 40 shares.");
    expect(result.text).toContain("4/A");
    const independentReport = await report(entries, "b. officer");
    expect(independentReport.data.complete).toBe(true);
    expect(rows(independentReport)).toHaveLength(1);
    expect(rows(independentReport)[0]).toMatchObject({ insider: "B. OFFICER", amendmentStatus: null });
    expect(independentReport.data.errors).toEqual([]);
  });

  test("failed amendment content still prevents trusting potentially affected originals", async () => {
    const result = await report([{ filing: filing("amendment", "4/A", "2026-08-21"), content: null }, { filing: filing("original"), content: xml() }], "a. officer");
    expect(result.data.complete).toBe(false);
    expect(rows(result)[0]).toMatchObject({ accessionNumber: "original", shares: 100, amendmentStatus: "potentially-amended" });
    expect(result.data.errors).toHaveLength(2);
  });
});
