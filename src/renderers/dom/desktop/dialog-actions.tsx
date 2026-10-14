/** @jsxImportSource react */
import type { CSSProperties } from "react";
import type { DialogActionsProps, DialogHintsProps } from "../../../components/ui/dialog-actions";
import { t } from "../../../i18n";
import { useThemeColors } from "../../../theme/theme-context";

/** Keys a keycap draws as the symbol printed on the key; the rest keep their name. */
const KEY_SYMBOLS: Record<string, string> = {
  enter: "↵",
  return: "↵",
  shift: "⇧",
  left: "←",
  right: "→",
  up: "↑",
  down: "↓",
  escape: "Esc",
};

/** `aria-keyshortcuts` names, from the UI Events key values. */
const ARIA_KEYS: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  ctrl: "Control",
  cmd: "Meta",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};

/** "Shift+Enter" reads ⇧↵ and "Enter" ↵; "Ctrl+G", "Esc" and "y" stay as they are. */
function keycapText(key: string): string {
  return key
    .split("+")
    .map((part) => KEY_SYMBOLS[part.trim().toLowerCase()] ?? part.trim())
    .join("+")
    .replaceAll("⇧+", "⇧");
}

/** The `aria-keyshortcuts` value for one key chord, such as "Shift+Enter" or "Escape". */
export function ariaKeyShortcut(key: string | undefined): string | undefined {
  if (!key) return undefined;
  return key.split("+").map((part) => ARIA_KEYS[part.trim().toLowerCase()] ?? part.trim()).join("+");
}

/**
 * A key as a small keycap. Its look is `.gloom-keycap` in styles.css: a
 * hairline outline and a faint fill mixed from the text colour it sits with,
 * so it reads on a primary, danger or plain button and in every theme. `fg`
 * sets that colour where the keycap is not inside the text it belongs to.
 */
export function WebKeycap({ keyName, fg, style }: { keyName: string; fg?: string; style?: CSSProperties }) {
  return (
    <kbd className="gloom-keycap" aria-hidden="true" style={{ ...(fg ? { color: fg } : {}), ...style }}>
      {keycapText(keyName)}
    </kbd>
  );
}

/** Keycap and word pairs, then a quiet note: what a dialog says once its buttons carry their keys. */
export function WebKeyHints({ keys = [], note, style }: DialogHintsProps & { style?: CSSProperties }) {
  const colors = useThemeColors();
  if (keys.length === 0 && !note) return null;
  return (
    <div
      data-gloom-role="dialog-hints"
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        columnGap: "var(--gloom-space-md)",
        rowGap: "var(--gloom-space-xs)",
        minWidth: 0,
        lineHeight: "16px",
        color: colors.textMuted,
        ...style,
      }}
    >
      {keys.map((hint) => (
        <span
          key={`${hint.key}:${hint.label}`}
          className="gloom-key-hint"
          style={{ display: "inline-flex", alignItems: "center", gap: "var(--gloom-space-xs)", whiteSpace: "nowrap" }}
        >
          <WebKeycap keyName={hint.key} fg={colors.textDim} />
          <span>{t(hint.label)}</span>
        </span>
      ))}
      {note ? <span style={{ fontVariantNumeric: "tabular-nums" }}>{t(note)}</span> : null}
    </div>
  );
}

/**
 * The buttons, then the hints across from them on the same row. A row too
 * narrow for both moves the hints under the buttons.
 */
export function WebDialogActions({ children, alignEnd = false, wrap = false, hints }: DialogActionsProps) {
  const hasHints = !!hints && ((hints.keys?.length ?? 0) > 0 || !!hints.note);
  return (
    <div
      data-gloom-role="dialog-actions"
      style={{
        display: "flex",
        flexDirection: alignEnd ? "row-reverse" : "row",
        alignItems: "center",
        flexWrap: "wrap",
        columnGap: "var(--gloom-space-lg)",
        rowGap: "var(--gloom-space-sm)",
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--gloom-space-sm)", flexWrap: wrap ? "wrap" : "nowrap", minWidth: 0 }}>
        {children}
      </div>
      {hasHints ? (
        <WebKeyHints
          keys={hints.keys}
          note={hints.note}
          style={alignEnd ? { marginRight: "auto" } : { marginLeft: "auto", justifyContent: "flex-end" }}
        />
      ) : null}
    </div>
  );
}
