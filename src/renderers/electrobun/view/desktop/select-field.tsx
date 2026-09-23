/** @jsxImportSource react */
import { useCallback, useImperativeHandle, useRef, useState, type CSSProperties } from "react";
import { useThemeColors } from "../../../../theme/theme-context";
import { blendHex } from "../../../../theme/colors";
import { WEB_CELL_HEIGHT } from "../../../../theme/font-scale";
import { Box } from "../../../../ui";
import { MenuPopover } from "../../../../components/ui/menu";
import type { SelectFieldHandle, SelectFieldProps } from "../../../../components/ui/select-field";
import { WebIcon } from "./icons";

const UNSET_VALUE = "\u0000unset";

function Chevron() {
  return (
    <span style={{ display: "inline-flex", flex: "none", opacity: 0.7 }}>
      <WebIcon name="chevron-down" size={9} />
    </span>
  );
}

/** Desktop host for the kit SelectField: a trigger that opens the kit Menu. */
export function WebSelectField({
  label,
  value,
  options,
  width,
  height,
  variant = "field",
  includeUnsetOption = false,
  disabled = false,
  selectRef,
  controlRef,
  onFocus,
  onChange,
}: SelectFieldProps) {
  const colors = useThemeColors();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const inline = variant === "inline";
  const current = options.find((option) => option.value === value);
  const showUnset = includeUnsetOption && !current;

  const openMenu = useCallback(() => {
    if (disabled) return;
    onFocus?.();
    setOpen(true);
  }, [disabled, onFocus]);
  const handle = useRef<SelectFieldHandle>({ open: () => {}, focus: () => {} });
  handle.current.open = openMenu;
  handle.current.focus = () => buttonRef.current?.focus();
  useImperativeHandle(controlRef, () => handle.current, []);
  const setSelectRef = useRef(selectRef);
  setSelectRef.current = selectRef;

  const resolvedWidth = width ?? (inline ? "auto" : 184);
  const resolvedHeight = height ?? (inline ? WEB_CELL_HEIGHT : 28);
  const style: CSSProperties = {
    width: resolvedWidth,
    height: resolvedHeight,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
    color: disabled ? colors.textMuted : colors.text,
    backgroundColor: inline ? "transparent" : blendHex(colors.panel, colors.textBright, 0.06),
    border: inline ? "none" : `1px solid ${open ? colors.borderFocused : colors.border}`,
    borderRadius: inline ? 0 : 6,
    padding: inline ? 0 : "0 8px",
    boxShadow: inline ? "none" : `inset 0 1px 0 ${blendHex(colors.bg, colors.textBright, 0.05)}`,
    cursor: disabled ? "default" : "pointer",
    font: "inherit",
    textAlign: "left",
    outline: "none",
    boxSizing: "border-box",
  };

  const trigger = (
    <button
      ref={(element) => {
        buttonRef.current = element;
        setSelectRef.current?.(element ? handle.current : null);
      }}
      type="button"
      aria-label={label}
      aria-haspopup="listbox"
      aria-expanded={open}
      disabled={disabled}
      data-gloom-interactive="true"
      style={style}
      onFocus={onFocus}
      onMouseDown={(event) => { event.stopPropagation(); }}
      onClick={(event) => {
        event.stopPropagation();
        if (open) setOpen(false);
        else openMenu();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " " && event.key !== "ArrowDown") return;
        event.preventDefault();
        event.stopPropagation();
        openMenu();
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {showUnset ? "Unset" : current?.label ?? value}
      </span>
      <Chevron />
    </button>
  );

  return (
    <Box
      height={`${resolvedHeight}px`}
      flexDirection="row"
      alignItems="center"
      onMouseDown={(event: any) => { event.stopPropagation?.(); }}
      onMouseUp={(event: any) => { event.stopPropagation?.(); }}
    >
      <MenuPopover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) queueMicrotask(() => buttonRef.current?.focus({ preventScroll: true }));
        }}
        trigger={trigger}
        label={label}
        selection="single"
        minWidth={typeof resolvedWidth === "number" ? Math.max(160, resolvedWidth) : 170}
        items={[
          ...(showUnset ? [{ id: UNSET_VALUE, label: "Unset", selected: true, disabled: true }] : []),
          ...options.map((option) => ({
            id: option.value,
            label: option.label,
            description: option.description,
            disabled: option.disabled,
            selected: option.value === value,
          })),
        ]}
        onSelect={(id) => {
          if (id !== UNSET_VALUE && id !== value) onChange(id);
        }}
      />
    </Box>
  );
}
