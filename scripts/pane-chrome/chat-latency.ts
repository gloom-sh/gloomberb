import { cp, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { cacheDir, evaluate, frames, launchBrowser, mouse, waitFor, type PageCommands } from "./browser";
import { serveFixturePage } from "./page";
import { launchChatWebKit } from "./chat-webkit";
import { transcriptPaint, transcriptView } from "./chat-paint";
import { checkChatReturn } from "./chat-return";

/**
 * Real keyboard and pointer input, local-only Cloud sync, and the desktop's
 * disabled capability handlers versus the web profile. Paint measurements are
 * rAF + task estimates, not GPU presentation timestamps. Only structural work
 * is gated: opening mounts a bounded window, and unchanged message rows must
 * not render for draft/upload updates.
 * --lifecycle checks geometry and pixels after mount, channel and asynchronous transitions.
 * --layout-return clicks saved layout tabs; --pane-return cycles overlapping windows.
 * --webkit runs those checks, --lifecycle or --open-only in Playwright WebKit.
 * --detached uses the real detached shell with its native bridge stubbed.
 * --arrival-on-mount delivers a message during the initial history request.
 * --multiple adds two more panes; --large-workspace adds saved layouts and drafts.
 * --open-only skips the typing/upload phase, retaining the opening profile.
 *
 * bun scripts/pane-chrome/chat-latency.ts [--label before] [--check] [--quick]
 * Artifacts (including CPU profiles and source maps) go to PANE_CHROME_CACHE.
 */
const args = process.argv.slice(2);
const webkit = args.includes("--webkit");
const returnChecks = args.includes("--layout-return") || args.includes("--pane-return");
const repeats = Number(args.includes("--repeat") ? args[args.indexOf("--repeat") + 1] : 1);
if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error("--repeat must be a positive integer");
if (webkit && !args.includes("--lifecycle") && !args.includes("--open-only") && !returnChecks) {
  throw new Error("--webkit requires --lifecycle, --open-only, --layout-return or --pane-return; CPU profiles and uploads use Chromium.");
}
const label = args.includes("--label") ? args[args.indexOf("--label") + 1]! : "chat-latency";
const out = cacheDir(label);
const root = resolve(import.meta.dir, "../..");
const workspace = args.includes("--large-workspace") ? "large" : "small";
const PROBES = `
window.__latency = { commits: 0, rows: 0, changed: {}, keys: [], long: [] };
window.__peakMountedRows = 0;
window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
 supportsFiber:true, isDisabled:false, renderers:new Map(), inject(){return 1},
 onScheduleFiberRoot(){},onCommitFiberUnmount(){},onPostCommitFiberRoot(){},checkDCE(){},
 onCommitFiberRoot(id,root){
  __latency.commits++;
  window.__peakMountedRows = Math.max(window.__peakMountedRows, document.querySelectorAll('[data-gloom-pane-id="chat:a"] [data-gloom-role=chat-message]').length);
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
const reset = (cdp: PageCommands) => evaluate(cdp, "__latency={commits:0,rows:0,changed:{},keys:[],long:[]}");
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
async function clickSelector(cdp: PageCommands, expression: string) {
  const point = await evaluate<{ x: number; y: number }>(cdp, `(()=>{const el=(${expression});if(!el)throw Error('Missing click target');const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await mouse(cdp, "mousePressed", point.x, point.y, true);
  await mouse(cdp, "mouseReleased", point.x, point.y, false);
}
async function channelPaint(cdp: PageCommands, channel: string) {
  const prefix = channel === "everyone" ? "m" : `${channel}:m`;
  await evaluate(cdp, `void(window.__channelPaint=new Promise(done=>document.addEventListener('pointerdown',()=>{
    const start=performance.now(), startRows=__latency.rows;
    window.__peakMountedRows=0;
    const last=__chatFake.messages.at(-1).id;
    const target='${channel}'==='everyone'?last:'${channel}:'+last;
    let firstVisibleMs=null;
    const tick=()=>{
      const view=${transcriptView()};
      const inChannel=view.visible.some(id=>id.startsWith('${prefix}') && ('${channel}'!=='everyone' || !id.includes(':')));
      if(inChannel && firstVisibleMs===null)firstVisibleMs=performance.now()-start;
      if(view.visible.includes(target)) {
        const latestVisibleMs=performance.now()-start, renderedRows=__latency.rows-startRows;
        requestAnimationFrame(()=>setTimeout(()=>done({ms:performance.now()-start,firstVisibleMs,latestVisibleMs,renderedRows,peakMountedRows:window.__peakMountedRows,...view}),0));
      } else if(performance.now()-start>10000)done(null);else requestAnimationFrame(tick);
    };requestAnimationFrame(tick);
  },{once:true,capture:true})))`);
  await clickSelector(cdp, `[...document.querySelectorAll('[data-gloom-pane-id="chat:a"] [data-gloom-role="pane-sidebar-item"]')].find(el=>el.textContent.includes('${channel}'))`);
  const result = await evaluate<{ ms: number; firstVisibleMs: number; latestVisibleMs: number; renderedRows: number; peakMountedRows: number; rows: number; visible: string[] } | null>(cdp, "__channelPaint", 15000);
  if (result === null) throw new Error(`No visible message in ${channel}`);
  const { png, ...paint } = await transcriptPaint(cdp);
  if (!paint.painted) {
    await Bun.write(join(out, `blank-open-${channel}.png`), png);
    throw new Error(`Rows mounted but no painted text in ${channel}: ${JSON.stringify(paint)}`);
  }
  return { ...result, paint };
}

await mkdir(out, { recursive: true });
const page = await serveFixturePage(root, join(out, "build"));
// Keep the exact baseline bundle and map even after the serving page closes.
await cp(join(out, "build"), join(out, "bundle"), { recursive: true });
const browser = webkit ? await launchChatWebKit(1280, 900) : await launchBrowser("chat-latency", 1280, 900);
const cdp = browser.cdp;
cdp.on("Runtime.exceptionThrown", (event) => console.error(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text));
cdp.on("Runtime.consoleAPICalled", (event) => { if (event.type === "error") console.error(event.args?.map((arg: { value?: unknown; description?: string }) => arg.value ?? arg.description).join(" ")); });
const samples: Record<string, unknown>[] = [];
let failures = 0;
try {
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBES });
  for (let run = 1; run <= repeats; run++) for (const host of ["desktop", "browser"]) for (const count of (args.includes("--quick") ? [500] : [40, 200, 500])) {
    await cdp.send("Page.navigate", { url: `${page.url}?scenario=chat&latencyCheck=1&count=${count}&loaded=${count}&latency=0&host=${host}&recent=${args.includes("--recent") ? "1" : "0"}&workspace=${workspace}&lifecycle=${args.includes("--lifecycle") ? "1" : "0"}&multiple=${args.includes("--multiple") ? "1" : "0"}&mount=${args.includes("--lifecycle") ? "inactive" : "chat"}&detached=${args.includes("--detached") ? "1" : "0"}&arrival=${args.includes("--arrival-on-mount") ? "mount" : "none"}&layoutReturn=${returnChecks ? "1" : "0"}&paneReturn=${args.includes("--pane-return") ? "1" : "0"}` });
    // Readiness must not require mounting the whole history: a bounded list may
    // already show the latest message while keeping earlier rows unmounted.
    if (!await waitFor(cdp, `window.__chatLatency?.snapshot('everyone').messages.length>=${count} && document.querySelector('[data-gloom-pane-id="chat:a"] [data-gloom-chat-message-id="m${count - 1}"]') && __chatLatency.stats.pulls>0`, 15000)) throw new Error(`Chat fixture did not start: ${await evaluate(cdp, 'document.body.innerText.slice(0,1000)')}`);
    await frames(cdp, 6);
    if (await evaluate<number>(cdp, "window.__peakMountedRows") > 80) {
      failures++;
      console.error(`${host}/${count}: initial open exceeded the 80-row mounting budget`);
    }
    if (returnChecks) {
      const states = await checkChatReturn(cdp, out, `${host}-${count}-${run}`, args.includes("--pane-return"));
      const failed = states.filter(state => !state.passed).map(state => state.step);
      failures += failed.length;
      samples.push({ run, host, count, webkit, states });
      console.log(JSON.stringify({ run, host, count, states: states.length, failed }));
      continue;
    }
    if (args.includes("--lifecycle")) {
      const states: Record<string, unknown>[] = [];
      const capture = async (channel: string, expected: string, paneId = "chat:a") => {
        const { png, ...paint } = await transcriptPaint(cdp, paneId);
        const { view } = paint;
        const latestId = await evaluate<string>(cdp, "__chatFake.messages.at(-1).id");
        const passed = view.height > 0 && paint.painted && (expected.startsWith("text:")
          ? view.rows === 0 && view.status && view.text.includes(expected.slice(5))
          : expected.startsWith("row:") ? view.visible.includes(expected.slice(4))
          : view.visible.includes(expected === "m" ? latestId : expected.slice(0, -1) + latestId));
        states.push({ channel, paneId, expected, passed, ...paint });
        if (!passed) {
          failures++;
          await Bun.write(join(out, `${host}-${count}-${channel.replaceAll(":", "-")}.png`), png);
        }
        return view;
      };
      const select = async (channel: string) => {
        await clickSelector(cdp, `[...document.querySelectorAll('[data-gloom-pane-id="chat:a"] [data-gloom-role="pane-sidebar-item"]')].find(el=>el.textContent.includes('${channel}'))`);
        await frames(cdp, 6);
        const expected = channel === "empty" ? "text:No messages yet." : ["waiting", "failure", "late", "resize"].includes(channel) ? "text:Loading..." : channel === "everyone" ? "m" : `${channel}:m`;
        await capture(channel, expected);
      };
      const tab = async (mode: string) => {
        await clickSelector(cdp, `[...document.querySelectorAll('[data-gloom-pane-id="chat:a"] [data-gloom-role=tab-button]')].find(el=>el.textContent==='${mode}')`);
        await frames(cdp, 6);
      };
      await tab("chat");
      await capture("initially:inactive", "m");
      for (const mode of ["inactive", "offscreen", "unmounted"]) {
        await tab(mode);
        await evaluate(cdp, `__chatFake.deliver('Arrival while ${mode}.')`);
        await frames(cdp, 3);
        await tab("chat");
        await capture(`returned:${mode}`, "m");
      }
      for (const channel of ["macro", "everyone", "macro", "everyone", "empty", "waiting"]) await select(channel);
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 720, height: 800, deviceScaleFactor: 1, mobile: false });
      await frames(cdp, 2);
      await capture("waiting:resized", "text:Loading...");
      await tab("inactive");
      await evaluate(cdp, "__chatFake.finishInitial('waiting')");
      await frames(cdp, 6);
      await tab("chat");
      await capture("waiting:resolved-hidden", "waiting:m");
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await frames(cdp, 6);
      await capture("waiting:resized-back", "waiting:m");
      await select("resize");
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 720, height: 800, deviceScaleFactor: 1, mobile: false });
      await evaluate(cdp, "__chatFake.finishInitial('resize')");
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await frames(cdp, 6);
      await capture("resize:resolved-during-open", "resize:m");
      await select("failure");
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 980, height: 760, deviceScaleFactor: 1, mobile: false });
      await evaluate(cdp, "__chatFake.finishInitial('failure',true)");
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await frames(cdp, 6);
      await capture("failure:rejected", "text:Fixture messages unavailable.");
      await select("late");
      await select("everyone");
      await evaluate(cdp, "__chatFake.finishInitial('late');__chatFake.deliver('Arrived while the previous channel was pending.')");
      await frames(cdp, 6);
      await capture("everyone:late-result", "m");
      // Scroll with real wheel input, then leave while new messages arrive.
      const point = await evaluate<{ x: number; y: number }>(cdp, `(() => {const r=document.querySelector('[data-gloom-pane-id="chat:a"] [data-gloom-role=chat-transcript]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY: -1400 });
      if (!await waitFor(cdp, `(() => {const view=${transcriptView()};return view.extent-view.height-view.top>100 && !view.visible.includes(__chatFake.messages.at(-1).id)})()`)) {
        const { png, ...paint } = await transcriptPaint(cdp);
        await Bun.write(join(out, `${host}-${count}-wheel.png`), png);
        throw new Error(`Wheel did not scroll the reader back: ${JSON.stringify(paint)}`);
      }
      await frames(cdp, 3);
      const reader = await evaluate<{ visible: string[]; top: number; extent: number; height: number }>(cdp, transcriptView());
      await capture("reader:scrolled-back", `row:${reader.visible[0]}`);
      await tab("inactive");
      await evaluate(cdp, "__chatFake.deliver('Arrival while the reader was away.')");
      await frames(cdp, 3);
      await tab("chat");
      const returned = await capture("reader:revealed", `row:${reader.visible[0]}`);
      if (Math.abs(returned.top-reader.top)>1) throw new Error("Tab reveal moved the scrolled-back reader");
      await select("macro");
      await select("everyone");
      for (const [key, code, expected] of [["]", "BracketRight", "macro:m"], ["[", "BracketLeft", "m"]]) {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code });
        await frames(cdp, 6);
        await capture(`keyboard:${code}`, expected!);
      }
      if (args.includes("--multiple") && !args.includes("--detached")) for (const paneId of ["chat:b", "chat:c"]) {
        await capture(`unaffected:${paneId}`, "m", paneId);
      }
      // Prove the pixel gate rejects the original symptom even when mounted
      // rows still have valid geometry. This is a detector control, not a repro.
      await evaluate(cdp, `document.querySelectorAll('[data-gloom-pane-id="chat:a"] [data-gloom-role=chat-message]').forEach(el=>el.style.opacity='0')`);
      const { png: blankPng, ...blank } = await transcriptPaint(cdp);
      await evaluate(cdp, `document.querySelectorAll('[data-gloom-pane-id="chat:a"] [data-gloom-role=chat-message]').forEach(el=>el.style.removeProperty('opacity'))`);
      if (!blank.view.visible.length || blank.painted) {
        await Bun.write(join(out, `${host}-${count}-detector-control.png`), blankPng);
        throw new Error(`Pixel detector accepted invisible rows: ${JSON.stringify(blank)}`);
      }
      await capture("detector:restored", "m");
      samples.push({ run, host, count, webkit, detached: args.includes("--detached"), states, detectorControl: blank });
      console.log(JSON.stringify({ run, host, count, states: states.length, failed: states.filter(state=>!state.passed).map(state=>state.channel) }));
      continue;
    }
    if (!webkit) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.start");
    }
    const cold = await channelPaint(cdp, "macro");
    const warm = await channelPaint(cdp, "everyone");
    const switches = [await channelPaint(cdp, "macro"), await channelPaint(cdp, "everyone")];
    // Fixed viewport, fixed minimum row size: independent of the loaded history.
    // Check every commit, not just the settled DOM, so mounting everything then
    // hiding it cannot pass. Timing remains diagnostic on a shared runner.
    const maxMountedRows = 80;
    for (const opened of [cold, warm, ...switches]) {
      if (opened.peakMountedRows > maxMountedRows || opened.rows === 0) {
        failures++;
        console.error(`${host}/${count}: mounted ${opened.peakMountedRows} rows, budget ${maxMountedRows}`);
      }
    }
    if (!webkit) {
      const opening = await cdp.send("Profiler.stop");
      await Bun.write(join(out, `${host}-${count}-opening.cpuprofile`), JSON.stringify(opening.profile));
    }
    if (args.includes("--open-only")) {
      samples.push({ run, host, count, workspace, cold, warm, switches, sync: await evaluate(cdp, "structuredClone(__chatLatency.stats)") });
      console.log(JSON.stringify(samples.at(-1)));
      continue;
    }
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
      const sample = { host, count, image, workspace, cold, warm, switches, p50: percentile(ms, .5), p95: percentile(ms, .95), p99: percentile(ms, .99), ...probe, syncBefore: before, syncAfter: after };
      samples.push(sample);
      console.log(JSON.stringify({ host, count, image, cold: cold.ms, warm: warm.ms, p50: sample.p50, p95: sample.p95, p99: sample.p99, rows: probe.rows, commits: probe.commits, long: probe.long.length }));
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
  if (args.includes("--check") && failures) throw new Error(`${failures} chat workloads failed (see samples.json)`);
} finally {
  await Bun.write(join(out, "samples.json"), JSON.stringify(samples, null, 2));
  await browser.close();
  await page.close();
}
