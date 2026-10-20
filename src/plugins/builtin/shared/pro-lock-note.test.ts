import { expect, jest, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import type { HeadlessPaneContext } from "../../../types/headless";
import { estimateRevisionsLockNote } from "../estimate-revisions/lock-note";
import { explainRefusal, refusedLock } from "./cloud-denied";
import { proLockNote, type FreeRoute } from "./pro-lock-note";

const free: FreeRoute[] = [{ text: (ticker, company) => `gloomberb events ${ticker} lists ${company}'s earnings dates.` }];

test("a lock note says what the function is, what a free reader can still run, and how to unlock it, to the wall the reader is behind", async () => {
  const pane = { token: "CALLS", does: "it reads each call", shows: "it", free } as const;
  const signedOut = (await proLockNote({ gate: "sign-in", symbol: "KO" }, pane)).split("\n");
  expect(signedOut).toEqual([
    "CALLS is part of Gloom Cloud Pro: it reads each call. Signed out it shows none of it.",
    "Free, with no sign-in: gloomberb events KO lists KO's earnings dates.",
    "To read it in CALLS, open the app (gloomberb), log in or sign up from the command bar (Ctrl+P, Log In or Sign Up), then upgrade (Ctrl+P, UPGRADE); gloomberb fn CALLS KO then reads with that session.",
  ]);
  expect(await proLockNote({ gate: "sign-in", symbol: "KO", verifyEmail: true }, pane))
    .toContain("Until the email is verified it shows none of it.");
  expect(await proLockNote({ gate: "sign-in", symbol: "KO", verifyEmail: true }, pane))
    .toContain("verify your email (Ctrl+P, Resend Verification Email), then upgrade");
  expect(await proLockNote({ gate: "pro", symbol: null }, pane)).toContain("To read it in CALLS, upgrade in the app (gloomberb, then Ctrl+P, UPGRADE); gloomberb fn CALLS <ticker> then");
});

test("a function that needs only a sign-in says so, names no free route it does not have, and is Pro once the server refuses a plan", async () => {
  const pane = { token: "BUZZ", does: "it counts posts", shows: "it", needs: "sign-in" } as const;
  expect(await proLockNote({ gate: "sign-in", symbol: "KO" }, pane)).toBe([
    "BUZZ needs a free Gloom sign-in: it counts posts. Signed out it shows none of it.",
    "To read it in BUZZ, open the app (gloomberb), log in or sign up free from the command bar (Ctrl+P, Log In or Sign Up); gloomberb fn BUZZ KO then reads with that session.",
  ].join("\n"));
  expect(await proLockNote({ gate: "pro", symbol: "KO" }, pane)).toContain("BUZZ is part of Gloom Cloud Pro: it counts posts. On a free account");
});

test("the command that reads with a session repeats the ticker only where the function takes one and the reader gave one", async () => {
  const base = { token: "JOBS", does: "it reads jobs", shows: "it" } as const;
  expect(await proLockNote({ gate: "sign-in", symbol: null }, { ...base, argument: "optional" })).toContain("gloomberb fn JOBS then reads");
  expect(await proLockNote({ gate: "sign-in", symbol: "KO" }, { ...base, argument: "optional" })).toContain("gloomberb fn JOBS KO then reads");
  expect(await proLockNote({ gate: "sign-in", symbol: "KO" }, { ...base, argument: "none" })).toContain("gloomberb fn JOBS then reads");
  // A pane that serves several functions names the one that was run.
  expect(await proLockNote({ gate: "sign-in", symbol: "KO", token: "GUID" }, { ...base, token: "EM" })).toContain("GUID is part of Gloom Cloud Pro");
});

/** A data context whose GUIDE covers the guided symbols and whose SEC list holds the filers' 8-Ks; every read is kept. */
function routeData({ guided = [] as string[], eightKs = [] as string[], guidance }: {
  guided?: string[];
  eightKs?: string[];
  /** Answers GUIDE's read in place of the guided list: a stall, a failure. */
  guidance?: (symbol: string, signal?: AbortSignal) => Promise<unknown>;
}) {
  const reads: string[] = [];
  const context = {
    apiClient: {
      getCloudCompanyGuidance: async (symbol: string, _options: unknown, _listing: unknown, request?: { signal?: AbortSignal }) => {
        reads.push(`GUIDE ${symbol}`);
        return guidance ? guidance(symbol, request?.signal) : guidancePayload(symbol, guided.includes(symbol) ? 1 : 0);
      },
      getCloudSecFilings: async ({ ticker, forms, limit }: { ticker: string; forms: string[]; limit: number }) => {
        reads.push(`${forms.join(",")} ${ticker} limit ${limit}`);
        return { filings: eightKs.includes(ticker) && forms.includes("8-K") ? [{ form: "8-K" }] : [], hasMore: false };
      },
    },
    marketData: { getQuote: async () => { throw new Error("no quote"); } },
  } as unknown as HeadlessPaneContext;
  const note = (symbol: string) => estimateRevisionsLockNote({ gate: "sign-in", symbol, token: "GUID", context });
  return { reads, note };
}

/**
 * GLO-1054: GUID offered `fn GUIDE AAPL`, which answers "No data for AAPL:
 * not covered by GUIDE". A route is named only when it has data for the
 * symbol; otherwise the next one that does, or none.
 */
test("GUID names GUIDE only where GUIDE has guidance, else the company's 8-Ks, else no route", async () => {
  const { reads, note } = routeData({ guided: ["NVDA"], eightKs: ["NVDA", "AAPL"] });

  expect(await note("NVDA")).toContain("Free, with no sign-in: gloomberb fn GUIDE NVDA lists NVDA's latest guidance ranges");
  const apple = await note("AAPL");
  expect(apple).not.toContain("fn GUIDE");
  expect(apple).toContain("Free, with no sign-in: gloomberb filings AAPL --form 8-K lists AAPL's 8-Ks");
  expect(await note("ASML")).not.toContain("Free, with no sign-in");
  // A note asked for twice in a row (the error a read throws, then the report) checks once,
  // and whether a company files a form is one filtered filing, not its whole list.
  await note("AAPL");
  expect(reads).toEqual(["GUIDE NVDA", "8-K NVDA limit 1", "GUIDE AAPL", "8-K AAPL limit 1", "GUIDE ASML", "8-K ASML limit 1"]);
  // Without a ticker the route reads a placeholder, with nothing to check.
  expect(await estimateRevisionsLockNote({ gate: "sign-in", symbol: null, token: "GUID" })).toContain("gloomberb fn GUIDE <ticker>");
});

/**
 * A check against a service that never answers held `fn GUID AAPL` open for
 * good. The checks share one deadline; one still out then is no data for
 * that note only, as is one that failed.
 */
test("a route check that stalls past the deadline or fails is no data for that note, and is checked again for the next", async () => {
  jest.useFakeTimers();
  try {
    let guidance: "stall" | "fail" | "answer" = "stall";
    let stalledRead: AbortSignal | undefined;
    const { reads, note } = routeData({
      eightKs: ["MSFT"],
      guidance: async (symbol, signal) => {
        if (guidance === "stall") { stalledRead = signal; return new Promise(() => {}); }
        return guidance === "fail" ? Promise.reject(new Error("Service unavailable")) : guidancePayload(symbol, 1);
      },
    });
    let stalled = null as string | null;
    void note("MSFT").then((text) => { stalled = text; });
    await flushMicrotasks();
    jest.advanceTimersByTime(2_999);
    await flushMicrotasks();
    expect(stalled).toBeNull();
    jest.advanceTimersByTime(1);
    await flushMicrotasks();
    // GUIDE ran out of time, so the next route with data is named, and its read is called off
    // rather than left to hold the command's process open.
    expect(stalled).toContain("Free, with no sign-in: gloomberb filings MSFT --form 8-K");
    expect(stalledRead?.aborted).toBe(true);

    guidance = "fail";
    expect(await note("MSFT")).toContain("gloomberb filings MSFT --form 8-K");
    guidance = "answer";
    expect(await note("MSFT")).toContain("Free, with no sign-in: gloomberb fn GUIDE MSFT");
    // Neither the stall nor the failure was kept; the 8-K answer was.
    expect(reads).toEqual(["GUIDE MSFT", "8-K MSFT limit 1", "GUIDE MSFT", "GUIDE MSFT"]);
  } finally {
    jest.useRealTimers();
  }
});

async function flushMicrotasks() {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

function guidancePayload(symbol: string, rows: number) {
  const evidence = {
    id: "e1", documentId: "d1", sourceId: "s1", sourceKind: "press_release", url: "https://example.com/release", title: "Results",
    publishedAt: "2026-08-26T20:00:00Z", country: "US", language: "en", quote: "Revenue is expected to grow about 70%.",
    quoteOffset: 0, quoteSourceLength: 38, quoteMatchMode: "exact", confidence: 0.9,
  };
  const row = {
    id: "g1", symbol, metricId: "revenue_growth", metric: { id: "revenue_growth", name: "Revenue growth", definition: "Growth" },
    unit: "percent", basis: "reported", currency: null, dimensions: {}, asOf: "2026-08-26T20:00:00Z", seriesKey: "revenue_growth",
    period: { start: null, end: "2028-01-31", kind: "year", label: "FY2028", fiscalYear: 2028, fiscalQuarter: null },
    confidence: 0.9, revision: 0, supersedesId: null, current: true, evidence: [evidence], issuedDate: "2026-08-26",
    low: null, high: null, point: 70, midpointChangePct: null, hedge: "approximately", status: "active", rangeText: "≈ 70%",
    previousId: null, direction: "not_comparable", actual: null,
  };
  return {
    symbol, status: "available", asOf: "2026-08-26T20:00:00Z", access: "preview", lockedRows: 0, totalRows: rows, truncated: false,
    previewRows: rows, methodology: "Filed guidance", dictionary: [],
    coverage: { documents: rows, observations: 0, guidance: rows, conflicts: 0, languages: ["en"], sourceKinds: ["press_release"] },
    guidance: Array.from({ length: rows }, () => row), history: [],
  };
}

test("a refusal is found behind the errors written for the reader, and any other failure is no refusal", async () => {
  const refusal = (status: number) => new ApiRequestError("Refused", status);
  expect(refusedLock(refusal(401))).toEqual({ gate: "sign-in" });
  expect(refusedLock(refusal(403))).toEqual({ gate: "sign-in", verifyEmail: true });
  expect(refusedLock(refusal(402))).toEqual({ gate: "pro" });
  expect(refusedLock(new Error("Wrapped", { cause: new Error("Twice", { cause: refusal(402) }) }))).toEqual({ gate: "pro" });
  expect(refusedLock(refusal(500))).toBeNull();
  expect(refusedLock("402")).toBeNull();

  const note = () => "Line one\nline two";
  const explained = await explainRefusal(refusal(401), note, { symbol: null }) as Error;
  expect(explained.message).toBe("Line one line two");
  expect(explained.cause).toBeInstanceOf(ApiRequestError);
  const other = refusal(500);
  expect(await explainRefusal(other, note, { symbol: null })).toBe(other);
});
