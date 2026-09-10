import { describe, expect, test } from "bun:test";
import { parseForm4Xml } from "./insider-data";
import { buildInsiderRows, buildInsiderSummary, parseInsiderFiling } from "./model";
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

  test("summary excludes exercises and gifts, separates securities, and exposes missing sale prices", () => {
    const xml = `<ownershipDocument>${owner}
      ${transaction("S", "Class A", "100", "10")}${transaction("S", "Class A", "25", "")}
      ${transaction("S", "Class B", "50", "20")}${transaction("S", "Options", "9000", "1", "2026-08-20", true)}
      ${transaction("G", "Class A", "8000", "0")}${transaction("M", "Class A", "7000", "0")}
      ${transaction("S", "Class A", "6000", "1", "2025-01-01")}
      </ownershipDocument>`;
    const summary = buildInsiderSummary(parseInsiderFiling(filing, xml), new Date("2026-09-10").getTime());
    expect(summary).toBe("Loaded filings, last 90 days: Class A: Sold 125 shares (value unavailable) | Class B: Sold 50 shares ($1,000.00)");
  });
});
