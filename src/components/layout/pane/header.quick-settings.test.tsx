import { describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { Box } from "../../../ui";
import { PaneHeader, terminalQuickSettingLabelPlacement, type PaneHeaderQuickSetting, type PaneHeaderStack } from "./header";

const tui = createOpenTuiTestHarness();

const IV: PaneHeaderQuickSetting = { key: "showIv", icon: "marker", label: "Current ATM IV", active: true };
const LIVE: PaneHeaderQuickSetting = { key: "liveStreaming", icon: "zap", label: "Live streaming", active: true };
const SQRT: PaneHeaderQuickSetting = { key: "sizeBy", icon: "sqrt", label: "Size by square root of market cap", active: false };

type HeaderProps = Parameters<typeof PaneHeader>[0];

async function mountHeader(props: Partial<HeaderProps> & { quickSettings: PaneHeaderQuickSetting[] }, width = 60) {
  await tui.render(
    <Box width={width} height={3} flexDirection="column">
      <PaneHeader title="HVG AAPL" width={width} focused={false} showActions onActionMouseDown={() => {}} {...props} />
    </Box>,
    { width, height: 3 },
  );
  await act(async () => { await tui.setup().renderOnce(); });
  return headerRow();
}

function headerRow(): string {
  return tui.frame().split("\n")[0]!;
}

/**
 * Points at the cell `column` of the header row and returns the row once
 * `settled` holds for it, or as it stands after a second: the renderer reads
 * the pointer from its input stream a moment after it is sent.
 */
async function pointAt(column: number, settled: (row: string) => boolean): Promise<string> {
  await act(async () => { await tui.setup().mockMouse.moveTo(column, 0); });
  for (let attempt = 0; attempt < 50 && !settled(headerRow()); attempt++) await settleFrame(tui.setup(), 20);
  return headerRow();
}

const showing = (text: string) => (row: string) => row.includes(text);

describe("a quick setting's terminal hover label", () => {
  test("goes after the glyph when it fits before the corner, else before it, else cut on the roomier side", () => {
    const at = { buttonWidth: 3, framed: true };
    // 20 cells after the button, the label's 9 fit there.
    expect(terminalQuickSettingLabelPlacement("IV: on", { ...at, buttonStart: 10, width: 35 })).toEqual({ left: 13, text: " IV: on " });
    // 4 after, 16 before (past the frame's corner): it ends where the button starts.
    expect(terminalQuickSettingLabelPlacement("IV: on", { ...at, buttonStart: 18, width: 27 })).toEqual({ left: 10, text: " IV: on " });
    // Room for neither: cut to the side with more room.
    expect(terminalQuickSettingLabelPlacement("Current ATM IV: on", { ...at, buttonStart: 12, width: 24 })).toEqual({ left: 2, text: " Current… " });
    // No room for a letter and the ellipsis either side.
    expect(terminalQuickSettingLabelPlacement("Current ATM IV: on", { ...at, buttonStart: 4, width: 11 })).toBeNull();
  });

  test("a focused pane's header names the setting and its state beside the glyph, and moves nothing", async () => {
    const before = await mountHeader({ focused: true, quickSettings: [IV] });
    const glyph = before.indexOf("⌖");
    expect(before.startsWith("┌─:: HVG AAPL ⌖ ──")).toBe(true);

    const hovered = await pointAt(glyph, showing("Current ATM IV"));
    expect(hovered.startsWith("┌─:: HVG AAPL ⌖  Current ATM IV: on ──")).toBe(true);
    // The title, the glyph, the menu and the corner stay where they were.
    expect(hovered.slice(0, glyph + 2)).toBe(before.slice(0, glyph + 2));
    expect(hovered.slice(-7)).toBe(before.slice(-7));

    expect(await pointAt(1, (row) => row === before)).toBe(before);
  });

  test("an unfocused pane's header, whose settings sit by the menu, puts the label over the title's room", async () => {
    const before = await mountHeader({ quickSettings: [{ ...IV, active: false }] });
    const glyph = before.indexOf("⌖");
    const hovered = await pointAt(glyph, showing("Current ATM IV"));
    expect(hovered).toContain(" Current ATM IV: off  ⌖ ");
    expect(hovered.indexOf("⌖")).toBe(glyph);
    expect(hovered.startsWith(":: HVG AAPL ")).toBe(true);
    expect(hovered.slice(glyph)).toBe(before.slice(glyph));
  });

  test("the live glyph's two cells are counted, so the label after the next one starts right after it", async () => {
    const before = await mountHeader({ focused: true, floating: true, onCloseMouseDown: () => {}, quickSettings: [LIVE, SQRT] }, 90);
    const sqrt = before.indexOf("√");
    const hovered = await pointAt(sqrt + 1, showing("Size by"));
    expect(hovered).toContain("√  Size by square root of market cap: off ");
    expect(hovered.slice(0, sqrt + 2)).toBe(before.slice(0, sqrt + 2));
  });

  test("a stack's header keeps its tabs, and a press on the glyph still toggles it while it is labelled", async () => {
    function Stacked() {
      const [active, setActive] = useState(true);
      const stack: PaneHeaderStack = {
        tabs: [{ id: "hvg", title: "HVG AAPL" }, { id: "news", title: "News" }],
        active: "hvg",
        onSelect: () => {},
      };
      return (
        <PaneHeader
          title="HVG AAPL"
          width={60}
          focused
          showActions
          stack={stack}
          quickSettings={[{ ...IV, active, onMouseDown: () => setActive((value) => !value) }]}
        />
      );
    }
    await tui.render(<Box width={60} height={3}><Stacked /></Box>, { width: 60, height: 3 });
    await act(async () => { await tui.setup().renderOnce(); });
    const before = headerRow();
    const glyph = before.indexOf("⌖");
    expect(before).toContain("HVG AAPL │ News ⌖ ");

    expect(await pointAt(glyph, showing("Current ATM IV"))).toContain("HVG AAPL │ News ⌖  Current ATM IV: on ");
    await act(async () => { await tui.setup().mockMouse.click(glyph, 0); });
    expect(await tui.waitForFrameToContain("Current ATM IV: off")).toContain("HVG AAPL │ News ⌖  Current ATM IV: off ");
  });
});
