import type { CompositeViewportRange } from "./interactions";
import type { CompositeChartScene } from "./types";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30.4375 * DAY_MS;
const YEAR_MS = 365.25 * DAY_MS;
const MONDAY_ANCHOR_MS = Date.UTC(1970, 0, 5);

type CompositeTimeAxisUnit =
  | "millisecond"
  | "second"
  | "minute"
  | "hour"
  | "day"
  | "week"
  | "month"
  | "year";

interface CompositeTimeAxisInterval {
  unit: CompositeTimeAxisUnit;
  step: number;
  approximateMs: number;
}

interface CompositeTimeAxisSample {
  timestamp: number;
  ratio: number;
}

interface CompositeTimeAxisCandidate extends CompositeTimeAxisSample {
  boundary: boolean;
}

export interface CompositeTimeAxisTick extends CompositeTimeAxisSample {
  label: string;
  start: number;
  end: number;
}

export interface CompositeTimeAxisLayout {
  text: string;
  ticks: CompositeTimeAxisTick[];
}

const TIME_AXIS_INTERVALS: readonly CompositeTimeAxisInterval[] = [
  { unit: "millisecond", step: 1, approximateMs: 1 },
  { unit: "millisecond", step: 5, approximateMs: 5 },
  { unit: "millisecond", step: 10, approximateMs: 10 },
  { unit: "millisecond", step: 50, approximateMs: 50 },
  { unit: "millisecond", step: 100, approximateMs: 100 },
  { unit: "millisecond", step: 250, approximateMs: 250 },
  { unit: "millisecond", step: 500, approximateMs: 500 },
  { unit: "second", step: 1, approximateMs: SECOND_MS },
  { unit: "second", step: 5, approximateMs: 5 * SECOND_MS },
  { unit: "second", step: 15, approximateMs: 15 * SECOND_MS },
  { unit: "second", step: 30, approximateMs: 30 * SECOND_MS },
  { unit: "minute", step: 1, approximateMs: MINUTE_MS },
  { unit: "minute", step: 5, approximateMs: 5 * MINUTE_MS },
  { unit: "minute", step: 15, approximateMs: 15 * MINUTE_MS },
  { unit: "minute", step: 30, approximateMs: 30 * MINUTE_MS },
  { unit: "hour", step: 1, approximateMs: HOUR_MS },
  { unit: "hour", step: 2, approximateMs: 2 * HOUR_MS },
  { unit: "hour", step: 4, approximateMs: 4 * HOUR_MS },
  { unit: "hour", step: 6, approximateMs: 6 * HOUR_MS },
  { unit: "hour", step: 12, approximateMs: 12 * HOUR_MS },
  { unit: "day", step: 1, approximateMs: DAY_MS },
  { unit: "day", step: 2, approximateMs: 2 * DAY_MS },
  { unit: "week", step: 1, approximateMs: WEEK_MS },
  { unit: "week", step: 2, approximateMs: 2 * WEEK_MS },
  { unit: "month", step: 1, approximateMs: MONTH_MS },
  { unit: "month", step: 2, approximateMs: 2 * MONTH_MS },
  { unit: "month", step: 3, approximateMs: 3 * MONTH_MS },
  { unit: "month", step: 6, approximateMs: 6 * MONTH_MS },
  { unit: "year", step: 1, approximateMs: YEAR_MS },
  { unit: "year", step: 2, approximateMs: 2 * YEAR_MS },
  { unit: "year", step: 5, approximateMs: 5 * YEAR_MS },
  { unit: "year", step: 10, approximateMs: 10 * YEAR_MS },
  { unit: "year", step: 20, approximateMs: 20 * YEAR_MS },
  { unit: "year", step: 50, approximateMs: 50 * YEAR_MS },
] as const;

const clamp = (value: number, min: number, max: number) => (
  Math.max(min, Math.min(max, value))
);

function validTimestamp(value: number): boolean {
  return Number.isFinite(value);
}

function axisLabelWidth(interval: CompositeTimeAxisInterval, startTime: number, endTime: number): number {
  const start = new Date(startTime);
  const end = new Date(endTime);
  const spansDays = start.getUTCFullYear() !== end.getUTCFullYear()
    || start.getUTCMonth() !== end.getUTCMonth()
    || start.getUTCDate() !== end.getUTCDate();
  const spansYears = start.getUTCFullYear() !== end.getUTCFullYear();

  switch (interval.unit) {
    case "millisecond":
      return spansDays ? 20 : 12;
    case "second":
      return spansDays ? 16 : 8;
    case "minute":
    case "hour":
      return spansDays ? 13 : 5;
    case "day":
    case "week":
      return spansYears ? 11 : 6;
    case "month":
      return 8;
    case "year":
      return 4;
  }
}

function resolveTimeAxisInterval(
  startTime: number,
  endTime: number,
  width: number,
): CompositeTimeAxisInterval {
  const span = Math.max(endTime - startTime, 1);
  for (const interval of TIME_AXIS_INTERVALS) {
    const labelWidth = axisLabelWidth(interval, startTime, endTime);
    const maximumLabels = Math.max(2, Math.floor(width / (labelWidth + 2)));
    const estimatedLabels = Math.floor(span / interval.approximateMs) + 1;
    if (estimatedLabels <= maximumLabels) return interval;
  }
  return TIME_AXIS_INTERVALS.at(-1)!;
}

function nextFixedBoundary(
  startTime: number,
  intervalMs: number,
  anchorTime = 0,
): number {
  const steps = Math.floor((startTime - anchorTime) / intervalMs) + 1;
  return anchorTime + steps * intervalMs;
}

function nextMonthBoundary(startTime: number, step: number): number {
  const start = new Date(startTime);
  const monthIndex = start.getUTCFullYear() * 12 + start.getUTCMonth();
  let alignedIndex = Math.floor(monthIndex / step) * step;
  let boundary = Date.UTC(
    Math.floor(alignedIndex / 12),
    alignedIndex % 12,
    1,
  );
  if (boundary <= startTime) {
    alignedIndex += step;
    boundary = Date.UTC(
      Math.floor(alignedIndex / 12),
      alignedIndex % 12,
      1,
    );
  }
  return boundary;
}

function nextYearBoundary(startTime: number, step: number): number {
  const startYear = new Date(startTime).getUTCFullYear();
  let year = Math.floor(startYear / step) * step;
  let boundary = Date.UTC(year, 0, 1);
  if (boundary <= startTime) {
    year += step;
    boundary = Date.UTC(year, 0, 1);
  }
  return boundary;
}

function calendarBoundaries(
  startTime: number,
  endTime: number,
  interval: CompositeTimeAxisInterval,
): number[] {
  let boundary: number;
  let advance: (timestamp: number) => number;

  switch (interval.unit) {
    case "millisecond":
      boundary = nextFixedBoundary(startTime, interval.step);
      advance = (timestamp) => timestamp + interval.step;
      break;
    case "second":
      boundary = nextFixedBoundary(startTime, interval.step * SECOND_MS);
      advance = (timestamp) => timestamp + interval.step * SECOND_MS;
      break;
    case "minute":
      boundary = nextFixedBoundary(startTime, interval.step * MINUTE_MS);
      advance = (timestamp) => timestamp + interval.step * MINUTE_MS;
      break;
    case "hour":
      boundary = nextFixedBoundary(startTime, interval.step * HOUR_MS);
      advance = (timestamp) => timestamp + interval.step * HOUR_MS;
      break;
    case "day":
      boundary = nextFixedBoundary(startTime, interval.step * DAY_MS);
      advance = (timestamp) => timestamp + interval.step * DAY_MS;
      break;
    case "week":
      boundary = nextFixedBoundary(
        startTime,
        interval.step * WEEK_MS,
        MONDAY_ANCHOR_MS,
      );
      advance = (timestamp) => timestamp + interval.step * WEEK_MS;
      break;
    case "month":
      boundary = nextMonthBoundary(startTime, interval.step);
      advance = (timestamp) => {
        const date = new Date(timestamp);
        return Date.UTC(
          date.getUTCFullYear(),
          date.getUTCMonth() + interval.step,
          1,
        );
      };
      break;
    case "year":
      boundary = nextYearBoundary(startTime, interval.step);
      advance = (timestamp) => (
        Date.UTC(new Date(timestamp).getUTCFullYear() + interval.step, 0, 1)
      );
      break;
  }

  const boundaries: number[] = [];
  while (boundary < endTime && boundaries.length < 1_000) {
    boundaries.push(boundary);
    const next = advance(boundary);
    if (!validTimestamp(next) || next <= boundary) break;
    boundary = next;
  }
  return boundaries;
}

function intervalBucketKey(
  timestamp: number,
  interval: CompositeTimeAxisInterval,
): number {
  switch (interval.unit) {
    case "millisecond":
      return Math.floor(timestamp / interval.step);
    case "second":
      return Math.floor(timestamp / (interval.step * SECOND_MS));
    case "minute":
      return Math.floor(timestamp / (interval.step * MINUTE_MS));
    case "hour":
      return Math.floor(timestamp / (interval.step * HOUR_MS));
    case "day":
      return Math.floor(timestamp / (interval.step * DAY_MS));
    case "week":
      return Math.floor((timestamp - MONDAY_ANCHOR_MS) / (interval.step * WEEK_MS));
    case "month": {
      const date = new Date(timestamp);
      const monthIndex = date.getUTCFullYear() * 12 + date.getUTCMonth();
      return Math.floor(monthIndex / interval.step);
    }
    case "year":
      return Math.floor(new Date(timestamp).getUTCFullYear() / interval.step);
  }
}

function lowerBoundSample(samples: readonly CompositeTimeAxisSample[], timestamp: number): number {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (samples[middle]!.timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function normalizeMarketSamples(scene: CompositeChartScene): CompositeTimeAxisSample[] {
  const samples = scene.dates.flatMap((date, index) => {
    const timestamp = date.getTime();
    const ratio = scene.dateRatios[index];
    return validTimestamp(timestamp) && typeof ratio === "number" && Number.isFinite(ratio)
      ? [{ timestamp, ratio: clamp(ratio, 0, 1) }]
      : [];
  }).sort((left, right) => left.timestamp - right.timestamp || left.ratio - right.ratio);

  return samples.filter((sample, index) => (
    index === 0
    || sample.timestamp !== samples[index - 1]!.timestamp
    || sample.ratio !== samples[index - 1]!.ratio
  ));
}

function sameUtcDay(left: number, right: number): boolean {
  const leftDate = new Date(left);
  const rightDate = new Date(right);
  return leftDate.getUTCFullYear() === rightDate.getUTCFullYear()
    && leftDate.getUTCMonth() === rightDate.getUTCMonth()
    && leftDate.getUTCDate() === rightDate.getUTCDate();
}

function sameUtcMonth(left: number, right: number): boolean {
  const leftDate = new Date(left);
  const rightDate = new Date(right);
  return leftDate.getUTCFullYear() === rightDate.getUTCFullYear()
    && leftDate.getUTCMonth() === rightDate.getUTCMonth();
}

function clockLabel(timestamp: number, unit: CompositeTimeAxisUnit): string {
  const date = new Date(timestamp);
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  const milliseconds = String(date.getUTCMilliseconds()).padStart(3, "0");
  if (unit === "millisecond") return `${hours}:${minutes}:${seconds}.${milliseconds}`;
  if (unit === "second") return `${hours}:${minutes}:${seconds}`;
  return `${hours}:${minutes}`;
}

function calendarLabel(timestamp: number, includeYear: boolean): string {
  const date = new Date(timestamp);
  const base = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  return includeYear ? `${base} ${date.getUTCFullYear()}` : base;
}

function formatBoundaryLabel(
  timestamp: number,
  counterpart: number,
  interval: CompositeTimeAxisInterval,
  includeTimeZone = true,
  includeBoundaryYear = true,
): string {
  const date = new Date(timestamp);
  switch (interval.unit) {
    case "millisecond":
    case "second":
    case "minute":
    case "hour": {
      const clock = clockLabel(timestamp, interval.unit);
      const suffix = includeTimeZone ? " UTC" : "";
      if (sameUtcDay(timestamp, counterpart)) return `${clock}${suffix}`;
      const includeYear = includeBoundaryYear
        && date.getUTCFullYear() !== new Date(counterpart).getUTCFullYear();
      return `${calendarLabel(timestamp, includeYear)} ${clock}${suffix}`;
    }
    case "day":
    case "week":
      return calendarLabel(
        timestamp,
        includeBoundaryYear
          && date.getUTCFullYear() !== new Date(counterpart).getUTCFullYear(),
      );
    case "month":
      return calendarLabel(timestamp, includeBoundaryYear);
    case "year":
      return `${date.getUTCFullYear()}`;
  }
}

function formatInteriorLabel(
  timestamp: number,
  previousTimestamp: number,
  interval: CompositeTimeAxisInterval,
): string {
  const date = new Date(timestamp);
  const previous = new Date(previousTimestamp);
  switch (interval.unit) {
    case "millisecond":
    case "second":
    case "minute":
    case "hour": {
      const clock = clockLabel(timestamp, interval.unit);
      if (sameUtcDay(timestamp, previousTimestamp)) return clock;
      return `${calendarLabel(
        timestamp,
        date.getUTCFullYear() !== previous.getUTCFullYear(),
      )} ${clock}`;
    }
    case "day":
    case "week":
      if (sameUtcMonth(timestamp, previousTimestamp)) return `${date.getUTCDate()}`;
      return calendarLabel(
        timestamp,
        date.getUTCFullYear() !== previous.getUTCFullYear(),
      );
    case "month":
      return date.getUTCFullYear() === previous.getUTCFullYear()
        ? MONTHS[date.getUTCMonth()]!
        : `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
    case "year":
      return `${date.getUTCFullYear()}`;
  }
}

function resolveLabelStart(center: number, label: string, width: number): number {
  return clamp(
    Math.round(center - label.length / 2),
    0,
    Math.max(width - label.length, 0),
  );
}

function writeLabel(axis: string[], start: number, label: string): void {
  for (let index = 0; index < label.length && start + index < axis.length; index += 1) {
    axis[start + index] = label[index]!;
  }
}

function addCandidate(
  candidates: CompositeTimeAxisCandidate[],
  candidate: CompositeTimeAxisCandidate,
): void {
  const duplicate = candidates.some((existing) => (
    Math.abs(existing.ratio - candidate.ratio) < 1e-9
    || existing.timestamp === candidate.timestamp
  ));
  if (!duplicate) candidates.push(candidate);
}

function layoutTimeAxis({
  startTime,
  endTime,
  width,
  samples,
}: {
  startTime: number;
  endTime: number;
  width: number;
  samples?: readonly CompositeTimeAxisSample[];
}): CompositeTimeAxisLayout {
  const axisWidth = Math.max(1, Math.floor(width));
  const axis = Array(axisWidth).fill(" ");
  if (!validTimestamp(startTime) || !validTimestamp(endTime) || endTime < startTime) {
    return { text: axis.join(""), ticks: [] };
  }

  const interval = resolveTimeAxisInterval(startTime, endTime, axisWidth);
  const marketSamples = samples?.length ? [...samples] : null;
  const firstTimestamp = startTime;
  const lastTimestamp = endTime;
  const candidates: CompositeTimeAxisCandidate[] = [{
    timestamp: firstTimestamp,
    ratio: 0,
    boundary: true,
  }];
  const firstBucket = intervalBucketKey(firstTimestamp, interval);

  for (const boundary of calendarBoundaries(startTime, endTime, interval)) {
    if (marketSamples) {
      const sample = marketSamples[lowerBoundSample(marketSamples, boundary)];
      if (
        sample
        && intervalBucketKey(sample.timestamp, interval) !== firstBucket
        && sample.timestamp < lastTimestamp
        && sample.ratio < 1
      ) {
        addCandidate(candidates, { ...sample, boundary: false });
      }
      continue;
    }
    const bucket = intervalBucketKey(boundary, interval);
    if (bucket === firstBucket) continue;
    const span = Math.max(endTime - startTime, 1);
    addCandidate(candidates, {
      timestamp: boundary,
      ratio: clamp((boundary - startTime) / span, 0, 1),
      boundary: false,
    });
  }

  addCandidate(candidates, {
    timestamp: lastTimestamp,
    ratio: 1,
    boundary: true,
  });
  candidates.sort((left, right) => left.ratio - right.ratio || left.timestamp - right.timestamp);

  if (candidates.length === 1 || firstTimestamp === lastTimestamp) {
    const label = formatBoundaryLabel(firstTimestamp, lastTimestamp, interval);
    const visibleLabel = label.slice(0, axisWidth);
    const start = Math.max(Math.floor((axisWidth - visibleLabel.length) / 2), 0);
    writeLabel(axis, start, visibleLabel);
    return {
      text: axis.join(""),
      ticks: [{
        timestamp: firstTimestamp,
        ratio: 0.5,
        label: visibleLabel,
        start,
        end: start + visibleLabel.length - 1,
      }],
    };
  }

  let startLabel = formatBoundaryLabel(firstTimestamp, lastTimestamp, interval);
  let endLabel = formatBoundaryLabel(lastTimestamp, firstTimestamp, interval);
  if (startLabel.length + endLabel.length + 1 > axisWidth) {
    startLabel = formatBoundaryLabel(firstTimestamp, lastTimestamp, interval, false);
    endLabel = formatBoundaryLabel(lastTimestamp, firstTimestamp, interval, false);
  }
  if (startLabel.length + endLabel.length + 1 > axisWidth) {
    startLabel = formatBoundaryLabel(firstTimestamp, lastTimestamp, interval, false, false);
    endLabel = formatBoundaryLabel(lastTimestamp, firstTimestamp, interval, false, false);
  }
  if (startLabel.length + endLabel.length + 1 > axisWidth) {
    const visibleLabel = startLabel.slice(0, axisWidth);
    writeLabel(axis, 0, visibleLabel);
    return {
      text: axis.join(""),
      ticks: [{
        timestamp: firstTimestamp,
        ratio: 0,
        label: visibleLabel,
        start: 0,
        end: visibleLabel.length - 1,
      }],
    };
  }

  const placed: CompositeTimeAxisTick[] = [];
  writeLabel(axis, 0, startLabel);
  placed.push({
    timestamp: firstTimestamp,
    ratio: 0,
    label: startLabel,
    start: 0,
    end: startLabel.length - 1,
  });

  const endPadding = axisWidth > startLabel.length + endLabel.length + 2 ? 1 : 0;
  const endStart = axisWidth - endLabel.length - endPadding;
  const minimumGap = interval.unit === "month" || interval.unit === "year" ? 2 : 1;
  let previousTimestamp = firstTimestamp;
  let previousEnd = startLabel.length - 1;
  for (const candidate of candidates.filter((entry) => !entry.boundary)) {
    const label = formatInteriorLabel(candidate.timestamp, previousTimestamp, interval);
    const center = candidate.ratio * Math.max(axisWidth - 1, 0);
    const start = resolveLabelStart(center, label, axisWidth);
    const end = start + label.length - 1;
    if (start <= previousEnd + minimumGap) continue;
    if (end >= endStart - minimumGap) continue;
    writeLabel(axis, start, label);
    placed.push({
      timestamp: candidate.timestamp,
      ratio: candidate.ratio,
      label,
      start,
      end,
    });
    previousTimestamp = candidate.timestamp;
    previousEnd = end;
  }

  writeLabel(axis, endStart, endLabel);
  placed.push({
    timestamp: lastTimestamp,
    ratio: 1,
    label: endLabel,
    start: endStart,
    end: endStart + endLabel.length - 1,
  });

  return {
    text: axis.join(""),
    ticks: placed,
  };
}

export function buildCompositeTimeAxisLayout(
  scene: CompositeChartScene,
  width: number,
): CompositeTimeAxisLayout {
  return layoutTimeAxis({
    startTime: scene.startTime,
    endTime: scene.endTime,
    width,
    samples: scene.timeScale.kind === "market"
      ? normalizeMarketSamples(scene)
      : undefined,
  });
}

export function buildCompositeViewportTimeAxisLayout(
  viewport: CompositeViewportRange,
  width: number,
): CompositeTimeAxisLayout {
  return layoutTimeAxis({
    startTime: viewport.start.getTime(),
    endTime: viewport.end.getTime(),
    width,
  });
}
