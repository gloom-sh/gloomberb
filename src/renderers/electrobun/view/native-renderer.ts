/// <reference lib="dom" />
import type { NativeRendererHost } from "../../../ui";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "./input-host";
import { hasWebCtrlModifier, normalizeWebKeyName, shouldConsumeWebAppKeyDown, shouldDispatchWebNativeKeyDown, webKeySequence } from "./key-event";

type Listener = (...args: unknown[]) => void;
type KeypressListener = (event: {
  name: string;
  sequence?: string;
  ctrl?: boolean;
  option?: boolean;
  alt?: boolean;
  meta?: boolean;
  shift?: boolean;
  super?: boolean;
  stopPropagation: () => void;
  preventDefault: () => void;
}) => void;

class WebKeyInput {
  private readonly listeners = new Map<string, Set<KeypressListener>>();

  on(event: string, handler: KeypressListener): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
  }

  off(event: string, handler: KeypressListener): void {
    this.listeners.get(event)?.delete(handler);
  }

  processPaste(data: Uint8Array): void {
    const text = new TextDecoder().decode(data);
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      const start = active.selectionStart ?? active.value.length;
      const end = active.selectionEnd ?? start;
      active.value = `${active.value.slice(0, start)}${text}${active.value.slice(end)}`;
      active.selectionStart = active.selectionEnd = start + text.length;
      active.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  emitKeyPress(event: KeyboardEvent): void {
    if (!shouldDispatchWebNativeKeyDown(event)) return;
    const payload = {
      name: normalizeWebKeyName(event.key),
      sequence: webKeySequence(event),
      ctrl: hasWebCtrlModifier(event),
      option: event.altKey,
      alt: event.altKey,
      meta: event.metaKey,
      shift: event.shiftKey,
      super: event.metaKey,
      stopPropagation: () => event.stopPropagation(),
      preventDefault: () => event.preventDefault(),
    };
    const listeners = this.listeners.get("keypress");
    for (const listener of listeners ?? []) {
      listener(payload);
      if (event.defaultPrevented) break;
    }
    if (listeners?.size && shouldConsumeWebAppKeyDown(event)) event.preventDefault();
  }
}

class WebNativeRenderer implements NativeRendererHost {
  private readonly listeners = new Map<string, Set<Listener>>();
  readonly keyInput = new WebKeyInput();
  capabilities = {};
  isDestroyed = false;

  get resolution() {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  get terminalWidth(): number {
    return Math.max(1, window.innerWidth / WEB_CELL_WIDTH);
  }

  get terminalHeight(): number {
    return Math.max(1, window.innerHeight / WEB_CELL_HEIGHT);
  }

  on(event: string, handler: Listener): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
  }

  off(event: string, handler: Listener): void {
    this.listeners.get(event)?.delete(handler);
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }

  requestRender(): void {}
  registerLifecyclePass(): void {}
  unregisterLifecyclePass(): void {}
}

export const webNativeRenderer = new WebNativeRenderer();

window.addEventListener("keydown", (event) => webNativeRenderer.keyInput.emitKeyPress(event));
window.addEventListener("focus", () => webNativeRenderer.emit("focus"));
window.addEventListener("blur", () => webNativeRenderer.emit("blur"));
window.addEventListener("beforeunload", () => {
  webNativeRenderer.isDestroyed = true;
  webNativeRenderer.emit("destroy");
});
