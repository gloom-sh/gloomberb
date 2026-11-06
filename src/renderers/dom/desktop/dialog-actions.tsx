/** @jsxImportSource react */
import { useRef, type CSSProperties } from "react";
import type { DialogActionsProps, DialogHintsProps } from "../../../components/ui/dialog-actions";
import type { KeyHintProps, KeyHintsProps } from "../../../components/ui/key-hints";
import { keycapText } from "../../../components/ui/key-hint-words";
import { t } from "../../../i18n";
import { useThemeColors } from "../../../theme/theme-context";
import { ariaKeyShortcut } from "../../../app/keybindings/chord";
import { cellMouseEvent } from "../host/mouse";

export { ariaKeyShortcut };

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

/**
 * The kit's KeyHint, the one key hint on the desktop and the web: the key in
 * a keycap, then the whole words. Its colours are styles.css's
 * `.gloom-hint`: the words muted, the keycap a step brighter, both
 * brighter under the pointer when the hint is pressable. `color` sets the
 * words' colour for a hint on a surface of its own (a field's placeholder);
 * the keycap stays a step above. A press is a mouse down and up on the hint,
 * as a footer hint has always taken it, and passes where it landed.
 */
export function WebKeyHint({ keyName, label, onPress, disabled = false, color, dataGloomRole, keyboardOnly = false }: KeyHintProps & {
  /** Only for a keyboard: a touch screen leaves it out (`.gloom-key-hint`), as it does a dialog's hints. */
  keyboardOnly?: boolean;
}) {
  const pressed = useRef(false);
  const interactive = !!onPress && !disabled;
  return (
    <span
      className={keyboardOnly ? "gloom-hint gloom-key-hint" : "gloom-hint"}
      data-gloom-role={dataGloomRole}
      data-interactive={interactive ? "true" : undefined}
      data-disabled={disabled ? "true" : undefined}
      aria-keyshortcuts={interactive ? ariaKeyShortcut(keyName) : undefined}
      style={color ? ({ "--gloom-key-hint-words": color } as CSSProperties) : undefined}
      onMouseDown={interactive ? (event) => {
        pressed.current = true;
        event.stopPropagation();
        event.preventDefault();
      } : undefined}
      onMouseUp={interactive ? (event) => {
        const started = pressed.current;
        pressed.current = false;
        if (started) onPress?.(cellMouseEvent(event.nativeEvent));
        else {
          event.stopPropagation();
          event.preventDefault();
        }
      } : undefined}
    >
      <WebKeycap keyName={keyName} />
      {label ? <span className="gloom-key-hint-words">{label}</span> : null}
    </span>
  );
}

/** KeyHints, then a quiet note: what a dialog says once its buttons carry their keys. */
export function WebKeyHints({ keys = [], note, style, color }: DialogHintsProps & { style?: CSSProperties; color?: string }) {
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
        color: color ?? colors.textMuted,
        ...style,
      }}
    >
      {keys.map((hint) => <WebKeyHint key={`${hint.key}:${hint.label}`} keyName={hint.key} label={t(hint.label)} color={color} keyboardOnly />)}
      {note ? <span style={{ fontVariantNumeric: "tabular-nums" }}>{t(note)}</span> : null}
    </div>
  );
}

/**
 * The kit's KeyHints: the same KeyHint each, kept on one line. `color` sets
 * the words for hints on a surface of their own.
 */
export function WebKeyHintsLine({ keys, color }: KeyHintsProps) {
  return <WebKeyHints keys={keys} color={color} style={{ flexWrap: "nowrap" }} />;
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
