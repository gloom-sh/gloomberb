import { expect, spyOn, test } from "bun:test";
import { act, type ReactNode } from "react";
import { apiClient, type CloudEconEventPayload } from "../../../api-client";
import type { DesktopPaneShotPayload, DesktopPaneShotRenderResult } from "../../../cli/desktop-pane-shot";
import type { ResolvedPaneFunction } from "../../../cli/pane-functions/resolver";
import { assessPaneScreenshot } from "../../../cli/pane-functions/screenshot-assessment";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createRemoteUiRegistry, RemoteUiRegistryProvider } from "../../../remote/semantic-tree";
import { WebDataTable } from "../../../renderers/dom/data-table";
import { WebInputHostProvider } from "../../../renderers/dom/input-host";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { createInitialState } from "../../../state/app/context";
import { TestPaneProvider } from "../../../test-support/pane";
import { assessDrawnTables } from "../../../test-support/strict-table-capture";
import { createDefaultConfig } from "../../../types/config";
import { UiHostProvider, useRendererHost, useUiHost } from "../../../ui";
import type { PluginRuntimeAccess } from "../../runtime";
import { resetEconCalendarPersistence } from "./calendar-model";
import { economicCalendarModule } from "./index";

const { render, window: testWindow } = createDomTestHarness();
/** happy-dom has no layout, so give the table body a viewport tall enough for every row. */
for (const property of ["offsetHeight", "clientHeight"]) {
  Object.defineProperty(testWindow.HTMLElement.prototype, property, { configurable: true, value: 18 * 50 });
}

test("a cold calendar is not usable as a strict shot until a zero-event response arrives", async () => {
  resetEconCalendarPersistence();
  const response = Promise.withResolvers<CloudEconEventPayload[]>();
  const read = spyOn(apiClient, "getCloudEconomicCalendar").mockReturnValue(response.promise);
  const registry = createRemoteUiRegistry();
  const pane = economicCalendarModule.panes![0]!;
  const EconPane = pane.component;
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-econ-test"));
  const resolved = {
    token: "ECO", label: pane.name, options: {}, pane, instance: { settings: {} },
    capability: { id: "econ-calendar-pane", botSafe: false, outputKind: "rendered-view", reportReadiness: "live-dom", screenshotReadiness: "live-dom" },
  } as ResolvedPaneFunction;
  try {
    const container = await render(
      <RemoteUiRegistryProvider registry={registry}>
        <TestPaneProvider state={state} paneId={pane.id} runtime={{} as PluginRuntimeAccess} pluginId="econ">
          <WebInputHostProvider>
            <PaneFooterProvider>
              {() => <EconPane paneId={pane.id} paneType={pane.id} focused width={110} height={24} />}
            </PaneFooterProvider>
          </WebInputHostProvider>
        </TestPaneProvider>
      </RemoteUiRegistryProvider>,
    );
    const capture = () => assessPaneScreenshot(resolved, { financials: [] } as unknown as DesktopPaneShotPayload, {
      visibleText: container.textContent ?? "", rows: [], semanticUi: registry.snapshot(),
      loadingStateDetected: !!container.querySelector('[data-gloom-status="loading"]'),
      emptyStateDetected: !!container.querySelector('[data-gloom-status="empty"]'),
    } as unknown as DesktopPaneShotRenderResult, "", "/tmp/eco-test.png");
    expect(capture()).toMatchObject({ usable: false, unusableReason: "The pane was still loading when the screenshot was captured." });
    await act(async () => { response.resolve([]); });
    expect(capture()).toMatchObject({ rowCount: 0, complete: true, usable: true, unusableReason: null });
  } finally {
    read.mockRestore();
    resetEconCalendarPersistence();
  }
});

/** The desktop's own table, whose rows and cells a capture reads. */
function DesktopTables({ children }: { children: ReactNode }) {
  const ui = useUiHost();
  return <UiHostProvider ui={{ ...ui, DataTable: WebDataTable }} renderer={useRendererHost()}>{children}</UiHostProvider>;
}

// The pane's own FORECAST and PRIOR columns passed a strict capture with every figure row blank while the whole column was exempt.
test("the calendar's own columns fail a strict shot whose released rows have no forecast, and not one of speeches", async () => {
  const pane = economicCalendarModule.panes![0]!;
  const EconPane = pane.component;
  const released = Date.now() - 3 * 3_600_000;
  const row = (index: number, overrides: Partial<CloudEconEventPayload>): CloudEconEventPayload => ({
    id: `e${index}`, date: new Date(released - (released % 300_000) + index * 300_000).toISOString(), time: "12:00", country: "US",
    event: `Release ${index}`, actual: "0.3%", forecast: null, prior: "0.4%", impact: "high", ...overrides,
  });
  const strict = async (events: CloudEconEventPayload[]) => {
    resetEconCalendarPersistence();
    const read = spyOn(apiClient, "getCloudEconomicCalendar").mockResolvedValue(events);
    const registry = createRemoteUiRegistry();
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-econ-test"));
    try {
      const container = await render(
        <RemoteUiRegistryProvider registry={registry}>
          <DesktopTables>
            <TestPaneProvider state={state} paneId={pane.id} runtime={{} as PluginRuntimeAccess} pluginId="econ">
              <WebInputHostProvider>
                <PaneFooterProvider>
                  {() => <EconPane paneId={pane.id} paneType={pane.id} focused width={110} height={24} />}
                </PaneFooterProvider>
              </WebInputHostProvider>
            </TestPaneProvider>
          </DesktopTables>
        </RemoteUiRegistryProvider>,
      );
      for (let turn = 0; turn < 50 && !container.querySelector('[data-gloom-role="data-table-row"]'); turn++) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      }
      return assessDrawnTables(container, registry);
    } finally {
      read.mockRestore();
      resetEconCalendarPersistence();
    }
  };
  const figures = [0, 1, 2].map((index) => row(index, {}));
  const speeches = [3, 4, 5].map((index) => row(index, { event: `Speech ${index}`, actual: null, prior: null }));
  expect(await strict([...figures, ...speeches])).toMatchObject({
    usable: false, blankColumns: ["FORECAST"], unusableReason: "The FORECAST column is blank in every row.",
  });
  expect(await strict(speeches)).toMatchObject({ usable: true, unusableReason: null });
});
