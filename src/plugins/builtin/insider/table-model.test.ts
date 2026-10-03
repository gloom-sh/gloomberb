import { describe, expect, test } from "bun:test";
import type { SecFilingItem } from "../../../types/data-provider";
import { colors } from "../../../theme/colors";
import { DEFAULT_INSIDER_TYPE_FILTER, matchesInsiderTypeFilter, parseInsiderFiling, type ParsedInsiderFiling } from "./model";
import { buildInsiderColumns, buildInsiderTableRows, type InsiderColumn } from "./table-model";
import { renderInsiderCell } from "./table";

function filing(accessionNumber: string, form = "4"): SecFilingItem {
  return { accessionNumber, form, filingDate: new Date("2026-09-17T00:00:00Z"), cik: "1", filingUrl: `https://www.sec.gov/${accessionNumber}` };
}

function form4(owner: string, title: string, lines: string, { form = "4", plan }: { form?: string; plan?: boolean } = {}) {
  return `<ownershipDocument><documentType>${form}</documentType><reportingOwner><reportingOwnerId><rptOwnerCik>1</rptOwnerCik><rptOwnerName>${owner}</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isOfficer>1</isOfficer><officerTitle>${title}</officerTitle></reportingOwnerRelationship></reportingOwner>${plan === undefined ? "" : `<aff10b5One>${plan ? 1 : 0}</aff10b5One>`}${lines}</ownershipDocument>`;
}

function line(code: string, shares: number, price: number, security = "Common Stock", derivative = false) {
  const tag = derivative ? "derivativeTransaction" : "nonDerivativeTransaction";
  return `<${tag}><securityTitle><value>${security}</value></securityTitle><transactionDate><value>2026-09-15</value></transactionDate><transactionCoding><transactionCode>${code}</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>${shares}</value></transactionShares><transactionPricePerShare><value>${price}</value></transactionPricePerShare></transactionAmounts></${tag}>`;
}

const parsed: ParsedInsiderFiling[] = [
  ...parseInsiderFiling(filing("sale"), form4("Lund Deanna H", "EVP & CFO", line("S", 4100, 48.56), { plan: true })),
  ...parseInsiderFiling(filing("buy"), form4("BOURLA ALBERT", "Chairman & CEO", line("P", 38_000, 26.34), { plan: false })),
  // The 10b5-1 box covers the whole form, but marks only its open-market trades.
  ...parseInsiderFiling(filing("award"), form4("Carrai Phillip D", "President, STC Division", line("A", 1200, 0, "Restricted Stock Unit", true), { plan: true })),
  ...parseInsiderFiling(filing("amended", "4/A"), form4("O'BRIEN DEIRDRE", "Senior Vice President", line("S", 900, 255.12), { form: "4/A" })),
  ...parseInsiderFiling(filing("notice"), form4("Mendoza Marie", "SVP & General Counsel", "<remarks>No longer subject to Section 16.</remarks>")),
  ...parseInsiderFiling(filing("unread"), null),
  // Joint filers read as the first and how many more.
  ...parseInsiderFiling(filing("joint"), form4("BAKER BROS. ADVISORS LP", "", line("P", 5000, 20)).replace("</reportingOwner>", "</reportingOwner><reportingOwner><reportingOwnerId><rptOwnerCik>2</rptOwnerCik><rptOwnerName>BAKER FELIX</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isTenPercentOwner>1</isTenPercentOwner></reportingOwnerRelationship></reportingOwner>")),
  ...parseInsiderFiling(filing("loading"), null, true),
];

describe("insider table rows", () => {
  test("each line becomes name, role, type, markers and figures", () => {
    const rows = buildInsiderTableRows(parsed);
    expect(rows.slice(0, 4).map(({ name, role, type, tone, amended, plan, security, shares, price }) => ({ name, role, type, tone, amended, plan, security, shares, price }))).toEqual([
      { name: "Deanna H. Lund", role: "CFO", type: "SELL", tone: "sell", amended: false, plan: true, security: null, shares: 4100, price: 48.56 },
      { name: "Albert Bourla", role: "CEO", type: "BUY", tone: "buy", amended: false, plan: false, security: null, shares: 38_000, price: 26.34 },
      { name: "Phillip D. Carrai", role: "Div. Pres.", type: "AWARD", tone: "neutral", amended: false, plan: false, security: "RSU", shares: 1200, price: 0 },
      { name: "Deirdre O'Brien", role: "SVP", type: "SELL", tone: "sell", amended: true, plan: false, security: null, shares: 900, price: 255.12 },
    ]);
    expect(rows.slice(4).map(({ name, role, type }) => [name, role, type])).toEqual([
      ["Marie Mendoza", "GC", "NOTICE"], ["Unknown filer", "", "—"], ["BAKER BROS. ADVISORS LP +1", "10% owner", "BUY"], ["Loading...", "", ""],
    ]);
  });

  test("buys and sells keep the theme's gain and loss colour, on the selected row too; other lines are dim", () => {
    const rows = buildInsiderTableRows(parsed);
    const type: InsiderColumn = { id: "type", label: "Type", width: 12, align: "left" };
    expect(renderInsiderCell(rows[1]!, type, 0, { selected: false })).toMatchObject({ text: "BUY", color: colors.positive, keepColorWhenSelected: true });
    expect(renderInsiderCell(rows[2]!, type, 0, { selected: false })).toMatchObject({ text: "AWARD", color: colors.textDim });
    const selectedBuy = renderInsiderCell(rows[1]!, type, 0, { selected: true });
    expect(selectedBuy.keepColorWhenSelected).toBe(true);
    expect(selectedBuy.color).not.toBe(colors.textDim);
    // The 10b5-1 marker rides with a sale only when the column has room for it.
    expect(renderInsiderCell(rows[0]!, { ...type, plan: true }, 0, { selected: false }).text).toBe("SELL 10b5-1");
    expect(renderInsiderCell(rows[0]!, type, 0, { selected: false }).text).toBe("SELL");
    expect(renderInsiderCell(rows[3]!, type, 0, { selected: false }).text).toBe("SELL 4/A");
  });
});

describe("insider Type filter", () => {
  test("opens on open-market buys and sells; awards, notices and filings still being read sit elsewhere", () => {
    const shown = (filter: Parameters<typeof matchesInsiderTypeFilter>[1]) => parsed
      .filter((entry) => matchesInsiderTypeFilter(entry, filter))
      .map((entry) => entry.filing.accessionNumber);
    expect(DEFAULT_INSIDER_TYPE_FILTER).toBe("trades");
    // An unread filing may hide a trade, so it shows in both narrower views.
    expect(shown("trades")).toEqual(["sale", "buy", "amended", "unread", "joint"]);
    expect(shown("other")).toEqual(["award", "notice", "unread"]);
    expect(shown("all")).toHaveLength(parsed.length);
  });
});

describe("insider columns", () => {
  const rows = buildInsiderTableRows(parsed.slice(0, 4));
  const ids = (width: number) => buildInsiderColumns(width, rows).map((column) => column.id);
  const total = (width: number) => buildInsiderColumns(width, rows).reduce((sum, column) => sum + column.width + 1, 2);

  test("a wide pane shows every column, numbers right-aligned, and the security only for non-common lines", () => {
    const columns = buildInsiderColumns(120, rows);
    expect(columns.map((column) => column.id)).toEqual(["date", "insider", "role", "type", "security", "shares", "price", "value"]);
    expect(columns.filter((column) => column.align === "right").map((column) => column.id)).toEqual(["shares", "price", "value"]);
    expect(columns.find((column) => column.id === "type")?.plan).toBe(true);
    expect(buildInsiderColumns(120, rows.filter((row) => !row.security)).map((column) => column.id)).not.toContain("security");
  });

  test("narrower panes drop the role, then the price, the 10b5-1 marker, the security and the shares", () => {
    expect(ids(76)).toEqual(["date", "insider", "type", "security", "shares", "price", "value"]);
    expect(ids(66)).toEqual(["date", "insider", "type", "security", "shares", "value"]);
    expect(buildInsiderColumns(56, rows).find((column) => column.id === "type")?.plan).toBe(false);
    expect(ids(48)).toEqual(["date", "insider", "type", "value"]);
    for (const width of [120, 90, 76, 66, 56, 48, 40]) expect(total(width)).toBeLessThanOrEqual(width);
  });
});
