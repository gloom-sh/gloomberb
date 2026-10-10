import type { MetricTreemapItem } from "./layout";

/**
 * A heat map tile says as much as its size allows and no more: a big tile its
 * ticker over the move, a small one the ticker, a tiny one only its colour.
 */
export type HeatTileLabelTier = "full" | "ticker" | "none";

export interface HeatTileLabel {
  tier: HeatTileLabelTier;
  /** Font sizes in px, for the desktop and the web. */
  tickerPx: number;
  valuePx: number;
}

/** Advance of one monospace glyph, in em. */
const MONO_CHAR_EM = 0.62;
const TILE_PAD_X_PX = 3;
const TILE_PAD_Y_PX = 2;
const MAX_TICKER_PX = 26;
const MIN_TICKER_PX = 9;
/** Below this the move under the ticker is too small to read at a glance. */
const MIN_FULL_TICKER_PX = 11;
const MIN_VALUE_PX = 9;
const VALUE_SCALE = 0.7;
const LINE_HEIGHT = 1.12;
/** Text grows with the tile's area, not just its width, so a long thin tile stays calm. */
const AREA_FONT_DIVISOR = 4.4;

const NO_LABEL: HeatTileLabel = { tier: "none", tickerPx: 0, valuePx: 0 };

export function heatTileLabelPx(width: number, height: number, ticker: string, value: string | null): HeatTileLabel {
  const innerWidth = width - TILE_PAD_X_PX * 2;
  const innerHeight = height - TILE_PAD_Y_PX * 2;
  if (innerWidth <= 0 || innerHeight <= 0 || ticker.length === 0) return NO_LABEL;
  const byWidth = innerWidth / (ticker.length * MONO_CHAR_EM);
  // Area caps big tiles only; a small one may still use the smallest readable size.
  const byArea = Math.max(MIN_FULL_TICKER_PX, Math.sqrt(width * height) / AREA_FONT_DIVISOR);
  const cap = Math.min(MAX_TICKER_PX, byWidth, byArea);

  if (value) {
    const valueByWidth = innerWidth / (value.length * MONO_CHAR_EM * VALUE_SCALE);
    const byHeight = innerHeight / (LINE_HEIGHT * (1 + VALUE_SCALE));
    const tickerPx = Math.min(cap, valueByWidth, byHeight);
    const valuePx = Math.max(MIN_VALUE_PX, tickerPx * VALUE_SCALE);
    if (
      tickerPx >= MIN_FULL_TICKER_PX
      && value.length * MONO_CHAR_EM * valuePx <= innerWidth
      && (tickerPx + valuePx) * LINE_HEIGHT <= innerHeight
    ) {
      return { tier: "full", tickerPx, valuePx };
    }
  }

  const tickerPx = Math.min(cap, innerHeight / LINE_HEIGHT);
  if (tickerPx >= MIN_TICKER_PX) return { tier: "ticker", tickerPx, valuePx: 0 };
  return NO_LABEL;
}

/**
 * The move with its qualifier (an after-hours move's AH) where that still fits
 * at the size the move alone was given, else the move alone. The qualifier
 * never shrinks the text or drops the move.
 */
export function heatTileValueWithSuffix(
  value: string | null,
  suffix: string | null | undefined,
  room: { width: number; valuePx?: number },
): string | null {
  if (!value || !suffix) return value;
  const withSuffix = `${value} ${suffix}`;
  const width = room.valuePx == null
    ? withSuffix.length
    : withSuffix.length * MONO_CHAR_EM * room.valuePx + TILE_PAD_X_PX * 2;
  return width <= room.width ? withSuffix : value;
}

/** The same tiers on a cell grid: whole words or nothing, never a clipped ticker. */
export function heatTileLabelCells(width: number, height: number, ticker: string, value: string | null): HeatTileLabelTier {
  if (width < ticker.length || height < 1 || ticker.length === 0) return "none";
  if (value && height >= 2 && width >= value.length) return "full";
  return "ticker";
}

/** "+2.7%": one decimal on the tile; the footer and the tooltip carry two. */
export function formatHeatTileMove(changePercent: number | null | undefined): string | null {
  if (changePercent == null || !Number.isFinite(changePercent)) return null;
  const fixed = Math.abs(changePercent).toFixed(1);
  if (!/[1-9]/.test(fixed)) return `${fixed}%`;
  return `${changePercent > 0 ? "+" : "-"}${fixed}%`;
}

/**
 * Keeps the previous layout input while no weight moved by more than
 * `tolerance` (relative) and the names and groups are the same, so a stream
 * of ticks does not relayout the board. A real change returns `next`.
 */
export function settleTreemapLayoutItems<T>(
  previous: readonly MetricTreemapItem<T>[] | null,
  next: readonly MetricTreemapItem<T>[],
  tolerance: number,
): readonly MetricTreemapItem<T>[] {
  if (!previous || previous.length !== next.length) return next;
  for (let index = 0; index < next.length; index += 1) {
    const before = previous[index]!;
    const after = next[index]!;
    if (before.id !== after.id || before.group !== after.group || before.subgroup !== after.subgroup) return next;
    const left = before.weight ?? 0;
    const right = after.weight ?? 0;
    if (left === right) continue;
    if (!(left > 0) || Math.abs(right - left) / left > tolerance) return next;
  }
  return previous;
}

export interface HeatPulseOptions {
  /** A tile pulses when its move has travelled this many percentage points since its last pulse. */
  threshold: number;
  /** And not again before this long. */
  minIntervalMs: number;
  /** Across the whole board, the largest changes first, so a busy tape or a snapshot refresh never flashes. */
  maxPerSecond: number;
}

const HEAT_PULSE_OPTIONS: HeatPulseOptions = {
  threshold: 0.2,
  minIntervalMs: 4_000,
  maxPerSecond: 6,
};

interface PulseState {
  base: number;
  at: number;
  count: number;
}

/**
 * Decides which tiles pulse as their moves change. `update` returns each
 * tile's pulse count: a tile whose count went up pulses once (the desktop
 * alternates two keyframe names on parity, which restarts the animation). The
 * first value a tile shows is its baseline and never pulses.
 */
export class HeatPulseTracker {
  private readonly states = new Map<string, PulseState>();
  private readonly counts = new Map<string, number>();
  private budget: number;
  private budgetAt: number | null = null;

  constructor(private readonly options: HeatPulseOptions = HEAT_PULSE_OPTIONS) {
    this.budget = options.maxPerSecond;
  }

  update(values: Iterable<readonly [string, number | null]>, now: number): ReadonlyMap<string, number> {
    if (this.budgetAt != null) {
      this.budget = Math.min(this.options.maxPerSecond, this.budget + (now - this.budgetAt) / 1000 * this.options.maxPerSecond);
    }
    this.budgetAt = now;
    const candidates: Array<{ id: string; delta: number; value: number }> = [];
    const seen = new Set<string>();
    for (const [id, value] of values) {
      seen.add(id);
      if (value == null || !Number.isFinite(value)) continue;
      const state = this.states.get(id);
      if (!state) {
        this.states.set(id, { base: value, at: now - this.options.minIntervalMs, count: 0 });
        continue;
      }
      const delta = Math.abs(value - state.base);
      if (delta >= this.options.threshold && now - state.at >= this.options.minIntervalMs) {
        candidates.push({ id, delta, value });
      }
    }
    for (const id of this.states.keys()) {
      if (!seen.has(id)) {
        this.states.delete(id);
        this.counts.delete(id);
      }
    }
    candidates.sort((left, right) => right.delta - left.delta);
    const allowed = Math.floor(this.budget);
    for (const candidate of candidates.slice(0, allowed)) {
      const state = this.states.get(candidate.id)!;
      state.base = candidate.value;
      state.at = now;
      state.count += 1;
      this.counts.set(candidate.id, state.count);
    }
    this.budget -= Math.min(allowed, candidates.length);
    return this.counts;
  }
}

const GLIDE_MS = 500;
const FADE_MS = 450;
const PULSE_MS = 700;

export interface HeatTileMotion {
  /** On the tile, after a relayout: slide from where it was (set `--heat-glide-x/y`). */
  glideAnimation?: string;
  /** On an overlay in the previous colour, fading out over the new one. */
  fadeAnimation?: string;
  /** On a light overlay that brightens the tile once. */
  pulseAnimation?: string;
}

/**
 * How a desktop tile moves. Every animation is a transform or an opacity, so
 * the compositor runs it without a main-thread frame: a relayout slides each
 * tile from its old place (its new size applies at once), a colour change
 * fades the old colour out over the new one, and a jump in the move flashes
 * once. `glideCount` alternates two keyframe names, which restarts the slide.
 * Reduced motion keeps every change instant.
 */
export function heatTileMotion({ reducedMotion, glide, glideCount, pulseCount }: {
  reducedMotion: boolean;
  glide: boolean;
  glideCount: number;
  pulseCount: number;
}): HeatTileMotion {
  if (reducedMotion) return {};
  return {
    ...(glide && glideCount > 0
      ? { glideAnimation: `gloom-heat-glide-${glideCount % 2 === 0 ? "b" : "a"} ${GLIDE_MS}ms ease` }
      : {}),
    fadeAnimation: `gloom-heat-fade ${FADE_MS}ms ease forwards`,
    ...(pulseCount > 0 ? { pulseAnimation: `gloom-heat-pulse ${PULSE_MS}ms ease-out forwards` } : {}),
  };
}
