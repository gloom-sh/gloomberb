import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient, type CloudEconEventPayload } from "../../../api-client";
import type { DesktopPaneShotPayload, DesktopPaneShotRenderResult } from "../../../cli/desktop-pane-shot";
import type { ResolvedPaneFunction } from "../../../cli/pane-functions/resolver";
import { assessPaneScreenshot } from "../../../cli/pane-functions/screenshot-assessment";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createRemoteUiRegistry, RemoteUiRegistryProvider } from "../../../remote/semantic-tree";
import { WebInputHostProvider } from "../../../renderers/dom/input-host";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { createInitialState } from "../../../state/app/context";
import { TestPaneProvider } from "../../../test-support/pane";
import { createDefaultConfig } from "../../../types/config";
import type { PluginRuntimeAccess } from "../../runtime";
import { resetEconCalendarPersistence } from "./calendar-model";
import { economicCalendarModule } from "./index";

const { render } = createDomTestHarness();

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
