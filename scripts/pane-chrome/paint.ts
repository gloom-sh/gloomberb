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
  const controls=document.querySelector('[data-theme-controls]');
  const theme=controls?.dataset.preview || controls?.dataset.committed;
  const panes=[...document.querySelectorAll('[data-gloom-role=pane-window], [data-gloom-role=detached-pane-window]')].map(pane=>{
    const body=pane.querySelector('[data-gloom-role=pane-body]');
    return {
      id:pane.dataset.gloomPaneId, focused:pane.dataset.focused==='true', floating:pane.dataset.floating==='true'||pane.dataset.gloomRole==='detached-pane-window',
      background:getComputedStyle(body).backgroundColor,
      plots:[...body.querySelectorAll('[data-gloom-role=composite-chart-panel]')].map(plot=>{
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
  return {theme, surfacePixel, paletteTransitions, tab:document.querySelector('[role=tab][aria-selected=true]')?.textContent.trim(), panes, dividers:[...document.querySelectorAll('[data-gloom-role=dock-divider]')].map(e=>getComputedStyle(e).getPropertyValue('--divider-color').trim())};
})()`;

interface Frame {
  n: number;
  time: number;
  theme: string;
  tab: string | undefined;
  surfacePixel: number[] | null;
  paletteTransitions: string[];
  panes: Array<{
    id: string; focused: boolean; floating: boolean; background: string;
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

async function startFrames(cdp: Cdp): Promise<void> {
  await evaluate(cdp, `window.__paintGeneration=(window.__paintGeneration??0)+1;
    window.__paintFrames=[];
    (()=>{const generation=window.__paintGeneration;let n=0; const tick=time=>{
      if(generation!==window.__paintGeneration)return;
      window.__paintFrames.push({n:n++,time,...${FRAME_PROBE}});
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

/** Cold open of both panes, then rapid switches. Every visible plot has pixels at its final size. */
export async function checkFirstPaint(cdp: Cdp): Promise<void> {
  const palettes = await evaluate<Record<string, Record<string, string>>>(cdp, "__paneChrome.themes");
  for (const [index, tab] of ["chart", "empty", "overview", "chart", "overview", "chart"].entries()) {
    await startFrames(cdp);
    await clickElement(cdp, `[...document.querySelectorAll('[role=tab]')].find(e=>e.textContent.trim()===${JSON.stringify(tab)})`);
    await frames(cdp, 6);
    const theme = await evaluate<string>(cdp, "document.querySelector('[data-theme-controls]').dataset.committed");
    const samples = await stopFrames(cdp, `open-${theme}-${index}-${tab}`);
    checkFrames(samples, palettes, false);
    const plots = samples.filter((sample) => sample.tab === tab).map((sample) => sample.panes[0]?.plots[0]).filter((plot) => !!plot);
    if (tab !== "empty" && !plots.length) throw new Error(`${tab}: no plot was captured`);
    const last = plots.at(-1);
    if (last?.canvas) for (const plot of plots) {
      if (plot.rect.some((value, i) => Math.abs(value - last.rect[i]!) > .1)) throw new Error(`${tab}: plot moved after first paint`);
      if (plot.canvas?.size.join() !== last.canvas.size.join()) throw new Error(`${tab}: bitmap changed size after first paint`);
    }
  }
}
