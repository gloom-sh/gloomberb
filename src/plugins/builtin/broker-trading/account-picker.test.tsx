import { expect, test } from "bun:test";
import { act, createRef } from "react";
import type { SelectControl } from "../../../components";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { BrokerAccountPicker, type BrokerAccountChoice } from "./account-picker";

const tui = createOpenTuiTestHarness({ width: 90, height: 30 });
const accounts: BrokerAccountChoice[] = [
  { value: "live", label: "Personal account", profileLabel: "Demo live profile", tradingMode: "live" },
  { value: "sim", label: "Practice account", profileLabel: "Demo simulation profile", tradingMode: "simulation" },
];

test("account choices show modes and require a deliberate selection, with simulation first", async () => {
  const control = createRef<SelectControl>();
  const changes: string[] = [];
  await tui.render(<BrokerAccountPicker accounts={accounts} onChange={(value) => changes.push(value)} controlRef={control} />);
  expect(changes).toEqual([]);
  await act(async () => control.current!.open());
  await tui.waitForFrameToContain("Demo simulation profile");
  expect(tui.frame()).toContain("SIMULATION");
  expect(tui.frame()).toContain("LIVE");
  await tui.emitKeypress({ name: "enter", sequence: "\r" }, { trackPropagation: true });
  expect(changes).toEqual([]);
  await tui.emitKeypress({ name: "down", sequence: "\u001b[B" }, { trackPropagation: true });
  await tui.emitKeypress({ name: "enter", sequence: "\r" }, { trackPropagation: true });
  await tui.waitForFrameToExclude("Demo simulation profile");
  expect(changes).toEqual(["sim"]);
});

test("closing the picker preserves selection and disabled controls cannot open", async () => {
  const control = createRef<SelectControl>();
  const changes: string[] = [];
  await tui.render(<BrokerAccountPicker accounts={accounts} value="sim" onChange={(value) => changes.push(value)} controlRef={control} />);
  await act(async () => control.current!.open());
  await tui.waitForFrameToContain("Demo simulation profile");
  await tui.emitKeypress({ name: "escape", sequence: "\u001b" }, { trackPropagation: true });
  await tui.waitForFrameToExclude("Demo simulation profile");
  expect(changes).toEqual([]);
  await tui.render(<BrokerAccountPicker accounts={accounts} disabled onChange={(value) => changes.push(value)} controlRef={control} />);
  await act(async () => control.current!.open());
  expect(tui.frame()).not.toContain("Demo live profile");
});
