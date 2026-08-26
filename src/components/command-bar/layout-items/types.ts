import type { Dispatch } from "react";
import type { PluginRegistry } from "../../../plugins/registry";
import type { AppAction, AppState } from "../../../state/app/context";
import type { LayoutConfig } from "../../../types/config";
import type { OpenInlineConfirm } from "../routing/confirm";
import type { CommandBarRoute } from "../workflow/types";

export type CloseAll = (options?: { revertThemePreview?: boolean }) => void;
export type { OpenInlineConfirm } from "../routing/confirm";

export interface LayoutItemsContext {
  closeAll: CloseAll;
  confirmDangerousActions?: boolean;
  currentLayout: LayoutConfig;
  dispatch: Dispatch<AppAction>;
  duplicatePane: (paneId: string) => void;
  focusedPaneId: string | null;
  notifyGridlockRevert: () => void;
  openBuiltInWorkflow: (actionId: string) => void;
  openInlineConfirm: OpenInlineConfirm;
  persistLayoutChange: (layout: LayoutConfig) => void;
  pluginRegistry: PluginRegistry;
  pushRoute: (route: CommandBarRoute) => void;
  state: AppState;
}
