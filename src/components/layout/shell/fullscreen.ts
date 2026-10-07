import { isPaneInLayout } from "../../../layout/pane-manager";
import { cloneLayout, type LayoutConfig } from "../../../types/config";

export function resolvePaneFocusSourceLayout(
  layout: LayoutConfig,
  paneId: string | null,
): LayoutConfig | null {
  if (!paneId || !isPaneInLayout(layout, paneId)) return null;
  return cloneLayout(layout);
}
