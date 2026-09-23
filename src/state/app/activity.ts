import { type NativeRendererHost as CliRenderer } from "../../ui";
import { createContext, useContext, useSyncExternalStore } from "react";
import { debugLog } from "../../utils/debug-log";

const activityLog = debugLog.createLogger("app-activity");

class AppActivityController {
  private active = true;
  private hasSeenFocus = false;
  private boundRenderer: CliRenderer | null = null;
  private teardownRenderer: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();

  bindRenderer(renderer: CliRenderer): () => void {
    if (this.boundRenderer === renderer && this.teardownRenderer) {
      return this.teardownRenderer;
    }

    this.teardownRenderer?.();
    activityLog.info("bind renderer");

    const handleFocus = () => {
      this.hasSeenFocus = true;
      activityLog.info("focus event");
      this.setActive(true);
    };
    const handleBlur = () => {
      // Some terminals can emit an initial blur before they ever report focus.
      // Fail open until focus reporting has proven itself.
      if (!this.hasSeenFocus) {
        activityLog.warn("ignored blur before first focus");
        return;
      }
      activityLog.info("blur event");
      this.setActive(false);
    };
    const handleDestroy = () => this.reset();

    renderer.on("focus", handleFocus);
    renderer.on("blur", handleBlur);
    renderer.on("destroy", handleDestroy);

    this.boundRenderer = renderer;
    this.teardownRenderer = () => {
      renderer.off("focus", handleFocus);
      renderer.off("blur", handleBlur);
      renderer.off("destroy", handleDestroy);
      if (this.boundRenderer === renderer) {
        this.boundRenderer = null;
        this.teardownRenderer = null;
      }
      activityLog.info("unbind renderer");
      this.reset();
    };

    return this.teardownRenderer;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  isActive(): boolean {
    return this.active;
  }

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    activityLog.info("activity changed", { active });
    for (const listener of this.listeners) {
      listener();
    }
  }

  reset(): void {
    this.hasSeenFocus = false;
    activityLog.info("reset activity state");
    this.setActive(true);
  }
}

const controller = new AppActivityController();

export function bindAppActivity(renderer: CliRenderer): () => void {
  return controller.bindRenderer(renderer);
}

export function isAppActive(): boolean {
  return controller.isActive();
}

export function setAppActive(active: boolean): void {
  controller.setActive(active);
}

/**
 * Whether the app can be seen, as opposed to whether it has focus. Focus is
 * attention (chat read state, notifications, account polling). Market data
 * follows visibility: a user watches quotes in a window while typing in another
 * app, so streams and refreshes pause only when the window is hidden or
 * minimized. A terminal cannot report visibility and always counts as visible.
 */
class AppVisibilityController {
  private visible = true;
  private watching = false;
  private readonly listeners = new Set<() => void>();

  private watchDocument(): void {
    if (this.watching) return;
    this.watching = true;
    const doc = (globalThis as { document?: Document }).document;
    if (!doc || typeof doc.addEventListener !== "function" || typeof doc.visibilityState !== "string") return;
    const update = () => this.setVisible(doc.visibilityState !== "hidden");
    doc.addEventListener("visibilitychange", update);
    update();
  }

  subscribe(listener: () => void): () => void {
    this.watchDocument();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  isVisible(): boolean {
    this.watchDocument();
    return this.visible;
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    activityLog.info("visibility changed", { visible });
    for (const listener of this.listeners) {
      listener();
    }
  }
}

const visibility = new AppVisibilityController();

export function isAppVisible(): boolean {
  return visibility.isVisible();
}

export function setAppVisible(visible: boolean): void {
  visibility.setVisible(visible);
}

/** For services outside React that follow visibility the way `useAppVisible` does. */
export function subscribeAppVisibility(listener: () => void): () => void {
  return visibility.subscribe(listener);
}

/** Gate market data (streams, polling, refresh clocks) on this, not on focus. */
export function useAppVisible(): boolean {
  return useSyncExternalStore(
    (listener) => visibility.subscribe(listener),
    () => visibility.isVisible(),
    () => true,
  );
}

/** Focus: gate attention (read state, notifications), not market data. */
export function useAppActive(): boolean {
  return useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.isActive(),
    () => true,
  );
}

/**
 * Whether the pane around the caller is on screen inside the layout: not
 * buried under floating windows. The pane host provides it; code outside a
 * pane (the header, the status bar, app services) reads the default, true.
 * This ignores app visibility; `usePaneVisible` combines the two.
 */
const PaneInViewContext = createContext(true);

export const PaneInViewProvider = PaneInViewContext.Provider;

/** Layout-level pane visibility alone, without the app's own visibility. */
export function usePaneInView(): boolean {
  return useContext(PaneInViewContext);
}

/**
 * Gate a pane's market data (stream priority, polls, refresh clocks) on this:
 * the app can be seen and the pane is on screen. A covered pane should keep
 * its subscriptions at a lower priority rather than drop them, so totals stay
 * current when it comes back; a hidden app pauses everything.
 */
export function usePaneVisible(): boolean {
  const appVisible = useAppVisible();
  const inView = usePaneInView();
  return appVisible && inView;
}
