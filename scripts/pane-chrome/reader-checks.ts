import { evaluate, frames, type Cdp } from "./browser";

/**
 * One prose bullet in every reader (reader-text.tsx): the article reader's key
 * facts and list items and the detail reader's markdown bullets are set at the
 * reading size and line height, with the same dim dot and the same hang, while
 * the detail reader's label and value facts stay at the app's size. On the kit
 * page's readers (kit-fixture.tsx), from the browser's computed styles.
 */

interface ReaderStep {
  name: string;
  scenario: string;
  run(cdp: Cdp): Promise<void>;
}

interface Bullet { reader: string; text: string; fontSize: string; lineHeight: string; dot: string; hang: number }

const MEASURE = `(() => {
  const bullets = [];
  for (const reader of document.querySelectorAll("[data-kit-reader]")) {
    for (const row of reader.querySelectorAll("[data-gloom-role=reader-bullet]")) {
      // The article reader: a dot, then the text in a box beside it. Markdown: one line whose first run is the dot.
      const dot = row.children[0];
      const rest = row.children[1];
      const text = rest?.querySelector("span, div") ?? rest;
      const style = getComputedStyle(text ?? row);
      bullets.push({
        reader: reader.getAttribute("data-kit-reader"),
        text: (row.textContent || "").slice(0, 40),
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        dot: dot ? getComputedStyle(dot).color : "none",
        hang: Math.round((rest.getBoundingClientRect().left - row.getBoundingClientRect().left) * 10) / 10,
      });
    }
  }
  const facts = document.querySelector("[data-kit-reader=detail] [data-gloom-ui=detail-facts]");
  const body = document.querySelector("[data-kit-reader=detail] [data-gloom-ui=reader-column]");
  return { bullets, factSize: facts ? getComputedStyle(facts).fontSize : null, bodySize: body ? getComputedStyle(body).fontSize : null };
})()`;

function fail(message: string, detail?: unknown): never {
  throw new Error(detail === undefined ? message : `${message}\n     ${JSON.stringify(detail)}`);
}

export const readerSteps: ReaderStep[] = [{
  name: "readers: key facts, article list items and markdown bullets are one prose bullet at the reading size; label and value facts stay at the app's",
  scenario: "kit&family=reader",
  async run(cdp) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await frames(cdp, 3);
    const { bullets, factSize, bodySize } = await evaluate<{ bullets: Bullet[]; factSize: string | null; bodySize: string | null }>(cdp, MEASURE);
    const article = bullets.filter((bullet) => bullet.reader === "article");
    const detail = bullets.filter((bullet) => bullet.reader === "detail");
    // Two key facts and two list items in the article, two markdown bullets in the detail.
    if (article.length !== 4 || detail.length !== 2) fail("the kit's readers do not show the bullets this check measures", bullets);
    const first = bullets[0]!;
    const differ = bullets.filter((bullet) => bullet.fontSize !== first.fontSize || bullet.lineHeight !== first.lineHeight || bullet.dot !== first.dot || Math.abs(bullet.hang - first.hang) > 0.5);
    if (differ.length) fail("prose bullets differ between readers", bullets);
    if (first.fontSize !== bodySize) fail(`prose bullets are ${first.fontSize}, the reading text ${bodySize}`, bullets);
    if (!factSize || parseFloat(factSize) >= parseFloat(first.fontSize)) fail(`label and value facts are ${factSize}, not the app's size under the reading text`);
  },
}];
