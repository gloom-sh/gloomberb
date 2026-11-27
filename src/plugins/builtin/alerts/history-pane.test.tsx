import { RGBA } from "@opentui/core";
import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { useTabCursorLink, type TabCursorLink } from "../../../state/app/tab-cursor";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createStatefulTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { getThemeColors } from "../../../theme/colors";
import { DEFAULT_THEME } from "../../../theme/themes";
import { ALERTS_PLUGIN_ID } from "./constants";
import { FIRED_LOG_KEY, type FiredAlert } from "./fired-log";
import { AlertHistoryPane } from "./history-pane";

const tui = createOpenTuiTestHarness();

/** An alert this app fired at `time` on 18 Apr 2026 UTC, named `Alert <id>` in its row. */
const fired = (id: string, time: string): FiredAlert => ({
  id, firedAt: `2026-04-18T${time}:00.000Z`, kind: "price", ruleId: `rule-${id}`, rule: `Alert ${id}`,
  value: 100, quoteAt: null, source: null, symbol: "AAPL",
});

async function mountHistory(log: FiredAlert[]) {
  const runtime = createStatefulTestPluginRuntime();
  runtime.setResumeState(ALERTS_PLUGIN_ID, FIRED_LOG_KEY, log);
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-alert-history-test", { instanceId: "alrt", paneId: "alerts" }));
  state.focusedPaneId = "alrt";
  let link: TabCursorLink | undefined;
  function Chart() {
    link = useTabCursorLink("chart");
    return null;
  }
  const settle = () => act(async () => { await tui.setup().renderOnce(); await tui.setup().renderOnce(); });
  await act(async () => {
    await tui.render(
      <TestPaneFrame state={state} paneId="alrt" pluginId={ALERTS_PLUGIN_ID} runtime={runtime} width={100} height={12}>
        {(body) => <><Chart /><AlertHistoryPane paneId="alrt" paneType="alerts" focused {...body} /></>}
      </TestPaneFrame>,
      { width: 100, height: 12 },
    );
  });
  await settle();
  const selectedText = RGBA.fromHex(getThemeColors(DEFAULT_THEME).selectedText).toInts();
  return {
    /** The alert drawn selected, by the id in its name. */
    selected(): string | null {
      const spans = tui.setup().captureSpans().lines.flatMap((line) => line.spans);
      const span = spans.find((entry) => /Alert \w+/.test(entry.text)
        && entry.fg.toInts().every((value, channel) => value === selectedText[channel]));
      return span ? /Alert (\w+)/.exec(span.text)![1]! : null;
    },
    async log(next: FiredAlert[]) {
      await act(async () => runtime.setResumeState(ALERTS_PLUGIN_ID, FIRED_LOG_KEY, next));
      await settle();
    },
    async pin(time: string | null) {
      await act(async () => link!.pin!(time === null ? null : Date.parse(`2026-04-18T${time}:00Z`)));
      await settle();
    },
    /** Moves the selection a row down, and waits out the table's commit of a quick second move. */
    async down() {
      await tui.emitKeypress({ name: "down", sequence: "\u001b[B" }, { frames: 2, afterCommit: true });
      await act(async () => { await Bun.sleep(200); });
      await settle();
    },
  };
}

// History goes by alert id, so an alert going off above the picked one leaves
// it picked. The pin's alert, picked with nothing picked before, is a pick
// too; and a picked alert that goes out of the log gives way to the pin's.
test("History keeps the picked alert as alerts arrive, and the pin's when the picked one goes out", async () => {
  const a = fired("A", "16:00"), b = fired("B", "14:30"), c = fired("C", "12:00");
  const history = await mountHistory([a, b, c]);
  try {
    expect(history.selected()).toBe("A");
    await history.down();
    expect(history.selected()).toBe("B");
    await history.log([fired("X", "17:00"), a, b, c]);
    expect(history.selected()).toBe("B");

    // Under a pin at 16:30 the selection goes to A, the alert out by then,
    // and stays there as one more alert goes off.
    await history.pin("16:30");
    expect(history.selected()).toBe("A");
    await history.log([fired("Y", "17:30"), fired("X", "17:00"), a, b, c]);
    expect(history.selected()).toBe("A");

    // A picked alert that leaves the log hands the selection to the pin's
    // alert (A), not to the top row or the row that took its place.
    await history.down();
    expect(history.selected()).toBe("B");
    await history.log([fired("Y", "17:30"), fired("X", "17:00"), a, c]);
    expect(history.selected()).toBe("A");
  } finally {
    await history.pin(null);
  }
});

test("History commits the pin's alert when it was the first row shown, so an alert going off cannot take its place", async () => {
  const a = fired("A", "16:00"), b = fired("B", "14:30");
  const history = await mountHistory([a, b]);
  try {
    await history.pin("16:30");
    expect(history.selected()).toBe("A");
    await history.log([fired("X", "17:00"), a, b]);
    expect(history.selected()).toBe("A");
  } finally {
    await history.pin(null);
  }
});
