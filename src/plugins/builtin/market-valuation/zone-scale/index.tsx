import { useUiHost } from "../../../../ui";
import { DesktopZoneColorScale } from "./desktop";
import type { ZoneScaleProps } from "./model";
import { TerminalZoneColorScale } from "./terminal";

export type { ZoneScaleProps } from "./model";

export function ZoneColorScale(props: ZoneScaleProps) {
  return useUiHost().kind === "desktop-web"
    ? <DesktopZoneColorScale {...props} />
    : <TerminalZoneColorScale {...props} />;
}
