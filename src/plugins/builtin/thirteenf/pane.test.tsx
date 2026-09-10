import { afterEach, describe, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { emitKeypress as emitTuiKeypress, testRender, type TestKeyEvent } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createDefaultConfig } from "../../../types/config";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { ThirteenFPane } from "./pane";
import { TestPaneProvider } from "../../../test-support/pane";

const PANE_ID = "thirteenf-pane-test";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let latestState: AppState | null = null;

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup!.renderer.destroy();
    });
    testSetup = undefined;
  }
  latestState = null;
  setHttpFetchTransport(null);
});

function Harness() {
  const initialState = createInitialState(createDefaultConfig("/tmp/gloomberb-thirteenf-pane-test"));
  initialState.focusedPaneId = PANE_ID;
  const [state, dispatch] = useReducer(appReducer, initialState);
  latestState = state;

  return (
    <TestPaneProvider state={state} dispatch={dispatch} paneId={PANE_ID} pluginId="ticker-research" runtime={createTestPluginRuntime()}>
      <ThirteenFPane
        paneId={PANE_ID}
        paneType="thirteenf-funds"
        focused
        width={96}
        height={18}
      />
    </TestPaneProvider>
  );
}

async function renderFrames(count = 4) {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await testSetup!.renderOnce();
    });
  }
}

const emitKeypress = (event: TestKeyEvent) => emitTuiKeypress(testSetup!, event, { trackPropagation: true });

const emitKeypressBatch = (events: TestKeyEvent[]) => emitTuiKeypress(testSetup!, events, { trackPropagation: true });

function installAlpha13FTransport() {
  setHttpFetchTransport(async (url) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    if (path.endsWith("/topfunds")) {
      return json([
        { cik: "1", name: "Alpha Capital", period_of_report: "2026-03-31", pnl: null },
      ]);
    }
    if (path.endsWith("/forms")) {
      return json([
        {
          cik: "0000000001",
          accession_number: "0000000001-26-000001",
          submission_type: "13F-HR/A",
          period_of_report: "2026-03-31",
          filed_as_of_date: "2026-05-15",
          company_name: "Alpha Capital",
          table_value_total: 120,
          table_entry_total: 2,
          is_amendment: true,
          amendment_type: "RESTATEMENT",
          url: "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/filing.txt",
        },
        {
          cik: "0000000001",
          accession_number: "0000000001-25-000004",
          submission_type: "13F-HR",
          period_of_report: "2025-12-31",
          filed_as_of_date: "2026-02-14",
          company_name: "Alpha Capital",
          table_value_total: 100,
          table_entry_total: 2,
          is_amendment: false,
          url: "https://www.sec.gov/Archives/edgar/data/1/000000000125000004/filing.txt",
        },
      ]);
    }
    if (path.endsWith("/form")) {
      return json([
        {
          cik: "0000000001",
          accession_number: parsed.searchParams.get("accession_number"),
          name_of_issuer: "Apple Inc.",
          title_of_class: "COM",
          cusip: "037833100",
          ticker: "AAPL",
          value: 90,
          ssh_prnamt: 1000,
          ssh_prnamt_type: "SH",
          put_call: "CALL",
          investment_discretion: "SOLE",
          voting_authority_sole: 1000,
          voting_authority_shared: 0,
          voting_authority_none: 0,
        },
      ]);
    }
    return json([]);
  });
}

describe("ThirteenFPane", () => {
  test("keyboard navigation starts from the first rendered sorted row", async () => {
    setHttpFetchTransport(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/topfunds")) {
        return json([
          { cik: "3", name: "Zeta Capital", period_of_report: "2026-03-31", pnl: null },
          { cik: "1", name: "Alpha Capital", period_of_report: "2026-03-31", pnl: null },
          { cik: "2", name: "Beta Capital", period_of_report: "2026-03-31", pnl: null },
        ]);
      }
      return json([]);
    });

    await act(async () => {
      testSetup = await testRender(<Harness />, { width: 100, height: 20 });
    });
    await renderFrames();
    const frame = testSetup!.captureCharFrame();
    expect(frame.indexOf("Alpha Capital")).toBeLessThan(frame.indexOf("Beta Capital"));
    expect(frame.indexOf("Beta Capital")).toBeLessThan(frame.indexOf("Zeta Capital"));

    await emitKeypress({ name: "down", sequence: "\u001B[B" });
    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderFrames(2);

    expect(testSetup!.captureCharFrame()).toContain("Back Beta Capital");
    expect(
      latestState?.paneState[PANE_ID]?.pluginState?.thirteenf?.selectedId,
    ).toBeUndefined();
  });

  test("moves from the first fund row to search with Up", async () => {
    setHttpFetchTransport(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/topfunds")) {
        return json([
          { cik: "1", name: "Alpha Capital", period_of_report: "2026-03-31", pnl: null },
        ]);
      }
      return json([]);
    });

    await act(async () => {
      testSetup = await testRender(<Harness />, { width: 100, height: 20 });
    });
    await renderFrames();

    await emitKeypress({ name: "up", sequence: "\u001B[A" });
    await act(async () => {
      await testSetup!.mockInput.typeText("BRK");
      await testSetup!.renderOnce();
    });
    await renderFrames(2);

    expect(testSetup!.captureCharFrame()).toContain("BRK");
  });

  test("rapid keyboard navigation activates the current rendered row", async () => {
    setHttpFetchTransport(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/topfunds")) {
        return json([
          { cik: "3", name: "Zeta Capital", period_of_report: "2026-03-31", pnl: null },
          { cik: "1", name: "Alpha Capital", period_of_report: "2026-03-31", pnl: null },
          { cik: "4", name: "Gamma Capital", period_of_report: "2026-03-31", pnl: null },
          { cik: "2", name: "Beta Capital", period_of_report: "2026-03-31", pnl: null },
        ]);
      }
      return json([]);
    });

    await act(async () => {
      testSetup = await testRender(<Harness />, { width: 100, height: 20 });
    });
    await renderFrames();

    await emitKeypressBatch([
      { name: "down", sequence: "\u001B[B" },
      { name: "down", sequence: "\u001B[B" },
      { name: "enter", sequence: "\r" },
    ]);
    await renderFrames(2);

    expect(testSetup!.captureCharFrame()).toContain("Back Gamma Capital");
    expect(
      latestState?.paneState[PANE_ID]?.pluginState?.thirteenf?.selectedId,
    ).toBeUndefined();
  });

  test("filing shortcut on a holding opens filing detail inside the pane", async () => {
    installAlpha13FTransport();

    await act(async () => {
      testSetup = await testRender(<Harness />, { width: 100, height: 24 });
    });
    await renderFrames();

    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderFrames(6);
    await emitKeypress({ name: "f", sequence: "f" });
    await renderFrames(6);

    const detailFrame = testSetup!.captureCharFrame();
    expect(detailFrame).toContain("Back 2026-03-31 filing");
    expect(detailFrame).toContain("Accession");
    expect(detailFrame).toContain("0000000001-26-000001");
    expect(detailFrame).toContain("Apple Inc.");

    await emitKeypress({ name: "backspace", sequence: "\u007f" });
    await renderFrames(2);

    const holdingsFrame = testSetup!.captureCharFrame();
    expect(holdingsFrame).toContain("Holdings");
    expect(holdingsFrame).toContain("AAPL");
    expect(holdingsFrame).not.toContain("Accession");
  });

  test("filing detail shows filing metadata and backspace returns to filings", async () => {
    installAlpha13FTransport();

    await act(async () => {
      testSetup = await testRender(<Harness />, { width: 100, height: 24 });
    });
    await renderFrames();

    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderFrames(6);
    await emitKeypress({ name: "right", sequence: "\u001B[C" });
    await renderFrames(2);
    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderFrames(6);

    const detailFrame = testSetup!.captureCharFrame();
    expect(detailFrame).toContain("Accession");
    expect(detailFrame).toContain("0000000001-26-000001");
    expect(detailFrame).toContain("RESTATEMENT");
    expect(detailFrame).toContain("Alpha Capital");
    expect(detailFrame).toContain("Apple Inc.");
    expect(detailFrame).toContain("CALL");
    expect(detailFrame).toContain("037833100");
    expect(detailFrame).toContain("SOLE");

    await emitKeypress({ name: "backspace", sequence: "\u007f" });
    await renderFrames(2);

    const filingsFrame = testSetup!.captureCharFrame();
    expect(filingsFrame).toContain("PERIOD");
    expect(filingsFrame).toContain("Restatement");
    expect(filingsFrame).toContain("Back Alpha Capital");
    expect(filingsFrame).not.toContain("Accession");
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
