import { afterEach, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { setCloudApiFetchTransport } from "../../../../../api-client";
import type { Letter } from "../../../../../api-client/letters";
import { createOpenTuiTestHarness } from "../../../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../../../test-support/pane";
import { createTestPluginRuntime } from "../../../../../test-support/plugin-runtime";
import { UiHostProvider, useNativeRenderer, useRendererHost, useUiHost } from "../../../../../ui";
import { IndustryPane } from "../industry-pane";

const tui = createOpenTuiTestHarness();
const PANE = "news-industry:test";
let opened: string[] = [];
let requests: string[] = [];

afterEach(() => {
  setCloudApiFetchTransport(null);
  opened = [];
  requests = [];
});

const letter = (id: string, overrides: Partial<Letter> = {}): Letter => ({
  id,
  title: `Title ${id}`,
  entity: "Oaktree Capital Management",
  kind: "memo",
  date: "2026-09-22",
  url: `https://www.oaktreecapital.com/insights/memo/${id}`,
  ...overrides,
});

function serve(respond: () => Response | Promise<Response>) {
  setCloudApiFetchTransport((async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requests.push(`${url.pathname}${url.search}`);
    return respond();
  }) as typeof fetch);
}

function Harness() {
  const config = createTestPaneConfig(":memory:", { instanceId: PANE, paneId: "news-industry", params: { code: "LTR" } });
  config.refreshIntervalMinutes = 0;
  const [state, dispatch] = useReducer(appReducer, config, createInitialState);
  const host = useRendererHost();
  const ui = useUiHost();
  const native = useNativeRenderer();
  const renderer = { ...host, openExternal: async (url: string) => { opened.push(url); } };
  return (
    <UiHostProvider ui={ui} nativeRenderer={native} renderer={renderer}>
      <TestPaneFrame state={state} dispatch={dispatch} paneId={PANE} pluginId="news" runtime={createTestPluginRuntime()} width={110} height={14} footerKeys>
        {(body) => <IndustryPane paneId={PANE} paneType="news-industry" focused {...body} />}
      </TestPaneFrame>
    </UiHostProvider>
  );
}

const mount = () => act(async () => { await tui.render(<Harness />, { width: 110, height: 14 }); });
const press = (name: string) => tui.emitKeypress({ name, sequence: name });

test("NI LTR lists letters from the anonymous route, newest first, and Enter opens the selected publisher link", async () => {
  serve(() => Response.json({
    items: [letter("a", { title: "Shall We Repeal the Laws of Economics", date: "2026-09-22" }), letter("b", { title: "Quarterly Commentary", entity: "FPA", kind: "commentary", date: "2026-08-24", url: "https://fpa.com/b" })],
    hasMore: false, limit: 50, offset: 0,
  }));
  await mount();
  const frame = await tui.waitForFrameToContain("Shall We Repeal the Laws of Economics");
  expect(frame).toContain("2026-09-22");
  expect(frame).toContain("Oaktree Capital Management");
  expect(frame).toContain("Memo");
  expect(frame).toContain("Commentary");
  expect(requests).toEqual(["/public/letters?limit=50&offset=0"]);

  await press("return");
  expect(opened).toEqual(["https://www.oaktreecapital.com/insights/memo/a"]);
  await press("j");
  await press("return");
  expect(opened.at(-1)).toBe("https://fpa.com/b");
  expect(tui.frame()).toContain("[o]pen");
});

test("a server without the route says letters are unavailable", async () => {
  serve(() => Response.json({ error: "not_found" }, { status: 404 }));
  await mount();
  await tui.waitForFrameToContain("Letters are not available right now.");
});

test("an unreadable answer is an error, never a wrong row", async () => {
  serve(() => Response.json({ items: [{ nope: true }], hasMore: false, limit: 50, offset: 0 }));
  await mount();
  await tui.waitForFrameToContain("unreadable letters");
});

test("an empty list says so in one line", async () => {
  serve(() => Response.json({ items: [], hasMore: false, limit: 50, offset: 0 }));
  await mount();
  await tui.waitForFrameToContain("No letters yet");
});

test("the Kind filter asks the server for that kind and starts the list over", async () => {
  serve(() => Response.json({
    items: [letter("a", { title: "A memo", kind: "memo" })], hasMore: false, limit: 50, offset: 0,
  }));
  await mount();
  await tui.waitForFrameToContain("A memo");
  await act(async () => { await tui.clickFrameText("Kind All"); });
  await tui.waitForFrameToContain("Annual report");
  await press("down");
  await press("down");
  await press("return");
  await tui.waitForFrameToContain("Kind Memo");
  expect(requests).toEqual([
    "/public/letters?limit=50&offset=0",
    "/public/letters?kind=memo&limit=50&offset=0",
  ]);
});
