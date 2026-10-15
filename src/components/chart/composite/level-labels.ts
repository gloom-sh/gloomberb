import type { CSSProperties } from "react";
import { blendForContrast, higherContrast } from "../../../theme/color-utils";
import { fitAxisLabels, type ProjectedLevel } from "./levels";

const GAP = 3;
const HALO = 2;

/** Space outside the plot for read-only annotations. Unlabelled charts keep every column. */
export function levelLabelGutter(levels: readonly { label?: string; editable: boolean }[], width: number): number {
  const labels = levels.filter((level) => !level.editable && level.label).map((level) => level.label!.length);
  // Keep the plot still as a draft gains a digit or an order changes status.
  return labels.length ? Math.min(32, Math.max(1, Math.floor(width / 3))) : 0;
}

/** DOM annotations sit above the SVG's ratio-space line, not on its text row. */
export function layoutLevelLabels(levels: readonly ProjectedLevel[], plotHeight: number, textHeight: number) {
  const candidates = levels.filter(({ level }) => level.label).map((entry) => {
    const lineY = entry.yRatio * plotHeight;
    const below = lineY < textHeight + GAP + HALO;
    const top = below ? lineY + GAP : lineY - GAP - textHeight;
    return { ...entry, below, top };
  }).filter(({ top }) => top >= HALO && top + textHeight + HALO <= plotHeight);
  // Flipping at the top can place two otherwise separated lines' labels on
  // the same row. Apply the existing priority policy to their actual boxes.
  return fitAxisLabels(candidates, [], ({ top }) => top / (textHeight + 2 * HALO));
}

export function levelLabelStyle({ yRatio, below, level }: ProjectedLevel & { below: boolean }, background: string): CSSProperties {
  return {
    top: `${yRatio * 100}%`,
    transform: below ? `translateY(${GAP}px)` : `translateY(calc(-100% - ${GAP}px))`,
    pointerEvents: "none",
    paddingInline: 4,
    color: blendForContrast(level.color, background, higherContrast("#000000", "#ffffff", background), 4.5),
    WebkitTextStroke: `${HALO}px ${background}`,
    paintOrder: "stroke fill",
  };
}
