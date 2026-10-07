import { useEffect, useRef, type RefObject } from "react";
import { observeScrollBoxContentSize, observeScrollBoxViewportSize } from "../renderers/opentui/scrollbox-layout";
import { useUiCapabilities, type ScrollBoxRenderable } from "../ui";

/** Native scroll ranges become available after computed layout, including the first frame. */
export function useScrollBoxLayout(scrollRef: RefObject<ScrollBoxRenderable | null>, onLayout: () => void) {
  const callback = useRef(onLayout);
  callback.current = onLayout;
  const desktop = !!useUiCapabilities().nativePaneChrome;
  useEffect(() => {
    if (desktop) return;
    const notify = () => callback.current();
    const stopContent = observeScrollBoxContentSize(scrollRef.current, notify);
    const stopViewport = observeScrollBoxViewportSize(scrollRef.current, notify);
    return () => { stopContent?.(); stopViewport?.(); };
  }, [desktop, scrollRef]);
}
