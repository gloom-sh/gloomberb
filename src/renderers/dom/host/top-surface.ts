import { useLayoutEffect, type RefObject } from "react";

type Rgba = [number, number, number, number];

const THROTTLE_MS = 120;
/** Rows and cells follow the cursor and selection; a tab must not take their colour. */
const TRANSIENT_ROLES = /^data-table-(row|cell|header-cell)$/;
const ACTIVE_BG = "--pane-tab-active-bg";

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

/**
 * The colour the active title-bar tab takes so it reads as the top of the pane
 * body: whatever surface sits directly under it (the query bar's band, a detail
 * header, a table header, the body itself), translucent layers composited.
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
    if (element === body || element === surface || (startsAtTop && spansBody && !TRANSIENT_ROLES.test(role))) {
      const color = parseColor(getComputedStyle(element).backgroundColor);
      if (color && color[3] > 0) layers.push(color);
    }
    if (element === body) break;
  }
  // From the body outwards to the topmost surface.
  let color: Rgba | null = null;
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index]!;
    color = color ? over(layer, color) : layer[3] >= 1 ? layer : null;
  }
  if (!color) return null;
  return `rgb(${Math.round(color[0])}, ${Math.round(color[1])}, ${Math.round(color[2])})`;
}

/**
 * Keeps `--pane-tab-active-bg` on a title-bar tab list equal to the surface
 * under its active tab, so the tab opens into the pane. Without a measure the
 * header's own value (the body colour) applies. A change to the body itself
 * (focus and theme recolour it) is measured at once, before it paints; changes
 * inside it (a detail opens, a query bar appears) at most every 120 ms; a
 * resize once it stops, so dragging a pane's edge costs no measures.
 */
export function useTopSurfaceColor(listRef: RefObject<HTMLElement | null>, enabled: boolean, deps: readonly unknown[]) {
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!enabled || !list) return;
    const body = list.closest("[data-gloom-role=pane-window], [data-gloom-role=detached-pane-window]")
      ?.querySelector<HTMLElement>(":scope > [data-gloom-role=pane-body]");
    if (!body) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const measure = () => {
      if (timer != null) clearTimeout(timer);
      timer = null;
      const active = list.querySelector<HTMLElement>("[data-active=true]");
      if (!active) return;
      const rect = active.getBoundingClientRect();
      const color = measureTopSurface(body, rect.left + rect.width / 2);
      if (color === (list.style.getPropertyValue(ACTIVE_BG) || null)) return;
      if (color) list.style.setProperty(ACTIVE_BG, color);
      else list.style.removeProperty(ACTIVE_BG);
    };
    const schedule = () => {
      if (timer == null) timer = setTimeout(measure, THROTTLE_MS);
    };
    const settle = () => {
      if (timer != null) clearTimeout(timer);
      timer = setTimeout(measure, THROTTLE_MS);
    };
    measure();
    const resize = new ResizeObserver(settle);
    resize.observe(body);
    // Live data rewrites text constantly; only structure and inline styles
    // (visibility, focus colours, theme) can change what sits under the tab.
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => record.target === body)) measure();
      else schedule();
    });
    mutations.observe(body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "data-gloom-top-surface"] });
    return () => {
      if (timer != null) clearTimeout(timer);
      resize.disconnect();
      mutations.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);
}
