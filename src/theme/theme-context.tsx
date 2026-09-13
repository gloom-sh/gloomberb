import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  colors,
  getCurrentStyleId,
  getCurrentThemeId,
  getResolvedTheme,
  getResolvedThemeFor,
  syncTheme,
  type ThemeColors,
} from "./colors";
import type { GlyphSet } from "./glyphs";
import type { StyleSpec } from "./styles";
import type { ResolvedTheme, ThemeTokens } from "./tokens";

interface ThemeContextValue {
  themeId: string;
  styleId: string;
  colors: ThemeColors;
  resolved: ResolvedTheme;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({
  themeId,
  styleId,
  children,
}: {
  themeId: string;
  styleId?: string;
  children: ReactNode;
}) {
  syncTheme(themeId, styleId);
  const resolved = useMemo(() => getResolvedThemeFor(themeId, styleId), [styleId, themeId]);
  const value = useMemo(() => ({
    themeId,
    styleId: resolved.styleId,
    colors: resolved.palette,
    resolved,
  }), [resolved, themeId]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useThemeId(): string {
  return useContext(ThemeContext)?.themeId ?? getCurrentThemeId();
}

export function useThemeStyleId(): string {
  return useContext(ThemeContext)?.styleId ?? getCurrentStyleId();
}

export function useThemeColors(): ThemeColors {
  return useContext(ThemeContext)?.colors ?? colors;
}

export function useResolvedTheme(): ResolvedTheme {
  return useContext(ThemeContext)?.resolved ?? getResolvedTheme();
}

/** The semantic token tree for the active scheme and style. */
export function useThemeTokens(): ThemeTokens {
  return useResolvedTheme().tokens;
}

/** The structural half of the active theme: borders, header mode, density. */
export function useThemeStyle(): StyleSpec {
  return useResolvedTheme().style;
}

/** The glyph repertoire the active style allows. */
export function useGlyphs(): GlyphSet {
  return useResolvedTheme().glyphs;
}
