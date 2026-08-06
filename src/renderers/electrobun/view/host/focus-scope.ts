/**
 * The browser gives up a field's focus when you press somewhere else. Panes,
 * charts and rows all consume their own mousedown, which is exactly what
 * suppresses that, so a field can hold the keyboard long after it looks done.
 *
 * One rule restores the default: a press outside the widget that owns the focus
 * releases it. Widgets whose own chrome must not take focus from their field,
 * such as a suggestion list under an input, mark it with the scope attribute.
 *
 * A dialog is exempt. It owns the pointer while it is open, and releasing a
 * field underneath it re-renders whatever hosts the dialog, which costs the
 * dialog the focus it just took.
 */
const FOCUS_SCOPE_ATTRIBUTE = "data-gloom-focus-scope";
const DIALOG_CLASS_SELECTOR = ".gloom-dialog";

interface FocusableLike {
  tagName?: string;
  isContentEditable?: boolean;
  blur?: () => void;
  focus?: () => void;
  closest?: (selector: string) => { contains?: (node: unknown) => boolean } | null;
  contains?: (node: unknown) => boolean;
}

function asFocusable(node: unknown): FocusableLike | null {
  return node && typeof node === "object" ? node as FocusableLike : null;
}

export function isEditableTarget(node: unknown): boolean {
  const element = asFocusable(node);
  if (!element) return false;
  if (element.isContentEditable === true) return true;
  const tag = element.tagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA";
}

export function shouldReleaseFocus(active: unknown, target: unknown): boolean {
  if (!isEditableTarget(active) || !target || active === target) return false;
  if (asFocusable(target)?.closest?.(DIALOG_CLASS_SELECTOR)) return false;
  const element = asFocusable(active)!;
  const scope = element.closest?.(`[${FOCUS_SCOPE_ATTRIBUTE}]`) ?? element;
  return !scope?.contains?.(target);
}

export function installFocusScopeRelease(): () => void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) return () => {};
  const handleMouseDown = (event: MouseEvent) => {
    const active = doc.activeElement;
    if (!shouldReleaseFocus(active, event.target)) return;
    asFocusable(active)?.blur?.();
  };
  doc.addEventListener("mousedown", handleMouseDown, true);
  return () => doc.removeEventListener("mousedown", handleMouseDown, true);
}
