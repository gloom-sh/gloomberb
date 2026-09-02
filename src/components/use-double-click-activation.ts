import { useCallback, useRef } from "react";

interface LastClickState {
  targetKey: string;
}

interface ClickEventLike {
  detail?: number;
}

export function useDoubleClickActivation<T>({
  onSelect,
  onActivate,
}: {
  onSelect?: (value: T) => void;
  onActivate?: (value: T) => void;
}) {
  const lastClickRef = useRef<LastClickState | null>(null);
  const onSelectRef = useRef(onSelect);
  const onActivateRef = useRef(onActivate);
  onSelectRef.current = onSelect;
  onActivateRef.current = onActivate;

  return useCallback((targetKey: string, value: T, event?: ClickEventLike) => {
    const lastClick = lastClickRef.current;

    onSelectRef.current?.(value);

    if ((typeof event?.detail === "number" && event.detail >= 2)
        || (lastClick && lastClick.targetKey === targetKey)) {
      lastClickRef.current = null;
      onActivateRef.current?.(value);
      return;
    }

    lastClickRef.current = {
      targetKey,
    };
  }, []);
}
