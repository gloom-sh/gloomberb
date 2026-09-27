import { useUiCapabilities } from "../../../../ui";
import { DesktopZoneColorScale } from "./desktop";
import type { ZoneScaleProps } from "./model";
import { TerminalZoneColorScale } from "./terminal";

export type { ZoneScaleProps } from "./model";

export function ZoneColorScale(props: ZoneScaleProps) {
  return useUiCapabilities().nativePaneChrome === true
    ? <DesktopZoneColorScale {...props} />
    : <TerminalZoneColorScale {...props} />;
}
