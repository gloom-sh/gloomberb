import { useCallback, useEffect, useRef, useState } from "react";

const SCROLLBAR_ACTIVITY_TIMEOUT_MS = 700;

export function useScrollbarActivity() {
  const [active, setActive] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markScrollbarActive = useCallback(() => {
    setActive(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      setActive(false);
    }, SCROLLBAR_ACTIVITY_TIMEOUT_MS);
  }, []);

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  return [active, markScrollbarActive] as const;
}
