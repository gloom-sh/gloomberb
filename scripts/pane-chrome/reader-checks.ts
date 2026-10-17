import { evaluate, frames, type Cdp } from "./browser";

/**
 * Every reader lays reading text out the same way (reader-text.tsx): the
 * article reader, the detail reader's markdown and Docs set paragraphs, a
 * section heading and prose bullets (an article's key facts and lists,
 * markdown and Docs lists) at one size and line height, with one paragraph
 * gap, one space around a heading, and the same dim dot and hang. The detail
 * reader's label and value facts stay at the app's size. On the kit page's
 * readers (kit-fixture.tsx), which hold the same text, from the browser's
 * computed styles and boxes, in wide columns and in narrow ones, where all
 * three step down together.
 */

interface ReaderStep {
  name: string;
  scenario: string;
  run(cdp: Cdp): Promise<void>;
}

interface Bullet { text: string; fontSize: string; lineHeight: string; dot: string; hang: number }
interface ReaderLayout {
  reader: string;
  paragraph: { fontSize: string; lineHeight: string; gap: number } | null;
  heading: { fontSize: string; fontWeight: string; above: number; below: number } | null;
  listGap: number | null;
  bullets: Bullet[];
}

const MEASURE = `(() => {
  const round = (value) => Math.round(value * 10) / 10;
  const box = (el) => el.getBoundingClientRect();
  const out = [];
  for (const reader of document.querySelectorAll("[data-kit-reader]")) {
    const blocks = [...reader.querySelectorAll("[data-gloom-role=reader-paragraph], [data-gloom-role=reader-heading], [data-gloom-role=reader-bullet]")];
    const role = (el) => el.getAttribute("data-gloom-role");
    const paragraphs = blocks.filter((el) => role(el) === "reader-paragraph");
    const first = paragraphs[0], second = paragraphs[1];
    const heading = blocks.find((el) => role(el) === "reader-heading" && el.textContent.trim().toLowerCase() === "guidance");
    const at = heading ? blocks.indexOf(heading) : -1;
    const before = at > 0 ? blocks[at - 1] : null, after = at >= 0 ? blocks[at + 1] : null;
    const firstBullet = blocks.findIndex((el, index) => role(el) === "reader-bullet" && index > at);
    const bullets = blocks.filter((el) => role(el) === "reader-bullet").map((row) => {
      // The innermost box holding the dot: its colour is the dot's.
      let dot = row.children[0];
      while (dot && dot.children.length === 1) dot = dot.children[0];
      const rest = row.children[1];
      const text = rest?.querySelector("span, div") ?? rest;
      const style = getComputedStyle(text ?? row);
      return { text: (row.textContent || "").slice(0, 30), fontSize: style.fontSize, lineHeight: style.lineHeight, dot: dot ? getComputedStyle(dot).color : "none", hang: round(box(rest).left - box(row).left) };
    });
    const style = first ? getComputedStyle(first) : null;
    out.push({
      reader: reader.getAttribute("data-kit-reader"),
      paragraph: first && second ? { fontSize: style.fontSize, lineHeight: style.lineHeight, gap: round(box(second).top - box(first).bottom) } : null,
      heading: heading && before && after ? { fontSize: getComputedStyle(heading).fontSize, fontWeight: getComputedStyle(heading).fontWeight, above: round(box(heading).top - box(before).bottom), below: round(box(after).top - box(heading).bottom) } : null,
      listGap: firstBullet > 0 ? round(box(blocks[firstBullet]).top - box(blocks[firstBullet - 1]).bottom) : null,
      bullets,
    });
  }
  const facts = document.querySelector("[data-kit-reader=detail] [data-gloom-ui=detail-facts]");
  return { readers: out, factSize: facts ? getComputedStyle(facts).fontSize : null };
})()`;

function fail(message: string, detail?: unknown): never {
  throw new Error(detail === undefined ? message : `${message}\n     ${JSON.stringify(detail)}`);
}

const near = (a: number, b: number) => Math.abs(a - b) <= 0.5;

export const readerSteps: ReaderStep[] = [{
  name: "readers: the article reader, markdown and Docs set paragraphs, a section heading and prose bullets alike; label and value facts stay at the app's size",
  scenario: "kit&family=reader",
  async run(cdp) {
    const sizes: Record<string, string> = {};
    try {
      // Wide, each of the three columns reads at the full size; narrow, under 480px, every one steps down together.
      for (const [label, width] of [["wide", 1900], ["narrow", 1100]] as const) {
        await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 1300, deviceScaleFactor: 1, mobile: false });
        await frames(cdp, 3);
        const { readers, factSize } = await evaluate<{ readers: ReaderLayout[]; factSize: string | null }>(cdp, MEASURE);
        if (readers.length !== 3 || readers.some((reader) => !reader.paragraph || !reader.heading || reader.listGap === null)) fail(`${label}: a kit reader is missing the blocks this check measures`, readers);
        const counts = Object.fromEntries(readers.map((reader) => [reader.reader, reader.bullets.length]));
        // Key facts and the list in the article; the list in markdown and Docs.
        if (counts.article !== 4 || counts.detail !== 2 || counts.docs !== 2) fail(`${label}: the kit readers do not show the bullets this check measures`, counts);
        const [base] = readers;
        const problems: string[] = [];
        for (const reader of readers) {
          const p = reader.paragraph!, h = reader.heading!, bp = base!.paragraph!, bh = base!.heading!;
          if (p.fontSize !== bp.fontSize || p.lineHeight !== bp.lineHeight || !near(p.gap, bp.gap)) problems.push(`${reader.reader} paragraphs ${p.fontSize}/${p.lineHeight}, gap ${p.gap}; ${base!.reader} ${bp.fontSize}/${bp.lineHeight}, gap ${bp.gap}`);
          if (h.fontSize !== bh.fontSize || h.fontWeight !== bh.fontWeight || !near(h.above, bh.above) || !near(h.below, bh.below)) problems.push(`${reader.reader} heading ${h.fontSize} ${h.fontWeight}, ${h.above} above, ${h.below} below; ${base!.reader} ${bh.fontSize} ${bh.fontWeight}, ${bh.above} above, ${bh.below} below`);
          if (!near(reader.listGap!, base!.listGap!)) problems.push(`${reader.reader} list ${reader.listGap} under its paragraph; ${base!.reader} ${base!.listGap}`);
          for (const bullet of reader.bullets) {
            const b0 = base!.bullets[0]!;
            if (bullet.fontSize !== bp.fontSize || bullet.lineHeight !== bp.lineHeight || bullet.dot !== b0.dot || !near(bullet.hang, b0.hang)) problems.push(`${reader.reader} bullet "${bullet.text}" ${bullet.fontSize}/${bullet.lineHeight}, dot ${bullet.dot}, hang ${bullet.hang}; paragraphs ${bp.fontSize}/${bp.lineHeight}, first bullet dot ${b0.dot}, hang ${b0.hang}`);
          }
        }
        if (problems.length) fail(`${label}: the readers lay reading text out differently`, problems);
        if (!factSize || parseFloat(factSize) >= parseFloat(base!.paragraph!.fontSize)) fail(`${label}: label and value facts are ${factSize}, not the app's size under the reading text`);
        sizes[label] = base!.paragraph!.fontSize;
      }
      if (!(parseFloat(sizes.narrow!) < parseFloat(sizes.wide!))) fail(`the readers read at ${sizes.wide} wide and ${sizes.narrow} in a narrow column; a narrow column steps down`);
    } finally {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    }
  },
}];
