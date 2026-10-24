import type { HeadlessPaneArgumentKind } from "../types/headless";
import type { PaneDef, PaneTemplateDef } from "../types/plugin";

type ShortcutArgKind = NonNullable<NonNullable<PaneTemplateDef["shortcut"]>["argKind"]>;

const SHORTCUT_ARG_KINDS: Record<Exclude<HeadlessPaneArgumentKind, "none">, ShortcutArgKind> = {
  ticker: "ticker",
  tickers: "ticker-list",
  "symbol-list": "ticker-list",
  "free-text": "text",
};

/**
 * The template as the command bar reads it. A shortcut that declares no
 * argument takes the one the function declares for `fn` and `catalog`
 * (`headless.argument`), so `PF Book` opens Book in the bar as it does in
 * `gloom fn PF Book`. A shortcut that declares its own argument keeps it.
 */
export function withFunctionShortcutArgument(
  template: PaneTemplateDef,
  pane?: Pick<PaneDef, "headless">,
): PaneTemplateDef {
  const shortcut = template.shortcut;
  if (!shortcut || shortcut.argKind || shortcut.argPlaceholder) return template;
  const argument = (template.headless ?? pane?.headless)?.argument;
  if (!argument || argument.kind === "none") return template;
  const argKind = SHORTCUT_ARG_KINDS[argument.kind];
  const argPlaceholder = argument.placeholder
    ?? (argKind === "ticker" ? "ticker" : argKind === "ticker-list" ? "tickers" : undefined);
  return {
    ...template,
    shortcut: {
      ...shortcut,
      argKind,
      ...(argPlaceholder ? { argPlaceholder } : {}),
      ...(argument.optional ? { argOptional: true } : {}),
    },
  };
}
