// Builds fixture.tsx (the row-shots Buildout case, with an optional ticker) against APP root,
// drives it in headless Chrome, stars the first company and probes whether the page still answers.
//   APP=<worktree> bun fixture-drive.ts <ticker|-> <key|click>
import { mkdir, rm, readFile, writeFile } from "fs/promises";
import { join } from "path";

const HERE = import.meta.dir;
const APP = process.env.APP!;
const ticker = process.argv[2] ?? "NVDA";
const how = process.argv[3] ?? "key";
const { launchBrowser, evaluate, sleep } = await import(join(APP, "scripts/pane-chrome/browser.ts"));
const { key } = await import(join(APP, "scripts/pane-chrome/web-app.ts"));

const outdir = join(HERE, `page-${process.env.SIDE ?? "app"}`);
if (!process.env.NOBUILD) {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  const entry = join(APP, "scripts/pane-chrome/.row-shots.tsx");
  await writeFile(entry, await readFile(join(HERE, "fixture.tsx"), "utf8"));
  const cwd = process.cwd();
  try {
    process.chdir(APP);
    const { writeElectrobunViewPage } = await import(join(APP, "src/renderers/dom/build-assets.ts"));
    await writeElectrobunViewPage({
      entrypoint: entry, outdir,
      aliasRules: [["backend-rpc", "native-stubs/backend-rpc.ts"]],
      failureMessage: "build failed", missingEntryMessage: "no script",
      title: "Row shots", loadingText: "Loading",
    });
  } finally {
    process.chdir(cwd);
    await rm(entry, { force: true });
  }
}
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const file = Bun.file(join(outdir, pathname === "/" ? "index.html" : pathname.slice(1)));
    return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
  },
});

const text = (cdp: any) => evaluate(cdp, "document.body.innerText", 5000);
async function waitText(cdp: any, needle: string, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if ((await text(cdp)).includes(needle)) return; await sleep(120); }
  throw new Error(`never showed "${needle}"`);
}
const browser = await launchBrowser("glo1325", 1280, 640);
const { cdp } = browser;
try {
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__commits = 0; window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, isDisabled: false, renderers: new Map(), inject() { return 1; }, onCommitFiberRoot() { window.__commits++; }, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {}, on() {}, off() {}, emit() {}, sub() { return () => {}; } };` });
  await cdp.send("Performance.enable");
  const loaded = cdp.once("Page.loadEventFired", 60_000);
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${server.port}/?case=buildout&theme=white${ticker === "-" ? "" : `&ticker=${ticker}`}` });
  await loaded;
  await sleep(1200);
  await waitText(cdp, "All Companies");
  await sleep(2000);
  await key(cdp, "Enter", "Enter", 13, 0, "\r");
  await waitText(cdp, "Northwind");
  await sleep(1500);
  // A counter of DOM mutations: how busy the page is at rest.
  await evaluate(cdp, `(() => { window.__muts = 0; new MutationObserver((list) => { window.__muts += list.length; }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }); })()`);
  const metric = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m: any) => [m.name, m.value]));
  const c0 = await evaluate(cdp, "window.__commits"); const m0 = await metric();
  await sleep(1000);
  const m1 = await metric();
  console.log("at rest 1s before star: mutations", await evaluate(cdp, "window.__muts"), "commits", (await evaluate(cdp, "window.__commits")) - c0, "scriptMs", Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000), "taskMs", Math.round((m1.TaskDuration - m0.TaskDuration) * 1000));
  if (how === "click") {
    const at = await evaluate(cdp, `(() => {
      const el = [...document.querySelectorAll("body *")].find((e) => e.children.length === 0 && (e.textContent.trim() === "☆"));
      const r = el?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
    console.log("star at", at);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, button: "none" });
    for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
  } else {
    const k = process.env.KEY ?? "s";
    await key(cdp, k, `Key${k.toUpperCase()}`, k.toUpperCase().charCodeAt(0), 0, k);
  }
  const started = Date.now();
  try {
    await evaluate(cdp, "window.__muts = 0", 8000);
    console.log("answered after star in", Date.now() - started, "ms");
    await sleep(1000);
    console.log("mutations in 1s after star:", await evaluate(cdp, "window.__muts", 8000), "commits total", await evaluate(cdp, "window.__commits"));
    console.log((await text(cdp)).split("\n").filter((l: string) => /Northwind|★|☆|!/.test(l)).slice(0, 5).join("\n"));
  } catch (error) {
    console.log("PAGE STOPPED ANSWERING:", error instanceof Error ? error.message : error, "after", Date.now() - started, "ms");
  }
} finally {
  await browser.close();
  server.stop(true);
}
