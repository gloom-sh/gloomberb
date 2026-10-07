import { useLayoutEffect, useRef, useState } from "react";

/** Fit partially covered cells into their remaining area, retaining text ellipses. */
export function useFrozenColumnInsets(enabled: boolean, scrollLeft: number, viewportWidth: number, columns: unknown, gap: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [insets, setInsets] = useState<number[]>([]);
  useLayoutEffect(() => {
    const cells = ref.current?.children;
    if (!enabled || !cells?.length) {
      setInsets((current) => current.length ? [] : current);
      return;
    }
    const first = cells[0]!.getBoundingClientRect();
    const next = Array.from(cells).map((cell, index) => {
      if (index === 0) return 0;
      const rect = cell.getBoundingClientRect();
      return Math.min(rect.width, Math.max(0, first.right + gap - rect.left));
    });
    setInsets((current) => current.length === next.length && current.every((value, index) => value === next[index]) ? current : next);
  }, [columns, enabled, gap, scrollLeft, viewportWidth]);
  return { ref, insets };
}
