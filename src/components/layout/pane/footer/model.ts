import type { ContextMenuItem } from "../../../../types/context-menu";

export interface PaneFooterRegistration {
  order?: number;
  info?: PaneFooterSegment[];
  hints?: PaneHint[];
  /**
   * Extra entries for the pane menu (the "..." button, `.`), for actions that
   * have no footer key of their own: sort a table, change a filter, close a
   * tab. The menu already lists every hint, so do not repeat those here.
   */
  menu?: ContextMenuItem[];
  /**
   * Keys bound while the pane is focused but not drawn in the footer, for an
   * action that already shows its key where it sits (an empty state's button).
   */
  keys?: PaneHint[];
}

export interface PaneFooterSegment {
  id: string;
  parts: PaneFooterPart[];
  /** Desktop affordance; parts retain the terminal representation. */
  icon?: "warning";
  label?: string;
  title?: string;
  shortcut?: string;
  onPress?: () => void;
  disabled?: boolean;
}

export interface PaneFooterPressEvent {
  pixelX?: number;
  pixelY?: number;
  stopPropagation?: () => void;
  preventDefault?: () => void;
}

export interface PaneFooterPart {
  text: string;
  tone?: "label" | "value" | "muted" | "positive" | "negative" | "warning";
  color?: string;
  bold?: boolean;
}

export interface PaneHint {
  id: string;
  key: string;
  label: string;
  /**
   * The action's full name in the pane menu. Defaults to the hint read as one
   * word (`[a]dd` is "Add"); set it when the key is not the first letter.
   */
  title?: string;
  onPress?: (event?: PaneFooterPressEvent) => void;
  disabled?: boolean;
}

export interface CombinedPaneFooter {
  info: PaneFooterSegment[];
  hints: PaneHint[];
  menu: ContextMenuItem[];
  keys: PaneHint[];
}

export const EMPTY_FOOTER: CombinedPaneFooter = { info: [], hints: [], menu: [], keys: [] };

/** The name a hint goes by in the pane menu: `[a]dd` is "Add", `[r]efresh` is "Refresh". */
export function paneHintTitle(hint: Pick<PaneHint, "key" | "label" | "title">): string {
  if (hint.title) return hint.title;
  const label = hint.label.trim();
  const key = hint.key;
  const joined = key.length === 1 && /^[a-z]$/i.test(key) && /^[a-z]/.test(hint.label)
    && !label.toLowerCase().startsWith(key.toLowerCase())
    ? `${key}${label}`
    : label;
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

export function hasPaneFooterContent(footer?: CombinedPaneFooter | null): boolean {
  if (!footer) return false;
  return footer.info.length > 0 || footer.hints.some((hint) => !hint.disabled);
}

export function combinePaneFooterRegistrations(registrations: Map<string, PaneFooterRegistration>): CombinedPaneFooter {
  if (registrations.size === 0) return EMPTY_FOOTER;

  const ordered = Array.from(registrations.entries()).sort(([idA, a], [idB, b]) => {
    const orderDelta = (a.order ?? 0) - (b.order ?? 0);
    return orderDelta || idA.localeCompare(idB);
  });

  const info: PaneFooterSegment[] = [];
  const hints: PaneHint[] = [];
  const menu: ContextMenuItem[] = [];
  const keys: PaneHint[] = [];
  for (const [id, registration] of ordered) {
    if (registration.info) info.push(...registration.info);
    if (registration.hints) hints.push(...registration.hints);
    if (registration.keys) keys.push(...registration.keys);
    if (registration.menu?.length) {
      if (menu.length > 0) menu.push({ type: "divider", id: `${id}:divider` });
      menu.push(...registration.menu);
    }
  }

  if (info.length === 0 && hints.length === 0 && menu.length === 0 && keys.length === 0) return EMPTY_FOOTER;
  return { info, hints, menu, keys };
}

function sameFooterParts(left: PaneFooterPart[], right: PaneFooterPart[]): boolean {
  return left.length === right.length && left.every((part, index) => {
    const other = right[index];
    return !!other
      && part.text === other.text
      && part.tone === other.tone
      && part.color === other.color
      && part.bold === other.bold;
  });
}

function sameMenuItems(left: ContextMenuItem[], right: ContextMenuItem[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index]!;
    if (item.type === "divider" || other.type === "divider") return item.type === other.type;
    return item.id === other.id
      && item.label === other.label
      && item.checked === other.checked
      && item.enabled === other.enabled
      && item.hidden === other.hidden
      && item.accelerator === other.accelerator
      && !!item.submenu === !!other.submenu
      && (!item.submenu || sameMenuItems(item.submenu, other.submenu ?? []));
  });
}

export function samePaneFooterRegistration(
  left: PaneFooterRegistration | null,
  right: PaneFooterRegistration | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftInfo = left.info ?? [];
  const rightInfo = right.info ?? [];
  const leftHints = left.hints ?? [];
  const rightHints = right.hints ?? [];
  const leftKeys = left.keys ?? [];
  const rightKeys = right.keys ?? [];
  return (left.order ?? 0) === (right.order ?? 0)
    && sameMenuItems(left.menu ?? [], right.menu ?? [])
    && leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key.id === rightKeys[index]!.id && key.key === rightKeys[index]!.key && key.disabled === rightKeys[index]!.disabled)
    && leftInfo.length === rightInfo.length
    && leftHints.length === rightHints.length
    && leftInfo.every((segment, index) => {
      const other = rightInfo[index];
      return !!other
        && segment.id === other.id
        && segment.icon === other.icon
        && segment.label === other.label
        && segment.title === other.title
        && segment.shortcut === other.shortcut
        && !!segment.onPress === !!other.onPress
        && segment.disabled === other.disabled
        && sameFooterParts(segment.parts, other.parts);
    })
    && leftHints.every((hint, index) => {
      const other = rightHints[index];
      return !!other
        && hint.id === other.id
        && hint.key === other.key
        && hint.label === other.label
        && hint.title === other.title
        && !!hint.onPress === !!other.onPress
        && hint.disabled === other.disabled;
    });
}
