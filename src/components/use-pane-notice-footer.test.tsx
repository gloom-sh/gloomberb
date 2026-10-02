import { expect, test } from "bun:test";
import { act, useState } from "react";
import { Box } from "../ui";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import { PaneFooterBar, PaneFooterProvider, PaneFooterScope, usePaneFooter, type CombinedPaneFooter } from "./layout/pane/footer";
import { usePaneNoticeFooter, type UsePaneNoticeFooterOptions } from "./use-pane-notice-footer";

const tui = createOpenTuiTestHarness();
let update!: (next: Partial<Options>) => void;
let footer: CombinedPaneFooter;
const controls = tui;
type Options = UsePaneNoticeFooterOptions & { active: boolean };

function Registration({ options }: { options: Options }) {
  usePaneNoticeFooter(options);
  usePaneFooter("existing", () => ({ hints: [{ id: "series", key: "s", label: "eries" }] }), []);
  return null;
}
function Harness({ notices = ["  AMD: publication dates unavailable.  ", "AMD: publication dates unavailable.", "  "] }: { notices?: string[] }) {
  const [options, setOptions] = useState<Options>({ registrationId: "notice-test", notices, focused: true, active: true });
  update = (next) => setOptions((current) => ({ ...current, ...next }));
  return <PaneFooterProvider>{(current) => {
    footer = current;
    return <Box width={72} height={1}>
      <PaneFooterScope active={options.active}><Registration options={options} /></PaneFooterScope>
      <PaneFooterBar footer={current} focused={options.focused} width={72} />
    </Box>;
  }}</PaneFooterProvider>;
}
async function change(next: Partial<Options>) {
  await act(async () => update(next));
  await controls.renderFrames(3);
}
async function key(name: string, modifiers = {}) {
  await tui.emitKeypress({ name, ...modifiers }, { trackPropagation: true });
  await controls.renderFrames(3);
}

test("compact warnings disclose by mouse, follow the current data and vanish without disabling existing actions", async () => {
  await act(async () => { await tui.render(<Harness />, { width: 80, height: 28 }); });
  await controls.renderFrames(3);
  expect(tui.frame()).toContain("⚠");
  expect(tui.frame()).toContain("[s]eries");
  expect(tui.frame()).not.toContain("publication");
  const retained = footer.info[0]!.onPress!;
  await act(async () => { await tui.setup().mockMouse.click(tui.frame().split("\n")[0]!.indexOf("⚠"), 0); });
  await controls.waitForFrameToContain("publication dates unavailable");
  expect(tui.frame().match(/publication dates unavailable/g)?.length).toBe(1);
  const dialogLines = tui.frame().split("\n");
  expect(dialogLines.findIndex((line) => line.includes("Close")) - dialogLines.findIndex((line) => line.includes("Data warnings"))).toBeLessThanOrEqual(5);
  await change({ notices: ["MSFT: stale provider observation."] });
  expect(tui.frame()).not.toContain("publication");
  await act(async () => retained());
  await controls.waitForFrameToContain("MSFT: stale provider observation.");
  await controls.clickFrameText("Close");
  await controls.renderFrames(3);
  expect(tui.frame()).not.toContain("stale provider");
  await change({ notices: [" "] });
  await act(async () => retained());
  await key("!");
  expect(tui.frame()).not.toContain("⚠");
  expect(tui.frame()).toContain("[s]eries");
  expect(footer.info).toEqual([]);
});

test("notice shortcut respects focus, inactive scopes, enabled state and an already open dialog", async () => {
  await act(async () => { await tui.render(<Harness />, { width: 80, height: 28 }); });
  await controls.renderFrames(3);
  for (const disabled of [{ focused: false }, { focused: true, active: false }, { active: true, enabled: false }]) {
    await change(disabled);
    await key("!");
    expect(tui.frame()).not.toContain("publication");
  }
  await change({ enabled: true });
  await key("!", { ctrl: true });
  expect(tui.frame()).not.toContain("publication");
  await key("!");
  await controls.waitForFrameToContain("publication dates unavailable");
  await key("!");
  await key("escape");
  expect(tui.frame()).not.toContain("publication");
  await key("!");
  await controls.waitForFrameToContain("publication dates unavailable");
  await change({ active: false });
  expect(tui.frame()).not.toContain("publication");
});

test("long warning details remain scrollable to their final observation", async () => {
  const notices = Array.from({ length: 40 }, (_, index) => `Observation ${index + 1}: provider timestamp unavailable.`);
  await act(async () => { await tui.render(<Harness notices={notices} />, { width: 48, height: 20 }); });
  await controls.renderFrames(3);
  await key("!");
  await controls.waitForFrameToContain("Observation 1:");
  expect(tui.frame()).not.toContain("Observation 40:");
  await key("end");
  expect(tui.frame()).toContain("Observation 40:");
  await key("home");
  expect(tui.frame()).toContain("Observation 1:");
  await key("enter");
  expect(tui.frame()).not.toContain("Observation 1:");
});

test("narrow panes keep warning disclosure visible beside overflowing action hints", async () => {
  await act(async () => {
    await tui.render(<PaneFooterBar focused width={18} footer={{
      info: [{ id: "notice", icon: "warning", parts: [{ text: "⚠", tone: "warning" }], onPress: () => {} }],
      hints: [{ id: "series", key: "s", label: "eries" }, { id: "indicators", key: "i", label: "ndicators" }, { id: "share", key: "x", label: " share" }],
    }} />, { width: 18, height: 1 });
  });
  await controls.renderFrames(3);
  expect(tui.frame()).toContain("⚠");
});
