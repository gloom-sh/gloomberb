import { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import {
  colors,
  getCurrentThemeId,
  getThemeColors,
  syncTheme,
  type ThemeColors,
} from "./colors";

interface ThemeContextValue {
  themeId: string;
  colors: ThemeColors;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ themeId, children }: { themeId: string; children: ReactNode }) {
  syncTheme(themeId);
  const themeColors = useMemo(() => getThemeColors(themeId), [themeId]);
  const value = useMemo(() => ({ themeId, colors: themeColors }), [themeColors, themeId]);
  const paintedTheme = useRef(themeId);
  useLayoutEffect(() => {
    if (paintedTheme.current === themeId) return;
    paintedTheme.current = themeId;
    // Hover transitions should not interpolate between two theme palettes.
    // Finish just color transitions after this commit's styles have landed,
    // before paint. Motion (including tab reorder and pane drag) is untouched.
    const documentLike = (globalThis as { document?: {
      getAnimations?: () => Array<{ transitionProperty?: string; finish(): void }>;
    } }).document;
    for (const transition of documentLike?.getAnimations?.() ?? []) {
      if (transition.transitionProperty && /color|fill|stroke|shadow/.test(transition.transitionProperty)) transition.finish();
    }
  }, [themeId]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useThemeId(): string {
  return useContext(ThemeContext)?.themeId ?? getCurrentThemeId();
}

export function useThemeColors(): ThemeColors {
  return useContext(ThemeContext)?.colors ?? colors;
}
