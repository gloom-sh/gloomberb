import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../../renderers/opentui/test-utils";
import type { PluginPersistence } from "../../../../types/plugin";
import type { PluginRegistry } from "../../../registry";
import { setSharedRegistryForTests } from "../../../registry/shared";
import { subscribeRequestedAccountManagementTab } from "../../account-management/navigation";
import { TerminalControlSection } from "./connect-section";
import { terminalRelayGrants } from "./grants";

const tui = createOpenTuiTestHarness();
let shown: string[] = [];
let tabs: string[] = [];
let dismissed = 0;
let stopTabs: () => void = () => {};

function persistence(): PluginPersistence {
  const state = new Map<string, unknown>();
  return {
    getState: <T,>(key: string) => (state.get(key) as T) ?? null,
    setState: (key, value) => { state.set(key, value); },
    deleteState: (key) => { state.delete(key); },
    getResource: () => null,
    setResource: () => { throw new Error("unused"); },
    deleteResource: () => {},
  };
}

beforeEach(() => {
  shown = [];
  tabs = [];
  dismissed = 0;
  terminalRelayGrants.attach(persistence());
  setSharedRegistryForTests({ showPane: (id: string) => { shown.push(id); } } as unknown as PluginRegistry);
  stopTabs = subscribeRequestedAccountManagementTab((tab) => tabs.push(tab));
});

afterEach(() => {
  stopTabs();
  setSharedRegistryForTests(undefined);
  terminalRelayGrants.detach();
});

async function renderSection() {
  await tui.render(<TerminalControlSection width={60} dismiss={() => { dismissed += 1; }} />, { width: 70, height: 8 });
}

test("counts the assistants allowed now and opens the Agents tab with m", async () => {
  terminalRelayGrants.decide("key:a", "Desk assistant", "always");
  terminalRelayGrants.decide("oauth:b", "Research agent", "session");
  terminalRelayGrants.decide("key:c", "Old script", "deny");
  await renderSection();
  await tui.waitForFrameToContain("2 assistants allowed");
  await tui.emitKeypress({ name: "m", sequence: "m" }, { frames: 2, afterCommit: true });
  expect(tabs).toEqual(["agents"]);
  expect(shown).toEqual(["account-management"]);
  expect(dismissed).toBe(1);
});

test("follows a revoke while open, and the button opens the Agents tab with the mouse", async () => {
  terminalRelayGrants.decide("key:a", "Desk assistant", "always");
  await renderSection();
  await tui.waitForFrameToContain("1 assistant allowed");
  act(() => terminalRelayGrants.forget("key:a"));
  await tui.waitForFrameToContain("None allowed yet");
  await tui.clickFrameText("Manage assistants");
  expect(tabs).toEqual(["agents"]);
  expect(shown).toEqual(["account-management"]);
});
