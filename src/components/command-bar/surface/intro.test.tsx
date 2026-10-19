import { afterEach, expect, test } from "bun:test";
import { act, type Dispatch } from "react";
import { showsCommandBarIntro } from "../../../app/command-bar-intro";
import { setConfigStoreHost } from "../../../data/config/store";
import { BROWSER_STORAGE_KEYS } from "../../../data/json-storage";
import { createBrowserConfigStore } from "../../../renderers/browser/config-host";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { AppProvider, useAppDispatch, type AppAction, type AppContextStoreValue } from "../../../state/app/context";
import { flushPendingPersistence } from "../../../state/persist-scheduler";
import { CommandBarHarness, createCommandBarTestControls } from "./test-harness";

const tui = createOpenTuiTestHarness();
const { waitForFrameToContain } = createCommandBarTestControls(() => tui.setup());

afterEach(async () => {
  await flushPendingPersistence();
  setConfigStoreHost(null);
});

test("the empty bar leads with Start Here and plain words to type on its first ten opens, and from the eleventh shows the list alone", async () => {
  const storeRef: { current: AppContextStoreValue | null } = { current: null };
  // A new install, with the bar closed: the header shows its own words.
  await tui.render(<CommandBarHarness
    query=""
    live
    storeRef={storeRef}
    configureState={(state) => ({ ...state, commandBarOpen: false })}
  />, { width: 100, height: 40 });
  await waitForFrameToContain("bar:closed");

  for (let open = 1; open <= 11; open += 1) {
    // As Ctrl+P and a click on the header prompt open it.
    await act(async () => { storeRef.current!.dispatch({ type: "SET_COMMAND_BAR", open: true, query: "" }); });
    const frame = await waitForFrameToContain(open <= 10 ? "Start Here" : "Ticker Research");
    expect(frame).toContain("bar:open");
    if (open <= 10) {
      expect(frame).toContain("Look up a company");
      expect(frame).toMatch(/Try: [a-z]/);
    } else {
      expect(frame).not.toContain("Start Here");
      expect(frame).not.toContain("Try:");
      expect(frame).toContain("Search or run a command");
    }
    expect(storeRef.current!.getState().config.commandBarOpens).toBe(open);
    await act(async () => { storeRef.current!.dispatch({ type: "SET_COMMAND_BAR", open: false }); });
    await waitForFrameToContain("bar:closed");
  }
});

test("the count is saved on this machine and read back after a reload, and a config from before it reads as past the introduction", async () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
  // A page load reads the browser's storage afresh.
  const load = () => createBrowserConfigStore(storage).loadConfig("browser://local");
  setConfigStoreHost(createBrowserConfigStore(storage));
  const firstVisit = await load();
  expect(firstVisit.commandBarOpens).toBe(0);

  let dispatch: Dispatch<AppAction> | null = null;
  function DispatchCapture() {
    dispatch = useAppDispatch();
    return null;
  }
  await tui.render(<AppProvider config={firstVisit}><DispatchCapture /></AppProvider>, { width: 40, height: 4 });
  for (let open = 0; open < 3; open += 1) {
    await act(async () => { dispatch!({ type: "SET_COMMAND_BAR", open: true, query: "" }); });
    await act(async () => { dispatch!({ type: "SET_COMMAND_BAR", open: false }); });
  }
  // A key bound to text runs it without showing the empty bar, so it does not count.
  await act(async () => { dispatch!({ type: "SET_COMMAND_BAR", open: true, query: "TOP", launch: { kind: "run-query", query: "TOP" } }); });
  await flushPendingPersistence();

  expect((await load()).commandBarOpens).toBe(3);

  const { commandBarOpens: _count, ...earlierBuild } = JSON.parse(data.get(BROWSER_STORAGE_KEYS.config)!) as Record<string, unknown>;
  data.set(BROWSER_STORAGE_KEYS.config, JSON.stringify(earlierBuild));
  expect(showsCommandBarIntro(await load())).toBe(false);
});
