import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { applyTheme, getThemeColors } from "../../theme/colors";
import { parseHex } from "../../theme/color-utils";
import { resolveHeatmapTileColors } from "../../theme/heat-colors";
import { ThemeProvider } from "../../theme/theme-context";
import { DEFAULT_THEME } from "../../theme/themes";
import { buildHeatTreemapScene, heatTreemapCanvas, HeatTreemapSurface, MetricTreemapSurface, type MetricTreemapItem } from ".";

const tui = createOpenTuiTestHarness();
afterEach(() => applyTheme(DEFAULT_THEME));

function items(weights: [number, number]): Array<MetricTreemapItem<string>> {
  return [
    { id: "a", label: "AAA", weight: weights[0], data: "a" },
    { id: "b", label: "BBB", weight: weights[1], data: "b" },
  ];
}

test("a relayout under a resting pointer leaves the keyboard's selection alone", async () => {
  const selected: string[] = [];
  let setWeights: ((weights: [number, number]) => void) | null = null;
  let setSelectedId: ((id: string) => void) | null = null;
  function Harness() {
    const [weights, updateWeights] = useState<[number, number]>([3, 1]);
    const [selectedId, updateSelectedId] = useState("a");
    setWeights = updateWeights;
    setSelectedId = updateSelectedId;
    return (
      <MetricTreemapSurface
        items={items(weights)}
        width={40}
        height={6}
        selectedId={selectedId}
        onSelect={(item) => {
          selected.push(item.id);
          updateSelectedId(item.id);
        }}
      />
    );
  }
  await tui.render(<Harness />, { width: 40, height: 6 });
  await act(async () => tui.setup().renderOnce());

  // The pointer moves onto the wide tile on the left: hover selects it.
  await act(async () => {
    await tui.setup().mockMouse.moveTo(5, 2);
    await tui.setup().renderOnce();
  });
  expect(selected).toEqual(["a"]);

  // The keyboard picks the other tile, then the weights flip so the resting
  // pointer now sits over it; neither may move the selection back.
  await act(async () => setSelectedId?.("b"));
  await act(async () => setWeights?.([1, 3]));
  await act(async () => {
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
  });
  expect(selected).toEqual(["a"]);

});

test("a theme switch recolours the heat map tiles at once, though no tile's props changed", async () => {
  const heatItems: Array<MetricTreemapItem<string>> = [
    { id: "a", label: "AAA", weight: 3, colorValue: 2, data: "a" },
    { id: "b", label: "BBB", weight: 1, colorValue: -2, data: "b" },
  ];
  const scene = buildHeatTreemapScene(heatItems, heatTreemapCanvas(40, 6, {}));
  let setThemeId: ((id: string) => void) | null = null;
  function Harness() {
    const [themeId, updateThemeId] = useState(DEFAULT_THEME);
    setThemeId = updateThemeId;
    return (
      <ThemeProvider themeId={themeId}>
        <HeatTreemapSurface scene={scene} items={heatItems} width={40} height={6} selectedId={null} onSelect={() => {}} />
      </ThemeProvider>
    );
  }
  const tileBackground = () => {
    const line = tui.setup().captureSpans().lines.find((spans) => spans.spans.some((span) => span.text.includes("AAA")));
    const [r, g, b] = line!.spans.find((span) => span.text.includes("AAA"))!.bg.toInts();
    return [r, g, b].join(",");
  };
  const expected = (themeId: string) => parseHex(resolveHeatmapTileColors(2, getThemeColors(themeId)).background).join(",");

  await tui.render(<Harness />, { width: 40, height: 6 });
  await act(async () => tui.setup().renderOnce());
  expect(tileBackground()).toBe(expected(DEFAULT_THEME));

  await act(async () => setThemeId?.("tokyo"));
  await act(async () => tui.setup().renderOnce());
  expect(expected("tokyo")).not.toBe(expected(DEFAULT_THEME));
  expect(tileBackground()).toBe(expected("tokyo"));
});
