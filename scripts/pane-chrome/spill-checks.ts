import { evaluate, frames, waitFor, type Cdp } from "./browser";

/**
 * A cut name reads on into the blank its row's figure leaves (tableCellSpill)
 * only while both columns show whole, on the desktop and the web as in the
 * terminal. The spill fixture (fixture.tsx) is an unfrozen table that scrolls
 * sideways; the body is scrolled until its right edge falls one cell into
 * LAST, with all of NAME in view: the name keeps its own cells and its
 * ellipsis in view. Scrolled on until LAST shows whole, it reads on again, a
 * blank before the dash; scrolled back, it stops again.
 */

interface SpillStep {
  name: string;
  scenario: string;
  run(cdp: Cdp): Promise<void>;
}

/** A window narrower than the table at its set widths. */
const SIZE = { width: 720, height: 900 };
/** The size every other step expects (checks.ts). */
const RESTORE = { width: 1400, height: 900 };

interface Edge { left: number; right: number }
interface SpillMeasure {
  scrolls: boolean;
  view: Edge;
  /** One cell, as LAST's header lays it out (10 cells). */
  cell: number;
  name: Edge;
  last: Edge;
  /** The first row's name: its cell, its text box, whether that text is cut, and the dash after it. */
  nameCell: Edge;
  label: Edge;
  cut: boolean;
  text: string;
  dash: Edge;
}

const PANE = `document.querySelector('[data-gloom-pane-id="spill:layout"]')`;

/** Scrolls the body sideways so its right edge is `cells` cells past LAST's left edge, then measures. */
const SCROLL_TO = (cells: number) => `(() => {
  const body = ${PANE}?.querySelector("[data-gloom-role=data-table-body-scroll]");
  const headers = [...body.querySelectorAll("[data-gloom-role=data-table-header-cell]")];
  const last = headers.find((cell) => cell.innerText.trim() === "LAST").getBoundingClientRect();
  const viewRight = body.getBoundingClientRect().left + body.clientLeft + body.clientWidth;
  body.scrollLeft += last.left + ${cells} * (last.width / 10) - viewRight;
})()`;

const MEASURE = `(() => {
  const body = ${PANE}?.querySelector("[data-gloom-role=data-table-body-scroll]");
  const edge = (r) => ({ left: r.left, right: r.right });
  const headers = [...body.querySelectorAll("[data-gloom-role=data-table-header-cell]")];
  const at = (label) => headers.findIndex((cell) => cell.innerText.trim() === label);
  const name = headers[at("NAME")].getBoundingClientRect();
  const last = headers[at("LAST")].getBoundingClientRect();
  const row = [...body.querySelectorAll("[data-gloom-role=data-table-row]")].find((each) => each.innerText.includes("NWB"));
  const cells = [...row.querySelectorAll(":scope > [data-gloom-role=data-table-cell]")];
  const nameCell = cells[at("NAME")];
  const label = nameCell.firstElementChild;
  const dash = cells[at("LAST")].firstElementChild;
  const left = body.getBoundingClientRect().left + body.clientLeft;
  return {
    scrolls: body.scrollWidth > body.clientWidth + 1,
    view: { left, right: left + body.clientWidth },
    cell: last.width / 10,
    name: edge(name),
    last: edge(last),
    nameCell: edge(nameCell.getBoundingClientRect()),
    label: edge(label.getBoundingClientRect()),
    cut: label.scrollWidth > label.clientWidth + 0.5,
    text: label.textContent,
    dash: edge(dash.getBoundingClientRect()),
  };
})()`;

function fail(message: string, detail?: unknown): never {
  throw new Error(detail === undefined ? message : `${message}\n     ${JSON.stringify(detail)}`);
}

async function scrolledTo(cdp: Cdp, cells: number): Promise<SpillMeasure> {
  await evaluate(cdp, SCROLL_TO(cells));
  // The scroll event, the render it asks for and its layout.
  await frames(cdp, 3);
  return await evaluate<SpillMeasure>(cdp, MEASURE);
}

/** NAME whole and the body's right edge inside LAST: the name keeps its cells and its ellipsis in view. */
function checkClipped(measure: SpillMeasure, when: string): void {
  const { view, name, last, nameCell, label } = measure;
  if (!(last.left < view.right - 1 && view.right < last.right - 1)) fail(`${when}: the body's edge is not inside LAST, so this checks nothing`, measure);
  if (name.left < view.left - 0.5 || name.right > view.right + 0.5) fail(`${when}: NAME is not whole in view, so this checks nothing`, measure);
  if (nameCell.right > name.right + 0.5) fail(`${when}: the name runs on into LAST, which the edge cuts`, measure);
  if (!measure.cut) fail(`${when}: the name is not cut, so it shows no ellipsis`, measure);
  if (label.right > view.right + 0.5) fail(`${when}: the name's ellipsis is past the body's edge`, measure);
}

/** NAME and LAST whole: the name reads on into LAST's blank, whole, a blank before the dash. */
function checkWhole(measure: SpillMeasure, when: string): void {
  const { view, name, last, nameCell, label, dash, cell } = measure;
  if (name.left < view.left - 0.5 || last.right > view.right + 0.5) fail(`${when}: NAME and LAST are not both whole in view`, measure);
  if (nameCell.right <= name.right + 0.5) fail(`${when}: the name keeps to its column beside a blank it could read on into`, measure);
  if (measure.cut || measure.text !== "Northwind Biologics Inc") fail(`${when}: the name is not whole`, measure);
  if (label.right > dash.left - cell + 0.5) fail(`${when}: the name runs closer to the dash than a blank`, measure);
}

export const spillSteps: SpillStep[] = [{
  name: "table: a name reads on into the next column's blank only while the scroll edge cuts neither column",
  scenario: "layout&pane=spill&mode=dock",
  async run(cdp) {
    try {
      await cdp.send("Emulation.setDeviceMetricsOverride", { ...SIZE, deviceScaleFactor: 1, mobile: false });
      if (!await waitFor(cdp, `(${PANE}?.innerText ?? "").includes("Northwind")`, 10_000)) fail("the spill table drew no rows");
      await frames(cdp, 3);
      const start = await evaluate<SpillMeasure>(cdp, MEASURE);
      if (!start.scrolls) fail("the spill table does not scroll sideways at this window size", start);
      // All of NAME and the first cell of LAST, the blank before its dash.
      checkClipped(await scrolledTo(cdp, 1), "one cell of LAST in view");
      // LAST whole, with a cell to spare.
      checkWhole(await scrolledTo(cdp, 11), "LAST whole");
      // Back: the edge cuts LAST again, a few cells in.
      checkClipped(await scrolledTo(cdp, 4), "four cells of LAST in view");
    } finally {
      await cdp.send("Emulation.setDeviceMetricsOverride", { ...RESTORE, deviceScaleFactor: 1, mobile: false });
    }
  },
}];
