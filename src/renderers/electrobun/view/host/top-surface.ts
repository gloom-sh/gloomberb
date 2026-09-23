import { useLayoutEffect, type RefObject } from "react";

type Rgba = [number, number, number, number];

const THROTTLE_MS = 120;
/** Rows and cells follow the cursor and selection; a tab must not take their colour. */
const TRANSIENT_ROLES = /^data-table-(row|cell|header-cell)$/;

function parseColor(value: string): Rgba | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "transparent") return [0, 0, 0, 0];
  const rgb = /^rgba?\(([^)]+)\)$/.exec(trimmed);
  if (rgb) {
    const parts = rgb[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some(Number.isNaN)) return null;
    return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
  }
  const srgb = /^color\(srgb\s+([^)]+)\)$/.exec(trimmed);
  if (srgb) {
    const parts = srgb[1]!.split(/[\s/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some(Number.isNaN)) return null;
    return [parts[0]! * 255, parts[1]! * 255, parts[2]! * 255, parts[3] ?? 1];
  }
  return null;
}

function over(top: Rgba, base: Rgba): Rgba {
  const alpha = top[3];
  return [
    top[0] * alpha + base[0] * (1 - alpha),
    top[1] * alpha + base[1] * (1 - alpha),
    top[2] * alpha + base[2] * (1 - alpha),
    1,
  ];
}

function backgroundOf(element: Element): Rgba | null {
  return parseColor(getComputedStyle(element).backgroundColor);
}

/**
 * The colour a title-bar tab should take so it reads as the top of the pane
 * body: whatever surface sits directly under it (a query bar, a detail header,
 * a table header, the body itself), with translucent layers composited.
 */
function measureTopSurface(body: HTMLElement, x: number): string | null {
  const bodyRect = body.getBoundingClientRect();
  if (bodyRect.width <= 0 || bodyRect.height <= 0) return null;
  const y = bodyRect.top + 1;
  let top: Element = document.elementsFromPoint(x, y).find((element) => body.contains(element)) ?? body;
  // A marked surface (query bar, detail header) is taken whole, so hovering a
  // control inside it never tints the tab.
  const surface = top.closest("[data-gloom-top-surface]");
  if (surface && body.contains(surface)) top = surface;

  const layers: Rgba[] = [];
  for (let element: Element | null = top; element; element = element.parentElement) {
    const role = element.getAttribute("data-gloom-role") ?? "";
    const rect = element.getBoundingClientRect();
    const startsAtTop = Math.abs(rect.top - bodyRect.top) <= 1.5;
    const spansBody = rect.width >= bodyRect.width * 0.6;
    const include = element === body || element === surface || (startsAtTop && spansBody && !TRANSIENT_ROLES.test(role));
    if (include) {
      const color = backgroundOf(element);
      if (color && color[3] > 0) layers.push(color);
    }
    if (element === body) break;
  }
  // Composite from the body outwards to the topmost surface.
  let color: Rgba | null = null;
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index]!;
    color = color ? over(layer, color) : layer[3] >= 1 ? layer : null;
  }
  if (!color) return null;
  return `rgb(${Math.round(color[0])}, ${Math.round(color[1])}, ${Math.round(color[2])})`;
}

/**
 * Keeps `--pane-tab-active-bg` on the tab list equal to the surface under its
 * active tab, re-measuring as the pane body changes (a detail opens, a query
 * bar appears, focus or theme changes the body colour).
 */
export function useTopSurfaceColor(listRef: RefObject<HTMLElement | null>, enabled: boolean, deps: readonly unknown[]) {
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!enabled || !list) return;
    const body = list.closest("[data-gloom-role=pane-window]")
      ?.querySelector<HTMLElement>(":scope > [data-gloom-role=pane-body]");
    if (!body) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const measure = () => {
      timer = null;
      const active = list.querySelector<HTMLElement>("[data-active=true]");
      if (!active) return;
      const rect = active.getBoundingClientRect();
      const color = measureTopSurface(body, rect.left + rect.width / 2);
      if (color) list.style.setProperty("--pane-tab-active-bg", color);
      else list.style.removeProperty("--pane-tab-active-bg");
    };
    const schedule = () => {
      if (timer == null) timer = setTimeout(measure, THROTTLE_MS);
    };
    measure();
    const resize = new ResizeObserver(schedule);
    resize.observe(body);
    // Live data rewrites text constantly; only structure and inline styles
    // (visibility, focus colours, theme) can change what sits under the tab.
    const mutations = new MutationObserver(schedule);
    mutations.observe(body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "data-gloom-top-surface"] });
    return () => {
      if (timer != null) clearTimeout(timer);
      resize.disconnect();
      mutations.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);
}
