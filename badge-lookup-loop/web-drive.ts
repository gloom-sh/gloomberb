// The real web build (dist/web of APP) in headless Chrome, signed in as a stand-in user with
// TheBuildout access. Gloom Cloud reads go to the replay as in the UI sweeps; the session,
// the Buildout account and token, and TheBuildout API are answered here (no request leaves for
// thebuildout.ai and no write reaches any service). Opens TheBuildout docked, opens All Companies,
// stars the first company with a real pointer (or `s`) and probes whether the page still answers.
//   APP=<checkout> bun web-drive.ts <ticker|-> <key|click> [registry=keep|drop]
import { join } from "path";

const APP = process.env.APP!;
const ticker = process.argv[2] ?? "NVDA";
const how = process.argv[3] ?? "click";
const { launchBrowser, evaluate, sleep, cacheDir } = await import(join(APP, "scripts/pane-chrome/browser.ts"));
const { createReplay, serveWebApp, loadLayout, key, runCommand } = await import(join(APP, "scripts/pane-chrome/web-app.ts"));

const replay = createReplay(join(import.meta.dir, "replay"));
const inner = serveWebApp(process.env.WEB ?? join(APP, "dist/web"), replay);
const user = { id: "repro-user", name: "Repro", email: "repro@example.com", username: "repro", emailVerified: true, image: null, plan: "pro", effectivePlan: "pro" };
const front = Bun.serve({
  hostname: "127.0.0.1", port: 0, idleTimeout: 120,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/api/auth/get-session") return Response.json({ user, session: { id: "s", expiresAt: "2099-01-01T00:00:00Z" } });
    if (path === "/api/account/buildout") return Response.json({ user: { id: user.id, email: user.email, emailVerified: true }, subscription: { product: "buildout", plan: "pro", active: true, status: "active" } });
    if (path === "/api/account/buildout/token") return Response.json({ token: "repro-token", expiresAt: "2099-01-01T00:00:00Z" });
    // Nothing else signed-in reaches a service: user-scoped reads and every write are refused.
    if (path.startsWith("/api/") && request.method !== "GET" && !/^\/api\/market\/[a-z-]+\/batch$/.test(path)) return new Response("Refused in the repro", { status: 503 });
    if (/^\/api\/(account|cloud|chat|teams|sync|portfolio|alerts|notifications|me|user)/.test(path)) return new Response("Refused in the repro", { status: 503 });
    return fetch(new URL(`${path}${url.search}`, inner.url), { method: request.method, headers: request.headers, body: request.method === "GET" ? undefined : await request.text() });
  },
});
const appUrl = `http://127.0.0.1:${front.port}/`;

const companies = [
  { id: "c-1", name: "Northwind Datacenters", ...(ticker === "-" ? {} : { ticker }) },
  { id: "c-2", name: "Helios Fabrication" },
  { id: "c-3", name: "Quarry Power Systems" },
];
const starred = new Set<string>();
function buildout(method: string, path: string): { status: number; body: unknown } {
  if (method === "POST" || method === "DELETE") {
    if (process.env.STAR_FAIL) return { status: 503, body: "Starring is paused for maintenance." };
    const id = decodeURIComponent(path.split("/").pop() ?? "");
    if (starred.has(id)) starred.delete(id); else starred.add(id);
    return { status: 200, body: { starred: starred.has(id) } };
  }
  if (path === "/companies") return { status: 200, body: companies.map((company) => ({ ...company, starred: starred.has(company.id) })) };
  return { status: 200, body: [] };
}

const browser = await launchBrowser("glo1325-web", 1280, 720);
const { cdp } = browser;
const log: string[] = [];
try {
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "https://*" }] });
  cdp.on("Fetch.requestPaused", async (event: any) => {
    const { requestId, request } = event;
    const cors = [{ name: "access-control-allow-origin", value: "*" }, { name: "access-control-allow-headers", value: "*" }, { name: "access-control-allow-methods", value: "*" }];
    if (request.method === "OPTIONS") { await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 204, responseHeaders: cors }).catch(() => {}); return; }
    const url = new URL(request.url);
    if (url.hostname === "api.thebuildout.ai") {
      const answer = buildout(request.method, url.pathname);
      log.push(`${request.method} ${url.pathname}`);
      await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: answer.status, responseHeaders: [{ name: "content-type", value: "application/json" }, ...cors], body: Buffer.from(JSON.stringify(answer.body)).toString("base64") }).catch(() => {});
      return;
    }
    if (request.method !== "GET") { await cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {}); return; }
    const answer = await replay.read(`DIRECT ${request.url}`, async () => {
      const response = await fetch(request.url, { signal: AbortSignal.timeout(30_000) });
      return { status: response.status, type: response.headers.get("content-type") ?? "", bytes: new Uint8Array(await response.arrayBuffer()) };
    });
    await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: answer.status, responseHeaders: [{ name: "content-type", value: answer.type || "application/octet-stream" }, ...cors], body: Buffer.from(answer.bytes).toString("base64") }).catch(() => {});
  });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__commits = 0; window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, isDisabled: false, renderers: new Map(), inject() { return 1; }, onCommitFiberRoot() { window.__commits++; }, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {}, on() {}, off() {}, emit() {}, sub() { return () => {}; } };` });
  await cdp.send("Performance.enable");
  const instance = { instanceId: "buildout:repro", paneId: "buildout", binding: { kind: "none" } };
  await loadLayout(cdp, appUrl, replay, { dockRoot: null, instances: [], floating: [], detached: [] });
  await sleep(1500);
  await runCommand(cdp, process.env.CMD ?? "TheBuildout");
  await sleep(1500);
  const paneId = await evaluate(cdp, `[...document.querySelectorAll("[data-gloom-pane-id]")].map((e) => e.getAttribute("data-gloom-pane-id")).find((id) => id.startsWith("buildout")) ?? null`);
  console.log("pane", paneId);
  const scope = `[data-gloom-pane-id="${paneId}"]`;
  const paneText = () => evaluate(cdp, `document.querySelector(${JSON.stringify(scope)})?.innerText ?? document.body.innerText`, 5000);
  const waitText = async (needle: string, ms = 20_000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if ((await paneText()).includes(needle)) return; await sleep(200); }
    throw new Error(`never showed "${needle}":\n${(await paneText()).slice(0, 800)}`);
  };
  await waitText("All Companies");
  await sleep(1500);
  // Open All Companies with a real click on its row.
  const rowAt = await evaluate(cdp, `(() => { const el = [...document.querySelectorAll(${JSON.stringify(scope)} + " *")].find((e) => e.children.length === 0 && e.textContent.trim() === "All Companies"); const r = el?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rowAt.x, y: rowAt.y, button: "none" });
  await key(cdp, "Enter", "Enter", 13, 0, "\r");
  await waitText("Northwind");
  await sleep(4000);
  const metric = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m: any) => [m.name, m.value]));
  const c0 = await evaluate(cdp, "window.__commits"); const m0 = await metric();
  await sleep(1000);
  const m1 = await metric();
  console.log(`[${ticker}] at rest 1s before star: commits`, (await evaluate(cdp, "window.__commits")) - c0, "scriptMs", Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000));
  const rowLine = (await paneText()).split("\n").filter((line: string) => line.includes("Northwind"));
  console.log("row:", JSON.stringify(rowLine));
  await Bun.write(join(import.meta.dir, `web-before-${ticker}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  if (how === "click") {
    const at = await evaluate(cdp, `(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(scope)} + " *")].filter((e) => e.children.length === 0 && /^[☆★]$/.test(e.textContent.trim()));
      const north = [...document.querySelectorAll(${JSON.stringify(scope)} + " *")].find((e) => e.children.length === 0 && e.textContent.includes("Northwind"))?.getBoundingClientRect();
      const r = els.map((e) => e.getBoundingClientRect()).find((r) => north && Math.abs(r.top - north.top) < 6);
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
    console.log("star at", at);
    // A real pointer: it moves there, presses and releases, and stays.
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, button: "none" });
    await sleep(200);
    for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }, 10_000);
  } else {
    if (process.env.HOVER) {
      const badge = await evaluate(cdp, `(() => { const el = [...document.querySelectorAll(${JSON.stringify(scope)} + " [role=button]")].find((e) => e.getAttribute("aria-label") === ${JSON.stringify(ticker)}); const r = el?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
      console.log("pointer resting on badge at", badge);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: badge.x, y: badge.y, button: "none" });
      await sleep(500);
    }
    await key(cdp, "s", "KeyS", 83, 0, "s");
  }
  const started = Date.now();
  try {
    const c2 = await evaluate(cdp, "window.__commits", 8000);
    console.log("answered after star in", Date.now() - started, "ms");
    await sleep(1500);
    const m2 = await metric(); const c3 = await evaluate(cdp, "window.__commits", 8000); await sleep(1000); const m3 = await metric();
    console.log("after star: commits in 1s", (await evaluate(cdp, "window.__commits", 8000)) - c3, "scriptMs", Math.round((m3.ScriptDuration - m2.ScriptDuration) * 1000), "(commits since star", c3 - c2, ")");
    console.log("row:", JSON.stringify((await paneText()).split("\n").filter((line: string) => line.includes("Northwind"))));
    await Bun.write(join(import.meta.dir, `web-after-${ticker}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  } catch (error) {
    console.log("PAGE STOPPED ANSWERING:", error instanceof Error ? error.message : error, "after", Date.now() - started, "ms");
  }
  console.log("buildout calls:", log.join(", "));
} finally {
  await browser.close();
  front.stop(true);
  inner.stop();
}
