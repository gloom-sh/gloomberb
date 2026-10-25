import { useUiCapabilities } from "../../ui";
import { useSettledLayoutSize } from "../../ui/resize-settle";

/** Keep responsive column choices through a desktop drag; the table's viewport stays live. */
export function useTableLayoutWidth(width: number): number {
  const { nativePaneChrome } = useUiCapabilities();
  return useSettledLayoutSize(width, 1, {
    enabled: nativePaneChrome === true,
    maxStretch: Infinity,
  }).width;
}
