import { join } from "path";
import { evaluate, frames, mouse, waitFor, type PageCommands } from "./browser";
import { transcriptPaint, transcriptView } from "./chat-paint";

/** Part of chat-latency: real saved-layout clicks and the app's Tab shortcut. */
export async function checkChatReturn(cdp: PageCommands, out: string, prefix: string, floating: boolean) {
  const states: Array<{ step: string; passed: boolean; [key: string]: unknown }> = [];
  const next = async (index: number) => {
    if (floating) {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    } else {
      const point = await evaluate<{ x: number; y: number }>(cdp, `(() => {
        const r=document.querySelector('[data-gloom-role=status-bar] [data-tab-value="${index}"]').getBoundingClientRect();
        return {x:r.x+r.width/2,y:r.y+r.height/2};
      })()`);
      await mouse(cdp, "mousePressed", point.x, point.y, true);
      await mouse(cdp, "mouseReleased", point.x, point.y, false);
    }
    await frames(cdp, 4);
  };
  const capture = async (step: string, expected?: { row: string; top: number }) => {
    // Screenshot first: no recovery scroll or click after bringing chat forward.
    const { png, ...paint } = await transcriptPaint(cdp);
    const latest = await evaluate<string>(cdp, "__chatFake.messages.at(-1).id");
    const passed = paint.painted && (expected
      ? paint.view.visible.includes(expected.row) && Math.abs(paint.view.top - expected.top) <= 1
      : paint.view.visible.includes(latest));
    states.push({ step, passed, ...paint });
    if (!passed || step === "cycle-0") await Bun.write(join(out, `${prefix}-${step}.png`), png);
  };
  const wheel = async (expression: string, deltaY: number) => {
    const point = await evaluate<{ x: number; y: number }>(cdp, `(() => {
      const r=(${expression}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY });
    await frames(cdp, 6);
  };
  await capture("initial");
  for (let cycle = 0; cycle < 10; cycle++) {
    for (const index of [1, 2, 0]) {
      await next(index);
      if (floating && index !== 0) {
        const id = index === 1 ? "table:a" : "reader:a";
        // The same ancestor move resets a virtualized table and an ordinary
        // article reader. Find their real scrollports, without scrolling in JS.
        const scroller = `([...document.querySelectorAll('[data-gloom-pane-id="${id}"] *')]
          .find(el=>el.clientHeight>100 && el.scrollHeight>el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY)))`;
        if (cycle === 0) {
          await wheel(scroller, 500);
          // WebKit's wheel can still be animating after several frames. Record
          // the settled offset, not an intermediate position during that wheel.
          if (!await waitFor(cdp, `(() => {const el=${scroller};return el.scrollTop>0 && Math.abs(el.scrollTop-Math.min(500,el.scrollHeight-el.clientHeight))<=1})()`)) {
            throw new Error(`${id} did not finish scrolling`);
          }
          await evaluate(cdp, `window.__returnPositions??={};__returnPositions['${id}']=${scroller}.scrollTop`);
        } else {
          const positions = await evaluate<{ before: number; after: number }>(cdp, `({before:__returnPositions['${id}'],after:${scroller}.scrollTop})`);
          states.push({ step: `${id}-${cycle}`, passed: Math.abs(positions.before - positions.after) <= 1, ...positions });
        }
      }
      if (floating && index === 2 && cycle === 5) {
        await evaluate(cdp, "__chatFake.deliver('Arrival while chat is behind another window.')");
        await frames(cdp, 4);
      }
      if (index === 0) await capture(`cycle-${cycle}`);
    }
  }
  if (floating && !states.at(-1)?.passed) {
    states.push({ step: "history-return", passed: false, reason: "No visible transcript to scroll back from" });
    return states;
  }
  if (floating) {
    await wheel("document.querySelector('[data-gloom-pane-id=\"chat:a\"] [data-gloom-role=chat-transcript]')", -1400);
    if (!await waitFor(cdp, `(() => {const v=${transcriptView()};return v.extent-v.height-v.top>100 && v.visible.length>0})()`)) {
      throw new Error("Chat did not scroll back to history");
    }
    const view = await evaluate<{ visible: string[]; top: number }>(cdp, transcriptView());
    await next(1);
    await next(2);
    await evaluate(cdp, "__chatFake.deliver('Arrival while reading history behind another window.')");
    await frames(cdp, 4);
    await next(0);
    await capture("history-return", { row: view.visible[0]!, top: view.top });
  }
  return states;
}
