import { describe, expect, test } from "bun:test";
import { parseForm4Xml } from "./insider-data";
import { OTHER_FILING_NOTES_LABEL, buildInsiderDisclosureText, buildInsiderRows, buildInsiderSummary, buildInsiderSummaryFigures, parseInsiderFiling, securityClassKey } from "./model";
import { buildInsiderTransactionDetailBody } from "../sec/filing-display";
import type { SecFilingItem } from "../../../types/data-provider";

const owner = `<reportingOwner><reportingOwnerId><rptOwnerName>OWNER &amp; CO</rptOwnerName><rptOwnerCik>123</rptOwnerCik></reportingOwnerId><reportingOwnerRelationship><officerTitle>CEO</officerTitle></reportingOwnerRelationship></reportingOwner>`;
function transaction(code: string, security: string, shares: string, price: string, date = "2026-08-20", derivative = false) {
  const tag = derivative ? "derivativeTransaction" : "nonDerivativeTransaction";
  return `<${tag}>
    <securityTitle><value>${security}</value></securityTitle>
    <transactionDate><value>${date}</value></transactionDate>
    <transactionCoding><transactionCode>${code}</transactionCode></transactionCoding>
    <transactionAmounts><transactionShares><value>${shares}</value><footnoteId id="F1"/></transactionShares><transactionPricePerShare><value>${price}</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts>
    <postTransactionAmounts><sharesOwnedFollowingTransaction><value>292786</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
    <ownershipNature><directOrIndirectOwnership><value>I</value></directOrIndirectOwnership><natureOfOwnership><value>Family trust</value></natureOfOwnership></ownershipNature>
  </${tag}>`;
}
const filing: SecFilingItem = { accessionNumber: "one", form: "4", filingDate: new Date("2026-08-24"), cik: "123", filingUrl: "https://www.sec.gov/one" };

describe("Form 4 transaction parsing", () => {
  test("keeps all gift, conversion and derivative rows with their own dates, security and ownership", () => {
    const xml = `<ownershipDocument>${owner}<nonDerivativeTable>
      <nonDerivativeHolding><securityTitle><value>Unrelated holding</value></securityTitle><postTransactionAmounts><sharesOwnedFollowingTransaction><value>999999</value></sharesOwnedFollowingTransaction></postTransactionAmounts></nonDerivativeHolding>
      ${transaction("G", "Class A Common Stock", "55498", "0", "2026-08-10")}
      ${transaction("G", "Class A Common Stock", "294502", "0", "2026-08-11")}
      ${transaction("C", "Class B Common Stock", "402348", "")}
      </nonDerivativeTable><derivativeTable>${transaction("M", "Restricted Stock Units", "877500", "0", "2026-08-20", true)}</derivativeTable></ownershipDocument>`;
    const rows = parseForm4Xml(xml);
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => [row.transactionType, row.shares, row.pricePerShare, row.filingDate?.toISOString().slice(0, 10), row.isDerivative])).toEqual([
      ["G", 55498, 0, "2026-08-10", false], ["G", 294502, 0, "2026-08-11", false],
      ["C", 402348, null, "2026-08-20", false], ["M", 877500, 0, "2026-08-20", true],
    ]);
    expect(rows[0]).toMatchObject({ reportedName: "OWNER & CO", securityTitle: "Class A Common Stock", acquiredDisposed: "D", ownershipType: "I", ownershipNature: "Family trust", sharesOwned: 292786, totalValue: 0 });
    expect(rows[2]?.totalValue).toBeNull();
    const projected = buildInsiderRows(parseInsiderFiling(filing, xml));
    expect(new Set(projected.map((row) => row.id)).size).toBe(4);
    expect(projected[1]).toMatchObject({ filingDate: "2026-08-24T00:00:00.000Z", transactionDate: "2026-08-11T00:00:00.000Z", side: "GIFT", transactionCode: "G", reportingOwners: [{ name: "OWNER & CO", cik: "123", title: "CEO" }] });
  });

  test("missing amounts and invalid dates remain unknown rather than becoming zero or today", () => {
    const rows = parseForm4Xml(`<ownershipDocument>${owner}${transaction("F", "Class A", "", "", "2026-02-31")}</ownershipDocument>`);
    expect(rows[0]).toMatchObject({ filingDate: null, shares: null, pricePerShare: null, totalValue: null, transactionType: "F" });
    expect(parseForm4Xml("<html>not a filing</html>")).toEqual([]);
    expect(buildInsiderRows(parseInsiderFiling(filing, "<ownershipDocument/>"))[0]?.status).toBe("unavailable");
  });

  test("a director without an officer title is labeled, and a Form 4 without transaction lines is a disclosure, not a parse failure", () => {
    const director = `<reportingOwner><reportingOwnerId><rptOwnerName>DIRECTOR A</rptOwnerName><rptOwnerCik>9</rptOwnerCik></reportingOwnerId><reportingOwnerRelationship><isDirector>1</isDirector><officerTitle></officerTitle></reportingOwnerRelationship></reportingOwner>`;
    expect(parseForm4Xml(`<ownershipDocument>${director}${transaction("S", "Common Stock", "10", "5")}</ownershipDocument>`)[0]).toMatchObject({ title: "Director", reportingOwners: [{ director: true, tenPercentOwner: false }] });
    // The 10b5-1 box is one per form; forms filed before it existed leave it unknown.
    expect(parseForm4Xml(`<ownershipDocument>${director}<aff10b5One>1</aff10b5One>${transaction("S", "Common Stock", "10", "5")}</ownershipDocument>`)[0]?.rule10b51).toBe(true);
    expect(parseForm4Xml(`<ownershipDocument>${director}<aff10b5One>0</aff10b5One>${transaction("S", "Common Stock", "10", "5")}</ownershipDocument>`)[0]?.rule10b51).toBe(false);
    expect(parseForm4Xml(`<ownershipDocument>${director}${transaction("S", "Common Stock", "10", "5")}</ownershipDocument>`)[0]?.rule10b51).toBeUndefined();
    const exit = parseInsiderFiling(filing, `<ownershipDocument>${owner}<remarks>No longer subject to Section 16.</remarks></ownershipDocument>`);
    expect(buildInsiderRows(exit)[0]).toMatchObject({ status: "disclosure", remarks: "No longer subject to Section 16." });
    expect(buildInsiderSummary(exit, new Date("2026-09-10").getTime())).toBe("1 loaded filing, trades dated 2026-06-12 to 2026-09-10: no parsed non-derivative buys/sales.");
  });

  test("summary excludes exercises and gifts, separates securities, and exposes missing sale prices", () => {
    const xml = `<ownershipDocument>${owner}
      ${transaction("S", "Class A", "100", "10")}${transaction("S", "Class A", "25", "")}
      ${transaction("S", "Class B", "50", "20")}${transaction("S", "Options", "9000", "1", "2026-08-20", true)}
      ${transaction("G", "Class A", "8000", "0")}${transaction("M", "Class A", "7000", "0")}
      ${transaction("S", "Class A", "6000", "1", "2025-01-01")}
      </ownershipDocument>`;
    const summary = buildInsiderSummary(parseInsiderFiling(filing, xml), new Date("2026-09-10").getTime());
    expect(summary).toBe("1 loaded filing, trades dated 2026-06-12 to 2026-09-10: Class A: Sold 125 shares (value unavailable) | Class B: Sold 50 shares (1,000.00 USD)");
  });

  test("summary totals every spelling of one class together, under the spelling most of its shares were filed as", () => {
    const xml = `<ownershipDocument>${owner}
      ${transaction("S", "Common Stock", "4000", "10")}${transaction("S", "Common", "300", "10")}
      ${transaction("S", "COMMON STOCK, $0.001 PAR VALUE", "20", "10")}${transaction("S", "Common Stock, par value $.01 per share", "1", "10")}
      </ownershipDocument>`;
    expect(buildInsiderSummary(parseInsiderFiling(filing, xml), new Date("2026-09-10").getTime()))
      .toBe("1 loaded filing, trades dated 2026-06-12 to 2026-09-10: Common Stock: Sold 4.3k shares (43,210.00 USD)");
    const keys = (titles: string[]) => new Set(titles.map(securityClassKey)).size;
    expect(keys(["Class A Common Stock", "Common Stock, Class A", "class a common stock ($.0001 par value)"])).toBe(1);
    expect(keys(["Class A Common Stock", "Class B Common Stock", "Common Stock", "Series A Preferred Stock", "Series B Preferred Stock"])).toBe(5);
  });

  test("a line's detail reads its price as filed and its own notes first, before the filing's other lines' notes", () => {
    // A CFO's tax withholding (F1) and 10b5-1 sale at a weighted average (F3, F4) on one Form 4, as NVDA's filed 2026-09-18.
    const line = (code: string, price: string, notes: string[]) => `<nonDerivativeTransaction>
      <securityTitle><value>Common</value></securityTitle>
      <transactionDate><value>2026-09-17</value></transactionDate>
      <transactionCoding><transactionCode>${code}</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>1356000</value></transactionShares><transactionPricePerShare><value>${price}</value>${notes.map((id) => `<footnoteId id="${id}"/>`).join("")}</transactionPricePerShare><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>800021</value><footnoteId id="F2"/></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>
    </nonDerivativeTransaction>`;
    const xml = `<ownershipDocument>${owner}<aff10b5One>1</aff10b5One><nonDerivativeTable>
      ${line("F", "212.17", ["F1"])}${line("S", "219.7219", ["F3", "F4"])}
      </nonDerivativeTable><footnotes>
      <footnote id="F1">Shares withheld to satisfy taxes.</footnote>
      <footnote id="F2">Includes shares from vested units.</footnote>
      <footnote id="F3">Effected under a Rule 10b5-1 trading plan.</footnote>
      <footnote id="F4">Weighted average sales price; sold from $219.42 to $219.865.</footnote>
      </footnotes><remarks>Exhibit 24, power of attorney.</remarks></ownershipDocument>`;
    const [tax, sale] = parseInsiderFiling(filing, xml);
    expect(buildInsiderTransactionDetailBody(sale!.transaction!)).toContain("Price/Share: $219.7219");
    expect(buildInsiderTransactionDetailBody(tax!.transaction!)).toContain("Price/Share: $212.17");
    expect(buildInsiderDisclosureText(sale!).split("\n\n")).toEqual([
      "F3: Effected under a Rule 10b5-1 trading plan.",
      "F4: Weighted average sales price; sold from $219.42 to $219.865.",
      "F2: Includes shares from vested units.",
      "Remarks: Exhibit 24, power of attorney.",
      OTHER_FILING_NOTES_LABEL,
      "F1: Shares withheld to satisfy taxes.",
    ]);
    // The filing as a whole (a 4/A's note under its rows) keeps the remarks first and every note in order.
    expect(buildInsiderDisclosureText(sale!, { byLine: false }).split("\n\n")[0]).toBe("Remarks: Exhibit 24, power of attorney.");
  });

  test("the 90-day totals say the trade dates they count and how many loaded filings they read", () => {
    const xml = `<ownershipDocument>${owner}${transaction("S", "Common Stock", "100", "10", "2026-06-12")}${transaction("S", "Common Stock", "7", "10", "2026-06-11")}</ownershipDocument>`;
    // 90 days before 2026-09-10 12:00 UTC is 2026-06-12 12:00: a trade dated 12 Jun (its midnight) is before it, 13 Jun the first day in.
    const figures = buildInsiderSummaryFigures(parseInsiderFiling(filing, xml), Date.parse("2026-09-10T12:00:00Z"));
    expect(figures).toMatchObject({ window: { from: "2026-06-13", to: "2026-09-10" }, filings: 1, totals: [] });
    expect(buildInsiderSummaryFigures(parseInsiderFiling(filing, xml), Date.parse("2026-09-10T00:00:00Z"))?.totals[0]).toMatchObject({ shares: 100 });
  });
});
