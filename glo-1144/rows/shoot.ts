// GLO-1144 before/after shots: the real web build of base and head, seeded workspaces, headless Chrome.
//   bun shoot.ts <side: base|head> <scenario: br-disabled|br-error|alerts>
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
  if (scenario === "br-disabled" || scenario === "br-error") {
    const portfolioId = "broker:ibkr-gloom:U7700123";
    const layout = {
      dockRoot: { kind: "split", axis: "vertical", ratio: 0.5, first: leaf("portfolio-list:shot"), second: leaf("brokers:shot") },
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
      focus: "brokers:shot",
      config: {
        layout,
        brokerInstances: [{
          id: "ibkr-gloom", brokerType: "signed-in", label: "Interactive Brokers", connectionMode: "ibkr",
          config: { connectionMode: "ibkr", broker: "ibkr" }, enabled: scenario === "br-error", lastSyncedAt: SYNCED,
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
  // Alerts: three rules, one on a symbol no source quotes.
  const layout = {
    dockRoot: leaf("alerts:shot"),
    instances: [{ instanceId: "alerts:shot", paneId: "alerts", binding: { kind: "none" } }],
    floating: [], detached: [],
  };
  const rule = (id: string, symbol: string, condition: string, targetPrice: number) => ({
    id, symbol, condition, targetPrice, createdAt: NOW - 3_600_000, status: "active",
  });
  const alerts = [
    rule("a1", "AAPL", "above", 400),
    rule("a2", "MSFT", "below", 200),
    rule("a3", "ZZQXW", "above", 10),
  ];
  return { focus: "alerts:shot", config: { layout, pluginConfig: { alerts: { alerts: JSON.stringify(alerts) } } } };
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
async function enter(cdp: any) {
  await key(cdp, "Enter", "Enter", 13, 0, "\r");
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

const HEIGHT = 640;
for (const theme of ["white", "paper"]) {
  for (const width of [640, 1280]) {
    const browser = await launchBrowser(`glo1144-${side}-${scenario}`, width, HEIGHT);
    const { cdp } = browser;
    try {
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: seed(theme) });
      const loaded = cdp.once("Page.loadEventFired", 60_000);
      await cdp.send("Page.navigate", { url: app.url });
      await loaded;
      await sleep(2500);
      await settle(cdp, "body", 800, 8000);
      const tag = `${side}-${theme}-${width}`;
      if (scenario === "br-disabled") {
        await waitText(cdp, "Interactive Brokers");
        await clickPane(cdp, "brokers:shot");
        await sleep(600);
        // Base offers Sync for the disabled profile, and it fails in the footer; head offers [b] enable.
        await letter(cdp, "s");
        await sleep(2500);
        await shot(cdp, join(out, `1-row-${tag}.png`));
        if (side === "head") {
          await letter(cdp, "b");
          await sleep(3500);
          await shot(cdp, join(out, `2-enabled-${tag}.png`));
        }
        await enter(cdp);
        await sleep(1200);
        await shot(cdp, join(out, `3-detail-${tag}.png`));
      } else if (scenario === "br-error") {
        await waitText(cdp, "Interactive Brokers");
        await clickPane(cdp, "brokers:shot");
        await sleep(600);
        // Signed out here, so the sync fails.
        await letter(cdp, "s");
        await sleep(3500);
        await shot(cdp, join(out, `1-row-${tag}.png`));
        await enter(cdp);
        await sleep(1200);
        await shot(cdp, join(out, `2-detail-${tag}.png`));
      } else {
        await waitText(cdp, "ZZQXW");
        await sleep(6000);
        await shot(cdp, join(out, `1-alerts-${tag}.png`));
      }
      const body = await text(cdp);
      await Bun.write(join(out, `text-${tag}.txt`), body);
    } finally {
      await browser.close();
    }
  }
}
app.stop();
