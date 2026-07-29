import { useUiHost } from "../../ui";
import { DesktopSpeedometerGauge } from "./desktop";
import {
  DEFAULT_MAX_WIDTH,
  DEFAULT_MIN_WIDTH,
  type SpeedometerGaugeProps,
} from "./model";
import { TerminalSpeedometerGauge } from "./terminal";

export type {
  SpeedometerGaugeProps,
  SpeedometerSegment,
} from "./model";

export function SpeedometerGauge({
  value,
  valueLabel,
  width,
  segments,
  min = 0,
  max = 100,
  currentLabel = "Current reading",
  minWidth = DEFAULT_MIN_WIDTH,
  maxWidth = DEFAULT_MAX_WIDTH,
  compact = false,
}: SpeedometerGaugeProps) {
  const props = {
    value,
    valueLabel,
    width,
    segments,
    min,
    max,
    currentLabel,
    minWidth,
    maxWidth,
    compact,
  };
  return useUiHost().kind === "desktop-web"
    ? <DesktopSpeedometerGauge {...props} />
    : <TerminalSpeedometerGauge {...props} />;
}
