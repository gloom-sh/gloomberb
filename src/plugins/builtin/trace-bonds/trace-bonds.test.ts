import { afterEach, expect, test } from "bun:test";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { setCliWidthOverride, visibleLength } from "../../../utils/cli-output";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { bondTapeRequests, fetchBondTape, isCusip, noPrintsText, parseBondQuery, tapeIssuerName } from "./client";
import { traceBondsHeadless } from "./headless";
import { buildBondColumns } from "./model";

type Row = Record<string, unknown>;
type Filter = { fieldName: string; compareType: string; fieldValue: string | null };
interface Posted { filters: Filter[]; limit: number; token: string | null }

const TODAY = "2026-10-16";

const bond = (cusip: string, symbol: string, issuerName: string, lastTradeDate: string, extra: Row = {}): Row => ({
  cusip, issueSymbolIdentifier: symbol, issuerName, lastTradeDate, couponRate: 7.875, maturityDate: "2034-07-01",
  lastSalePrice: 88.055, lastSaleYield: 10.091, priceChangeNumber: -0.245, traceGradeCode: "H", ...extra,
});

/** The tape's two steps: a session cookie, then filtered POSTs that must echo it. An answer can be a whole response. */
function fakeTape(answer: (posted: Posted) => Row[] | Response): Posted[] {
  const posted: Posted[] = [];
  setHttpFetchTransport(async (_url, init) => {
    if (!init?.method) return new Response("", { headers: { "set-cookie": "XSRF-TOKEN=token-1; Path=/; Secure" } });
    const body = JSON.parse(String(init.body)) as { compareFilters: Filter[]; limit: number };
    const entry = { filters: body.compareFilters, limit: body.limit, token: new Headers(init.headers).get("X-XSRF-TOKEN") };
    posted.push(entry);
    const rows = answer(entry);
    if (rows instanceof Response) return rows;
    return Response.json(rows.length
      ? { status: "success", returnBody: { statusCode: 200, headers: { "Record-Total": [String(rows.length)] }, data: JSON.stringify(rows) } }
      : { status: "success", returnBody: { statusCode: 204, data: null } });
  });
  return posted;
}

const filterOn = (posted: Posted, field: string, type?: string) => posted.filters.find((filter) => (
  filter.fieldName === field && (!type || filter.compareType === type)
));
/** The date filter that leaves matured issues out, or the one that asks for perpetuals. */
const perpetual = (posted: Posted) => filterOn(posted, "maturityDate", "EQUAL")?.fieldValue === null;

async function report(argument: string, marketData = createTestDataProvider()) {
  const args = createTestHeadlessArgs({ argument, rawArgument: argument });
  const result = await traceBondsHeadless.load(args, createTestHeadlessContext({ marketData }));
  return { result, text: renderHeadlessPaneText(traceBondsHeadless, result, args, "TRACE") };
}

afterEach(() => {
  setHttpFetchTransport(null);
  setCliWidthOverride(null);
});

test("a CUSIP, a symbol root and a name each ask the tape for that issuer's live bonds", () => {
  expect(isCusip("963320BG0")).toBe(true);
  expect(isCusip("U9633LAB2")).toBe(true);
  // One wrong character fails the check digit, and a nine-letter word is not a CUSIP.
  expect(isCusip("963320BG1")).toBe(false);
  expect(parseBondQuery(" 963320bg0 ")).toEqual({ kind: "cusip", text: "963320bg0", cusip: "963320BG0" });
  expect(parseBondQuery("WHIRLPOOL CORP")).toMatchObject({ kind: "issuer", name: "WHIRLPOOL CORP", root: null, ticker: null });
  expect(parseBondQuery("brk.b")).toMatchObject({ root: null, ticker: "BRK.B" });
  expect(parseBondQuery("  ")).toBeNull();
  // What is typed is capped before it reaches the tape.
  expect(parseBondQuery("A".repeat(500))!.text).toHaveLength(80);

  // A CUSIP is that bond, matured or not.
  expect(bondTapeRequests(parseBondQuery("963320bg0"), TODAY).map((request): Filter[] => request.filters)).toEqual([[
    { fieldName: "cusip", compareType: "EQUAL", fieldValue: "963320BG0" },
    { fieldName: "lastTradeDate", compareType: "GREATER", fieldValue: "1900-01-01" },
  ]]);
  const whr: Filter[][] = bondTapeRequests(parseBondQuery("whr"), TODAY).map((request) => request.filters);
  // The name and the exact root, each for issues maturing after today and for perpetuals, which have no date.
  expect(whr).toEqual([
    [{ fieldName: "issuerName", compareType: "BEGINS_WITH", fieldValue: "WHR" }],
    [{ fieldName: "issuerName", compareType: "BEGINS_WITH", fieldValue: "WHR" }],
    [
      { fieldName: "issueSymbolIdentifier", compareType: "GREATER", fieldValue: "WHR-" },
      { fieldName: "issueSymbolIdentifier", compareType: "LESSER", fieldValue: "WHR:" },
    ],
    [
      { fieldName: "issueSymbolIdentifier", compareType: "GREATER", fieldValue: "WHR-" },
      { fieldName: "issueSymbolIdentifier", compareType: "LESSER", fieldValue: "WHR:" },
    ],
  ].map((filters, index) => [
    ...filters,
    index % 2 === 0
      ? { fieldName: "maturityDate", compareType: "GREATER", fieldValue: TODAY }
      : { fieldName: "maturityDate", compareType: "EQUAL", fieldValue: null },
    { fieldName: "lastTradeDate", compareType: "GREATER", fieldValue: "1900-01-01" },
  ]));
  // Two letters start GENERAL MOTORS and GEORGIA POWER; as a name they are a first word.
  expect(bondTapeRequests(parseBondQuery("ge"), TODAY)[0]!.filters[0]).toEqual({ fieldName: "issuerName", compareType: "BEGINS_WITH", fieldValue: "GE " });
  expect(bondTapeRequests(parseBondQuery("whirlpool corp"), TODAY)).toHaveLength(2);
  expect(tapeIssuerName("Cumulus Media Inc.")).toBe("CUMULUS MEDIA");
});

test("a longer root is held out before the page is cut, so the issuer's own bonds fill the hundred", async () => {
  // Were a longer root's newer prints let in, they would take the page and be cut after: here they are 60 of 160.
  const day = (index: number) => `2026-${String(9 - Math.floor(index / 28)).padStart(2, "0")}-${String(28 - (index % 28)).padStart(2, "0")}`;
  const posted = fakeTape((request) => {
    if (perpetual(request)) return [];
    if (filterOn(request, "issueSymbolIdentifier")) {
      return [
        ...Array.from({ length: 60 }, (_, index) => bond(`WHRL${String(index).padStart(4, "0")}5`, `WHRL${index}`, "ACME WIDGETS INC", "2026-10-16")),
        ...Array.from({ length: 40 }, (_, index) => bond(`963A${String(index).padStart(4, "0")}5`, `WHR${6_000_000 + index}`, "WHIRLPOOL CORP", day(index))),
      ];
    }
    return Array.from({ length: 70 }, (_, index) => bond(`963B${String(index).padStart(4, "0")}5`, `WHRG${7_000_000 + index}`, "WHR GROUP INC", day(index)));
  });
  const tape = await fetchBondTape("whr", { today: TODAY });
  expect(posted).toHaveLength(4);
  expect(posted.every((request) => request.token === "token-1" && request.limit === 100)).toBe(true);
  expect(tape.bonds).toHaveLength(100);
  expect(tape.bonds.filter((row) => row.issuerName === "ACME WIDGETS INC")).toEqual([]);
  // 110 matched the name or the root itself: the page says it is the first hundred.
  expect(tape.truncated).toBe(true);

  const { text } = await report("whr");
  expect(text).toContain("Notes: First 100 issues, newest last sale first.");
});

test("an issuer's matured bonds stay out, its perpetuals stay in, and a CUSIP shows its bond either way", async () => {
  const matured = bond("963320AT3", "WHR4100001", "WHIRLPOOL CORP", "2025-04-29", { maturityDate: "2025-05-01", lastSaleYield: 42.56 });
  const perpetualBond = bond("963320PP1", "WHR4100002", "WHIRLPOOL CORP", "2026-10-15", { maturityDate: null });
  const live = bond("963320BG0", "WHR6415676", "WHIRLPOOL CORP", "2026-10-16");
  // A tape that ignored the date filter: its matured row is still not shown.
  fakeTape((request) => filterOn(request, "cusip") ? [matured] : perpetual(request) ? [perpetualBond] : [live, matured]);
  const tape = await fetchBondTape("whirlpool", { today: TODAY });
  expect(tape.bonds.map((row) => row.cusip)).toEqual(["963320BG0", "963320PP1"]);
  expect((await fetchBondTape("963320AT3", { today: TODAY })).bonds.map((row) => row.lastSaleYield)).toEqual([42.56]);
});

test("one request failing leaves the others' rows, and a 204 with no body is no rows", async () => {
  fakeTape((request) => filterOn(request, "issuerName")
    ? new Response("upstream down", { status: 502 })
    : perpetual(request) ? new Response(null, { status: 204 }) : [bond("963320BG0", "WHR6415676", "WHIRLPOOL CORP", "2026-10-16")]);
  const tape = await fetchBondTape("whr", { today: TODAY });
  expect(tape.bonds.map((row) => row.cusip)).toEqual(["963320BG0"]);
  expect(tape.failures).toEqual(["Bond tape request failed (502): upstream down"]);
  const { result } = await report("whr");
  expect(result.errors).toEqual(["Bond tape request failed (502): upstream down"]);
  expect(result.complete).toBe(false);

  // Only when nothing answers does the load fail.
  fakeTape(() => new Response("upstream down", { status: 502 }));
  await expect(fetchBondTape("whr", { today: TODAY })).rejects.toThrow("Bond tape request failed (502)");
});

test("a ticker with no bonds of its own is asked once by its company's name, and an empty answer is its message alone", async () => {
  const cumulus = [
    bond("23110AAB2", "CUMU5000001", "CUMULUS MEDIA NEW HLDGS INC", "2026-07-27", { couponRate: 8, maturityDate: "2029-07-01" }),
  ];
  const posted = fakeTape((request) => request.filters.length === 1
    ? [bond("65334HAE2", "NXY3816446", "NEXEN INC", "2026-10-16")]
    : filterOn(request, "issuerName")?.fieldValue === "CUMULUS MEDIA" && !perpetual(request) ? cumulus : []);
  const quoted = createTestDataProvider({ getQuote: async (symbol) => createTestQuote({ symbol, name: "Cumulus Media Inc." }) });
  const found = await report("CMLSQ", quoted);
  expect(found.result.warnings).toEqual(["Showing bonds for CUMULUS MEDIA (Cumulus Media Inc.): none trade under CMLSQ."]);
  expect(found.text).toContain("CUMULUS MEDIA NEW HLDGS INC");
  // CMLSQ's name and root, then the company's name.
  expect(posted.map((request) => filterOn(request, "issuerName")?.fieldValue ?? filterOn(request, "issueSymbolIdentifier")?.fieldValue))
    .toEqual(["CMLSQ", "CMLSQ", "CMLSQ-", "CMLSQ-", "CUMULUS MEDIA", "CUMULUS MEDIA"]);

  // With no company to ask, or none on the tape, the market's latest day dates the empty answer.
  posted.length = 0;
  const empty = await report("CMLSQ", createTestDataProvider({
    getQuote: async (symbol) => createTestQuote({ symbol, name: symbol }),
  }));
  expect(posted.map((request) => request.limit)).toEqual([100, 100, 100, 100, 1]);
  // The message stands alone under the report's title, with no heading over nothing.
  expect(empty.text.split("\n").slice(0, 3)).toEqual(["Latest corporate and agency bond sales", "", "No prints for CMLSQ on 2026-10-16."]);
  expect(empty.text).not.toContain("Last sales");
  expect(empty.result.complete).toBe(true);
  expect(empty.result.errors).toBeUndefined();
  const tape = await fetchBondTape("ZZZQ", { today: TODAY, companyName: async () => "Nobody Holdings Inc." });
  expect(noPrintsText(tape.query!, tape.tradeDate, tape.issuer)).toBe("No prints for ZZZQ or NOBODY on 2026-10-16.");
  expect(noPrintsText(tape.query!, null)).toBe("No prints for ZZZQ.");
});

test("a failed issuer-name lookup leaves an empty report incomplete and names the failed check", async () => {
  fakeTape((request) => request.limit === 1
    ? [bond("65334HAE2", "NXY3816446", "NEXEN INC", "2026-10-16")]
    : []);
  const unavailable = createTestDataProvider({ getQuote: async () => { throw new Error("quote unavailable"); } });
  const { result, text } = await report("CMLSQ", unavailable);
  expect(result.complete).toBe(false);
  expect(result.errors).toEqual(["Issuer-name lookup failed."]);
  expect(result.metadata).toMatchObject({ matched: 0, tradeDate: "2026-10-16" });
  expect(text).toContain("Issuer-name lookup failed.");
});

test.each(["abort error", "caller signal", "resolved after cancellation"])("a cancelled issuer lookup stops without a failure report: %s", async (cancellation) => {
  const posted = fakeTape(() => []);
  const controller = new AbortController();
  const reason = new DOMException("Lookup cancelled", "AbortError");
  const companyName = async () => {
    if (cancellation !== "abort error") controller.abort(reason);
    if (cancellation === "resolved after cancellation") return "Example Industries Inc.";
    throw cancellation === "caller signal" ? new Error("request interrupted") : reason;
  };
  await expect(fetchBondTape("CMLSQ", { today: TODAY, signal: controller.signal, companyName })).rejects.toBe(reason);
  // Cancellation must not start a fallback issuer request or a market-date request.
  expect(posted).toHaveLength(4);
});

test("a narrow tape keeps coupon and maturity, and the trade date outlasts the CUSIP and yield", async () => {
  const ids = (width: number) => buildBondColumns(width).map((column) => column.id);
  expect(ids(56)).toEqual(["issuer", "coupon", "maturity", "price"]);
  expect(ids(72)).toEqual(["issuer", "coupon", "maturity", "price", "traded"]);
  expect(ids(80)).toEqual(["issuer", "coupon", "maturity", "price", "yield", "traded"]);
  expect(ids(95)).toEqual(["issuer", "cusip", "coupon", "maturity", "price", "yield", "traded"]);
  expect(ids(120)).toHaveLength(9);

  fakeTape((request) => perpetual(request) ? [] : [
    bond("963320BG0", "WHR6415676", "WHIRLPOOL CORP", "2026-10-16"),
    bond("963320BF2", "WHR6415678", "WHIRLPOOL CORP", "2026-10-16", { couponRate: 7.5, maturityDate: "2031-07-01" }),
  ]);
  setCliWidthOverride(56);
  const { text } = await report("whirlpool");
  const lines = text.split("\n");
  const header = lines.find((line) => line.includes("Issuer"))!;
  for (const name of ["Coupon", "Maturity", "Price"]) expect(header).toContain(name);
  // Two issues of one issuer stay apart by coupon and maturity, the CUSIP moved under each.
  expect(lines.find((line) => line.includes("7.875"))).toContain("2034-07-01");
  expect(lines.find((line) => line.includes("7.500"))).toContain("2031-07-01");
  expect(text).toContain("CUSIP 963320BG0");
  expect(lines.filter((line) => visibleLength(line) > 56)).toEqual([]);
});
