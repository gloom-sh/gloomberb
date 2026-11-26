/**
 * Translation for plugin UI (`gloomberb/i18n`).
 *
 * A plugin pane sits next to built-in ones, so its labels have to follow the
 * language the user picked or the pane reads half-translated. `t` looks a
 * string up in the app's own tables and falls back to the English source, and
 * `tPlugin` reads the plugin's own registered keys. `useAppLanguage` returns
 * the current language and re-renders on changes to its translations.
 *
 * It is a shared host module: the tables and the current language live in host
 * state, and a bundled copy would answer in English forever.
 *
 * Compatibility commitment: see the note in `./utils.ts`.
 */

export { registerTranslations, t, tc, tf, tPlugin } from "../i18n";
export type { AppLanguage } from "../i18n";
export { useAppLanguage } from "../i18n/react";
