import {
  removeUnavailablePaneTypes,
  type PaneTypeAvailability,
} from "../../../layout/pane-manager";
import type { LayoutConfig } from "../../../types/config";

export function resolveShellVisibleLayout(
  layout: LayoutConfig,
  disabledPaneIds: ReadonlySet<string>,
  registeredPaneIds: PaneTypeAvailability,
): LayoutConfig {
  return removeUnavailablePaneTypes(
    layout,
    registeredPaneIds,
    { disabledPaneIds },
  );
}
