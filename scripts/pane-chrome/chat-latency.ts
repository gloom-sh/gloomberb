import { cp, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { cacheDir, evaluate, frames, launchBrowser, mouse, waitFor, type Cdp } from "./browser";
import { serveFixturePage } from "./page";

/**
 * Real keyboard and pointer input, local-only Cloud sync, and the desktop's
 * disabled capability handlers versus the web profile. Paint measurements are
 * rAF + task estimates, not GPU presentation timestamps. Only structural work
 * is gated: unchanged message rows must not render for draft/upload updates.
 *
 * bun scripts/pane-chrome/chat-latency.ts [--label before] [--check] [--quick]
 * Artifacts (including CPU profiles and source maps) go to PANE_CHROME_CACHE.
 */
const args = process.argv.slice(2);
const label = args.includes("--label") ? args[args.indexOf("--label") + 1]! : "chat-latency";
const out = cacheDir(label);
const root = resolve(import.meta.dir, "../..");
const PROBES = `
window.__latency = { commits: 0, rows: 0, changed: {}, keys: [], long: [] };
window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
 supportsFiber:true, isDisabled:false, renderers:new Map(), inject(){return 1},
 onScheduleFiberRoot(){},onCommitFiberUnmount(){},onPostCommitFiberRoot(){},checkDCE(){},
 onCommitFiberRoot(id,root){
  __latency.commits++;
  const visit=f=>{if(!f)return;
   if((f.flags&1) && f.memoizedProps?.msg && f.memoizedProps?.registerMessageElement){
    __latency.rows++;
    if(f.alternate)for(const k of Object.keys(f.memoizedProps)){
     if(f.memoizedProps[k]!==f.alternate.memoizedProps?.[k]) __latency.changed[k]=(__latency.changed[k]||0)+1;
    }
   }
   // React leaves flags on reused children. A bailed-out subtree is not work.
   if(f.child!==f.alternate?.child)visit(f.child);visit(f.sibling);
  };visit(root.current);
 }
};
new PerformanceObserver(list=>__latency.long.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});
document.addEventListener('keydown',e=>{
 if(e.target.tagName!=='TEXTAREA'||e.key.length!==1)return;
 const start=e.timeStamp, writes=window.__chatLatency.stats.storageWrites;
 requestAnimationFrame(()=>setTimeout(()=>__latency.keys.push({ms:performance.now()-start,writes:window.__chatLatency.stats.storageWrites-writes}),0));
},true);
document.addEventListener('pointerdown',e=>{
 if(!e.target.closest('[data-gloom-role=chat-draft-attachment] button[aria-label^="Remove"]'))return;
 const start=e.timeStamp;
 requestAnimationFrame(()=>setTimeout(()=>{window.__removePaint=performance.now()-start},0));
},true);
`;
const reset = (cdp: Cdp) => evaluate(cdp, "__latency={commits:0,rows:0,changed:{},keys:[],long:[]}");
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
async function clickSelector(cdp: Cdp, expression: string) {
  const point = await evaluate<{ x: number; y: number }>(cdp, `(()=>{const el=(${expression});if(!el)throw Error('Missing click target');const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await mouse(cdp, "mousePressed", point.x, point.y, true);
  await mouse(cdp, "mouseReleased", point.x, point.y, false);
}
async function channelPaint(cdp: Cdp, channel: string) {
  const prefix = channel === "everyone" ? "m" : `${channel}:m`;
  await evaluate(cdp, `void(window.__channelPaint=new Promise(done=>document.addEventListener('pointerdown',()=>{
    const start=performance.now();const tick=()=>{
      if(document.querySelector('[data-gloom-chat-message-id^="${prefix}"]'))requestAnimationFrame(()=>setTimeout(()=>done(performance.now()-start),0));
      else if(performance.now()-start>10000)done(null);else requestAnimationFrame(tick);
    };requestAnimationFrame(tick);
  },{once:true,capture:true})))`);
  await clickSelector(cdp, `[...document.querySelectorAll('[data-gloom-role="pane-sidebar-item"]')].find(el=>el.textContent.includes('${channel}'))`);
  const ms = await evaluate<number | null>(cdp, "__channelPaint", 15000);
  if (ms === null) throw new Error(`No first message in ${channel}`);
  return ms;
}

await mkdir(out, { recursive: true });
const page = await serveFixturePage(root, join(out, "build"));
// Keep the exact baseline bundle and map even after the serving page closes.
await cp(join(out, "build"), join(out, "bundle"), { recursive: true });
const browser = await launchBrowser("chat-latency", 1280, 900);
const cdp = browser.cdp;
cdp.on("Runtime.exceptionThrown", (event) => console.error(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text));
cdp.on("Runtime.consoleAPICalled", (event) => { if (event.type === "error") console.error(event.args?.map((arg: { value?: unknown; description?: string }) => arg.value ?? arg.description).join(" ")); });
const samples: Record<string, unknown>[] = [];
let failures = 0;
try {
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBES });
  for (const host of ["desktop", "browser"]) for (const count of (args.includes("--quick") ? [500] : [40, 200, 500])) {
    await cdp.send("Page.navigate", { url: `${page.url}?scenario=chat&latencyCheck=1&count=${count}&loaded=${count}&latency=0&host=${host}&recent=${args.includes("--recent") ? "1" : "0"}` });
    if (!await waitFor(cdp, `document.querySelectorAll('[data-gloom-role=chat-message]').length===${count} && __chatLatency.stats.pulls>0`, 15000)) throw new Error(`Chat fixture did not start: ${await evaluate(cdp, 'document.body.innerText.slice(0,1000)')}`);
    await frames(cdp, 6);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.start");
    const cold = await channelPaint(cdp, "macro");
    const warm = await channelPaint(cdp, "everyone");
    const switches = [await channelPaint(cdp, "macro"), await channelPaint(cdp, "everyone")];
    const opening = await cdp.send("Profiler.stop");
    await Bun.write(join(out, `${host}-${count}-opening.cpuprofile`), JSON.stringify(opening.profile));
    for (const image of [false, true]) {
      if (image) {
        // A real file chooser click, with CDP standing in only for the OS picker.
        await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true });
        const chooser = cdp.once<{ backendNodeId: number }>("Page.fileChooserOpened");
        await clickSelector(cdp, `document.querySelector('button[aria-label="Attach Image"]')`);
        const { backendNodeId } = await chooser;
        const png = await evaluate<string>(cdp, `(()=>{const c=document.createElement('canvas');c.width=1024;c.height=768;const x=c.getContext('2d');x.fillStyle='#789abc';x.fillRect(0,0,1024,768);return c.toDataURL('image/png').split(',')[1]})()`);
        const path = join(out, "fixture.png");
        await Bun.write(path, Buffer.from(png, "base64"));
        const start = performance.now();
        await cdp.send("DOM.setFileInputFiles", { files: [path], backendNodeId });
        if (!await waitFor(cdp, `document.querySelector('[data-gloom-role=chat-draft-attachment] img')?.complete`, 10000)) throw new Error("Image preview did not decode");
        samples.push({ host, count, attachPreviewMs: performance.now() - start });
      }
      await clickSelector(cdp, "document.querySelector('textarea')");
      await frames(cdp, 4);
      await reset(cdp);
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.start");
      const before = await evaluate(cdp, "({...__chatLatency.stats})");
      // Schedule outside the renderer, without waiting for the previous key:
      // otherwise a blocked UI also slows the driver and hides input queueing.
      await Promise.all(Array.from({ length: 60 }, (_, i) => new Promise<void>((done, fail) => {
        setTimeout(() => {
          const progress = image && i % 4 === 0 ? evaluate(cdp, `__chatLatency.progress(${(i / 4 + 1) / 16})`) : Promise.resolve();
          const down = cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", text: "a", windowsVirtualKeyCode: 65, timestamp: Date.now() / 1000 });
          const up = cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
          void Promise.all([progress, down, up]).then(() => done(), fail);
        }, i * 50 + Math.floor(i / 10) * 350);
      })));
      await frames(cdp, 25);
      const { profile } = await cdp.send("Profiler.stop");
      await Bun.write(join(out, `${host}-${count}-${image ? "image" : "text"}.cpuprofile`), JSON.stringify(profile));
      const probe = await evaluate(cdp, "__latency");
      const after = await evaluate(cdp, "({...__chatLatency.stats})");
      const ms = probe.keys.map((key: { ms: number }) => key.ms);
      const sample = { host, count, image, cold, warm, switches, p50: percentile(ms, .5), p95: percentile(ms, .95), p99: percentile(ms, .99), ...probe, syncBefore: before, syncAfter: after };
      samples.push(sample);
      console.log(JSON.stringify({ host, count, image, cold, warm, p50: sample.p50, p95: sample.p95, p99: sample.p99, rows: probe.rows, commits: probe.commits, long: probe.long.length }));
      if (probe.keys.length !== 60 || probe.rows !== 0) failures++;
      if (await evaluate(cdp, "document.querySelector('textarea').value.length") !== (image ? 120 : 60)) throw new Error("Typing lost draft characters");
      if (image) {
        await evaluate(cdp, "__chatLatency.complete()");
        await frames(cdp, 3);
        await clickSelector(cdp, `document.querySelector('[data-gloom-role=chat-draft-attachment] button[aria-label^="Remove"]')`);
        if (!await waitFor(cdp, "!document.querySelector('[data-gloom-role=chat-draft-attachment]') && window.__removePaint != null")) throw new Error("Image not removed");
        samples.push({ host, count, removePaintMs: await evaluate(cdp, "window.__removePaint") });
      }
    }
    await channelPaint(cdp, "macro");
    await channelPaint(cdp, "everyone");
    if (await evaluate(cdp, "document.querySelector('textarea').value.length") !== 120) throw new Error("Switching lost the saved draft");
  }
  await Bun.write(join(out, "samples.json"), JSON.stringify(samples, null, 2));
  if (args.includes("--check") && failures) throw new Error(`${failures} workloads rendered unchanged message rows`);
} finally {
  await browser.close();
  await page.close();
}
