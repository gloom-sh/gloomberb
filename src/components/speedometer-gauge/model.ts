import { colors } from "../../theme/colors";
import { clamp } from "../../utils/math";

export interface SpeedometerSegment {
  from: number;
  to: number;
  label: string;
  color: string;
}

export interface SpeedometerGaugeProps {
  value: number;
  valueLabel: string;
  width: number;
  segments: SpeedometerSegment[];
  min?: number;
  max?: number;
  currentLabel?: string;
  minWidth?: number;
  maxWidth?: number;
  compact?: boolean;
}

export const DEFAULT_MIN_WIDTH = 34;
export const DEFAULT_MAX_WIDTH = 50;

export function normalizeValue(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return clamp((value - min) / (max - min), 0, 1);
}

export function valueToAngle(value: number, min: number, max: number): number {
  return Math.PI - normalizeValue(value, min, max) * Math.PI;
}

export function valueToDegrees(value: number, min: number, max: number): number {
  return -90 + normalizeValue(value, min, max) * 180;
}

export function formatGaugeValue(value: number): string {
  if (!Number.isFinite(value)) return "--";
  return String(Math.round(value));
}

export function compactSegmentLabel(segment: SpeedometerSegment): string {
  return segment.label.replace(/^EXTREME /, "EXT ");
}

function segmentForValue(value: number, segments: SpeedometerSegment[]): SpeedometerSegment | null {
  return segments.find((segment) => value >= segment.from && value <= segment.to)
    ?? segments[segments.length - 1]
    ?? null;
}

export function segmentColorForScore(score: number, segments: SpeedometerSegment[]): string {
  return segmentForValue(score, segments)?.color ?? colors.textDim;
}
