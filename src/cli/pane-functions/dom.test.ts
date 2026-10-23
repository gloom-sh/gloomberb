import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import type { ResolvedPaneFunction } from "./resolver";
import type { HeadlessPaneContext } from "../../types/headless";
import { assessPaneScreenshot, type PaneScreenshotResult } from "./screenshot";
import type { DesktopPaneShotPayload, DesktopPaneShotRenderResult } from "../desktop-pane-shot";
import { appendDomReportFooter, buildDomPaneReportFromRender, domReportNote, domReportView } from "./dom";
import { getPaneFunctionCapability } from "./capabilities";
import { researchModule } from "../../plugins/builtin/research";
import { filingEventsModule } from "../../plugins/builtin/filing-events";
import { renderReportCsv } from "../report-tables";
import { formatFreshnessLine } from "./freshness";
import { reportFailure } from ".";

// The status line names the year only when it is not the current one.
beforeAll(() => setSystemTime(new Date("2026-10-10T12:00:00Z")));
afterAll(() => setSystemTime());

test("marks rendered reports as truncated when a visible cell contains an ellipsis", async () => {
  const resolved = {
    token: "INS",
    label: "Insider",
    pane: { id: "insider" },
    capability: { id: "insider-pane" },
    options: {},
  } as unknown as ResolvedPaneFunction;
  const screenshot = {
    symbols: ["AVGO"],
    render: {
      visibleText: "NVIDIA Corporati…",
      rows: [{
        tableIndex: 0,
        rowIndex: 0,
        selected: false,
        cells: [{ columnLabel: "Issuer", text: "NVIDIA Corporati…" }],
      }],
      truncated: false,
      truncationReasons: [],
      loadingStateDetected: false,
      errorStateDetected: false,
      errorStateMarkers: [],
      emptyStateDetected: false,
      emptyStateMarkers: [],
    },
  } as unknown as PaneScreenshotResult;

  const report = await buildDomPaneReportFromRender(resolved, screenshot);
  expect(report.data).toMatchObject({
    kind: "rendered-view",
    rowCount: 1,
    truncated: true,
    complete: false,
    limitation: expect.stringContaining("visible"),
  });
});

test("keeps a cell under its own column when an earlier cell in the row is blank, and prints shortened times whole", async () => {
  const resolved = {
    token: "TOP", label: "Top News", options: {}, capability: { id: "news-top-pane" },
    pane: { id: "news-top", reportFreshness: { status: "not-a-feed", basis: "published stories" } },
  } as unknown as ResolvedPaneFunction;
  const cell = (columnId: string, columnLabel: string, text: string, instant?: string) => ({ columnId, columnLabel, text, ...(instant ? { instant } : {}) });
  const screenshot = {
    symbols: [],
    render: {
      visibleText: "",
      footerText: "15m delayed",
      rows: [
        // The pane shortens times to fit; the cell keeps the instant behind them.
        { tableIndex: 0, rowIndex: 0, selected: false, cells: [cell("time", "TIME", "Wed 11:27", "2026-10-07T11:27:00.000Z"), cell("title", "HEADLINE", "Deal"), cell("tickers", "TICKERS", "PSKY"), cell("categories", "CATEGORY", "M&A")] },
        // The DOM capture drops the blank TICKERS cell.
        { tableIndex: 0, rowIndex: 1, selected: false, cells: [cell("time", "TIME", "Oct 2", "2026-10-02T14:00:00.000Z"), cell("title", "HEADLINE", "Sanctions"), cell("categories", "CATEGORY", "Regulatory")] },
      ],
      truncated: false,
      truncationReasons: [],
      loadingStateDetected: false,
      errorStateDetected: false,
      errorStateMarkers: [],
      emptyStateDetected: false,
      emptyStateMarkers: [],
    },
  } as unknown as PaneScreenshotResult;

  const report = await buildDomPaneReportFromRender(resolved, screenshot);
  const lines = report.text.split("\n");
  const header = lines.find((line) => line.includes("HEADLINE"))!;
  const row = lines.find((line) => line.includes("Sanctions"))!;
  expect(row.indexOf("Regulatory")).toBe(header.indexOf("CATEGORY"));
  expect(lines.find((line) => line.includes("Deal"))).toContain("2026-10-07 11:27 UTC");
  expect(row).toContain("2026-10-02 14:00 UTC");
  // The pane's declaration says what the data is; a footer phrase does not turn it into a feed.
  expect(report.data.freshness).toMatchObject({ source: "Gloom Cloud", asOf: "2026-10-07T11:27:00.000Z", status: "not-a-feed" });
  // --csv writes the same columns, the blank cell empty and each time as the instant behind it.
  expect(renderReportCsv(report.tables).split("\n").slice(0, 5)).toEqual([
    "TIME,HEADLINE,TICKERS,CATEGORY",
    "2026-10-07T11:27:00.000Z,Deal,PSKY,M&A",
    "2026-10-02T14:00:00.000Z,Sanctions,,Regulatory",
    "",
    "# Source: Gloom Cloud · Wed 7 Oct 2026 11:27 UTC · not a live feed (published stories)",
  ]);
});

/**
 * An OMON capture of a 10-strike window centred on the money: the viewport
 * shows three rows, the table publishes all five it lists, and the pane says
 * how many of the expiry's strikes those are.
 */
function omonCapture() {
  const row = (strike: number, rowIndex: number) => ({
    tableIndex: 0, rowIndex, key: String(strike), selected: strike === 720,
    cells: [{ columnId: "callDelta", columnLabel: "C Δ", text: ".600" }, { columnId: "strike", columnLabel: "STRIKE", text: String(strike) }],
  });
  const notice = "5 of 145 strikes, 2 either side of the money (700 to 740). --strikes all lists every strike.";
  return {
    resolved: {
      token: "OMON", label: "Options", options: { strikes: "2" },
      pane: { id: "options" }, capability: { id: "options-pane", screenshotReadiness: "live-dom" },
    } as unknown as ResolvedPaneFunction,
    notice,
    render: {
      visibleText: "OMON META Strikes ±2 710 720 730",
      rows: [710, 720, 730].map(row),
      reportRows: [700, 710, 720, 730, 740].map(row),
      truncated: true,
      truncationReasons: ["rows above and below the rendered viewport are cut"],
      reportTruncationReasons: [],
      loadingStateDetected: false, errorStateDetected: false, errorStateMarkers: [],
      emptyStateDetected: false, emptyStateMarkers: [], visibleKeyValues: [],
      semanticUi: [{
        id: "ui:1", role: "report-notice", actions: [],
        metadata: { text: notice, key: "strikes", value: { window: "2", shown: 5, total: 145 } },
      }],
    },
  };
}

test("an OMON report reads every strike of its window past the viewport, and says how many of the expiry's it lists", async () => {
  const { resolved, render, notice } = omonCapture();
  const report = await buildDomPaneReportFromRender(resolved, { symbols: ["META"], render } as unknown as PaneScreenshotResult);
  expect(report.data).toMatchObject({
    rowCount: 5, complete: true, truncated: false, truncationReasons: [], everyRow: true,
    metadata: { strikes: { window: "2", shown: 5, total: 145 }, notices: [notice] },
  });
  expect(domReportNote(1, domReportView(report.data))).toContain("every row of the pane's table");
  expect((report.data.rows as Array<{ key: string }>).map((row) => row.key)).toEqual(["700", "710", "720", "730", "740"]);
  expect(report.text).toContain(notice);

  // A table read from the viewport alone stays incomplete, and says which side was cut.
  const viewportOnly = { ...render, reportRows: undefined, reportTruncationReasons: undefined };
  const clipped = await buildDomPaneReportFromRender(resolved, { symbols: ["META"], render: viewportOnly } as unknown as PaneScreenshotResult);
  expect(clipped.data).toMatchObject({ rowCount: 3, complete: false, truncationReasons: ["rows above and below the rendered viewport are cut"] });
  expect(domReportNote(1, domReportView(clipped.data))).toContain("The rendered view is clipped.");
});

test("an OMON shot names the rows its image cuts and how many strikes the window lists", () => {
  const { resolved, render, notice } = omonCapture();
  const shot = assessPaneScreenshot(resolved, { financials: [["META", {}]] } as unknown as DesktopPaneShotPayload,
    render as DesktopPaneShotRenderResult, "META", "/tmp/omon-shot-test.png");
  expect(shot.notices).toEqual([notice]);
  expect(shot.rowCount).toBe(3);
  expect(shot.render.truncationReasons).toEqual(["rows above and below the rendered viewport are cut"]);
});

test("states the expiry a rendered OMON shows and dates the report by the chain behind it", async () => {
  const resolved = {
    token: "OMON", label: "Options", options: { expiration: "2028-01-21" }, capability: { id: "options-pane" }, pane: { id: "options" },
  } as unknown as ResolvedPaneFunction;
  const screenshot = {
    symbols: ["AAPL"],
    render: {
      visibleText: "",
      // The capture keeps only warnings in the footer, so it never says delayed here.
      footerText: "",
      rows: [{ tableIndex: 0, rowIndex: 0, selected: false, cells: [{ columnLabel: "STRIKE", text: "340" }] }],
      semanticUi: [
        { id: "ui:1", role: "report-notice", actions: [], metadata: {
          text: "Expiry 2028-01-21 (469d)", key: "expiry", value: { date: "2028-01-21", daysToExpiry: 469 },
        } },
        { id: "ui:2", role: "report-freshness", actions: [], metadata: {
          asOf: "2026-10-09T19:59:59.999Z", status: "delayed", delayMinutes: 15,
        } },
      ],
      truncated: false,
      truncationReasons: [],
      loadingStateDetected: false,
      errorStateDetected: false,
      errorStateMarkers: [],
      emptyStateDetected: false,
      emptyStateMarkers: [],
    },
  } as unknown as PaneScreenshotResult;

  const report = await buildDomPaneReportFromRender(resolved, screenshot);
  expect(report.text.split("\n").slice(0, 3)).toEqual(["Options", "", "Expiry 2028-01-21 (469d)"]);
  expect(report.data.metadata).toMatchObject({ expiry: { date: "2028-01-21", daysToExpiry: 469 } });
  expect(formatFreshnessLine(report.data.freshness!)).toBe("Source: Gloom Cloud · Fri 9 Oct 2026 19:59 UTC · 15 min delayed");
  expect(renderReportCsv(report.tables)).toContain("# note: Expiry 2028-01-21 (469d)");
});

test("dates a rendered FXC by the observations behind its rates, in the report and in its JSON", async () => {
  const resolved = {
    token: "FXC", label: "FX Cross Rates", options: {}, capability: { id: "fx-matrix-pane" }, pane: { id: "fx-matrix" },
  } as unknown as ResolvedPaneFunction;
  // Saturday 12:00 UTC (the clock above): Friday's close for the euro, a quiet tick on Saturday morning for the rand.
  const observation = (currency: string, quoteTime: string) => ({
    currency, quoteTime, dataSource: "delayed", stale: false, sessionExchange: "CCY", marketState: "CLOSED",
  });
  const screenshot = {
    symbols: [],
    render: {
      visibleText: "",
      // The pane's own footer states its rates' ages, not their feed.
      footerText: "oldest rate 2026-10-09 21:29 UTC · fetched 5m ago",
      rows: [{ tableIndex: 0, rowIndex: 0, selected: false, cells: [{ columnLabel: "EUR", text: "1.1206" }] }],
      semanticUi: [{
        id: "ui:1", role: "report-freshness", actions: [], metadata: {
          observations: [observation("EUR", "2026-10-09T21:29:00.000Z"), observation("ZAR", "2026-10-10T04:21:11.000Z")],
        },
      }],
      truncated: false, truncationReasons: [], loadingStateDetected: false, errorStateDetected: false, errorStateMarkers: [],
      emptyStateDetected: false, emptyStateMarkers: [],
    },
  } as unknown as PaneScreenshotResult;

  const report = await buildDomPaneReportFromRender(resolved, screenshot);
  expect(formatFreshnessLine(report.data.freshness!)).toBe("Source: Gloom Cloud · FX trading day Fri 9 Oct 2026 close · delayed · markets closed");
  expect(report.data.freshness).toMatchObject({ status: "delayed", asOf: "2026-10-10T04:21:11.000Z", asOfClose: "2026-10-09", market: { state: "closed" } });
  expect(renderReportCsv(report.tables)).toContain("# Source: Gloom Cloud · FX trading day Fri 9 Oct 2026 close · delayed · markets closed");

  // A pane that publishes nothing keeps the unknown status in data, without filler in its line.
  const bare = { ...screenshot, render: { ...screenshot.render, semanticUi: [] } } as unknown as PaneScreenshotResult;
  const unknown = (await buildDomPaneReportFromRender(resolved, bare)).data.freshness!;
  expect(unknown.status).toBe("unreported");
  expect(formatFreshnessLine(unknown)).toMatch(/^Source: Gloom Cloud · retrieved .+ UTC$/);
});

test("a pane behind the sign-in wall reports what it needs instead of the wall's buttons, as its catalog entry does", async () => {
  const diagnostic = researchModule.panes!.find((pane) => pane.id === "equity-diagnostic")!;
  expect(getPaneFunctionCapability(undefined, diagnostic).dataRequirements).toEqual(["Free Gloom sign-in"]);

  const resolved = {
    token: "DIAG", label: "Equity Diagnostic", options: {}, capability: { id: "equity-diagnostic-pane" }, pane: diagnostic,
  } as unknown as ResolvedPaneFunction;
  const wall = async (visibleText: string) => (await buildDomPaneReportFromRender(resolved, {
    symbols: ["MSTR"],
    render: {
      visibleText, accessGate: "sign-in", rows: [], truncated: false, truncationReasons: [], loadingStateDetected: false,
      errorStateDetected: true, errorStateMarkers: ["Sign in to"], emptyStateDetected: false, emptyStateMarkers: [],
    },
  } as unknown as PaneScreenshotResult)).text;
  expect(await wall("DIAG MSTR Sign in to run the Equity Diagnostic. Log in \u21B5 Sign up free")).toBe([
    "Equity Diagnostic", "", "DIAG MSTR Sign in to run the Equity Diagnostic. Requires a free Gloom sign-in: log in or sign up in the app.",
  ].join("\n"));
  // Signed in with an unconfirmed address, the wall asks for the email instead.
  expect(await wall("DIAG MSTR Verify your email to run the Equity Diagnostic. Resend Verification Email")).toEndWith(
    "Verify your email to run the Equity Diagnostic. Requires a verified email on your Gloom account; resend the verification email in the app.",
  );
});

test("a pane walled whole cites no source, and one that says how to reach it says that instead of the wall", async () => {
  const ek = filingEventsModule.panes!.find((pane) => pane.id === "filing-events")!;
  const resolved = {
    token: "EK", label: "8-K Filings", options: {}, capability: { id: "filing-events-pane" }, pane: ek,
  } as unknown as ResolvedPaneFunction;
  // The SEC lists 8-Ks for NEM; ASML files 6-Ks, so its route would answer "No filings".
  const filings = { NEM: ["10-Q", "8-K"], ASML: ["6-K", "20-F"] } as Record<string, string[]>;
  const context = {
    marketData: {},
    apiClient: {
      getCloudSecFilings: async ({ ticker, forms }: { ticker: string; forms: string[] }) =>
        ({ filings: (filings[ticker] ?? []).filter((form) => forms.includes(form)).map((form) => ({ form })) }),
    },
  } as unknown as HeadlessPaneContext;
  const walled = (gate: "sign-in" | "pro", visibleText: string, symbol = "NEM") => buildDomPaneReportFromRender(resolved, {
    symbols: [symbol],
    render: {
      visibleText, accessGate: gate, rows: [], truncated: false, truncationReasons: [], loadingStateDetected: false,
      errorStateDetected: true, errorStateMarkers: [], emptyStateDetected: false, emptyStateMarkers: [],
    },
  } as unknown as PaneScreenshotResult, context);
  const signedOut = await walled("sign-in", "EK NEM Sign in to read 8-K filings. Log in \u21B5 Sign up free");
  expect(signedOut.data).toMatchObject({ locked: "sign-in", complete: false });
  expect(signedOut.data.freshness).toBeUndefined();
  expect(signedOut.data.reason).toContain("Free, with no sign-in: gloom fn SEC NEM lists NEM's recent filings");
  expect(signedOut.text).not.toContain("Sign up free");
  expect(signedOut.tables.footer.some((line) => /^Source:|^Retrieval time/.test(line))).toBe(false);
  const footer = appendDomReportFooter(signedOut.text, 10, domReportView(signedOut.data), signedOut.data.freshness);
  expect(footer).toEndWith("Rendered view: the pane is locked, so no values were read. Render time: 10 ms.");
  // On a free account the Pro wall stands in the same way, with the route that is left.
  const free = await walled("pro", "EK NEM 8-K filings are part of Gloom Cloud Pro. Upgrade");
  expect(free.data.locked).toBe("pro");
  expect(free.data.reason).toContain("On a free account it shows none of them.");
  expect(free.data.reason).toContain("upgrade in the app");
  // A company the route has nothing for gets no route rather than one that answers "No filings".
  const foreign = await walled("sign-in", "EK ASML Sign in to read 8-K filings. Log in", "ASML");
  expect(foreign.data.reason).not.toContain("Free, with no sign-in");
  expect(foreign.data.reason).toContain("To read them in EK");
});

test("a pane that is prose reads as the lines it draws, wrapped, without its own title and Back button, and whole once it grew to fit", async () => {
  const resolved = {
    token: "DOCS", label: "Docs", options: {}, capability: { id: "docs-pane" },
    pane: { id: "docs", shotFitsReader: true, reportFreshness: { status: "not-a-feed", basis: "documentation" } },
  } as unknown as ResolvedPaneFunction;
  const long = "Short interest as a share of float, days to cover, the change since the prior settlement and the month's price move across your portfolios and watchlists. Updates twice a month.";
  const lines = ["Docs", "Back", "SIW · Short squeeze watch", "Type", "SIW GME, AMC, CVNA", long, "•", "Ex-dividend dates", "Plan  Data and features", "Free  Delayed 15 minutes."];
  const report = (truncated: boolean) => buildDomPaneReportFromRender(resolved, {
    symbols: [],
    render: {
      visibleText: lines.join(" "), visibleLines: lines, rows: [], truncated, truncationReasons: truncated ? ["rows below the rendered viewport are cut"] : [],
      loadingStateDetected: false, errorStateDetected: false, errorStateMarkers: [], emptyStateDetected: false, emptyStateMarkers: [],
    },
  } as unknown as PaneScreenshotResult);
  const whole = await report(false);
  expect(whole.text).toBe([
    "Docs", "",
    "SIW · Short squeeze watch", "Type", "SIW GME, AMC, CVNA",
    // Wrapped at 100 columns where the terminal has no width; a list marker joins its item; aligned columns stay as drawn.
    ...[long.slice(0, long.lastIndexOf(" ", 100)), long.slice(long.lastIndexOf(" ", 100) + 1)],
    "• Ex-dividend dates", "Plan  Data and features", "Free  Delayed 15 minutes.",
  ].join("\n"));
  expect(domReportView(whole.data)).toBe("whole");
  expect(domReportNote(5, "whole")).toBe("Rendered view: the pane grown to fit the whole page. Render time: 5 ms.");
  // A page still cut once the pane has grown is not whole.
  expect(domReportView((await report(true)).data)).toBe("clipped");
});

test("a rendered pane with rows beside an error marker has data for its symbol and exits 0; one with none fails", async () => {
  const resolved = { token: "DES", label: "Description", pane: { id: "ticker-detail" }, capability: { id: "ticker-detail-pane" }, options: {} } as unknown as ResolvedPaneFunction;
  const render = (rows: unknown[]) => ({
    symbols: ["AAPL"],
    render: {
      visibleText: rows.length ? "Sector Technology Quote unavailable." : "Quote unavailable.", rows, truncated: false, truncationReasons: [],
      loadingStateDetected: false, errorStateDetected: true, errorStateMarkers: ["Quote unavailable."], emptyStateDetected: false, emptyStateMarkers: [],
    },
  }) as unknown as PaneScreenshotResult;
  const drawn = await buildDomPaneReportFromRender(resolved, render([{ tableIndex: 0, rowIndex: 0, selected: false,
    cells: [{ columnLabel: "Field", text: "Sector" }, { columnLabel: "Value", text: "Technology" }] }]));
  expect(drawn.data).toMatchObject({ unavailableSymbols: [], complete: false, reason: "The rendered pane reported: Quote unavailable." });
  expect(reportFailure(drawn.data, "fn DES AAPL", { tables: drawn.tables })).toBeNull();

  const bare = await buildDomPaneReportFromRender(resolved, render([]));
  expect(bare.data.unavailableSymbols).toEqual(["AAPL"]);
  expect(reportFailure(bare.data, "fn DES AAPL", { tables: bare.tables })?.code).toBe("no_data");
});
