import { afterEach, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { setCloudApiFetchTransport } from "../../../../../api-client";
import type { Letter } from "../../../../../api-client/letters";
import { deriveRenderedFreshness, formatFreshnessLine } from "../../../../../cli/pane-functions/freshness";
import { renderedReportFreshness } from "../../../../../cli/pane-functions/report-notices";
import { RemoteUiRegistryProvider, createRemoteUiRegistry } from "../../../../../remote/semantic-tree";
import { createOpenTuiTestHarness } from "../../../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../../../state/app/context";
import { captureConfigSaves } from "../../../../../test-support/config-store";
import { createTestPaneConfig, TestPaneFrame } from "../../../../../test-support/pane";
import { createTestPluginRuntime } from "../../../../../test-support/plugin-runtime";
import { UiHostProvider, useNativeRenderer, useRendererHost, useUiHost } from "../../../../../ui";
import { IndustryPane } from "../industry-pane";

const tui = createOpenTuiTestHarness();
// A filter change saves the pane's settings: kept in memory, never written under the working directory.
captureConfigSaves();
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
  date_basis: "published",
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

function Harness({ width = 110 }: { width?: number }) {
  const config = createTestPaneConfig(":memory:", { instanceId: PANE, paneId: "news-industry", params: { code: "LTR" } });
  config.refreshIntervalMinutes = 0;
  const [state, dispatch] = useReducer(appReducer, config, createInitialState);
  const host = useRendererHost();
  const ui = useUiHost();
  const native = useNativeRenderer();
  const renderer = { ...host, openExternal: async (url: string) => { opened.push(url); } };
  return (
    <UiHostProvider ui={ui} nativeRenderer={native} renderer={renderer}>
      <TestPaneFrame state={state} dispatch={dispatch} paneId={PANE} pluginId="news" runtime={createTestPluginRuntime()} width={width} height={14} footerKeys>
        {(body) => <IndustryPane paneId={PANE} paneType="news-industry" focused {...body} />}
      </TestPaneFrame>
    </UiHostProvider>
  );
}

async function mount(width = 110) {
  const registry = createRemoteUiRegistry();
  await act(async () => {
    await tui.render(<RemoteUiRegistryProvider registry={registry}><Harness width={width} /></RemoteUiRegistryProvider>, { width, height: 14 });
  });
  return registry;
}
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
  // The default view leaves out annual reports, in one request for the other three kinds.
  expect(requests).toEqual(["/public/letters?kind=shareholder_letter%2Cmemo%2Ccommentary&limit=50&offset=0"]);
  expect(frame).toContain("Kind All but annual reports");

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

test("annual reports, and everything, are each one choice away, and a new view starts its paging over", async () => {
  serve(() => Response.json({
    items: [letter("a", { title: "A memo", kind: "memo" })], hasMore: false, limit: 50, offset: 0,
  }));
  await mount();
  await tui.waitForFrameToContain("A memo");
  await act(async () => { await tui.clickFrameText("Kind All but annual reports"); });
  const menu = await tui.waitForFrameToContain("Everything");
  for (const label of ["All but annual reports", "Shareholder letters", "Memos", "Commentary", "Annual reports", "Everything"])
    expect(menu).toContain(label);
  for (let i = 0; i < 4; i++) await press("down");
  await press("return");
  await tui.waitForFrameToContain("Kind Annual reports");
  await act(async () => { await tui.renderFrames(3); });
  await act(async () => { await tui.clickFrameText("Kind Annual reports"); });
  await tui.waitForFrameToContain("Everything");
  await press("down");
  await press("return");
  await tui.waitForFrameToContain("Kind Everything");
  expect(requests).toEqual([
    "/public/letters?kind=shareholder_letter%2Cmemo%2Ccommentary&limit=50&offset=0",
    "/public/letters?kind=annual_report&limit=50&offset=0",
    "/public/letters?limit=50&offset=0",
  ]);
});

test("each row says what its date is, and a report of NI LTR says it lists letters, not stories", async () => {
  serve(() => Response.json({
    items: [
      letter("a", { title: "Shall We Repeal the Laws of Economics", date_basis: "published" }),
      letter("b", { title: "Letter to shareholders, 2025", entity: "Berkshire Hathaway", kind: "shareholder_letter", date: "2026-02-28", date_basis: "file_modified", url: "https://www.berkshirehathaway.com/letters/2025ltr.pdf" }),
      letter("c", { title: "Annual report to shareholders", entity: "Coherent Corp.", kind: "annual_report", date: "2026-10-09", date_basis: "filed", url: "https://www.sec.gov/x.pdf" }),
    ],
    hasMore: false, limit: 50, offset: 0,
  }));
  const registry = await mount();
  const frame = await tui.waitForFrameToContain("Letter to shareholders, 2025");
  expect(frame).toContain("DATE BASIS");
  expect(frame).toMatch(/2026-09-22 Published/);
  expect(frame).toMatch(/2026-02-28 File updated/);
  expect(frame).toMatch(/2026-10-09 Filed/);
  const published = renderedReportFreshness(registry.snapshot());
  expect(published).toEqual({ status: "not-a-feed", basis: "public letters" });
  // NI declares "published stories" for its news codes; LTR's own node replaces it.
  const line = formatFreshnessLine(deriveRenderedFreshness({ status: "not-a-feed", basis: "published stories", ...published }, { footerText: "", cellTimes: [] }));
  expect(line).toContain("not a live feed (public letters)");
  expect(line).not.toContain("stories");
});

test("too narrow for the Date basis column, the footer names the selected row's", async () => {
  serve(() => Response.json({
    items: [letter("b", { title: "Letter 2025", date_basis: "file_modified" })],
    hasMore: false, limit: 50, offset: 0,
  }));
  await mount(44);
  const frame = await tui.waitForFrameToContain("Letter 2025");
  expect(frame).not.toContain("DATE BASIS");
  expect(frame).toContain("file updated");
});
