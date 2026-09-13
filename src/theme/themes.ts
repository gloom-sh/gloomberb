/**
 * The colour schemes moved to `schemes.ts` when a theme became a scheme plus a
 * style. This module stays as the import path plugins and panes already use.
 */
export {
  DEFAULT_SCHEME,
  DEFAULT_THEME,
  getScheme,
  getSchemeIds,
  getTheme,
  getThemeIds,
  hasScheme,
  isDarkTheme,
  schemes,
  themes,
} from "./schemes";
export type { Theme } from "./schemes";
