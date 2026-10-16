/** Real composer input against a cold, channel-scoped synthetic member set. */
import { join, resolve } from "node:path";
import { cacheDir, evaluate, frames, launchBrowser, mouse, waitFor } from "./browser";
import { serveFixturePage } from "./page";

const out = cacheDir("chat-mentions");
const page = await serveFixturePage(resolve(import.meta.dir, "../.."), join(out, "build"));
const browser = await launchBrowser("chat-mentions", 1280, 900);
const { cdp } = browser;
async function check(expression: string, message: string) {
  if (!await evaluate(cdp, expression)) throw new Error(message);
}
async function click(expression: string) {
  const point = await evaluate<{ x: number; y: number }>(cdp, `(() => {const r=(${expression}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await mouse(cdp, "mousePressed", point.x, point.y, true);
  await mouse(cdp, "mouseReleased", point.x, point.y, false);
}
async function draft(text: string) {
  await click("document.querySelector('textarea')");
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
  await cdp.send("Input.insertText", { text });
  await frames(cdp, 4);
}
// Leaf text rather than row geometry: the shared list's appearance is unchanged.
const labels = `[...document.querySelectorAll('[data-gloom-pane-id="chat:a"] *')].filter(el=>el.tagName!=='TEXTAREA' && el.childElementCount===0 && /^@\\w+$/.test(el.textContent.trim())).map(el=>el.textContent.trim())`;
try {
  for (const host of ["desktop", "browser"]) {
    await cdp.send("Page.navigate", { url: `${page.url}?scenario=chat&latencyCheck=1&host=${host}&members=held&count=40&loaded=40&latency=0` });
    if (!await waitFor(cdp, "window.__chatMembers?.reads.length===1 && !!document.querySelector('textarea')")) throw new Error("Fixture did not start");
    await frames(cdp, 6);
    await draft("@");
    await check(`${labels}.length > 0`, "Cold read lost loaded-author suggestions");
    await draft("@Silent");
    await check(`!${labels}.includes('@quiet')`, "Held members appeared early");
    await evaluate(cdp, "__chatMembers.release()");
    await frames(cdp, 6);
    await check(`${labels}.includes('@quiet')`, "Silent member did not fill in without another key");
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await frames(cdp, 4);
    await check("document.querySelector('textarea').value === '@quiet '", "Tab did not accept the display-name match");
    await draft("@");
    await check(`${labels}.length === 5`, "Suggestion cap changed");
    await check(`${labels}.includes('@penpal')`, "Recent DM contact is missing");
    await draft("@member4999");
    await check(`${labels}.includes('@member4999')`, "Filtering capped the candidate set before matching");
    await draft("@outsider");
    await check(`${labels}.length === 0`, "Unrelated user was suggested");
    await check("__chatMembers.reads.length === 1", "Typing fetched members again");
    await click(`[...document.querySelectorAll('[data-gloom-pane-id="chat:a"] [data-gloom-role="pane-sidebar-item"]')].find(el=>el.textContent.includes('macro'))`);
    await frames(cdp, 6);
    await draft("@quiet");
    await check(`${labels}.length === 0`, "Previous channel's silent member leaked into this channel");
    await draft("@Silent");
    await check(`${labels}.includes('@othermember')`, "New channel did not fetch its members");
    await check("JSON.stringify(__chatMembers.reads) === '[\"everyone\",\"macro\"]'", "Expected one read per channel");
    console.log(`${host}: cold cache, silent member, display name, Tab, DM contact, cap, full-set filtering, channel isolation and read counts passed`);
  }
} finally {
  await browser.close();
  await page.close();
}
