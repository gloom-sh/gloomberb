import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { Box } from "../../../../ui";
import { testRender } from "../../../../renderers/opentui/test-utils";
import { PaneFooterBar, PaneFooterProvider, PaneFooterScope, usePaneFooter, type CombinedPaneFooter, type PaneFooterPressEvent } from "./index";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let update: (next: Partial<Options>) => void;
let footer: CombinedPaneFooter;
let renders = 0;
const actions: string[] = [];
let receivedEvent: PaneFooterPressEvent | undefined;
interface Options { selected: string; disabled: boolean; callable: boolean; visible: boolean; active: boolean; registrationId: string }
function Harness() {
  const [options, setOptions] = useState<Options>({ selected: "A", disabled: false, callable: true, visible: true, active: true, registrationId: "current-actions" });
  update = (next) => setOptions((current) => ({ ...current, ...next }));
  return <PaneFooterProvider>{(current) => {
    footer = current;
    return <Box width={60} height={1}>
      <PaneFooterScope active={options.active}>{options.visible && <Registration options={options} />}</PaneFooterScope>
      <PaneFooterBar footer={current} focused width={60} />
    </Box>;
  }}</PaneFooterProvider>;
}
function Registration({ options }: { options: Options }) {
  if (++renders > 30) throw new Error("Footer registration render loop");
  const onPress = (event?: PaneFooterPressEvent) => { receivedEvent = event; actions.push(options.selected); };
  usePaneFooter(options.registrationId, () => ({
    info: [{ id: "detail", parts: [{ text: "Detail" }], onPress: options.callable ? onPress : undefined, disabled: options.disabled }],
    hints: [{ id: "filter", key: "f", label: "ilter", onPress: options.callable ? onPress : undefined, disabled: options.disabled }],
  }), [onPress, options.callable, options.disabled]);
  return null;
}
async function settle() {
  for (let i = 0; i < 3; i++) await act(async () => { await setup!.renderOnce(); });
}
async function change(next: Partial<Options>) { await act(async () => update(next)); await settle(); }
async function click(text: string) {
  const column = setup!.captureCharFrame().split("\n")[0]!.indexOf(text);
  expect(column).toBeGreaterThanOrEqual(0);
  await act(async () => { await setup!.mockMouse.click(column + 1, 0); });
  await settle();
}
afterEach(async () => {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  setup = undefined; actions.length = 0; renders = 0;
  receivedEvent = undefined;
});

test.each(["registration-id", "active-scope"])("obsolete handlers cannot resume after %s changes", async (kind) => {
  await act(async () => { setup = await testRender(<Harness />, { width: 60, height: 1 }); });
  await settle();
  const oldHint = footer.hints[0]!.onPress!;
  const oldInfo = footer.info[0]!.onPress!;
  await change({ selected: "B" });
  const event = { pixelX: 22, pixelY: 33 };
  oldHint(event);
  expect(receivedEvent).toBe(event);
  oldInfo();
  expect(actions).toEqual(["B", "B"]);
  if (kind === "registration-id") await change({ registrationId: "next", selected: "C" });
  else {
    await change({ active: false });
    oldHint(); oldInfo();
    expect(actions).toEqual(["B", "B"]);
    await change({ active: true, selected: "C" });
  }
  oldHint(); oldInfo();
  expect(actions).toEqual(["B", "B"]);
  await click("[f]ilter");
  await click("Detail");
  expect(actions).toEqual(["B", "B", "C", "C"]);
});

test("unchanged footer labels invoke the current selection for both hint and segment mouse actions", async () => {
  await act(async () => { setup = await testRender(<Harness />, { width: 60, height: 1 }); });
  await settle();
  const filterColumn = setup!.captureCharFrame().split("\n")[0]!.indexOf("[f]ilter");
  await act(async () => { await setup!.mockMouse.release(filterColumn + 1, 0); });
  await settle();
  expect(actions).toEqual([]);
  await click("[f]ilter");
  await change({ selected: "B" });
  await click("[f]ilter");
  await click("Detail");
  expect(actions).toEqual(["A", "B", "B"]);
  expect(renders).toBeLessThan(10);
});

test("removed, disabled and unmounted footer actions cannot invoke obsolete handlers", async () => {
  await act(async () => { setup = await testRender(<Harness />, { width: 60, height: 1 }); });
  await settle();
  const retainedHint = footer.hints[0]!.onPress!;
  const retainedInfo = footer.info[0]!.onPress!;
  await change({ disabled: true });
  retainedHint(); retainedInfo();
  await click("Detail");
  expect(actions).toEqual([]);
  await change({ disabled: false, callable: false });
  retainedHint(); retainedInfo();
  expect(footer.hints[0]!.onPress).toBeUndefined();
  expect(footer.info[0]!.onPress).toBeUndefined();
  await change({ callable: true, selected: "C" });
  await click("[f]ilter");
  await click("Detail");
  expect(actions).toEqual(["C", "C"]);
  await change({ visible: false });
  retainedHint(); retainedInfo();
  expect(footer.hints).toEqual([]);
  expect(footer.info).toEqual([]);
  expect(actions).toEqual(["C", "C"]);
});
