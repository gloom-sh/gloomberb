import { afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../api-client";
import type { FailsToDeliverPayload } from "../../../api-client/short-side-publications";
import { createOpenTuiTestHarness, settleFrame, takeSavedTextFile } from "../../../renderers/opentui/test-utils";
import { TestPaneProvider, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createInitialState } from "../../../state/app/context";
import { exportPaneTable } from "../../../state/pane-table-export-registry";
import { publicationCache } from "./publications-client";
import { ShortSidePublicationPane } from "./publications-pane";

const tui = createOpenTuiTestHarness();
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.(); restore = undefined;
  publicationCache.reset();
});

const SECURITY = "GAMESTOP CORP (HLDG CO) CL A";
function payload(rows: Array<[date: string, cusip: string, description: string]>): FailsToDeliverPayload {
  return { symbol: "GME", status: "available", asOf: rows.at(-1)![0], sourceAsOf: rows.at(-1)![0], fetchedAt: "2026-10-15T12:00:00Z", loadedAt: "2026-10-14T12:00:00Z",
    source: { name: "SEC", url: "https://www.sec.gov/data-research/sec-markets-data/fails-deliver-data", cadence: "twice monthly" }, warnings: [],
    coverage: { from: rows[0]![0], to: rows.at(-1)![0], publications: rows.length },
    history: rows.map(([date, cusip, description], index) => ({ date, cusip, quantity: 1000 * (index + 1), price: 20 + index, description, sourceUrl: "https://www.sec.gov/files/ftd.zip" })) };
}
const count = (frame: string, text: string) => frame.split(text).length - 1;

async function mount(history: FailsToDeliverPayload) {
  const cloud = spyOn(apiClient, "getCloudFailsToDeliver").mockImplementation(async () => history);
  restore = () => cloud.mockRestore();
  const config = createTestPaneConfig("/tmp/short-interest-ftd-test-unused", { instanceId: "ftd", paneId: "short-interest" });
  const state = createInitialState(config); state.focusedPaneId = "ftd";
  state.paneState.ftd = { cursorSymbol: "GME" }; state.tickers.set("GME", createTestTicker("GME", "GameStop", { assetCategory: "STK" }));
  await act(async () => {
    await tui.render(<TestPaneProvider state={state} paneId="ftd" pluginId="short-interest" runtime={createTestPluginRuntime()}>
      <ShortSidePublicationPane kind="ftd" focused width={110} height={20} />
    </TestPaneProvider>, { width: 110, height: 20 });
  });
  await settleFrame(tui.setup(), 10);
  await tui.waitForFrameToContain("SETTLEMENT");
}

test("a ticker with one CUSIP says it and its security once, above the table and in the export, not on every row", async () => {
  await mount(payload([["2026-09-15", "36467W109", SECURITY], ["2026-09-30", "36467W109", SECURITY], ["2026-10-15", "36467W109", SECURITY]]));
  const frame = tui.frame();
  expect(count(frame, "36467W109")).toBe(1);
  expect(count(frame, SECURITY)).toBe(1);
  expect(frame).not.toContain("SECURITY");
  expect(frame).toContain("2026-10-15");
  await exportPaneTable("ftd", "fails.csv");
  const csv = takeSavedTextFile()!.text;
  expect(csv.split("\n")[0]).not.toContain("CUSIP");
  expect(csv).toContain("cusip,36467W109");
  expect(csv).toContain(`security,${SECURITY}`);
});

test("a ticker with several CUSIPs keeps the CUSIP and security columns", async () => {
  await mount(payload([["2026-09-15", "36467W109", SECURITY], ["2026-09-15", "36467W999", "GAMESTOP CORP WT"], ["2026-10-15", "36467W109", SECURITY]]));
  const frame = tui.frame();
  expect(frame).toContain("CUSIP");
  expect(frame).toContain("SECURITY");
  expect(count(frame, "36467W109")).toBe(2);
  expect(frame).toContain("36467W999");
  await exportPaneTable("ftd", "fails.csv");
  const csv = takeSavedTextFile()!.text;
  expect(csv.split("\n")[0]).toContain("CUSIP");
  expect(csv).not.toContain("cusip,36467W109");
});
