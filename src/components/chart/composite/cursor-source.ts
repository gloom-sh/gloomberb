import { useSyncExternalStore } from "react";
import { applyCompositeChartCursor, compositeLinkedCursorTime } from "./scene";
import type { CompositeChartScene } from "./types";

type Listener = () => void;

/** A value that changes without rendering what holds it: only its readers render. */
export interface ValueStore<T> {
  get(): T;
  set(value: T): void;
  subscribe(listener: Listener): () => void;
}

export function createValueStore<T>(initial: T): ValueStore<T> {
  let value = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The cursor charts in one tab share: the time another chart's crosshair is at. */
export interface SharedCursorTime {
  subscribe(listener: Listener): () => void;
  time(): number | null;
}

/**
 * The chart's scene with its crosshair applied, for the parts that draw the
 * crosshair: the legend's values, the value and time axes' cursor labels and
 * the plot's crosshair. A pointer move renders those alone; the chart, its
 * series and its axes stay as they are.
 */
export interface CompositeCursorSource {
  /** The scene with the cursor, the same object until the cursor moves to another bar. */
  scene(): CompositeChartScene;
  subscribe(listener: Listener): () => void;
}

export interface CompositeCursorSourceOptions {
  /** The scene the cursor is applied to, which has none of its own. */
  baseScene: CompositeChartScene;
  /** The chart's own cursor, in epoch ms, which the pointer and the keys move. Null when the owner holds it. */
  own: ValueStore<number | null> | null;
  /** The owner's cursor, in epoch ms: the one shown while the chart has none of its own. */
  fallback: number | null;
  /** Another chart's cursor, which shows in place of this one's while it is set. */
  link?: SharedCursorTime;
}

export function createCompositeCursorSource({
  baseScene,
  own,
  fallback,
  link,
}: CompositeCursorSourceOptions): CompositeCursorSource {
  let cachedKey: string | null = null;
  let cached = baseScene;
  const scene = () => {
    const sharedTime = link?.time() ?? null;
    let key: string;
    let next: () => CompositeChartScene;
    if (sharedTime !== null) {
      // A chart renders again when the bar the shared cursor lands on here
      // changes, not on every move: a daily chart under a 30-minute one's
      // cursor moves once a session.
      const bar = compositeLinkedCursorTime(baseScene, sharedTime);
      key = `linked:${bar}`;
      next = () => applyCompositeChartCursor(baseScene, bar === null ? null : new Date(bar), "linked");
    } else {
      const time = own?.get() ?? fallback;
      key = `own:${time}`;
      next = () => applyCompositeChartCursor(baseScene, time === null ? null : new Date(time));
    }
    if (key !== cachedKey) {
      cachedKey = key;
      cached = next();
    }
    return cached;
  };
  const subscribe = (listener: Listener) => {
    const stopOwn = own?.subscribe(listener);
    const stopLink = link?.subscribe(listener);
    return () => {
      stopOwn?.();
      stopLink?.();
    };
  };
  return { scene, subscribe };
}

/** The scene with the cursor, rendering again when the cursor moves to another bar. */
export function useCursorScene(source: CompositeCursorSource): CompositeChartScene {
  return useSyncExternalStore(source.subscribe, source.scene, source.scene);
}

/** A store's value, rendering again when it changes. */
export function useValueStore<T>(store: ValueStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
