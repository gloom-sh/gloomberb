import { act, useReducer } from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { attachDocsPersistence, resetDocsPersistence, setDocsFetchForTests } from "../../../docs/load";
import { DOCS_FIXTURE_LESSON_URL, docsFeedFixture, docsLessonFixture } from "../../../docs/test-fixture";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { DocsPane } from "./pane";

const tui = createOpenTuiTestHarness();

afterEach(() => {
  setDocsFetchForTests(null);
  resetDocsPersistence();
});

/** The site, or none when `online` is false. */
function serve(online = true, opened: string[] = []) {
  resetDocsPersistence();
  attachDocsPersistence(new MemoryPluginPersistence());
  setDocsFetchForTests(async (url) => {
    if (!online) throw new Error("offline");
    if (url.includes("/academy/")) {
      opened.push(url);
      return docsLessonFixture();
    }
    return docsFeedFixture();
  });
}

function Harness({ topic, width, height }: { topic?: string; width: number; height: number }) {
  const id = "docs";
  const [state, dispatch] = useReducer(appReducer, createInitialState(createTestPaneConfig("/tmp/gloom-docs-test", {
    paneId: "docs",
    instanceId: id,
    binding: { kind: "none" },
    ...(topic ? { params: { topic, at: "1" } } : {}),
  })));
  return (
    <TestPaneFrame state={state} dispatch={dispatch} paneId={id} pluginId="application" runtime={createTestPluginRuntime()} width={width} height={height} footerKeys>
      {(body) => <DocsPane paneId={id} paneType="docs" {...body} focused />}
    </TestPaneFrame>
  );
}

async function mount(topic?: string, width = 96, height = 30) {
  await act(async () => { await tui.render(<Harness topic={topic} width={width} height={height} />, { width, height }); });
}

describe("DOCS in the terminal", () => {
  test("a pane's ? opens its entry, links stay in the reader, and Back walks the way back", async () => {
    const opened: string[] = [];
    serve(true, opened);
    await mount("fn:GP");
    const entry = await tui.waitForFrameToContain("GP · Price chart");
    expect(entry).toContain("Candles with volume");
    expect(entry).toContain("GP AAPL");
    expect(entry).toContain("Keys and shortcuts");

    await tui.clickFrameText("Academy: Reading a price chart (GP)");
    const lesson = await tui.waitForFrameToContain("A candle shows where the day opened");
    expect(lesson).toContain("One company and its price · 6 min");
    // Depth stays closed until asked for.
    expect(lesson).not.toContain("Hidden until opened.");
    expect(opened).toEqual([`https://gloom.sh/api/app-docs${DOCS_FIXTURE_LESSON_URL}`]);

    await tui.emitKeypress({ name: "escape" });
    await tui.waitForFrameToContain("GP · Price chart");
    await tui.emitKeypress({ name: "escape" });
    const index = await tui.waitForFrameToContain("Research companies");
    expect(index).toContain("Options chain");
    expect(index).not.toContain("GP · Price chart");
  });

  test("an unknown function says there are no docs for it, and searching finds nothing for nonsense", async () => {
    serve();
    await mount("fn:ZZQX");
    expect(await tui.waitForFrameToContain("No docs for ZZQX yet.")).toContain("Search the Docs");
    await act(async () => { await tui.render(<Harness topic="home:zzqx" width={96} height={30} />, { width: 96, height: 30 }); });
    expect(await tui.waitForFrameToContain("No docs match \"zzqx\".")).not.toContain("Options chain");
  });

  test("offline, the shipped docs read and say so, and a lesson never read asks for a connection", async () => {
    serve(false);
    await mount("fn:GP");
    const entry = await tui.waitForFrameToContain("GP · Price chart");
    expect(entry).toContain("offline, saved copy");
    await tui.clickFrameText("Academy: Reading a price chart");
    expect(await tui.waitForFrameToContain("This lesson is not saved for offline reading.")).toContain("Try Again");
  });
});
