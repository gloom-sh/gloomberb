// Builds row-shots.tsx against main and this branch (and the IBKR Gateway plugin's main and branch), drives each
// case in headless Chrome at 640 and 1280 px in the dark `white` and light `paper` themes, and writes one sheet per
// case and state: main on top, the branch below.
//   bun shoot.ts [case...]
import { mkdir, rm, readFile, writeFile } from "fs/promises";
import { join } from "path";

const HERE = process.env.SHOTS_DIR ?? import.meta.dir;
const APP_HEAD = process.env.APP_HEAD!; // this branch
const APP_BASE = join(HERE, "app-base");
const IBKR_HEAD = process.env.IBKR_HEAD!; // the plugin branch
const IBKR_BASE = join(HERE, "ibkr-base");
const { launchBrowser, evaluate, sleep } = await import(join(APP_HEAD, "scripts/pane-chrome/browser.ts"));
const { key } = await import(join(APP_HEAD, "scripts/pane-chrome/web-app.ts"));

type Side = { name: string; root: string; ibkr: string };
const SIDES: Record<string, Side> = {
  base: { name: "base", root: APP_BASE, ibkr: IBKR_BASE },
  head: { name: "head", root: APP_HEAD, ibkr: IBKR_HEAD },
  // The plugin's own main on this branch's host: the IBKR case's before.
  "ibkr-base": { name: "ibkr-base", root: APP_HEAD, ibkr: IBKR_BASE },
};

async function build(side: Side): Promise<string> {
  const outdir = join(HERE, `page-${side.name}`);
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  const entry = join(side.root, "scripts/pane-chrome/.row-shots.tsx");
  const source = (await readFile(join(HERE, "row-shots.tsx"), "utf8")).replaceAll("__IBKR_ROOT__", side.ibkr);
  await writeFile(entry, source);
  const cwd = process.cwd();
  try {
    process.chdir(side.root);
    const { writeElectrobunViewPage } = await import(join(side.root, "src/renderers/dom/build-assets.ts"));
    await writeElectrobunViewPage({
      entrypoint: entry, outdir,
      aliasRules: [["backend-rpc", "native-stubs/backend-rpc.ts"]],
      failureMessage: "row shots build failed", missingEntryMessage: "row shots build produced no script",
      title: "Row shots", loadingText: "Loading",
    });
  } finally {
    process.chdir(cwd);
    await rm(entry, { force: true });
  }
  return outdir;
}

function serve(outdir: string) {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const file = Bun.file(join(outdir, pathname === "/" ? "index.html" : pathname.slice(1)));
      return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
}

const text = (cdp: any) => evaluate<string>(cdp, "document.body.innerText");
async function waitText(cdp: any, needle: string, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await text(cdp)).includes(needle)) return;
    await sleep(120);
  }
  throw new Error(`never showed "${needle}"`);
}
const letter = (cdp: any, ch: string) => key(cdp, ch, `Key${ch.toUpperCase()}`, ch.toUpperCase().charCodeAt(0), 0, ch);
const enter = (cdp: any) => key(cdp, "Enter", "Enter", 13, 0, "\r");
const down = (cdp: any) => key(cdp, "ArrowDown", "ArrowDown", 40, 0, "");

/** Clicks the element reading `label` on the line holding `row` (the last such when `last`). */
async function clickIn(cdp: any, row: string, label: string, last = false) {
  const at = await evaluate<{ x: number; y: number } | null>(cdp, `(() => {
    const leaves = [...document.querySelectorAll("body *")].filter((el) => el.children.length === 0 && el.textContent.trim() === ${JSON.stringify(label)});
    const rowTop = [...document.querySelectorAll("body *")].filter((el) => el.children.length === 0 && el.textContent.includes(${JSON.stringify(row)}))
      .map((el) => el.getBoundingClientRect()).find((r) => r.height > 0);
    if (!rowTop) return null;
    const onLine = leaves.map((el) => el.getBoundingClientRect()).filter((r) => r.height > 0 && Math.abs((r.top + r.height / 2) - (rowTop.top + rowTop.height / 2)) < rowTop.height);
    const pick = ${last ? "onLine.sort((a, b) => b.left - a.left)[0]" : "onLine.filter((r) => r.left > rowTop.left).sort((a, b) => a.left - b.left)[0]"};
    return pick ? { x: pick.left + pick.width / 2, y: pick.top + pick.height / 2 } : null;
  })()`);
  if (!at) throw new Error(`no "${label}" beside "${row}"`);
  for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}
async function clickPlaceholder(cdp: any, placeholder: string) {
  const at = await evaluate<{ x: number; y: number } | null>(cdp, `(() => {
    const el = document.querySelector('[placeholder=${JSON.stringify(placeholder)}]');
    const r = el?.getBoundingClientRect();
    return r ? { x: r.left + 8, y: r.top + r.height / 2 } : null;
  })()`);
  if (!at) throw new Error(`no field ${placeholder}`);
  for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}
async function shot(cdp: any, file: string) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  await Bun.write(file, Buffer.from(data, "base64"));
}

/** Each case: what it waits for, then its steps, each ending in a named picture. */
const CASES: Record<string, (cdp: any, snap: (state: string) => Promise<void>) => Promise<void>> = {
  async alerts(cdp, snap) {
    await waitText(cdp, "ZZQXW");
    await sleep(600);
    await down(cdp);
    await sleep(700);
    await snap("row");
    await enter(cdp);
    await sleep(900);
    await snap("detail");
  },
  async orders(cdp, snap) {
    await waitText(cdp, "Working");
    await sleep(500);
    await letter(cdp, "j");
    await sleep(300);
    await letter(cdp, "c");
    await waitText(cdp, "Cancel AAPL order?");
    await sleep(300);
    await enter(cdp);
    await sleep(1800);
    await snap("row");
  },
  async team(cdp, snap) {
    await waitText(cdp, "@bob");
    await sleep(500);
    await clickIn(cdp, "@bob", "Remove", true);
    await waitText(cdp, "Remove @bob?");
    await sleep(300);
    // The question's answer holds the ring, so Enter gives it (at 640 px the row cuts it off).
    await enter(cdp);
    await sleep(1500);
    await snap("row");
  },
  async "team-invite"(cdp, snap) {
    await waitText(cdp, "@carol");
    await sleep(500);
    await clickPlaceholder(cdp, "@analyst");
    await sleep(200);
    await cdp.send("Input.insertText", { text: "dave" });
    await sleep(300);
    await enter(cdp);
    await sleep(1500);
    await snap("form");
  },
  async buildout(cdp, snap) {
    await waitText(cdp, "All Companies");
    await sleep(3000);
    await enter(cdp);
    await waitText(cdp, "Northwind");
    await sleep(500);
    await letter(cdp, "s");
    await sleep(1500);
    await snap("row");
    await enter(cdp);
    await sleep(1000);
    await snap("detail");
  },
  async settings(cdp, snap) {
    await waitText(cdp, "GitHub Copilot account");
    await sleep(500);
    await enter(cdp);
    await sleep(1500);
    await snap("waiting");
    await sleep(3000);
    await snap("row");
  },
  async ibkr(cdp, snap) {
    await waitText(cdp, "AAPL");
    await sleep(800);
    await letter(cdp, "c");
    await waitText(cdp, "Cancel order 42?");
    await sleep(300);
    await enter(cdp);
    await sleep(1500);
    await snap("row");
  },
};

const wanted = process.argv.slice(2);
const cases = Object.keys(CASES).filter((name) => !wanted.length || wanted.includes(name));
const HEIGHT = 640;
const raw = join(HERE, "raw");
await mkdir(raw, { recursive: true });

const pages: Record<string, { url: string; stop(): void }> = {};
for (const sideName of ["base", "head", "ibkr-base"]) {
  if (sideName === "ibkr-base" && !cases.includes("ibkr")) continue;
  console.log("building", sideName);
  pages[sideName] = serve(await build(SIDES[sideName]!));
}

for (const name of cases) {
  for (const theme of ["white", "paper"]) {
    for (const width of [640, 1280]) {
      for (const side of [name === "ibkr" ? "ibkr-base" : "base", "head"]) {
        const browser = await launchBrowser(`row-shots-${side}-${name}`, width, HEIGHT);
        const { cdp } = browser;
        try {
          const loaded = cdp.once("Page.loadEventFired", 60_000);
          await cdp.send("Page.navigate", { url: `${pages[side]!.url}?case=${name}&theme=${theme}` });
          await loaded;
          await sleep(1200);
          const tag = side === "head" ? "head" : "base";
          await CASES[name]!(cdp, async (state) => {
            const file = join(raw, `${name}-${state}-${theme}-${width}-${tag}.png`);
            await shot(cdp, file);
            console.log("wrote", file);
          });
          await Bun.write(join(raw, `${name}-${theme}-${width}-${side === "head" ? "head" : "base"}.txt`), await text(cdp));
        } catch (error) {
          console.error(`${name} ${theme} ${width} ${side}:`, error instanceof Error ? error.message : error);
          await shot(cdp, join(raw, `FAILED-${name}-${theme}-${width}-${side}.png`)).catch(() => {});
        } finally {
          await browser.close();
        }
      }
    }
  }
}
for (const page of Object.values(pages)) page.stop();
