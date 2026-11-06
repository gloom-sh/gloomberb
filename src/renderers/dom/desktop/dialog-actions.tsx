/** @jsxImportSource react */
import type { CSSProperties } from "react";
import type { DialogActionsProps, DialogHintsProps } from "../../../components/ui/dialog-actions";
import type { KeyHintsProps } from "../../../components/ui/key-hints";
import { t } from "../../../i18n";
import { useThemeColors } from "../../../theme/theme-context";
import { formatShortcutForHost, keyNotationFor } from "../../../app/keybindings/labels";
import { ariaKeyShortcut } from "../../../app/keybindings/chord";

export { ariaKeyShortcut };

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

/**
 * On a Mac, the key in Apple's notation (formatShortcutForHost): "Shift+Enter"
 * is ⇧↩ and "Ctrl+G" ⌃G. Elsewhere "Shift+Enter" reads ⇧↵ and "Enter" ↵, and
 * "Ctrl+G", "Esc" and "y" stay as they are.
 */
function keycapText(key: string): string {
  if (keyNotationFor("platform") === "mac") return formatShortcutForHost(key, "platform");
  return key
    .split("+")
    .map((part) => KEY_SYMBOLS[part.trim().toLowerCase()] ?? part.trim())
    .join("+")
    .replaceAll("⇧+", "⇧");
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
export function WebKeyHints({ keys = [], note, style, keyColor }: DialogHintsProps & { style?: CSSProperties; keyColor?: string }) {
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
          <WebKeycap keyName={hint.key} fg={keyColor ?? colors.textDim} />
          {hint.label ? <span>{t(hint.label)}</span> : null}
        </span>
      ))}
      {note ? <span style={{ fontVariantNumeric: "tabular-nums" }}>{t(note)}</span> : null}
    </div>
  );
}

/**
 * The kit's KeyHints: the same keycaps and words, kept on one line. `color`
 * sets the keys and the words for hints on a surface of their own.
 */
export function WebKeyHintsLine({ keys, color }: KeyHintsProps) {
  return <WebKeyHints keys={keys} keyColor={color} style={{ flexWrap: "nowrap", ...(color ? { color } : {}) }} />;
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
