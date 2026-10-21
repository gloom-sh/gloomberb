import { click, evaluate, frames, mouse, type Cdp } from "./browser";

/**
 * Title-bar tabs (GLO-1138): a pane's primary strip, drawn in its title bar on
 * the desktop and the web, is a row of raised boxes. The active tab is a box
 * with rounded top corners from just under the bar's top edge down over its
 * bottom rule, its top and sides in the rule's colour and its inside the
 * colour of what is under it, so it opens into the pane. Docked, floating and
 * popped out, every label sits on the title's centre line, and focus changes
 * colours, never weights or widths. Read from the pixels Chrome draws, so a
 * rule painted over the tab or a seam between the tab and the bar under it
 * fails. In-pane tab rows keep their underline.
 */

interface TitleTabStep {
  name: string;
  scenario: string;
  run(cdp: Cdp): Promise<void>;
}

interface Box { left: number; right: number; top: number; bottom: number }
interface Strip {
  header: Box;
  body: Box;
  title: { centre: number; weight: string };
  tabs: Array<{ label: string; box: Box; centre: number; weight: string; colour: string; fill: string; line: string }>;
  active: number;
  /** The active tab's own outline and corners, computed. */
  outline: { top: number; side: number; bottom: number; topRadius: number; bottomRadius: number; colours: string[] };
  /** What a tab's ::after draws: the underline of an in-pane strip. */
  underline: string;
}

/** Centre lines may differ by subpixel rounding only. */
const TOLERANCE = 0.5;

function fail(message: string, detail?: unknown): never {
  throw new Error(detail === undefined ? message : `${message}\n     ${JSON.stringify(detail)}`);
}

const STRIP = (paneId: string) => `(() => {
  const pane = document.querySelector('[data-gloom-role=pane-window][data-gloom-pane-id="${paneId}"], [data-gloom-role=detached-pane-window][data-gloom-pane-id="${paneId}"]');
  const header = pane?.querySelector("[data-gloom-role=pane-header]");
  const body = pane?.querySelector(":scope > [data-gloom-role=pane-body]");
  const list = header?.querySelector("[data-gloom-role=tab-list]");
  if (!header || !body || !list) return null;
  const box = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
  const centre = (element) => { const r = element.getBoundingClientRect(); return r.top + r.height / 2; };
  const title = header.querySelector("[data-gloom-role=pane-title]");
  const tabs = [...list.querySelectorAll("[role=tab]")];
  const active = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
  const style = getComputedStyle(tabs[active]);
  return {
    header: box(header),
    body: box(body),
    title: { centre: centre(title), weight: getComputedStyle(title).fontWeight },
    tabs: tabs.map((tab) => {
      const s = getComputedStyle(tab);
      return { label: tab.textContent.trim(), box: box(tab), centre: centre(tab.querySelector("[data-gloom-role=tab-label]")), weight: s.fontWeight, colour: s.color, fill: s.backgroundColor, line: s.borderTopColor };
    }),
    active,
    outline: {
      top: parseFloat(style.borderTopWidth), side: parseFloat(style.borderLeftWidth), bottom: parseFloat(style.borderBottomWidth),
      topRadius: parseFloat(style.borderTopLeftRadius), bottomRadius: parseFloat(style.borderBottomLeftRadius),
      colours: [style.borderTopColor, style.borderLeftColor, style.borderRightColor],
    },
    underline: getComputedStyle(tabs[active], "::after").content,
  };
})()`;

async function readStrip(cdp: Cdp, paneId: string): Promise<Strip> {
  return await evaluate<Strip | null>(cdp, STRIP(paneId)) ?? fail(`${paneId} has no title-bar tabs`);
}

/** Device pixels at page points, read from one Chrome screenshot of the clip. */
async function pixels(cdp: Cdp, clip: Box, points: Array<{ x: number; y: number }>): Promise<number[][]> {
  const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    clip: { x: clip.left, y: clip.top, width: clip.right - clip.left, height: clip.bottom - clip.top, scale: 1 },
  });
  return await evaluate<number[][]>(cdp, `(async () => {
    const image = new Image();
    image.src = "data:image/png;base64,${shot.data}";
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return ${JSON.stringify(points)}.map((point) => [...context.getImageData(Math.floor(point.x - ${clip.left}), Math.floor(point.y - ${clip.top}), 1, 1).data.slice(0, 3)]);
  })()`);
}

const same = (a: number[], b: number[]) => a.every((value, index) => Math.abs(value - b[index]!) <= 2);

/** The box, its lines and its labels, against the title bar it sits in. */
async function checkBox(cdp: Cdp, paneId: string, where: string): Promise<Strip> {
  const strip = await readStrip(cdp, paneId);
  const tab = strip.tabs[strip.active] ?? fail(`${where}: no active tab`);
  const { outline } = strip;
  if (Math.abs(tab.box.bottom - strip.header.bottom) > TOLERANCE) fail(`${where}: the active tab does not reach the title bar's bottom edge, so its rule shows under it`, { tab: tab.box, header: strip.header });
  if (tab.box.top <= strip.header.top || tab.box.top - strip.header.top > 3) fail(`${where}: the active tab's box does not start just under the title bar's top edge`, { tab: tab.box, header: strip.header });
  if (outline.top !== 1 || outline.side !== 1 || outline.bottom !== 0) fail(`${where}: the active tab is not a box open at the bottom`, outline);
  if (outline.topRadius !== 6 || outline.bottomRadius !== 0) fail(`${where}: the active tab's corners are not the control radius on top and square at the bottom`, outline);
  if (new Set(outline.colours).size !== 1) fail(`${where}: the active tab's top and sides are not one line`, outline);
  if (strip.underline !== "none") fail(`${where}: a title-bar tab draws the in-pane underline`, strip.underline);
  for (const entry of strip.tabs) {
    if (Math.abs(entry.centre - strip.title.centre) > TOLERANCE) fail(`${where}: "${entry.label}" is off the title's centre line`, { label: entry.centre, title: strip.title.centre });
  }

  // From the pixels: the rule beside the box, none under it, the box drawn in the rule's colour.
  const x = (tab.box.left + tab.box.right) / 2;
  const ruleY = strip.header.bottom - 0.5;
  const besideX = tab.box.left - 3 > strip.header.left ? tab.box.left - 3 : tab.box.right + 3;
  const [inside, under, rule, top, bar] = await pixels(cdp, { left: strip.header.left, top: strip.header.top, right: strip.header.right, bottom: strip.header.bottom + 4 }, [
    { x: tab.box.left + 3, y: ruleY },
    { x: tab.box.left + 3, y: strip.header.bottom + 1.5 },
    { x: besideX, y: ruleY },
    { x, y: tab.box.top + 0.5 },
    { x: besideX, y: strip.header.bottom - 2.5 },
  ]) as [number[], number[], number[], number[], number[]];
  if (same(inside, rule)) fail(`${where}: the title bar's rule runs under the active tab`, { inside, rule });
  if (!same(inside, under)) fail(`${where}: the active tab is not the colour of what is under it`, { tab: inside, under });
  if (same(rule, bar)) fail(`${where}: no rule beside the active tab`, { rule, bar });
  if (!same(top, rule)) fail(`${where}: the active tab's top line is not the rule's colour`, { top, rule });
  return strip;
}

async function focusPane(cdp: Cdp, paneId: string): Promise<void> {
  const point = await evaluate<{ x: number; y: number } | null>(cdp, `(() => {
    const body = document.querySelector('[data-gloom-pane-id="${paneId}"] > [data-gloom-role=pane-body]');
    const r = body?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.bottom - 12 } : null;
  })()`) ?? fail(`${paneId} has no body to click`);
  await click(cdp, point);
  await mouse(cdp, "mouseMoved", 1, 899, false);
  // Past the labels' colour transition.
  await frames(cdp, 12);
}

export const titleTabSteps: TitleTabStep[] = [
  ...["white", "paper"].map((theme): TitleTabStep => ({
    name: `title-bar tabs (docked, ${theme}): the active tab is a box open into the pane, labels on the title's centre line, and focus changes colour, not weight or width`,
    scenario: `docked&theme=${theme}`,
    async run(cdp) {
      await focusPane(cdp, "tabs:a");
      const focused = await checkBox(cdp, "tabs:a", "focused");
      // The pointer over an inactive tab fills it in the box's shape.
      const third = focused.tabs.find((tab) => tab.label === "Third") ?? fail("no Third tab");
      await mouse(cdp, "mouseMoved", (third.box.left + third.box.right) / 2, (third.box.top + third.box.bottom) / 2, false);
      await frames(cdp, 12);
      const hovered = await readStrip(cdp, "tabs:a");
      const hoveredThird = hovered.tabs.find((tab) => tab.label === "Third")!;
      if (/rgba\(0, 0, 0, 0\)|transparent/.test(hoveredThird.fill)) fail("an inactive tab under the pointer takes no fill", hoveredThird);
      if (hovered.tabs[hovered.active]!.fill !== focused.tabs[focused.active]!.fill) fail("hovering another tab changed the active one", hovered.tabs[hovered.active]);
      await mouse(cdp, "mouseMoved", 1, 899, false);

      await focusPane(cdp, "plain:a");
      const unfocused = await checkBox(cdp, "tabs:a", "unfocused");
      const [was, now] = [focused.tabs[focused.active]!, unfocused.tabs[unfocused.active]!];
      if (was.weight !== now.weight || focused.title.weight !== unfocused.title.weight) fail("focus changed a weight", { tab: [was.weight, now.weight], title: [focused.title.weight, unfocused.title.weight] });
      if (focused.tabs.some((tab, index) => Math.abs(tab.box.right - tab.box.left - (unfocused.tabs[index]!.box.right - unfocused.tabs[index]!.box.left)) > 0.01)) fail("focus changed a tab's width");
      if (was.colour === now.colour) fail("the active tab's label reads the same focused and not", { focused: was.colour, unfocused: now.colour });
      if (was.line === now.line) fail("the active tab's line is the same colour focused and not: it should be the title bar's rule (the accent while focused)", { focused: was.line, unfocused: now.line });
    },
  })),
  {
    name: "title-bar tabs (floating): the box sits under the pane's top border, labels on the title's centre line",
    scenario: "narrow",
    async run(cdp) {
      await focusPane(cdp, "tabs:wide");
      await checkBox(cdp, "tabs:wide", "floating, focused");
      await focusPane(cdp, "plain:a");
      await checkBox(cdp, "tabs:wide", "floating, unfocused");
    },
  },
  {
    name: "title-bar tabs (popped out): the window's title bar draws the same box",
    scenario: "detached",
    async run(cdp) {
      await checkBox(cdp, "tabs:a", "popped out");
    },
  },
  {
    name: "title-bar tabs (over a query bar): the active tab takes the bar's colour, with no seam between them",
    scenario: "nested",
    async run(cdp) {
      await focusPane(cdp, "board:dock");
      const strip = await checkBox(cdp, "board:dock", "over a query bar");
      const fill = strip.tabs[strip.active]!.fill;
      const body = await evaluate<string>(cdp, `getComputedStyle(document.querySelector('[data-gloom-pane-id="board:dock"] > [data-gloom-role=pane-body]')).backgroundColor`);
      if (fill === body) fail("the active tab took the pane body's colour, not the query bar's under it", { tab: fill, body });
    },
  },
  {
    name: "in-pane tab rows keep the underline: no box, the active tab on its accent line",
    scenario: "kit&family=tabs",
    async run(cdp) {
      const tab = await evaluate<{ underline: string; opacity: string; border: string; fill: string } | null>(cdp, `(() => {
        const tab = document.querySelector('[data-kit-sample="active, inactive, disabled"] [role=tab][aria-selected=true]');
        if (!tab) return null;
        const s = getComputedStyle(tab);
        const after = getComputedStyle(tab, "::after");
        return { underline: after.content, opacity: after.opacity, border: s.borderTopWidth, fill: s.backgroundColor };
      })()`) ?? fail("the kit page has no in-pane tab strip");
      if (tab.underline === "none" || tab.opacity !== "1") fail("an in-pane active tab lost its underline", tab);
      if (tab.border !== "0px" || !/rgba\(0, 0, 0, 0\)|transparent/.test(tab.fill)) fail("an in-pane tab is drawn as a box", tab);
    },
  },
];
