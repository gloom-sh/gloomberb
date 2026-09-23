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

const POINTER_CONTROL_SELECTOR = "button, a[href], summary, [role='button'], [role='radio'], [role='option'], [role='tab'], [tabindex]";

export function installFocusScopeRelease(): () => void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) return () => {};
  const handleMouseDown = (event: MouseEvent) => {
    const active = doc.activeElement;
    if (!shouldReleaseFocus(active, event.target)) return;
    asFocusable(active)?.blur?.();
  };
  // Any control a pointer pressed (a chip, a segment, a list row) lets go of
  // the focus once its own click has run, unless it sits in a dialog or menu.
  // Seen in capture, since handlers often stop the click; released after it.
  const handleClick = (event: MouseEvent) => {
    const active = doc.activeElement;
    if (!active || active === doc.body || isEditableTarget(active)) return;
    const control = asFocusable(event.target)?.closest?.(POINTER_CONTROL_SELECTOR);
    if (control !== active) return;
    const detail = event.detail;
    queueMicrotask(() => {
      if (doc.activeElement === active) releasePointerFocus(active, detail);
    });
  };
  doc.addEventListener("mousedown", handleMouseDown, true);
  doc.addEventListener("click", handleClick, true);
  return () => {
    doc.removeEventListener("mousedown", handleMouseDown, true);
    doc.removeEventListener("click", handleClick, true);
  };
}

/**
 * Keyboard focus lives in the app, not the DOM: Tab moves between panes, and a
 * pane's rows and hints act on keys that reach the window. A button a pointer
 * pressed keeps the DOM focus in Chromium, and it then takes every later Enter
 * and Space for itself, so a control outside a dialog or menu lets go of the
 * focus as soon as its click has run. Inside a dialog Tab walks the controls,
 * and there a focused control is the point.
 */
export function releasePointerFocus(element: unknown, pointerDetail: number): void {
  if (pointerDetail <= 0) return;
  const node = asFocusable(element);
  if (!node || node.closest?.(`${DIALOG_CLASS_SELECTOR}, .gloom-popover`)) return;
  node.blur?.();
}

/** Whether a control sits in a dialog or popover, where it may keep focus. */
export function isInsideDialogSurface(element: unknown): boolean {
  return !!asFocusable(element)?.closest?.(`${DIALOG_CLASS_SELECTOR}, .gloom-popover`);
}
