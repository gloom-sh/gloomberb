import type { ChartShareData } from "../../shares/payload";

export interface SharedChartMark { x: number; y: number; label: string }
export interface SharedChartPanel {
  unit: string;
  hasValues: boolean;
  min: number;
  max: number;
  series: Array<{ name: string; index: number; style: "line" | "step" | "points"; segments: SharedChartMark[][] }>;
}

/** Shared coordinates are data coordinates, never independent row indices. */
export function sharedChartGeometry(data: ChartShareData) {
  const labels = data.series.flatMap((entry) => entry.points.map((point) => point.x));
  const dates = labels.every((value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)
    && Number.isFinite(Date.parse(value)));
  const numeric = labels.every((value) => typeof value === "number");
  const categories = [...new Set(labels.map((value) => `${typeof value}:${value}`))];
  const position = (value: string | number) => dates ? Date.parse(String(value)) : numeric ? Number(value)
    : categories.indexOf(`${typeof value}:${value}`);
  const positions = labels.map(position);
  let start = Math.min(...positions);
  let end = Math.max(...positions);
  if (dates && data.viewport) { start = Date.parse(data.viewport.start); end = Date.parse(data.viewport.end); }
  const x = (value: string | number) => start === end ? 500 : 20 + (position(value) - start) / (end - start) * 960;
  const groups = new Map<string, Array<{ entry: ChartShareData["series"][number]; index: number }>>();
  data.series.forEach((entry, index) => {
    const unit = entry.unit || "Unit unavailable";
    groups.set(unit, [...(groups.get(unit) ?? []), { entry, index }]);
  });
  const scopedPoints = (entry: ChartShareData["series"][number]) => {
    const ordered = [...entry.points].sort((a, b) => position(a.x) - position(b.x));
    const anchor = entry.style === "step" && !ordered.some((point) => position(point.x) === start)
      ? ordered.findLast((point) => position(point.x) < start) : undefined;
    return ordered.filter((point) => point === anchor || (position(point.x) >= start && position(point.x) <= end));
  };
  const panels: SharedChartPanel[] = [...groups].map(([unit, entries]) => {
    const values = entries.flatMap(({ entry }) => scopedPoints(entry)
      .flatMap((point) => point.y === null ? [] : [point.y]));
    let min = values.length ? Math.min(...values) : 0;
    let max = values.length ? Math.max(...values) : 1;
    if (min === max) { const pad = Math.abs(min) * 0.05 || 1; min -= pad; max += pad; }
    return { unit, hasValues: values.length > 0, min, max, series: entries.map(({ entry, index }) => {
      const segments: SharedChartMark[][] = [];
      let current: SharedChartMark[] = [];
      for (const point of scopedPoints(entry)) {
        if (point.y === null) {
          if (current.length) segments.push(current);
          current = [];
          continue;
        }
        current.push({ x: Math.max(20, x(point.x)), y: 300 - (point.y - min) / (max - min) * 280,
          label: `${point.x}: ${point.y} ${entry.unit ?? "(unit unavailable)"}` });
      }
      if (entry.style === "step" && current.length && current.at(-1)!.x < 980 && end > start) {
        const last = current.at(-1)!;
        current.push({ ...last, x: 980, label: `Held level from ${last.label}` });
      }
      if (current.length) segments.push(current);
      return { name: entry.name, index, style: entry.style ?? "line", segments };
    }) };
  });
  const dateLabel = (time: number) => new Date(time).toISOString().replace("T", " ").slice(0, end - start <= 2 * 86400000 ? 16 : 10);
  return { panels, startLabel: dates ? dateLabel(start) : String(numeric ? start : labels.find((value) => position(value) === start)),
    endLabel: dates ? dateLabel(end) : String(numeric ? end : labels.find((value) => position(value) === end)),
    axisLabel: dates ? "Time (UTC)" : numeric ? "X value" : "Category" };
}

/** Expand step-after observations without inventing intermediate values. */
export function sharedChartLinePoints(segment: SharedChartMark[], style: "line" | "step" | "points"): string {
  return segment.flatMap((point, index) => style === "step" && index > 0
    ? [`${point.x},${segment[index - 1]!.y}`, `${point.x},${point.y}`]
    : [`${point.x},${point.y}`]).join(" ");
}
