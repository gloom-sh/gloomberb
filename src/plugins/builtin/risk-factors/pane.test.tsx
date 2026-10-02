import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { act, useEffect, useMemo, useState } from "react";
import { apiClient, setCloudApiFetchTransport } from "../../../api-client";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { blockExternalNetwork } from "../../../test-support/network-guard";
import { TestPaneProvider, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createStatefulTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box, useRendererHost } from "../../../ui";
import { attachRiskFactorsPersistence, resetRiskFactorsPersistence } from "./data";
import { RiskFactorsPane } from "./pane";
import { list, report } from "./test-fixtures";

blockExternalNetwork();

const PRO_USER = { id: "pro", emailVerified: true, plan: "pro" };
const currentUser = spyOn(apiClient, "getCurrentUser").mockReturnValue(PRO_USER as never);
afterAll(() => currentUser.mockRestore());

const PANE_ID = "risk-factors:test";
const tui = createOpenTuiTestHarness();
let requests: string[] = [];
let opened: string[] = [];
let selectTicker: (symbol: string) => void;

// The chosen filing year is pane state, so the harness needs a reducer.
function Harness() {
  const [symbol, setSymbol] = useState("ACME");
  selectTicker = setSymbol;
  const [paneState, setPaneState] = useState<AppState["paneState"]>({});
  const state = useMemo(() => {
    const config = createTestPaneConfig("/tmp/gloomberb-risk-factors-test", {
      instanceId: PANE_ID,
      paneId: "risk-factors",
      binding: { kind: "fixed", symbol },
    });
    const initial = createInitialState(config);
    initial.tickers = new Map([[symbol, createTestTicker(symbol)]]);
    initial.focusedPaneId = PANE_ID;
    return initial;
  }, [symbol]);
  state.paneState = paneState;
  const dispatch = (action: AppAction) => {
    setPaneState((current) => appReducer({ ...state, paneState: current }, action).paneState);
  };
  const runtime = useMemo(() => createStatefulTestPluginRuntime(), []);
  const host = useRendererHost();
  useEffect(() => {
    const original = host.openExternal;
    host.openExternal = async (url: string) => { opened.push(url); };
    return () => { host.openExternal = original; };
  }, [host]);
  return (
    <TestPaneProvider state={state} dispatch={dispatch} paneId={PANE_ID} pluginId="ticker-research" runtime={runtime}>
      <PaneFooterProvider>
        {(footer) => (
          <Box width={100} height={24} flexDirection="column">
            <Box height={23}><RiskFactorsPane focused width={100} height={23} /></Box>
            <PaneFooterBar footer={footer} focused width={100} />
          </Box>
        )}
      </PaneFooterProvider>
    </TestPaneProvider>
  );
}

async function settle() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await Bun.sleep(5);
      await tui.setup().renderOnce();
    });
  }
}

async function mount() {
  await act(async () => { await tui.render(<Harness />, { width: 100, height: 24 }); });
  await settle();
}

const frame = tui.frame;

function transport(respond: (path: string) => Promise<Response> | Response) {
  setCloudApiFetchTransport((async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    return respond(path);
  }) as typeof fetch);
}

async function click(label: string) {
  await act(async () => { await Bun.sleep(170); });
  await settle();
  const rows = frame().split("\n");
  const y = rows.findIndex((row) => row.includes(label));
  expect(y).toBeGreaterThanOrEqual(0);
  await act(async () => tui.setup().mockMouse.click(rows[y]!.indexOf(label) + 2, y));
  await settle();
}

async function key(value: string) {
  await act(async () => tui.setup().mockInput.pressKey(value));
  await settle();
}

afterEach(() => {
  currentUser.mockReturnValue(PRO_USER as never);
  resetRiskFactorsPersistence();
  setCloudApiFetchTransport(null);
  apiClient.dispose();
  requests = [];
  opened = [];
});

test("stale discovery is disclosed; standard refresh follows latest until an explicit historical selection", async () => {
  const store = new MemoryPluginPersistence();
  store.seedResource("reports", "ACME", list([2025]), { sourceKey: "risk-factors", schemaVersion: 1, stale: true });
  store.seedResource("report", "ACME:2025", report(2025), { sourceKey: "risk-factors", schemaVersion: 1 });
  attachRiskFactorsPersistence(store);
  let newest = 2026;
  let unavailable = true;
  transport((path) => {
    if (!path.endsWith("/ACME")) return Response.json(report(Number(path.split("/").at(-1))));
    if (unavailable) return new Response("Discovery unavailable", { status: 503 });
    return Response.json(list([...new Set([2025, newest, 2026])]));
  });

  await mount();
  const stale = frame();
  expect(stale).toContain("Only 2025 risk analysis");
  expect(stale).toContain("Discovery unavailable");

  unavailable = false;
  await key("r");
  const latest = frame();
  expect(latest).toContain("Only 2026 risk analysis");
  expect(latest).toContain("Filed 2026-02-03");
  expect(latest).toContain("updated 2026-02-04");
  expect(latest).not.toContain("Discovery unavailable");

  await click("2025 10-K");
  newest = 2027;
  await key("r");
  const historical = frame();
  expect(historical).toContain("2027 10-K");
  expect(historical).toContain("Only 2025 risk analysis");
  expect(historical).not.toContain("Only 2027 risk analysis");
  await click("[o]pen filing");
  expect(opened.at(-1)).toBe(report(2025).docUrl);
});

test("historical year loading and failure cannot display the previous report or its filing action", async () => {
  const pending = Promise.withResolvers<Response>();
  let recovery = false;
  transport((path) => {
    if (path.endsWith("/ACME")) return Response.json(list([2026, 2025]));
    if (path.endsWith("/2026")) return Response.json(report(2026));
    return recovery ? Response.json(report(2025)) : pending.promise;
  });

  await mount();
  await click("2025 10-K");
  expect(frame()).not.toContain("Only 2026 risk analysis");
  await key("o");
  expect(opened).toEqual([]);

  pending.resolve(new Response("Historical report unavailable", { status: 503 }));
  await settle();
  const failed = frame();
  expect(failed).toContain("Historical report unavailable");
  expect(failed).not.toContain("Only 2026 risk analysis");
  expect(failed).not.toContain("Loading...");

  recovery = true;
  await key("r");
  expect(frame()).toContain("Only 2025 risk analysis");
  await click("[o]pen filing");
  expect(opened.at(-1)).toBe(report(2025).docUrl);
});

for (const status of [503, 404]) {
  test(`initial report ${status} stops loading and exposes the cause`, async () => {
    transport((path) => path.endsWith("/ACME")
      ? Response.json(list([2026]))
      : new Response("Detail unavailable", { status }));

    await mount();
    const failed = frame();
    expect(failed).toContain("Detail unavailable");
    expect(failed).not.toContain("Loading...");
    expect(failed).not.toContain("[o]pen filing");
  });
}

test("a ticker without a 10-K report shows the empty state, not a load error", async () => {
  transport(() => Response.json({ message: "No risk factor reports for this ticker" }, { status: 404 }));

  await mount();
  const empty = frame();
  expect(empty).toContain("No 10-K risk factors on file for ACME.");
  expect(empty).not.toContain("Report list:");
  expect(empty).not.toContain("Could not load risk reports");
  expect(requests).toEqual(["/cloud/risks/ACME"]);
});

test("changing ticker while a historical report is pending cannot adopt the old security or year", async () => {
  const pending = Promise.withResolvers<Response>();
  const otherList = list([2024]);
  transport((path) => {
    if (path.endsWith("/ACME")) return Response.json(list([2026, 2025]));
    if (path.endsWith("/ACME/2025")) return pending.promise;
    if (path.endsWith("/ACME/2026")) return Response.json(report(2026));
    if (path.endsWith("/OTHER")) return Response.json({ ...otherList, company: { ...otherList.company!, ticker: "OTHER" } });
    return Response.json({
      ...report(2024),
      ticker: "OTHER",
      docUrl: "https://www.sec.gov/Archives/other-2024.htm",
      overview: "Only OTHER 2024 risk analysis",
    });
  });

  await mount();
  await click("2025 10-K");
  await act(async () => selectTicker("OTHER"));
  await settle();
  expect(frame()).toContain("Only OTHER 2024 risk analysis");
  expect(requests).not.toContain("/cloud/risks/OTHER/2025");

  pending.resolve(Response.json(report(2025)));
  await settle();
  const completed = frame();
  expect(completed).toContain("Only OTHER 2024 risk analysis");
  expect(completed).not.toContain("Only 2025 risk analysis");
  await click("[o]pen filing");
  expect(opened.at(-1)).toBe("https://www.sec.gov/Archives/other-2024.htm");
});

test("in-memory report survives transient refresh with its source dates but clears after definitive denial", async () => {
  let status = 200;
  transport((path) => {
    if (path.endsWith("/ACME")) return Response.json(list([2026]));
    if (status === 200) return Response.json(report(2026));
    return new Response(status === 503 ? "Temporary report outage" : "Access denied", { status });
  });

  await mount();
  status = 503;
  await key("r");
  const failed = frame();
  expect(failed).toContain("Only 2026 risk analysis");
  expect(failed).toContain("Temporary report outage");
  expect(failed).toContain("Filed 2026-02-03");

  status = 402;
  await key("r");
  const denied = frame();
  expect(denied).not.toContain("Only 2026 risk analysis");
  expect(denied).toContain("Risk factors are part of Gloom Cloud Pro.");
  expect(denied).not.toContain("[o]pen filing");
});

test("a free account gets the upgrade wall and reads nothing", async () => {
  currentUser.mockReturnValue({ ...PRO_USER, plan: "free" } as never);
  transport(() => Response.json(list([2026])));

  await mount();
  expect(frame()).toContain("Risk factors are part of Gloom Cloud Pro.");
  expect(frame()).toContain("Upgrade to Pro");
  expect(requests).toEqual([]);
});
