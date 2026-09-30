import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { useShortcut } from "../../../react/input";
import { Input, type InputRenderable } from "../../../ui";
import { SeriesEditorDialog } from "./editor";
import {
  appendChartSeries,
  buildFundamentalChartPreset,
  buildPriceChartPreset,
  parseSeriesExpression,
} from "./presets";

const tui = createOpenTuiTestHarness();

async function emitKey(
  name: string,
  sequence: string,
  overrides: Partial<{ shift: boolean }> = {},
) {
  await tui.emitKeypress({ name, sequence, shift: overrides.shift ?? false }, { trackPropagation: true });
}

const { waitForFrameToContain } = tui;

describe("chart composer series editor", () => {
  test("focuses its catalog quick-add outside the app-state root", async () => {
    await tui.render(
      <SeriesEditorDialog
        dialogId="series-editor-test"
        initialSpec={buildPriceChartPreset("AAPL")}
        dismiss={() => {}}
        resolve={() => {}}
      />,
      { width: 92, height: 42 },
    );

    await act(async () => {
      await tui.setup().renderOnce();
    });
    const frame = tui.frame();
    expect(frame).toContain("Add a series");
    expect(frame).toContain("AAPL:market.ohlcv");

    await act(async () => {
      await tui.setup().mockInput.typeText("MSFT revenue");
      await tui.setup().renderOnce();
    });

    await waitForFrameToContain("MSFT · Revenue");

    await emitKey("enter", "\r");
    await emitKey("a", "a");
    await act(async () => {
      await Bun.sleep(80);
      await tui.setup().mockInput.typeText("AAPL free cash flow");
      await tui.setup().renderOnce();
    });

    const secondAddFrame = await waitForFrameToContain("AAPL · Free Cash Flow");
    expect(secondAddFrame).toContain("AAPL free cash flow");
    expect(secondAddFrame).toContain("AAPL · Free Cash Flow");
    expect(secondAddFrame).not.toContain("MSFT revenueAAPL");
  });

  test("keeps the final series when removal is requested", async () => {
    let resolved = undefined as ReturnType<typeof buildPriceChartPreset> | null | undefined;
    await tui.render(
      <SeriesEditorDialog
        dialogId="series-editor-last-series-test"
        initialSpec={buildPriceChartPreset("AAPL")}
        dismiss={() => {}}
        resolve={(next) => {
          resolved = next;
        }}
      />,
      { width: 92, height: 42 },
    );

    await act(async () => {
      await tui.setup().renderOnce();
    });
    const frame = tui.frame();
    const rows = frame.split("\n");
    const actionRow = rows.findIndex((line) => line.includes("Remove") && line.includes("Save"));
    expect(actionRow).toBeGreaterThan(0);
    const removeColumn = rows[actionRow]!.indexOf("Remove");
    const saveColumn = rows[actionRow]!.indexOf("Save");
    expect(removeColumn).toBeGreaterThan(0);
    expect(saveColumn).toBeGreaterThan(removeColumn);

    await act(async () => {
      await tui.setup().mockMouse.click(removeColumn, actionRow);
      await tui.setup().mockMouse.click(saveColumn, actionRow);
      await tui.setup().renderOnce();
    });

    expect(resolved?.series).toHaveLength(1);
    expect(resolved?.series[0]?.source).toMatchObject({
      kind: "security",
      instrument: { symbol: "AAPL" },
    });
  });

  test("edits financial timing independently from style", async () => {
    let resolved: ReturnType<typeof buildFundamentalChartPreset> | null | undefined;
    await tui.render(
      <SeriesEditorDialog
        dialogId="series-editor-timing-test"
        initialSpec={buildFundamentalChartPreset(["AAPL"])}
        dismiss={() => {}}
        resolve={(next) => {
          resolved = next;
        }}
      />,
      { width: 92, height: 48 },
    );

    await act(async () => {
      await tui.setup().renderOnce();
    });
    const rows = tui.frame().split("\n");
    const timingLabelRow = rows.findIndex((line) => line.includes("Timing"));
    const timingRow = timingLabelRow + 1;
    const availableColumn = rows[timingRow]?.indexOf("Available Date") ?? -1;
    const styleLabelRow = rows.findIndex((line) => line.trim() === "Style");
    const styleRow = styleLabelRow + 1;
    const lineColumn = rows[styleRow]?.indexOf("Line") ?? -1;
    const actionRow = rows.findIndex((line) => line.includes("Remove") && line.includes("Save"));
    const saveColumn = rows[actionRow]?.indexOf("Save") ?? -1;
    expect(timingLabelRow).toBeGreaterThan(0);
    expect(availableColumn).toBeGreaterThan(0);
    expect(styleLabelRow).toBeGreaterThan(0);
    expect(lineColumn).toBeGreaterThan(0);
    expect(saveColumn).toBeGreaterThan(0);

    await act(async () => {
      await tui.setup().mockMouse.click(availableColumn + 1, timingRow);
      await tui.setup().renderOnce();
    });
    await act(async () => {
      await tui.setup().mockMouse.click(lineColumn + 1, styleRow);
      await tui.setup().renderOnce();
    });
    await act(async () => {
      await tui.setup().mockMouse.click(saveColumn + 1, actionRow);
      await tui.setup().renderOnce();
    });

    expect(resolved?.series[0]).toMatchObject({
      style: "line",
      source: { kind: "security", timestampMode: "available-at" },
    });
  });

  test("dismisses the editor from the initially focused quick-add with Escape", async () => {
    let resolved: ReturnType<typeof buildPriceChartPreset> | null | undefined;
    await tui.render(
      <SeriesEditorDialog
        dialogId="series-editor-escape-test"
        initialSpec={buildPriceChartPreset("AAPL")}
        dismiss={() => {}}
        resolve={(next) => {
          resolved = next;
        }}
      />,
      { width: 92, height: 42 },
    );

    await act(async () => {
      await tui.setup().renderOnce();
    });
    await emitKey("escape", "\u001b");
    expect(resolved).toBeNull();
  });

  test("tabs through add, series, and exact source without clearing the add query", async () => {
    const initialSpec = appendChartSeries(
      buildPriceChartPreset("AAPL"),
      parseSeriesExpression("MSFT")!,
    ).spec;
    await tui.render(
      <SeriesEditorDialog
        dialogId="series-editor-focus-order-test"
        initialSpec={initialSpec}
        dismiss={() => {}}
        resolve={() => {}}
      />,
      { width: 92, height: 42 },
    );

    await act(async () => {
      await tui.setup().renderOnce();
      await tui.setup().mockInput.typeText("revenue");
      await tui.setup().renderOnce();
    });
    expect(tui.frame()).toContain("› Add a series");

    await emitKey("tab", "\t");
    await emitKey("down", "\u001b[B");
    await emitKey("tab", "\t");
    let frame = await waitForFrameToContain("› Exact source (advanced)");
    expect(frame).toContain("revenue");
    expect(frame).toContain("› Exact source (advanced)");
    expect(frame).toContain("MSFT:market.ohlcv");

    await emitKey("tab", "\t", { shift: true });
    await emitKey("tab", "\t", { shift: true });
    await act(async () => {
      await tui.setup().mockInput.typeText("x");
      await tui.setup().renderOnce();
    });
    frame = tui.frame();
    expect(frame).toContain("› Add a series");
    expect(frame).toContain("revenuex");
  });

  test("contains editor fields within a narrow terminal", async () => {
    await tui.render(
      <SeriesEditorDialog
        dialogId="series-editor-narrow-test"
        initialSpec={buildPriceChartPreset("AAPL")}
        dismiss={() => {}}
        resolve={() => {}}
      />,
      { width: 60, height: 42 },
    );

    await act(async () => {
      await tui.setup().renderOnce();
    });

    const contentWidth = 60 - 8;
    const overflowRows = tui.frame()
      .split("\n")
      .map((row) => row.trimEnd())
      .filter((row) => row.length > contentWidth);
    expect(overflowRows).toEqual([]);
  });

  test("logical editor focus owns arrows when another native text editor retains focus", async () => {
    let background: InputRenderable | null = null;
    let resolved: ReturnType<typeof buildPriceChartPreset> | null | undefined;
    let globalArrows = 0;
    function Harness() {
      useShortcut((event) => {
        if (event.name === "left" || event.name === "right") globalArrows += 1;
      }, { phase: "after", allowEditable: true });
      return <>
        <Input ref={(input) => { background = input; }} value="unchanged" />
        <SeriesEditorDialog dialogId="retained-editor-focus" initialSpec={buildPriceChartPreset("QQQ")}
          dismiss={() => {}} resolve={(next) => { resolved = next; }} />
      </>;
    }
    await tui.render(<Harness />, { width: 92, height: 48 });
    for (let index = 0; index < 4; index += 1) await emitKey("tab", "\t");
    // The full terminal can still identify an underlying input as its focused
    // editor after the dialog has moved its own logical focus to a selector.
    await act(async () => { background!.focus(); await tui.setup().renderOnce(); });
    await emitKey("right", "\u001b[C");
    await emitKey("left", "\u001b[D");
    await emitKey("right", "\u001b[C");
    await emitKey("enter", "\r");
    expect(resolved?.series[0]).toMatchObject({ transform: "percent", style: "line" });
    expect(background!.editBuffer.getText()).toBe("unchanged");
    expect(globalArrows).toBe(0);
  });

  test("edits every segmented series setting with Tab and arrow keys", async () => {
    let resolved: ReturnType<typeof buildFundamentalChartPreset> | null | undefined;
    await tui.render(
      <SeriesEditorDialog
        dialogId="series-editor-keyboard-settings-test"
        initialSpec={buildFundamentalChartPreset(["AAPL"])}
        dismiss={() => {}}
        resolve={(next) => {
          resolved = next;
        }}
      />,
      { width: 92, height: 48 },
    );

    await act(async () => {
      await tui.setup().renderOnce();
    });

    await emitKey("tab", "\t");
    await emitKey("tab", "\t");
    await emitKey("tab", "\t");

    await emitKey("right", "\u001b[C");
    await emitKey("tab", "\t");
    await emitKey("right", "\u001b[C");
    await emitKey("tab", "\t");
    await emitKey("right", "\u001b[C");
    await emitKey("tab", "\t");
    await emitKey("right", "\u001b[C");
    await emitKey("tab", "\t");
    await emitKey("right", "\u001b[C");
    await emitKey("tab", "\t");
    await emitKey("right", "\u001b[C");
    await emitKey("tab", "\t");
    await emitKey("right", "\u001b[C");
    await emitKey("tab", "\t");
    await emitKey("right", "\u001b[C");
    await emitKey("enter", "\r");

    expect(resolved?.series[0]).toMatchObject({
      style: "line",
      transform: "percent",
      axis: "right",
      panelId: "main",
      source: {
        kind: "security",
        period: "annual",
        timestampMode: "available-at",
      },
    });
    expect(resolved?.series[0]?.visible).not.toBe(false);
    expect(resolved?.panels.find((panel) => panel.id === "main")?.scale).toBe("log");
  });
});
