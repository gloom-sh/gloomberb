import { afterEach, expect, test } from "bun:test";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { setCliWidthOverride, visibleLength } from "../../../utils/cli-output";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { bondTapeFilters, fetchBondTape, isCusip, noPrintsText, parseBondQuery } from "./client";
import { traceBondsHeadless } from "./headless";
import { buildBondColumns } from "./model";

type Row = Record<string, unknown>;
interface Posted { filters: Array<{ fieldName: string; compareType: string; fieldValue: string }>; limit: number; token: string | null }

const bond = (cusip: string, symbol: string, issuerName: string, lastTradeDate: string, extra: Row = {}): Row => ({
  cusip, issueSymbolIdentifier: symbol, issuerName, lastTradeDate, couponRate: 7.875, maturityDate: "2034-07-01",
  lastSalePrice: 88.055, lastSaleYield: 10.091, priceChangeNumber: -0.245, traceGradeCode: "H", ...extra,
});

/** The tape's two steps: a session cookie, then filtered POSTs that must echo it. */
function fakeTape(answer: (posted: Posted) => Row[]): Posted[] {
  const posted: Posted[] = [];
  setHttpFetchTransport(async (_url, init) => {
    if (!init?.method) return new Response("", { headers: { "set-cookie": "XSRF-TOKEN=token-1; Path=/; Secure" } });
    const body = JSON.parse(String(init.body)) as { compareFilters: Posted["filters"]; limit: number };
    const entry = { filters: body.compareFilters, limit: body.limit, token: new Headers(init.headers).get("X-XSRF-TOKEN") };
    posted.push(entry);
    const rows = answer(entry);
    return Response.json(rows.length
      ? { status: "success", returnBody: { statusCode: 200, data: JSON.stringify(rows) } }
      : { status: "success", returnBody: { statusCode: 204, data: null } });
  });
  return posted;
}

const filterOn = (posted: Posted, field: string) => posted.filters.find((filter) => filter.fieldName === field);

afterEach(() => {
  setHttpFetchTransport(null);
  setCliWidthOverride(null);
});

test("a CUSIP, a symbol and a name each ask the tape for that issuer", () => {
  expect(isCusip("963320BG0")).toBe(true);
  expect(isCusip("U9633LAB2")).toBe(true);
  // One wrong character fails the check digit, and a nine-letter word is not a CUSIP.
  expect(isCusip("963320BG1")).toBe(false);
  expect(parseBondQuery(" 963320bg0 ")).toEqual({ kind: "cusip", text: "963320bg0", cusip: "963320BG0" });
  expect(parseBondQuery("WHIRLPOOL")).toMatchObject({ kind: "issuer", name: "WHIRLPOOL", symbol: null });
  expect(parseBondQuery("  ")).toBeNull();

  expect(bondTapeFilters(parseBondQuery("963320bg0"))[0]).toContainEqual({ fieldName: "cusip", compareType: "EQUAL", fieldValue: "963320BG0" });
  const whr = bondTapeFilters(parseBondQuery("whr"));
  expect(whr.map((filters) => filters[0])).toEqual([
    { fieldName: "issuerName", compareType: "BEGINS_WITH", fieldValue: "WHR" },
    { fieldName: "issueSymbolIdentifier", compareType: "BEGINS_WITH", fieldValue: "WHR" },
  ]);
  // Every request leaves out issues that never traded.
  for (const filters of [...whr, ...bondTapeFilters(null)]) {
    expect(filters).toContainEqual({ fieldName: "lastTradeDate", compareType: "GREATER", fieldValue: "1900-01-01" });
  }
  expect(bondTapeFilters(parseBondQuery("whirlpool corp"))).toHaveLength(1);
});

test("an issuer's prints come from the tape, merged once, without a longer symbol root", async () => {
  const posted = fakeTape((request) => filterOn(request, "issueSymbolIdentifier")
    ? [
      bond("963320BG0", "WHR6415676", "WHIRLPOOL CORP", "2026-10-16"),
      bond("U9633LAB2", "WHR6415677", "WHIRLPOOL CORP", "2026-10-15"),
      bond("123456AB7", "WHRL1234567", "ACME WIDGETS INC", "2026-10-16"),
    ]
    : filterOn(request, "issuerName")
      ? [bond("963320BG0", "WHR6415676", "WHIRLPOOL CORP", "2026-10-16")]
      : []);
  const tape = await fetchBondTape("whr");
  expect(posted).toHaveLength(2);
  expect(posted.every((request) => request.token === "token-1" && request.limit === 100)).toBe(true);
  expect(tape.bonds.map((row) => row.cusip)).toEqual(["963320BG0", "U9633LAB2"]);
  expect(tape.tradeDate).toBe("2026-10-16");
});

test("no prints for a query says so for the market's latest day", async () => {
  const posted = fakeTape((request) => request.filters.length === 1
    ? [bond("65334HAE2", "NXY3816446", "NEXEN INC", "2026-10-16")]
    : []);
  const tape = await fetchBondTape("CMLSQ");
  expect(tape.bonds).toEqual([]);
  // The issuer's two requests, then one row of the market for its date.
  expect(posted.map((request) => request.limit)).toEqual([100, 100, 1]);
  expect(noPrintsText(tape.query!, tape.tradeDate)).toBe("No prints for CMLSQ on 2026-10-16.");
  expect(noPrintsText(tape.query!, null)).toBe("No prints for CMLSQ.");

  const args = createTestHeadlessArgs({ argument: "CMLSQ", rawArgument: "CMLSQ" });
  const result = await traceBondsHeadless.load(args, createTestHeadlessContext());
  expect(renderHeadlessPaneText(traceBondsHeadless, result, args, "TRACE")).toContain("No prints for CMLSQ on 2026-10-16.");
});

test("at 56 columns coupon and maturity survive in the pane and the text report alike", async () => {
  // The pane drops columns: grade, change, trade date, CUSIP and yield give way first.
  expect(buildBondColumns(56).map((column) => column.id)).toEqual(["issuer", "coupon", "maturity", "price"]);
  expect(buildBondColumns(80).map((column) => column.id)).toEqual(["issuer", "cusip", "coupon", "maturity", "price", "yield"]);
  expect(buildBondColumns(120)).toHaveLength(9);

  fakeTape(() => [
    bond("963320BG0", "WHR6415676", "WHIRLPOOL CORP", "2026-10-16"),
    bond("963320BF2", "WHR6415678", "WHIRLPOOL CORP", "2026-10-16", { couponRate: 7.5, maturityDate: "2031-07-01" }),
  ]);
  setCliWidthOverride(56);
  const args = createTestHeadlessArgs({ argument: "whirlpool", rawArgument: "whirlpool" });
  const text = renderHeadlessPaneText(traceBondsHeadless, await traceBondsHeadless.load(args, createTestHeadlessContext()), args, "TRACE");
  const lines = text.split("\n");
  const header = lines.find((line) => line.includes("Issuer"))!;
  for (const name of ["Coupon", "Maturity", "Price"]) expect(header).toContain(name);
  // Two issues of one issuer stay apart by coupon and maturity, the CUSIP moved under each.
  expect(lines.find((line) => line.includes("7.875"))).toContain("2034-07-01");
  expect(lines.find((line) => line.includes("7.500"))).toContain("2031-07-01");
  expect(text).toContain("CUSIP 963320BG0");
  expect(lines.filter((line) => visibleLength(line) > 56)).toEqual([]);
});
