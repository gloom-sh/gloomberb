/** @jsxImportSource react */
import type { CSSProperties } from "react";
import type { DialogActionsProps, DialogHintsProps } from "../../../components/ui/dialog-actions";
import { t } from "../../../i18n";
import { blendHex, type ThemeColors } from "../../../theme/colors";
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

/** The fill a dialog sits on (`.gloom-dialog`), for keycaps on a borderless surface. */
export function dialogSurface(colors: ThemeColors): string {
  return blendHex(colors.panel, colors.bg, 0.12);
}

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * A key as a small keycap: a hairline outline and a faint fill mixed from the
 * text colour it sits with, so it reads on a primary, danger or plain button
 * and in every theme without colours of its own.
 */
export function WebKeycap({ keyName, fg, surface, style }: { keyName: string; fg: string; surface: string; style?: CSSProperties }) {
  const base = HEX.test(surface) ? surface : "#000000";
  const ink = HEX.test(fg) ? fg : "#ffffff";
  return (
    <kbd
      className="gloom-keycap"
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        boxSizing: "border-box",
        minWidth: "1.55em",
        height: "1.36em",
        padding: "0 0.38em",
        borderRadius: 3,
        font: "inherit",
        fontSize: "0.84em",
        fontWeight: 500,
        lineHeight: 1,
        letterSpacing: 0,
        color: blendHex(ink, base, 0.28),
        backgroundColor: blendHex(ink, base, 0.9),
        boxShadow: `inset 0 0 0 1px ${blendHex(ink, base, 0.72)}`,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {keycapText(keyName)}
    </kbd>
  );
}

/** Keycap and word pairs, then a quiet note: what a dialog says once its buttons carry their keys. */
export function WebKeyHints({ keys = [], note, style }: DialogHintsProps & { style?: CSSProperties }) {
  const colors = useThemeColors();
  if (keys.length === 0 && !note) return null;
  const surface = dialogSurface(colors);
  return (
    <div
      data-gloom-role="dialog-hints"
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        columnGap: 12,
        rowGap: 4,
        minWidth: 0,
        fontSize: 11,
        lineHeight: "16px",
        color: colors.textMuted,
        ...style,
      }}
    >
      {keys.map((hint) => (
        <span
          key={`${hint.key}:${hint.label}`}
          className="gloom-key-hint"
          style={{ display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}
        >
          <WebKeycap keyName={hint.key} fg={colors.textDim} surface={surface} />
          <span>{t(hint.label)}</span>
        </span>
      ))}
      {note ? <span style={{ fontVariantNumeric: "tabular-nums" }}>{t(note)}</span> : null}
    </div>
  );
}

/** Hints for a dialog with no buttons to carry them, centred under its content. */
export function WebDialogHints({ keys, note }: DialogHintsProps) {
  return <WebKeyHints keys={keys} note={note} style={{ justifyContent: "center" }} />;
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
        columnGap: 16,
        rowGap: 8,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: wrap ? "wrap" : "nowrap", minWidth: 0 }}>
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
