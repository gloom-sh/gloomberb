import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { MetricTreemapSurface, type MetricTreemapItem } from ".";

const tui = createOpenTuiTestHarness();

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
