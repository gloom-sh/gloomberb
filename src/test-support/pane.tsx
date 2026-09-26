import type { Dispatch, ReactNode } from "react";
import { PaneFooterBar, PaneFooterKeys, PaneFooterProvider, type CombinedPaneFooter } from "../components/layout/pane/footer";
import { AppContext, PaneInstanceProvider, type AppAction, type AppState } from "../state/app/context";
import { PluginRenderProvider, type PluginRuntimeAccess } from "../plugins/runtime";
import { Box } from "../ui";
import { cloneLayout, createDefaultConfig, type AppConfig, type PaneInstanceConfig } from "../types/config";

export { createTestTicker } from "./ticker";

interface TestPaneProviderProps {
  state: AppState;
  dispatch?: Dispatch<AppAction>;
  paneId: string;
  pluginId: string;
  runtime: PluginRuntimeAccess;
  children: ReactNode;
}

/** Provider wiring only: the suite retains ownership of its state and update timing. */
export function TestPaneProvider({
  state, dispatch = () => {}, paneId, pluginId, runtime, children,
}: TestPaneProviderProps) {
  return (
    <AppContext value={{ state, dispatch }}>
      <PaneInstanceProvider paneId={paneId}>
        <PluginRenderProvider pluginId={pluginId} runtime={runtime}>
          {children}
        </PluginRenderProvider>
      </PaneInstanceProvider>
    </AppContext>
  );
}

/**
 * A focused pane inside TestPaneProvider with the footer bar the app draws under it. `children`
 * renders the pane into the body above the footer and runs again with each footer the pane
 * registers. `footerKeys` also binds the footer's shortcut keys.
 */
export function TestPaneFrame({
  width, height, footerKeys = false, children, ...provider
}: Omit<TestPaneProviderProps, "children"> & {
  width: number;
  height: number;
  footerKeys?: boolean;
  children: (body: { width: number; height: number }, footer: CombinedPaneFooter) => ReactNode;
}) {
  const body = { width, height: height - 1 };
  return (
    <TestPaneProvider {...provider}>
      <PaneFooterProvider>{(footer) => (
        <Box width={width} height={height} flexDirection="column">
          <Box width={width} height={body.height} flexShrink={0}>{children(body, footer)}</Box>
          <PaneFooterBar footer={footer} focused width={width} />
          {footerKeys ? <PaneFooterKeys paneId={provider.paneId} footer={footer} focused /> : null}
        </Box>
      )}</PaneFooterProvider>
    </TestPaneProvider>
  );
}

export function createTestPaneConfig(dataDir: string, instance: PaneInstanceConfig): AppConfig {
  const layout: AppConfig["layout"] = {
    dockRoot: { kind: "pane", instanceId: instance.instanceId },
    instances: [instance], floating: [], detached: [],
  };
  return {
    ...createDefaultConfig(dataDir), layout,
    layouts: [{ name: "Default", layout: cloneLayout(layout) }],
  };
}
