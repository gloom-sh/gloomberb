import type { SpeedometerSegment } from "../../../components";
import { colors } from "../../../theme/colors";
import { formatNumber } from "../../../utils/format";
import type {
  FearGreedRating,
  FearGreedValueFormat,
} from "./data";

export const FEAR_GREED_GAUGE_SEGMENTS: SpeedometerSegment[] = [
  { from: 0, to: 24.999, label: "EXTREME FEAR", color: colors.negative },
  { from: 25, to: 44.999, label: "FEAR", color: colors.warning },
  { from: 45, to: 55, label: "NEUTRAL", color: colors.neutral },
  { from: 55.001, to: 75, label: "GREED", color: colors.positive },
  { from: 75.001, to: 100, label: "EXTREME GREED", color: colors.positive },
];

export function ratingLabel(rating: FearGreedRating): string {
  return rating.toUpperCase();
}

export function ratingColor(rating: FearGreedRating): string {
  switch (rating) {
    case "extreme fear":
      return colors.negative;
    case "fear":
      return colors.warning;
    case "neutral":
      return colors.neutral;
    case "greed":
    case "extreme greed":
      return colors.positive;
  }
}

export function ratingTrend(rating: FearGreedRating): "positive" | "negative" | "neutral" {
  switch (rating) {
    case "extreme fear":
    case "fear":
      return "negative";
    case "neutral":
      return "neutral";
    case "greed":
    case "extreme greed":
      return "positive";
  }
}

export function formatScore(score: number | null | undefined): string {
  if (score == null || Number.isNaN(score)) return "--";
  return String(Math.round(score));
}

export function formatIndicatorValue(value: number | null | undefined, format: FearGreedValueFormat): string {
  if (value == null || Number.isNaN(value)) return "--";
  switch (format) {
    case "score":
      return formatScore(value);
    case "percent":
      return `${formatNumber(value, 2)}%`;
    case "ratio":
      return value.toFixed(2);
    case "number": {
      const abs = Math.abs(value);
      if (abs >= 1000) return formatNumber(value, 0);
      if (abs >= 100) return formatNumber(value, 1);
      return formatNumber(value, 2);
    }
  }
}

export function formatAxisValue(format: FearGreedValueFormat): (value: number) => string {
  return (value) => formatIndicatorValue(value, format);
}

export function formatUpdatedAt(date: Date | null): string {
  if (!date) return "Last updated --";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `Last updated ${part("month")} ${part("day")} at ${part("hour")}:${part("minute")} ${part("dayPeriod")} ET`;
}
