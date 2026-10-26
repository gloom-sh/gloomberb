import { useCallback, useRef, useState } from "react";
import type { CompositeAxisSide } from "./types";
import { NO_VALUE_SCALES, valueScaleSlot, type CompositeValueRange, type CompositeValueScales } from "./value-scale";

/**
 * The chart's manual value scales: set by a drag or the wheel on an axis, or
 * a drag on the plot of a panel already scaled by hand; cleared per panel or
 * all at once, and whenever `resetKey` changes (in the same render, so a new
 * view never draws in the old one's scale).
 */
export function useCompositeValueScales(resetKey: unknown) {
  const [state, setState] = useState<{ resetKey: unknown; scales: CompositeValueScales }>(() => ({ resetKey, scales: NO_VALUE_SCALES }));
  const resetKeyRef = useRef(resetKey);
  resetKeyRef.current = resetKey;
  const scales = Object.is(state.resetKey, resetKey) ? state.scales : NO_VALUE_SCALES;
  const update = useCallback((change: (scales: CompositeValueScales) => CompositeValueScales) => {
    setState((current) => {
      const key = resetKeyRef.current;
      const fresh = Object.is(current.resetKey, key);
      const base = fresh ? current.scales : NO_VALUE_SCALES;
      const next = change(base);
      return fresh && next === base ? current : { resetKey: key, scales: next };
    });
  }, []);
  const setValueScale = useCallback((panelId: string, side: CompositeAxisSide, key: string, range: CompositeValueRange) => {
    const slot = valueScaleSlot(panelId, side);
    update((current) => {
      const previous = current[slot];
      if (previous && previous.key === key && previous.min === range.min && previous.max === range.max) return current;
      return { ...current, [slot]: { key, min: range.min, max: range.max } };
    });
  }, [update]);
  const resetPanelValueScale = useCallback((panelId: string) => {
    update((current) => {
      const slots = (["left", "right"] as const).map((side) => valueScaleSlot(panelId, side)).filter((slot) => slot in current);
      if (slots.length === 0) return current;
      const next = { ...current };
      for (const slot of slots) delete next[slot];
      return Object.keys(next).length === 0 ? NO_VALUE_SCALES : next;
    });
  }, [update]);
  const resetValueScales = useCallback(() => update(() => NO_VALUE_SCALES), [update]);
  return { valueScales: scales, setValueScale, resetPanelValueScale, resetValueScales };
}
