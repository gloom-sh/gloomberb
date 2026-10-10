import { describe, expect, test } from "bun:test";
import type { ASKGToolRow, ASKGTurn } from "./model";
import { describeToolRow, type ToolDisplayContext } from "./tool-display";
import { toolGroupId, turnTimelineIds } from "./tool-timeline";

const IBKR = "broker:signed-in-interactive-brokers:ibkr";
const context: ToolDisplayContext = {
  collectionName: (id) => (id === IBKR ? "Interactive Brokers U7654321" : null),
};

function row(patch: Partial<ASKGToolRow>): ASKGToolRow {
  return {
    toolCallId: "call",
    name: "pf",
    argumentSummary: "",
    writeTier: "read",
    origin: "client",
    status: "ok",
    requiresConfirmation: false,
    expanded: false,
    ...patch,
  };
}

/** Everything a row puts on screen, folded or open. */
function shown(view: ReturnType<typeof describeToolRow>): string {
  return [view.title, view.subject, view.meta, view.line ?? "", ...view.details].join("\n");
}

describe("describeToolRow", () => {
  test("a partial holdings result says how many positions are missing in one line, and names the portfolio", () => {
    const view = describeToolRow(row({
      args: { text: IBKR, limit: 200 },
      status: "partial",
      rowCount: 94,
      elapsedMs: 1_240,
      note: "No market value or P&L for 700, 7203, SQ; totals and weights leave them out",
    }), context);

    expect(view).toMatchObject({
      title: "Holdings",
      subject: "Interactive Brokers U7654321",
      meta: "94 rows · 1.2 s",
      mark: "partial",
      line: "3 of 94 positions had no price",
      details: ["No price for 700, 7203, SQ, so totals leave them out"],
    });
  });

  test("the risk note's wall becomes one coverage line; service errors and model pointers never show", () => {
    const view = describeToolRow(row({
      name: "port",
      args: { text: IBKR, view: "risk", "equity-shift": -10 },
      status: "partial",
      rowCount: 8,
      elapsedMs: 3_400,
      note: "Quote listing differs from the requested holding (ARKK, SHOP, WMT, IEF); Treasury yield: Internal server error; "
        + "Volatility: Internal server error; Basket covers at most 94% of market value · 7 holdings left out; "
        + "metadata.coverage lists each with its reason; 3 holdings had no current quote; weighted at the latest completed close; and 1 more",
    }), context);

    expect(view.subject).toBe("Interactive Brokers U7654321 · risk");
    expect(view.line).toBe("Risk covers up to 94% of the portfolio's value · 7 holdings left out");
    expect(view.details).toContain("Treasury yield unavailable");
    expect(view.details).toContain("3 holdings had no current quote, weighted at the latest completed close");
    const text = shown(view);
    expect(text).not.toMatch(/metadata|Internal server error|and 1 more|broker:/);
  });

  test("a partial result whose only gaps are services Gloom worked around reads as a plain result", () => {
    const view = describeToolRow(row({
      name: "port",
      status: "partial",
      rowCount: 8,
      note: "Treasury yield: Internal server error; Volatility: HTTP 503",
    }), context);

    expect(view.line).toBeNull();
    expect(view.details).toEqual(["Treasury yield unavailable", "Volatility unavailable"]);
  });

  test("a failure is one human line: no payloads, codes or ids", () => {
    const failed = (note: string, status: ASKGToolRow["status"] = "error") => describeToolRow(row({ status, note, rowCount: 3 }), context);

    expect(failed('Request failed: {"type":"validation","code":"E_BAD"}')).toMatchObject({ mark: "failed", line: "Could not load this", meta: "" });
    expect(failed("Unknown local portfolio: default").line).toBe("Unknown local portfolio: default");
    expect(failed("Tool call timed out.", "timeout").line).toBe("Took too long to answer");
    expect(failed("Took too long, so Gloom answered without it.", "timeout").line).toBe("Took too long, so Gloom answered without it");
    expect(failed("You declined this action.", "denied")).toMatchObject({ mark: "declined", line: "You declined this" });
    expect(failed('"pane.show" was not accepted by this session.', "denied").line).toBe("Not available in this window");
  });

  test("a server tool is named in words, and its note stays a caveat rather than a subject", () => {
    const server = (patch: Partial<ASKGToolRow>) => describeToolRow(row({ origin: "server", ...patch }));
    expect(server({ name: "macro.yield_curve", rowCount: 11, elapsedMs: 420 }))
      .toMatchObject({ title: "Yield curve", subject: "", meta: "11 rows · 420 ms", mark: "ok", line: null });
    expect(server({
      name: "company.corporate_actions",
      status: "partial",
      argumentSummary: "Returned 26 of at least 152 rows.",
      note: "Returned 26 of at least 152 rows.",
      rowCount: 26,
    })).toMatchObject({ title: "Corporate actions", subject: "", line: "Returned 26 of at least 152 rows" });
    expect(server({ name: "market.quotes", status: "error", note: "The market.quotes tool failed." }).line).toBe("Could not load this");
  });
});

describe("turnTimelineIds", () => {
  const turn = (status: ASKGTurn["status"], calls: number): ASKGTurn => ({
    id: "turn-1",
    remoteTurnId: null,
    prompt: "q",
    answer: "",
    status,
    error: null,
    startedAt: 0,
    tools: [
      ...Array.from({ length: calls }, (_, index) => row({ toolCallId: `call-${index}`, status: "ok" })),
      row({ toolCallId: "script", name: "run_script", origin: "server", status: "ok", note: `${calls} calls, 6.3 s` }),
    ],
  });

  test("a finished turn with many calls folds into one line, and opens to its calls without the script row", () => {
    expect(turnTimelineIds(turn("complete", 6), new Set())).toEqual([toolGroupId("turn-1")]);
    expect(turnTimelineIds(turn("complete", 6), new Set([toolGroupId("turn-1")]))).toEqual([
      toolGroupId("turn-1"),
      ...Array.from({ length: 6 }, (_, index) => `call-${index}`),
    ]);
  });

  test("calls stay listed while the answer streams, and a short turn is never folded", () => {
    expect(turnTimelineIds(turn("streaming", 6), new Set())).toHaveLength(6);
    expect(turnTimelineIds(turn("complete", 3), new Set())).toEqual(["call-0", "call-1", "call-2"]);
  });
});
