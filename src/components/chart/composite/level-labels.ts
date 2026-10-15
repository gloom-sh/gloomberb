import type { CSSProperties } from "react";
import { blendForContrast, higherContrast } from "../../../theme/color-utils";
import { fitAxisLabels, type CompositeChartLevel, type ProjectedLevel } from "./levels";

/** Keep a precise price in the tag only when it has no readable axis marker. */
export function levelLabelText(level: CompositeChartLevel, axisVisible: boolean): string {
  return `${level.label ?? ""}${!axisVisible && level.axisLabel ? ` ${level.axisLabel}` : ""}`;
}

/** Compact DOM tags straddle their line; crowded or clipped tags yield. */
export function layoutLevelLabels(levels: readonly ProjectedLevel[], plotHeight: number, textHeight: number) {
  const candidates = levels.filter(({ level }) => level.label).map((entry) => ({
    ...entry, top: entry.yRatio * plotHeight - textHeight / 2,
  })).filter(({ top }) => top >= 0 && top + textHeight <= plotHeight);
  return fitAxisLabels(candidates, [], ({ top }) => top / textHeight);
}

export function levelLabelStyle({ yRatio, level }: ProjectedLevel, background: string): CSSProperties {
  return {
    top: `${yRatio * 100}%`,
    transform: "translateY(-50%)",
    pointerEvents: "none",
    paddingInline: 3,
    height: "auto",
    width: "max-content",
    border: `1px solid ${level.color}`,
    backgroundColor: background,
    color: blendForContrast(level.color, background, higherContrast("#000000", "#ffffff", background), 4.5),
  };
}
