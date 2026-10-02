import { createContext, useContext } from "react";

/**
 * The body color of the pane a component renders in. Charts draw on it, so a
 * plot reads as part of the pane instead of a darker box inside it. Null
 * outside a pane (dialogs, screenshots of a lone chart).
 */
export const PaneSurfaceContext = createContext<string | null>(null);

export function usePaneSurface(): string | null {
  return useContext(PaneSurfaceContext);
}

/**
 * A chart's background: an explicit color wins, except the theme's own
 * background, which callers pass only because it was the default. That one,
 * or none at all, becomes the pane surface when there is one.
 */
export function chartSurfaceBackground(
  requested: string | null | undefined,
  themeBackground: string,
  paneSurface: string | null,
): string {
  if (requested && requested.toLowerCase() !== themeBackground.toLowerCase()) return requested;
  return paneSurface ?? requested ?? themeBackground;
}
