// GLO-1144 before/after shots: the real web build of base and head, seeded workspaces, headless Chrome.
//   bun shoot.ts <side: base|head> <scenario: broker|locked|pack> [--keep]
import { mkdir } from "fs/promises";
import { join } from "path";

const REPO = "/home/vince/.paseo/worktrees/0a293nnp/gloom-fda81df87272";
const { launchBrowser, evaluate, sleep } = await import(join(REPO, "scripts/pane-chrome/browser.ts"));
const { createReplay, serveWebApp, key, settle } = await import(join(REPO, "scripts/pane-chrome/web-app.ts"));

const HERE = "/home/vince/.cache/gloom-smoke/glo-1144";
const [side, scenario] = process.argv.slice(2) as [string, string];
const dist = join(HERE, `web-${side}`);
const out = join(HERE, "shots", scenario);
await mkdir(out, { recursive: true });

const replay = createReplay(join(HERE, "replay"), { offline: process.env.OFFLINE === "1" });
const app = serveWebApp(dist, replay);

const leaf = (instanceId: string) => ({ kind: "pane", instanceId });
const NOW = await replay.clock();
const SYNCED = NOW - 26 * 60 * 60 * 1000;

function workspace(): { config: Record<string, unknown>; tickers?: Record<string, unknown>; focus: string } {
  if (scenario === "broker") {
    const portfolioId = "broker:ibkr-gloom:U7700123";
    const layout = {
      dockRoot: { kind: "split", axis: "vertical", ratio: 0.55, first: leaf("portfolio-list:shot"), second: leaf("brokers:shot") },
      instances: [
        { instanceId: "portfolio-list:shot", paneId: "portfolio-list", binding: { kind: "none" }, params: { collectionId: portfolioId } },
        { instanceId: "brokers:shot", paneId: "brokers", binding: { kind: "none" } },
      ],
      floating: [], detached: [],
    };
    const position = (shares: number, avgCost: number) => ({ portfolio: portfolioId, shares, avgCost, broker: "signed-in", currency: "USD" });
    const ticker = (symbol: string, name: string, shares: number, avgCost: number) => ({
      ticker: symbol, exchange: "NASDAQ", currency: "USD", name, assetCategory: "STK",
      portfolios: [portfolioId], watchlists: [], positions: [position(shares, avgCost)], custom: {}, tags: [],
    });
    return {
      focus: "portfolio-list:shot",
      config: {
        layout,
        brokerInstances: [{
          id: "ibkr-gloom", brokerType: "signed-in", label: "Interactive Brokers", connectionMode: "ibkr",
          config: { connectionMode: "ibkr", broker: "ibkr" }, enabled: false, lastSyncedAt: SYNCED,
        }],
        portfolios: [{ id: portfolioId, name: "IBKR U7700123", currency: "USD", brokerId: "signed-in", brokerInstanceId: "ibkr-gloom", brokerAccountId: "U7700123", lastSyncedAt: SYNCED }],
      },
      tickers: {
        AAPL: ticker("AAPL", "Apple Inc.", 120, 182.4),
        MSFT: ticker("MSFT", "Microsoft Corp.", 40, 401.1),
        NVDA: ticker("NVDA", "NVIDIA Corp.", 75, 118.9),
      },
    };
  }
  if (scenario === "locked") {
    const layout = {
      dockRoot: { kind: "split", axis: "horizontal", ratio: 0.5, first: leaf("world-indices:shot"), second: leaf("help:shot") },
      instances: [
        { instanceId: "world-indices:shot", paneId: "world-indices", binding: { kind: "none" }, locked: true },
        { instanceId: "help:shot", paneId: "help", binding: { kind: "none" } },
      ],
      floating: [], detached: [],
    };
    return { focus: "world-indices:shot", config: { layout } };
  }
  const layout = {
    dockRoot: { kind: "split", axis: "horizontal", ratio: 0.6, first: leaf("options-scenario:shot"), second: leaf("world-indices:shot") },
    instances: [
      { instanceId: "options-scenario:shot", paneId: "options-scenario", binding: { kind: "fixed", symbol: "AAPL" }, settings: { symbol: "AAPL" } },
      { instanceId: "world-indices:shot", paneId: "world-indices", binding: { kind: "none" } },
    ],
    floating: [], detached: [],
  };
  return { focus: "options-scenario:shot", config: { layout } };
}

function seed(theme: string): string {
  const { config, tickers, focus } = workspace();
  const layout = config.layout as object;
  const full = {
    ...config,
    layouts: [{ name: "Shot", layout, focusedPaneId: focus }],
    activeLayoutIndex: 0,
    onboardingComplete: true,
    telemetry: { crashReports: false, usage: false },
    theme,
  };
  return `(() => {
  const RealDate = Date, startedAt = RealDate.now(), now = () => ${NOW} + (RealDate.now() - startedAt);
  globalThis.Date = class extends RealDate { constructor(...args) { if (args.length === 0) super(now()); else super(...args); } static now() { return now(); } };
})();
if (!sessionStorage.getItem("seeded")) {
  sessionStorage.setItem("seeded", "1");
  localStorage.clear();
  localStorage.setItem("gloomberb.web.config.v1", ${JSON.stringify(JSON.stringify(full))});
  ${tickers ? `localStorage.setItem("gloomberb.web.tickers.v1", ${JSON.stringify(JSON.stringify(tickers))});` : ""}
}`;
}

const text = (cdp: any) => evaluate<string>(cdp, "document.body.innerText");
async function waitText(cdp: any, needle: string, ms = 8000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await text(cdp)).includes(needle)) return true;
    await sleep(150);
  }
  return false;
}
async function letter(cdp: any, ch: string) {
  await key(cdp, ch, `Key${ch.toUpperCase()}`, ch.toUpperCase().charCodeAt(0), 0, ch);
}
async function clickPane(cdp: any, id: string) {
  const at = await evaluate<{ x: number; y: number } | null>(cdp, `(() => { const r = document.querySelector('[data-gloom-pane-id="${id}"]')?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
  if (!at) throw new Error(`no pane ${id}`);
  for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}
async function shot(cdp: any, file: string) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  await Bun.write(file, Buffer.from(data, "base64"));
  console.log("wrote", file);
}

const HEIGHT = scenario === "broker" ? 640 : 520;
for (const theme of ["white", "paper"]) {
  for (const width of [640, 1280]) {
    const browser = await launchBrowser(`glo1144-${side}-${scenario}`, width, HEIGHT);
    const { cdp } = browser;
    try {
      await cdp.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }).catch(() => {});
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: seed(theme) });
      const loaded = cdp.once("Page.loadEventFired", 60_000);
      await cdp.send("Page.navigate", { url: app.url });
      await loaded;
      await sleep(2500);
      await settle(cdp, "body", 800, 8000);
      const tag = `${side}-${theme}-${width}`;
      if (scenario === "broker") {
        await waitText(cdp, "Interactive Brokers");
        await clickPane(cdp, "portfolio-list:shot");
        await sleep(600);
        await shot(cdp, join(out, `1-portfolio-${tag}.png`));
        await clickPane(cdp, "brokers:shot");
        await sleep(600);
        await shot(cdp, join(out, `2-brokers-${tag}.png`));
        if (side === "base") {
          // Base: Brokers offers Sync for the disabled profile; it fails with the raw error.
          await letter(cdp, "s");
        } else {
          // Head: b enables the profile, then syncs it (signed out here, so the sync fails, in the pane).
          await clickPane(cdp, "portfolio-list:shot");
          await sleep(300);
          await letter(cdp, "b");
        }
        await sleep(3000);
        await shot(cdp, join(out, `3-action-${tag}.png`));
      } else if (scenario === "locked") {
        await clickPane(cdp, "world-indices:shot");
        await sleep(400);
        await key(cdp, "w", "KeyW", 87, 2);
        await waitText(cdp, "Pane is locked", 3000);
        await sleep(500);
        await shot(cdp, join(out, `1-close-locked-${tag}.png`));
      } else {
        await waitText(cdp, "rowse saved");
        await clickPane(cdp, "options-scenario:shot");
        await sleep(400);
        await letter(cdp, "b");
        await waitText(cdp, "No saved strategies", 3000);
        await sleep(500);
        await shot(cdp, join(out, `1-browse-saved-${tag}.png`));
      }
      const body = await text(cdp);
      await Bun.write(join(out, `text-${tag}.txt`), body);
    } finally {
      await browser.close();
    }
  }
}
app.stop();
