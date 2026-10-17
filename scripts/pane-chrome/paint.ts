import { mkdir } from "fs/promises";
import { cacheDir, click, evaluate, frames, waitFor, type Cdp } from "./browser";

/** Theme comparisons use the product's computed palette, including its surface blends. */
const SNAPSHOT = `(() => {
  const scopes = [...document.querySelectorAll('[data-gloom-role=pane-window], [data-gloom-role=detached-pane-window], [data-gloom-role=dock-divider], [data-theme-chrome]')];
  return scopes.map(scope => ({
    id: scope.dataset.gloomPaneId ?? scope.dataset.themeChrome ?? ('divider:' + scope.dataset.axis),
    styles: [scope, ...scope.querySelectorAll('*')].map(e => {
      const s = getComputedStyle(e);
      return [e.tagName, s.color, s.backgroundColor, s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor, s.fill, s.stroke, s.boxShadow, s.getPropertyValue('--divider-color'), s.getPropertyValue('--pane-border-color')];
    }),
    pixels: [...scope.querySelectorAll('canvas')].map(c => {
      const copy = document.createElement('canvas'); copy.width=c.width; copy.height=c.height;
      const ctx=copy.getContext('2d'); ctx.drawImage(c,0,0);
      const pixels=ctx.getImageData(0,0,c.width,c.height).data;
      let hash=2166136261; for(const byte of pixels) hash=Math.imul(hash^byte,16777619);
      return [c.width,c.height,hash>>>0];
    }),
  }));
})()`;

/** Runs on every animation frame, not just once the page has settled. */
const FRAME_PROBE = `(() => {
  // A tab opened before stays mounted and hidden; only what shows is sampled.
  const shown=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;};
  const controls=document.querySelector('[data-theme-controls]');
  const theme=controls?.dataset.preview || controls?.dataset.committed;
  const panes=[...document.querySelectorAll('[data-gloom-role=pane-window], [data-gloom-role=detached-pane-window]')].map(pane=>{
    const body=pane.querySelector('[data-gloom-role=pane-body]');
    return {
      id:pane.dataset.gloomPaneId, focused:pane.dataset.focused==='true', floating:pane.dataset.floating==='true'||pane.dataset.gloomRole==='detached-pane-window',
      background:getComputedStyle(body).backgroundColor,
      chartText:[...body.querySelectorAll('[data-gloom-role=composite-chart]')].filter(shown).map(chart=>chart.innerText.replace(/\\s+/g,' ').trim()).join(' | '),
      plots:[...body.querySelectorAll('[data-gloom-role=composite-chart-panel]')].filter(shown).map(plot=>{
        const r=plot.getBoundingClientRect(), canvas=plot.querySelector('canvas');
        return {rect:[r.x,r.y,r.width,r.height], background:getComputedStyle(plot).backgroundColor,
          canvas:canvas?{size:[canvas.width,canvas.height],pixel:[...canvas.getContext('2d').getImageData(1,1,1,1).data]}:null};
      }),
    };
  });
  const surface=document.querySelector('[data-gloom-role=surface-3d] canvas');
  let surfacePixel=null;
  if(surface){const copy=document.createElement('canvas');copy.width=surface.width;copy.height=surface.height;const ctx=copy.getContext('2d');ctx.drawImage(surface,0,0);surfacePixel=[...ctx.getImageData(1,1,1,1).data];}
  const paletteTransitions=document.getAnimations().filter(a=>a.transitionProperty && /color|fill|stroke|shadow/.test(a.transitionProperty) && a.playState==='running').map(a=>a.transitionProperty);
  return {theme, dpr:devicePixelRatio, surfacePixel, paletteTransitions, tab:document.querySelector('[role=tab][aria-selected=true]')?.textContent.trim(), panes, dividers:[...document.querySelectorAll('[data-gloom-role=dock-divider]')].map(e=>getComputedStyle(e).getPropertyValue('--divider-color').trim())};
})()`;

interface Frame {
  n: number;
  time: number;
  theme: string;
  dpr: number;
  tab: string | undefined;
  surfacePixel: number[] | null;
  paletteTransitions: string[];
  panes: Array<{
    id: string; focused: boolean; floating: boolean; background: string; chartText: string;
    plots: Array<{ rect: number[]; background: string; canvas: { size: number[]; pixel: number[] } | null }>;
  }>;
  dividers: string[];
}

async function key(cdp: Cdp, key: string): Promise<void> {
  const code = ({ ArrowDown: 40, Home: 36, End: 35, Enter: 13, Escape: 27 } as Record<string, number>)[key];
  for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: code });
}

async function clickElement(cdp: Cdp, expression: string): Promise<void> {
  const point = await evaluate(cdp, `(() => {const e=${expression}; if(!e)throw new Error('missing input: '+${JSON.stringify(expression)}); const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await click(cdp, point);
}

/**
 * Samples what each frame painted: a task posted from the frame's animation
 * callback runs once that frame's rendering (style, layout, resize
 * observers, paint) is done, before the next frame's. A sample taken in the
 * callback itself would read the page before its resize observers ran, and
 * miss what they change in the same frame (a tab coming back).
 */
async function startFrames(cdp: Cdp): Promise<void> {
  await evaluate(cdp, `window.__paintGeneration=(window.__paintGeneration??0)+1;
    window.__paintFrames=[];
    (()=>{const generation=window.__paintGeneration;let n=0;const channel=new MessageChannel();let frameTime=0;
      channel.port1.onmessage=()=>{if(generation!==window.__paintGeneration)return;window.__paintFrames.push({n:n++,time:frameTime,...${FRAME_PROBE}});};
      const tick=time=>{
        if(generation!==window.__paintGeneration)return;
        frameTime=time;channel.port2.postMessage(0);
        requestAnimationFrame(tick);
      };requestAnimationFrame(tick);})()`);
}

async function stopFrames(cdp: Cdp, name: string): Promise<Frame[]> {
  const samples = await evaluate<Frame[]>(cdp, "++window.__paintGeneration; window.__paintFrames");
  await mkdir(cacheDir("paint"), { recursive: true });
  await Bun.write(cacheDir("paint", `${name}.json`), JSON.stringify(samples, null, 2));
  return samples;
}

function rgb(hex: string): number[] {
  return [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
}
function blend(a: string, b: string, weight: number): string {
  const to = rgb(b);
  return `rgb(${rgb(a).map((v, i) => Math.round(v + (to[i]! - v) * weight)).join(", ")})`;
}

function checkFrames(samples: Frame[], palettes: Record<string, Record<string, string>>, checkTheme: boolean): void {
  for (const sample of samples) {
    const palette = palettes[sample.theme]!;
    const at = `frame ${sample.n} (+${(sample.time - samples[0]!.time).toFixed(1)} ms), ${sample.theme}`;
    if (checkTheme && sample.paletteTransitions.length) throw new Error(`${at}: interpolating between palettes (${sample.paletteTransitions.join(", ")})`);
    for (const pane of sample.panes) {
      if (checkTheme) {
        const expected = pane.focused
          ? blend(palette.bg!, palette.borderFocused!, pane.floating ? .08 : .06)
          : blend(palette.panel!, palette.border!, pane.floating ? .18 : .08);
        if (pane.background !== expected) throw new Error(`${at}: ${pane.id} background ${pane.background}, expected ${expected}`);
      }
      for (const plot of pane.plots) {
        if (!plot.canvas) throw new Error(`${at}: ${pane.id} exposed an empty ${plot.rect.slice(2).join("x")} plot`);
        const pixel = plot.canvas.pixel;
        if (pixel[3] !== 255 || `rgb(${pixel.slice(0, 3).join(", ")})` !== pane.background) {
          throw new Error(`${at}: ${pane.id} canvas ${pixel} differs from body ${pane.background}`);
        }
      }
    }
    if (checkTheme && sample.surfacePixel && sample.surfacePixel.join() !== [...rgb(palette.bg!), 255].join()) {
      throw new Error(`${at}: 3D surface background ${sample.surfacePixel}, expected ${palette.bg}`);
    }
    if (checkTheme && sample.dividers.some((color) => color !== palette.border)) {
      throw new Error(`${at}: divider ${sample.dividers.join(", ")}, expected ${palette.border}`);
    }
  }
}

/** Every built-in theme: preview is the committed palette, cancellation is lossless. */
export async function checkThemePreview(cdp: Cdp): Promise<void> {
  await clickElement(cdp, "document.querySelector('[data-theme-controls] button')");
  await clickElement(cdp, "document.querySelector('[aria-label=\"Theme filter\"]')");
  await frames(cdp, 4);
  const original = await evaluate(cdp, SNAPSHOT);
  const palettes = await evaluate<Record<string, Record<string, string>>>(cdp, "__paneChrome.themes");
  const ids = await evaluate<string[]>(cdp, "Object.entries(__paneChrome.themes).map(([id])=>id)");
  // The picker sorts by display name, not id.
  const sorted = await evaluate<string[]>(cdp, "__paneChrome.themeOrder");
  for (const id of ids) {
    // Cancel back to High Contrast, even after the previous iteration committed.
    await evaluate(cdp, `window.__paneChrome.resetTheme()`);
    await frames(cdp, 12);
    await startFrames(cdp);
    await key(cdp, "End");
    await key(cdp, "Home");
    for (let index = 0; index < sorted.indexOf(id); index++) await key(cdp, "ArrowDown");
    if (!await waitFor(cdp, `document.querySelector('[data-theme-controls]').dataset.preview === ${JSON.stringify(id === "high-contrast" ? "" : id)}`, 3000)) throw new Error(`picker did not preview ${id}`);
    await frames(cdp, 3);
    const samples = await stopFrames(cdp, `preview-${id}`);
    checkFrames(samples, palettes, true);
    const preview = await evaluate(cdp, SNAPSHOT);
    await key(cdp, "Enter");
    await frames(cdp, 3);
    const committed = await evaluate(cdp, SNAPSHOT);
    if (JSON.stringify(preview) !== JSON.stringify(committed)) {
      await Bun.write(cacheDir("paint", `commit-${id}.json`), JSON.stringify({ preview, committed }, null, 2));
      throw new Error(`${id}: committing repainted pane colors or pixels`);
    }
    // Preview another palette and cancel without committing.
    await key(cdp, "End");
    await key(cdp, "Home");
    await frames(cdp, 12);
    await key(cdp, "Escape");
    await frames(cdp, 3);
    if (JSON.stringify(committed) !== JSON.stringify(await evaluate(cdp, SNAPSHOT))) throw new Error(`${id}: cancel did not restore committed pixels and tokens`);
  }
  await evaluate(cdp, "window.__paneChrome.resetTheme()");
  await frames(cdp, 12);
  if (JSON.stringify(original) !== JSON.stringify(await evaluate(cdp, SNAPSHOT))) throw new Error("final cancel did not restore High Contrast");
}

/**
 * Every plot that shows is drawn for the box it shows in. A bitmap drawn for
 * another size is stretched over the plot: a chart tab that comes back with
 * the 1 by 1 bitmap it drew while hidden shows that pixel across the whole
 * plot until its resize redraw lands (GLO-590).
 */
function checkDrawnForItsBox(samples: Frame[], label: string): void {
  for (const sample of samples) {
    for (const pane of sample.panes) {
      pane.plots.forEach((plot, index) => {
        if (!plot.canvas) return;
        const [width, height] = plot.canvas.size as [number, number];
        const boxWidth = plot.rect[2]! * sample.dpr;
        const boxHeight = plot.rect[3]! * sample.dpr;
        if (Math.abs(width - boxWidth) > 1.5 || Math.abs(height - boxHeight) > 1.5) {
          throw new Error(`${label}, frame ${sample.n} (+${(sample.time - samples[0]!.time).toFixed(1)} ms): ${pane.id} plot ${index} shows a ${width}x${height} bitmap stretched over its ${Math.round(boxWidth)}x${Math.round(boxHeight)} box`);
        }
      });
    }
  }
}

/** Every frame from the first one with a plot draws the chart the pane settles on: same place, same size, same labels. */
function checkSettledFromFirstPlot(samples: Frame[], label: string, pick: (sample: Frame) => Frame["panes"][number] | undefined): void {
  const shown = samples.filter((sample) => pick(sample)?.plots.length);
  const last = shown.at(-1) && pick(shown.at(-1)!);
  if (!last) return;
  for (const sample of shown) {
    const pane = pick(sample)!;
    const at = `${label}, frame ${sample.n} (+${(sample.time - samples[0]!.time).toFixed(1)} ms)`;
    if (pane.plots.length !== last.plots.length) throw new Error(`${at}: ${pane.plots.length} plots, then ${last.plots.length}`);
    pane.plots.forEach((plot, index) => {
      const settled = last.plots[index]!;
      if (plot.rect.some((value, i) => Math.abs(value - settled.rect[i]!) > .1)) throw new Error(`${at}: plot ${index} at ${plot.rect.join(",")}, then moved to ${settled.rect.join(",")}`);
      if (plot.canvas && settled.canvas && plot.canvas.size.join() !== settled.canvas.size.join()) throw new Error(`${at}: plot ${index} bitmap ${plot.canvas.size.join("x")}, then ${settled.canvas.size.join("x")}`);
    });
    // A provisional chart that relabels its axes when the settled one lands reads as a flash.
    if (pane.chartText !== last.chartText) throw new Error(`${at}: chart drew "${pane.chartText.slice(0, 160)}", then "${last.chartText.slice(0, 160)}"`);
  }
}

const TAB = (tab: string) => `[...document.querySelectorAll('[role=tab]')].find(e=>e.textContent.trim()===${JSON.stringify(tab)})`;
/** The chart composer has drawn its settled chart: a plot, and no loading state in the pane. */
const COMPOSER_SETTLED = `document.querySelector('[data-gloom-role=composite-chart-panel] canvas') && !/loading/i.test(document.querySelector('[data-gloom-role=pane-window]')?.innerText ?? '')`;

/**
 * Cold open of every pane, then rapid switches. Every visible plot has pixels
 * at its final size. `composer` is the research Chart tab: the first open waits
 * for its bars, the next ones draw from cache, and both must paint the chart it
 * settles on from their first plotted frame.
 */
export async function checkFirstPaint(cdp: Cdp): Promise<void> {
  const palettes = await evaluate<Record<string, Record<string, string>>>(cdp, "__paneChrome.themes");
  const theme = await evaluate<string>(cdp, "document.querySelector('[data-theme-controls]').dataset.committed");
  for (const [index, tab] of ["chart", "empty", "overview", "composer", "chart", "overview", "chart", "overview", "composer", "empty", "composer"].entries()) {
    await startFrames(cdp);
    await clickElement(cdp, TAB(tab));
    if (tab === "composer" && !await waitFor(cdp, COMPOSER_SETTLED, 5000)) throw new Error(`${tab}: the chart did not settle`);
    await frames(cdp, tab === "composer" ? 20 : 6);
    const samples = await stopFrames(cdp, `open-${theme}-${index}-${tab}`);
    checkDrawnForItsBox(samples, tab);
    checkFrames(samples, palettes, false);
    if (tab !== "empty" && !samples.some((sample) => sample.tab === tab && sample.panes[0]?.plots.length)) throw new Error(`${tab}: no plot was captured`);
    checkSettledFromFirstPlot(samples, tab, (sample) => sample.tab === tab ? sample.panes[0] : undefined);
  }
  // A chart pane added beside it: its bars are cached by now.
  await startFrames(cdp);
  const added = await evaluate<string>(cdp, "window.__paneChrome.addChartPane()");
  const addedPane = `document.querySelector('[data-gloom-role=pane-window][data-gloom-pane-id=${JSON.stringify(added)}]')`;
  if (!await waitFor(cdp, `${addedPane}?.querySelector('[data-gloom-role=composite-chart-panel] canvas') && !/loading/i.test(${addedPane}.innerText)`, 5000)) {
    throw new Error("added chart pane: the chart did not settle");
  }
  await frames(cdp, 20);
  const samples = await stopFrames(cdp, `open-${theme}-added-pane`);
  checkFrames(samples, palettes, false);
  checkSettledFromFirstPlot(samples, "added chart pane", (sample) => sample.panes.find((pane) => pane.id === added));
}
