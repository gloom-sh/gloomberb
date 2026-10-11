import { expect, test } from "bun:test";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, createTestTicker, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { useOpenDescription } from "./open-description";

const tui = createOpenTuiTestHarness({ width: 20, height: 2 });

test("a listing opens its DES under the key DES saved it under, keeping the venue only for another security", async () => {
  const state = createInitialState(createTestPaneConfig("/tmp/open-description-test", { instanceId: "power:test", paneId: "power", binding: { kind: "none" } }));
  for (const [symbol, exchange] of [["NEE", "NYSE"], ["VOD", "LSE"], ["SAP", "XETRA"]] as const) {
    state.tickers.set(symbol, createTestTicker(symbol, symbol, { exchange }));
  }
  const opened: Array<[string, string | undefined, boolean | undefined]> = [];
  let open!: ReturnType<typeof useOpenDescription>;
  function Probe() {
    open = useOpenDescription();
    return <text>probe</text>;
  }
  await tui.render(<TestPaneProvider state={state} paneId="power:test" pluginId="power"
    runtime={createTestPluginRuntime({ pinTicker: (symbol, options) => { opened.push([symbol, options?.paneType, options?.floating]); } })}>
    <Probe />
  </TestPaneProvider>);

  // The DES `DES NEE` opened, whatever US venue the row names.
  open("NEE:XNYS");
  open("NEE", "NASDAQ");
  // Not saved: a US listing still opens under its symbol, a listing abroad under its venue.
  open("MSFT:XNAS");
  open("NET", "LSE");
  // A bare symbol saved on its home venue is that listing's DES; the US line of the same name is another security.
  open("SAP:XETR");
  open("VOD:XNAS");
  expect(opened.map(([symbol]) => symbol)).toEqual(["NEE", "NEE", "MSFT", "NET:XLON", "SAP", "VOD:XNAS"]);
  expect(new Set(opened.map(([, paneType, floating]) => `${paneType}:${floating}`))).toEqual(new Set(["ticker-research:true"]));
});
