import { expect, test } from "bun:test";
import { companyNameCase } from "./company-name";

test("a name written in capitals reads as a company name, with legal forms, short words and initials in their usual case", () => {
  const cased: Record<string, string> = {
    "APPLE INC": "Apple Inc",
    "MERCK & CO INC": "Merck & Co Inc",
    "BANK OF AMERICA": "Bank of America",
    "AIR PRODUCTS AND CHEMICALS": "Air Products and Chemicals",
    "THE TRAVELERS COMPANIES": "The Travelers Companies",
    "ALPHABET CLASS A": "Alphabet Class A",
    "BERKSHIRE HATHAWAY INC CLASS B": "Berkshire Hathaway Inc Class B",
    "COCA-COLA": "Coca-Cola",
    "AMAZON.COM INC": "Amazon.com Inc",
    "LINDE PLC": "Linde PLC",
    "EQUINIX REIT": "Equinix REIT",
    "TRANE TECHNOLOGIES PLC": "Trane Technologies PLC",
    "LIBERTY GLOBAL LTD CLASS C": "Liberty Global Ltd Class C",
    // Initials and tickers inside a name stay capitals.
    "GE AEROSPACE": "GE Aerospace",
    "AT&T": "AT&T",
    "3M": "3M",
    "L3HARRIS TECHNOLOGIES": "L3Harris Technologies",
    "WD-40": "WD-40",
    "CVS HEALTH CORP": "CVS Health Corp",
    "TXNM ENERGY": "TXNM Energy",
    // The largest names whose brand spelling title case would get wrong.
    NVIDIA: "NVIDIA",
    "JPMORGAN CHASE & CO": "JPMorgan Chase & Co",
    "UNITEDHEALTH GROUP": "UnitedHealth Group",
    "MCDONALD'S CORP": "McDonald's Corp",
    MCKESSON: "McKesson",
  };
  for (const [name, expected] of Object.entries(cased)) expect(companyNameCase(name)).toBe(expected);
});

test("a name that already carries lower case, or no letters, is left as its source wrote it", () => {
  for (const name of ["Apple Inc.", "iShares Core S&P 500", "NVIDIA Corporation", "3M Company", "", "66"]) expect(companyNameCase(name)).toBe(name);
});

test("a brand that opens in lower case before capitals is a name in capitals all the same", () => {
  expect(companyNameCase("aTYR PHARMA INC")).toBe("aTyr Pharma Inc");
  expect(companyNameCase("iROBOT CORP")).toBe("iRobot Corp");
  // Lower case anywhere else is how the source means it.
  expect(companyNameCase("aTyr Pharma Inc")).toBe("aTyr Pharma Inc");
  expect(companyNameCase("eBay INC")).toBe("eBay INC");
});
