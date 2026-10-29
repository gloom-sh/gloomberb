import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { act, useReducer } from "react";
import { apiClient } from "../../../api-client";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { flushPendingPersistence } from "../../../state/persist-scheduler";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { helpModule } from "./index";

const id = "help:test";
const HelpPane = helpModule.panes![0]!.component;
const tui = createOpenTuiTestHarness();
let dataDir = "";

function Harness() {
  const config = createTestPaneConfig(dataDir, { instanceId: id, paneId: "help", binding: { kind: "none" } });
  const initial = createInitialState(config);
  initial.focusedPaneId = id;
  const [state, dispatch] = useReducer(appReducer, initial);
  return (
    <TestPaneFrame state={state} dispatch={dispatch} paneId={id} pluginId="help" runtime={createTestPluginRuntime()} width={90} height={40}>
      {(body) => <HelpPane paneId={id} paneType="help" focused {...body} />}
    </TestPaneFrame>
  );
}

beforeEach(async () => {
  spyOn(apiClient, "getCloudPricing").mockRejectedValue(new Error("Fixture has no pricing"));
  dataDir = await mkdtemp(join(tmpdir(), "gloom-help-"));
});

afterEach(async () => {
  mock.restore();
  await flushPendingPersistence();
  await rm(dataDir, { recursive: true, force: true });
});

async function open(tab?: string) {
  await act(async () => { await tui.render(<Harness />, { width: 90, height: 40 }); });
  await tui.waitForFrameToContain("Try These");
  if (tab) {
    await act(async () => { await tui.clickFrameText(tab); });
    await tui.waitForFrameToContain("Command Bar (");
  }
  return tui.frame();
}

/** The column a header label starts at, where the table's descriptions start. */
const column = (text: string, label: string) => {
  const line = text.split("\n").find((row) => row.includes(label));
  return line ? line.indexOf(label) : -1;
};

test("Basics keeps Try These, one line about the search bar and Start Here; the command bar keys and the layout notes are in Reference", async () => {
  const basics = await open();
  expect(basics).toContain("Try These (5)");
  expect(basics).toContain("Not sure of a code?");
  expect(basics).toContain("Start Here (7)");
  for (const moved of ["Command Bar (", "Layout Basics", "How To Use Gloom", "Ctrl+Home/End", "Docked panes"]) expect(basics).not.toContain(moved);
  // The search-bar line comes between the two tables.
  expect(basics.indexOf("Try These")).toBeLessThan(basics.indexOf("Not sure of a code?"));
  expect(basics.indexOf("Not sure of a code?")).toBeLessThan(basics.indexOf("Start Here"));

  const reference = await open("Reference");
  expect(reference).toContain("Command Bar (");
  expect(reference).toContain("Navigation (");
  expect(reference).not.toContain("Try These");
});

test("every key table shares one key column, wide enough that no chip is cut", async () => {
  const basics = await open();
  const tryThese = column(basics, "OPENS");
  expect(tryThese).toBeGreaterThan(0);
  // Try These and Start Here describe from the same column.
  expect(column(basics, "DOES")).toBe(tryThese);

  const reference = await open("Reference");
  expect(column(reference, "DOES")).toBe(tryThese);
  // The longest chord of the command bar, which a 24-cell column cut to "Ctrl+Hor".
  expect(reference).toContain("PageUp/PageDown");
  expect(reference).toContain("Ctrl+Home/End");
});
