import { type ComponentType, type Ref } from "react";
import { useUiHost } from "../../ui";

/** Opens the field's menu from a shortcut or a parent form. */
export interface SelectFieldHandle {
  open(): void;
  focus(): void;
}

interface SelectFieldOption {
  label: string;
  value: string;
  description?: string;
  disabled?: boolean;
}

export interface SelectFieldProps {
  label?: string;
  value: string;
  disabled?: boolean;
  options: SelectFieldOption[];
  width?: number | string;
  height?: number;
  /**
   * `field` is the form control used in dialogs. `inline` drops the box so a
   * dense row reads as text; both open the same Menu.
   */
  variant?: "field" | "inline";
  includeUnsetOption?: boolean;
  /**
   * Return focus to the trigger when the menu closes (inside a dialog). A list
   * that moves its own highlight, such as pane settings, turns it off so the
   * arrows keep moving the list.
   */
  restoreFocus?: boolean;
  selectRef?: (handle: SelectFieldHandle | null) => void;
  controlRef?: Ref<SelectFieldHandle>;
  onFocus?: () => void;
  onChange: (value: string) => void;
}

export function openSelectField(handle: SelectFieldHandle | null | undefined) {
  handle?.open();
}

/**
 * Desktop single-select field: a trigger that opens the kit Menu in the kit
 * Popover, so every dropdown in the app looks and behaves the same. The
 * desktop host draws it; the terminal uses SelectButton's choice dialog.
 */
export function SelectField(props: SelectFieldProps) {
  const HostSelectField = useUiHost().SelectField as ComponentType<SelectFieldProps> | undefined;
  return HostSelectField ? <HostSelectField {...props} /> : null;
}
