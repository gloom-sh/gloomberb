import { describe, expect, test } from "bun:test";
import { formatInsiderName, insiderSecurityTag, insiderTypeLabel, insiderTypeTone, shortInsiderRole } from "./display";

describe("insider names", () => {
  test("SEC's last-first names read first name first, title-cased", () => {
    expect(formatInsiderName("Lund Deanna H")).toBe("Deanna H. Lund");
    expect(formatInsiderName("O'BRIEN DEIRDRE")).toBe("Deirdre O'Brien");
    expect(formatInsiderName("COOK TIMOTHY D")).toBe("Timothy D. Cook");
    expect(formatInsiderName("Fendley Steven S.")).toBe("Steven S. Fendley");
    expect(formatInsiderName("DESMOND-HELLMANN SUSAN")).toBe("Susan Desmond-Hellmann");
    expect(formatInsiderName("MCDONALD ROBERT A")).toBe("Robert A. McDonald");
    // A name filed in mixed case keeps its capitals.
    expect(formatInsiderName("DeVore Susan D.")).toBe("Susan D. DeVore");
  });

  test("suffixes stay at the end and compound surnames stay together", () => {
    expect(formatInsiderName("Dixon Robert L JR")).toBe("Robert L. Dixon Jr.");
    expect(formatInsiderName("HAY LEWIS III")).toBe("Lewis Hay III");
    expect(formatInsiderName("Kendrick Charles Morgan JR")).toBe("Charles Morgan Kendrick Jr.");
    expect(formatInsiderName("NORA JOHNSON SUZANNE M")).toBe("Suzanne M. Nora Johnson");
    expect(formatInsiderName("VAN DER BERG JOHN")).toBe("John Van Der Berg");
    // "Le" is a surname of its own, not a particle.
    expect(formatInsiderName("LE PETER J")).toBe("Peter J. Le");
  });

  test("funds, companies and trusts keep the name they filed; joint filers are each formatted", () => {
    expect(formatInsiderName("BERKSHIRE HATHAWAY INC")).toBe("BERKSHIRE HATHAWAY INC");
    expect(formatInsiderName("Baker Bros. Advisors LP")).toBe("Baker Bros. Advisors LP");
    expect(formatInsiderName("SMITH FAMILY TRUST")).toBe("SMITH FAMILY TRUST");
    expect(formatInsiderName("Fund II, L.P.")).toBe("Fund II, L.P.");
    expect(formatInsiderName("KKR & CO")).toBe("KKR & CO");
    expect(formatInsiderName("GATES WILLIAM H III; Gates Foundation Trust")).toBe("William H. Gates III; Gates Foundation Trust");
  });
});

describe("insider roles", () => {
  const role = (title: string, flags: { director?: boolean; tenPercentOwner?: boolean } = {}, remarks?: string) =>
    shortInsiderRole([{ title, ...flags }], remarks);

  test("the most senior role in a combined title, in a few letters", () => {
    expect(role("Chairman & CEO")).toBe("CEO");
    expect(role("President and Chief Executive Officer")).toBe("CEO");
    expect(role("EVP & CFO", { director: true })).toBe("CFO");
    expect(role("SVP, General Counsel and Secretary")).toBe("GC");
    expect(role("SVP, GC and Government Affairs")).toBe("GC");
    expect(role("EVP & Chief Legal Officer")).toBe("GC");
    expect(role("Chief Operating Officer")).toBe("COO");
    expect(role("Principal Accounting Officer")).toBe("CAO");
    expect(role("EVP & Chief HR Officer")).toBe("CHRO");
    expect(role("Senior Vice President")).toBe("SVP");
    expect(role("President")).toBe("President");
  });

  test("a unit's president is not the company's", () => {
    expect(role("President, STC Division")).toBe("Div. Pres.");
    expect(role("EVP & President, Commercial")).toBe("Div. Pres.");
    expect(role("Group President")).toBe("Div. Pres.");
  });

  test("relationship boxes: director, 10% owner, former roles and remarks", () => {
    expect(role("Director")).toBe("Director");
    expect(role("", { director: true })).toBe("Director");
    expect(role("", { director: true, tenPercentOwner: true })).toBe("10% owner");
    expect(role("Chief Executive Officer", { tenPercentOwner: true })).toBe("CEO");
    expect(role("Former Director")).toBe("Ex-Director");
    expect(role("See Remarks", {}, "Executive Vice President and Chief Operating Officer")).toBe("COO");
    expect(role("See Remarks", {}, `Exhibit 24 ${"power of attorney ".repeat(10)}naming the Chief Financial Officer`)).toBe("Officer");
    expect(role("Chief of Staff")).toBe("Chief of Staff");
    expect(shortInsiderRole([{ title: "" }])).toBe("");
  });
});

describe("transaction types", () => {
  test("buys are green, sales red, everything else neutral", () => {
    expect([insiderTypeLabel("P"), insiderTypeTone("P")]).toEqual(["BUY", "buy"]);
    expect([insiderTypeLabel("S"), insiderTypeTone("S")]).toEqual(["SELL", "sell"]);
    for (const code of ["A", "M", "F", "G", "X", "J"]) expect(insiderTypeTone(code)).toBe("neutral");
    expect(["A", "M", "F", "G"].map(insiderTypeLabel)).toEqual(["AWARD", "EXERCISE", "TAX", "GIFT"]);
  });

  test("the security is named only when it is not common stock", () => {
    expect(insiderSecurityTag({ securityTitle: "Common Stock", isDerivative: false })).toBeNull();
    expect(insiderSecurityTag({ securityTitle: "Class B Common Stock", isDerivative: false })).toBeNull();
    expect(insiderSecurityTag({ securityTitle: "Common Stock, par value $0.01 per share", isDerivative: false })).toBeNull();
    expect(insiderSecurityTag({ securityTitle: "Restricted Stock Unit", isDerivative: true })).toBe("RSU");
    expect(insiderSecurityTag({ securityTitle: "Employee Stock Option (Right to Buy)", isDerivative: true })).toBe("Option");
    // A derivative that names common stock is still a derivative.
    expect(insiderSecurityTag({ securityTitle: "Stock Option (right to buy Common Stock)", isDerivative: true })).toBe("Option");
    expect(insiderSecurityTag({ securityTitle: "Phantom Stock Units", isDerivative: true })).toBe("Phantom");
    expect(insiderSecurityTag({ securityTitle: "Series B Preferred Stock", isDerivative: false })).toBe("Preferred");
  });
});
